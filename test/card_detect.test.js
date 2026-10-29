// Test der Grundriss-Erkennung: node test/card_detect.test.js
const fs = require("fs");
const { FP2Math } = require("../card/fp2-room-card.js");
const truth = JSON.parse(fs.readFileSync(__dirname + "/plans/truth.json"));
let fail = 0;
for (const name of Object.keys(truth)) {
  const meta = JSON.parse(fs.readFileSync(`${__dirname}/plans/${name}.json`));
  const gray = new Uint8Array(fs.readFileSync(`${__dirname}/plans/${name}.gray`));
  const t0 = Date.now();
  const b = FP2Math.detectPlanBBox(gray, meta.w, meta.h);
  const ms = Date.now() - t0;
  const got = b ? [b.x0, b.y0, b.x1, b.y1].map((v) => Math.round(v / meta.scale)) : null;
  const [tx0, ty0, tx1, ty1] = truth[name];
  // Erwartung: Wandbereich vollständig enthalten, höchstens 8 % der Bildgröße Übermaß je Seite
  const tol = 0.08 * Math.max(meta.w, meta.h) / meta.scale;
  const ok = got && got[0] <= tx0 && got[1] <= ty0 && got[2] >= tx1 && got[3] >= ty1 &&
    tx0 - got[0] < tol && ty0 - got[1] < tol && got[2] - tx1 < tol && got[3] - ty1 < tol;
  console.log(`${ok ? "✓" : "✗"} ${name}: erkannt ${JSON.stringify(got)}, Wände ${JSON.stringify(truth[name])}, ${ms} ms`);
  if (!ok) fail++;
}
process.exit(fail ? 1 : 0);
