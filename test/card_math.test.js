// Tests für Decoder und Homographie. Aufruf: node test/math.test.js
const assert = require("assert");
const { FP2Math } = require("../card/fp2-room-card.js");

function encodeTargets(targets) {
  const b = Buffer.alloc(1 + targets.length * 14);
  b[0] = targets.length;
  targets.forEach((t, i) => {
    const o = 1 + i * 14;
    b[o] = t.id;
    b.writeInt16BE(t.x, o + 1);
    b.writeInt16BE(t.y, o + 3);
    b.writeInt16BE(t.z ?? 0, o + 5);
    b.writeInt16BE(t.velocity ?? 0, o + 7);
    b.writeInt16BE(t.snr ?? 0, o + 9);
    b[o + 11] = t.classifier ?? 0;
    b[o + 12] = t.posture ?? 0;
    b[o + 13] = t.active ?? 1;
  });
  return b.toString("base64");
}

let n = 0;
const ok = (name) => { n++; console.log("✓", name); };

// --- Decoder ---
{
  const t = [
    { id: 1, x: -400, y: 800, z: 12, velocity: -5, snr: 300, classifier: 2, posture: 3, active: 1 },
    { id: 7, x: 399, y: 0, z: -1, velocity: 32767, snr: -32768, classifier: 0, posture: 0, active: 0 },
  ];
  const d = FP2Math.decodeTargets(encodeTargets(t));
  assert.deepStrictEqual(d, t);
  ok("Decoder: Vorzeichen, Big Endian, alle Felder");
  assert.deepStrictEqual(FP2Math.decodeTargets(encodeTargets([])), []);
  assert.deepStrictEqual(FP2Math.decodeTargets("unknown"), []);
  assert.deepStrictEqual(FP2Math.decodeTargets("unavailable"), []);
  assert.deepStrictEqual(FP2Math.decodeTargets(""), []);
  ok("Decoder: leere/ungültige Zustände");
  // abgeschnittener Datensatz: count=2, aber nur 1 Ziel vorhanden
  const full = Buffer.from(encodeTargets(t), "base64");
  const cut = full.subarray(0, 1 + 14 + 5).toString("base64");
  assert.strictEqual(FP2Math.decodeTargets(cut).length, 1);
  ok("Decoder: abgeschnittene Daten werden nicht falsch gelesen");
  // Format von esphome::base64_encode: Standard-Base64 mit Padding – Länge für 5 Ziele
  const five = encodeTargets(Array.from({ length: 5 }, (_, i) => ({ id: i, x: i, y: i })));
  assert.ok(five.length <= 255, "State-Länge " + five.length);
  ok(`Decoder: 5 Ziele = ${five.length} Zeichen (< 255, HA-State-Limit)`);
}

// --- Homographie ---
const Htrue = [0.9, -0.25, 310, 0.18, 1.05, -40, 0.0004, -0.0002, 1];
const apply = FP2Math.apply;
const close = (a, b, eps) => Math.abs(a - b) <= eps;

{
  // Raum-Ecken im Plan (Pixel) -> Sensorpunkte via Inverse erzeugen
  const plan = [[120, 80], [620, 95], [600, 470], [140, 450]];
  const Hinv = FP2Math.inv3(Htrue);
  const sensor = plan.map((p) => apply(Hinv, p));
  const H = FP2Math.fitHomography(sensor, plan);
  assert.ok(H);
  for (const p of [[0, 0], [250, 400], [-300, 600], [123, 456]]) {
    const a = apply(H, p), b = apply(Htrue, p);
    assert.ok(close(a[0], b[0], 1e-6) && close(a[1], b[1], 1e-6), `Punkt ${p}: ${a} vs ${b}`);
  }
  ok("Homographie: 4 Punkte exakt (auch Punkte außerhalb der Ecken)");
}

{
  // L-förmiger Raum, 6 Ecken, Messrauschen auf Sensorpunkten
  const plan = [[100, 100], [500, 100], [500, 300], [300, 300], [300, 500], [100, 500]];
  const Hinv = FP2Math.inv3(Htrue);
  let seed = 42;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  const sensor = plan.map((p) => { const s = apply(Hinv, p); return [s[0] + rnd() * 6, s[1] + rnd() * 6]; });
  const H = FP2Math.fitHomography(sensor, plan);
  assert.ok(H);
  const res = FP2Math.residuals(H, sensor, plan);
  const maxRel = Math.max(...res.map((r) => r.rel));
  assert.ok(maxRel < 0.03, "maxRel " + maxRel);
  ok(`Homographie: 6 Punkte mit Rauschen, max. Abweichung ${(maxRel * 100).toFixed(2)} %`);
}

{
  // realistischer Rohwertebereich wie in PROTOCOL.md (Eckmontage: X -400..400, Y 0..800)
  const sensor = [[380, 20], [-390, 30], [-370, 790], [395, 780]];
  const plan = [[0, 0], [500, 0], [500, 480], [0, 480]];
  const H = FP2Math.fitHomography(sensor, plan);
  assert.ok(H);
  sensor.forEach((s, i) => {
    const q = apply(H, s);
    assert.ok(close(q[0], plan[i][0], 1e-6) && close(q[1], plan[i][1], 1e-6));
  });
  ok("Homographie: Rohwerte im dokumentierten Wertebereich, Spiegelung X");
}

{
  // degenerierte Fälle
  assert.strictEqual(FP2Math.fitHomography([[0, 0], [1, 1], [2, 2], [3, 3]], [[0, 0], [1, 0], [1, 1], [0, 1]]), null);
  assert.strictEqual(FP2Math.fitHomography([[0, 0], [1, 0], [1, 1]], [[0, 0], [1, 0], [1, 1]]), null);
  assert.strictEqual(FP2Math.fitHomography([[5, 5], [5, 5], [5, 5], [5, 5]], [[0, 0], [1, 0], [1, 1], [0, 1]]), null);
  ok("Homographie: kollinear / zu wenig / identische Punkte -> null");
}

// --- Punkt im Polygon ---
{
  const L = [[100, 100], [500, 100], [500, 300], [300, 300], [300, 500], [100, 500]];
  assert.ok(FP2Math.pointInPolygon([200, 200], L));
  assert.ok(FP2Math.pointInPolygon([200, 450], L));
  assert.ok(!FP2Math.pointInPolygon([400, 400], L));
  assert.ok(!FP2Math.pointInPolygon([50, 50], L));
  ok("Punkt-in-Polygon: L-Form");
}

// --- Stabilität ---
{
  const s = FP2Math.stability([{ x: 10, y: 10 }, { x: 12, y: 9 }, { x: 11, y: 11 }, { x: 300, y: 300 }, { x: 10, y: 10 }]);
  assert.strictEqual(s.x, 11); assert.strictEqual(s.y, 10);
  assert.ok(s.rms > 100);
  ok("Stabilität: Median robust, Ausreißer erhöht Streuung");
}

console.log(`\n${n} Tests bestanden`);
