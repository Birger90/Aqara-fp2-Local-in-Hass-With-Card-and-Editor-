/*
 * fp2-room-card – Live-Karte für Aqara FP2 (ESPHome hansihe/esphome_fp2 + Komponente fp2_rooms)
 *
 * Aufgabenteilung
 *  - ESP (fp2_rooms, Layout v2): festes Raster 16 × 20 Zellen à 50 cm wie in der Aqara-App, Masken für
 *    Raum, Ignorier-Zellen und bis zu 32 Zonen, Filter, Flash-Speicherung, HA-Entitäten für Anwesenheit/
 *    Personenzahl. Die Karte liest/schreibt das Layout über die API-Aktionen esphome.<gerät>_get_layout /
 *    _set_layout. Zonenstatus kompakt: {"c","r":[an,n],"z":"<8 Hex, Bit i = Slot i>","n":"<32 Hex>"}.
 *  - Karte: Raum lernen (frei herumlaufen), Störquellen lernen (leerer Raum), Zellen malen (auch als Rechteck),
 *    Zonen einzeln anlegen/benennen/löschen, Möbel stellen, Ausrichten auf einem Grundriss, Live-Anzeige.
 *  - HA: Wandkarte (aus einem Grundrissbild im Browser erkannte Wände als SVG-Pfad), je Gerät die
 *    Ausrichtung auf dem Grundriss, Namen/Farben/Typen der Zonen und Möbel über frontend/set_system_data.
 *    Zonen-Entitäten werden in der Entitätsregistrierung umbenannt bzw. ein-/ausgeblendet. Das Bild selbst
 *    wird weder hochgeladen noch gespeichert.
 *
 * Datenquelle (verifiziert im Quellcode von hansihe/esphome_fp2, fp2_component.cpp):
 *  Text-Sensor "Targets" = Base64 von [count u8][target 14 Byte]...
 *  target: id u8, x s16 BE, y s16 BE, z s16 BE, velocity s16 BE, snr s16 BE,
 *          classifier u8, posture u8, active u8
 *
 * Rohkoordinaten: 1 Einheit = 1 cm (Radar-Firmware: int16 = 100 × Meter). Wandmontage: Sensor im Ursprung,
 * y geradeaus in den Raum, x seitlich. Zelle: col = floor((x + 400) / 50), row = floor(y / 50).
 */

/* ------------------------------------------------------------------ */
/* Mathematik / Datenaufbereitung (ohne DOM, in Node testbar)          */
/* ------------------------------------------------------------------ */

const FP2Math = (() => {
  const TARGET_SIZE = 14;

  function base64ToBytes(b64) {
    let bin;
    if (typeof atob === "function") bin = atob(b64);
    else bin = Buffer.from(b64, "base64").toString("binary");
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function s16(b, o) {
    const v = (b[o] << 8) | b[o + 1];
    return v >= 0x8000 ? v - 0x10000 : v;
  }

  /** Dekodiert den Base64-State des Targets-Sensors. Ungültige Daten -> [] */
  function decodeTargets(state) {
    if (typeof state !== "string" || state.length === 0) return [];
    if (state === "unknown" || state === "unavailable") return [];
    let b;
    try {
      b = base64ToBytes(state.trim());
    } catch (e) {
      return [];
    }
    if (b.length < 1) return [];
    const count = b[0];
    const targets = [];
    for (let i = 0; i < count; i++) {
      const o = 1 + i * TARGET_SIZE;
      if (o + TARGET_SIZE > b.length) break;
      targets.push({
        id: b[o],
        x: s16(b, o + 1),
        y: s16(b, o + 3),
        z: s16(b, o + 5),
        velocity: s16(b, o + 7),
        snr: s16(b, o + 9),
        classifier: b[o + 11],
        posture: b[o + 12],
        active: b[o + 13],
      });
    }
    return targets;
  }

  /** Hartley-Normalisierung: Schwerpunkt 0, mittlerer Abstand sqrt(2) */
  function normalization(pts) {
    let cx = 0, cy = 0;
    for (const p of pts) { cx += p[0]; cy += p[1]; }
    cx /= pts.length; cy /= pts.length;
    let d = 0;
    for (const p of pts) d += Math.hypot(p[0] - cx, p[1] - cy);
    d /= pts.length;
    const s = d > 1e-12 ? Math.SQRT2 / d : 1;
    return [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1];
  }

  function mul3(a, b) {
    const r = new Array(9).fill(0);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
    return r;
  }

  function inv3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-15) return null;
    return [
      A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
      B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
      C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
    ];
  }

  function apply(H, p) {
    const w = H[6] * p[0] + H[7] * p[1] + H[8];
    return [(H[0] * p[0] + H[1] * p[1] + H[2]) / w, (H[3] * p[0] + H[4] * p[1] + H[5]) / w];
  }

  /** Löst M x = v (Gauß mit Spaltenpivotisierung). null bei Singularität */
  function solve(M, v) {
    const n = v.length;
    const A = M.map((row, i) => [...row, v[i]]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      if (Math.abs(A[p][c]) < 1e-12) return null;
      [A[c], A[p]] = [A[p], A[c]];
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
      }
    }
    return A.map((row, i) => row[n] / row[i]);
  }

  /** Signierte doppelte Dreiecksfläche, für Kollinearitätsprüfung */
  function minTriangleSpread(pts) {
    // Größte Dreiecksfläche relativ zur Ausdehnung^2 -> 0 = alle kollinear
    let maxArea = 0, ext = 0;
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++) {
        ext = Math.max(ext, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]));
        for (let k = j + 1; k < pts.length; k++) {
          const a = Math.abs((pts[j][0] - pts[i][0]) * (pts[k][1] - pts[i][1]) -
                             (pts[k][0] - pts[i][0]) * (pts[j][1] - pts[i][1]));
          maxArea = Math.max(maxArea, a);
        }
      }
    return ext > 0 ? maxArea / (ext * ext) : 0;
  }

  /**
   * Homographie src -> dst aus n >= 4 Punktpaaren (Least Squares, h33 = 1,
   * Hartley-normalisiert). Rückgabe 3x3 zeilenweise oder null.
   */
  function fitHomography(src, dst) {
    if (src.length !== dst.length || src.length < 4) return null;
    if (minTriangleSpread(src) < 0.02 || minTriangleSpread(dst) < 0.02) return null;
    const Ts = normalization(src), Td = normalization(dst);
    const s = src.map((p) => apply(Ts, p));
    const d = dst.map((p) => apply(Td, p));
    // Normalengleichungen A^T A h = A^T b
    const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
    const Atb = new Array(8).fill(0);
    const addRow = (row, rhs) => {
      for (let i = 0; i < 8; i++) {
        Atb[i] += row[i] * rhs;
        for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j];
      }
    };
    for (let i = 0; i < s.length; i++) {
      const [x, y] = s[i], [u, v] = d[i];
      addRow([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
      addRow([0, 0, 0, x, y, 1, -v * x, -v * y], v);
    }
    const h = solve(AtA, Atb);
    if (!h || h.some((v) => !Number.isFinite(v))) return null;
    const Hn = [...h, 1];
    const TdInv = inv3(Td);
    if (!TdInv) return null;
    let H = mul3(TdInv, mul3(Hn, Ts));
    if (Math.abs(H[8]) > 1e-15) H = H.map((v) => v / H[8]);
    return H;
  }

  /** Abweichung der eingemessenen Ecken nach Transformation, relativ zur Raumdiagonale */
  function residuals(H, src, dst) {
    let ext = 0;
    for (let i = 0; i < dst.length; i++)
      for (let j = i + 1; j < dst.length; j++)
        ext = Math.max(ext, Math.hypot(dst[i][0] - dst[j][0], dst[i][1] - dst[j][1]));
    return src.map((p, i) => {
      const q = apply(H, p);
      const e = Math.hypot(q[0] - dst[i][0], q[1] - dst[i][1]);
      return { abs: e, rel: ext > 0 ? e / ext : 0 };
    });
  }

  function pointInPolygon(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi)
        inside = !inside;
    }
    return inside;
  }

  function median(arr) {
    const a = [...arr].sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  /** Stabilitätsauswertung eines Messfensters [{x,y}] */
  function stability(samples) {
    if (samples.length === 0) return null;
    const mx = median(samples.map((s) => s.x));
    const my = median(samples.map((s) => s.y));
    let sq = 0;
    for (const s of samples) sq += (s.x - mx) ** 2 + (s.y - my) ** 2;
    return { x: mx, y: my, rms: Math.sqrt(sq / samples.length), n: samples.length };
  }

  function polygonCentroid(poly) {
    let x = 0, y = 0;
    for (const p of poly) { x += p[0]; y += p[1]; }
    return [x / poly.length, y / poly.length];
  }

  /**
   * Findet den eigentlichen Grundriss in einem Bild (z. B. Exposé mit Titel, Logo, Legende, Rand).
   * gray: Graustufen 0..255 (Zeilen), w/h: Größe. Ansatz: dunkle Pixel (Wände) leicht verdicken,
   * zusammenhängende Bereiche suchen; der Bereich mit dem größten umschließenden Rechteck ist der
   * Grundriss (Wände hängen über die Außenwände zusammen, Texte/Logos sind kleine Einzelteile).
   * Rückgabe {x0,y0,x1,y1} in Pixeln (inkl. Rand) oder null, wenn nichts Eindeutiges gefunden wurde.
   */
  function detectPlanBBoxCC(gray, w, h, opts = {}) {
    const n = w * h;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += gray[i];
    const mean = sum / n;
    const darkBg = mean < 128;
    const thr = darkBg ? Math.max(115, mean + 40) : Math.min(140, mean - 40);
    let mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = darkBg ? (gray[i] > thr ? 1 : 0) : (gray[i] < thr ? 1 : 0);
    // Dilatation (3x3), zweimal: überbrückt schmale Lücken (Türen, Antialiasing)
    const rad = opts.dilate ?? 2;
    for (let it = 0; it < rad; it++) {
      const m2 = new Uint8Array(n);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          if (!mask[y * w + x]) continue;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx >= 0 && xx < w) m2[yy * w + xx] = 1;
            }
          }
        }
      mask = m2;
    }
    // Zusammenhangskomponenten (8er-Nachbarschaft)
    const label = new Int32Array(n);
    const stack = new Int32Array(n);
    const comps = [];
    for (let i = 0; i < n; i++) {
      if (!mask[i] || label[i]) continue;
      const id = comps.length + 1;
      let sp = 0, cnt = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
      stack[sp++] = i;
      label[i] = id;
      while (sp) {
        const k = stack[--sp];
        const x = k % w, y = (k - x) / w;
        cnt++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const j = yy * w + xx;
            if (mask[j] && !label[j]) { label[j] = id; stack[sp++] = j; }
          }
        }
      }
      comps.push({ x0, y0, x1, y1, cnt, area: (x1 - x0 + 1) * (y1 - y0 + 1) });
    }
    const minCnt = Math.max(30, n * 0.0002);
    const cand = comps.filter((c) => c.cnt >= minCnt);
    if (!cand.length) return null;
    cand.sort((a, b) => b.area - a.area);
    const main = { ...cand[0] };
    if (main.area < n * 0.02) return null;
    // Teile, die überwiegend im Hauptbereich liegen, mitnehmen (z. B. herausragende Balkone/Treppen)
    for (const c of cand.slice(1)) {
      const ix = Math.max(0, Math.min(main.x1, c.x1) - Math.max(main.x0, c.x0) + 1);
      const iy = Math.max(0, Math.min(main.y1, c.y1) - Math.max(main.y0, c.y0) + 1);
      if (ix * iy >= c.area * 0.5) {
        main.x0 = Math.min(main.x0, c.x0); main.y0 = Math.min(main.y0, c.y0);
        main.x1 = Math.max(main.x1, c.x1); main.y1 = Math.max(main.y1, c.y1);
      }
    }
    const pad = Math.round(Math.max(w, h) * (opts.pad ?? 0.02));
    return {
      x0: Math.max(0, main.x0 - pad), y0: Math.max(0, main.y0 - pad),
      x1: Math.min(w - 1, main.x1 + pad), y1: Math.min(h - 1, main.y1 + pad),
    };
  }

  /* ---------- Wand-Erkennung: nur die Wände aus einem Grundrissbild ---------- */

  // Chamfer-Abstandstransformation (Gewichte 3/4, Ergebnis in Pixeln). Berechnet für jedes Pixel
  // mit need=1 den Abstand zum nächsten Pixel mit need=0. outside: Wert für Pixel außerhalb des
  // Bilds (0 = Rand zählt als Ziel, Infinity = Rand zählt nicht).
  function chamfer(need, w, h, outside) {
    const INF = 1e9;
    const o3 = outside === 0 ? 3 : INF, o4 = outside === 0 ? 4 : INF;
    const d = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) d[i] = need[i] ? INF : 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!d[i]) continue;
        let v = d[i];
        v = Math.min(v, x > 0 ? d[i - 1] + 3 : o3);
        v = Math.min(v, y > 0 ? d[i - w] + 3 : o3);
        v = Math.min(v, x > 0 && y > 0 ? d[i - w - 1] + 4 : o4);
        v = Math.min(v, x < w - 1 && y > 0 ? d[i - w + 1] + 4 : o4);
        d[i] = v;
      }
    for (let y = h - 1; y >= 0; y--)
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        if (!d[i]) continue;
        let v = d[i];
        v = Math.min(v, x < w - 1 ? d[i + 1] + 3 : o3);
        v = Math.min(v, y < h - 1 ? d[i + w] + 3 : o3);
        v = Math.min(v, x < w - 1 && y < h - 1 ? d[i + w + 1] + 4 : o4);
        v = Math.min(v, x > 0 && y < h - 1 ? d[i + w - 1] + 4 : o4);
        d[i] = v;
      }
    for (let i = 0; i < w * h; i++) d[i] /= 3;
    return d;
  }

  // Abstand jedes Pixels mit mask=1 zum nächsten Pixel mit mask=0 (Bildrand zählt als 0)
  function distanceTransform(mask, w, h) { return chamfer(mask, w, h, 0); }

  // Abstand jedes Pixels zum nächsten Pixel mit mask=1 (für Dilatation); 0 auf den Pixeln selbst
  function distanceTo(mask, w, h) {
    const need = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) need[i] = mask[i] ? 0 : 1;
    return chamfer(need, w, h, Infinity);
  }

  function otsu(values, n) {
    const hist = new Float64Array(256);
    for (let i = 0; i < n; i++) hist[values[i]]++;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sB = 0, wB = 0, best = 0, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = n - wB;
      if (!wF) break;
      sB += t * hist[t];
      const mB = sB / wB, mF = (sum - sB) / wF;
      const between = wB * wF * (mB - mF) ** 2;
      if (between > best) { best = between; thr = t + 1; }
    }
    return thr;
  }

  function labelComponents(mask, w, h) {
    const label = new Int32Array(w * h);
    const stack = new Int32Array(w * h);
    const comps = [null];
    for (let i = 0; i < w * h; i++) {
      if (!mask[i] || label[i]) continue;
      const id = comps.length;
      let sp = 0, cnt = 0;
      stack[sp++] = i;
      label[i] = id;
      while (sp) {
        const k = stack[--sp];
        cnt++;
        const x = k % w, y = (k - x) / w;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const j = yy * w + xx;
            if (mask[j] && !label[j]) { label[j] = id; stack[sp++] = j; }
          }
        }
      }
      comps.push({ id, area: cnt });
    }
    return { label, comps };
  }

  // Strichbreiten-Histogramm: Kammlinien (lokale Maxima der Abstandstransformation) je Breite
  function strokeWidths(dt, mask, w, h) {
    const hist = new Float64Array(64);
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        const v = dt[i];
        if (v < dt[i - 1] || v < dt[i + 1] || v < dt[i - w] || v < dt[i + w]) continue;
        const width = Math.min(63, Math.max(1, Math.round(2 * v - 1)));
        hist[width]++;
      }
    return hist;
  }

  // Wandstärke automatisch: häufigste Strichbreite nach Fläche (Breite × Kammlänge) ab 2 px gilt
  // als Außenwand W; Mindeststärke = 45 % davon (Innenwände sind oft halb so dick wie Außenwände,
  // Schrift und Möbellinien deutlich dünner).
  function dominantWidth(hist) {
    let best = 0, W = 0;
    for (let k = 2; k < 64; k++) if (hist[k] * k > best) { best = hist[k] * k; W = k; }
    return W;
  }

  function autoThickness(hist) {
    const W = dominantWidth(hist);
    if (!W) return 3;
    return Math.max(2, Math.round(W * 0.45));
  }

  // Pixelränder der Maske als geschlossene Linienzüge (Ecken auf dem Pixelgitter)
  function traceContours(mask, w, h) {
    const W1 = w + 1;
    const from = [], to = [], dir = [];
    const outA = new Int32Array(W1 * (h + 1)).fill(-1), outB = new Int32Array(W1 * (h + 1)).fill(-1);
    const add = (x0, y0, x1, y1, d) => {
      const e = from.length, v = y0 * W1 + x0;
      from.push(v); to.push(y1 * W1 + x1); dir.push(d);
      if (outA[v] < 0) outA[v] = e; else outB[v] = e;
    };
    const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (!mask[y * w + x]) continue;
        if (!at(x, y - 1)) add(x, y, x + 1, y, 0);
        if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1, 1);
        if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1, 2);
        if (!at(x - 1, y)) add(x, y + 1, x, y, 3);
      }
    const used = new Uint8Array(from.length);
    const loops = [];
    for (let s = 0; s < from.length; s++) {
      if (used[s]) continue;
      const pts = [];
      let e = s;
      while (e >= 0 && !used[e]) {
        used[e] = 1;
        const v = from[e];
        pts.push([v % W1, (v - (v % W1)) / W1]);
        const nv = to[e], a = outA[nv], b = outB[nv];
        let next = -1;
        if (a >= 0 && !used[a] && b >= 0 && !used[b]) next = dir[a] === (dir[e] + 3) % 4 ? a : b;   // Sattel: links abbiegen
        else if (a >= 0 && !used[a]) next = a;
        else if (b >= 0 && !used[b]) next = b;
        e = next;
      }
      loops.push(pts);
    }
    return loops;
  }

  function rdp(pts, eps) {
    if (pts.length < 3) return pts.slice();
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const [ax, ay] = pts[a], [bx, by] = pts[b];
      const len = Math.hypot(bx - ax, by - ay) || 1e-9;
      let md = -1, mi = -1;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
        if (d > md) { md = d; mi = i; }
      }
      if (md > eps) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  function simplifyLoop(loop, eps) {
    // nur Richtungswechsel behalten, dann geschlossen vereinfachen (Start = weitester Punkt von 0)
    const n = loop.length;
    const c = [];
    for (let i = 0; i < n; i++) {
      const p = loop[(i + n - 1) % n], q = loop[i], r = loop[(i + 1) % n];
      if ((q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]) !== 0) c.push(q);
    }
    if (c.length < 3) return c;
    let far = 0, fd = -1;
    for (let i = 1; i < c.length; i++) {
      const d = (c[i][0] - c[0][0]) ** 2 + (c[i][1] - c[0][1]) ** 2;
      if (d > fd) { fd = d; far = i; }
    }
    const A = rdp(c.slice(0, far + 1), eps), B = rdp([...c.slice(far), c[0]], eps);
    return [...A.slice(0, -1), ...B.slice(0, -1)];
  }

  /**
   * Wände aus einem Graustufenbild (w×h, 0 = schwarz) extrahieren.
   * opts: threshold (0–255, Wandpixel dunkler als Schwelle; Standard Otsu, höchstens 160),
   *       thickness (Mindest-Wandstärke in px; Standard automatisch),
   *       close (Lücken bis 2·close px schließen – für doppellinige/schraffierte Wände; Standard 0),
   *       removed ([[x,y],…] Punkte, deren Wandteil entfernt wird),
   *       minPart (Anteil an der größten Wand, darunter fällt ein Teil weg; Standard 0.01),
   *       eps (Vereinfachung in px; Standard 1).
   * Ergebnis: { mask, d (SVG-Pfad, evenodd), vertices, params, parts, removedParts, area }
   */
  function extractWalls(gray, w, h, opts = {}) {
    const n = w * h;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += gray[i];
    const darkBg = opts.darkBg ?? sum / n < 128;
    const g = new Uint8Array(n);
    for (let i = 0; i < n; i++) g[i] = darkBg ? 255 - gray[i] : gray[i];
    const threshold = Math.round(opts.threshold ?? Math.min(160, otsu(g, n)));
    let dark = new Uint8Array(n);
    for (let i = 0; i < n; i++) dark[i] = g[i] < threshold ? 1 : 0;
    const close = Math.max(0, Math.round(opts.close ?? 0));
    if (close > 0) {
      // Vorher kleine, freistehende Teile (Buchstaben, Ziffern) entfernen – sie würden sonst
      // zu Flecken in Wandstärke zusammenwachsen.
      const maxSide = Math.max(12, Math.round(0.025 * Math.max(w, h)));
      const pre = labelComponents(dark, w, h);
      const box = pre.comps.map(() => [Infinity, Infinity, -1, -1]);
      for (let i = 0; i < n; i++) {
        const id = pre.label[i];
        if (!id) continue;
        const x = i % w, y = (i - x) / w, b = box[id];
        if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
      }
      for (let i = 0; i < n; i++) {
        const id = pre.label[i];
        if (id && Math.max(box[id][2] - box[id][0], box[id][3] - box[id][1]) < maxSide) dark[i] = 0;
      }
      const dTo = distanceTo(dark, w, h);
      const dil = new Uint8Array(n);
      for (let i = 0; i < n; i++) dil[i] = dTo[i] <= close ? 1 : 0;
      const dIn = distanceTransform(dil, w, h);
      for (let i = 0; i < n; i++) dark[i] = dIn[i] > close ? 1 : 0;
    }
    const dt = distanceTransform(dark, w, h);
    const hist = strokeWidths(dt, dark, w, h);
    const thickness = Math.max(2, Math.round(opts.thickness ?? autoThickness(hist)));
    const r = Math.ceil(thickness / 2);
    const core = new Uint8Array(n);
    for (let i = 0; i < n; i++) core[i] = dt[i] >= r - 1e-6 ? 1 : 0;
    const toCore = distanceTo(core, w, h);
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = dark[i] && toCore[i] <= r ? 1 : 0;
    // zu kleine Teile weg
    {
      const { label, comps } = labelComponents(mask, w, h);
      let maxA = 0;
      for (let k = 1; k < comps.length; k++) maxA = Math.max(maxA, comps[k].area);
      const minPart = opts.minPart ?? 0.01;
      const lim = Math.max(20, maxA * minPart);
      for (let i = 0; i < n; i++) if (mask[i] && comps[label[i]].area < lim) mask[i] = 0;
    }
    const wallWidth = Math.max(thickness, dominantWidth(hist) || thickness);
    const openings = opts.openings === false ? [] : detectOpenings(mask, g, threshold, w, h, wallWidth);
    const fin = finishWalls(mask, w, h, { removed: opts.removed, edits: opts.edits, eps: opts.eps, pick: Math.max(4, thickness * 2) });
    return { ...fin, openings, params: { threshold, thickness, close, darkBg }, wallWidth, widthHist: hist };
  }

  /**
   * Wandmaske fertigstellen: angeklickte Teile entfernen, Handkorrekturen (Rechtecke) anwenden,
   * kleine Löcher schließen, Konturen als SVG-Pfad. mask wird verändert.
   * opts: removed [[x,y]], edits [{type:"erase"|"add", r}], eps, pick (Suchradius für Klicks)
   */
  function finishWalls(mask, w, h, opts = {}) {
    const n = w * h;
    const { label, comps } = labelComponents(mask, w, h);
    const drop = new Uint8Array(comps.length);
    const removedParts = [];
    for (const p of opts.removed || []) {
      const id = nearestLabel(label, w, h, p, opts.pick ?? 8);
      if (id && !drop[id]) { drop[id] = 1; removedParts.push(id); }
    }
    for (let i = 0; i < n; i++) if (mask[i] && drop[label[i]]) mask[i] = 0;
    for (const ed of opts.edits || []) {
      if (!ed || !Array.isArray(ed.r)) continue;
      const x0 = Math.max(0, Math.round(Math.min(ed.r[0], ed.r[2]))), x1 = Math.min(w, Math.round(Math.max(ed.r[0], ed.r[2])));
      const y0 = Math.max(0, Math.round(Math.min(ed.r[1], ed.r[3]))), y1 = Math.min(h, Math.round(Math.max(ed.r[1], ed.r[3])));
      const v = ed.type === "add" ? 1 : 0;
      for (let y = y0; y < y1; y++) mask.fill(v, y * w + x0, y * w + x1);
    }
    const holeMax = Math.max(16, (opts.pick ?? 8) ** 2 / 2);
    const bg = new Uint8Array(n);
    for (let i = 0; i < n; i++) bg[i] = mask[i] ? 0 : 1;
    const holes = labelComponents(bg, w, h);
    const touches = new Uint8Array(holes.comps.length);
    for (let x = 0; x < w; x++) { touches[holes.label[x]] = 1; touches[holes.label[(h - 1) * w + x]] = 1; }
    for (let y = 0; y < h; y++) { touches[holes.label[y * w]] = 1; touches[holes.label[y * w + w - 1]] = 1; }
    for (let i = 0; i < n; i++) {
      const id = holes.label[i];
      if (id && !touches[id] && holes.comps[id].area <= holeMax) mask[i] = 1;
    }
    let area = 0;
    for (let i = 0; i < n; i++) area += mask[i];
    const parts = labelComponents(mask, w, h);
    const eps = opts.eps ?? 1;
    const loops = traceContours(mask, w, h).map((l) => simplifyLoop(l, eps)).filter((l) => l.length >= 3);
    const d = loops.map((l) => "M" + l.map((p) => p[0] + " " + p[1]).join("L") + "Z").join("");
    const vertices = [];
    for (const l of loops) for (const p of l) vertices.push(p);
    return { mask, label: parts.label, d, vertices, area, parts: parts.comps.length - 1, removedParts };
  }

  /**
   * Türen und Fenster = Lücken in waagerechten/senkrechten Wänden: ein freier Abschnitt in Wandrichtung,
   * an beiden Enden begrenzt von Wandstücken in Wandstärke (nicht von quer laufenden Wänden).
   * Fenster: im Originalbild laufen Linien längs durch die Lücke. Sonst Tür; Anschlag und
   * Aufschlagrichtung aus dem Viertelkreis im Plan (wenn gezeichnet).
   * Schräge Wände werden nicht untersucht.
   * Ergebnis: [{type:"door"|"window", r:[x0,y0,x1,y1], axis:"h"|"v", hinge:0|1, swing:1|-1, arc:bool}]
   */
  function detectOpenings(mask, g, thr, w, h, W) {
    const n = w * h;
    const vr = new Int32Array(n), hr = new Int32Array(n);
    for (let x = 0; x < w; x++) {
      let y = 0;
      while (y < h) {
        if (!mask[y * w + x]) { y++; continue; }
        let e = y;
        while (e < h && mask[e * w + x]) e++;
        for (let k = y; k < e; k++) vr[k * w + x] = e - y;
        y = e;
      }
    }
    for (let y = 0; y < h; y++) {
      let x = 0;
      while (x < w) {
        if (!mask[y * w + x]) { x++; continue; }
        let e = x;
        while (e < w && mask[y * w + e]) e++;
        for (let k = x; k < e; k++) hr[y * w + k] = e - x;
        x = e;
      }
    }
    const Lmin = Math.max(6, W * 1.5), Lmax = Math.min(Math.max(w, h) * 0.3, W * 25);
    const lo = Math.max(2, W * 0.4), hi = W * 1.8;
    const dark = (x, y) => x >= 0 && y >= 0 && x < w && y < h && g[y * w + x] < thr;
    const out = [];
    for (const axis of ["h", "v"]) {
      // Lücken-Pixel markieren
      const gap = new Uint8Array(n);
      const A = axis === "h" ? w : h, B = axis === "h" ? h : w;
      const idx = axis === "h" ? (a, b) => b * w + a : (a, b) => a * w + b;
      const perp = axis === "h" ? vr : hr, along = axis === "h" ? hr : vr;
      // Wandende: bis 3 px zurück ein Pixel, dessen Wand quer so dick wie eine Wand ist und in
      // Wandrichtung weiterläuft (nicht eine quer stehende Wand)
      const endOK = (a, b, dir) => {
        for (let k = 0; k < 3; k++) {
          const q = a + dir * k;
          if (q < 0 || q >= A) return false;
          const i = idx(q, b);
          if (!mask[i]) return false;
          if (perp[i] >= lo && perp[i] <= hi && along[i] >= W * 1.2) return true;
        }
        return false;
      };
      for (let b = 0; b < B; b++) {
        let a = 0;
        while (a < A) {
          if (mask[idx(a, b)]) { a++; continue; }
          let e = a;
          while (e < A && !mask[idx(e, b)]) e++;
          const L = e - a;
          if (a > 0 && e < A && L >= Lmin && L <= Lmax && endOK(a - 1, b, -1) && endOK(e, b, 1))
            for (let k = a; k < e; k++) gap[idx(k, b)] = 1;
          a = e;
        }
      }
      const { label, comps } = labelComponents(gap, w, h);
      for (let k = 1; k < comps.length; k++) Object.assign(comps[k], { x0: w, y0: h, x1: -1, y1: -1 });
      for (let i = 0; i < n; i++) {
        const id = label[i];
        if (!id) continue;
        const c = comps[id], x = i % w, y = (i - x) / w;
        if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      }
      for (let k = 1; k < comps.length; k++) {
        const c = comps[k];
        const r = [c.x0, c.y0, c.x1 + 1, c.y1 + 1];
        const L = axis === "h" ? r[2] - r[0] : r[3] - r[1], T = axis === "h" ? r[3] - r[1] : r[2] - r[0];
        if (T < lo || T > hi || L < Lmin || c.area < L * T * 0.6) continue;
        // Fenster: eine Linie längs der Wand über ≥ 60 % der Lücke
        let win = false;
        for (let q = 0; q < T && !win; q++) {
          let cnt = 0;
          for (let s = 0; s < L; s++) if (axis === "h" ? dark(r[0] + s, r[1] + q) : dark(r[0] + q, r[1] + s)) cnt++;
          if (cnt >= L * 0.6) win = true;
        }
        const o = { type: win ? "window" : "door", r, axis, hinge: 0, swing: 1, arc: false };
        if (!win) {
          // Viertelkreis um eine der Laibungen, Radius = Lückenbreite, auf einer der beiden Seiten
          let best = 0;
          for (const hinge of [0, 1])
            for (const swing of [1, -1]) {
              let hit = 0, tot = 0;
              for (let deg = 15; deg <= 75; deg += 5) {
                const t = (deg * Math.PI) / 180;
                let px, py;
                if (axis === "h") {
                  const hx = hinge ? r[2] : r[0], ox = hinge ? r[0] : r[2], cy = (r[1] + r[3]) / 2;
                  px = hx + (ox - hx) * Math.cos(t); py = cy + swing * L * Math.sin(t);
                } else {
                  const hy = hinge ? r[3] : r[1], oy = hinge ? r[1] : r[3], cx = (r[0] + r[2]) / 2;
                  px = cx + swing * L * Math.sin(t); py = hy + (oy - hy) * Math.cos(t);
                }
                tot++;
                let f = false;
                for (let dy = -2; dy <= 2 && !f; dy++) for (let dx = -2; dx <= 2 && !f; dx++) if (dark(Math.round(px) + dx, Math.round(py) + dy)) f = true;
                if (f) hit++;
              }
              if (hit / tot > best) { best = hit / tot; o.hinge = hinge; o.swing = swing; }
            }
          if (best >= 0.6) o.arc = true; else { o.hinge = 0; o.swing = 1; }
        }
        out.push(o);
      }
    }
    return out;
  }

  /**
   * Wandmaske als Lauflängen (Text): je Zeile abwechselnd Längen frei/Wand, beginnend mit frei;
   * gleiche Folgezeilen als "…*k". Damit bleibt eine gespeicherte Wandkarte beim Bearbeiten exakt.
   */
  function maskToRle(mask, w, h) {
    const rows = [];
    for (let y = 0; y < h; y++) {
      const runs = [];
      let v = 0, c = 0;
      for (let x = 0; x < w; x++) {
        const b = mask[y * w + x] ? 1 : 0;
        if (b !== v) { runs.push(c); c = 0; v = b; }
        c++;
      }
      if (v) runs.push(c);
      rows.push(runs.join(","));
    }
    const out = [];
    for (let i = 0; i < rows.length; ) {
      let k = 1;
      while (i + k < rows.length && rows[i + k] === rows[i]) k++;
      out.push(k > 1 ? rows[i] + "*" + k : rows[i]);
      i += k;
    }
    return out.join(";");
  }

  function rleToMask(str, w, h) {
    const mask = new Uint8Array(w * h);
    let y = 0;
    for (const part of String(str).split(";")) {
      const [row, rep] = part.split("*");
      const runs = row === "" ? [] : row.split(",").map(Number);
      for (let k = 0; k < (rep ? Number(rep) : 1) && y < h; k++, y++) {
        let x = 0, v = 0;
        for (const len of runs) {
          if (v) mask.fill(1, y * w + Math.min(x, w), y * w + Math.min(x + len, w));
          x += len; v ^= 1;
        }
      }
    }
    if (y !== h) throw new Error("Wandmaske unvollständig");
    return mask;
  }

  /** Öffnung an Punkt p (mit Toleranz) – Index oder -1 */
  function openingAt(list, p, tol = 4) {
    let best = -1, bd = Infinity;
    list.forEach((o, i) => {
      const [x0, y0, x1, y1] = o.r;
      const dx = Math.max(0, x0 - p[0], p[0] - x1), dy = Math.max(0, y0 - p[1], p[1] - y1);
      const d = Math.hypot(dx, dy);
      if (d <= tol && d < bd) { bd = d; best = i; }
    });
    return best;
  }

  /** Handänderungen an Öffnungen der Reihe nach anwenden: {op:"add", o} | {op:"del", p} | {op:"set", p, patch} */
  function applyOpeningOps(list, ops, tol = 4) {
    const out = list.map((o) => ({ ...o, r: [...o.r] }));
    for (const op of ops || []) {
      if (op.op === "add") { out.push({ ...op.o, r: [...op.o.r] }); continue; }
      const i = openingAt(out, op.p, tol);
      if (i < 0) continue;
      if (op.op === "del") out.splice(i, 1);
      else if (op.op === "set") Object.assign(out[i], op.patch);
    }
    return out;
  }

  function nearestLabel(label, w, h, p, rad) {
    const px = Math.round(p[0]), py = Math.round(p[1]);
    let best = 0, bd = Infinity;
    for (let y = Math.max(0, py - rad); y <= Math.min(h - 1, py + rad); y++)
      for (let x = Math.max(0, px - rad); x <= Math.min(w - 1, px + rad); x++) {
        const id = label[y * w + x];
        if (!id) continue;
        const d = (x - px) ** 2 + (y - py) ** 2;
        if (d < bd) { bd = d; best = id; }
      }
    return best;
  }

  // Pfad (nur M/L/Z mit ganzen Zahlen, wie von extractWalls erzeugt) wieder in Ecken zerlegen
  function pathVertices(d) {
    const out = [];
    const re = /[ML](-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g;
    let m;
    while ((m = re.exec(d || ""))) out.push([Number(m[1]), Number(m[2])]);
    return out;
  }

  /**
   * Ausschnitt des Grundrisses im Bild finden. Grundlage sind alle dunklen Teile (8-Nachbarschaft):
   *  - einzelne Zeichen (Ausdehnung < 3 % der Bildkante) zählen nicht,
   *  - kompakte Vollflächen (Logo, Farbbalken: Füllgrad > 60 %, schmale Seite > 2 %) zählen nicht,
   *  - Start ist das Teil mit der größten Ausdehnung (Rahmen-Fläche); dazu kommen schrittweise alle
   *    Teile, deren Rahmen höchstens opts.gap (5 %) der Bildkante entfernt ist – so bleiben durch
   *    Fenster/Türen getrennte Wandstücke zusammen, Überschrift, Logo und Legende außen vor.
   * Rückgabe {x0,y0,x1,y1} in Pixeln oder null.
   */
  function detectPlanBBox(gray, w, h, opts = {}) {
    const n = w * h, M = Math.max(w, h);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += gray[i];
    const darkBg = sum / n < 128;
    const g = new Uint8Array(n);
    for (let i = 0; i < n; i++) g[i] = darkBg ? 255 - gray[i] : gray[i];
    const thr = Math.min(160, otsu(g, n));
    const dark = new Uint8Array(n);
    for (let i = 0; i < n; i++) dark[i] = g[i] < thr ? 1 : 0;
    const { label, comps } = labelComponents(dark, w, h);
    for (let k = 1; k < comps.length; k++) Object.assign(comps[k], { x0: w, y0: h, x1: -1, y1: -1 });
    for (let i = 0; i < n; i++) {
      const id = label[i];
      if (!id) continue;
      const c = comps[id], x = i % w, y = (i - x) / w;
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
    }
    const cand = comps.slice(1).filter((c) => {
      const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
      if (Math.max(bw, bh) < M * 0.03) return false;
      if (c.area / (bw * bh) > 0.6 && Math.min(bw, bh) > M * 0.02) return false;
      return true;
    });
    if (!cand.length) return detectPlanBBoxCC(gray, w, h, opts);
    cand.sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
    const D = M * (opts.gap ?? 0.05);
    const b = { x0: cand[0].x0, y0: cand[0].y0, x1: cand[0].x1, y1: cand[0].y1 };
    const used = new Uint8Array(cand.length);
    used[0] = 1;
    for (let grown = true; grown; ) {
      grown = false;
      for (let k = 1; k < cand.length; k++) {
        if (used[k]) continue;
        const c = cand[k];
        const dx = Math.max(0, c.x0 - b.x1, b.x0 - c.x1), dy = Math.max(0, c.y0 - b.y1, b.y0 - c.y1);
        if (Math.hypot(dx, dy) > D) continue;
        used[k] = 1; grown = true;
        b.x0 = Math.min(b.x0, c.x0); b.y0 = Math.min(b.y0, c.y0); b.x1 = Math.max(b.x1, c.x1); b.y1 = Math.max(b.y1, c.y1);
      }
    }
    if ((b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1) < n * 0.02) return detectPlanBBoxCC(gray, w, h, opts);
    const pad = Math.round(M * (opts.pad ?? 0.02));
    return { x0: Math.max(0, b.x0 - pad), y0: Math.max(0, b.y0 - pad), x1: Math.min(w - 1, b.x1 + pad), y1: Math.min(h - 1, b.y1 + pad) };
  }

  /* ---------- Raster (gemeinsamer Vertrag mit fp2_rooms, Layout v2) ---------- */

  // 16 × 20 Zellen à 50 cm (8 m breit, 10 m tief), Sensor oben mittig. Rohkoordinaten in cm.
  const GRID = { cols: 16, rows: 20, cell: 50, x0: -400, y0: 0 };
  const CELLS = GRID.cols * GRID.rows;
  const MAX_ZONES = 32;           // Zonen-Slots 0..31 (Zonenstatus: Belegung als 32-Bit-Maske)
  const ZONE_HOLD_DEFAULT = 5;    // Haltezeit einer Zone ohne Z-Zeile (wie ZoneDef auf dem ESP)
  const PATH_MS = 30000;          // trackMoves merkt sich die Wegstücke je ID so lange (ms)

  /** Zellindex i = row * 16 + col aus Rohkoordinaten (cm); -1 außerhalb des Rasters */
  function cellOf(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return -1;
    const col = Math.floor((x - GRID.x0) / GRID.cell), row = Math.floor((y - GRID.y0) / GRID.cell);
    if (col < 0 || col >= GRID.cols || row < 0 || row >= GRID.rows) return -1;
    return row * GRID.cols + col;
  }

  /** Ecken einer Zelle in Rohkoordinaten: [x0,y0], [x1,y0], [x1,y1], [x0,y1] */
  function cellRect(i) {
    const col = i % GRID.cols, row = (i - col) / GRID.cols;
    const x0 = GRID.x0 + col * GRID.cell, y0 = GRID.y0 + row * GRID.cell;
    return [[x0, y0], [x0 + GRID.cell, y0], [x0 + GRID.cell, y0 + GRID.cell], [x0, y0 + GRID.cell]];
  }

  function maskNew() { return new Uint8Array(CELLS); }

  function maskCount(mask) {
    let n = 0;
    for (let i = 0; i < CELLS; i++) if (mask[i]) n++;
    return n;
  }

  /**
   * Textform -> Maske: 80 Hex-Zeichen, Zeile 0 (y 0–50 cm) zuerst, je Zeile ein uint16 (4 Hex-Ziffern),
   * Bit 15 (MSB) = Spalte 0 (x −400…−350), Bit 0 = Spalte 15. Groß/Klein egal. Ungültig -> null.
   */
  function maskFromHex(hex) {
    if (typeof hex !== "string") return null;
    const s = hex.trim();
    if (s.length !== GRID.rows * 4 || !/^[0-9a-fA-F]+$/.test(s)) return null;
    const m = new Uint8Array(CELLS);
    for (let row = 0; row < GRID.rows; row++) {
      const v = parseInt(s.substr(row * 4, 4), 16);
      for (let col = 0; col < GRID.cols; col++) if (v & (0x8000 >> col)) m[row * GRID.cols + col] = 1;
    }
    return m;
  }

  /** Maske -> 80 Hex-Zeichen (Großbuchstaben) */
  function maskToHex(mask) {
    let s = "";
    for (let row = 0; row < GRID.rows; row++) {
      let v = 0;
      for (let col = 0; col < GRID.cols; col++) if (mask[row * GRID.cols + col]) v |= 0x8000 >> col;
      s += v.toString(16).toUpperCase().padStart(4, "0");
    }
    return s;
  }

  /**
   * Morphologisches Schließen: Dilatation, dann Erosion (4er-Nachbarschaft, 1 Zelle). Gerechnet wie auf
   * einer unbegrenzten Fläche (Rand mit einer freien Zelle aufgefüllt): gesetzte Zellen bleiben gesetzt,
   * am Rasterrand wächst nichts an.
   */
  function maskClose(mask) {
    const C = GRID.cols, R = GRID.rows, W = C + 2, H = R + 2;
    const at = (a, x, y) => (x >= 0 && y >= 0 && x < W && y < H ? a[y * W + x] : 0);
    const pad = new Uint8Array(W * H);
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) pad[(r + 1) * W + c + 1] = mask[r * C + c] ? 1 : 0;
    const dil = new Uint8Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        dil[y * W + x] = at(pad, x, y) | at(pad, x - 1, y) | at(pad, x + 1, y) | at(pad, x, y - 1) | at(pad, x, y + 1);
    const out = new Uint8Array(CELLS);
    for (let r = 0; r < R; r++)
      for (let c = 0; c < C; c++) {
        const x = c + 1, y = r + 1;
        out[r * C + c] = at(dil, x, y) & at(dil, x - 1, y) & at(dil, x + 1, y) & at(dil, x, y - 1) & at(dil, x, y + 1);
      }
    return out;
  }

  /** Löcher füllen: freie Zellen, die nicht über freie Zellen (4er-Nachbarschaft) mit dem Rasterrand verbunden sind, werden gesetzt */
  function maskFillHoles(mask) {
    const C = GRID.cols, R = GRID.rows;
    const reach = new Uint8Array(CELLS), stack = [];
    const push = (i) => { if (!mask[i] && !reach[i]) { reach[i] = 1; stack.push(i); } };
    for (let c = 0; c < C; c++) { push(c); push((R - 1) * C + c); }
    for (let r = 0; r < R; r++) { push(r * C); push(r * C + C - 1); }
    while (stack.length) {
      const i = stack.pop(), c = i % C, r = (i - c) / C;
      if (c > 0) push(i - 1);
      if (c < C - 1) push(i + 1);
      if (r > 0) push(i - C);
      if (r < R - 1) push(i + C);
    }
    const out = new Uint8Array(CELLS);
    for (let i = 0; i < CELLS; i++) out[i] = mask[i] || !reach[i] ? 1 : 0;
    return out;
  }

  /** Raum-Vorschlag aus besuchten Zellen (Zähler > 0): Schließen, dann Löcher füllen */
  function learnRoomFromVisits(visits) {
    const m = new Uint8Array(CELLS);
    for (let i = 0; i < CELLS; i++) m[i] = visits[i] > 0 ? 1 : 0;
    return maskFillHoles(maskClose(m));
  }

  /** Zelle aus Rohkoordinaten, auf das Raster geklemmt (Rechteck-Werkzeug darf über den Rand gezogen werden) */
  function cellClamp(x, y) {
    const col = Math.max(0, Math.min(GRID.cols - 1, Math.floor((x - GRID.x0) / GRID.cell)));
    const row = Math.max(0, Math.min(GRID.rows - 1, Math.floor((y - GRID.y0) / GRID.cell)));
    return row * GRID.cols + col;
  }

  /** Alle Zellen im Rechteck zwischen den Zellen a und b (einschließlich) auf value setzen; mask wird verändert */
  function maskRect(mask, a, b, value) {
    const C = GRID.cols;
    const c0 = Math.min(a % C, b % C), c1 = Math.max(a % C, b % C);
    const r0 = Math.min(Math.floor(a / C), Math.floor(b / C)), r1 = Math.max(Math.floor(a / C), Math.floor(b / C));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) mask[r * C + c] = value ? 1 : 0;
    return mask;
  }

  function maskFromCounts(counts, min) {
    const m = new Uint8Array(CELLS);
    for (let i = 0; i < CELLS; i++) m[i] = counts[i] >= min ? 1 : 0;
    return m;
  }

  /**
   * Bewegung je Ziel-ID über aufeinanderfolgende Meldungen; state ({}) wird fortgeschrieben.
   * moved: Position geändert seit der letzten Meldung derselben ID (neue ID: false),
   * run: Anzahl Meldungen in Folge mit bitgleicher Position (eingefrorene Spur/Geist ab 3),
   * hist: verlassene Orte [{t, x, y}] der letzten PATH_MS (t = Zeit des Verlassens, für pickMover).
   */
  function trackMoves(state, targets, now = 0) {
    const ids = state.ids || (state.ids = {});
    const seen = {};
    const out = targets.map((t) => {
      const p = ids[t.id];
      const moved = !!p && (p.x !== t.x || p.y !== t.y);
      const run = p && !moved ? p.run + 1 : 1;
      const hist = (p && p.hist ? p.hist : []).filter((e) => now - e.t <= PATH_MS);
      if (moved) hist.push({ t: now, x: p.x, y: p.y });
      ids[t.id] = { x: t.x, y: t.y, run, movedAt: moved ? now : p ? p.movedAt : null, hist };
      seen[t.id] = true;
      return { ...t, moved, run };
    });
    for (const k of Object.keys(ids)) if (!seen[k]) delete ids[k];
    return out;
  }

  /**
   * Messziel beim Ausrichten: die aktuell gemeldete ID, die in den letzten ms am weitesten von ihrem jetzigen
   * Ort entfernt war (reach, cm), mindestens minCm. Wer zur Messstelle gegangen ist, kommt von weiter her;
   * ortsfeste Geister springen nur um wenige cm hin und her, eingefrorene Spuren gar nicht.
   * Rückgabe { id, reach } oder null.
   */
  function pickMover(state, now, ms = PATH_MS, minCm = 100) {
    let best = null;
    for (const [id, s] of Object.entries(state.ids || {})) {
      const reach = reachOf(s, now, ms);
      if (reach >= minCm && (!best || reach > best.reach)) best = { id: Number(id), reach };
    }
    return best;
  }

  /** Größter Abstand (cm) eines in den letzten ms verlassenen Orts zum jetzigen Ort eines trackMoves-Eintrags */
  function reachOf(s, now, ms) {
    let reach = 0;
    for (const e of (s && s.hist) || []) if (now - e.t <= ms) reach = Math.max(reach, Math.hypot(e.x - s.x, e.y - s.y));
    return reach;
  }

  /** Raum lernen: Zelle jedes bewegten Ziels zählen. Rückgabe: Anzahl erstmals besuchter Zellen */
  function addVisits(visits, tracked) {
    let fresh = 0;
    for (const t of tracked) {
      if (!t.moved) continue;
      const c = cellOf(t.x, t.y);
      if (c < 0) continue;
      if (!visits[c]) fresh++;
      visits[c]++;
    }
    return fresh;
  }

  /** Störquellen lernen: je Meldung jede Zelle mit mindestens einem Ziel einmal zählen (bewegt oder nicht) */
  function addReport(counts, targets) {
    const hit = new Set();
    for (const t of targets) {
      const c = cellOf(t.x, t.y);
      if (c >= 0) hit.add(c);
    }
    for (const c of hit) counts[c]++;
    return hit.size;
  }

  /** Längste Folge bitgleicher Positionen in [{x,y}] */
  function identicalRun(samples) {
    let best = 0, run = 0;
    for (let i = 0; i < samples.length; i++) {
      run = i > 0 && samples[i].x === samples[i - 1].x && samples[i].y === samples[i - 1].y ? run + 1 : 1;
      if (run > best) best = run;
    }
    return best;
  }

  /* ---------- Ausrichtung Roh -> Anzeige ---------- */

  /**
   * align = { pos: [px, py], ang: rad, scale: px/cm, mirror }. f = (cos ang, sin ang) ist die Blickrichtung,
   * r = (sin ang, −cos ang) die Seitenrichtung, s = mirror ? −1 : 1: p = pos + scale · (y · f + s · x · r).
   */
  function alignApply(a, x, y) {
    const c = Math.cos(a.ang), s = Math.sin(a.ang), m = a.mirror ? -1 : 1;
    return [a.pos[0] + a.scale * (y * c + m * x * s), a.pos[1] + a.scale * (y * s - m * x * c)];
  }

  /** Umkehrung von alignApply: Anzeige -> Roh (cm) */
  function alignInvert(a, px, py) {
    const c = Math.cos(a.ang), s = Math.sin(a.ang), m = a.mirror ? -1 : 1;
    const dx = (px - a.pos[0]) / a.scale, dy = (py - a.pos[1]) / a.scale;
    return [m * (dx * s - dy * c), dx * c + dy * s];
  }

  /** Rastermodus (ohne Grundriss): Gerät i nebeneinander, Sensor oben mittig, Anzeige = (400 + i·900 + s·x, y) */
  function alignDefault(i = 0, mirror = false) {
    return { pos: [400 + i * 900, 0], ang: Math.PI / 2, scale: 1, mirror: !!mirror };
  }

  /**
   * Ausrichtung aus Sensorposition pos und Blickrichtungspunkt dirPoint (Plan), optional mit Messpunkt:
   * raw = gemessene Rohposition [x, y] (cm), tap = getippte eigene Position im Plan.
   * Mit Messpunkt: scale = |tap − pos| / |raw|, Winkel so, dass raw genau auf tap fällt (corr = Korrektur
   * gegenüber der getippten Blickrichtung). Ohne Messpunkt: Winkel aus dirPoint, 1 px/cm.
   */
  function alignFromReference(pos, dirPoint, raw, tap, mirror = false) {
    const m = mirror ? -1 : 1;
    const ang0 = Math.atan2(dirPoint[1] - pos[1], dirPoint[0] - pos[0]);
    const out = { pos: [pos[0], pos[1]], ang: ang0, scale: 1, mirror: !!mirror, corr: 0 };
    if (!raw || !tap) return out;
    const dr = Math.hypot(raw[0], raw[1]), dt = Math.hypot(tap[0] - pos[0], tap[1] - pos[1]);
    if (!(dr > 1e-9) || !(dt > 1e-9)) return out;
    const a = Math.atan2(tap[1] - pos[1], tap[0] - pos[0]) - Math.atan2(-m * raw[0], raw[1]);
    out.ang = Math.atan2(Math.sin(a), Math.cos(a));
    out.scale = dt / dr;
    out.corr = Math.atan2(Math.sin(out.ang - ang0), Math.cos(out.ang - ang0));
    return out;
  }

  /* ---------- Layout v2 (get_layout-JSON, set_layout-Text, Auswertung wie auf dem ESP) ---------- */

  const intIn = (v, lo, hi, def) => (Number.isInteger(v) && v >= lo && v <= hi ? v : def);

  /** Antwort von get_layout -> Layout der Karte (Masken als Uint8Array(320)); Fehler -> { error } */
  function parseLayoutJson(j) {
    if (!j || typeof j !== "object") return { error: "keine Antwort" };
    if (j.version !== 2) return { error: `ESP liefert Layout-Version ${j.version ?? "?"} – Firmware mit fp2_rooms v2 nötig` };
    const g = j.grid || {};
    if ((g.cols ?? 16) !== 16 || (g.rows ?? 20) !== 20 || (g.cell ?? 50) !== 50 || (g.x0 ?? -400) !== -400 || (g.y0 ?? 0) !== 0)
      return { error: "Raster des ESP passt nicht zur Karte (erwartet 16 × 20 Zellen à 50 cm)" };
    let bad = null;
    const mk = (h, what) => {
      if (h == null || h === "") return maskNew();
      const m = maskFromHex(h);
      if (!m) { bad = bad || what; return maskNew(); }
      return m;
    };
    const room = { hold: intIn(j.room && j.room.hold, 0, 3600, 5), mask: mk(j.room && j.room.mask, "Raum") };
    const excl = mk(j.excl, "Ignorieren");
    const zones = (Array.isArray(j.zones) ? j.zones : [])
      .map((z) => ({ slot: Number(z.slot), label: String(z.label ?? `Zone ${Number(z.slot) + 1}`), hold: intIn(z.hold, 0, 3600, 5), mask: mk(z.mask, "Zone " + z.slot) }))
      .filter((z) => Number.isInteger(z.slot) && z.slot >= 0 && z.slot < MAX_ZONES)
      .sort((a, b) => a.slot - b.slot);
    if (bad) return { error: `ungültige Maske (${bad}) vom ESP` };
    const on = intIn(j.filter && j.filter.on, 1, 32, 3), win = intIn(j.filter && j.filter.window, 1, 32, 10);
    return {
      version: 2, calibrated: j.calibrated === true, room, excl, zones,
      filter: { on: Math.min(on, win), window: win },
      diag: j.diag || {}, limits: j.limits || { zones: MAX_ZONES },
    };
  }

  /** Layout der Karte -> JSON wie von get_layout (für den Demo-Modus und Tests) */
  function layoutToJson(L, calibrated) {
    return {
      version: 2, calibrated: calibrated ?? maskCount(L.room.mask) > 0,
      grid: { ...GRID },
      room: { hold: L.room.hold, mask: maskToHex(L.room.mask) },
      excl: maskToHex(L.excl),
      zones: L.zones.map((z) => ({ slot: z.slot, label: z.label, hold: z.hold, mask: maskToHex(z.mask) })),
      filter: { on: L.filter.on, window: L.filter.window },
      diag: L.diag || {}, limits: L.limits || { zones: MAX_ZONES },
    };
  }

  /**
   * Layout der Karte -> Textformat v2 für set_layout. Zonen ohne Zellen mit Standard-Haltezeit entfallen:
   * ein Slot ohne Z-Zeile ist auf dem ESP leer mit 5 s (hält den Text bei 32 Slots kurz).
   */
  function layoutToText(L) {
    const lines = ["v2", `R ${L.room.hold} ${maskToHex(L.room.mask)}`];
    if (maskCount(L.excl)) lines.push(`X ${maskToHex(L.excl)}`);
    for (const z of L.zones) if (maskCount(z.mask) || z.hold !== ZONE_HOLD_DEFAULT) lines.push(`Z ${z.slot} ${z.hold} ${maskToHex(z.mask)}`);
    lines.push(`F ${L.filter.on} ${L.filter.window}`);
    return lines.join("\n");
  }

  /**
   * Textformat v2 prüfen und lesen wie parse_layout (fp2_rooms_core.h) plus die Slot-Prüfung von set_layout,
   * mit denselben Meldungen (Demo-Modus, Tests). slots: im YAML angelegte Zonen-Slots.
   * Ergebnis { ok: true, room: {hold, mask}, excl, zones: {slot: {hold, mask}}, filter } oder { ok: false, error }.
   */
  function parseLayoutText(text, slots = []) {
    const src = String(text ?? "");
    const res = { ok: true, room: null, excl: null, zones: {}, filter: { on: 3, window: 10 } };
    const fail = (msg) => ({ ok: false, error: msg });
    // Ganzzahl wie strtol: Vorzeichen erlaubt, danach nur Leerraum oder Zeilenende
    const int = (s, lo, hi) => (/^[+-]?\d+$/.test(s ?? "") && Number(s) >= lo && Number(s) <= hi ? Number(s) || 0 : null);
    let version = false, filter = false;
    const lines = src.split(/\n|;/);
    for (let k = 0; k < lines.length; k++) {
      const where = `Zeile ${k + 1}: `;
      const line = lines[k].replace(/[\r \t]+$/, "");
      if (line.includes("\0")) return fail(where + "ungültiges Zeichen (NUL)");
      const body = line.replace(/^[ \t]+/, "");
      if (!body) continue;
      const tag = body[0], rest = body.slice(1);
      const tok = rest.split(/[ \t]+/).filter((t) => t !== "");
      const mask = (w) => {
        const n = (w || "").length;
        if (n !== GRID.rows * 4) return { error: `Maske braucht ${GRID.rows * 4} Hex-Zeichen (${n} gefunden)` };
        const m = maskFromHex(w);
        return m ? { m } : { error: "ungültiges Zeichen in der Maske (nur 0-9, a-f, A-F)" };
      };
      if (tag === "v") {
        const v = rest.replace(/^[ \t]+/, "");
        if (v === "1") return fail("Format v1 wird nicht mehr unterstützt – Raum in der Karte neu einrichten");
        if (v !== "2") return fail(where + "unbekannte Version");
        version = true;
      } else if (tag === "R") {
        if (res.room) return fail(where + "Raum (R) doppelt");
        const hold = int(tok[0], 0, 3600);
        if (hold === null) return fail(where + "Haltezeit 0..3600 s");
        const m = mask(tok[1]);
        if (m.error) return fail(where + m.error);
        if (tok.length > 2) return fail(where + "zu viele Werte");
        if (!maskCount(m.m)) return fail(where + "Raum braucht mindestens 1 Zelle");
        res.room = { hold, mask: m.m };
      } else if (tag === "X") {
        if (res.excl) return fail(where + "Ignorier-Zellen (X) doppelt");
        const m = mask(tok[0]);
        if (m.error) return fail(where + m.error);
        if (tok.length > 1) return fail(where + "zu viele Werte");
        res.excl = m.m;
      } else if (tag === "Z") {
        const slot = int(tok[0], 0, MAX_ZONES - 1);
        if (slot === null) return fail(where + `Zonen-Slot 0..${MAX_ZONES - 1}`);
        if (res.zones[slot]) return fail(where + `Zone ${slot} doppelt`);
        const hold = int(tok[1], 0, 3600);
        if (hold === null) return fail(where + "Haltezeit 0..3600 s");
        const m = mask(tok[2]);
        if (m.error) return fail(where + m.error);
        if (tok.length > 3) return fail(where + "zu viele Werte");
        res.zones[slot] = { hold, mask: m.m };
      } else if (tag === "F") {
        if (filter) return fail(where + "Filter (F) doppelt");
        const on = int(tok[0], 1, 32), win = int(tok[1], 1, 32);
        if (on === null || win === null || on > win) return fail(where + "1 <= on_count <= window <= 32");
        if (tok.length > 2) return fail(where + "zu viele Werte");
        res.filter = { on, window: win };
        filter = true;
      } else return fail(where + `unbekannter Eintrag '${tag}'`);
    }
    if (!version) return fail("Versionszeile 'v2' fehlt");
    if (!res.room) return fail("Raum (R) fehlt");
    // wie set_layout: belegte Zone in einem Slot, der im YAML fehlt
    for (let i = 0; i < MAX_ZONES; i++)
      if (res.zones[i] && maskCount(res.zones[i].mask) && !slots.includes(i)) return fail(`Zonen-Slot ${i} ist im YAML nicht angelegt`);
    if (!res.excl) res.excl = maskNew();
    return res;
  }

  function cloneLayout(L) {
    return {
      ...L,
      room: { ...L.room, mask: L.room.mask.slice() },
      excl: L.excl.slice(),
      zones: L.zones.map((z) => ({ ...z, mask: z.mask.slice() })),
      filter: { ...L.filter },
      diag: { ...(L.diag || {}) },
      limits: { ...(L.limits || {}) },
    };
  }

  /** Auswertung wie auf dem ESP: gezählt ⇔ Zelle gültig ∧ Raum-Bit ∧ kein Ignorier-Bit; Zonen nur für gezählte Ziele */
  function classify(L, x, y) {
    const cell = cellOf(x, y);
    const counted = cell >= 0 && !!(L && L.room && L.room.mask[cell]) && !(L.excl && L.excl[cell]);
    const zones = counted ? L.zones.filter((z) => z.mask[cell]).map((z) => z.slot) : [];
    return { cell, counted, zones };
  }

  /* ---------- Zonenstatus (Text-Sensor des ESP) ---------- */

  /**
   * Zonenstatus lesen. Kompakt (ab 32 Zonen): {"c":0|1,"r":[an,n],"z":"<8 Hex>","n":"<32 Hex>"} – z: Bit i = Slot i
   * belegt (Slot 0 = LSB), n: Ziffer an Stelle i = Personen in Slot i (höchstens 15). Alte Form: "z":{"0":[an,n],…}.
   * Rückgabe { c, r: [an, n] | null, z: { slot: [an, n] } } oder null (kein JSON).
   */
  function parseZoneState(src) {
    let j = src;
    if (typeof src === "string") {
      try { j = JSON.parse(src); } catch (e) { return null; }
    }
    if (!j || typeof j !== "object" || Array.isArray(j)) return null;
    const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);
    const r = Array.isArray(j.r) ? [j.r[0] ? 1 : 0, num(j.r[1])] : null;
    const z = {};
    if (typeof j.z === "string") {
      const hz = j.z.trim();
      if (/^[0-9a-fA-F]{1,8}$/.test(hz)) {
        const bits = parseInt(hz, 16);
        const n = typeof j.n === "string" ? j.n.trim() : "";
        for (let i = 0; i < MAX_ZONES; i++) {
          const on = Math.floor(bits / 2 ** i) % 2;
          const cnt = i < n.length && /[0-9a-fA-F]/.test(n[i]) ? parseInt(n[i], 16) : on;   // ohne Zähler: belegt = 1 Person
          z[i] = [on, cnt];
        }
      }
    } else if (j.z && typeof j.z === "object") {
      for (const [k, v] of Object.entries(j.z)) {
        const i = Number(k);
        if (Number.isInteger(i) && i >= 0 && i < MAX_ZONES && Array.isArray(v)) z[i] = [v[0] ? 1 : 0, num(v[1])];
      }
    }
    return { c: j.c ? 1 : 0, r, z };
  }

  /** Zonenstatus in Kompaktform wie der ESP (Demo-Modus, Tests); zones: { slot: [an, n] } */
  function formatZoneState(calibrated, room, zones) {
    let bits = 0, n = "";
    for (let i = 0; i < MAX_ZONES; i++) {
      const v = zones && zones[i];
      if (v && v[0]) bits += 2 ** i;
      n += Math.min(15, Math.max(0, (v && v[1]) || 0)).toString(16);
    }
    return JSON.stringify({ c: calibrated ? 1 : 0, r: [room && room[0] ? 1 : 0, (room && room[1]) || 0], z: bits.toString(16).padStart(8, "0"), n });
  }

  /* ---------- Zonen: Namen, Farben, freie Slots (Namen/Farben liegen in HA) ---------- */

  const ZONE_COLORS = ["#ff9800", "#e91e63", "#8bc34a", "#9c27b0", "#009688", "#ffc107", "#3f51b5", "#795548", "#00bcd4", "#f44336", "#607d8b", "#cddc39"];
  const isColor = (c) => typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c);

  /** Zone hat einen Namen in HA (meta: { slot: { name, color } }) */
  function zoneNamed(meta, slot) {
    const m = meta && meta[slot];
    return !!(m && typeof m.name === "string" && m.name.trim());
  }

  // Zonentypen wie in der Aqara-App: Typ setzt Standardnamen und Symbol (mdi-Icon)
  const ZONE_TYPES = {
    sofa: { label: "Sofa-Bereich", icon: "mdi:sofa" },
    tv: { label: "TV-Bereich", icon: "mdi:television" },
    esstisch: { label: "Esstisch", icon: "mdi:table-chair" },
    arbeitstisch: { label: "Arbeitstisch", icon: "mdi:desk" },
    bett: { label: "Bett", icon: "mdi:bed" },
    kochen: { label: "Kochbereich", icon: "mdi:stove" },
    kuehlschrank: { label: "Kühlschrank", icon: "mdi:fridge" },
    waschbecken: { label: "Handwaschbecken", icon: "mdi:faucet" },
    dusche: { label: "Duschbereich", icon: "mdi:shower-head" },
    badewanne: { label: "Badewannenbereich", icon: "mdi:bathtub" },
    toilette: { label: "Toilettenbereich", icon: "mdi:toilet" },
    garderobe: { label: "Garderobe", icon: "mdi:wardrobe" },
    frisiertisch: { label: "Frisiertisch", icon: "mdi:mirror" },
    liegestuhl: { label: "Liegestuhl", icon: "mdi:seat-recline-extra" },
    entspannung: { label: "Entspannungsbereich", icon: "mdi:meditation" },
    waesche: { label: "Wäschetrocknen", icon: "mdi:tshirt-crew" },
    pflanzen: { label: "Pflanzen", icon: "mdi:flower" },
    konferenz: { label: "Konferenztisch", icon: "mdi:account-group" },
    andere: { label: "Andere", icon: "mdi:shape-outline" },
  };

  /** Anzeigename, Farbe, Typ und Symbol einer Zone: Name aus HA, sonst Label aus dem YAML; Farbe aus HA, sonst Palette nach Slot */
  function zoneInfo(z, meta) {
    const m = meta && meta[z.slot];
    const type = m && ZONE_TYPES[m.type] ? m.type : null;
    return {
      name: zoneNamed(meta, z.slot) ? m.name.trim() : z.label,
      color: m && isColor(m.color) ? m.color : ZONE_COLORS[z.slot % ZONE_COLORS.length],
      type, icon: type ? ZONE_TYPES[type].icon : null,
    };
  }

  /** Aktive Zonen: Slot mit Zellen oder mit Namen in HA */
  function activeZones(zones, meta) {
    return (zones || []).filter((z) => maskCount(z.mask) || zoneNamed(meta, z.slot));
  }

  /** Nächster freier Slot (im YAML angelegt, ohne Zellen, ohne Namen) – kleinster Slot zuerst; -1 wenn keiner frei */
  function freeZoneSlot(zones, meta) {
    const free = (zones || []).filter((z) => !maskCount(z.mask) && !zoneNamed(meta, z.slot)).map((z) => z.slot).sort((a, b) => a - b);
    return free.length ? free[0] : -1;
  }

  /** Farbe für eine neue Zone: erste Palettenfarbe, die keine aktive Zone hat (sonst reihum nach Anzahl) */
  function freeZoneColor(zones, meta) {
    const act = activeZones(zones, meta);
    const used = new Set(act.map((z) => zoneInfo(z, meta).color));
    return ZONE_COLORS.find((c) => !used.has(c)) || ZONE_COLORS[act.length % ZONE_COLORS.length];
  }

  /**
   * Was sich für die HA-Entitäten der Zonen ändert, zwischen Stand vorher (Zonen zones0 mit Masken, Namen meta0) und
   * nachher (zones1, meta1): [{ slot, label, from, to, show }] – to = neuer Anzeigename, show = true (Zone neu aktiv:
   * einblenden), false (gelöscht: ausblenden), undefined (nur umbenannt).
   */
  function zoneEntityChanges(zones0, meta0, zones1, meta1) {
    const out = [];
    const before = new Map((zones0 || []).map((z) => [z.slot, z]));
    for (const z of zones1 || []) {
      const z0 = before.get(z.slot) || { ...z, mask: new Uint8Array(CELLS) };
      const was = !!(maskCount(z0.mask) || zoneNamed(meta0, z.slot)), is = !!(maskCount(z.mask) || zoneNamed(meta1, z.slot));
      const from = zoneInfo(z0, meta0).name, to = zoneInfo(z, meta1).name;
      if (from === to && was === is) continue;
      out.push({ slot: z.slot, label: z.label, from, to, show: was === is ? undefined : is });
    }
    return out;
  }

  const ZONE_ENTITY_SUFFIXES = [" belegt", " Personen"];

  /**
   * Änderungen in der HA-Entitätsregistrierung: Entitäten der Plattform esphome desselben Geräts, deren
   * original_name "<YAML-Label> belegt" bzw. "<YAML-Label> Personen" ist. name = "<Name> belegt", null = YAML-Name;
   * hidden_by null beim Anlegen, "user" beim Löschen. entities: Antwort von config/entity_registry/list,
   * changes: zoneEntityChanges(…). Rückgabe [{ entity_id, name, hidden_by? }].
   */
  function zoneEntityUpdates(entities, deviceId, changes) {
    const out = [];
    if (!Array.isArray(entities) || !deviceId) return out;
    for (const ch of changes || []) {
      for (const e of entities) {
        if (!e || e.platform !== "esphome" || e.device_id !== deviceId) continue;
        for (const suf of ZONE_ENTITY_SUFFIXES)
          if (e.original_name === ch.label + suf) {
            const u = { entity_id: e.entity_id, name: ch.to === ch.label ? null : ch.to + suf };
            if (ch.show === true) u.hidden_by = null;
            else if (ch.show === false) u.hidden_by = "user";
            out.push(u);
          }
      }
    }
    return out;
  }

  /* ---------- Möbel (nur Anzeige, wie die Sticker der Aqara-App) ---------- */

  // Standardgrößen in cm (w = Breite, h = Tiefe); im Rastermodus ist 1 Anzeige-Einheit = 1 cm
  // Reihenfolge = Palette; die ersten 16 wie die Aufkleber der Aqara-App
  const FURNITURE = {
    tuer: { label: "Tür", w: 90, h: 90 },
    vorhang: { label: "Vorhang", w: 200, h: 15 },
    sofa: { label: "Sofa", w: 200, h: 90 },
    tv: { label: "Fernseher", w: 120, h: 30 },
    herd: { label: "Herd", w: 60, h: 60 },
    tisch: { label: "Esstisch", w: 160, h: 150 },
    stuhl: { label: "Stuhl", w: 45, h: 45 },
    pflanze: { label: "Pflanze", w: 40, h: 40 },
    bett: { label: "Bett", w: 160, h: 200 },
    schrank: { label: "Schrank", w: 120, h: 60 },
    badewanne: { label: "Badewanne", w: 170, h: 75 },
    toilette: { label: "Toilette", w: 40, h: 65 },
    schreibtisch: { label: "Arbeitstisch", w: 140, h: 70 },
    tischlampe: { label: "Tischlampe", w: 30, h: 30 },
    stehleuchte: { label: "Stehleuchte", w: 40, h: 40 },
    deckenlampe: { label: "Deckenlampe", w: 50, h: 50 },
    sessel: { label: "Sessel", w: 80, h: 80 },
    regal: { label: "Regal", w: 100, h: 35 },
    fenster: { label: "Fenster", w: 120, h: 15 },
    teppich: { label: "Teppich", w: 200, h: 140 },
    kueche: { label: "Küchenzeile", w: 240, h: 60 },
  };
  const FURN_MAX = 40;            // höchstens so viele Möbel je Liste (Aqara: 20)
  const rnd1 = (v) => Math.round(v * 10) / 10;
  const normDeg = (d) => ((Math.round(d) % 360) + 360) % 360;

  /** Neues Möbelstück, Mitte (x, y), Standardgröße in cm × scale (Anzeige-Einheiten je cm) */
  function furnitureNew(type, x, y, scale = 1) {
    const d = FURNITURE[type];
    if (!d) return null;
    const s = scale > 0 && Number.isFinite(scale) ? scale : 1;
    return { type, x: rnd1(x), y: rnd1(y), w: rnd1(d.w * s), h: rnd1(d.h * s), rot: 0 };
  }

  /**
   * Möbelliste fürs Speichern/Lesen säubern: { type, x, y, w, h, rot } – x/y = Mitte, w/h Größe (Anzeige-Einheiten),
   * rot in Grad (0..359, im Uhrzeigersinn). Unbekannte Typen und ungültige Werte fallen weg.
   */
  function furnitureClean(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const f of list) {
      if (!f || typeof f !== "object" || !FURNITURE[f.type]) continue;
      const x = Number(f.x), y = Number(f.y), w = Number(f.w), h = Number(f.h), rot = Number(f.rot ?? 0);
      if (![x, y, w, h, rot].every(Number.isFinite) || !(w > 0) || !(h > 0)) continue;
      out.push({ type: f.type, x: rnd1(x), y: rnd1(y), w: Math.max(0.1, rnd1(w)), h: Math.max(0.1, rnd1(h)), rot: normDeg(rot) });
      if (out.length >= FURN_MAX) break;
    }
    return out;
  }

  /** Punkt (Anzeige) im eigenen Rahmen des Möbelstücks (Mitte = 0, ungedreht) */
  function furnitureLocal(f, px, py) {
    const t = (f.rot * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
    const dx = px - f.x, dy = py - f.y;
    return [dx * c + dy * s, -dx * s + dy * c];
  }

  /** Eigener Rahmen -> Anzeige (SVG rotate: im Uhrzeigersinn bei y nach unten) */
  function furnitureWorld(f, lx, ly) {
    const t = (f.rot * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
    return [f.x + lx * c - ly * s, f.y + lx * s + ly * c];
  }

  /** Oberstes Möbelstück unter dem Punkt (Index) oder -1; tol erweitert die Fläche */
  function furnitureAt(list, px, py, tol = 0) {
    for (let i = (list || []).length - 1; i >= 0; i--) {
      const [lx, ly] = furnitureLocal(list[i], px, py);
      if (Math.abs(lx) <= list[i].w / 2 + tol && Math.abs(ly) <= list[i].h / 2 + tol) return i;
    }
    return -1;
  }

  /** Griff zum Größe-Ändern: Ecke rechts unten im eigenen Rahmen */
  function furnitureCorner(f) { return furnitureWorld(f, f.w / 2, f.h / 2); }

  /** Größe über den Eckgriff ändern: gegenüberliegende Ecke bleibt fest, Drehung bleibt; min = kleinste Seite */
  function furnitureResize(f, px, py, min = 10) {
    const fixed = furnitureWorld(f, -f.w / 2, -f.h / 2);
    const t = (f.rot * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
    const dx = px - fixed[0], dy = py - fixed[1];
    const w = Math.max(min, dx * c + dy * s), h = Math.max(min, -dx * s + dy * c);
    return { ...f, w: rnd1(w), h: rnd1(h), x: rnd1(fixed[0] + (w / 2) * c - (h / 2) * s), y: rnd1(fixed[1] + (w / 2) * s + (h / 2) * c) };
  }

  /** Um deg Grad weiterdrehen (Standard 15°) */
  function furnitureRotate(f, deg = 15) { return { ...f, rot: normDeg(f.rot + deg) }; }

  /**
   * Symbol als SVG-Elemente im eigenen Rahmen (Mitte 0, Breite w, Tiefe h; Rückseite/Wand oben bei −h/2).
   * Klassen: f-b Körper, f-l Linie, f-d dunkle Fläche, f-g Pflanze, f-r Teppich.
   */
  function furnitureShape(type, w, h) {
    const a = w / 2, b = h / 2, m = Math.min(w, h);
    const n = (v) => rnd1(v);
    const rect = (x, y, rw, rh, rx, cls) => `<rect x="${n(x)}" y="${n(y)}" width="${n(rw)}" height="${n(rh)}" rx="${n(rx)}" class="${cls}"/>`;
    const path = (d, cls = "f-l") => `<path d="${d}" class="${cls}"/>`;
    const circ = (cx, cy, r, cls) => `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" class="${cls}"/>`;
    const sofa = (cushions) => {
      const back = h * 0.28, arm = Math.min(w * 0.14, h * 0.3);
      const k = cushions || Math.max(1, Math.min(4, Math.round((w - 2 * arm) / (h - back))));
      let d = `M${n(-a + arm)} ${n(-b + back)}H${n(a - arm)}M${n(-a + arm)} ${n(-b + back)}V${n(b)}M${n(a - arm)} ${n(-b + back)}V${n(b)}`;
      for (let i = 1; i < k; i++) { const x = -a + arm + ((w - 2 * arm) * i) / k; d += `M${n(x)} ${n(-b + back)}V${n(b)}`; }
      return rect(-a, -b, w, h, m * 0.12, "f-b") + path(d);
    };
    switch (type) {
      case "sofa": return sofa(0);
      case "sessel": return sofa(1);
      case "bett": {
        const two = w / h >= 0.6, pw = two ? w * 0.38 : w * 0.7, py = -b + h * 0.05, ph = h * 0.15;
        const pil = two ? rect(-a + w * 0.08, py, pw, ph, ph * 0.3, "f-l") + rect(a - w * 0.08 - pw, py, pw, ph, ph * 0.3, "f-l") : rect(-pw / 2, py, pw, ph, ph * 0.3, "f-l");
        return rect(-a, -b, w, h, m * 0.04, "f-b") + pil + path(`M${n(-a)} ${n(-b + h * 0.28)}H${n(a)}M${n(-a)} ${n(-b + h * 0.28)}L${n(-a + w * 0.3)} ${n(-b + h * 0.38)}`);
      }
      case "tisch": {
        // Tisch mit je zwei Stühlen oben und unten
        const ch = h * 0.18, cw = Math.min(w * 0.25, ch * 2.2);
        const chairs = [-1, 1].map((sx) => [-1, 1].map((sy) => rect(sx * w * 0.25 - cw / 2, sy < 0 ? -b : b - ch, cw, ch, ch * 0.25, "f-l")).join("")).join("");
        return chairs + rect(-a, -b + ch * 1.15, w, h - ch * 2.3, m * 0.06, "f-b");
      }
      case "vorhang": {
        // Stange oben, Stoff als Wellenlinie
        const k = Math.max(3, Math.round(w / Math.max(h * 2, 1e-9)));
        let d = `M${n(-a)} ${n(-b)}H${n(a)}M${n(-a)} ${n(b * 0.2)}`;
        for (let i = 0; i < k; i++) d += `Q${n(-a + (w * (i + 0.5)) / k)} ${n(i % 2 ? b : -b * 0.6)} ${n(-a + (w * (i + 1)) / k)} ${n(b * 0.2)}`;
        return `<rect x="${n(-a)}" y="${n(-b)}" width="${n(w)}" height="${n(h)}" class="f-hit"/>` + path(d, "f-l f-thick");
      }
      case "herd": {
        const cr = m * 0.15;
        return rect(-a, -b, w, h, m * 0.05, "f-b") + [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([i, j]) => circ(i * w * 0.23, j * h * 0.23, cr, "f-l")).join("");
      }
      case "badewanne":
        return rect(-a, -b, w, h, m * 0.12, "f-b") + rect(-a + m * 0.12, -b + m * 0.12, w - m * 0.24, h - m * 0.24, m * 0.3, "f-l") + circ(-a + w * 0.18, 0, m * 0.05, "f-l");
      case "toilette":
        return rect(-a, -b, w, h * 0.28, m * 0.08, "f-b") + `<ellipse cx="0" cy="${n(-b + h * 0.64)}" rx="${n(a * 0.85)}" ry="${n(h * 0.35)}" class="f-b"/>`;
      case "tischlampe":
      case "stehleuchte":
      case "deckenlampe": {
        // Leuchten: Kreis mit Kreuz; Stehleuchte mit Fuß in der Mitte, Deckenlampe mit Strahlen
        const r = m * 0.48, k = r * 0.7;
        let s = `<ellipse cx="0" cy="0" rx="${n(a * 0.96)}" ry="${n(b * 0.96)}" class="f-b"/>` + path(`M${n(-k)} ${n(-k)}L${n(k)} ${n(k)}M${n(k)} ${n(-k)}L${n(-k)} ${n(k)}`);
        if (type === "stehleuchte") s += circ(0, 0, r * 0.35, "f-d");
        if (type === "deckenlampe")
          s += path([0, 1, 2, 3].map((i) => { const t = (i * Math.PI) / 2 + Math.PI / 4; return `M${n(Math.cos(t) * r * 1.05)} ${n(Math.sin(t) * r * 1.05)}L${n(Math.cos(t) * r * 0.75)} ${n(Math.sin(t) * r * 0.75)}`; }).join(""));
        return s;
      }
      case "stuhl": return rect(-a, -b + h * 0.22, w, h * 0.78, m * 0.12, "f-b") + rect(-a, -b, w, h * 0.18, m * 0.06, "f-d");
      case "schreibtisch":
        return rect(-a, -b, w, h, m * 0.04, "f-b") + rect(-w * 0.18, -b + h * 0.1, w * 0.36, h * 0.1, 0, "f-d") + rect(-w * 0.15, -b + h * 0.45, w * 0.3, h * 0.16, h * 0.03, "f-l");
      case "schrank":
        return rect(-a, -b, w, h, 0, "f-b") + path(`M0 ${n(-b)}V${n(b)}M${n(-a)} ${n(-b)}L${n(a)} ${n(b)}M${n(a)} ${n(-b)}L${n(-a)} ${n(b)}`);
      case "regal": {
        const k = Math.max(2, Math.min(8, Math.round(w / Math.max(h, 1e-9))));
        let d = "";
        for (let i = 1; i < k; i++) d += `M${n(-a + (w * i) / k)} ${n(-b)}V${n(b)}`;
        return rect(-a, -b, w, h, 0, "f-b") + path(d);
      }
      case "tv": return rect(-a, -b + h * 0.35, w, h * 0.65, m * 0.1, "f-b") + rect(-a * 0.8, -b, w * 0.8, h * 0.25, h * 0.05, "f-d");
      case "pflanze": {
        let d = "";
        for (let i = 0; i < 6; i++) {
          const t = (i * Math.PI) / 3;
          d += `M${n(Math.cos(t) * a * 0.35)} ${n(Math.sin(t) * b * 0.35)}L${n(Math.cos(t) * a * 0.85)} ${n(Math.sin(t) * b * 0.85)}`;
        }
        return `<ellipse cx="0" cy="0" rx="${n(a)}" ry="${n(b)}" class="f-g"/>` + path(d) + circ(0, 0, m * 0.18, "f-b");
      }
      case "tuer":
        // Wandöffnung oben, Anschlag links, Blatt nach unten aufgeschlagen, Viertelkreis bis zur Öffnung rechts
        return `<rect x="${n(-a)}" y="${n(-b)}" width="${n(w)}" height="${n(h)}" class="f-hit"/>` + path(`M${n(-a)} ${n(-b)}H${n(a)}`, "f-l f-dash") + path(`M${n(-a)} ${n(-b)}V${n(b)}`, "f-l f-thick") + path(`M${n(a)} ${n(-b)}A${n(w)} ${n(h)} 0 0 1 ${n(-a)} ${n(b)}`);
      case "fenster": return rect(-a, -b, w, h, 0, "f-b") + path(`M${n(-a)} 0H${n(a)}`);
      case "teppich": return rect(-a, -b, w, h, m * 0.03, "f-r") + rect(-a + m * 0.08, -b + m * 0.08, w - m * 0.16, h - m * 0.16, 0, "f-l f-dash");
      case "kueche": {
        const sx = -a + w * 0.08, cr = Math.min(w * 0.05, h * 0.14), cx = a - w * 0.22;
        return rect(-a, -b, w, h, 0, "f-b") + rect(sx, -b + h * 0.2, w * 0.22, h * 0.6, m * 0.08, "f-l")
          + [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([i, j]) => circ(cx + i * w * 0.07, j * h * 0.2, cr, "f-l")).join("");
      }
      default: return rect(-a, -b, w, h, 0, "f-b");
    }
  }

  return {
    decodeTargets, fitHomography, apply, residuals, pointInPolygon,
    stability, median, polygonCentroid, inv3, minTriangleSpread, detectPlanBBox,
    extractWalls, finishWalls, detectOpenings, openingAt, applyOpeningOps, maskToRle, rleToMask,
    distanceTransform, distanceTo, traceContours, simplifyLoop, pathVertices, nearestLabel,
    GRID, CELLS, cellOf, cellRect, maskNew, maskCount, maskFromHex, maskToHex, maskClose, maskFillHoles,
    learnRoomFromVisits, maskFromCounts, cellClamp, maskRect, trackMoves, pickMover, reachOf, addVisits, addReport, identicalRun,
    alignApply, alignInvert, alignDefault, alignFromReference,
    parseLayoutJson, layoutToJson, layoutToText, parseLayoutText, cloneLayout, classify,
    MAX_ZONES, parseZoneState, formatZoneState,
    ZONE_COLORS, ZONE_TYPES, zoneNamed, zoneInfo, activeZones, freeZoneSlot, freeZoneColor, zoneEntityChanges, zoneEntityUpdates,
    FURNITURE, furnitureNew, furnitureClean, furnitureLocal, furnitureWorld, furnitureAt, furnitureCorner,
    furnitureResize, furnitureRotate, furnitureShape,
  };
})();

/* ------------------------------------------------------------------ */
/* Lovelace-Karte                                                     */
/* ------------------------------------------------------------------ */

if (typeof window !== "undefined" && typeof HTMLElement !== "undefined") {
  const CARD_VERSION = "0.10.1";
  const STORE_PREFIX = "fp2_room_card_";
  // { version, floorplan, furniture, devices: { <device>: { align, mirror, zones: { <slot>: { name, color } }, furniture } } }
  // furniture: Möbel auf dem Grundriss (Plan-Koordinaten); devices[].furniture: Möbel im Raster des Geräts (cm)
  const STORE_VERSION = 3;
  const COLORS = ["#03a9f4", "#ff9800", "#8bc34a", "#e91e63", "#9c27b0", "#009688", "#ffc107", "#795548"];
  const TICK_MS = 250;            // Uhr für Countdown, Messdauer und Anzeige
  const MEASURE_MS = 2500;        // Messung beim Ausrichten (Median der Meldungen)
  const FROZEN_RUN = 3;           // ab so vielen bitgleichen Meldungen in Folge gilt eine Position als eingefroren
  const MOVER_MS = 30000;         // Messziel beim Ausrichten: längster Weg in diesem Zeitraum …
  const MOVER_MIN_CM = 100;       // … und mindestens so viel (Geister springen nur um wenige cm)
  const STILL_MS = 1000;          // vor „Messen“ so lange ohne Sprung über stable_tolerance (Spiegelungen laufen mit)
  const REPEAT_MS = 750;          // FP2 ca. 1,33 Frames/s; HA meldet gleiche Frames nicht – so lange unverändert gilt als Wiederholung
  const INTERF_WAIT_MS = 20000;   // Störquellen lernen: Zeit zum Verlassen des Raums
  const INTERF_REC_MS = 120000;   // Störquellen lernen: Aufnahmedauer
  const INTERF_MIN = 2;           // Zelle wird vorgeschlagen ab so vielen Meldungen mit Ziel
  const TRAIL_MS = 2500;
  const PLAN_MAX = 1000;          // Wandkarte: längste Seite in Plan-Einheiten (= Pixel der Auswertung)
  const FOV_DEG = 60;             // Blickfeld ±60° (gemessen −63°…+64°)
  // Montage laut hansihe mounting_position_sensor (nur Anzeige; das Raster dreht die Radar-Firmware selbst)
  const MOUNTS = { 1: "Wand", 2: "Ecke links", 3: "Ecke rechts" };
  const MOUNT_FROM_ESP = { wall: 1, left_upper_corner: 2, right_upper_corner: 3 };
  // Demo: Standard-Raum 4 × 5 m vor dem Sensor (Roh-cm), ein ortsfester Geist, Zonen-Slots wie im Beispiel-YAML
  const DEMO_ROOM = { x0: -200, x1: 200, y0: 0, y1: 500 };
  const DEMO_GHOST = { id: 3, x: 130, y: 330 };
  const DEMO_ZONES = Array.from({ length: 32 }, (_, i) => ({ slot: i, label: ["Sofa", "Schreibtisch", "Esstisch"][i] || `Zone ${i + 1}` }));
  const DEMO_FRAME_MS = 500;      // Meldungsabstand im Demo (echter FP2 ca. 750 ms)

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : "–");
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const r1 = (v) => Math.round(v * 10) / 10;

  class FP2RoomCard extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._hass = null;
      this._config = null;
      this._store = null;        // HA: Wandkarte + Ausrichtung je Gerät
      this._layouts = {};        // device -> Layout vom ESP (Masken als Uint8Array)
      this._drafts = {};         // device -> bearbeitetes, ungespeichertes Layout
      this._loaded = false;
      this._view = "live";       // live | setup | crop | walls | learn | interf | edit | align
      this._learn = null;
      this._interf = null;
      this._edit = null;
      this._align = null;
      this._trails = new Map();
      this._timer = null;
    }

    static getStubConfig() {
      return { title: "Anwesenheit", devices: [{ device: "fp2_wohnzimmer", name: "Wohnzimmer", targets: "sensor.fp2_wohnzimmer_targets", state: "sensor.fp2_wohnzimmer_zonenstatus" }] };
    }

    setConfig(config) {
      this._demo = !!(config && config.demo);
      if (this._demo && (!config.devices || !config.devices.length))
        config = { ...config, devices: [{ device: "demo", name: "Demo-Raum", targets: "demo" }] };
      if (!config || !Array.isArray(config.devices) || config.devices.length === 0)
        throw new Error("fp2-room-card: 'devices' fehlt (Liste mit device, targets)");
      for (const d of config.devices) {
        if (!d.device) throw new Error("fp2-room-card: jedes Gerät braucht 'device' (ESPHome-Name, z. B. fp2_wohnzimmer)");
        if (!d.targets) throw new Error("fp2-room-card: jedes Gerät braucht 'targets' (Text-Sensor Targets)");
      }
      this._config = {
        title: config.title ?? "Anwesenheit",
        storage_key: config.storage_key ?? (this._demo ? "demo" : "default"),
        stable_tolerance: Number(config.stable_tolerance ?? 30),
        show_raw: config.show_raw ?? false,
        devices: config.devices.map((d) => ({
          device: String(d.device).replace(/-/g, "_"),
          name: d.name ?? d.device,
          targets: d.targets,
          state: d.state ?? null,
          mounting: d.mounting ?? null,
        })),
      };
      this._renderShell();
    }

    set hass(hass) {
      const first = !this._hass;
      this._hass = hass;
      if (first) this._loadAll();
      this._onHassUpdate();
    }

    getCardSize() { return 8; }
    disconnectedCallback() { this._stopTimer(); if (this._demoTimer) clearInterval(this._demoTimer); this._demoTimer = null; }
    connectedCallback() {
      if (this._demo && this._loaded && !this._demoTimer) this._demoStart();
      if (this._view === "learn" || this._view === "interf" || this._view === "align") this._startTimer();
    }

    /* ---------------- Daten: HA-Speicher + ESP ---------------- */

    get _storeKey() { return STORE_PREFIX + this._config.storage_key; }
    _dev(device) { return this._config.devices.find((d) => d.device === device); }
    _devIndex(device) { return this._config.devices.findIndex((d) => d.device === device); }

    async _loadAll() {
      await this._readStore();
      if (this._demo) await this._demoLoad();
      await Promise.all(this._config.devices.map((d) => this._fetchLayout(d.device)));
      this._loaded = true;
      if (this._demo) this._demoStart();
      this._renderShell();
    }

    /**
     * HA-Speicher lesen. Schlägt das fehl, bleibt _storeError gesetzt und _saveStore schreibt nicht –
     * sonst überschriebe der leere Ersatz-Store den gespeicherten Grundriss.
     */
    async _readStore() {
      let v = null;
      try {
        const res = await this._hass.callWS({ type: "frontend/get_system_data", key: this._storeKey });
        v = res && res.value ? res.value : null;
        this._storeError = null;
      } catch (e) {
        this._storeError = e.message || String(e);
      }
      // Ältere Stores (Ecken/Homographie): Grundriss übernehmen, Geräte zurücksetzen
      if (!v || typeof v !== "object" || v.version !== STORE_VERSION) v = { version: STORE_VERSION, floorplan: (v && v.floorplan) ?? null, devices: {} };
      if (!v.devices || typeof v.devices !== "object") v.devices = {};
      // Möbel und Zonen-Namen säubern (fremde/kaputte Einträge sollen die Anzeige nicht stören)
      if (v.furniture !== undefined) v.furniture = FP2Math.furnitureClean(v.furniture);
      for (const s of Object.values(v.devices)) {
        if (!s || typeof s !== "object") continue;
        if (s.furniture !== undefined) s.furniture = FP2Math.furnitureClean(s.furniture);
        if (s.zones !== undefined && (!s.zones || typeof s.zones !== "object" || Array.isArray(s.zones))) s.zones = {};
      }
      this._store = v;
    }

    /** „Neu laden“: HA-Speicher (falls nicht lesbar) und fehlerhafte Layouts erneut holen */
    async _reload() {
      if (this._storeError) await this._readStore();
      await Promise.all(this._config.devices.filter((d) => !this._layouts[d.device] || this._layouts[d.device].error).map((d) => this._fetchLayout(d.device)));
      this._toast(this._storeError ? "HA-Speicher weiterhin nicht lesbar: " + this._storeError : "Neu geladen");
      this._renderShell();
    }

    _storeErrorHtml() {
      return this._storeError
        ? `<div class="warn small">HA-Speicher (${esc(this._storeKey)}) konnte nicht gelesen werden: ${esc(this._storeError)}. Grundriss und Ausrichtung fehlen und werden nicht gespeichert. <button class="btn ghost sm" data-act="reload">Neu laden</button></div>`
        : "";
    }

    /** Layout vom ESP (get_layout, v2) holen und in Masken umwandeln; Fehler -> { error } */
    async _fetchLayout(device) {
      let L;
      try {
        let j;
        if (this._demo) j = this._demoGetLayout();
        else {
          const r = await this._hass.callService("esphome", `${device}_get_layout`, {}, undefined, false, true);
          j = r && r.response ? r.response : null;
          if (!j) throw new Error("keine Antwort");
        }
        L = FP2Math.parseLayoutJson(j);
      } catch (e) {
        L = { error: e.message || String(e), svc: true };   // svc: Aufruf selbst fehlgeschlagen
      }
      this._layouts[device] = L;
      return L;
    }

    /** Layout als Text v2 auf den ESP übertragen (set_layout) und neu laden */
    async _pushLayout(device, L) {
      const text = FP2Math.layoutToText(L);
      if (this._demo) await this._demoSetLayout(text);
      else {
        const r = await this._hass.callService("esphome", `${device}_set_layout`, { layout: text }, undefined, false, true);
        const res = r && r.response ? r.response : null;
        if (!res || !res.ok) { const e = new Error(res && res.error ? res.error : "keine Antwort vom ESP"); e.rejected = true; throw e; }
      }
      const N = await this._fetchLayout(device);
      if (N.error) { const e = new Error(N.error); e.stored = true; throw e; }   // gespeichert, nur Neuladen fehlgeschlagen
    }

    async _saveStore() {
      if (this._storeError) {
        this._toast("Nicht gespeichert: HA-Speicher konnte nicht gelesen werden – erst „Neu laden“");
        return false;
      }
      try {
        await this._hass.callWS({ type: "frontend/set_system_data", key: this._storeKey, value: this._store });
        return true;
      } catch (e) {
        this._toast("Speichern in HA fehlgeschlagen: " + (e.message || e) + " (Admin-Rechte nötig)");
        return false;
      }
    }

    /** HA-Eintrag eines Geräts zum Ändern (legt ihn bei Bedarf an) */
    _devStore(device) {
      const s = this._store.devices;
      if (!s[device] || typeof s[device] !== "object") s[device] = { align: null, mirror: false };
      return s[device];
    }

    _isAdmin() { return !this._hass || !this._hass.user || this._hass.user.is_admin; }

    /* ---------------- Zonen-Namen und Möbel (HA) ---------------- */

    /** Namen/Farben der Zonen eines Geräts: im Editor der Entwurf, sonst aus HA ({ slot: { name, color } }) */
    _zmeta(device) {
      if (this._view === "edit" && this._edit && this._edit.device === device) return this._edit.zmeta;
      const s = this._store && this._store.devices[device];
      return (s && s.zones) || {};
    }

    _zoneInfo(device, z) { return FP2Math.zoneInfo(z, this._zmeta(device)); }

    /** Möbelliste: owner "plan" = Grundriss (Plan-Koordinaten), sonst Gerät (Raster, cm); im Editor der Entwurf */
    _furnList(owner) {
      const e = this._view === "edit" ? this._edit : null;
      if (e && e.furnOwner === owner) return e.furn;
      if (owner === "plan") return (this._store && this._store.furniture) || [];
      const s = this._store && this._store.devices[owner];
      return (s && s.furniture) || [];
    }

    _furnListSvg(list, u) {
      return (list || []).map((f) => `<g class="furn" transform="translate(${f.x} ${f.y})${f.rot ? ` rotate(${f.rot})` : ""}" stroke-width="${r1(u * 0.16) || 0.1}">${FP2Math.furnitureShape(f.type, f.w, f.h)}</g>`).join("");
    }

    /** Möbel der aktuellen Ansicht: auf dem Grundriss die des Plans, im Raster je Gerät (Gerät i um i·900 verschoben) */
    _furnitureSvg() {
      const sc = this._scene();
      const u = this._u();
      if (sc.fp) return this._furnListSvg(this._furnList("plan"), u);
      return sc.items.map((it) => {
        const s = this._furnListSvg(this._furnList(it.d.device), u);
        const dx = it.align.pos[0] - 400;
        return s && dx ? `<g transform="translate(${dx} 0)">${s}</g>` : s;
      }).join("");
    }

    /**
     * Zonen-Entitäten in HA anpassen: umbenennen ("<Name> belegt" / "<Name> Personen", null = Name aus dem YAML),
     * neue Zonen einblenden (hidden_by null), gelöschte ausblenden (hidden_by "user"). Gerät über die Targets-Entität
     * der Karte. Nur für Admins; Fehler blockieren nichts. Rückgabe: Meldung für den Toast ("" = nichts).
     */
    async _renameZoneEntities(device, changes) {
      if (this._demo || !changes.length || !this._isAdmin()) return "";
      const d = this._dev(device);
      let list;
      try {
        list = await this._hass.callWS({ type: "config/entity_registry/list" });
        if (!Array.isArray(list)) throw new Error("keine Liste");
      } catch (e) {
        return "Entitäten nicht umbenannt: Registrierung nicht lesbar (" + (e.message || e) + ")";
      }
      const own = list.find((x) => x && x.entity_id === d.targets);
      if (!own || !own.device_id) return `Entitäten nicht umbenannt: Gerät von ${d.targets} nicht gefunden`;
      const ups = FP2Math.zoneEntityUpdates(list, own.device_id, changes);
      if (!ups.length) return "Keine passenden Zonen-Entitäten gefunden";
      const failed = [];
      for (const u of ups) {
        try { await this._hass.callWS({ type: "config/entity_registry/update", ...u }); }
        catch (e) { failed.push(u.entity_id); }
      }
      const okN = ups.length - failed.length;
      return `${okN} Entität${okN === 1 ? "" : "en"} angepasst${failed.length ? ` – fehlgeschlagen: ${failed.join(", ")}` : ""}`;
    }

    /* ---------------- Grundriss zuschneiden ---------------- */

    async _startCrop(file) {
      const url = URL.createObjectURL(file);
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error("kein lesbares Bild (PNG, JPG oder GIF)"));
        im.src = url;
      });
      const w = img.naturalWidth, h = img.naturalHeight;
      // Erkennung auf Kopie mit längster Seite 1000 px (kleiner werden dünne Wände und Schrift ununterscheidbar)
      const sc = 1000 / Math.max(w, h);
      const cw = Math.max(1, Math.round(w * sc)), ch = Math.max(1, Math.round(h * sc));
      const cv = document.createElement("canvas");
      cv.width = cw; cv.height = ch;
      const cx = cv.getContext("2d");
      cx.imageSmoothingEnabled = true;
      cx.imageSmoothingQuality = "high";
      cx.fillStyle = "#fff"; cx.fillRect(0, 0, cw, ch);   // transparente PNGs auf Weiß
      cx.drawImage(img, 0, 0, cw, ch);
      const data = cx.getImageData(0, 0, cw, ch).data;
      const gray = new Uint8Array(cw * ch);
      for (let i = 0; i < cw * ch; i++) gray[i] = (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000;
      const b = FP2Math.detectPlanBBox(gray, cw, ch);
      const full = [0, 0, w, h];
      const auto = b ? [b.x0 / sc, b.y0 / sc, Math.min(w, (b.x1 + 1) / sc), Math.min(h, (b.y1 + 1) / sc)].map(Math.round) : null;
      this._crop = { file, url, img, w, h, full, auto, rect: auto || full };
      this._view = "crop";
      this._renderShell();
      if (!auto) this._toast("Grundriss nicht eindeutig erkannt – bitte Bereich aufziehen");
    }

    _cropHtml() {
      const c = this._crop;
      const [x0, y0, x1, y1] = c.rect;
      return `
        <div class="instruction">Grundriss zuschneiden</div>
        <div class="hint">${c.auto ? "Der Grundriss wurde automatisch erkannt (Rahmen). " : ""}Zum Ändern einen neuen Rahmen aufziehen. Nur im Rahmen werden im nächsten Schritt die Wände gesucht.</div>
        <div class="plan-wrap drawing crop">
          <svg id="plan" viewBox="0 0 ${c.w} ${c.h}" preserveAspectRatio="xMidYMid meet">
            <image href="${c.url}" x="0" y="0" width="${c.w}" height="${c.h}" preserveAspectRatio="none"/>
            <g id="edit-layer"></g>
          </svg>
        </div>
        <div class="hint small">Ausschnitt: ${Math.round(x1 - x0)} × ${Math.round(y1 - y0)} px von ${c.w} × ${c.h} px</div>
        <div class="actions">
          <button class="btn ghost" data-act="crop-cancel">Abbrechen</button>
          ${c.auto ? `<button class="btn ghost" data-act="crop-auto">Automatisch</button>` : ""}
          <button class="btn ghost" data-act="crop-full">Ganzes Bild</button>
          <button class="btn" data-act="crop-ok">Weiter</button>
        </div>`;
    }

    _drawCropLayer(preview) {
      const c = this._crop;
      const layer = this.shadowRoot.getElementById("edit-layer");
      if (!c || !layer) return;
      const [x0, y0, x1, y1] = preview || c.rect;
      const u = Math.max(c.w, c.h) / 100;
      layer.innerHTML = `
        <path d="M0 0H${c.w}V${c.h}H0Z M${x0} ${y0}V${y1}H${x1}V${y0}Z" fill="#000" fill-opacity="0.45" fill-rule="evenodd"/>
        <rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="none" stroke="#ff5722" stroke-width="${u * 0.4}"/>
        ${[[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="${u * 0.9}" fill="#ff5722" stroke="#fff" stroke-width="${u * 0.2}"/>`).join("")}`;
    }

    _bindCropDrag(svg) {
      const c = this._crop;
      let start = null;
      const clamp = (p) => [Math.max(0, Math.min(c.w, p[0])), Math.max(0, Math.min(c.h, p[1]))];
      const rectOf = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
      svg.addEventListener("pointerdown", (ev) => {
        const p = this._planPoint(ev);
        if (!p) return;
        ev.preventDefault();
        start = clamp(p);
        try { svg.setPointerCapture(ev.pointerId); } catch (x) { /* ignorieren */ }
      });
      svg.addEventListener("pointermove", (ev) => {
        if (!start) return;
        const p = this._planPoint(ev);
        if (p) this._drawCropLayer(rectOf(start, clamp(p)));
      });
      svg.addEventListener("pointerup", (ev) => {
        if (!start) return;
        const p = this._planPoint(ev);
        const a = start;
        start = null;
        if (!p) return;
        const r = rectOf(a, clamp(p)).map(Math.round);
        if (r[2] - r[0] < c.w * 0.05 || r[3] - r[1] < c.h * 0.05) { this._toast("Rahmen zu klein"); this._drawCropLayer(); return; }
        c.rect = r;
        this._renderShell();
      });
      svg.addEventListener("pointercancel", () => { start = null; this._drawCropLayer(); });
    }

    /* ---------------- Wände, Türen, Fenster: übernehmen und bearbeiten ---------------- */

    /** Ausschnitt auf Planauflösung bringen (längste Seite PLAN_MAX px), Wände/Türen/Fenster erkennen */
    _startWalls() {
      const c = this._crop;
      const [x0, y0, x1, y1] = c.rect;
      const sw = x1 - x0, sh = y1 - y0;
      const s = PLAN_MAX / Math.max(sw, sh);
      const w = Math.max(1, Math.round(sw * s)), h = Math.max(1, Math.round(sh * s));
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      const cx = cv.getContext("2d");
      cx.imageSmoothingEnabled = true;
      cx.imageSmoothingQuality = "high";
      cx.fillStyle = "#fff"; cx.fillRect(0, 0, w, h);
      cx.drawImage(c.img, x0, y0, sw, sh, 0, 0, w, h);
      const data = cx.getImageData(0, 0, w, h).data;
      const gray = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) gray[i] = (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000;
      this._walls = this._newWallsState(w, h, { mode: "import", gray, src: cv.toDataURL("image/jpeg", 0.7) });   // Vorlage nur zur Ansicht
      this._wallsRecompute();
      this._view = "walls";
      this._renderShell();
    }

    /** gespeicherte Wandkarte bearbeiten (ohne Bild): Pfad wieder rastern, Öffnungen übernehmen */
    _editWallMap() {
      const fp = this._store.floorplan;
      const w = fp.width, h = fp.height;
      let base;
      if (fp.m) base = FP2Math.rleToMask(fp.m, w, h);          // exakte Maske (gespeichert)
      else {                                                     // sonst Pfad rastern
        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        const cx = cv.getContext("2d");
        cx.fillStyle = "#fff"; cx.fillRect(0, 0, w, h);
        cx.fillStyle = "#000";
        cx.fill(new Path2D(fp.d), "evenodd");
        const data = cx.getImageData(0, 0, w, h).data;
        base = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) base[i] = data[i * 4] < 128 ? 1 : 0;
      }
      this._walls = this._newWallsState(w, h, { mode: "existing", base, baseOpenings: clone(fp.openings || []), params: fp.params || {} });
      this._wallsRecompute();
      this._view = "walls";
      this._renderShell();
    }

    _newWallsState(w, h, extra) {
      return {
        w, h, opts: { threshold: 128, thickness: 7, close: 0 }, manual: {},   // manual: vom Nutzer verstellte Regler
        removed: [], edits: [], openOps: [], history: [], tool: "part", showSrc: true, result: null, openings: [],
        ...extra,
      };
    }

    _wallsRecompute() {
      const W = this._walls;
      const tol = Math.max(4, W.w / 150);
      if (W.mode === "existing") {
        const fin = FP2Math.finishWalls(W.base.slice(), W.w, W.h, { removed: W.removed, edits: W.edits, pick: 8 });
        W.result = { ...fin, openings: W.baseOpenings, params: W.params };
      } else {
        W.result = FP2Math.extractWalls(W.gray, W.w, W.h, {
          close: W.opts.close,
          threshold: W.manual.threshold ? W.opts.threshold : undefined,
          thickness: W.manual.thickness ? W.opts.thickness : undefined,
          removed: W.removed, edits: W.edits,
        });
        for (const k of ["threshold", "thickness"]) if (!W.manual[k]) W.opts[k] = W.result.params[k];
      }
      W.openings = FP2Math.applyOpeningOps(W.result.openings, W.openOps, tol);
    }

    _wallsHtml() {
      const W = this._walls;
      const r = W.result;
      const imp = W.mode === "import";
      const slider = (key, label, min, max, hint) => `
        <label class="field slider"><span>${label}: <b id="wl-val-${key}">${W.opts[key]}</b> <span class="small" id="wl-auto-${key}">${hint || (W.manual[key] ? "" : "(automatisch)")}</span></span>
          <input type="range" min="${min}" max="${max}" step="1" value="${W.opts[key]}" data-act="wl-${key}"></label>`;
      const tools = [["part", "Entfernen"], ["erase", "Radieren"], ["add", "Wand"], ["door", "Tür"], ["window", "Fenster"]];
      const hints = {
        part: "Wandteil, Tür oder Fenster antippen, um es zu entfernen (z. B. Logo, Nordpfeil, falsch erkannte Öffnung).",
        erase: "Rechteck aufziehen – Wand darin wird gelöscht.",
        add: "Rechteck aufziehen – wird als Wand gefüllt.",
        door: "Rechteck über die Wandlücke aufziehen = neue Tür (Wand darin wird entfernt). Tür antippen = Anschlag/Aufschlag drehen, Fenster antippen = in Tür umwandeln.",
        window: "Rechteck über die Wand aufziehen = neues Fenster (Wand darin wird entfernt). Tür antippen = in Fenster umwandeln.",
      };
      return `
        <div class="instruction">${imp ? "Wände, Türen und Fenster übernehmen" : "Wandkarte bearbeiten"}</div>
        <div class="hint">${imp ? "Übernommen werden Wände, Türen und Fenster als eigene Karte – Text, Möbel, Maße und das Bild selbst nicht." : "Änderungen gelten für die gespeicherte Wandkarte. Räume auf den ESPs bleiben unverändert."}</div>
        <div class="walk-grid">
          <div class="plan-wrap walls drawing">
            <svg id="plan" viewBox="0 0 ${W.w} ${W.h}" preserveAspectRatio="xMidYMid meet">
              ${imp && W.showSrc ? `<image href="${W.src}" x="0" y="0" width="${W.w}" height="${W.h}" opacity="0.35" preserveAspectRatio="none"/>` : ""}
              <path id="wl-path" d="${r.d}" class="wall" fill-rule="evenodd"/>
              <g id="wl-open">${this._openingsSvg(W.openings, W.w, W.h)}</g>
              <g id="edit-layer"></g>
            </svg>
          </div>
          <div class="walk-side">
            <div class="status-line small" id="wl-status">${this._wallsStatus()}</div>
            ${imp ? `
            ${slider("close", "Lücken schließen (px)", 0, 12, "für doppellinige/schraffierte Wände")}
            ${slider("thickness", "Mindest-Wandstärke (px)", 2, 40)}
            ${slider("threshold", "Helligkeitsschwelle", 30, 230)}
            <button class="btn ghost sm" data-act="wl-auto" id="wl-auto-btn" ${W.manual.thickness || W.manual.threshold ? "" : "hidden"}>Wandstärke/Schwelle automatisch</button>` : ""}
            <div class="sub">Bearbeiten</div>
            <div class="seg wrap">${tools.map(([k, l]) => `<button class="seg-btn ${W.tool === k ? "on" : ""}" data-act="wl-tool" data-tool="${k}">${l}</button>`).join("")}</div>
            <div class="hint small">${hints[W.tool]}</div>
            <div class="row">
              <button class="btn ghost sm" data-act="wl-undo" ${W.history.length ? "" : "disabled"}>Rückgängig</button>
              ${imp ? `<button class="btn ghost sm" data-act="wl-src">${W.showSrc ? "Vorlage ausblenden" : "Vorlage einblenden"}</button>` : ""}
            </div>
          </div>
        </div>
        <div class="actions">
          ${imp ? `<button class="btn ghost" data-act="wl-back">Zurück</button>` : ""}
          <button class="btn ghost" data-act="wl-cancel">Abbrechen</button>
          <button class="btn" data-act="wl-ok" ${r.area ? "" : "disabled"}>${imp ? "Übernehmen" : "Speichern"}</button>
        </div>`;
    }

    _wallsStatus() {
      const W = this._walls, r = W.result;
      if (!r.area) return "Keine Wände erkannt – Schwelle erhöhen oder Wandstärke verringern.";
      const nd = W.openings.filter((o) => o.type === "door").length, nw = W.openings.length - nd;
      return `${r.parts} Wandteil${r.parts === 1 ? "" : "e"} · ${nd} Tür${nd === 1 ? "" : "en"} · ${nw} Fenster · ${(r.d.length / 1024).toFixed(1)} KB`;
    }

    /** Türen (Blatt + Viertelkreis) und Fenster (Rahmen + Mittellinie) als SVG */
    _openingsSvg(list, w, h) {
      const sw = Math.max(w, h) / 100 * 0.22;
      let s = "";
      for (const o of list || []) {
        const [x0, y0, x1, y1] = o.r;
        if (o.type === "window") {
          const mid = o.axis === "h" ? `M${x0} ${(y0 + y1) / 2}H${x1}` : `M${(x0 + x1) / 2} ${y0}V${y1}`;
          s += `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" class="win" stroke-width="${sw}"/><path d="${mid}" class="win-l" stroke-width="${sw}"/>`;
          continue;
        }
        const pts = [];
        let leaf;
        if (o.axis === "h") {
          const L = x1 - x0, cy = (y0 + y1) / 2, hx = o.hinge ? x1 : x0, ox = o.hinge ? x0 : x1, sg = o.swing || 1;
          leaf = `M${hx} ${cy}V${cy + sg * L}`;
          for (let i = 0; i <= 12; i++) { const t = (i / 12) * Math.PI / 2; pts.push(`${hx + (ox - hx) * Math.cos(t)},${cy + sg * L * Math.sin(t)}`); }
        } else {
          const L = y1 - y0, cx = (x0 + x1) / 2, hy = o.hinge ? y1 : y0, oy = o.hinge ? y0 : y1, sg = o.swing || 1;
          leaf = `M${cx} ${hy}H${cx + sg * L}`;
          for (let i = 0; i <= 12; i++) { const t = (i / 12) * Math.PI / 2; pts.push(`${cx + sg * L * Math.sin(t)},${hy + (oy - hy) * Math.cos(t)}`); }
        }
        s += `<path d="${leaf}" class="door" stroke-width="${sw * 1.3}"/><polyline points="${pts.join(" ")}" class="door arc" stroke-width="${sw}"/>`;
      }
      return s;
    }

    /** nur Pfad/Öffnungen/Status aktualisieren (Regler ziehen ohne Neuaufbau) */
    _wallsRefresh() {
      const root = this.shadowRoot;
      const W = this._walls;
      const path = root.getElementById("wl-path");
      if (path) path.setAttribute("d", W.result.d);
      const op = root.getElementById("wl-open");
      if (op) op.innerHTML = this._openingsSvg(W.openings, W.w, W.h);
      const st = root.getElementById("wl-status");
      if (st) st.textContent = this._wallsStatus();
      const ok = root.querySelector('[data-act="wl-ok"]');
      if (ok) ok.disabled = !W.result.area;
      const undo = root.querySelector('[data-act="wl-undo"]');
      if (undo) undo.disabled = !W.history.length;
      for (const k of ["threshold", "thickness"]) {
        if (W.manual[k]) continue;
        const el = root.querySelector(`[data-act="wl-${k}"]`), v = root.getElementById("wl-val-" + k);
        if (el) el.value = W.opts[k];
        if (v) v.textContent = W.opts[k];
      }
      this._drawWallsLayer();
    }

    _drawWallsLayer(preview) {
      const W = this._walls;
      const layer = this.shadowRoot.getElementById("edit-layer");
      if (!W || !layer) return;
      const u = Math.max(W.w, W.h) / 100;
      const col = { add: "#4caf50", erase: "#ff5722", door: "#03a9f4", window: "#03a9f4" };
      let s = "";
      for (const e of W.edits) {
        const [a, b, c, d] = e.r;
        s += `<rect x="${Math.min(a, c)}" y="${Math.min(b, d)}" width="${Math.abs(c - a)}" height="${Math.abs(d - b)}" fill="none" stroke="${e.type === "add" ? "#4caf50" : "#ff5722"}" stroke-width="${u * 0.2}" stroke-dasharray="${u * 0.6} ${u * 0.4}"/>`;
      }
      for (const p of W.removed) s += `<g stroke="#ff5722" stroke-width="${u * 0.35}"><path d="M${p[0] - u} ${p[1] - u}L${p[0] + u} ${p[1] + u}M${p[0] + u} ${p[1] - u}L${p[0] - u} ${p[1] + u}"/></g>`;
      if (preview) {
        const [a, b, c, d] = preview, k = col[W.tool] || "#ff5722";
        s += `<rect x="${a}" y="${b}" width="${c - a}" height="${d - b}" fill="${k}" fill-opacity="0.25" stroke="${k}" stroke-width="${u * 0.3}"/>`;
      }
      layer.innerHTML = s;
    }

    /** Änderung merken (für Rückgängig) und neu berechnen; steps: [["removed"|"edits"|"openOps", item], …] */
    _wallsPush(steps) {
      const W = this._walls;
      for (const [k, item] of steps) W[k].push(item);
      W.history.push(steps.map(([k]) => k));
      this._wallsRecompute();
      this._wallsRefresh();
    }

    _wallsTap(p) {
      const W = this._walls;
      const tol = Math.max(4, W.w / 150);
      const i = FP2Math.openingAt(W.openings, p, tol);
      const o = i >= 0 ? W.openings[i] : null;
      const at = o ? [(o.r[0] + o.r[2]) / 2, (o.r[1] + o.r[3]) / 2] : p;
      if (W.tool === "part") {
        if (o) { this._wallsPush([["openOps", { op: "del", p: at }]]); return; }
        const before = W.result.parts;
        W.removed.push(p);
        this._wallsRecompute();
        W.removed.pop();
        if (W.result.parts === before) { this._wallsRecompute(); this._toast("Hier ist keine Wand"); return; }
        this._wallsPush([["removed", p]]);
        return;
      }
      if (W.tool === "door" || W.tool === "window") {
        if (!o) { this._toast(W.tool === "door" ? "Für eine neue Tür ein Rechteck über die Wand aufziehen" : "Für ein neues Fenster ein Rechteck über die Wand aufziehen"); return; }
        let patch;
        if (W.tool === "window") {
          if (o.type === "window") { this._toast("Das ist schon ein Fenster"); return; }
          patch = { type: "window" };
        } else if (o.type === "window") patch = { type: "door", hinge: 0, swing: 1 };
        else {
          // Anschlag/Aufschlag reihum: (0,+) → (1,+) → (1,−) → (0,−)
          const seq = [[0, 1], [1, 1], [1, -1], [0, -1]];
          const k = seq.findIndex(([hg, sg]) => hg === (o.hinge || 0) && sg === (o.swing || 1));
          const [hinge, swing] = seq[(k + 1) % 4];
          patch = { hinge, swing };
        }
        this._wallsPush([["openOps", { op: "set", p: at, patch }]]);
      }
    }

    _bindWallsTool(svg) {
      const W = this._walls;
      let start = null;
      const clamp = (p) => [Math.max(0, Math.min(W.w, p[0])), Math.max(0, Math.min(W.h, p[1]))];
      const rectOf = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
      svg.addEventListener("pointerdown", (ev) => {
        const p = this._planPoint(ev);
        if (!p) return;
        ev.preventDefault();
        if (W.tool === "part") { this._wallsTap(p); return; }
        start = clamp(p);
        try { svg.setPointerCapture(ev.pointerId); } catch (x) { /* ignorieren */ }
      });
      svg.addEventListener("pointermove", (ev) => {
        if (!start) return;
        const p = this._planPoint(ev);
        if (p) this._drawWallsLayer(rectOf(start, clamp(p)));
      });
      svg.addEventListener("pointerup", (ev) => {
        if (!start) return;
        const p = this._planPoint(ev);
        const a = start;
        start = null;
        if (!p) { this._drawWallsLayer(); return; }
        const r = rectOf(a, clamp(p)).map(Math.round);
        const tiny = r[2] - r[0] < 3 && r[3] - r[1] < 3;
        if (tiny && (W.tool === "door" || W.tool === "window")) { this._drawWallsLayer(); this._wallsTap(a); return; }
        if (r[2] - r[0] < 2 || r[3] - r[1] < 2) { this._toast("Rechteck aufziehen"); this._drawWallsLayer(); return; }
        if (W.tool === "door" || W.tool === "window") {
          const axis = r[2] - r[0] >= r[3] - r[1] ? "h" : "v";
          const o = W.tool === "door" ? { type: "door", r, axis, hinge: 0, swing: 1, arc: false } : { type: "window", r, axis };
          this._wallsPush([["edits", { type: "erase", r }], ["openOps", { op: "add", o }]]);
          return;
        }
        this._wallsPush([["edits", { type: W.tool, r }]]);
      });
      svg.addEventListener("pointercancel", () => { start = null; this._drawWallsLayer(); });
    }

    _wallsAction(act, el) {
      const W = this._walls;
      if (!W) return;
      if (act === "wl-thickness" || act === "wl-threshold" || act === "wl-close") {
        const key = act.slice(3);
        W.opts[key] = Number(el.value);
        if (key !== "close" && !W.manual[key]) {
          W.manual[key] = true;
          const a = this.shadowRoot.getElementById("wl-auto-" + key);
          if (a) a.textContent = "";
          const btn = this.shadowRoot.getElementById("wl-auto-btn");
          if (btn) btn.hidden = false;
        }
        const lbl = this.shadowRoot.getElementById("wl-val-" + key);
        if (lbl) lbl.textContent = el.value;
        clearTimeout(this._wlT);
        this._wlT = setTimeout(() => { this._wallsRecompute(); this._wallsRefresh(); }, 120);
        return;
      }
      switch (act) {
        case "wl-tool": W.tool = el.dataset.tool; this._renderShell(); return;
        case "wl-src": W.showSrc = !W.showSrc; this._renderShell(); return;
        case "wl-auto": W.manual = {}; this._wallsRecompute(); this._renderShell(); return;
        case "wl-undo": {
          const keys = W.history.pop() || [];
          for (const k of keys) W[k].pop();
          this._wallsRecompute();
          this._wallsRefresh();
          return;
        }
        case "wl-back": this._walls = null; this._view = "crop"; this._renderShell(); return;
        case "wl-cancel":
          if (this._crop) URL.revokeObjectURL(this._crop.url);
          this._crop = null; this._walls = null; this._view = "setup"; this._renderShell();
          return;
        case "wl-ok": this._saveWalls(); return;
      }
    }

    async _saveWalls() {
      const W = this._walls;
      this._wallsRecompute();
      const r = W.result;
      if (!r.area) return;
      if (r.d.length > 400 * 1024) { this._toast("Wandkarte zu groß – Schwelle/Wandstärke anpassen oder Bildteile radieren"); return; }
      const openings = W.openings.map((o) => o.type === "window"
        ? { type: "window", r: o.r.map((v) => Math.round(v)), axis: o.axis }
        : { type: "door", r: o.r.map((v) => Math.round(v)), axis: o.axis, hinge: o.hinge ? 1 : 0, swing: o.swing === -1 ? -1 : 1 });
      const prev = this._store.floorplan;
      this._store.floorplan = {
        kind: "walls", width: W.w, height: W.h, d: r.d, m: FP2Math.maskToRle(r.mask, W.w, W.h), openings, params: { ...r.params },
        created: W.mode === "existing" && prev ? prev.created : new Date().toISOString(),
        ...(W.mode === "existing" ? { edited: new Date().toISOString() } : {}),
      };
      // Neu importiert = neue Plan-Koordinaten: Sensoren neu ausrichten (Bearbeiten behält die Ausrichtung)
      // Möbel auf dem Plan liegen in den alten Plan-Koordinaten und entfallen ebenso
      if (W.mode === "import") {
        for (const s of Object.values(this._store.devices)) if (s) s.align = null;
        this._store.furniture = [];
      }
      if (this._crop) URL.revokeObjectURL(this._crop.url);
      this._crop = null;
      this._walls = null;
      this._view = "setup";
      if (await this._saveStore()) this._toast("Wandkarte gespeichert");
      this._renderShell();
    }

    /** Hintergrund des Plans: eigene Wandkarte (Vektor) oder – ältere Einrichtungen – Bild */
    _floorplanSvg(fp) {
      if (!fp) return "";
      if (fp.kind === "walls") return `<path d="${esc(fp.d)}" class="wall" fill-rule="evenodd"/>${this._openingsSvg(fp.openings, fp.width, fp.height)}`;
      return fp.url ? `<image href="${esc(this._url(fp.url))}" x="0" y="0" width="${fp.width}" height="${fp.height}" preserveAspectRatio="none"/>` : "";
    }

    _url(p) { return this._hass && this._hass.hassUrl ? this._hass.hassUrl(p) : p; }

    /* ---------------- Sensordaten ---------------- */

    _targets(device) {
      if (this._demo) return { reason: null, targets: this._demoTargets() };
      const d = this._dev(device);
      const st = this._hass && this._hass.states[d.targets];
      if (!st) return { reason: "Targets-Entität nicht gefunden", targets: [] };
      if (st.state === "unavailable") return { reason: "nicht verfügbar", targets: [] };
      if (st.state === "unknown" || st.state === "") return { reason: "keine Positionsdaten (Report Targets aus?)", targets: [] };
      return { reason: null, targets: FP2Math.decodeTargets(st.state) };
    }

    /** Kennung der aktuellen Meldung des Targets-Sensors; HA meldet nur Änderungen, jede neue Kennung = neue Meldung */
    _frameId(device) {
      if (this._demo) return this._demoFrame ? this._demoFrame.n : null;
      const d = this._dev(device);
      const st = this._hass && this._hass.states[d.targets];
      return st ? `${st.last_updated || st.last_changed || ""}|${st.state}` : null;
    }

    /** Neue Meldung seit dem letzten Aufruf mit diesem Zustand s? -> Ziele, sonst null (s.frame merkt die Kennung) */
    _newReport(s, device) {
      const id = this._frameId(device);
      if (id == null || id === s.frame) return null;
      s.frame = id;
      const res = this._targets(device);
      return res.reason ? null : res.targets;
    }

    /**
     * Wie _newReport, aber ohne neue Meldung zählt der unveränderte Zustand alle REPEAT_MS als wiederholter Frame
     * (HA reicht bitgleiche Frames nicht weiter, z. B. leerer Raum mit ortsfestem Geist). s.repAt merkt die Zeit.
     */
    _reportOrRepeat(s, device, now) {
      const tg = this._newReport(s, device);
      if (tg) { s.repAt = now; return tg; }
      if (s.repAt == null || now - s.repAt < REPEAT_MS) return null;
      const res = this._targets(device);
      if (res.reason) return null;
      s.repAt = now;
      return res.targets;
    }

    /** Zustand vom ESP (Text-Sensor Zonenstatus, kompakt oder alte Form) -> {c, r:[on,n], z:{slot:[on,n]}} */
    _espState(device) {
      if (this._demo) return FP2Math.parseZoneState(this._demoState());
      const d = this._dev(device);
      if (!d.state) return null;
      const st = this._hass.states[d.state];
      if (!st || st.state === "unknown" || st.state === "unavailable") return null;
      return FP2Math.parseZoneState(st.state);
    }

    /** Montage laut ESP-YAML (hansihe mounting_position_sensor), falls konfiguriert */
    _espMount(device) {
      const d = this._dev(device);
      if (this._demo || !d.mounting) return null;
      const st = this._hass && this._hass.states[d.mounting];
      return st ? MOUNT_FROM_ESP[st.state] || null : null;
    }

    _mountHint(device) {
      const m = this._espMount(device);
      return m && m !== 1 ? `Montage laut ESP: ${MOUNTS[m]}. Das Raster dreht/verschiebt die Radar-Firmware selbst; Sensor-Symbol und Blickfeld sind für Wandmontage gezeichnet.` : "";
    }

    _layout(device) {
      return this._drafts[device] || this._layouts[device];
    }

    _layoutOk(device) {
      const L = this._layout(device);
      return !!(L && !L.error && L.room);
    }

    _calibrated(device) {
      return this._layoutOk(device) && FP2Math.maskCount(this._layout(device).room.mask) > 0;
    }

    /* ---------------- Raster und Ausrichtung ---------------- */

    _mirror(device) {
      const s = this._store && this._store.devices[device];
      return !!(s && s.mirror);
    }

    /** Gespeicherte Ausrichtung auf dem Grundriss oder null; Spiegelung kommt aus dem Schalter des Geräts */
    _storedAlign(device) {
      const s = this._store && this._store.devices[device];
      const a = s && s.align;
      if (!a || !Array.isArray(a.pos) || !Number.isFinite(a.ang) || !(a.scale > 0)) return null;
      return { pos: [a.pos[0], a.pos[1]], ang: a.ang, scale: a.scale, mirror: !!s.mirror };
    }

    /** Gerät der aktuellen Einzelansicht (Lernen, Bearbeiten, Ausrichten) oder null */
    _viewDevice() {
      const st = { learn: this._learn, interf: this._interf, edit: this._edit, align: this._align }[this._view];
      return st ? st.device : null;
    }

    /**
     * Was gezeigt wird: { fp, items: [{ d, di, align }] }. Mit Grundriss die ausgerichteten Geräte, sonst das
     * Raster (Geräte nebeneinander). Einzelansichten zeigen ein Gerät, ohne Ausrichtung im Raster.
     */
    _scene() {
      const fp = this._store && this._store.floorplan;
      const devs = this._config.devices;
      if (this._view === "align" && this._align) {
        const di = this._devIndex(this._align.device);
        return { fp, items: this._align.preview ? [{ d: devs[di], di, align: this._align.preview }] : [] };
      }
      const one = this._viewDevice();
      if (one) {
        const di = this._devIndex(one);
        const a = fp ? this._storedAlign(one) : null;
        return a ? { fp, items: [{ d: devs[di], di, align: a }] } : { fp: null, items: [{ d: devs[di], di, align: FP2Math.alignDefault(0, this._mirror(one)) }] };
      }
      if (fp) return { fp, items: devs.map((d, di) => ({ d, di, align: this._storedAlign(d.device) })).filter((it) => it.align) };
      return { fp: null, items: devs.map((d, di) => ({ d, di, align: FP2Math.alignDefault(di, this._mirror(d.device)) })) };
    }

    _viewBox() {
      const sc = this._scene();
      if (sc.fp) return { x: 0, y: 0, w: sc.fp.width, h: sc.fp.height };
      if (this._view === "live" && !this._config.full_grid) {
        const vb = this._roomViewBox(sc);
        if (vb) return vb;
      }
      const xs = sc.items.map((it) => it.align.pos[0]);
      const minX = Math.min(400, ...xs) - 400, maxX = Math.max(400, ...xs) + 400;
      return { x: minX - 40, y: -60, w: maxX - minX + 80, h: 1100 };
    }

    /**
     * Live im Raster: Ausschnitt auf die gelernten Räume (wie die Aqara-App), dazu Sensoren und Möbel, eine Zelle Rand.
     * null, solange kein Gerät einen Raum hat. full_grid: true in der Kartenkonfiguration zeigt immer das ganze Raster.
     */
    _roomViewBox(sc) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, rooms = 0;
      const add = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
      for (const it of sc.items) {
        if (!this._calibrated(it.d.device)) continue;
        const mask = this._layout(it.d.device).room.mask;
        mask.forEach((v, i) => {
          if (!v) return;
          rooms++;
          for (const q of FP2Math.cellRect(i)) { const p = FP2Math.alignApply(it.align, q[0], q[1]); add(p[0], p[1]); }
        });
        add(it.align.pos[0], it.align.pos[1]);
        const dx = it.align.pos[0] - 400;
        for (const f of this._furnList(it.d.device) || []) {
          const r = Math.hypot(f.w, f.h) / 2;
          add(f.x + dx - r, f.y - r); add(f.x + dx + r, f.y + r);
        }
      }
      if (!rooms) return null;
      const pad = FP2Math.GRID.cell;
      let w = x1 - x0 + 2 * pad, h = y1 - y0 + 2 * pad;
      const min = 4 * FP2Math.GRID.cell;
      const ex = Math.max(0, min - w) / 2, ey = Math.max(0, min - h) / 2;
      w += 2 * ex; h += 2 * ey;
      return { x: r1(x0 - pad - ex), y: r1(y0 - pad - ey), w: r1(w), h: r1(h) };
    }

    _u() { const vb = this._viewBox(); return Math.max(vb.w, vb.h) / 100; }

    /** Bildschirmposition -> Plan-Koordinaten */
    _planPoint(e) {
      const svg = this.shadowRoot.getElementById("plan");
      const ctm = svg && svg.getScreenCTM();
      if (!ctm) return null;
      const pt = svg.createSVGPoint();
      pt.x = e.clientX; pt.y = e.clientY;
      const p = pt.matrixTransform(ctm.inverse());
      return [r1(p.x), r1(p.y)];
    }

    /** Rohposition (cm) unter dem Zeiger */
    _rawAt(e, align) {
      const p = this._planPoint(e);
      return p ? FP2Math.alignInvert(align, p[0], p[1]) : null;
    }

    /* ---------------- Zeichnen ---------------- */

    _planSvg(drawing) {
      const vb = (this._view === "edit" && this._zoomVB) || this._viewBox();   // im Editor mit zwei Fingern gezoomt
      const fp = this._scene().fp;
      return `
        <div class="plan-wrap ${fp ? (fp.kind === "walls" ? "walls" : "") : "raster"} ${drawing ? "drawing" : ""}">
          <svg id="plan" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" preserveAspectRatio="xMidYMid meet">
            <defs><pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45) scale(${this._u() / 4})"><line x1="0" y1="0" x2="0" y2="8" stroke="#9e9e9e" stroke-width="3"/></pattern></defs>
            ${this._floorplanSvg(fp)}
            <g id="furn-layer">${this._furnitureSvg()}</g>
            <g id="shapes-layer"></g>
            <g id="edit-layer"></g>
            <g id="live-layer"></g>
          </svg>
        </div>`;
    }

    _crisp(align) {
      // achsparallel (Rastermodus): Kanten ohne Kantenglättung, sonst feine Spalte zwischen den Zellen
      return Math.abs(Math.cos(align.ang)) < 1e-9 || Math.abs(Math.sin(align.ang)) < 1e-9 ? `shape-rendering="crispEdges"` : "";
    }

    /** Gesetzte Zellen einer Maske als ein Pfad (zusammenhängende Zellen einer Zeile als ein Viereck) */
    _maskPath(align, mask) {
      const { cols, rows } = FP2Math.GRID;
      const P = (q) => { const p = FP2Math.alignApply(align, q[0], q[1]); return `${r1(p[0])} ${r1(p[1])}`; };
      let d = "";
      for (let row = 0; row < rows; row++) {
        let c = 0;
        while (c < cols) {
          if (!mask[row * cols + c]) { c++; continue; }
          let e = c;
          while (e < cols && mask[row * cols + e]) e++;
          const a = FP2Math.cellRect(row * cols + c), b = FP2Math.cellRect(row * cols + e - 1);
          d += `M${P(a[0])}L${P(b[1])}L${P(b[2])}L${P(a[3])}Z`;
          c = e;
        }
      }
      return d;
    }

    /** Umriss einer Maske: Kanten zwischen gesetzten und freien Zellen */
    _maskEdges(align, mask) {
      const { cols, rows } = FP2Math.GRID;
      const P = (q) => { const p = FP2Math.alignApply(align, q[0], q[1]); return `${r1(p[0])} ${r1(p[1])}`; };
      let d = "";
      for (let i = 0; i < FP2Math.CELLS; i++) {
        if (!mask[i]) continue;
        const c = i % cols, r = (i - c) / cols, q = FP2Math.cellRect(i);
        if (r === 0 || !mask[i - cols]) d += `M${P(q[0])}L${P(q[1])}`;
        if (c === cols - 1 || !mask[i + 1]) d += `M${P(q[1])}L${P(q[2])}`;
        if (r === rows - 1 || !mask[i + cols]) d += `M${P(q[2])}L${P(q[3])}`;
        if (c === 0 || !mask[i - 1]) d += `M${P(q[3])}L${P(q[0])}`;
      }
      return d;
    }

    /** Rasterlinien (50 cm) und Umriss des Rasters; im Rastermodus Entfernungen in Metern am Rand */
    _gridSvg(align, color, lines) {
      const { cols, rows, cell, x0 } = FP2Math.GRID;
      const u = this._u();
      const P = (x, y) => FP2Math.alignApply(align, x, y).map(r1).join(" ");
      let s = "";
      if (lines) {
        let d = "";
        for (let c = 1; c < cols; c++) d += `M${P(x0 + c * cell, 0)}L${P(x0 + c * cell, rows * cell)}`;
        for (let r = 1; r < rows; r++) d += `M${P(x0, r * cell)}L${P(-x0, r * cell)}`;
        s += `<path d="${d}" fill="none" class="grid-l" stroke-width="${u * 0.1}" ${this._crisp(align)}/>`;
      }
      s += `<path d="M${P(x0, 0)}L${P(-x0, 0)}L${P(-x0, rows * cell)}L${P(x0, rows * cell)}Z" fill="none" stroke="${color}" stroke-opacity="0.45" stroke-width="${u * 0.2}"/>`;
      if (this._crisp(align) && align.scale === 1)
        for (let m = 2; m <= 10; m += 2) {
          const p = FP2Math.alignApply(align, 0, m * 100);
          s += `<text x="${align.pos[0] + x0 - u * 0.6}" y="${p[1] + u * 0.6}" font-size="${u * 1.5}" text-anchor="end" class="axis">${m} m</text>`;
        }
      return s;
    }

    /** Sensor-Symbol mit Blickfeld ±60° (Wandmontage: Ursprung, Blick entlang +y), auf clipD (Pfad) oder das Raster beschnitten */
    _sensorSvg(align, color, key, clipD) {
      const u = this._u();
      const A = (x, y) => FP2Math.alignApply(align, x, y);
      const { rows, cell, x0 } = FP2Math.GRID;
      const [px, py] = A(0, 0);
      const arc = [];
      for (let i = 0; i <= 24; i++) {
        const t = ((-FOV_DEG + (2 * FOV_DEG * i) / 24) * Math.PI) / 180;
        arc.push(A(1200 * Math.sin(t), 1200 * Math.cos(t)).map(r1).join(","));
      }
      const box = [A(x0, 0), A(-x0, 0), A(-x0, rows * cell), A(x0, rows * cell)].map((p) => p.map(r1).join(",")).join(" ");
      const f = A(0, 100), fl = Math.hypot(f[0] - px, f[1] - py) || 1;
      const ax = px + ((f[0] - px) / fl) * u * 4.5, ay = py + ((f[1] - py) / fl) * u * 4.5;
      return `<clipPath id="clip-${key}">${clipD ? `<path d="${clipD}"/>` : `<polygon points="${box}"/>`}</clipPath>
        <polygon points="${r1(px)},${r1(py)} ${arc.join(" ")}" fill="${color}" fill-opacity="0.06" stroke="${color}" stroke-opacity="0.35" stroke-width="${u * 0.2}" clip-path="url(#clip-${key})"/>
        <line x1="${px}" y1="${py}" x2="${ax}" y2="${ay}" stroke="${color}" stroke-width="${u * 0.45}" stroke-linecap="round"/>
        <rect x="${px - u * 1.6}" y="${py - u * 1.6}" width="${u * 3.2}" height="${u * 3.2}" rx="${u * 0.7}" fill="#fff" stroke="${color}" stroke-width="${u * 0.4}"/>
        <circle cx="${px}" cy="${py}" r="${u * 0.6}" fill="${color}"/>`;
    }

    /** Raum-, Zonen- und Ignorier-Zellen eines Layouts; st = ESP-Zustand zur Hervorhebung, meta = Zonen-Namen/Farben */
    _layoutSvg(L, align, c, st, meta) {
      const u = this._u();
      const crisp = this._crisp(align);
      let s = "";
      const roomOn = st && st.r ? st.r[0] === 1 : false;
      // Kante (wie Aqara): Zellen außerhalb des Raums grau
      if (FP2Math.maskCount(L.room.mask)) {
        const edge = this._maskPath(align, L.room.mask.map((v) => (v ? 0 : 1)));
        if (edge) s += `<path d="${edge}" class="edge" ${crisp}/>`;
      }
      const room = this._maskPath(align, L.room.mask);
      if (room) s += `<path d="${room}" fill="${c}" fill-opacity="${roomOn ? 0.2 : 0.1}" ${crisp}/><path d="${this._maskEdges(align, L.room.mask)}" fill="none" stroke="${c}" stroke-width="${u * 0.3}" stroke-linecap="square"/>`;
      const labels = [];
      for (const z of L.zones) {
        const d = this._maskPath(align, z.mask);
        if (!d) continue;
        const on = st && st.z && st.z[z.slot] ? st.z[z.slot][0] === 1 : false;
        const info = FP2Math.zoneInfo(z, meta);
        const zc = info.color;
        s += `<path d="${d}" fill="${zc}" fill-opacity="${on ? 0.4 : 0.16}" ${crisp}/><path d="${this._maskEdges(align, z.mask)}" fill="none" stroke="${zc}" stroke-width="${u * 0.22}" stroke-dasharray="${u} ${u * 0.6}"/>`;
        // Beschriftung im Schwerpunkt der Zellen
        let sx = 0, sy = 0, n = 0;
        for (let i = 0; i < FP2Math.CELLS; i++) {
          if (!z.mask[i]) continue;
          const q = FP2Math.cellRect(i);
          const p = FP2Math.alignApply(align, (q[0][0] + q[2][0]) / 2, (q[0][1] + q[2][1]) / 2);
          sx += p[0]; sy += p[1]; n++;
        }
        labels.push(`<text x="${r1(sx / n)}" y="${r1(sy / n + u * 0.7)}" font-size="${u * 1.9}" text-anchor="middle" class="lbl" fill="${zc}">${esc(info.name)}${on ? " ●" : ""}</text>`);
      }
      const ex = this._maskPath(align, L.excl);
      if (ex) s += `<path d="${ex}" fill="url(#hatch)" fill-opacity="0.85" ${crisp}/><path d="${this._maskEdges(align, L.excl)}" fill="none" stroke="#9e9e9e" stroke-width="${u * 0.18}"/>`;
      return s + labels.join("");
    }

    /**
     * Raster, Layout und Sensor aller gezeigten Geräte.
     * opts: live (ESP-Zustand hervorheben), grid (Rasterlinien auch auf dem Grundriss), bare (ohne Layout-Zellen)
     */
    _drawShapes(opts = {}) {
      const layer = this.shadowRoot.getElementById("shapes-layer");
      if (!layer) return;
      const sc = this._scene();
      const u = this._u();
      let s = "";
      for (const it of sc.items) {
        const c = COLORS[it.di % COLORS.length];
        if (!sc.fp || opts.grid) s += this._gridSvg(it.align, c, true);
        const L = this._layout(it.d.device);
        const lay = !opts.bare && L && !L.error && L.room;
        if (lay) s += this._layoutSvg(L, it.align, c, opts.live ? this._espState(it.d.device) : null, this._zmeta(it.d.device));
        // Auf dem Grundriss das Blickfeld auf den Raum beschneiden (sonst reicht es in Nachbarräume)
        const clip = sc.fp && lay && FP2Math.maskCount(L.room.mask) ? this._maskPath(it.align, L.room.mask) : null;
        s += this._sensorSvg(it.align, c, "s" + it.di, clip);
        if (!sc.fp) s += `<text x="${it.align.pos[0] - 400}" y="${-u * 2.4}" font-size="${u * 2.2}" class="lbl" fill="${c}">${esc(it.d.name)}</text>`;
      }
      layer.innerHTML = s;
    }

    /** Ziel im Plan: Punkt (gezählt) oder graues ✕ (nicht gezählt) */
    _targetSvg(p, c, counted, label) {
      const u = this._u();
      let s = counted
        ? `<circle cx="${p[0]}" cy="${p[1]}" r="${u * 2.2}" fill="${c}" fill-opacity="0.25"/><circle cx="${p[0]}" cy="${p[1]}" r="${u * 1.1}" fill="${c}" stroke="#fff" stroke-width="${u * 0.3}"/>`
        : `<g opacity="0.45"><circle cx="${p[0]}" cy="${p[1]}" r="${u * 1}" fill="none" stroke="#9e9e9e" stroke-width="${u * 0.3}"/><path d="M${p[0] - u * 0.7} ${p[1] - u * 0.7}L${p[0] + u * 0.7} ${p[1] + u * 0.7}M${p[0] + u * 0.7} ${p[1] - u * 0.7}L${p[0] - u * 0.7} ${p[1] + u * 0.7}" stroke="#9e9e9e" stroke-width="${u * 0.3}"/></g>`;
      if (label) s += `<text x="${p[0] + u * 2}" y="${p[1] - u * 2}" font-size="${u * 2}" class="raw">${esc(label)}</text>`;
      return s;
    }

    _rawLabel(t) { return this._config.show_raw ? `#${t.id} ${t.x}/${t.y}` : ""; }

    /* ---------------- Grundgerüst ---------------- */

    _renderShell() {
      if (!this._config) return;
      const isAdmin = this._isAdmin();
      const views = {
        setup: () => this._setupHtml(), crop: () => this._cropHtml(), walls: () => this._wallsHtml(),
        learn: () => this._learnHtml(), interf: () => this._interfHtml(), edit: () => this._editHtml(), align: () => this._alignHtml(),
      };
      let body;
      if (!this._loaded) body = `<div class="hint">Lade Einrichtung vom ESP …</div>`;
      else body = (views[this._view] || (() => this._liveHtml()))();
      this.shadowRoot.innerHTML = `
        <style>${this._css()}</style>
        <ha-card>
          <div class="head">
            <div class="title">${esc(this._config.title)}${this._demo ? ` <span class="demo-badge">Demo – simulierter FP2</span>` : ""}</div>
            <div class="head-actions">
              ${this._view === "live" && isAdmin && this._loaded ? `<button class="btn ghost" data-act="open-setup">Einrichten</button>` : ""}
              ${this._view !== "live" && this._view !== "crop" && this._view !== "walls" ? `<button class="btn ghost" data-act="close">${this._view === "setup" ? "Fertig" : "Abbrechen"}</button>` : ""}
            </div>
          </div>
          <div class="body">${body}</div>
          <div class="toast" id="toast"></div>
        </ha-card>`;
      this._bind();
      this._onHassUpdate();
    }

    _toast(msg) {
      const t = this.shadowRoot.getElementById("toast");
      if (!t) return;
      t.textContent = msg;
      t.classList.add("show");
      clearTimeout(this._toastT);
      this._toastT = setTimeout(() => t.classList.remove("show"), 4500);
    }

    _bind() {
      const root = this.shadowRoot;
      root.querySelectorAll("[data-act]").forEach((el) => {
        const ev = el.tagName === "INPUT" && el.type === "range" ? "input" : el.tagName === "INPUT" || el.tagName === "SELECT" ? "change" : "click";
        el.addEventListener(ev, (e) => this._action(el.dataset.act, el, e));
      });
      const nn = root.getElementById("e-new-name");
      if (nn) nn.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); this._editAction("e-zone-add-ok"); }
        else if (ev.key === "Escape") this._editAction("e-zone-add-cancel");
      });
      const svg = root.getElementById("plan");
      if (!svg) return;
      if (this._view === "crop") { this._bindCropDrag(svg); this._drawCropLayer(); return; }
      if (this._view === "walls") { this._bindWallsTool(svg); this._drawWallsLayer(); return; }
      if (this._view === "edit" && this._edit) {
        if (this._edit.tool === "furn") { this._bindFurniture(svg); this._drawFurnEdit(); }
        else this._bindPaint(svg);
      } else if (this._view === "align" && this._align) svg.addEventListener("click", (e) => this._alignTap(e));
    }

    async _action(act, el) {
      switch (act) {
        case "open-setup": this._view = "setup"; this._renderShell(); return;
        case "close": this._close(); return;
        case "upload": {
          const f = el.files && el.files[0];
          if (!f) return;
          try { await this._startCrop(f); } catch (err) { this._toast("Bild konnte nicht gelesen werden: " + err.message); }
          return;
        }
        case "crop-auto": this._crop.rect = this._crop.auto || this._crop.full; this._renderShell(); return;
        case "crop-full": this._crop.rect = this._crop.full; this._renderShell(); return;
        case "crop-cancel": URL.revokeObjectURL(this._crop.url); this._crop = null; this._walls = null; this._view = "setup"; this._renderShell(); return;
        case "edit-walls":
          try { this._editWallMap(); } catch (err) { this._toast("Wandkarte konnte nicht geöffnet werden: " + err.message); }
          return;
        case "crop-ok":
          try { this._startWalls(); } catch (err) { this._toast("Wand-Erkennung fehlgeschlagen: " + err.message); }
          return;
        case "remove-plan":
          if (!confirm("Grundriss entfernen? Die Ausrichtungen der Sensoren und die Möbel auf dem Grundriss gehen verloren, die Karte zeigt dann das Raster. Räume und Zonen auf den ESPs bleiben.")) return;
          this._store.floorplan = null;
          this._store.furniture = [];
          for (const s of Object.values(this._store.devices)) if (s) s.align = null;
          await this._saveStore();
          this._renderShell();
          return;
        case "learn": this._startLearn(el.dataset.dev); return;
        case "interf": this._startInterf(el.dataset.dev); return;
        case "edit": this._startEdit(el.dataset.dev); return;
        case "align": this._startAlign(el.dataset.dev); return;
        case "mirror": this._setMirror(el.dataset.dev, el.checked); return;
        case "reload": this._reload(); return;
      }
      if (act.startsWith("wl-")) return this._wallsAction(act, el);
      if (act.startsWith("l-")) return this._learnAction(act, el);
      if (act.startsWith("i-")) return this._interfAction(act, el);
      if (act.startsWith("e-")) return this._editAction(act, el);
      if (act.startsWith("a-")) return this._alignAction(act, el);
    }

    _close() {
      if (this._view === "edit" && this._edit && (this._edit.dirty || this._edit.metaDirty) && !confirm("Ungespeicherte Änderungen verwerfen?")) return;
      this._stopTimer();
      this._zoomVB = null;
      if (this._edit) delete this._drafts[this._edit.device];
      this._view = this._view === "setup" ? "live" : "setup";
      this._learn = null;
      this._interf = null;
      this._edit = null;
      this._align = null;
      this._renderShell();
    }

    _onHassUpdate() {
      if (!this._hass || !this._loaded || !this._config) return;
      if (this._view === "live") this._updateLive();
      else if (this._view === "learn") this._updateLearn();
      else if (this._view === "interf") this._updateInterf();
      else if (this._view === "edit") this._updateEdit();
      else if (this._view === "align") this._updateAlign();
    }

    _startTimer() { this._stopTimer(); this._timer = setInterval(() => this._onTick(), TICK_MS); }
    _stopTimer() { if (this._timer) clearInterval(this._timer); this._timer = null; }

    _onTick() {
      if (this._view === "interf") this._interfTick();
      else if (this._view === "align") this._alignTick();
      this._onHassUpdate();
    }

    /* ---------------- Live ---------------- */

    _liveHtml() {
      const sc = this._scene();
      const errs = this._config.devices.filter((d) => this._layouts[d.device] && this._layouts[d.device].error)
        .map((d) => `<div class="warn small">${esc(d.name)}: ${esc(this._layouts[d.device].error)}.${this._layouts[d.device].svc ? ` Ist <code>esphome.${esc(d.device)}_get_layout</code> vorhanden?` : ""}</div>`).join("") + this._storeErrorHtml();
      let hint = "";
      if (sc.fp && !sc.items.length)
        hint = `<div class="empty"><div class="empty-title">Sensoren noch nicht auf dem Grundriss ausgerichtet</div>
          <div class="hint">Unter „Einrichten“ je Sensor „Ausrichten“: Position und Blickrichtung im Plan tippen, optional den Maßstab messen.</div></div>`;
      else if (!this._config.devices.some((d) => this._calibrated(d.device)))
        hint = `<div class="hint">Noch kein Raum eingerichtet: unter „Einrichten“ „Raum lernen“ (frei herumlaufen) oder Zellen malen. Bis dahin zählt der ESP niemanden (graue ✕).</div>`;
      return `${errs}${hint}${sc.items.length ? this._planSvg() : ""}<div class="stats" id="stats"></div><div id="sensor-status"></div>`;
    }

    _updateLive() {
      const root = this.shadowRoot;
      const layer = root.getElementById("live-layer");
      const sc = this._scene();
      if (layer) this._drawShapes({ live: true });
      const u = this._u();
      const now = Date.now();
      const shown = new Map(sc.items.map((it) => [it.d.device, it]));
      let dots = "";
      const chips = [];
      const warns = [];
      this._config.devices.forEach((d, di) => {
        const c = COLORS[di % COLORS.length];
        const L = this._layout(d.device);
        const ok = this._layoutOk(d.device);
        const it = shown.get(d.device);
        const res = this._targets(d.device);
        if (res.reason) warns.push(`${esc(d.name)}: ${esc(res.reason)}`);
        if (sc.fp && !it) warns.push(`${esc(d.name)}: noch nicht auf dem Grundriss ausgerichtet`);
        if (this._mountHint(d.device)) warns.push(`${esc(d.name)}: ${esc(this._mountHint(d.device))}`);
        if (it)
          for (const t of res.targets) {
            const p = FP2Math.alignApply(it.align, t.x, t.y);
            if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
            const counted = ok && FP2Math.classify(L, t.x, t.y).counted;
            const key = d.device + "#" + t.id;
            let tr = this._trails.get(key) || [];
            const last = tr[tr.length - 1];
            if (last && Math.hypot(last.p[0] - p[0], last.p[1] - p[1]) > u * 15) tr = [];
            tr.push({ t: now, p });
            while (tr.length && now - tr[0].t > TRAIL_MS) tr.shift();
            this._trails.set(key, tr);
            if (tr.length > 1 && counted)
              dots += `<polyline points="${tr.map((e) => e.p.map(r1).join(",")).join(" ")}" fill="none" stroke="${c}" stroke-opacity="0.35" stroke-width="${u * 0.6}" stroke-linecap="round" stroke-linejoin="round"/>`;
            dots += this._targetSvg(p, c, counted, this._rawLabel(t));
          }
        const st = this._espState(d.device);
        if (st && st.r) chips.push(...this._chips(d, c, ok ? L : null, st));
        else if (d.state) warns.push(`${esc(d.name)}: Zonenstatus-Entität ohne Wert`);
      });
      for (const [k, tr] of this._trails) if (!tr.length || now - tr[tr.length - 1].t > TRAIL_MS) this._trails.delete(k);
      if (layer) layer.innerHTML = dots;
      const stats = root.getElementById("stats");
      if (stats) stats.innerHTML = chips.join("") || `<div class="hint small">Für Raum-/Zonenstatus vom ESP <code>state:</code> (Zonenstatus-Entität) in der Kartenkonfiguration angeben.</div>`;
      const ss = root.getElementById("sensor-status");
      if (ss) ss.innerHTML = warns.length ? `<div class="warn small">${warns.join("<br>")}</div>` : "";
    }

    /** Status-Chips eines Geräts: Raum und aktive Zonen (Name/Farbe aus HA) */
    _chips(d, c, L, st) {
      const out = [`<div class="stat ${st.r[0] ? "on" : ""}" style="--c:${c}"><span class="dot"></span>${esc(d.name)}<span class="num-s">${st.r[1]}</span></div>`];
      if (!L) return out;
      const meta = this._zmeta(d.device);
      for (const z of FP2Math.activeZones(L.zones, meta)) {
        const zs = (st.z && st.z[z.slot]) || [0, 0];
        const info = FP2Math.zoneInfo(z, meta);
        out.push(`<div class="stat ${zs[0] ? "on" : ""}" style="--c:${info.color}"><span class="dot"></span>${info.icon ? `<ha-icon class="z-ico" icon="${info.icon}"></ha-icon>` : ""}${esc(info.name)}${zs[1] ? `<span class="num-s">${zs[1]}</span>` : ""}</div>`);
      }
      return out;
    }

    /* ---------------- Einrichtung (Übersicht) ---------------- */

    _setupHtml() {
      const fp = this._store.floorplan;
      return `${this._storeErrorHtml()}
        <div class="section">
          <div class="sub">Grundriss</div>
          ${fp
            ? `<div class="row">${fp.kind === "walls"
                  ? `<svg class="thumb walls" viewBox="0 0 ${fp.width} ${fp.height}" preserveAspectRatio="xMidYMid meet">${this._floorplanSvg(fp)}${this._furnListSvg(this._store.furniture, Math.max(fp.width, fp.height) / 100)}</svg><div class="grow">Wandkarte · ${(fp.openings || []).filter((o) => o.type === "door").length} Türen · ${(fp.openings || []).filter((o) => o.type === "window").length} Fenster</div>
                    <button class="btn ghost" data-act="edit-walls">Bearbeiten</button>`
                  : `<img class="thumb" src="${esc(this._url(fp.url))}"><div class="grow">Bild · ${fp.width} × ${fp.height} px</div>`}
                <label class="btn ghost">Neu importieren<input type="file" accept="image/png,image/jpeg,image/gif" data-act="upload" hidden></label>
                <button class="btn ghost danger" data-act="remove-plan">Entfernen</button></div>
               <div class="hint">Die Ausrichtung der Sensoren (Position, Blickrichtung, Maßstab) und die Möbel beziehen sich auf diese Karte. Nach einem Neu-Import die Sensoren neu ausrichten und die Möbel neu stellen; Räume und Zonen auf den ESPs bleiben.</div>`
            : `<div class="hint">Optional: Bild eines Grundrisses (PNG/JPG/GIF). Übernommen werden nur die Wände – als eigene Karte. Ohne Grundriss zeigt die Karte das Raster des Sensors: 16 × 20 Zellen à 50 cm, Sensor oben mittig.</div>
               <label class="btn">Grundriss importieren<input type="file" accept="image/png,image/jpeg,image/gif" data-act="upload" hidden></label>`}
        </div>
        <div class="section">
          <div class="sub">Sensoren</div>
          ${this._config.devices.map((d, i) => {
            const L = this._layouts[d.device];
            const ok = L && !L.error && L.room;
            const n = ok ? FP2Math.maskCount(L.room.mask) : 0;
            const info = !L ? "lade …" : L.error ? `ESP: ${esc(L.error)}`
              : `${n ? `Raum ${n} Zellen` : "kein Raum"} · Ignorieren ${FP2Math.maskCount(L.excl)} · Zonen ${FP2Math.activeZones(L.zones, this._zmeta(d.device)).length}/${L.zones.length} · Filter ${L.filter.on}/${L.filter.window}`;
            const a = this._storedAlign(d.device);
            const al = fp ? (a ? ` · ausgerichtet (1 m = ${fmt(a.scale * 100)} px)` : " · nicht ausgerichtet") : "";
            const mh = this._mountHint(d.device);
            return `<div class="row dev-row">
              <span class="swatch" style="background:${COLORS[i % COLORS.length]}"></span>
              <div class="grow"><div>${esc(d.name)}</div><div class="hint small">${esc(d.device)} · ${info}${al}</div>
                ${mh ? `<div class="warn small">${esc(mh)}</div>` : ""}
                ${L && L.error ? `<div class="row btns"><button class="btn ghost sm" data-act="reload">Neu laden</button></div>` : ""}
                <div class="row btns">
                  <button class="btn ghost sm" data-act="learn" data-dev="${esc(d.device)}" ${ok ? "" : "disabled"}>Raum lernen</button>
                  <button class="btn ghost sm" data-act="interf" data-dev="${esc(d.device)}" ${ok ? "" : "disabled"}>Störquellen lernen</button>
                  <button class="btn ghost sm" data-act="edit" data-dev="${esc(d.device)}" ${ok ? "" : "disabled"}>Bearbeiten</button>
                  ${fp ? `<button class="btn ghost sm" data-act="align" data-dev="${esc(d.device)}">Ausrichten</button>` : ""}
                  <label class="toggle"><input type="checkbox" data-act="mirror" data-dev="${esc(d.device)}" ${this._mirror(d.device) ? "checked" : ""}> Links/rechts tauschen</label>
                </div></div>
            </div>`;
          }).join("")}
        </div>
        <div class="hint small">Raum lernen: allein frei herumlaufen. Störquellen lernen: leerer Raum, Ziele werden als Ignorier-Zellen vorgeschlagen. Bearbeiten: Zellen für Raum, Ignorieren und Zonen malen. „Links/rechts tauschen“, wenn ein Punkt beim Gehen zur falschen Seite läuft.</div>
        <div class="foot">fp2-room-card ${CARD_VERSION} · Grundriss und Ausrichtung in HA (${esc(this._storeKey)}), Raster-Layout v2 auf dem ESP</div>`;
    }

    async _setMirror(device, on) {
      const s = this._devStore(device);
      s.mirror = !!on;
      const a = s.align;
      if (a) {
        a.mirror = s.mirror;
        // Mit Messpunkt den Winkel neu bestimmen, damit der Messpunkt weiter auf der getippten Stelle liegt
        if (a.ref && a.dir) {
          const n = FP2Math.alignFromReference(a.pos, a.dir, a.ref.raw, a.ref.tap, s.mirror);
          a.ang = n.ang;
          a.scale = n.scale;
        }
      }
      await this._saveStore();
      this._renderShell();
    }

    /* ---------------- Raum lernen ---------------- */

    _startLearn(device) {
      this._learn = { device, phase: "ready", visits: new Uint16Array(FP2Math.CELLS), track: {}, frame: undefined, t0: 0, elapsed: 0, reports: 0, last: null, proposal: null };
      this._view = "learn";
      this._renderShell();
    }

    _learnHtml() {
      const l = this._learn;
      const d = this._dev(l.device);
      const head = `<div class="instruction">Raum lernen – <b>${esc(d.name)}</b></div>`;
      if (l.phase === "ready")
        return `${head}
          <div class="hint">Allein im Raum „Start“ tippen und 1–3 Minuten frei herumlaufen – auch an den Wänden entlang und in die Ecken. Gezählt werden nur Zellen, in denen sich ein Ziel bewegt hat; Ziele mit bitgleich wiederholter Position (eingefrorene Spuren, Geister) zählen nicht.</div>
          ${this._planSvg()}
          <div class="actions"><button class="btn" data-act="l-start">Start</button></div>`;
      if (l.phase === "run")
        return `${head}
          <div class="walk-grid">${this._planSvg()}
            <div class="walk-side">
              <div class="big-num" id="l-clock">0:00</div>
              <div class="status-line" id="l-stat">–</div>
              <div class="hint small">Orange = besuchte Zellen. Graues ✕ = Ziel ohne Bewegung (zählt nicht).</div>
              <button class="btn" data-act="l-stop">Stopp</button>
            </div></div>`;
      const nv = FP2Math.maskCount(FP2Math.maskFromCounts(l.visits, 1)), np = FP2Math.maskCount(l.proposal);
      return `${head}
        <div class="instruction">Vorschlag: <b>${np}</b> Zellen – ${nv} besucht, ${np - nv} durch Schließen und Füllen ergänzt.</div>
        <div class="hint">„Übernehmen“ öffnet den Editor mit diesem Raum; Zonen und Ignorier-Zellen bleiben. Dort lässt sich der Raum nachmalen und dann auf den ESP übertragen.</div>
        ${this._planSvg()}
        <div class="actions">
          <button class="btn ghost" data-act="l-discard">Verwerfen</button>
          <button class="btn ghost" data-act="l-resume">Weiterlaufen</button>
          <button class="btn" data-act="l-apply" ${np ? "" : "disabled"}>Übernehmen</button>
        </div>`;
    }

    _learnAction(act) {
      const l = this._learn;
      if (!l) return;
      switch (act) {
        case "l-start":
        case "l-resume":
          l.phase = "run";
          l.t0 = Date.now();
          // Ausgangslage: nur neue Meldungen zählen, Bewegung gegenüber der aktuellen Position
          l.frame = this._frameId(l.device);
          l.last = FP2Math.trackMoves(l.track, this._targets(l.device).targets, l.t0);
          this._startTimer();
          this._renderShell();
          return;
        case "l-stop":
          l.elapsed += Date.now() - l.t0;
          l.phase = "result";
          l.proposal = FP2Math.learnRoomFromVisits(l.visits);
          this._stopTimer();
          this._renderShell();
          return;
        case "l-discard": this._learn = null; this._view = "setup"; this._renderShell(); return;
        case "l-apply": {
          const room = l.proposal;
          this._learn = null;
          this._startEdit(l.device, { room });
          return;
        }
      }
    }

    _updateLearn() {
      const l = this._learn;
      if (!l) return;
      const root = this.shadowRoot;
      const now = Date.now();
      if (l.phase === "run") {
        const tg = this._newReport(l, l.device);
        if (tg) {
          l.last = FP2Math.trackMoves(l.track, tg, now);
          l.reports++;
          FP2Math.addVisits(l.visits, l.last);
        }
      }
      this._drawShapes({ grid: true, bare: l.phase !== "ready" });
      const it = this._scene().items[0];
      const u = this._u();
      const c = COLORS[it.di % COLORS.length];
      const edit = root.getElementById("edit-layer");
      if (edit) {
        const vis = FP2Math.maskFromCounts(l.visits, 1);
        let s = "";
        if (l.phase === "result" && l.proposal)
          s += `<path d="${this._maskPath(it.align, l.proposal)}" fill="${c}" fill-opacity="0.22" ${this._crisp(it.align)}/><path d="${this._maskEdges(it.align, l.proposal)}" fill="none" stroke="${c}" stroke-width="${u * 0.35}"/>`;
        if (l.phase !== "ready") s += `<path d="${this._maskPath(it.align, vis)}" fill="#ff5722" fill-opacity="0.35" ${this._crisp(it.align)}/>`;
        edit.innerHTML = s;
      }
      const live = root.getElementById("live-layer");
      if (live) {
        const list = l.phase === "run" && l.last ? l.last : this._targets(l.device).targets.map((t) => ({ ...t, moved: true }));
        live.innerHTML = list.map((t) => this._targetSvg(FP2Math.alignApply(it.align, t.x, t.y), "#ff5722", t.moved, this._rawLabel(t))).join("");
      }
      if (l.phase === "run") {
        const ms = l.elapsed + now - l.t0, sec = Math.floor(ms / 1000);
        const clock = root.getElementById("l-clock");
        if (clock) clock.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
        const st = root.getElementById("l-stat");
        if (st) {
          const res = this._targets(l.device);
          const nv = FP2Math.maskCount(FP2Math.maskFromCounts(l.visits, 1));
          st.textContent = res.reason ? "Sensor: " + res.reason : `${l.reports} Meldungen · ${nv} Zellen besucht${sec < 60 ? " · noch etwas weiterlaufen" : ""}`;
        }
      }
    }

    /* ---------------- Störquellen lernen ---------------- */

    _startInterf(device) {
      this._interf = { device, phase: "ready", counts: new Uint16Array(FP2Math.CELLS), reports: 0, t0: 0, t1: 0, frame: undefined, last: null, proposal: null };
      this._view = "interf";
      this._renderShell();
    }

    _interfHtml() {
      const s = this._interf;
      const d = this._dev(s.device);
      const head = `<div class="instruction">Störquellen lernen – <b>${esc(d.name)}</b></div>`;
      if (s.phase === "ready")
        return `${head}
          <div class="hint">Alle verlassen den Raum (auch Haustiere). Nach „Start“ bleiben ${INTERF_WAIT_MS / 1000} s zum Hinausgehen, dann wird ${INTERF_REC_MS / 60000} Minuten aufgenommen. Jede Zelle, in der in mindestens ${INTERF_MIN} Meldungen ein Ziel war (bewegt oder nicht), wird als Ignorier-Zelle vorgeschlagen. Bleibt die Meldung unverändert, zählt sie alle ${fmt(REPEAT_MS / 1000, 2).replace(".", ",")} s erneut.</div>
          ${this._planSvg()}
          <div class="actions"><button class="btn" data-act="i-start">Start</button></div>`;
      if (s.phase === "countdown")
        return `${head}
          <div class="instruction big">Bitte jetzt den Raum verlassen.</div>
          <div class="big-num" id="i-clock">${INTERF_WAIT_MS / 1000}</div>
          <div class="hint">Die Aufnahme beginnt automatisch.</div>`;
      if (s.phase === "run")
        return `${head}
          <div class="walk-grid">${this._planSvg()}
            <div class="walk-side">
              <div class="instruction">Aufnahme läuft – Raum leer lassen.</div>
              <div class="meter"><div class="meter-fill" id="i-meter"></div></div>
              <div class="status-line" id="i-stat">–</div>
              <button class="btn ghost" data-act="i-stop">Vorzeitig beenden</button>
            </div></div>`;
      const np = FP2Math.maskCount(s.proposal);
      return `${head}
        ${np ? `<div class="instruction">Vorschlag: <b>${np}</b> Zelle${np === 1 ? "" : "n"} als Störquelle (${s.reports} Meldungen ausgewertet).</div>
          <div class="hint">„Übernehmen“ vereinigt sie mit den bestehenden Ignorier-Zellen und öffnet den Editor.</div>`
        : `<div class="instruction">Keine Störquellen gefunden – in ${s.reports} Meldungen war keine Zelle mindestens ${INTERF_MIN}-mal belegt.</div>`}
        ${this._planSvg()}
        <div class="actions">
          <button class="btn ghost" data-act="i-discard">${np ? "Verwerfen" : "Zurück"}</button>
          ${np ? `<button class="btn" data-act="i-apply">Übernehmen</button>` : ""}
        </div>`;
    }

    _interfAction(act) {
      const s = this._interf;
      if (!s) return;
      switch (act) {
        case "i-start": s.phase = "countdown"; s.t0 = Date.now(); this._startTimer(); this._renderShell(); return;
        case "i-stop": this._interfFinish(); return;
        case "i-discard": this._interf = null; this._view = "setup"; this._renderShell(); return;
        case "i-apply": {
          const add = s.proposal;
          this._interf = null;
          this._startEdit(s.device, { exclAdd: add });
          return;
        }
      }
    }

    _interfTick() {
      const s = this._interf;
      if (!s) return;
      const now = Date.now();
      if (s.phase === "countdown" && now - s.t0 >= INTERF_WAIT_MS) {
        s.phase = "run";
        s.t1 = now;
        s.frame = this._frameId(s.device);   // nur Meldungen ab jetzt; der aktuelle Zustand zählt nach REPEAT_MS
        s.repAt = now;
        this._renderShell();
      } else if (s.phase === "run" && now - s.t1 >= INTERF_REC_MS) this._interfFinish();
    }

    _interfFinish() {
      const s = this._interf;
      s.phase = "result";
      s.proposal = FP2Math.maskFromCounts(s.counts, INTERF_MIN);
      this._stopTimer();
      this._renderShell();
    }

    _updateInterf() {
      const s = this._interf;
      if (!s) return;
      const root = this.shadowRoot;
      const now = Date.now();
      if (s.phase === "run") {
        const tg = this._reportOrRepeat(s, s.device, now);
        if (tg) { s.reports++; FP2Math.addReport(s.counts, tg); s.last = tg; }
      }
      if (s.phase === "countdown") {
        const el = root.getElementById("i-clock");
        if (el) el.textContent = String(Math.max(0, Math.ceil((INTERF_WAIT_MS - (now - s.t0)) / 1000)));
        return;
      }
      this._drawShapes({ grid: true });
      const it = this._scene().items[0];
      const u = this._u();
      const edit = root.getElementById("edit-layer");
      if (edit) {
        let h = "";
        if (s.phase === "run") {
          h += `<path d="${this._maskPath(it.align, FP2Math.maskFromCounts(s.counts, 1))}" fill="#ff5722" fill-opacity="0.18" ${this._crisp(it.align)}/>`;
          h += `<path d="${this._maskPath(it.align, FP2Math.maskFromCounts(s.counts, INTERF_MIN))}" fill="#ff5722" fill-opacity="0.4" ${this._crisp(it.align)}/>`;
        } else if (s.phase === "result" && s.proposal)
          h += `<path d="${this._maskPath(it.align, s.proposal)}" fill="#ff5722" fill-opacity="0.35" ${this._crisp(it.align)}/><path d="${this._maskEdges(it.align, s.proposal)}" fill="none" stroke="#ff5722" stroke-width="${u * 0.35}"/>`;
        edit.innerHTML = h;
      }
      const live = root.getElementById("live-layer");
      if (live) live.innerHTML = this._targets(s.device).targets.map((t) => this._targetSvg(FP2Math.alignApply(it.align, t.x, t.y), "#ff5722", true, this._rawLabel(t))).join("");
      if (s.phase === "run") {
        const meter = root.getElementById("i-meter");
        if (meter) meter.style.width = `${Math.min(100, Math.round(((now - s.t1) / INTERF_REC_MS) * 100))}%`;
        const st = root.getElementById("i-stat");
        if (st) {
          const left = Math.max(0, Math.ceil((INTERF_REC_MS - (now - s.t1)) / 1000));
          st.textContent = `noch ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} · ${s.reports} Meldungen · ${FP2Math.maskCount(FP2Math.maskFromCounts(s.counts, INTERF_MIN))} Zellen vorgeschlagen`;
        }
      }
    }

    /* ---------------- Bearbeiten (Malen) ---------------- */

    /** Editor öffnen; patch: { room } (aus Raum lernen) oder { exclAdd } (aus Störquellen lernen) */
    _startEdit(device, patch) {
      const base = this._layouts[device];
      if (!base || base.error || !base.room) { this._toast("Kein Layout vom ESP"); return; }
      const L = FP2Math.cloneLayout(base);
      // Möbel: auf dem Grundriss (wenn das Gerät dort ausgerichtet ist) oder im Raster des Geräts
      const fp = this._store && this._store.floorplan;
      const al = fp ? this._storedAlign(device) : null;
      const ds = this._store.devices[device];
      const zmeta = clone((ds && ds.zones) || {});
      const furnOwner = al ? "plan" : device;
      const furn = clone(furnOwner === "plan" ? this._store.furniture || [] : (ds && ds.furniture) || []);
      const e = {
        device, tool: "room", shape: "free", undo: [], dirty: false, stroke: null, note: null,
        zmeta, base: { zones: FP2Math.cloneLayout(base).zones, zmeta: clone(zmeta) }, metaDirty: false, adding: false,
        furnOwner, furnScale: al ? al.scale : 1, furn, fsel: -1, fdrag: null,
      };
      if (patch && patch.room) {
        e.undo.push({ key: "room", mask: L.room.mask.slice() });
        L.room.mask = patch.room.slice();
        e.dirty = true;
        e.note = "Raum aus „Raum lernen“ übernommen – noch nicht übertragen.";
      }
      if (patch && patch.exclAdd) {
        e.undo.push({ key: "excl", mask: L.excl.slice() });
        for (let i = 0; i < FP2Math.CELLS; i++) if (patch.exclAdd[i]) L.excl[i] = 1;
        e.tool = "excl";
        e.dirty = true;
        e.note = "Störquellen zu den Ignorier-Zellen hinzugefügt – noch nicht übertragen.";
      }
      this._drafts[device] = L;
      this._edit = e;
      this._zoomVB = null;
      this._view = "edit";
      this._renderShell();
    }

    /** Maske zu einem Werkzeug: room | excl | z<slot> (furn: keine Maske) */
    _maskOf(L, key) {
      if (key === "room") return L.room.mask;
      if (key === "excl") return L.excl;
      const z = L.zones.find((zz) => "z" + zz.slot === key);
      return z ? z.mask : null;
    }

    _setMaskOf(L, key, m) {
      if (key === "room") L.room.mask = m;
      else if (key === "excl") L.excl = m;
      else {
        const z = L.zones.find((zz) => "z" + zz.slot === key);
        if (z) z.mask = m;
      }
    }

    /** Im Editor gezeigte Zonen: aktiv (Zellen oder Name) oder gerade als Werkzeug gewählt */
    _editZones(L) {
      const e = this._edit;
      return L.zones.filter((z) => FP2Math.maskCount(z.mask) || FP2Math.zoneNamed(e.zmeta, z.slot) || "z" + z.slot === e.tool);
    }

    _zoneTypeOptions(sel) {
      return `<option value="">Typ …</option>` + Object.entries(FP2Math.ZONE_TYPES).map(([k, t]) => `<option value="${k}" ${k === sel ? "selected" : ""}>${esc(t.label)}</option>`).join("");
    }

    /** Möbel-Symbol für die Palette */
    _furnIcon(type) {
      const f = FP2Math.FURNITURE[type];
      const pad = Math.max(f.w, f.h) * 0.08;
      return `<svg class="f-ico" viewBox="${r1(-f.w / 2 - pad)} ${r1(-f.h / 2 - pad)} ${r1(f.w + 2 * pad)} ${r1(f.h + 2 * pad)}"><g class="furn" stroke-width="${r1(Math.max(f.w, f.h) / 28)}">${FP2Math.furnitureShape(type, f.w, f.h)}</g></svg>`;
    }

    _editHtml() {
      const e = this._edit;
      const d = this._dev(e.device);
      const L = this._drafts[e.device];
      const di = this._devIndex(e.device);
      const zones = this._editZones(L);
      const zi = (z) => FP2Math.zoneInfo(z, e.zmeta);
      const tools = [["room", "Raum", COLORS[di % COLORS.length]], ["excl", "Ignorieren", null],
        ...zones.map((z) => ["z" + z.slot, esc(zi(z).name), zi(z).color]), ["furn", "Möbel", "furn"]];
      const cnt = (k) => (k === "furn" ? e.furn.length : FP2Math.maskCount(this._maskOf(L, k)));
      const sw = (c) => (c === "furn" ? "" : `<span class="swatch${c ? "" : " hatch"}" ${c ? `style="background:${c}"` : ""}></span> `);
      const free = FP2Math.freeZoneSlot(L.zones, e.zmeta);
      const nFree = L.zones.filter((z) => !FP2Math.maskCount(z.mask) && !FP2Math.zoneNamed(e.zmeta, z.slot)).length;
      const isFurn = e.tool === "furn";
      const hint = e.tool === "room" ? "Zellen, in denen der ESP Personen zählt. Grau = Kante (außerhalb des Raums)."
        : e.tool === "excl" ? "Ziele in Ignorier-Zellen zählt der ESP nicht (Störquellen wie Ventilator, Vorhang, Spiegelungen)."
        : "Zonen zählen nur Ziele innerhalb des Raums und außerhalb der Ignorier-Zellen.";
      let side;
      if (isFurn) {
        const f = e.furn[e.fsel];
        side = `
            <div class="hint small">Möbel sind nur Anzeige. Antippen wählt aus, Ziehen verschiebt; Griffe an den Ecken: ↻ drehen (15°), ✕ löschen, ⤡ Größe. Zwei Finger verschieben/zoomen die Ansicht.</div>
            <div class="furn-pal">${Object.entries(FP2Math.FURNITURE).map(([k, t]) => `<button class="pal-btn" data-act="e-furn-add" data-type="${k}" title="${esc(t.label)} hinzufügen">${this._furnIcon(k)}<span>${esc(t.label)}</span></button>`).join("")}</div>
            ${f ? `<div class="row"><span class="grow small">${esc(FP2Math.FURNITURE[f.type].label)} · ${fmt(f.w / e.furnScale)} × ${fmt(f.h / e.furnScale)} cm · ${f.rot}°</span></div>
              <div class="row"><button class="btn ghost sm" data-act="e-furn-rot">Drehen 15°</button><button class="btn ghost sm danger" data-act="e-furn-del">Löschen</button></div>`
              : `<div class="hint small">${e.furn.length} Möbel – antippen zum Auswählen.</div>`}`;
      } else
        side = `
            <div class="seg"><button class="seg-btn ${e.shape === "rect" ? "on" : ""}" data-act="e-shape" data-shape="rect">Rechteck</button><button class="seg-btn ${e.shape === "free" ? "on" : ""}" data-act="e-shape" data-shape="free">Malen</button></div>
            <div class="hint small">${e.shape === "rect" ? "Rechteck über die Zellen ziehen (rastet auf 50-cm-Zellen ein)." : "Zellen antippen oder darüberziehen."} Die erste Zelle bestimmt, ob der Zug setzt oder löscht. Zwei Finger verschieben/zoomen die Ansicht. ${hint}</div>`;
      const zoneRows = zones.map((z) => {
        const info = zi(z), n = cnt("z" + z.slot);
        return `
              <div class="zone-card">
                <div class="zone-row">
                  <button class="swatch-btn" style="background:${info.color}" data-act="e-zone-color" data-slot="${z.slot}" title="Farbe wechseln"></button>
                  ${info.icon ? `<ha-icon class="z-ico" icon="${info.icon}"></ha-icon>` : ""}
                  <input class="zname grow" type="text" maxlength="40" value="${esc(info.name)}" placeholder="${esc(z.label)}" data-act="e-zone-name" data-slot="${z.slot}" title="Name (✎) – Slot ${z.slot}, im YAML „${esc(z.label)}“">
                  <button class="btn ghost sm danger" data-act="e-zone-del" data-slot="${z.slot}" title="Zone löschen">✕</button>
                </div>
                <div class="zone-row">
                  <select class="ztype" data-act="e-zone-type" data-slot="${z.slot}">${this._zoneTypeOptions(info.type)}</select>
                  <span class="hint small grow">${n ? n + " Zellen" : "noch leer"}</span>
                  <input class="hold" type="number" min="0" max="3600" value="${z.hold}" title="Haltezeit (s)" data-act="e-zone-hold" data-slot="${z.slot}"><span class="hint small">s</span>
                </div>
              </div>`;
      }).join("");
      const add = e.adding
        ? `<div class="zone-card">
              <div class="zone-row"><input id="e-new-name" class="zname grow" type="text" maxlength="40" placeholder="Name, z. B. Sofa"></div>
              <div class="zone-row"><select id="e-new-type" class="ztype grow">${this._zoneTypeOptions("")}</select>
                <button class="btn sm" data-act="e-zone-add-ok">Anlegen</button><button class="btn ghost sm" data-act="e-zone-add-cancel">Abbrechen</button></div>
            </div>`
        : `<button class="btn ghost sm" data-act="e-zone-add" ${free >= 0 ? "" : "disabled"}>Zone hinzufügen</button>`;
      return `
        <div class="instruction">Bearbeiten – <b>${esc(d.name)}</b>${e.dirty || e.metaDirty ? ` <span class="dirty">● ungespeichert</span>` : ""}</div>
        ${e.note ? `<div class="hint small">${esc(e.note)}</div>` : ""}
        <div class="walk-grid">
          <div>${this._planSvg(true)}
            ${this._zoomVB ? `<div class="row"><button class="btn ghost sm" data-act="e-zoom-reset">Ansicht zurücksetzen</button></div>` : ""}</div>
          <div class="walk-side">
            <div class="sub">Werkzeug</div>
            <div class="seg wrap">${tools.map(([k, l, c]) => `<button class="seg-btn ${e.tool === k ? "on" : ""}" data-act="e-tool" data-tool="${k}">${sw(c)}<span class="tl">${l}</span> <span class="small">${cnt(k)}</span></button>`).join("")}</div>
            ${side}
            <div class="row">
              <button class="btn ghost sm" data-act="e-undo" ${e.undo.length ? "" : "disabled"}>Rückgängig</button>
              <button class="btn ghost sm danger" data-act="e-clear" title="${isFurn ? "Alle Möbel entfernen" : "Alle Zellen des gewählten Werkzeugs löschen"}" ${cnt(e.tool) ? "" : "disabled"}>Alle löschen</button>
            </div>
            <div class="sub">Raum</div>
            <label class="field"><span>Haltezeit Raum (s)</span><input type="number" min="0" max="3600" value="${L.room.hold}" data-act="e-room-hold"></label>
            <div class="row">
              <label class="field grow"><span>Ein bei … Treffern</span><input type="number" min="1" max="32" value="${L.filter.on}" data-act="e-f-on"></label>
              <label class="field grow"><span>… in Frames</span><input type="number" min="1" max="32" value="${L.filter.window}" data-act="e-f-win"></label>
            </div>
            <div class="sub">Zonen</div>
            ${L.zones.length ? `${zoneRows}${add}
              <div class="hint small">${zones.length} aktiv · ${nFree} von ${L.zones.length} Slots frei. Name, Farbe und Typ liegen in HA; die Zonen-Entitäten werden beim Speichern umbenannt.</div>`
              : `<div class="hint small">Keine Zonen-Slots im ESP-YAML angelegt.</div>`}
            <button class="btn" data-act="e-save" ${(e.dirty || e.metaDirty) && !e.busy ? "" : "disabled"}>${e.dirty || !e.metaDirty ? "Auf den ESP übertragen" : "In HA speichern"}</button>
          </div>
        </div>`;
    }

    /**
     * Zwei Finger verschieben und zoomen die Ansicht (viewBox), ein Finger bleibt beim Werkzeug. cancel() bricht den
     * laufenden Zug des Werkzeugs ab, sobald der zweite Finger aufsetzt. Während der Geste ignorieren die Werkzeuge
     * alle Zeiger, bis alle Finger oben sind (this._gest).
     */
    _bindGestures(svg, cancel) {
      const ptrs = new Map();
      this._gest = null;
      const mid = () => { const v = [...ptrs.values()]; return [(v[0][0] + v[1][0]) / 2, (v[0][1] + v[1][1]) / 2, Math.hypot(v[0][0] - v[1][0], v[0][1] - v[1][1])]; };
      svg.addEventListener("pointerdown", (ev) => {
        if (ev.pointerType !== "touch") return;   // nur Finger (eine Maus hat keinen zweiten Zeiger)
        ptrs.set(ev.pointerId, [ev.clientX, ev.clientY]);
        if (ptrs.size !== 2) return;
        cancel();
        const ctm = svg.getScreenCTM && svg.getScreenCTM();
        if (!ctm) return;
        const inv = ctm.inverse();
        const vb = this._zoomVB || this._viewBox();
        const [mx, my, dist] = mid();
        // Plan = o + Pixel · upp (gleichmäßiger Maßstab, ohne Drehung); px0 = Pixelposition des viewBox-Ursprungs
        const upp = inv.a, o = [inv.e, inv.f];
        this._gest = { vb: { ...vb }, upp, px0: [(vb.x - o[0]) / upp, (vb.y - o[1]) / upp], P: [o[0] + mx * upp, o[1] + my * upp], dist: dist || 1 };
      });
      svg.addEventListener("pointermove", (ev) => {
        if (!ptrs.has(ev.pointerId)) return;
        ptrs.set(ev.pointerId, [ev.clientX, ev.clientY]);
        const g = this._gest;
        if (!g || ptrs.size < 2) return;
        const [mx, my, dist] = mid();
        const base = this._viewBox();
        const s = Math.max(base.w / 8 / g.vb.w, Math.min(base.w / g.vb.w, g.dist / Math.max(dist, 1)));
        const w = g.vb.w * s, h = g.vb.h * s, upp = g.upp * s;
        const vb = { x: g.P[0] - (mx - g.px0[0]) * upp, y: g.P[1] - (my - g.px0[1]) * upp, w, h };
        this._zoomVB = vb;
        svg.setAttribute("viewBox", `${r1(vb.x)} ${r1(vb.y)} ${r1(vb.w)} ${r1(vb.h)}`);
      });
      const up = (ev) => {
        ptrs.delete(ev.pointerId);
        if (this._gest && ptrs.size === 0) { this._gest = null; this._renderShell(); }
      };
      svg.addEventListener("pointerup", up);
      svg.addEventListener("pointercancel", up);
    }

    /** Malen: Tippen/Ziehen schaltet Zellen, Rechteck setzt alle Zellen dazwischen; die erste Zelle bestimmt an/aus */
    _bindPaint(svg) {
      const e = this._edit;
      const paint = (from, to) => {
        // Strecke in 10-cm-Schritten abtasten, damit schnelles Ziehen keine Zellen überspringt
        const m = this._maskOf(this._drafts[e.device], e.tool);
        if (!m) return false;
        const n = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / 10));
        let changed = false;
        for (let k = 0; k <= n; k++) {
          const i = FP2Math.cellOf(from[0] + ((to[0] - from[0]) * k) / n, from[1] + ((to[1] - from[1]) * k) / n);
          if (i >= 0 && m[i] !== e.stroke.value) { m[i] = e.stroke.value; changed = true; }
        }
        return changed;
      };
      this._bindGestures(svg, () => {
        // zweiter Finger: Zug zurücknehmen
        if (!e.stroke) return;
        const m = this._maskOf(this._drafts[e.device], e.tool);
        const u = e.undo.pop();
        if (m && u) m.set(u.mask);
        e.stroke = null;
        this._drawShapes({ grid: true });
      });
      svg.addEventListener("pointerdown", (ev) => {
        if (e.stroke || this._gest) return;   // zweiter Finger / Geste läuft
        const it = this._scene().items[0];
        const p = this._rawAt(ev, it.align);
        const i = p ? FP2Math.cellOf(p[0], p[1]) : -1;
        const m = this._maskOf(this._drafts[e.device], e.tool);
        if (i < 0 || !m) return;
        ev.preventDefault();
        e.undo.push({ key: e.tool, mask: m.slice() });
        e.stroke = { value: m[i] ? 0 : 1, align: it.align, last: p, start: i, base: m.slice(), rect: e.shape === "rect" };
        m[i] = e.stroke.value;
        e.dirty = true;
        try { svg.setPointerCapture(ev.pointerId); } catch (x) { /* ignorieren */ }
        this._drawShapes({ grid: true });
      });
      svg.addEventListener("pointermove", (ev) => {
        if (!e.stroke || this._gest) return;
        const p = this._rawAt(ev, e.stroke.align);
        if (!p) return;
        if (e.stroke.rect) {
          const m = this._maskOf(this._drafts[e.device], e.tool);
          const j = FP2Math.cellClamp(p[0], p[1]);
          if (j === e.stroke.lastCell) return;
          e.stroke.lastCell = j;
          m.set(e.stroke.base);
          FP2Math.maskRect(m, e.stroke.start, j, e.stroke.value);
          this._drawShapes({ grid: true });
          return;
        }
        const changed = paint(e.stroke.last, p);
        e.stroke.last = p;
        if (changed) this._drawShapes({ grid: true });
      });
      const end = () => {
        if (!e.stroke) return;
        e.stroke = null;
        this._renderShell();
      };
      svg.addEventListener("pointerup", end);
      svg.addEventListener("pointercancel", end);
    }

    /** Möbel-Ebene und Auswahl (Rahmen, Eckgriffe) neu zeichnen */
    _drawFurnEdit() {
      const root = this.shadowRoot, e = this._edit;
      const fl = root.getElementById("furn-layer");
      if (fl) fl.innerHTML = this._furnitureSvg();
      const ed = root.getElementById("edit-layer");
      if (!ed) return;
      const f = e && e.tool === "furn" ? e.furn[e.fsel] : null;
      if (!f) { ed.innerHTML = ""; return; }
      const u = this._u();
      const h = this._furnHandles(f);
      const knob = (p, col, sym) => `<circle cx="${r1(p[0])}" cy="${r1(p[1])}" r="${r1(u * 1.6)}" fill="${col}" stroke="#fff" stroke-width="${r1(u * 0.3)}"/><text x="${r1(p[0])}" y="${r1(p[1] + u * 0.7)}" font-size="${r1(u * 2)}" text-anchor="middle" fill="#fff" class="knob">${sym}</text>`;
      ed.innerHTML = `<g transform="translate(${f.x} ${f.y}) rotate(${f.rot})"><rect x="${r1(-f.w / 2)}" y="${r1(-f.h / 2)}" width="${f.w}" height="${f.h}" fill="none" stroke="#ff5722" stroke-width="${r1(u * 0.25)}" stroke-dasharray="${r1(u)} ${r1(u * 0.6)}"/></g>`
        + knob(h.rot, "#03a9f4", "↻") + knob(h.del, "#db4437", "✕") + knob(h.size, "#ff5722", "⤡");
    }

    /** Eckgriffe, etwas nach außen versetzt (kleine Möbel bleiben greifbar): links oben drehen, rechts oben löschen, rechts unten Größe */
    _furnHandles(f) {
      const o = this._u() * 1.8;
      const at = (sx, sy) => FP2Math.furnitureWorld(f, sx * (f.w / 2 + o), sy * (f.h / 2 + o));
      return { rot: at(-1, -1), del: at(1, -1), size: at(1, 1) };
    }

    /** Möbel: Tippen wählt, Ziehen verschiebt, Eckgriffe drehen/löschen/vergrößern; Maus und Touch über Pointer-Events */
    _bindFurniture(svg) {
      const e = this._edit;
      this._bindGestures(svg, () => {
        if (!e.fdrag) return;
        e.furn = e.fdrag.before;
        e.fdrag = null;
        this._drawFurnEdit();
      });
      svg.addEventListener("pointerdown", (ev) => {
        if (e.fdrag || this._gest) return;
        const p = this._planPoint(ev);
        if (!p) return;
        ev.preventDefault();
        const u = this._u();
        const near = (q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= u * 2.5;
        const sel = e.furn[e.fsel];
        if (sel) {
          const h = this._furnHandles(sel);
          if (near(h.del)) { this._editAction("e-furn-del"); return; }
          if (near(h.rot)) { this._editAction("e-furn-rot"); return; }
        }
        let mode = sel && near(this._furnHandles(sel).size) ? "resize" : null;
        let i = mode ? e.fsel : -1;
        if (!mode) { i = FP2Math.furnitureAt(e.furn, p[0], p[1], u * 0.5); if (i >= 0) mode = "move"; }
        if (!mode) { if (e.fsel !== -1) { e.fsel = -1; this._renderShell(); } return; }
        const f = e.furn[i];
        e.fsel = i;
        // Abstand Zeiger – Mitte (Verschieben) bzw. Zeiger – Ecke (Größe), damit nichts springt
        const ref = mode === "move" ? [f.x, f.y] : FP2Math.furnitureCorner(f);
        e.fdrag = { mode, i, d: [p[0] - ref[0], p[1] - ref[1]], before: clone(e.furn), moved: false };
        try { svg.setPointerCapture(ev.pointerId); } catch (x) { /* ignorieren */ }
        this._drawFurnEdit();
      });
      svg.addEventListener("pointermove", (ev) => {
        const g = e.fdrag;
        if (!g || this._gest) return;
        const p = this._planPoint(ev);
        if (!p) return;
        const f = e.furn[g.i];
        e.furn[g.i] = g.mode === "move" ? { ...f, x: r1(p[0] - g.d[0]), y: r1(p[1] - g.d[1]) } : FP2Math.furnitureResize(f, p[0] - g.d[0], p[1] - g.d[1], 10 * e.furnScale);
        g.moved = true;
        this._drawFurnEdit();
      });
      const end = () => {
        const g = e.fdrag;
        if (!g) return;
        e.fdrag = null;
        if (g.moved) { e.undo.push({ key: "furn", list: g.before }); e.metaDirty = true; }
        this._renderShell();
      };
      svg.addEventListener("pointerup", end);
      svg.addEventListener("pointercancel", end);
    }

    /** Ablageort für ein neues Möbelstück: Mitte des Raums (sonst der Ansicht), leicht versetzt je Stück */
    _furnDropPoint() {
      const e = this._edit, L = this._drafts[e.device], it = this._scene().items[0];
      let sx = 0, sy = 0, n = 0;
      for (let i = 0; i < FP2Math.CELLS; i++) {
        if (!L.room.mask[i]) continue;
        const q = FP2Math.cellRect(i);
        const p = FP2Math.alignApply(it.align, (q[0][0] + q[2][0]) / 2, (q[0][1] + q[2][1]) / 2);
        sx += p[0]; sy += p[1]; n++;
      }
      const vb = this._viewBox();
      const k = (e.furn.length % 5) * this._u() * 3;
      return n ? [sx / n + k, sy / n + k] : [vb.x + vb.w / 2 + k, vb.y + vb.h / 2 + k];
    }

    /** Zone anlegen: nächster freier Slot, Name/Typ aus dem Feld, wird gleich als Werkzeug (Rechteck) gewählt */
    _addZone() {
      const e = this._edit;
      const L = this._drafts[e.device];
      const slot = FP2Math.freeZoneSlot(L.zones, e.zmeta);
      if (slot < 0) { this._toast("Kein freier Zonen-Slot – weitere Slots im ESP-YAML anlegen"); return; }
      const z = L.zones.find((zz) => zz.slot === slot);
      const nameEl = this.shadowRoot.querySelector("#e-new-name"), typeEl = this.shadowRoot.querySelector("#e-new-type");
      const type = typeEl && FP2Math.ZONE_TYPES[typeEl.value] ? typeEl.value : null;
      const name = ((nameEl && nameEl.value) || "").trim().slice(0, 40) || (type ? FP2Math.ZONE_TYPES[type].label : z.label);
      e.zmeta[slot] = { name, color: FP2Math.freeZoneColor(L.zones, e.zmeta), ...(type ? { type } : {}) };
      e.tool = "z" + slot;
      e.shape = "rect";
      e.adding = false;
      e.metaDirty = true;
      e.note = `Zone „${name}“ angelegt (Slot ${slot}) – jetzt ein Rechteck über die Zellen ziehen, danach bei Bedarf einzeln malen.`;
      this._renderShell();
    }

    _editAction(act, el) {
      const e = this._edit;
      if (!e) return;
      const L = this._drafts[e.device];
      const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
      const slot = el && el.dataset ? Number(el.dataset.slot) : NaN;
      const zone = L.zones.find((z) => z.slot === slot);
      const furnUndo = () => { e.undo.push({ key: "furn", list: clone(e.furn) }); e.metaDirty = true; };
      switch (act) {
        case "e-tool": e.tool = el.dataset.tool; e.fsel = -1; break;
        case "e-shape": e.shape = el.dataset.shape === "rect" ? "rect" : "free"; break;
        case "e-zoom-reset": this._zoomVB = null; break;
        case "e-undo": {
          const u = e.undo.pop();
          if (!u) return;
          if (u.key === "furn") { e.furn = u.list; e.fsel = -1; e.metaDirty = true; }
          else { this._setMaskOf(L, u.key, u.mask); e.dirty = true; }
          break;
        }
        case "e-clear": {
          if (e.tool === "furn") { furnUndo(); e.furn = []; e.fsel = -1; break; }
          const m = this._maskOf(L, e.tool);
          if (!m) return;
          e.undo.push({ key: e.tool, mask: m.slice() });
          this._setMaskOf(L, e.tool, FP2Math.maskNew());
          e.dirty = true;
          break;
        }
        case "e-room-hold": L.room.hold = num(el.value, 0, 3600); e.dirty = true; break;
        case "e-f-on": L.filter.on = num(el.value, 1, 32); if (L.filter.on > L.filter.window) L.filter.window = L.filter.on; e.dirty = true; break;
        case "e-f-win": L.filter.window = num(el.value, 1, 32); if (L.filter.on > L.filter.window) L.filter.on = L.filter.window; e.dirty = true; break;
        case "e-zone-hold": zone.hold = num(el.value, 0, 3600); e.dirty = true; break;
        case "e-zone-name": {
          const v = String(el.value || "").trim().slice(0, 40);
          const m = { ...(e.zmeta[slot] || {}) };
          if (v) m.name = v; else delete m.name;
          if (Object.keys(m).length) e.zmeta[slot] = m; else delete e.zmeta[slot];
          e.metaDirty = true;
          break;
        }
        case "e-zone-type": {
          const m = { ...(e.zmeta[slot] || {}) };
          const old = FP2Math.zoneInfo(zone, e.zmeta);
          const t = FP2Math.ZONE_TYPES[el.value] ? el.value : null;
          // Standardname des Typs übernehmen, solange der Name nicht selbst vergeben wurde
          const auto = !FP2Math.zoneNamed(e.zmeta, slot) || old.name === zone.label || (old.type && old.name === FP2Math.ZONE_TYPES[old.type].label);
          if (t) { m.type = t; if (auto) m.name = FP2Math.ZONE_TYPES[t].label; } else delete m.type;
          e.zmeta[slot] = m;
          e.metaDirty = true;
          break;
        }
        case "e-zone-color": {
          const cur = FP2Math.zoneInfo(zone, e.zmeta).color;
          const P = FP2Math.ZONE_COLORS;
          e.zmeta[slot] = { ...(e.zmeta[slot] || {}), color: P[(P.indexOf(cur) + 1) % P.length] };
          e.metaDirty = true;
          break;
        }
        case "e-zone-del": {
          const info = FP2Math.zoneInfo(zone, e.zmeta);
          if (!confirm(`Zone „${info.name}“ löschen? Ihre Zellen werden gelöscht, Name und Farbe entfallen, der Slot wird frei.`)) return;
          if (FP2Math.maskCount(zone.mask)) { e.undo.push({ key: "z" + slot, mask: zone.mask.slice() }); zone.mask = FP2Math.maskNew(); e.dirty = true; }
          delete e.zmeta[slot];
          e.metaDirty = true;
          if (e.tool === "z" + slot) e.tool = "room";
          break;
        }
        case "e-zone-add": e.adding = true; break;
        case "e-zone-add-cancel": e.adding = false; break;
        case "e-zone-add-ok": this._addZone(); return;
        case "e-furn-add": {
          if (e.furn.length >= 40) { this._toast("Höchstens 40 Möbel"); return; }
          const p = this._furnDropPoint();
          const f = FP2Math.furnitureNew(el.dataset.type, p[0], p[1], e.furnScale);
          if (!f) return;
          furnUndo();
          e.furn.push(f);
          e.fsel = e.furn.length - 1;
          break;
        }
        case "e-furn-rot": if (!e.furn[e.fsel]) return; furnUndo(); e.furn[e.fsel] = FP2Math.furnitureRotate(e.furn[e.fsel], 15); break;
        case "e-furn-del": if (!e.furn[e.fsel]) return; furnUndo(); e.furn.splice(e.fsel, 1); e.fsel = -1; break;
        case "e-save": this._saveEdit(); return;
        default: return;
      }
      if (["e-room-hold", "e-f-on", "e-f-win", "e-zone-hold", "e-zone-name"].includes(act)) {
        // Eingabefelder nicht neu rendern (Fokus): geklemmte bzw. angeglichene Werte zurückschreiben, Speichern-Knopf aktivieren
        const put = (sel, v) => { const i = this.shadowRoot.querySelector(sel); if (i) i.value = String(v); };
        if (act === "e-room-hold") el.value = String(L.room.hold);
        else if (act === "e-zone-hold") el.value = String(zone.hold);
        else if (act === "e-zone-name") {
          const nm = FP2Math.zoneInfo(zone, e.zmeta).name;
          el.value = nm;
          const tl = this.shadowRoot.querySelector(`.seg-btn[data-tool="z${slot}"] .tl`);
          if (tl) tl.textContent = nm;
        } else { put('[data-act="e-f-on"]', L.filter.on); put('[data-act="e-f-win"]', L.filter.window); el.value = String(act === "e-f-on" ? L.filter.on : L.filter.window); }
        const b = this.shadowRoot.querySelector('[data-act="e-save"]');
        if (b && !e.busy) b.disabled = false;
        const ins = this.shadowRoot.querySelector(".instruction");
        if (ins && !ins.querySelector(".dirty")) ins.insertAdjacentHTML("beforeend", ` <span class="dirty">● ungespeichert</span>`);
        return;
      }
      this._renderShell();
      if (act === "e-zone-add") { const i = this.shadowRoot.querySelector("#e-new-name"); if (i && i.focus) i.focus(); }
    }

    /**
     * Speichern: geänderte Masken/Haltezeiten/Filter auf den ESP, danach Namen/Farben/Typen der Zonen und Möbel in HA,
     * zuletzt die Zonen-Entitäten umbenennen/ein-/ausblenden. HA-Fehler blockieren die ESP-Übertragung nicht.
     */
    async _saveEdit() {
      const e = this._edit;
      const L = this._drafts[e.device];
      if (e.busy || (!e.dirty && !e.metaDirty)) return;   // Doppelklick: nicht zweimal senden
      if (e.dirty && !FP2Math.maskCount(L.room.mask)) { this._toast("Der Raum braucht mindestens eine Zelle (Werkzeug „Raum“)"); return; }
      e.busy = true;
      const b = this.shadowRoot.querySelector('[data-act="e-save"]');
      if (b) b.disabled = true;
      let msg = "", espOk = true;
      try {
        if (e.dirty) {
          try {
            this._toast("Übertrage auf den ESP …");
            await this._pushLayout(e.device, L);
            if (this._edit === e) {
              this._drafts[e.device] = FP2Math.cloneLayout(this._layouts[e.device]);
              e.dirty = false;
              e.undo = [];
              e.note = null;
            }
            msg = "Auf dem ESP gespeichert";
          } catch (err) {
            if (err.stored) {
              // Layout ist auf dem ESP; der Entwurf entspricht ihm, nur das Neuladen schlug fehl
              e.dirty = false;
              e.undo = [];
              e.note = null;
              msg = "Auf dem ESP gespeichert, Neuladen fehlgeschlagen: " + err.message + " – in der Einrichtung „Neu laden“";
            } else {
              espOk = false;
              msg = (err.rejected ? "ESP hat abgelehnt: " : "Übertragung fehlgeschlagen: ") + err.message;
            }
          }
        }
        // HA-Teil auch dann, wenn nur Malen eine Zone aktiv/inaktiv gemacht hat (Entitäten ein-/ausblenden)
        const cur = this._drafts[e.device] || L;
        if (espOk && (e.metaDirty || FP2Math.zoneEntityChanges(e.base.zones, e.base.zmeta, cur.zones, e.zmeta).length)) msg = await this._saveEditMeta(e, msg);
      } finally {
        e.busy = false;
      }
      if (msg) this._toast(msg);
      this._renderShell();
    }

    /** Zonen-Namen/-Farben/-Typen und Möbel in HA speichern, danach Entitäten anpassen; Rückgabe: Meldung */
    async _saveEditMeta(e, msg) {
      const ds = this._devStore(e.device);
      const prev = { zones: ds.zones, plan: this._store.furniture, dev: ds.furniture };
      ds.zones = clone(e.zmeta);
      if (e.furnOwner === "plan") this._store.furniture = FP2Math.furnitureClean(e.furn);
      else ds.furniture = FP2Math.furnitureClean(e.furn);
      if (!(await this._saveStore())) {
        // nicht gespeichert: Anzeige nicht mit ungespeicherten Namen weiterführen, Entwurf bleibt im Editor
        ds.zones = prev.zones; this._store.furniture = prev.plan; ds.furniture = prev.dev;
        return (msg ? msg + " – " : "") + (this._storeError ? "Namen/Möbel nicht gespeichert: HA-Speicher nicht lesbar, erst „Neu laden“" : "Namen/Möbel nicht in HA gespeichert (Admin-Rechte nötig)");
      }
      const zones1 = (this._drafts[e.device] || this._layouts[e.device]).zones;
      const changes = FP2Math.zoneEntityChanges(e.base.zones, e.base.zmeta, zones1, e.zmeta);
      e.base = { zones: zones1.map((z) => ({ ...z, mask: z.mask.slice() })), zmeta: clone(e.zmeta) };
      e.metaDirty = false;
      msg = (msg ? msg + " · " : "") + "In HA gespeichert";
      let rn = "";
      try { rn = await this._renameZoneEntities(e.device, changes); } catch (err) { rn = "Entitäten nicht angepasst: " + (err.message || err); }
      return rn ? msg + " · " + rn : msg;
    }

    _updateEdit() {
      const e = this._edit;
      if (!e) return;
      const root = this.shadowRoot;
      const shapes = root.getElementById("shapes-layer");
      if (shapes && !shapes.childElementCount) this._drawShapes({ grid: true });
      const it = this._scene().items[0];
      const L = this._drafts[e.device];
      const c = COLORS[it.di % COLORS.length];
      const live = root.getElementById("live-layer");
      if (live) live.innerHTML = this._targets(e.device).targets
        .map((t) => this._targetSvg(FP2Math.alignApply(it.align, t.x, t.y), c, FP2Math.classify(L, t.x, t.y).counted, this._rawLabel(t))).join("");
    }

    /* ---------------- Ausrichten (Grundriss) ---------------- */

    _startAlign(device) {
      if (!this._store.floorplan) return;
      const prev = this._store.devices[device] && this._store.devices[device].align;
      const a = {
        device, step: 1, mirror: this._mirror(device),
        pos: prev && Array.isArray(prev.pos) ? [prev.pos[0], prev.pos[1]] : null,
        dir: prev && Array.isArray(prev.dir) ? [prev.dir[0], prev.dir[1]] : null,
        raw: prev && prev.ref ? prev.ref.raw : null, tap: prev && prev.ref ? prev.ref.tap : null,
        measure: null, track: {}, frame: undefined, last: [], preview: null,
      };
      this._align = a;
      this._alignRecalc();
      if (!a.preview) a.preview = this._storedAlign(device);
      this._view = "align";
      this._startTimer();
      this._renderShell();
    }

    _alignRecalc() {
      const a = this._align;
      a.preview = a.pos && a.dir ? FP2Math.alignFromReference(a.pos, a.dir, a.raw && a.tap ? a.raw : null, a.raw ? a.tap : null, a.mirror) : null;
    }

    _alignHtml() {
      const a = this._align;
      const d = this._dev(a.device);
      const names = ["Sensor", "Blickrichtung", "Maßstab", "Spiegeln"];
      const bar = `<div class="steps">${names.map((n, i) => `<span class="${i + 1 === a.step ? "cur" : i + 1 < a.step ? "done" : ""}">${i + 1}. ${n}</span>`).join("")}</div>`;
      const head = `${bar}<div class="instruction">Ausrichten – <b>${esc(d.name)}</b></div>`;
      if (a.step === 1)
        return `${head}<div class="instruction">Tippe auf die <b>Position des Sensors</b> im Plan.</div>
          ${this._planSvg(true)}
          <div class="actions"><button class="btn" data-act="a-next" ${a.pos ? "" : "disabled"}>Weiter</button></div>`;
      if (a.step === 2)
        return `${head}<div class="instruction">Tippe in die <b>Richtung, in die der Sensor schaut</b> (z. B. Mitte der gegenüberliegenden Wand).</div>
          ${this._planSvg(true)}
          <div class="actions"><button class="btn ghost" data-act="a-back">Zurück</button><button class="btn" data-act="a-next" ${a.dir ? "" : "disabled"}>Weiter</button></div>`;
      if (a.step === 3) {
        const p = a.preview;
        const dist = a.raw ? Math.hypot(a.raw[0], a.raw[1]) / 100 : 0;
        let side;
        if (!a.raw)
          side = `<div class="hint">Optional: Maßstab messen. Geh 1,5–4 m vor den Sensor, steh still und tippe gleich „Messen“ (${fmt(MEASURE_MS / 1000, 1).replace(".", ",")} s). Gemessen wird das Ziel, das in den letzten ${MOVER_MS / 1000} s am weitesten gegangen ist (grün).</div>
            <div class="meter"><div class="meter-fill" id="a-meter"></div></div>
            <div class="status-line" id="a-stat">–</div>
            <button class="btn" data-act="a-measure" id="a-measure">Messen</button>`;
        else if (!a.tap)
          side = `<div class="instruction">Gemessen${a.rawId != null ? ` (Ziel ${a.rawId})` : ""}: ${fmt(a.raw[0])} / ${fmt(a.raw[1])} cm (${fmt(dist, 2)} m vom Sensor).</div>
            ${dist < 1.5 || dist > 4 ? `<div class="warn small">Außerhalb von 1,5–4 m – der Maßstab wird ungenauer.</div>` : ""}
            <div class="instruction"><b>Tippe jetzt deine Position im Plan.</b></div>
            <button class="btn ghost" data-act="a-remeasure">Neu messen</button>`;
        else
          side = `<div class="instruction">Maßstab: 1 m = ${fmt(p.scale * 100, 1)} px · Blickrichtung um ${fmt((p.corr * 180) / Math.PI, 1)}° korrigiert.</div>
            <div class="hint small">Erneut tippen verschiebt die eigene Position.</div>
            <button class="btn ghost" data-act="a-remeasure">Neu messen</button>`;
        return `${head}<div class="walk-grid">${this._planSvg(!!a.raw)}<div class="walk-side">${side}</div></div>
          <div class="actions">
            <button class="btn ghost" data-act="a-back">Zurück</button>
            ${a.raw && a.tap ? `<button class="btn" data-act="a-next">Weiter</button>` : `<button class="btn ghost" data-act="a-skip">Ohne Maßstab weiter</button>`}
          </div>`;
      }
      return `${head}<div class="instruction">Geh im Raum nach links und rechts: Folgt der Punkt deiner Bewegung? Sonst <b>Links/rechts tauschen</b>.</div>
        ${a.raw && a.tap ? "" : `<div class="hint small">Ohne Messung gilt der Standard-Maßstab 1 px/cm – Größe der Zellen auf dem Plan prüfen, sonst in Schritt 3 messen.</div>`}
        ${this._planSvg()}
        <div class="actions">
          <button class="btn ghost" data-act="a-back">Zurück</button>
          <button class="btn ghost" data-act="a-mirror">Links/rechts tauschen${a.mirror ? " (an)" : ""}</button>
          <button class="btn" data-act="a-save" ${a.preview ? "" : "disabled"}>Speichern</button>
        </div>`;
    }

    _alignAction(act) {
      const a = this._align;
      if (!a) return;
      switch (act) {
        case "a-next": if ((a.step === 1 && a.pos) || (a.step === 2 && a.dir) || (a.step === 3 && a.raw && a.tap)) a.step++; break;
        case "a-back": a.step = Math.max(1, a.step - 1); a.measure = null; break;
        case "a-skip": a.raw = null; a.tap = null; a.measure = null; a.step = 4; break;
        case "a-remeasure": a.raw = null; a.tap = null; a.measure = null; break;
        case "a-mirror": a.mirror = !a.mirror; break;
        case "a-measure": this._alignStartMeasure(); return;
        case "a-save": this._saveAlign(); return;
        default: return;
      }
      this._alignRecalc();
      this._renderShell();
    }

    /** Tipp im Plan: Schritt 1 Sensorposition, Schritt 2 Blickrichtung, Schritt 3 eigene Position nach der Messung */
    _alignTap(ev) {
      const a = this._align;
      const q = this._planPoint(ev);
      if (!q) return;
      if (a.step === 1) { a.pos = q; a.step = 2; a.raw = null; a.tap = null; }   // neuer Ort: alte Messung gilt nicht mehr
      else if (a.step === 2) {
        if (Math.hypot(q[0] - a.pos[0], q[1] - a.pos[1]) < this._u() * 2) { this._toast("Etwas weiter vom Sensor entfernt tippen"); return; }
        a.dir = q; a.step = 3;
      } else if (a.step === 3) {
        if (!a.raw) { this._toast("Erst messen, dann die eigene Position tippen"); return; }
        if (Math.hypot(q[0] - a.pos[0], q[1] - a.pos[1]) < this._u()) { this._toast("Das ist die Sensorposition – die eigene Position tippen"); return; }
        a.tap = q;
      } else return;
      this._alignRecalc();
      this._renderShell();
    }

    /**
     * Messung starten: gemessen wird das Ziel, das zuletzt am weitesten gegangen ist (pickMover). Ortsfeste
     * Geister springen nur um wenige cm, eingefrorene Spuren bewegen sich gar nicht – beide scheiden so aus.
     * Bitgleiche Positionen während der Messung sind dagegen normal: der FP2 meldet eine stillstehende Person so.
     */
    _alignStartMeasure() {
      const a = this._align;
      const best = FP2Math.pickMover(a.track, Date.now(), MOVER_MS, MOVER_MIN_CM);
      if (!best) { this._toast(`Kein Ziel ist in den letzten ${MOVER_MS / 1000} s mindestens ${MOVER_MIN_CM / 100} m gegangen – zur Messstelle gehen, stillstehen, gleich „Messen“`); return; }
      // Ziel muss schon stehen: läuft es noch (oder ist es eine mitlaufende Spiegelung), wäre die Messung Zufall
      if (FP2Math.reachOf(a.track.ids[best.id], Date.now(), STILL_MS) > this._config.stable_tolerance) { this._toast(`Ziel ${best.id} bewegt sich noch – stillstehen, dann „Messen“`); return; }
      a.measure = { id: best.id, t0: Date.now(), samples: [] };
      const b = this.shadowRoot.getElementById("a-measure");
      if (b) b.disabled = true;
    }

    _alignTick() {
      const a = this._align;
      if (a && a.measure && Date.now() - a.measure.t0 >= MEASURE_MS) this._alignFinishMeasure();
    }

    _alignFinishMeasure() {
      const a = this._align;
      const m = a.measure;
      a.measure = null;
      const again = () => { const b = this.shadowRoot.getElementById("a-measure"); if (b) b.disabled = false; };
      if (m.samples.length < 2) { this._toast("Zu wenige Meldungen während der Messung – erneut messen"); again(); return; }
      const st = FP2Math.stability(m.samples);
      if (st.rms > this._config.stable_tolerance) { this._toast(`Zu viel Bewegung (Streuung ${fmt(st.rms)} cm) – stillstehen und erneut messen`); again(); return; }
      if (Math.hypot(st.x, st.y) < 100) { this._toast("Zu nah am Sensor – 1,5 bis 4 m Abstand"); again(); return; }
      a.raw = [st.x, st.y];
      a.rawId = m.id;
      a.tap = null;
      this._alignRecalc();
      this._renderShell();
    }

    _updateAlign() {
      const a = this._align;
      if (!a) return;
      const root = this.shadowRoot;
      const now = Date.now();
      // unveränderter Zustand = wiederholter Frame (stillstehende Person), sonst fehlten der Messung Meldungen
      const tg = this._reportOrRepeat(a, a.device, now);
      if (tg) {
        a.last = FP2Math.trackMoves(a.track, tg, now);
        if (a.measure) {
          const me = a.last.find((t) => t.id === a.measure.id);
          if (me) a.measure.samples.push({ x: me.x, y: me.y });
          else { a.measure = null; this._toast("Messung abgebrochen – Ziel verloren, bitte erneut messen"); const b = root.getElementById("a-measure"); if (b) b.disabled = false; }
        }
      }
      this._drawShapes({ grid: true });
      const u = this._u();
      const mk = (p, col, label) => `<circle cx="${p[0]}" cy="${p[1]}" r="${u * 1.2}" fill="${col}" stroke="#fff" stroke-width="${u * 0.3}"/>${label ? `<text x="${p[0]}" y="${p[1] - u * 2}" font-size="${u * 1.8}" text-anchor="middle" class="lbl" fill="${col}">${label}</text>` : ""}`;
      const edit = root.getElementById("edit-layer");
      if (edit) {
        let s = "";
        if (a.pos && !a.preview) s += mk(a.pos, "#ff5722", a.step === 2 ? "Blickrichtung?" : "Sensor");
        if (a.dir && a.step >= 2) s += `<path d="M${a.dir[0] - u} ${a.dir[1]}H${a.dir[0] + u}M${a.dir[0]} ${a.dir[1] - u}V${a.dir[1] + u}" stroke="#ff5722" stroke-width="${u * 0.3}"/>`;
        if (a.tap && a.step >= 3) s += mk(a.tap, "#4caf50", "ich");
        edit.innerHTML = s;
      }
      // Messziel (während der Messung) bzw. Kandidat davor grün, damit eine falsche Wahl auffällt
      const cand = a.step === 3 && !a.raw && !a.measure ? FP2Math.pickMover(a.track, now, MOVER_MS, MOVER_MIN_CM) : null;
      const live = root.getElementById("live-layer");
      if (live) {
        const p = a.preview;
        live.innerHTML = p ? (a.last || []).map((t) => {
          const q = FP2Math.alignApply(p, t.x, t.y);
          const me = a.measure ? t.id === a.measure.id : !!cand && t.id === cand.id;
          return this._targetSvg(q, me ? "#4caf50" : "#ff5722", t.run < FROZEN_RUN, this._rawLabel(t));
        }).join("") : "";
      }
      if (a.step === 3 && !a.raw) {
        const meter = root.getElementById("a-meter");
        if (meter) meter.style.width = a.measure ? `${Math.min(100, Math.round(((now - a.measure.t0) / MEASURE_MS) * 100))}%` : "0%";
        const st = root.getElementById("a-stat");
        if (st) {
          const res = this._targets(a.device);
          const ct = cand && (a.last || []).find((t) => t.id === cand.id);
          st.textContent = res.reason ? "Sensor: " + res.reason
            : a.measure ? `Messe Ziel ${a.measure.id} – stillstehen … (${a.measure.samples.length} Meldungen)`
            : ct ? `${res.targets.length} Ziel(e) · gemessen würde Ziel ${ct.id} bei ${fmt(ct.x)} / ${fmt(ct.y)} cm (grün, kam aus ${fmt(cand.reach / 100, 1)} m Entfernung)`
            : `${res.targets.length} Ziel(e), keines ist in den letzten ${MOVER_MS / 1000} s mindestens ${MOVER_MIN_CM / 100} m gegangen`;
        }
      }
    }

    async _saveAlign() {
      const a = this._align;
      const p = a.preview;
      if (!p || !a.dir) return;
      const s = this._devStore(a.device);
      s.align = { pos: p.pos, ang: p.ang, scale: p.scale, mirror: a.mirror, dir: a.dir, ...(a.raw && a.tap ? { ref: { raw: a.raw, tap: a.tap } } : {}) };
      s.mirror = a.mirror;
      if (!(await this._saveStore())) return;
      this._toast("Ausrichtung in HA gespeichert");
      this._stopTimer();
      this._align = null;
      this._view = "setup";
      this._renderShell();
    }

    /* ---------------- Demo-Modus (ohne FP2) ---------------- */

    /**
     * Simuliert einen FP2 mit fp2_rooms v2 im Roh-Rahmen: Personen laufen im Standard-Raum (4 × 5 m vor dem
     * Sensor), dazu ein ortsfester Geist mit bitgleicher Position. Das Layout (Text v2) liegt in HA
     * (frontend system data) statt auf einem ESP; ausgewertet wird wie auf dem ESP (Masken, ohne Filter).
     */
    async _demoLoad() {
      try {
        const r = await this._hass.callWS({ type: "frontend/get_system_data", key: STORE_PREFIX + "demo_layout_v2" });
        this._demoText = r && r.value && typeof r.value.text === "string" ? r.value.text : null;
      } catch (e) { this._demoText = null; }
    }

    /** Antwort wie get_layout des ESP (JSON v2) */
    _demoGetLayout() {
      const p = this._demoText ? FP2Math.parseLayoutText(this._demoText, DEMO_ZONES.map((z) => z.slot)) : null;
      const ok = !!(p && p.ok);
      const zone = (slot) => (ok && p.zones[slot]) || { hold: 5, mask: FP2Math.maskNew() };
      return FP2Math.layoutToJson({
        room: ok ? p.room : { hold: 5, mask: FP2Math.maskNew() },
        excl: ok ? p.excl : FP2Math.maskNew(),
        zones: DEMO_ZONES.map((z) => ({ ...z, hold: zone(z.slot).hold, mask: zone(z.slot).mask })),
        filter: ok ? p.filter : { on: 3, window: 10 },
        diag: { frames: this._demoFrame ? this._demoFrame.n : 0 },
        limits: { zones: FP2Math.MAX_ZONES },
      }, ok);
    }

    /** wie set_layout: Text prüfen (gleiche Regeln wie der ESP) und in HA speichern */
    async _demoSetLayout(text) {
      const p = FP2Math.parseLayoutText(text, DEMO_ZONES.map((z) => z.slot));
      if (!p.ok) { const e = new Error(p.error); e.rejected = true; throw e; }
      await this._hass.callWS({ type: "frontend/set_system_data", key: STORE_PREFIX + "demo_layout_v2", value: { text } });
      this._demoText = text;
    }

    _demoRandomPoint() {
      const R = DEMO_ROOM;
      return [R.x0 + 30 + Math.random() * (R.x1 - R.x0 - 60), R.y0 + 40 + Math.random() * (R.y1 - R.y0 - 70)];
    }

    /** Schlangenlinie durch den Demo-Raum (für „Raum lernen“) */
    _demoSweep() {
      const R = DEMO_ROOM, pts = [];
      for (let y = R.y0 + 25, k = 0; y < R.y1; y += 50, k++) {
        const a = [R.x0 + 25, y], b = [R.x1 - 25, y];
        pts.push(...(k % 2 ? [b, a] : [a, b]));
      }
      return pts;
    }

    _demoStart() {
      if (this._demoTimer) return;
      this._demoPersons = [{ p: [0, 250], goal: null, wait: 0 }, { p: this._demoRandomPoint(), goal: null, wait: 2000 }];
      this._demoClock = 0;
      this._demoFrame = { n: 0, targets: [] };
      this._demoBuildFrame();
      this._demoTimer = setInterval(() => { this._demoStep(100); this._onHassUpdate(); }, 100);
    }

    _demoStep(dt) {
      const v = this._view;
      const learning = v === "learn" && this._learn && this._learn.phase === "run";
      const away = v === "interf" && this._interf && (this._interf.phase === "countdown" || this._interf.phase === "run");
      const measuring = v === "align" && this._align && this._align.step === 3 && !this._align.raw;
      const solo = v === "learn" || v === "align" || (v === "interf" && !away);
      const speed = (learning ? 80 : 120) * (dt / 1000);   // cm je Schritt
      this._demoPersons.forEach((P, i) => {
        if (away) {
          // Raum verlassen: nach hinten links hinaus, dann unsichtbar
          if (P.hidden) return;
          P.goal = [DEMO_ROOM.x0 + 20, DEMO_ROOM.y1 + 60];
          P.path = null;
        } else {
          if (solo && i > 0) { P.hidden = true; return; }
          P.hidden = false;
          if (learning && i === 0) {
            if (!P.path || !P.path.length) P.path = this._demoSweep();
            P.goal = P.path[0];
          } else {
            P.path = null;
            if (measuring && i === 0) P.goal = P.away || [-60, 260];
          }
          if (!P.goal) {
            if (P.wait > 0) { P.wait -= dt; return; }
            P.goal = this._demoRandomPoint();
          }
        }
        const dx = P.goal[0] - P.p[0], dy = P.goal[1] - P.p[1], d = Math.hypot(dx, dy);
        if (d > speed) { P.p = [P.p[0] + (dx / d) * speed, P.p[1] + (dy / d) * speed]; return; }
        P.p = [...P.goal];
        if (away) { P.hidden = true; P.goal = null; return; }
        if (P.path && P.path.length) { P.path.shift(); P.goal = null; return; }
        if (measuring && i === 0) {
          // nach 15 s ohne Messung kurz weg und zurück: „Messen“ braucht ein hergegangenes Ziel
          if (P.away) { P.away = null; P.still = 0; }
          else if (!this._align.measure && (P.still = (P.still || 0) + dt) > 15000) { P.still = 0; P.away = this._demoRandomPoint(); }
        } else { P.goal = null; P.wait = 1500 + Math.random() * 4000; }
      });
      this._demoClock += dt;
      if (this._demoClock >= DEMO_FRAME_MS) { this._demoClock = 0; this._demoBuildFrame(); }
    }

    /** neue Meldung: Personen mit Messrauschen (nie bitgleich), Geist mit fester Position */
    _demoBuildFrame() {
      const jit = () => Math.round((Math.random() - 0.5) * 6);
      const targets = [];
      this._demoPersons.forEach((P, i) => {
        if (!P.hidden) targets.push({ id: i + 1, x: Math.round(P.p[0]) + jit(), y: Math.round(P.p[1]) + jit() });
      });
      targets.push({ id: DEMO_GHOST.id, x: DEMO_GHOST.x, y: DEMO_GHOST.y });
      this._demoFrame = { n: this._demoFrame.n + 1, targets };
    }

    _demoTargets() {
      return this._demoFrame ? this._demoFrame.targets : [];
    }

    /** Zonenstatus wie vom ESP (Kompaktform als Text), aus dem gespeicherten (nicht dem bearbeiteten) Layout */
    _demoState() {
      const L = this._layouts[this._config.devices[0].device];
      if (!L || L.error || !L.room || !FP2Math.maskCount(L.room.mask)) return FP2Math.formatZoneState(false, [0, 0], {});
      let n = 0;
      const z = {};
      for (const zz of L.zones) z[zz.slot] = [0, 0];
      for (const t of this._demoTargets()) {
        const c = FP2Math.classify(L, t.x, t.y);
        if (!c.counted) continue;
        n++;
        for (const s of c.zones) { z[s][0] = 1; z[s][1]++; }
      }
      return FP2Math.formatZoneState(true, [n ? 1 : 0, n], z);
    }

    /* ---------------- Styles ---------------- */

    _css() {
      return `
        :host { display:block; }
        ha-card { padding: 12px 14px 14px; overflow: hidden; position: relative; }
        .head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; }
        .title { font-size: 1.15em; font-weight: 500; color: var(--primary-text-color); }
        .head-actions { display:flex; gap:6px; }
        .demo-badge { font-size: .62em; font-weight: 500; padding: 2px 8px; border-radius: 10px; background: #ff9800; color: #fff; vertical-align: middle; }
        .btn { font: inherit; font-size: .9em; border: none; border-radius: 8px; padding: 7px 12px; cursor: pointer;
               background: var(--primary-color); color: var(--text-primary-color, #fff); display:inline-flex; align-items:center; justify-content:center; gap:6px; }
        .btn.sm { padding: 4px 9px; font-size: .82em; }
        .btn[disabled] { opacity: .4; cursor: default; }
        .btn.ghost { background: transparent; color: var(--primary-color); border: 1px solid var(--divider-color); }
        .btn.danger { color: var(--error-color, #db4437); }
        .section { margin: 6px 0 14px; display:flex; flex-direction:column; gap:8px; }
        .sub { font-size: .78em; text-transform: uppercase; letter-spacing: .05em; color: var(--secondary-text-color); margin-top: 6px; }
        .hint { font-size: .85em; color: var(--secondary-text-color); line-height: 1.4; }
        .small { font-size: .78em; }
        code { font-size: .9em; }
        .warn { background: rgba(255,152,0,.12); color: var(--primary-text-color); border-left: 3px solid var(--warning-color, #ff9800); padding: 8px 10px; border-radius: 6px; font-size: .88em; margin: 6px 0; }
        .row { display:flex; align-items:center; gap:10px; flex-wrap: wrap; }
        .grow { flex: 1 1 auto; min-width: 0; }
        .thumb { width: 64px; height: 48px; object-fit: cover; border-radius: 6px; border: 1px solid var(--divider-color); }
        .swatch { width: 12px; height: 12px; border-radius: 3px; flex: none; }
        .swatch.hatch { background: repeating-linear-gradient(45deg, #9e9e9e 0 2px, transparent 2px 5px); border: 1px solid #9e9e9e; }
        .dev-row { padding: 6px 0; border-bottom: 1px solid var(--divider-color); }
        .zone-row { display:flex; align-items:center; gap:6px; font-size: .9em; }
        .zone-row .hold { width: 52px; font: inherit; padding: 3px 4px; border-radius: 6px; border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); }
        .field { display:flex; flex-direction:column; gap:4px; font-size:.82em; color: var(--secondary-text-color); }
        .field input { font: inherit; font-size: 1rem; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); }
        .actions { display:flex; gap:8px; justify-content:flex-end; flex-wrap:wrap; margin-top: 10px; }
        .plan-wrap { width: 100%; border-radius: 10px; overflow: hidden; background: var(--secondary-background-color, #f5f5f5); border: 1px solid var(--divider-color); }
        .plan-wrap.raster { background: var(--card-background-color, #fff); }
        .grid-l { stroke: var(--divider-color, #e0e0e0); }
        .axis { fill: var(--secondary-text-color); }
        .big-num { font-size: 2.4em; font-weight: 600; color: var(--primary-text-color); font-variant-numeric: tabular-nums; }
        .toggle { display:inline-flex; align-items:center; gap:6px; font-size:.85em; color: var(--primary-text-color); cursor: pointer; }
        .dev-row .btns { margin-top: 6px; gap: 6px; }
        .seg-btn .swatch { display:inline-block; vertical-align: -1px; }
        .plan-wrap.drawing { cursor: crosshair; outline: 2px solid #ff5722; }
        #plan { width: 100%; height: auto; max-height: 70vh; display:block; }
        .lbl { font-weight: 600; paint-order: stroke; stroke: var(--card-background-color, #fff); stroke-width: .5; }
        .raw { fill: var(--primary-text-color); }
        .stats { display:flex; flex-wrap:wrap; gap:8px; margin-top: 10px; }
        .stat { display:flex; align-items:center; gap:6px; padding: 5px 10px; border-radius: 16px; background: var(--secondary-background-color, #f2f2f2); font-size: .88em; color: var(--secondary-text-color); }
        .stat.on { color: var(--primary-text-color); }
        .stat .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c); opacity: .3; }
        .stat.on .dot { opacity: 1; }
        .num-s { font-weight: 600; }
        .steps { display:flex; gap:6px; flex-wrap:wrap; margin-bottom: 10px; }
        .steps span { font-size: .78em; padding: 3px 9px; border-radius: 12px; background: var(--secondary-background-color, #eee); color: var(--secondary-text-color); }
        .steps span.cur { background: var(--primary-color); color: var(--text-primary-color, #fff); }
        .steps span.done { color: var(--primary-color); }
        .instruction { font-size: 1em; color: var(--primary-text-color); margin: 4px 0 6px; line-height: 1.4; }
        .instruction.big { font-size: 1.35em; }
        .dirty { color: #ff9800; font-size: .8em; }
        .plan-wrap.crop { background: #eee; }
        .plan-wrap.walls { background: var(--card-background-color, #fff); }
        .wall { fill: var(--primary-text-color, #212121); fill-opacity: .85; }
        .win { fill: var(--card-background-color, #fff); stroke: var(--primary-text-color, #212121); stroke-opacity: .85; }
        .win-l { fill: none; stroke: var(--primary-text-color, #212121); stroke-opacity: .85; }
        .door { fill: none; stroke: var(--primary-text-color, #212121); stroke-opacity: .7; stroke-linecap: round; }
        .door.arc { stroke-opacity: .45; }
        .seg.wrap { flex-wrap: wrap; }
        .seg.wrap .seg-btn { flex: 1 1 30%; }
        svg.thumb.walls { background: var(--card-background-color, #fff); object-fit: initial; }
        .btn[hidden] { display: none; }
        .field.slider input { padding: 0; accent-color: var(--primary-color); }
        .seg { display:flex; border: 1px solid var(--divider-color); border-radius: 8px; overflow: hidden; }
        .seg-btn { flex: 1; font: inherit; font-size: .88em; padding: 7px 8px; border: none; cursor: pointer; background: transparent; color: var(--primary-text-color); }
        .seg-btn.on { background: var(--primary-color); color: var(--text-primary-color, #fff); }
        .plan-wrap.drawing #plan { touch-action: none; }
        .walk-grid { display:grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 12px; align-items: start; }
        @media (max-width: 600px) { .walk-grid { grid-template-columns: 1fr; } }
        .walk-side { display:flex; flex-direction:column; gap: 8px; }
        .meter { height: 10px; border-radius: 5px; background: var(--secondary-background-color, #eee); overflow:hidden; }
        .meter-fill { height: 100%; width: 0; background: #4caf50; transition: width .2s linear; }
        .status-line { font-size: .9em; color: var(--primary-text-color); min-height: 2.6em; }
        .empty { padding: 18px 4px; }
        .empty-title { font-size: 1.05em; margin-bottom: 6px; color: var(--primary-text-color); }
        .foot { font-size: .72em; color: var(--secondary-text-color); text-align: right; }
        .toast { position:absolute; left: 0; right: 0; bottom: 12px; margin: 0 auto; width: max-content; max-width: calc(100% - 32px);
                 transform: translateY(20px); opacity: 0; pointer-events:none; background: var(--primary-text-color); color: var(--card-background-color, #fff);
                 padding: 8px 14px; border-radius: 8px; font-size: .88em; transition: all .25s ease; text-align: center; }
        .toast.show { opacity: .95; transform: translateY(0); }
        .edge { fill: #9e9e9e; fill-opacity: .22; }
        .furn { stroke: #757575; stroke-linejoin: round; stroke-linecap: round; }
        .furn .f-b { fill: #9e9e9e; fill-opacity: .22; }
        .furn .f-l { fill: none; }
        .furn .f-d { fill: #757575; fill-opacity: .7; }
        .furn .f-g { fill: #8bc34a; fill-opacity: .3; }
        .furn .f-r { fill: #9e9e9e; fill-opacity: .1; }
        .furn .f-dash { stroke-dasharray: 4 3; }
        .furn .f-hit { fill: transparent; stroke: none; }
        .knob { font-weight: 700; pointer-events: none; }
        .furn-pal { display:grid; grid-template-columns: repeat(auto-fill, minmax(64px, 1fr)); gap: 4px; }
        .pal-btn { font: inherit; font-size: .7em; display:flex; flex-direction:column; align-items:center; gap:2px; padding: 4px 2px; border: 1px solid var(--divider-color); border-radius: 8px; background: transparent; color: var(--primary-text-color); cursor: pointer; }
        .f-ico { width: 36px; height: 26px; }
        .zone-card { border: 1px solid var(--divider-color); border-radius: 8px; padding: 6px; display:flex; flex-direction:column; gap: 4px; }
        .zone-row .zname, .ztype { font: inherit; font-size: .95em; padding: 3px 6px; border-radius: 6px; border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); min-width: 0; }
        .swatch-btn { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--card-background-color, #fff); box-shadow: 0 0 0 1px var(--divider-color); cursor: pointer; flex: none; padding: 0; }
        .z-ico { --mdc-icon-size: 18px; color: var(--secondary-text-color); flex: none; }
        .stat .z-ico { --mdc-icon-size: 16px; }
      `;
    }
  }

  if (!customElements.get("fp2-room-card")) customElements.define("fp2-room-card", FP2RoomCard);
  window.customCards = window.customCards || [];
  if (!window.customCards.some((c) => c.type === "fp2-room-card"))
    window.customCards.push({
      type: "fp2-room-card",
      name: "FP2 Raumkarte",
      description: "Live-Positionen des Aqara FP2 (ESPHome + fp2_rooms) im Raster oder auf dem Grundriss: Raum lernen, Störquellen lernen, Zellen für Raum, Zonen und Ignorieren malen – Auswertung auf dem ESP.",
    });
  // eslint-disable-next-line no-console
  console.info(`%c FP2-ROOM-CARD %c ${CARD_VERSION} `, "background:#03a9f4;color:#fff", "background:#444;color:#fff");
}

if (typeof module !== "undefined" && module.exports) module.exports = { FP2Math };
