// Test der Wand-Erkennung: node test/card_walls.test.js [--dump]
// Vergleicht das Ergebnis mit der Wahrheitsmaske aus test/walls/make_plans.py und prüft, dass der
// SVG-Pfad genau die erkannte Maske beschreibt (Rasterung mit evenodd an Pixelmitten).
const fs = require("fs");
const { FP2Math } = require("../card/fp2-room-card.js");
const DIR = __dirname + "/walls/";
const dump = process.argv.includes("--dump");

// Erwartung je Plan: Einstellungen wie in der Karte (auto) bzw. mit Lücken-Regler
const CASES = [
  { name: "gefuellt", opts: {}, minIoU: 0.9 },
  { name: "farbig", opts: {}, minIoU: 0.9 },
  { name: "dunkel", opts: {}, minIoU: 0.9 },
  { name: "duenn", opts: {}, minIoU: 0.8 },
  { name: "doppellinie", opts: { close: 6 }, minIoU: 0.85 },
  { name: "schraffiert", opts: { close: 4 }, minIoU: 0.85 },
];

function rasterize(d, w, h) {
  const loops = [];
  for (const m of d.split("Z")) {
    const pts = FP2Math.pathVertices(m);
    if (pts.length >= 3) loops.push(pts);
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const cy = y + 0.5;
    const xs = [];
    for (const l of loops)
      for (let i = 0; i < l.length; i++) {
        const [x0, y0] = l[i], [x1, y1] = l[(i + 1) % l.length];
        if ((y0 <= cy) !== (y1 <= cy)) xs.push(x0 + ((cy - y0) * (x1 - x0)) / (y1 - y0));
      }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2)
      for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x < Math.min(w, Math.ceil(xs[k + 1] - 0.5)); x++) out[y * w + x] = 1;
  }
  return out;
}

let fail = 0;
for (const c of CASES) {
  const meta = JSON.parse(fs.readFileSync(DIR + c.name + ".json"));
  const gray = new Uint8Array(fs.readFileSync(DIR + c.name + ".gray"));
  const truth = new Uint8Array(fs.readFileSync(DIR + c.name + ".truth"));
  const t0 = Date.now();
  const r = FP2Math.extractWalls(gray, meta.w, meta.h, c.opts);
  const ms = Date.now() - t0;
  let tp = 0, fp = 0, fn = 0;
  for (let i = 0; i < truth.length; i++) {
    if (r.mask[i] && truth[i]) tp++;
    else if (r.mask[i]) fp++;
    else if (truth[i]) fn++;
  }
  const iou = tp / (tp + fp + fn), prec = tp / (tp + fp || 1), rec = tp / (tp + fn || 1);
  const ras = rasterize(r.d, meta.w, meta.h);
  // jede Abweichung Pfad↔Maske muss direkt am Wandrand liegen (≤ 1 px, Glättung durch Vereinfachung)
  let diff = 0, far = 0;
  const W = meta.w, H = meta.h;
  for (let i = 0; i < ras.length; i++) {
    if (ras[i] === r.mask[i]) continue;
    diff++;
    const x = i % W, y = (i - x) / W;
    let near = false;
    for (let dy = -1; dy <= 1 && !near; dy++)
      for (let dx = -1; dx <= 1 && !near; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < W && yy < H && r.mask[yy * W + xx] !== r.mask[i]) near = true;
      }
    if (!near) far++;
  }
  const pathOk = far === 0;
  const ok = iou >= c.minIoU && pathOk;
  console.log(`${ok ? "✓" : "✗"} ${c.name.padEnd(12)} IoU ${iou.toFixed(3)} (Präzision ${prec.toFixed(3)}, Trefferquote ${rec.toFixed(3)}) ` +
    `Param ${JSON.stringify(r.params)} Teile ${r.parts} Pfad ${(r.d.length / 1024).toFixed(1)} KB, Abweichung Pfad↔Maske ${diff} px (davon nicht am Rand ${far}), ${ms} ms`);
  if (!ok) fail++;
  if (dump) fs.writeFileSync(`${DIR}out_${c.name}.mask`, Buffer.from(r.mask));
}

// Türen und Fenster gegen die Wahrheit aus make_plans.py
function rectIoU(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const i = ix * iy, u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i;
  return u > 0 ? i / u : 0;
}
for (const c of CASES) {
  const meta = JSON.parse(fs.readFileSync(DIR + c.name + ".json"));
  const gray = new Uint8Array(fs.readFileSync(DIR + c.name + ".gray"));
  const r = FP2Math.extractWalls(gray, meta.w, meta.h, c.opts);
  const found = r.openings.slice();
  const msgs = [];
  let ok = true;
  for (const t of meta.openings) {
    let bi = -1, bv = 0;
    found.forEach((o, i) => { const v = rectIoU(o.r, t.r); if (v > bv) { bv = v; bi = i; } });
    const o = bi >= 0 && bv >= 0.5 ? found.splice(bi, 1)[0] : null;
    // bei geschlossenen Lücken (doppellinig/schraffiert) werden Fenster zu Wand – dort nur Türen erwartet
    const expected = !(c.opts.close && t.type === "window");
    if (!o) { msgs.push(`${t.type} ${t.axis} fehlt`); if (expected) ok = false; continue; }
    let m = `${t.type}${o.type !== t.type ? "→" + o.type : ""} IoU ${bv.toFixed(2)}`;
    if (o.type !== t.type) ok = false;
    if (t.type === "door") {
      const rot = o.hinge === t.hinge && o.swing === t.swing;
      m += rot ? " Anschlag/Aufschlag ✓" : ` Anschlag/Aufschlag ✗ (${o.hinge}/${o.swing} statt ${t.hinge}/${t.swing}, Bogen ${o.arc})`;
      if (!rot) ok = false;
    }
    msgs.push(m);
  }
  if (found.length) { ok = false; msgs.push(`${found.length} zusätzlich: ` + found.map((o) => o.type + " " + o.r.join(",")).join("; ")); }
  console.log(`${ok ? "✓" : "✗"} Öffnungen ${c.name.padEnd(12)} ${msgs.join(" | ")}`);
  if (!ok) fail++;
}

// Öffnungen von Hand: hinzufügen, umdrehen, umwandeln, löschen
{
  const base = [{ type: "door", r: [10, 10, 40, 18], axis: "h", hinge: 0, swing: 1 }];
  const out = FP2Math.applyOpeningOps(base, [
    { op: "add", o: { type: "window", r: [100, 10, 160, 18], axis: "h" } },
    { op: "set", p: [25, 14], patch: { hinge: 1, swing: -1 } },
    { op: "set", p: [130, 14], patch: { type: "door", hinge: 0, swing: 1 } },
    { op: "del", p: [12, 12] },
  ]);
  const ok = out.length === 1 && out[0].type === "door" && out[0].r[0] === 100 && base[0].hinge === 0;
  console.log(`${ok ? "✓" : "✗"} Öffnungen bearbeiten: ${JSON.stringify(out)}`);
  if (!ok) fail++;
}

// Lauflängen der Wandmaske: verlustfrei
{
  const meta = JSON.parse(fs.readFileSync(DIR + "schraffiert.json"));
  const gray = new Uint8Array(fs.readFileSync(DIR + "schraffiert.gray"));
  const r = FP2Math.extractWalls(gray, meta.w, meta.h, { close: 4 });
  const rle = FP2Math.maskToRle(r.mask, meta.w, meta.h);
  const back = FP2Math.rleToMask(rle, meta.w, meta.h);
  const same = back.every((v, i) => v === r.mask[i]);
  const again = FP2Math.finishWalls(back, meta.w, meta.h, {});
  const ok = same && again.d === r.d;
  console.log(`${ok ? "✓" : "✗"} Wandmaske als Lauflängen: ${rle.length} Zeichen, verlustfrei ${same}, Pfad identisch ${again.d === r.d}`);
  if (!ok) fail++;
}

// Entfernen per Klick: Punkt auf eine Wand → dieser Teil fällt weg
{
  const meta = JSON.parse(fs.readFileSync(DIR + "gefuellt.json"));
  const gray = new Uint8Array(fs.readFileSync(DIR + "gefuellt.gray"));
  const a = FP2Math.extractWalls(gray, meta.w, meta.h);
  let px = null;
  for (let i = 0; i < a.mask.length && !px; i++) if (a.mask[i]) px = [i % meta.w, Math.floor(i / meta.w)];
  const b = FP2Math.extractWalls(gray, meta.w, meta.h, { removed: [px] });
  const ok = b.removedParts.length === 1 && b.area < a.area && b.parts === a.parts - 1;
  console.log(`${ok ? "✓" : "✗"} Teil per Punkt entfernt: ${a.parts} → ${b.parts} Teile, Fläche ${a.area} → ${b.area}`);
  if (!ok) fail++;
}
process.exit(fail ? 1 : 0);
