// Tests für Raster, Masken, Lernen und Ausrichtung (Layout v2). Aufruf: node test/card_grid.test.js
const assert = require("assert");
const { FP2Math: M } = require("../card/fp2-room-card.js");

let n = 0;
const ok = (name) => { n++; console.log("✓", name); };
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ""} ${a} vs ${b}`);
const idx = (row, col) => row * 16 + col;
const maskOf = (cells) => { const m = M.maskNew(); for (const [r, c] of cells) m[idx(r, c)] = 1; return m; };
const cellsOf = (m) => { const out = []; for (let i = 0; i < 320; i++) if (m[i]) out.push(i); return out; };
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

// --- Zelle aus Rohkoordinaten ---
{
  assert.strictEqual(M.cellOf(-400, 0), 0);
  assert.strictEqual(M.cellOf(-401, 0), -1);
  assert.strictEqual(M.cellOf(399, 0), 15);
  assert.strictEqual(M.cellOf(399.9, 0), 15);
  assert.strictEqual(M.cellOf(400, 0), -1);
  assert.strictEqual(M.cellOf(0, 0), 8);
  assert.strictEqual(M.cellOf(-0.1, 0), 7);
  assert.strictEqual(M.cellOf(-350, 50), idx(1, 1));
  assert.strictEqual(M.cellOf(-351, 49), idx(0, 0));
  assert.strictEqual(M.cellOf(0, 999), idx(19, 8));
  assert.strictEqual(M.cellOf(0, 1000), -1);
  assert.strictEqual(M.cellOf(0, -1), -1);
  assert.strictEqual(M.cellOf(0, -0.5), -1);
  assert.strictEqual(M.cellOf(-400, 999), 304);
  assert.strictEqual(M.cellOf(399, 999), 319);
  assert.strictEqual(M.cellOf(NaN, 10), -1);
  assert.strictEqual(M.cellOf(10, Infinity), -1);
  ok("cellOf: Ränder x −401/−400/399/400, y −1/0/999/1000, ungültige Werte");
}

{
  assert.deepStrictEqual(M.cellRect(0), [[-400, 0], [-350, 0], [-350, 50], [-400, 50]]);
  assert.deepStrictEqual(M.cellRect(319), [[350, 950], [400, 950], [400, 1000], [350, 1000]]);
  assert.deepStrictEqual(M.cellRect(idx(3, 9)), [[50, 150], [100, 150], [100, 200], [50, 200]]);
  for (let i = 0; i < 320; i++) {
    const q = M.cellRect(i);
    assert.strictEqual(M.cellOf((q[0][0] + q[2][0]) / 2, (q[0][1] + q[2][1]) / 2), i);
    assert.strictEqual(M.cellOf(q[0][0], q[0][1]), i, "linke obere Ecke gehört zur Zelle");
  }
  ok("cellRect: Roh-Ecken, Mitte und linke obere Ecke liegen in derselben Zelle");
}

// --- Hex-Textform ---
{
  assert.strictEqual(M.maskToHex(M.maskNew()), "0".repeat(80));
  assert.strictEqual(M.maskToHex(maskOf([[0, 0]])), "8000" + "0".repeat(76));
  assert.strictEqual(M.maskToHex(maskOf([[0, 15]])), "0001" + "0".repeat(76));
  assert.strictEqual(M.maskToHex(maskOf([[0, 0], [0, 1]])), "C000" + "0".repeat(76));
  assert.strictEqual(M.maskToHex(maskOf([[19, 0]])), "0".repeat(76) + "8000");
  assert.strictEqual(M.maskToHex(maskOf([[1, 4]])), "0000" + "0800" + "0".repeat(72));
  const full = new Uint8Array(320).fill(1);
  assert.strictEqual(M.maskToHex(full), "F".repeat(80));
  ok("maskToHex: Bit 15 = Spalte 0, Bit 0 = Spalte 15, Zeile 0 zuerst");

  const m = M.maskFromHex("8000" + "0001" + "0".repeat(72));
  assert.deepStrictEqual(cellsOf(m), [idx(0, 0), idx(1, 15)]);
  assert.deepStrictEqual(cellsOf(M.maskFromHex("c000" + "0".repeat(76))), [0, 1]);
  assert.deepStrictEqual(M.maskFromHex(" " + "0".repeat(80) + "\n"), M.maskNew());
  assert.strictEqual(M.maskFromHex("0".repeat(79)), null);
  assert.strictEqual(M.maskFromHex("0".repeat(81)), null);
  assert.strictEqual(M.maskFromHex("G" + "0".repeat(79)), null);
  assert.strictEqual(M.maskFromHex(null), null);
  assert.strictEqual(M.maskFromHex(1234), null);
  ok("maskFromHex: Bitlage, Kleinbuchstaben, falsche Länge/Zeichen -> null");

  for (let k = 0; k < 50; k++) {
    const r = new Uint8Array(320);
    for (let i = 0; i < 320; i++) r[i] = rnd() < 0.4 ? 1 : 0;
    const hex = M.maskToHex(r);
    assert.strictEqual(hex.length, 80);
    assert.deepStrictEqual(M.maskFromHex(hex), r);
    assert.deepStrictEqual(M.maskFromHex(hex.toLowerCase()), r);
  }
  ok("Hex-Roundtrip: 50 Zufallsmasken (auch klein geschrieben)");
}

// --- Schließen ---
{
  assert.deepStrictEqual(M.maskClose(M.maskNew()), M.maskNew());
  const full = new Uint8Array(320).fill(1);
  assert.deepStrictEqual(M.maskClose(full), full);
  for (const cell of [[0, 0], [0, 15], [19, 0], [19, 15], [7, 7]]) assert.deepStrictEqual(M.maskClose(maskOf([cell])), maskOf([cell]));
  ok("maskClose: leer/voll/Einzelzellen (auch in den Ecken) unverändert");

  // 3×3-Block mit Loch in der Mitte -> gefüllt
  const ring = [];
  for (let r = 4; r <= 6; r++) for (let c = 4; c <= 6; c++) if (!(r === 5 && c === 5)) ring.push([r, c]);
  const closed = M.maskClose(maskOf(ring));
  assert.strictEqual(closed[idx(5, 5)], 1);
  assert.strictEqual(M.maskCount(closed), 9);
  // Spalte am Rand (Spalte 0, Zeilen 3–6): kein Anwachsen nach außen, keine Erosion am Rand
  const edge = maskOf([[3, 0], [4, 0], [5, 0], [6, 0]]);
  assert.deepStrictEqual(M.maskClose(edge), edge);
  // ganze Zeile 0 (direkt vor dem Sensor) bleibt genau Zeile 0
  const row0 = maskOf(Array.from({ length: 16 }, (_, c) => [0, c]));
  assert.deepStrictEqual(M.maskClose(row0), row0);
  ok("maskClose: Loch im Block gefüllt, am Rasterrand weder Wachsen noch Schrumpfen");

  // Lücke von einer Spalte zwischen zwei 3 Zeilen hohen Blöcken: mittlere Zeile wird überbrückt (4er-Nachbarschaft)
  const blocks = [];
  for (let r = 5; r <= 7; r++) for (const c of [2, 3, 5, 6]) blocks.push([r, c]);
  const b = M.maskClose(maskOf(blocks));
  assert.strictEqual(b[idx(6, 4)], 1);
  assert.strictEqual(b[idx(5, 4)], 0);
  assert.strictEqual(b[idx(7, 4)], 0);
  for (const [r, c] of blocks) assert.strictEqual(b[idx(r, c)], 1, "Schließen ist extensiv");
  ok("maskClose: 1-Zellen-Lücke nur dort geschlossen, wo die 4er-Nachbarschaft sie umschließt");

  // Extensiv für Zufallsmasken
  for (let k = 0; k < 30; k++) {
    const r = new Uint8Array(320);
    for (let i = 0; i < 320; i++) r[i] = rnd() < 0.3 ? 1 : 0;
    const c = M.maskClose(r);
    for (let i = 0; i < 320; i++) if (r[i]) assert.strictEqual(c[i], 1);
    assert.deepStrictEqual(M.maskClose(c), c, "Schließen ist idempotent");
  }
  ok("maskClose: extensiv und idempotent (30 Zufallsmasken)");
}

// --- Löcher füllen ---
{
  // Ring (Zeilen 3–8, Spalten 3–9) mit freiem Inneren -> Inneres gefüllt
  const ring = [];
  for (let r = 3; r <= 8; r++) for (let c = 3; c <= 9; c++) if (r === 3 || r === 8 || c === 3 || c === 9) ring.push([r, c]);
  const f = M.maskFillHoles(maskOf(ring));
  assert.strictEqual(M.maskCount(f), 6 * 7);
  // U-Form zum Rand offen (Zeile 0 fehlt) -> nichts gefüllt
  const u = [];
  for (let r = 0; r <= 5; r++) { u.push([r, 3]); u.push([r, 8]); }
  for (let c = 3; c <= 8; c++) u.push([5, c]);
  assert.deepStrictEqual(M.maskFillHoles(maskOf(u)), maskOf(u));
  // Loch, das nur diagonal nach außen verbunden ist, gilt als Loch (4er-Nachbarschaft)
  const diag = maskOf([[4, 5], [5, 4], [5, 6], [6, 5], [4, 6], [6, 4]]);
  // freie Zelle (5,5): Nachbarn (4,5),(5,4),(5,6),(6,5) belegt -> eingeschlossen
  assert.strictEqual(M.maskFillHoles(diag)[idx(5, 5)], 1);
  // freie Randzellen werden nie gefüllt
  const all = new Uint8Array(320).fill(1);
  all[idx(0, 7)] = 0; all[idx(10, 0)] = 0; all[idx(10, 7)] = 0;
  const g = M.maskFillHoles(all);
  assert.strictEqual(g[idx(0, 7)], 0);
  assert.strictEqual(g[idx(10, 0)], 0);
  assert.strictEqual(g[idx(10, 7)], 1);
  ok("maskFillHoles: Ring gefüllt, offene U-Form nicht, Randzellen bleiben frei, 4er-Nachbarschaft");
}

// --- Raum aus besuchten Zellen ---
{
  // Rechteck Zeilen 2–9, Spalten 4–11 frei begangen, aber mit Lücken im Inneren und einer Kerbe am Rand
  const visits = new Uint16Array(320);
  for (let r = 2; r <= 9; r++) for (let c = 4; c <= 11; c++) visits[idx(r, c)] = 1 + ((r * 7 + c) % 4);
  for (const [r, c] of [[4, 6], [5, 6], [5, 7], [7, 9], [8, 5]]) visits[idx(r, c)] = 0;   // Löcher
  visits[idx(2, 8)] = 0;                                                                  // Kerbe am Rand
  const room = M.learnRoomFromVisits(visits);
  const expect = new Uint8Array(320);
  for (let r = 2; r <= 9; r++) for (let c = 4; c <= 11; c++) expect[idx(r, c)] = 1;
  expect[idx(2, 8)] = 0;
  assert.deepStrictEqual(room, expect);
  ok("learnRoomFromVisits: Löcher geschlossen/gefüllt, Kerbe am Rand bleibt frei");

  const none = M.learnRoomFromVisits(new Uint16Array(320));
  assert.strictEqual(M.maskCount(none), 0);
  const one = new Uint16Array(320); one[idx(10, 3)] = 5;
  assert.deepStrictEqual(cellsOf(M.learnRoomFromVisits(one)), [idx(10, 3)]);
  ok("learnRoomFromVisits: keine Besuche -> leer, Einzelzelle bleibt Einzelzelle");
}

// --- Bewegung je ID, eingefrorene Ziele ---
{
  const st = {};
  let t = M.trackMoves(st, [{ id: 1, x: 10, y: 100 }, { id: 2, x: 130, y: 330 }], 1000);
  assert.deepStrictEqual(t.map((e) => [e.moved, e.run]), [[false, 1], [false, 1]]);
  t = M.trackMoves(st, [{ id: 1, x: 12, y: 101 }, { id: 2, x: 130, y: 330 }], 2000);
  assert.deepStrictEqual(t.map((e) => [e.moved, e.run]), [[true, 1], [false, 2]]);
  t = M.trackMoves(st, [{ id: 1, x: 12, y: 101 }, { id: 2, x: 130, y: 330 }], 3000);
  assert.deepStrictEqual(t.map((e) => [e.moved, e.run]), [[false, 2], [false, 3]]);
  assert.strictEqual(st.ids[1].movedAt, 2000);
  assert.strictEqual(st.ids[2].movedAt, null);
  t = M.trackMoves(st, [{ id: 2, x: 130, y: 330 }], 4000);
  assert.ok(!st.ids[1], "verschwundene ID wird vergessen");
  t = M.trackMoves(st, [{ id: 1, x: 12, y: 101 }], 5000);
  assert.strictEqual(t[0].moved, false, "wieder aufgetauchte ID gilt nicht als bewegt");
  ok("trackMoves: neue ID nicht bewegt, bitgleiche Wiederholung zählt run hoch, verschwundene IDs vergessen");

  // pickMover: wer in den letzten 30 s am weitesten weg war; hin und her springender Geist und eingefrorene Spur scheiden aus
  const sm = {};
  const seq = [];
  for (let k = 0; k <= 10; k++) seq.push([{ id: 0, x: -150 + k * 15, y: 300 - k * 19 }, { id: 1, x: 114, y: 288 }]);   // Person geht ca. 2,4 m
  for (let k = 0; k < 12; k++) seq.push([{ id: 0, x: 0, y: 110 }, { id: 1, x: k % 2 ? 125 : 115, y: k % 2 ? 253 : 262 }]);   // Person steht bitgleich, Geist springt
  seq.forEach((f, k) => M.trackMoves(sm, f, 1000 + k * 750));
  const tEnd = 1000 + (seq.length - 1) * 750;
  assert.ok(sm.ids[1].movedAt > sm.ids[0].movedAt, "Geist ist zuletzt bewegt (alte Regel wählte ihn)");
  assert.strictEqual(M.pickMover(sm, tEnd).id, 0, "gemessen wird die Person");
  near(M.pickMover(sm, tEnd).reach, Math.hypot(150, 300 - 110), 0.01, "Entfernung vom Startpunkt");
  assert.strictEqual(M.pickMover(sm, tEnd + 31000), null, "nach 30 s ohne Weg kein Messziel");
  const sg = {};
  for (let k = 0; k < 40; k++) M.trackMoves(sg, [{ id: 4, x: k % 2 ? 125 : 115, y: k % 2 ? 253 : 262 }, { id: 5, x: 60, y: 260 }], k * 750);
  assert.strictEqual(M.pickMover(sg, 39 * 750), null, "nur Geister (40 Sprünge à 13 cm): kein Messziel");
  assert.strictEqual(M.pickMover(sg, 39 * 750, 30000, 10).id, 4, "Mindestentfernung ist ein Parameter");
  assert.ok(sg.ids[5].hist.length === 0 && sg.ids[4].hist.every((e) => 39 * 750 - e.t <= 30000) && sg.ids[4].hist.length < 40);
  assert.strictEqual(M.reachOf(sm.ids[0], tEnd, 1000), 0, "steht seit über 1 s");
  near(M.reachOf(sm.ids[1], tEnd, 1000), Math.hypot(10, 9), 0.01, "Geist sprang eben");
  assert.strictEqual(M.reachOf(undefined, tEnd, 1000), 0);
  ok("pickMover/reachOf: Person mit Weg statt zuletzt gesprungenem Geist, Zeitfenster, Mindestentfernung");

  const visits = new Uint16Array(320);
  const s2 = {};
  const frames = [
    [{ id: 1, x: -390, y: 10 }, { id: 9, x: 130, y: 330 }, { id: 5, x: 500, y: 100 }],
    [{ id: 1, x: -380, y: 12 }, { id: 9, x: 130, y: 330 }, { id: 5, x: 510, y: 100 }],
    [{ id: 1, x: -300, y: 60 }, { id: 9, x: 130, y: 330 }, { id: 5, x: 520, y: 100 }],
    [{ id: 1, x: -300, y: 60 }, { id: 9, x: 130, y: 330 }],
  ];
  const fresh = frames.map((f) => M.addVisits(visits, M.trackMoves(s2, f, 0)));
  assert.deepStrictEqual(fresh, [0, 1, 1, 0]);
  assert.deepStrictEqual(cellsOf(visits), [idx(0, 0), idx(1, 2)]);
  assert.strictEqual(visits[M.cellOf(130, 330)], 0, "Geist mit bitgleicher Position zählt nicht");
  ok("addVisits: nur bewegte Ziele, bitgleiche Geister und Ziele außerhalb des Rasters zählen nicht");
}

// --- Störquellen: Zellen mit Ziel in ≥ 2 Meldungen ---
{
  const counts = new Uint16Array(320);
  M.addReport(counts, [{ id: 1, x: 130, y: 330 }, { id: 2, x: 140, y: 340 }]);   // gleiche Zelle, eine Meldung
  M.addReport(counts, [{ id: 3, x: -200, y: 700 }]);
  M.addReport(counts, [{ id: 1, x: 130, y: 330 }, { id: 4, x: 0, y: -10 }]);
  assert.strictEqual(counts[M.cellOf(130, 330)], 2);
  assert.strictEqual(counts[M.cellOf(-200, 700)], 1);
  const prop = M.maskFromCounts(counts, 2);
  assert.deepStrictEqual(cellsOf(prop), [M.cellOf(130, 330)]);
  ok("addReport/maskFromCounts: je Meldung jede Zelle einmal, Vorschlag ab 2 Meldungen");

  assert.strictEqual(M.identicalRun([]), 0);
  assert.strictEqual(M.identicalRun([{ x: 1, y: 2 }, { x: 1, y: 3 }, { x: 1, y: 3 }]), 2);
  assert.strictEqual(M.identicalRun([{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }, { x: 6, y: 5 }]), 3);
  ok("identicalRun: längste Folge bitgleicher Positionen");
}

// --- Ausrichtung ---
{
  const g = M.alignDefault();
  assert.deepStrictEqual(g.pos, [400, 0]);
  near(g.ang, Math.PI / 2, 1e-12);
  assert.strictEqual(g.scale, 1);
  assert.strictEqual(g.mirror, false);
  for (const [x, y] of [[0, 0], [-400, 0], [399, 999], [120, 300], [-250, 640]]) {
    const p = M.alignApply(g, x, y);
    near(p[0], 400 + x, 1e-9); near(p[1], y, 1e-9);
    const pm = M.alignApply(M.alignDefault(0, true), x, y);
    near(pm[0], 400 - x, 1e-9); near(pm[1], y, 1e-9);
    const p1 = M.alignApply(M.alignDefault(1), x, y);
    near(p1[0], 1300 + x, 1e-9); near(p1[1], y, 1e-9);
  }
  ok("alignDefault: Anzeige = (400 + i·900 + s·x, y), Sensor oben mittig");

  // f = Blickrichtung: y-Achse zeigt entlang ang; ohne Spiegelung liegt +x rechts von f gedreht um −90°
  const a = { pos: [100, 200], ang: 0, scale: 2, mirror: false };
  const p = M.alignApply(a, 0, 50);
  near(p[0], 200, 1e-9); near(p[1], 200, 1e-9);
  const q = M.alignApply(a, 50, 0);
  near(q[0], 100, 1e-9); near(q[1], 100, 1e-9);   // r = (sin 0, −cos 0) = (0, −1)
  const qm = M.alignApply({ ...a, mirror: true }, 50, 0);
  near(qm[0], 100, 1e-9); near(qm[1], 300, 1e-9);
  ok("alignApply: p = pos + scale·(y·f + s·x·r) mit f = (cos, sin), r = (sin, −cos)");

  for (let k = 0; k < 200; k++) {
    const al = { pos: [rnd() * 1000, rnd() * 800], ang: (rnd() - 0.5) * 4 * Math.PI, scale: 0.2 + rnd() * 3, mirror: rnd() < 0.5 };
    const x = (rnd() - 0.5) * 900, y = rnd() * 1100;
    const d = M.alignApply(al, x, y);
    const r = M.alignInvert(al, d[0], d[1]);
    near(r[0], x, 1e-6); near(r[1], y, 1e-6);
    const d2 = M.alignApply(al, r[0], r[1]);
    near(d2[0], d[0], 1e-6); near(d2[1], d[1], 1e-6);
  }
  const gr = M.alignInvert(M.alignDefault(0, true), 300, 450);
  near(gr[0], 100, 1e-9); near(gr[1], 450, 1e-9);
  ok("alignApply/alignInvert: Roundtrip mit/ohne Spiegelung (200 Zufallsfälle), Rastermodus gespiegelt");
}

{
  // Wahre Ausrichtung; Nutzer tippt Sensor, ungefähre Blickrichtung und seine Position zum Messpunkt
  for (let k = 0; k < 100; k++) {
    const mirror = k % 2 === 1;
    const truth = { pos: [200 + rnd() * 600, 100 + rnd() * 500], ang: (rnd() - 0.5) * 2 * Math.PI, scale: 0.4 + rnd() * 2, mirror };
    const raw = [(rnd() - 0.5) * 300, 150 + rnd() * 250];
    const tap = M.alignApply(truth, raw[0], raw[1]);
    const dirTrue = M.alignApply(truth, 0, 300);
    const dirPoint = [dirTrue[0] + (rnd() - 0.5) * 40, dirTrue[1] + (rnd() - 0.5) * 40];   // ungenau getippt
    const a = M.alignFromReference(truth.pos, dirPoint, raw, tap, mirror);
    near(a.scale, truth.scale, 1e-9, "Maßstab");
    near(Math.cos(a.ang), Math.cos(truth.ang), 1e-9); near(Math.sin(a.ang), Math.sin(truth.ang), 1e-9);
    assert.strictEqual(a.mirror, mirror);
    const p = M.alignApply(a, raw[0], raw[1]);
    near(p[0], tap[0], 1e-6); near(p[1], tap[1], 1e-6);
    const ang0 = Math.atan2(dirPoint[1] - truth.pos[1], dirPoint[0] - truth.pos[0]);
    near(Math.cos(ang0 + a.corr), Math.cos(a.ang), 1e-9); near(Math.sin(ang0 + a.corr), Math.sin(a.ang), 1e-9);
  }
  ok("alignFromReference: Messpunkt fällt auf den Tipp, Maßstab/Winkel exakt (mit/ohne Spiegelung)");

  const d = M.alignFromReference([400, 0], [400, 300], null, null);
  near(d.ang, Math.PI / 2, 1e-12);
  assert.strictEqual(d.scale, 1);
  assert.strictEqual(d.corr, 0);
  const z = M.alignFromReference([400, 0], [400, 300], [0, 0], [450, 50]);
  assert.strictEqual(z.scale, 1, "Messpunkt im Ursprung ist unbrauchbar");
  ok("alignFromReference: ohne Messpunkt Blickrichtung und 1 px/cm");

  // Rastermodus als Referenzfall: Sensor (400,0), Blick nach unten, Messpunkt (100, 300) -> Tipp (500, 300)
  const r = M.alignFromReference([400, 0], [380, 500], [100, 300], [500, 300]);
  near(r.ang, Math.PI / 2, 1e-12); near(r.scale, 1, 1e-12);
  ok("alignFromReference: reproduziert die Standard-Ausrichtung des Rasters");
}

// --- Layout v2: Text, JSON, Auswertung ---
{
  const room = M.maskNew();
  for (let r = 0; r < 10; r++) for (let c = 4; c < 12; c++) room[idx(r, c)] = 1;
  const L = {
    room: { hold: 5, mask: room },
    excl: maskOf([[6, 10]]),
    zones: [{ slot: 0, label: "Sofa", hold: 7, mask: maskOf([[8, 4], [8, 5], [9, 4], [9, 5], [6, 10]]) }, { slot: 1, label: "Tisch", hold: 0, mask: M.maskNew() }],
    filter: { on: 3, window: 10 },
  };
  const text = M.layoutToText(L);
  const lines = text.split("\n");
  assert.strictEqual(lines[0], "v2");
  assert.strictEqual(lines[1], "R 5 " + M.maskToHex(room));
  assert.strictEqual(lines[2], "X " + M.maskToHex(L.excl));
  assert.ok(lines[3].startsWith("Z 0 7 ") && lines[4] === "Z 1 0 " + "0".repeat(80));
  assert.strictEqual(lines[5], "F 3 10");
  assert.ok(lines[1].length === 4 + 80);
  ok("layoutToText: v2 / R / X / Z je Slot / F");

  const p = M.parseLayoutText(text, [0, 1]);
  assert.ok(p.ok, p.error);
  assert.deepStrictEqual(p.room.mask, room);
  assert.strictEqual(p.room.hold, 5);
  assert.deepStrictEqual(p.excl, L.excl);
  assert.deepStrictEqual(p.zones[0].mask, L.zones[0].mask);
  assert.strictEqual(p.zones[0].hold, 7);
  assert.deepStrictEqual(p.filter, { on: 3, window: 10 });
  const p2 = M.parseLayoutText(lines.join(";") + ";", [0, 1]);
  assert.ok(p2.ok);
  const p3 = M.parseLayoutText(lines.map((l) => l + "  \r").join("\n") + "\n\n", [0, 1]);
  assert.ok(p3.ok, p3.error);
  const noX = M.parseLayoutText(["v2", lines[1]].join("\n"), []);
  assert.ok(noX.ok && M.maskCount(noX.excl) === 0 && noX.filter.on === 3 && noX.filter.window === 10);
  ok("parseLayoutText: Roundtrip, ';' als Trenner, \\r/Leerzeichen am Ende, Standardfilter 3/10");

  const err = (t, slots = [0]) => M.parseLayoutText(t, slots).error;
  const hex = M.maskToHex(room), zero = "0".repeat(80);
  assert.strictEqual(err("v1\nH 1 0 0 0 1 0 0 0 1"), "Format v1 wird nicht mehr unterstützt – Raum in der Karte neu einrichten");
  assert.strictEqual(err("R 5 " + hex), "Versionszeile 'v2' fehlt");
  assert.strictEqual(err("v2\nX " + zero), "Raum (R) fehlt");
  assert.strictEqual(err("v2\nR 5 " + zero), "Zeile 2: Raum braucht mindestens 1 Zelle");
  assert.strictEqual(err("v2\nR 3601 " + hex), "Zeile 2: Haltezeit 0..3600 s");
  assert.strictEqual(err("v2\nR 5 " + hex.slice(1)), "Zeile 2: Maske braucht 80 Hex-Zeichen (79 gefunden)");
  assert.strictEqual(err("v2\nR 5 " + hex.slice(1) + "G"), "Zeile 2: ungültiges Zeichen in der Maske (nur 0-9, a-f, A-F)");
  assert.strictEqual(err("v2\nR 5 " + hex + " 1"), "Zeile 2: zu viele Werte");
  assert.strictEqual(err("v2\nR 5 " + hex + "\nR 5 " + hex), "Zeile 3: Raum (R) doppelt");
  assert.strictEqual(err("v2\nR 5 " + hex + "\nX " + zero + "\nX " + zero), "Zeile 4: Ignorier-Zellen (X) doppelt");
  for (const f of ["F 0 10", "F 11 10", "F 3 33", "F 3"]) assert.strictEqual(err("v2\nR 5 " + hex + "\n" + f), "Zeile 3: 1 <= on_count <= window <= 32", f);
  assert.strictEqual(err("v2\nR 5 " + hex + "\nZ 32 5 " + zero), "Zeile 3: Zonen-Slot 0..31");
  assert.ok(M.parseLayoutText("v2\nR 5 " + hex + "\nZ 31 5 " + hex, [31]).ok, "Slot 31 ist gültig");
  assert.strictEqual(err("v2\nR 5 " + hex + "\nZ 20 5 " + hex, [0, 1]), "Zonen-Slot 20 ist im YAML nicht angelegt");
  assert.strictEqual(err("v2\nR 5 " + hex + "\nZ 2 5 " + hex), "Zonen-Slot 2 ist im YAML nicht angelegt");
  assert.ok(M.parseLayoutText("v2\nR 5 " + hex + "\nZ 2 5 " + zero, [0]).ok, "leere Maske in fremdem Slot ist erlaubt");
  assert.strictEqual(err("v2\nR 5 " + hex + "\nZ 0 5 " + zero + "\nZ 0 5 " + zero), "Zeile 4: Zone 0 doppelt");
  assert.strictEqual(err("v2\nR 5 " + hex + "\nS 1 0,0 1,1"), "Zeile 3: unbekannter Eintrag 'S'");
  assert.strictEqual(err("v10\nR 5 " + hex), "Zeile 1: unbekannte Version");
  assert.strictEqual(err("v2\nR 5 " + hex + "\0"), "Zeile 2: ungültiges Zeichen (NUL)");
  ok("parseLayoutText: Fehlerfälle mit denselben Meldungen wie fp2_rooms (v1, Version, R fehlt/leer/doppelt, Grenzen, Slots, S-Zeile, NUL)");

  // wie parse_layout: Leerraum/Tabs zwischen und vor Feldern, Versionszeile an beliebiger Stelle, Tag ohne Leerzeichen
  for (const t of [" v2\nR 5 " + hex, "v2\n  R 5 " + hex, "v2\nR  5 " + hex, "v2\nR\t5 " + hex, "R 5 " + hex + "\nv2", "v2\nR 5 " + hex + "\t", "v 2\nR5 " + hex, "v2\nR +5 " + hex])
    assert.ok(M.parseLayoutText(t).ok, JSON.stringify(t) + ": " + M.parseLayoutText(t).error);
  assert.strictEqual(M.parseLayoutText("v2\nR\t7\t" + hex + "\nF  2\t9").room.hold, 7);
  assert.deepStrictEqual(M.parseLayoutText("v2\nR 5 " + hex + "\nF  2\t9").filter, { on: 2, window: 9 });
  ok("parseLayoutText: nimmt dieselben Texte an wie parse_layout (Leerraum, Tabs, Lage der Versionszeile)");

  const j = M.layoutToJson({ ...L, diag: { frames: 3 }, limits: { zones: 8 } });
  assert.strictEqual(j.version, 2);
  assert.strictEqual(j.calibrated, true);
  assert.deepStrictEqual(j.grid, { cols: 16, rows: 20, cell: 50, x0: -400, y0: 0 });
  assert.strictEqual(j.room.mask, M.maskToHex(room));
  const back = M.parseLayoutJson(JSON.parse(JSON.stringify(j)));
  assert.ok(!back.error, back.error);
  assert.deepStrictEqual(back.room.mask, room);
  assert.deepStrictEqual(back.excl, L.excl);
  assert.deepStrictEqual(back.zones.map((z) => [z.slot, z.label, z.hold, M.maskToHex(z.mask)]), L.zones.map((z) => [z.slot, z.label, z.hold, M.maskToHex(z.mask)]));
  assert.deepStrictEqual(back.filter, { on: 3, window: 10 });
  assert.strictEqual(M.layoutToText(back), text, "JSON -> Layout -> Text wie vorher");
  ok("layoutToJson/parseLayoutJson: Roundtrip wie get_layout");

  assert.match(M.parseLayoutJson({ version: 1, calibrated: true, h: [1, 0, 0, 0, 1, 0, 0, 0, 1] }).error, /Layout-Version 1/);
  assert.match(M.parseLayoutJson({ ...j, grid: { ...j.grid, cell: 40 } }).error, /Raster/);
  assert.match(M.parseLayoutJson({ ...j, excl: "xyz" }).error, /ungültige Maske/);
  assert.ok(M.parseLayoutJson(null).error);
  const empty = M.parseLayoutJson({ version: 2, calibrated: false, zones: [{ slot: 0, label: "Sofa", hold: 5, mask: zero }] });
  assert.ok(!empty.error && M.maskCount(empty.room.mask) === 0 && empty.zones.length === 1);
  ok("parseLayoutJson: v1-Antwort, falsches Raster, ungültige Maske, leeres Layout");

  const c = M.cloneLayout(back);
  c.room.mask[0] = 1; c.zones[0].mask[0] = 1; c.excl[0] = 1;
  assert.strictEqual(back.room.mask[0], 0);
  assert.strictEqual(back.zones[0].mask[0], 0);
  assert.strictEqual(back.excl[0], 0);
  ok("cloneLayout: Masken werden kopiert");

  // Auswertung: Raum ∧ ¬X, Zone nur für gezählte Ziele
  const at = (r, cc) => { const q = M.cellRect(idx(r, cc)); return [q[0][0] + 25, q[0][1] + 25]; };
  assert.deepStrictEqual(M.classify(back, ...at(8, 4)), { cell: idx(8, 4), counted: true, zones: [0] });
  assert.deepStrictEqual(M.classify(back, ...at(6, 10)), { cell: idx(6, 10), counted: false, zones: [] });
  assert.deepStrictEqual(M.classify(back, ...at(3, 2)), { cell: idx(3, 2), counted: false, zones: [] });
  assert.deepStrictEqual(M.classify(back, 0, -20), { cell: -1, counted: false, zones: [] });
  assert.deepStrictEqual(M.classify(back, ...at(0, 8)), { cell: idx(0, 8), counted: true, zones: [] });
  ok("classify: gezählt nur in Raum-Zellen ohne Ignorier-Bit, Zone nur für gezählte Ziele");
}

// --- 32 Zonen: get_layout, Text ohne leere Standard-Slots ---
{
  const zero = "0".repeat(80);
  const zones = Array.from({ length: 32 }, (_, i) => ({ slot: i, label: i < 3 ? ["Sofa", "Schreibtisch", "Esstisch"][i] : `Zone ${i + 1}`, hold: 5, mask: zero }));
  zones[31].mask = "8000" + "0".repeat(76);
  zones[4].hold = 9;
  const L = M.parseLayoutJson({ version: 2, calibrated: true, room: { hold: 5, mask: "F".repeat(80) }, excl: zero, zones, limits: { zones: 32 } });
  assert.ok(!L.error, L.error);
  assert.strictEqual(L.zones.length, 32);
  assert.strictEqual(L.zones[31].label, "Zone 32");
  assert.strictEqual(L.limits.zones, 32);
  const lines = M.layoutToText(L).split("\n");
  assert.deepStrictEqual(lines.filter((l) => l[0] === "Z").map((l) => l.split(" ").slice(0, 3).join(" ")), ["Z 4 9", "Z 31 5"], "nur Zonen mit Zellen oder eigener Haltezeit");
  const back = M.parseLayoutText(lines.join("\n"), zones.map((z) => z.slot));
  assert.ok(back.ok, back.error);
  assert.strictEqual(back.zones[31].mask[0], 1);
  assert.strictEqual(M.parseLayoutJson({ version: 2, zones: [{ slot: 32, label: "x", mask: zero }] }).zones.length, 0, "Slot 32 gibt es nicht");
  ok("32 Zonen: get_layout mit Slots 0..31, set_layout-Text lässt leere Slots mit 5 s weg (ESP-Standard)");
}

// --- Zonenstatus kompakt und alte Form ---
{
  const s = M.parseZoneState('{"c":1,"r":[1,3],"z":"80000005","n":"2010000000000000000000000000000f"}');
  assert.strictEqual(s.c, 1);
  assert.deepStrictEqual(s.r, [1, 3]);
  assert.deepStrictEqual(s.z[0], [1, 2], "Bit 0 = Slot 0, Zähler an Stelle 0");
  assert.deepStrictEqual(s.z[1], [0, 0]);
  assert.deepStrictEqual(s.z[2], [1, 1]);
  assert.deepStrictEqual(s.z[31], [1, 15], "Bit 31 = Slot 31, Zähler f = 15");
  assert.strictEqual(Object.keys(s.z).length, 32);
  const lo = M.parseZoneState('{"c":0,"r":[0,0],"z":"0000000a","n":"0A"}');
  assert.deepStrictEqual([lo.z[0], lo.z[1], lo.z[3], lo.z[5]], [[0, 0], [1, 10], [1, 1], [0, 0]], "Kleinbuchstaben, kurzes n: belegt ohne Zähler = 1");
  const old = M.parseZoneState('{"c":1,"r":[1,2],"z":{"0":[1,2],"1":[0,0],"40":[1,1]}}');
  assert.deepStrictEqual(old, { c: 1, r: [1, 2], z: { 0: [1, 2], 1: [0, 0] } }, "alte Objekt-Form, Slot 40 verworfen");
  assert.strictEqual(M.parseZoneState("kaputt"), null);
  assert.strictEqual(M.parseZoneState("[1,2]"), null);
  assert.deepStrictEqual(M.parseZoneState('{"c":1,"z":"zz"}'), { c: 1, r: null, z: {} });
  const f = M.formatZoneState(true, [1, 4], { 0: [1, 2], 9: [1, 20], 31: [1, 1] });
  assert.deepStrictEqual(JSON.parse(f), { c: 1, r: [1, 4], z: "80000201", n: "200000000f000000000000000000000" + "1" });
  const rt = M.parseZoneState(f);
  assert.deepStrictEqual([rt.z[0], rt.z[9], rt.z[31], rt.z[5]], [[1, 2], [1, 15], [1, 1], [0, 0]]);
  ok("parseZoneState: Kompaktform (Bit i = Slot i, n je Slot), alte Objekt-Form, ungültig -> null; formatZoneState wie ESP");
}

// --- Zonen: aktiv, freier Slot, Namen/Farben/Typen, Entitäten ---
{
  const z = (slot, cells, label) => ({ slot, label: label || `Zone ${slot + 1}`, hold: 5, mask: maskOf(cells) });
  const zones = [z(0, [], "Sofa"), z(1, [[3, 3]], "Schreibtisch"), z(2, [], "Esstisch"), z(3, [])];
  assert.deepStrictEqual(M.activeZones(zones, {}).map((q) => q.slot), [1]);
  assert.deepStrictEqual(M.activeZones(zones, { 2: { name: "Couch" } }).map((q) => q.slot), [1, 2], "Name in HA macht die Zone aktiv");
  assert.deepStrictEqual(M.activeZones(zones, { 0: { name: "  " }, 3: { color: "#ff0000" } }).map((q) => q.slot), [1], "leerer Name / nur Farbe zählt nicht");
  assert.strictEqual(M.freeZoneSlot(zones, {}), 0);
  assert.strictEqual(M.freeZoneSlot(zones, { 0: { name: "Couch" } }), 2, "benannter und belegter Slot sind nicht frei");
  assert.strictEqual(M.freeZoneSlot([zones[3], zones[0]], { 0: { name: "A" } }), 3);
  assert.strictEqual(M.freeZoneSlot([zones[1]], {}), -1);
  assert.strictEqual(M.freeZoneSlot([], {}), -1);
  const info = M.zoneInfo(zones[0], { 0: { name: " Couch ", color: "#123abc", type: "sofa" } });
  assert.deepStrictEqual(info, { name: "Couch", color: "#123abc", type: "sofa", icon: "mdi:sofa" });
  assert.deepStrictEqual(M.zoneInfo(zones[2], { 2: { color: "red", type: "gibtsnicht" } }), { name: "Esstisch", color: M.ZONE_COLORS[2], type: null, icon: null }, "YAML-Label, Palettenfarbe");
  assert.ok(Object.keys(M.ZONE_TYPES).length >= 19 && M.ZONE_TYPES.andere && M.ZONE_TYPES.kochen.label === "Kochbereich");
  assert.strictEqual(M.freeZoneColor(zones, {}), M.ZONE_COLORS[0]);
  assert.strictEqual(M.freeZoneColor(zones, { 1: { color: M.ZONE_COLORS[0] } }), M.ZONE_COLORS[1]);
  ok("Zonen: aktiv = Zellen oder Name in HA, nächster freier Slot, Name/Farbe/Typ mit Rückfall auf YAML/Palette");

  // Stand vorher: Slot 1 belegt (YAML-Name), Slot 2 als „Couch“ benannt. Nachher: Slot 0 neu „Fenster“, Slot 2 gelöscht, Slot 1 umbenannt
  const before = { 2: { name: "Couch" } };
  const after = { 0: { name: "Fenster" }, 1: { name: "Büro" } };
  const zones1 = zones.map((q) => ({ ...q, mask: q.mask.slice() }));
  zones1[0].mask[5] = 1;
  const ch = M.zoneEntityChanges(zones, before, zones1, after);
  assert.deepStrictEqual(ch, [
    { slot: 0, label: "Sofa", from: "Sofa", to: "Fenster", show: true },
    { slot: 1, label: "Schreibtisch", from: "Schreibtisch", to: "Büro", show: undefined },
    { slot: 2, label: "Esstisch", from: "Couch", to: "Esstisch", show: false },
  ]);
  assert.deepStrictEqual(M.zoneEntityChanges(zones, {}, zones, {}), []);
  const reg = [
    { entity_id: "binary_sensor.fp2_sofa_belegt", platform: "esphome", device_id: "D1", original_name: "Sofa belegt" },
    { entity_id: "sensor.fp2_sofa_personen", platform: "esphome", device_id: "D1", original_name: "Sofa Personen" },
    { entity_id: "binary_sensor.fp2_esstisch_belegt", platform: "esphome", device_id: "D1", original_name: "Esstisch belegt" },
    { entity_id: "binary_sensor.fp2_schreibtisch_belegt", platform: "esphome", device_id: "D1", original_name: "Schreibtisch belegt", name: "Alt" },
    { entity_id: "binary_sensor.anderer_sofa_belegt", platform: "esphome", device_id: "D2", original_name: "Sofa belegt" },
    { entity_id: "binary_sensor.mqtt_sofa", platform: "mqtt", device_id: "D1", original_name: "Sofa belegt" },
    { entity_id: "sensor.fp2_sofa_x", platform: "esphome", device_id: "D1", original_name: "Sofa belegt x" },
  ];
  assert.deepStrictEqual(M.zoneEntityUpdates(reg, "D1", ch), [
    { entity_id: "binary_sensor.fp2_sofa_belegt", name: "Fenster belegt", hidden_by: null },
    { entity_id: "sensor.fp2_sofa_personen", name: "Fenster Personen", hidden_by: null },
    { entity_id: "binary_sensor.fp2_schreibtisch_belegt", name: "Büro belegt" },
    { entity_id: "binary_sensor.fp2_esstisch_belegt", name: null, hidden_by: "user" },
  ]);
  assert.deepStrictEqual(M.zoneEntityUpdates(reg, null, ch), []);
  assert.deepStrictEqual(M.zoneEntityUpdates({}, "D1", ch), []);
  ok("zoneEntityChanges/zoneEntityUpdates: nur esphome-Entitäten des Geräts nach original_name, null = YAML-Name, hidden_by beim Anlegen/Löschen");
}

// --- Rechteck-Werkzeug ---
{
  assert.strictEqual(M.cellClamp(-1000, -50), 0);
  assert.strictEqual(M.cellClamp(5000, 5000), 319);
  assert.strictEqual(M.cellClamp(10, 120), M.cellOf(10, 120));
  const m = M.maskRect(M.maskNew(), idx(5, 9), idx(3, 7), 1);
  assert.deepStrictEqual(cellsOf(m), [idx(3, 7), idx(3, 8), idx(3, 9), idx(4, 7), idx(4, 8), idx(4, 9), idx(5, 7), idx(5, 8), idx(5, 9)]);
  M.maskRect(m, idx(4, 8), idx(4, 8), 0);
  assert.strictEqual(M.maskCount(m), 8);
  ok("cellClamp/maskRect: Rechteck rastet auf Zellen ein, beliebige Ziehrichtung, auf den Rand geklemmt");
}

// --- Möbel ---
{
  const types = Object.keys(M.FURNITURE);
  assert.ok(types.length >= 16, "mindestens 16 Typen: " + types.length);
  for (const t of ["tuer", "vorhang", "sofa", "tv", "herd", "tisch", "stuhl", "pflanze", "bett", "schrank", "badewanne", "toilette", "schreibtisch", "tischlampe", "stehleuchte", "deckenlampe"])
    assert.ok(M.FURNITURE[t], "Aqara-Typ " + t);
  assert.deepStrictEqual([M.FURNITURE.sofa.w, M.FURNITURE.sofa.h], [200, 90]);
  assert.deepStrictEqual(M.furnitureNew("sofa", 400.04, 300), { type: "sofa", x: 400, y: 300, w: 200, h: 90, rot: 0 }, "Rastermodus: 1 Einheit = 1 cm");
  assert.deepStrictEqual(M.furnitureNew("bett", 10, 20, 0.5), { type: "bett", x: 10, y: 20, w: 80, h: 100, rot: 0 }, "Grundriss: cm × px/cm");
  assert.strictEqual(M.furnitureNew("rakete", 0, 0), null);
  for (const t of types) {
    const svg = M.furnitureShape(t, M.FURNITURE[t].w, M.FURNITURE[t].h);
    assert.ok(svg.length > 20 && !/NaN|undefined|Infinity/.test(svg), t + ": " + svg);
  }
  ok("Möbel: ≥ 16 Typen (Aqara-Aufkleber), Standardgrößen in cm, Maßstab, Symbole ohne NaN");

  const raw = [
    { type: "sofa", x: 100.04, y: "50", w: 200, h: 90, rot: -15 },
    { type: "rakete", x: 0, y: 0, w: 1, h: 1, rot: 0 },
    { type: "tisch", x: NaN, y: 0, w: 10, h: 10 },
    { type: "stuhl", x: 1, y: 2, w: 0, h: 10 },
    { type: "pflanze", x: -30, y: -1200, w: 40, h: 40 },
    null, "x",
    { type: "bett", x: 5, y: 6, w: 160, h: 200, rot: 735, extra: 1 },
  ];
  const clean = M.furnitureClean(raw);
  assert.deepStrictEqual(clean, [
    { type: "sofa", x: 100, y: 50, w: 200, h: 90, rot: 345 },
    { type: "pflanze", x: -30, y: -1200, w: 40, h: 40, rot: 0 },
    { type: "bett", x: 5, y: 6, w: 160, h: 200, rot: 15 },
  ], "außerhalb des Rasters erlaubt, rot 0..359, unbekannte/ungültige weg");
  assert.deepStrictEqual(M.furnitureClean(JSON.parse(JSON.stringify(clean))), clean, "JSON-Roundtrip");
  assert.deepStrictEqual(M.furnitureClean("kaputt"), []);
  assert.strictEqual(M.furnitureClean(Array.from({ length: 60 }, () => ({ type: "stuhl", x: 0, y: 0, w: 45, h: 45 }))).length, 40, "höchstens 40");
  ok("furnitureClean: Speicherform {type,x,y,w,h,rot}, Rundung, Drehung normiert, Grenze 40");

  const f = { type: "sofa", x: 100, y: 100, w: 200, h: 90, rot: 90 };
  assert.strictEqual(M.furnitureAt([f], 100, 190), 0, "gedreht: 90 cm nach unten liegt noch drin");
  assert.strictEqual(M.furnitureAt([f], 190, 100), -1, "gedreht: 90 cm zur Seite nicht mehr");
  assert.strictEqual(M.furnitureAt([f, { ...f, rot: 0 }], 100, 100), 1, "oberstes zuerst");
  const c = M.furnitureCorner(f);
  near(c[0], 55, 1e-9); near(c[1], 200, 1e-9);
  const l = M.furnitureLocal(f, ...M.furnitureWorld(f, 30, -20));
  near(l[0], 30, 1e-9); near(l[1], -20, 1e-9);
  for (const rot of [0, 30, 135, 270]) {
    const g = { ...f, rot };
    const fixed = M.furnitureWorld(g, -g.w / 2, -g.h / 2);
    const target = M.furnitureWorld(g, 60, 80);   // Ecke nach außen ziehen
    const r = M.furnitureResize(g, target[0], target[1]);
    near(r.w, 160, 0.11); near(r.h, 125, 0.11);
    const fixed2 = M.furnitureWorld(r, -r.w / 2, -r.h / 2);
    near(fixed2[0], fixed[0], 0.2); near(fixed2[1], fixed[1], 0.2);
    assert.strictEqual(r.rot, rot);
  }
  const tiny = M.furnitureResize({ ...f, rot: 0 }, f.x - 500, f.y - 500, 10);
  assert.ok(tiny.w === 10 && tiny.h === 10, "Mindestgröße");
  let q = { ...f, rot: 0 };
  for (let k = 0; k < 24; k++) q = M.furnitureRotate(q);
  assert.strictEqual(q.rot, 0);
  assert.strictEqual(M.furnitureRotate({ ...f, rot: 350 }).rot, 5);
  ok("Möbel: Treffer mit Drehung, Eckgriff hält die Gegenecke fest, Drehen in 15°-Schritten");
}

// --- Karte im vm mit DOM-Attrappen: HA-Speicher, Störquellen, Messen, Editor ---
const fs = require("fs");
const vm = require("vm");
const SRC = fs.readFileSync(__dirname + "/../card/fp2-room-card.js", "utf8");
const FULL = "F".repeat(80), ZERO = "0".repeat(80);
const layoutJson = (over = {}) => ({ version: 2, calibrated: true, grid: { cols: 16, rows: 20, cell: 50, x0: -400, y0: 0 }, room: { hold: 5, mask: FULL }, excl: ZERO, zones: [], filter: { on: 3, window: 10 }, ...over });
const enc = (ts) => {
  const b = Buffer.alloc(1 + 14 * ts.length);
  b[0] = ts.length;
  ts.forEach((t, i) => { const o = 1 + i * 14; b[o] = t.id; b.writeInt16BE(t.x, o + 1); b.writeInt16BE(t.y, o + 3); b.writeInt16BE(t.v || 0, o + 7); });
  return b.toString("base64");
};
const plain = (o) => JSON.parse(JSON.stringify(o));   // Objekte aus dem vm vergleichbar machen
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Karte im vm laden; ha: { store, getStore, getLayout, setLayout } als async-Funktionen bzw. Werte */
async function mkCard(ha) {
  const clock = { t: 1e6 };
  const fields = {};
  // fields.svgFactory: liefert bei jedem Neuaufbau ein frisches <svg id="plan"> (Attrappe mit Ereignissen)
  let html = "";
  const root = {
    get innerHTML() { return html; }, set innerHTML(v) { html = v; fields.svg = null; },
    getElementById: (id) => (id === "plan" && fields.svgFactory ? fields.svg || (fields.svg = fields.svgFactory()) : null),
    querySelectorAll: () => [], querySelector: (s) => fields[s] || null,
  };
  class HTMLElement { attachShadow() { this.shadowRoot = root; return root; } }
  class FakeDate extends Date { static now() { return clock.t; } }
  let Card = null;
  const ctx = {
    window: { customCards: [] }, HTMLElement, customElements: { define: (nm, c) => { if (nm === "fp2-room-card") Card = c; }, get: () => undefined },
    console: { info() {}, log: console.log, warn: console.warn, error: console.error }, setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {},
    Date: FakeDate, atob: (s) => Buffer.from(s, "base64").toString("binary"), confirm: () => true, module: { exports: {} },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const c = new Card();
  c.setConfig({ devices: [{ device: "fp2_wz", targets: "sensor.t" }], ...(ha.config || {}) });
  const calls = [], toasts = [];
  c._toast = (m) => toasts.push(m);
  const states = { "sensor.t": { state: enc([]), last_updated: "0" } };
  let k = 0;
  const hass = {
    user: { is_admin: ha.admin ?? true }, states,
    callWS: async (m) => {
      calls.push(m);
      if (m.type === "frontend/get_system_data") return ha.getStore ? ha.getStore() : { value: ha.store ?? null };
      if (ha.ws) { const r = await ha.ws(m); if (r !== undefined) return r; }
      return {};
    },
    callService: async (dom, svc, data) => {
      calls.push({ svc, data });
      if (svc.endsWith("_get_layout")) return { response: ha.getLayout ? await ha.getLayout() : layoutJson() };
      if (svc.endsWith("_set_layout")) return { response: ha.setLayout ? await ha.setLayout(data) : { ok: true } };
      return {};
    },
  };
  c.hass = hass;
  for (let i = 0; i < 5; i++) await tick();
  const report = (ts) => { states["sensor.t"] = { state: enc(ts), last_updated: String(++k) }; c.hass = hass; };
  const advance = (ms) => { for (let t = 0; t < ms; t += 250) { clock.t += 250; c._onTick(); } };
  return { c, calls, toasts, clock, fields, report, advance, states, writes: () => calls.filter((m) => m.type === "frontend/set_system_data") };
}

const FLOORPLAN = { kind: "walls", width: 1000, height: 800, d: "M0 0L10 0L10 10Z", openings: [] };

(async () => {
  // HA-Speicher nicht lesbar: nichts schreiben, Fehler zeigen, „Neu laden“ holt den echten Store
  {
    let fail = true;
    const stored = { version: 3, floorplan: FLOORPLAN, devices: {} };
    const h = await mkCard({ getStore: () => { if (fail) throw new Error("Verbindung unterbrochen"); return { value: stored }; } });
    assert.strictEqual(h.c._storeError, "Verbindung unterbrochen");
    assert.match(h.c._setupHtml(), /konnte nicht gelesen werden: Verbindung unterbrochen.*data-act="reload"/s);
    assert.match(h.c._liveHtml(), /konnte nicht gelesen werden/);
    await h.c._setMirror("fp2_wz", true);
    assert.strictEqual(h.writes().length, 0, "kein Überschreiben mit leerem Store");
    assert.match(h.toasts.pop(), /Nicht gespeichert/);
    fail = false;
    await h.c._reload();
    assert.strictEqual(h.c._storeError, null);
    await h.c._setMirror("fp2_wz", true);
    assert.strictEqual(h.writes().length, 1);
    assert.deepStrictEqual(h.writes()[0].value.floorplan, FLOORPLAN, "Grundriss bleibt erhalten");
    // fehlender Schlüssel (value null) ist kein Lesefehler
    const h2 = await mkCard({ store: null });
    assert.strictEqual(h2.c._storeError, null);
    await h2.c._setMirror("fp2_wz", true);
    assert.strictEqual(h2.writes().length, 1);
    ok("Karte: HA-Speicher nicht lesbar -> Hinweis, kein Speichern, „Neu laden“; fehlender Schlüssel speichert normal");
  }

  // Störquellen lernen: ortsfester Geist, HA meldet keine neue Meldung (bitgleicher Frame)
  {
    const h = await mkCard({});
    h.report([{ id: 1, x: 50, y: 250 }]);
    h.c._startInterf("fp2_wz");
    h.c._interfAction("i-start");
    h.advance(20000);
    assert.strictEqual(h.c._interf.phase, "run");
    h.advance(120000);
    const s = h.c._interf;
    assert.strictEqual(s.phase, "result");
    assert.ok(s.reports >= 150 && s.reports <= 162, "Wiederholung alle 0,75 s: " + s.reports);
    assert.deepStrictEqual(cellsOf(s.proposal), [M.cellOf(50, 250)]);
    // neue Meldungen zählen sofort und nur einmal
    const h3 = await mkCard({});
    h3.c._startInterf("fp2_wz");
    h3.c._interfAction("i-start");
    h3.advance(20000);
    for (let i = 0; i < 4; i++) { h3.report([{ id: 2, x: -100, y: 100 + i }]); h3.c._onHassUpdate(); h3.c._onHassUpdate(); }
    assert.strictEqual(h3.c._interf.reports, 4);
    ok("Karte: Störquellen lernen zählt unveränderte HA-Zustände alle 0,75 s als Meldung (Geist wird vorgeschlagen)");
  }

  // Ausrichten: Person geht hin und steht bitgleich, Geist springt -> gemessen wird die Person
  {
    const h = await mkCard({ store: { version: 3, floorplan: FLOORPLAN, devices: {} } });
    h.c._startAlign("fp2_wz");
    const a = h.c._align;
    a.pos = [500, 0]; a.dir = [500, 500]; a.step = 3;
    h.c._alignRecalc();
    const ghost = (j) => ({ id: 1, x: j % 2 ? 125 : 115, y: j % 2 ? 253 : 262 });
    for (let i = 0; i <= 5; i++) { h.report([{ id: 0, x: -150 + i * 36, y: 320 - i * 20, v: 20 }, ghost(0)]); h.advance(750); }   // Schritte à 41 cm
    h.report([{ id: 0, x: 30, y: 220, v: 9 }, ghost(0)]);
    h.c._alignAction("a-measure");   // gerade angekommen: läuft noch
    assert.strictEqual(a.measure, null);
    assert.match(h.toasts.pop(), /^Ziel 0 bewegt sich noch/);
    for (let j = 1; j <= 6; j++) { h.report([{ id: 0, x: 30, y: 220, v: j }, ghost(j)]); h.advance(1500); }   // Person steht, nur v ändert sich
    h.advance(3000);   // HA meldet nichts Neues
    assert.ok(h.c._align.track.ids[1].movedAt > h.c._align.track.ids[0].movedAt, "Geist zuletzt bewegt");
    h.c._alignAction("a-measure");
    assert.strictEqual(a.measure.id, 0, "Person statt Geist");
    h.advance(2750);
    assert.deepStrictEqual(Array.from(a.raw || []), [30, 220], h.toasts.join(" | "));
    assert.strictEqual(a.rawId, 0);
    // nur Geister: keine Messung
    const g = await mkCard({ store: { version: 3, floorplan: FLOORPLAN, devices: {} } });
    g.c._startAlign("fp2_wz");
    Object.assign(g.c._align, { pos: [500, 0], dir: [500, 500], step: 3 });
    for (let j = 0; j < 30; j++) { g.report([ghost(j), { id: 2, x: 60, y: 260 }]); g.advance(750); }
    g.c._alignAction("a-measure");
    assert.strictEqual(g.c._align.measure, null);
    assert.match(g.toasts.pop(), /Kein Ziel ist in den letzten 30 s mindestens 1 m gegangen/);
    ok("Karte: Messen wählt die hergegangene Person, nicht den springenden Geist; still und bitgleich wird angenommen");
  }

  // Editor: angeglichene/geklemmte Werte stehen in den Feldern, Doppelklick sendet einmal, Neuladen-Fehler eigene Meldung
  {
    let getFail = false, sets = 0;
    const h = await mkCard({
      getLayout: async () => { if (getFail) throw new Error("Zeitüberschreitung"); return layoutJson(); },
      setLayout: async () => { sets++; await tick(); return { ok: true }; },
    });
    h.c._startEdit("fp2_wz");
    const win = { value: "10" }, on = { value: "3" };
    h.fields['[data-act="e-f-win"]'] = win;
    h.fields['[data-act="e-f-on"]'] = on;
    on.value = "12";
    h.c._editAction("e-f-on", on);
    assert.deepStrictEqual({ ...h.c._drafts.fp2_wz.filter }, { on: 12, window: 12 });
    assert.strictEqual(win.value, "12", "Fenster-Feld zeigt den angeglichenen Wert");
    win.value = "4";
    h.c._editAction("e-f-win", win);
    assert.strictEqual(on.value, "4");
    const hold = { value: "5000", dataset: {} };
    h.c._editAction("e-room-hold", hold);
    assert.strictEqual(hold.value, "3600");
    await Promise.all([h.c._saveEdit(), h.c._saveEdit()]);
    assert.strictEqual(sets, 1, "Doppelklick sendet nur einmal");
    assert.ok(h.calls.some((m) => m.svc === "fp2_wz_set_layout" && /\nF 4 4$/.test(m.data.layout)));
    getFail = true;
    h.c._edit.dirty = true;
    await h.c._saveEdit();
    assert.match(h.toasts.pop(), /^Auf dem ESP gespeichert, Neuladen fehlgeschlagen: Zeitüberschreitung/);
    assert.strictEqual(h.c._edit.dirty, false);
    getFail = false;
    await h.c._reload();
    assert.ok(!h.c._layouts.fp2_wz.error, "„Neu laden“ holt das Layout");
    ok("Karte: Editor-Felder zeigen geklemmte Werte, Doppelklick sendet einmal, Neuladen-Fehler mit eigener Meldung");
  }

  // Live: Frage nach dem Dienst nur, wenn der Aufruf selbst fehlschlug
  {
    const v1 = await mkCard({ getLayout: async () => ({ version: 1, calibrated: true }) });
    assert.match(v1.c._liveHtml(), /Layout-Version 1/);
    assert.doesNotMatch(v1.c._liveHtml(), /vorhanden\?/);
    const none = await mkCard({ getLayout: async () => { throw new Error("Dienst nicht gefunden"); } });
    assert.match(none.c._liveHtml(), /Dienst nicht gefunden\. Ist <code>esphome\.fp2_wz_get_layout<\/code> vorhanden\?/);
    ok("Karte: Live-Hinweis auf get_layout nur bei fehlgeschlagenem Dienstaufruf");
  }

  // Zonen anlegen, umbenennen, löschen: ESP, HA-Speicher und Entitäten
  {
    const zonesJson = Array.from({ length: 32 }, (_, i) => ({ slot: i, label: ["Sofa", "Schreibtisch", "Esstisch"][i] || `Zone ${i + 1}`, hold: 5, mask: ZERO }));
    zonesJson[1].mask = "0".repeat(16) + "0F00" + "0".repeat(60);   // Schreibtisch: Zeile 4, Spalten 4–7
    let espText = null;
    const REG = [
      { entity_id: "sensor.t", platform: "esphome", device_id: "DEV", original_name: "Targets" },
      { entity_id: "binary_sensor.wz_sofa_belegt", platform: "esphome", device_id: "DEV", original_name: "Sofa belegt" },
      { entity_id: "sensor.wz_sofa_personen", platform: "esphome", device_id: "DEV", original_name: "Sofa Personen" },
      { entity_id: "binary_sensor.wz_schreibtisch_belegt", platform: "esphome", device_id: "DEV", original_name: "Schreibtisch belegt" },
      { entity_id: "binary_sensor.anderes_sofa_belegt", platform: "esphome", device_id: "OTHER", original_name: "Sofa belegt" },
    ];
    let regFail = false;
    const ws = async (m) => {
      if (m.type === "config/entity_registry/list") { if (regFail) throw new Error("nicht erlaubt"); return REG; }
      if (m.type === "config/entity_registry/update") return { entity_entry: {} };
      return undefined;
    };
    const h = await mkCard({
      ws,
      getLayout: async () => layoutJson({ zones: espText ? zonesJson.map((z) => { const p = M.parseLayoutText(espText, zonesJson.map((q) => q.slot)); const zz = p.zones[z.slot]; return { ...z, hold: zz ? zz.hold : 5, mask: zz ? M.maskToHex(zz.mask) : ZERO }; }) : zonesJson }),
      setLayout: async (d) => { espText = d.layout; return { ok: true }; },
    });
    const c = h.c;
    c._startEdit("fp2_wz");
    let e = c._edit;
    assert.deepStrictEqual(c._editZones(c._drafts.fp2_wz).map((z) => z.slot), [1], "nur aktive Zonen (Slot 1 hat Zellen)");
    assert.match(c._editHtml(), /Zone hinzufügen/);
    assert.doesNotMatch(c._editHtml(), /value="Esstisch"/, "unbenutzter Slot erscheint nicht");
    c._editAction("e-zone-add");
    assert.strictEqual(e.adding, true);
    assert.match(c._editHtml(), /id="e-new-name"/);
    h.fields["#e-new-name"] = { value: "  " };
    h.fields["#e-new-type"] = { value: "tv" };
    c._editAction("e-zone-add-ok");
    assert.deepStrictEqual({ ...e.zmeta[0] }, { name: "TV-Bereich", color: M.ZONE_COLORS[0], type: "tv" }, "freier Slot 0, Name aus dem Typ, freie Farbe");
    assert.strictEqual(e.tool, "z0");
    assert.strictEqual(e.shape, "rect", "neue Zone: Rechteck ziehen");
    assert.strictEqual(e.adding, false);
    // Typ ändern übernimmt den Standardnamen, eigener Name bleibt
    c._editAction("e-zone-type", { value: "sofa", dataset: { slot: "0" } });
    assert.strictEqual(e.zmeta[0].name, "Sofa-Bereich");
    c._editAction("e-zone-name", { value: "Couch", dataset: { slot: "0" } });
    c._editAction("e-zone-type", { value: "bett", dataset: { slot: "0" } });
    assert.deepStrictEqual([e.zmeta[0].name, e.zmeta[0].type], ["Couch", "bett"]);
    c._editAction("e-zone-color", { dataset: { slot: "0" } });
    assert.strictEqual(e.zmeta[0].color, M.ZONE_COLORS[1]);
    // nächste Zone bekommt Slot 2 (0 benannt, 1 belegt)
    h.fields["#e-new-name"] = { value: "Lesen" };
    h.fields["#e-new-type"] = { value: "" };
    c._editAction("e-zone-add-ok");
    assert.ok(e.zmeta[2] && e.zmeta[2].name === "Lesen" && !e.zmeta[2].type);
    delete e.zmeta[2];
    // Rechteck malen (wie _bindPaint) und Slot 1 umbenennen
    M.maskRect(c._drafts.fp2_wz.zones[0].mask, 2 * 16 + 2, 3 * 16 + 4, 1);
    e.dirty = true;
    c._editAction("e-zone-name", { value: "Büro", dataset: { slot: "1" } });
    assert.match(c._editHtml(), /value="Couch"/);
    await c._saveEdit();
    assert.match(espText, /\nZ 0 5 /, "Zone 0 auf dem ESP");
    const w = h.writes().pop().value;
    assert.deepStrictEqual(plain(w.devices.fp2_wz.zones), { 0: { name: "Couch", color: M.ZONE_COLORS[1], type: "bett" }, 1: { name: "Büro" } });
    const ups = h.calls.filter((m) => m.type === "config/entity_registry/update");
    assert.deepStrictEqual(plain(ups), [
      { type: "config/entity_registry/update", entity_id: "binary_sensor.wz_sofa_belegt", name: "Couch belegt", hidden_by: null },
      { type: "config/entity_registry/update", entity_id: "sensor.wz_sofa_personen", name: "Couch Personen", hidden_by: null },
      { type: "config/entity_registry/update", entity_id: "binary_sensor.wz_schreibtisch_belegt", name: "Büro belegt" },
    ]);
    assert.match(h.toasts.pop(), /^Auf dem ESP gespeichert · In HA gespeichert · 3 Entitäten angepasst$/);
    assert.strictEqual(e.metaDirty, false);
    // Live: Chips mit Namen/Farben, nur aktive Zonen; Status in Kompaktform
    c._close();
    c._close();
    assert.strictEqual(c._view, "live");
    const st = M.parseZoneState('{"c":1,"r":[1,2],"z":"00000001","n":"20000000000000000000000000000000"}');
    const chips = c._chips(c._config.devices[0], "#03a9f4", c._layouts.fp2_wz, st).join("");
    assert.match(chips, /stat on" style="--c:#[0-9a-f]+"><span class="dot"><\/span><ha-icon class="z-ico" icon="mdi:bed"><\/ha-icon>Couch<span class="num-s">2<\/span>/);
    assert.match(chips, /Büro/);
    assert.doesNotMatch(chips, /Esstisch|Zone 4/);
    assert.match(c._layoutSvg(c._layouts.fp2_wz, M.alignDefault(), "#03a9f4", st, c._zmeta("fp2_wz")), /fill="#e91e63" fill-opacity="0.4".*>Couch ●<\/text>/s);
    assert.doesNotMatch(c._layoutSvg(c._layouts.fp2_wz, M.alignDefault(), "#03a9f4", st, {}), /class="edge"/, "ganzer Raster-Raum: keine Kante");
    const part = M.cloneLayout(c._layouts.fp2_wz);
    part.room.mask = maskOf([[0, 0], [0, 1]]);
    assert.match(c._layoutSvg(part, M.alignDefault(), "#03a9f4", null, {}), /^<path d="M100 0L800 0L800 50L100 50ZM0 50L800 50[^"]*" class="edge"/, "Kante = Zellen außerhalb des Raums");
    // Löschen: Zellen weg, Name weg, Entitäten zurückbenannt und ausgeblendet
    c._startEdit("fp2_wz");
    e = c._edit;
    assert.deepStrictEqual(c._editZones(c._drafts.fp2_wz).map((z) => z.slot), [0, 1]);
    const nUp = h.calls.length;
    c._editAction("e-zone-del", { dataset: { slot: "0" } });
    assert.ok(!e.zmeta[0] && e.dirty && e.metaDirty && e.tool === "room");
    await c._saveEdit();
    assert.doesNotMatch(espText, /\nZ 0 /, "leerer Slot fällt aus dem Text");
    assert.deepStrictEqual(plain(h.writes().pop().value.devices.fp2_wz.zones), { 1: { name: "Büro" } });
    assert.deepStrictEqual(h.calls.slice(nUp).filter((m) => m.type === "config/entity_registry/update").map((m) => [m.entity_id, m.name, m.hidden_by]),
      [["binary_sensor.wz_sofa_belegt", null, "user"], ["sensor.wz_sofa_personen", null, "user"]]);
    // Registrierung nicht lesbar: nur Hinweis, ESP und HA-Speicher gespeichert
    regFail = true;
    c._editAction("e-zone-name", { value: "Arbeit", dataset: { slot: "1" } });
    await c._saveEdit();
    assert.match(h.toasts.pop(), /^In HA gespeichert · Entitäten nicht umbenannt: Registrierung nicht lesbar \(nicht erlaubt\)$/);
    assert.strictEqual(h.writes().pop().value.devices.fp2_wz.zones[1].name, "Arbeit");
    ok("Karte: Zone hinzufügen (freier Slot, Typ, Farbe), umbenennen, löschen – ESP, HA-Speicher, Entitäten (Name, hidden_by), Chips");

    // kein Admin: keine Registrierungs-Aufrufe
    const na = await mkCard({ ws, admin: false, getLayout: async () => layoutJson({ zones: zonesJson }) });
    na.c._startEdit("fp2_wz");
    na.c._editAction("e-zone-name", { value: "Büro", dataset: { slot: "1" } });
    await na.c._saveEdit();
    assert.ok(!na.calls.some((m) => /entity_registry/.test(m.type || "")), "ohne Admin keine Registrierung");
    // HA-Speicher nicht lesbar: ESP wird trotzdem übertragen, Namen nicht, keine Umbenennung
    let sets = 0;
    const se = await mkCard({ ws, getStore: () => { throw new Error("weg"); }, getLayout: async () => layoutJson({ zones: zonesJson }), setLayout: async () => { sets++; return { ok: true }; } });
    se.c._startEdit("fp2_wz");
    se.c._editAction("e-zone-name", { value: "Büro", dataset: { slot: "1" } });
    se.c._edit.dirty = true;
    await se.c._saveEdit();
    assert.strictEqual(sets, 1, "ESP-Übertragung nicht blockiert");
    assert.strictEqual(se.writes().length, 0);
    assert.ok(!se.calls.some((m) => /entity_registry/.test(m.type || "")));
    assert.match(se.toasts.pop(), /^Auf dem ESP gespeichert – Namen\/Möbel nicht gespeichert: HA-Speicher nicht lesbar/);
    assert.strictEqual(se.c._edit.metaDirty, true, "Entwurf bleibt");
    assert.ok(!(se.c._store.devices.fp2_wz && se.c._store.devices.fp2_wz.zones && se.c._store.devices.fp2_wz.zones[1]), "Speicher im Browser zurückgesetzt");
    ok("Karte: ohne Admin keine Umbenennung; HA-Speicher nicht lesbar -> ESP trotzdem, Namen nicht gespeichert");
  }

  // Möbel: hinzufügen, drehen, löschen, speichern (Raster und Grundriss), Zeichnen unter den Zellen
  {
    const h = await mkCard({ store: { version: 3, floorplan: null, devices: {} } });
    const c = h.c;
    c._startEdit("fp2_wz");
    const e = c._edit;
    assert.strictEqual(e.furnOwner, "fp2_wz");
    c._editAction("e-tool", { dataset: { tool: "furn" } });
    assert.match(c._editHtml(), /data-act="e-furn-add" data-type="vorhang"/);
    c._editAction("e-furn-add", { dataset: { type: "sofa" } });
    assert.deepStrictEqual({ ...e.furn[0] }, { type: "sofa", x: 400, y: 500, w: 200, h: 90, rot: 0 }, "Mitte des Raums (ganzes Raster), Standardgröße in cm");
    c._editAction("e-furn-add", { dataset: { type: "tuer" } });
    c._editAction("e-furn-rot", {});
    assert.strictEqual(e.furn[1].rot, 15);
    c._editAction("e-undo", {});
    assert.strictEqual(e.furn[1].rot, 0, "Rückgängig");
    assert.strictEqual(e.fsel, -1, "Rückgängig hebt die Auswahl auf");
    e.fsel = 1;
    c._editAction("e-furn-del", {});
    assert.ok(e.fsel === -1 && e.furn.length === 1);
    c._editAction("e-undo", {});
    assert.strictEqual(e.furn.length, 2);
    e.furn[1] = { ...e.furn[1], x: 400, y: -40 };   // Tür über der Sensorwand (außerhalb des Rasters)
    assert.match(c._editHtml(), /In HA speichern/);
    await c._saveEdit();
    assert.ok(!h.calls.some((m) => m.svc === "fp2_wz_set_layout"), "nur HA, nicht der ESP");
    assert.deepStrictEqual(plain(h.writes().pop().value.devices.fp2_wz.furniture), [{ type: "sofa", x: 400, y: 500, w: 200, h: 90, rot: 0 }, { type: "tuer", x: 400, y: -40, w: 90, h: 90, rot: 0 }]);
    c._close();
    c._close();
    const live = c._liveHtml();
    assert.ok(live.indexOf('id="furn-layer"><g class="furn" transform="translate(400 500)"') > 0 && live.indexOf("furn-layer") < live.indexOf("shapes-layer"), "Möbel unter den Zellen");
    // Rastermodus mit zwei Geräten: Gerät 2 um 900 verschoben
    const h2 = await mkCard({ store: { version: 3, floorplan: null, devices: { b: { furniture: [{ type: "bett", x: 100, y: 100, w: 160, h: 200, rot: 0 }] } } },
      config: { devices: [{ device: "a", targets: "sensor.t" }, { device: "b", targets: "sensor.t" }] } });
    assert.match(h2.c._liveHtml(), /<g transform="translate\(900 0\)"><g class="furn" transform="translate\(100 100\)"/);
    // Grundriss: Möbel in Plan-Koordinaten, Größe mit dem Maßstab der Ausrichtung; Store-Fehler -> nichts geschrieben
    const al = { pos: [500, 100], ang: Math.PI / 2, scale: 0.5, mirror: false, dir: [500, 400] };
    const h3 = await mkCard({ store: { version: 3, floorplan: FLOORPLAN, furniture: [{ type: "rakete" }], devices: { fp2_wz: { align: al, mirror: false } } } });
    assert.deepStrictEqual(plain(h3.c._store.furniture), [], "kaputte Einträge beim Lesen entfernt");
    h3.c._startEdit("fp2_wz");
    assert.deepStrictEqual([h3.c._edit.furnOwner, h3.c._edit.furnScale], ["plan", 0.5]);
    h3.c._editAction("e-tool", { dataset: { tool: "furn" } });
    h3.c._editAction("e-furn-add", { dataset: { type: "bett" } });
    assert.deepStrictEqual([h3.c._edit.furn[0].w, h3.c._edit.furn[0].h], [80, 100]);
    await h3.c._saveEdit();
    const w3 = h3.writes().pop().value;
    assert.strictEqual(w3.furniture.length, 1);
    assert.ok(!w3.devices.fp2_wz.furniture, "Grundriss-Möbel nicht beim Gerät");
    assert.match(h3.c._setupHtml(), /svg class="thumb walls".*class="furn"/s, "Vorschau in der Einrichtung");
    ok("Karte: Möbel hinzufügen/drehen/löschen/Rückgängig, Speichern in HA (Raster je Gerät, Grundriss), unter den Zellen gezeichnet");
  }

  // Zeiger: Rechteck über Zellen, zwei Finger (Abbruch des Zugs, Zoom), Möbel ziehen und Eckgriffe
  {
    const mkSvg = () => {
      const L = {};
      return {
        L, addEventListener: (t, f) => (L[t] = L[t] || []).push(f), setAttribute(k, v) { this[k] = v; }, setPointerCapture() {},
        getScreenCTM: () => ({ inverse: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) }),   // Bildschirm = Plan
        createSVGPoint: () => ({ x: 0, y: 0, matrixTransform(m) { return { x: m.a * this.x + m.e, y: m.d * this.y + m.f }; } }),
        fire(t, ev) { for (const f of L[t] || []) f({ preventDefault() {}, pointerType: "mouse", pointerId: 1, ...ev }); },
      };
    };
    const zonesJson = Array.from({ length: 32 }, (_, i) => ({ slot: i, label: `Zone ${i + 1}`, hold: 5, mask: ZERO }));
    const h = await mkCard({ getLayout: async () => layoutJson({ zones: zonesJson }) });
    const c = h.c;
    h.fields.svgFactory = mkSvg;
    c._startEdit("fp2_wz");
    const e = c._edit;
    h.fields["#e-new-name"] = { value: "Sofa" };
    c._editAction("e-zone-add-ok");
    assert.strictEqual(e.tool, "z0");
    // Anzeige im Raster = (400 + x, y): Zelle (Zeile 2, Spalte 2) bis (Zeile 5, Spalte 4), Ende über den Rasterrand hinaus geklemmt
    const at = (x, y, o = {}) => ({ clientX: 400 + x, clientY: y, ...o });
    h.fields.svg.fire("pointerdown", at(-275, 125));
    h.fields.svg.fire("pointermove", at(-210, 200));
    h.fields.svg.fire("pointermove", at(-175, 275));
    h.fields.svg.fire("pointerup", at(-175, 275));
    const zm = () => c._drafts.fp2_wz.zones[0].mask;
    const rectCells = [];
    for (let r = 2; r <= 5; r++) for (let cc = 2; cc <= 4; cc++) rectCells.push(idx(r, cc));
    assert.deepStrictEqual(cellsOf(zm()), rectCells, "Rechteck rastet auf Zellen ein");
    h.fields.svg.fire("pointerdown", at(-375, 25));
    h.fields.svg.fire("pointermove", at(-900, -200));
    h.fields.svg.fire("pointerup", at(-900, -200));
    assert.strictEqual(M.maskCount(zm()), 12 + 1, "über den Rand gezogen: nur die Randzelle");
    // zweiter Finger: Zug zurücknehmen, dann Zoom per Spreizen
    const before = zm().slice();
    const nUndo = e.undo.length;
    h.fields.svg.fire("pointerdown", at(100, 100, { pointerType: "touch", pointerId: 7 }));
    h.fields.svg.fire("pointermove", at(150, 300, { pointerType: "touch", pointerId: 7 }));
    assert.notDeepStrictEqual(Array.from(zm()), Array.from(before));
    h.fields.svg.fire("pointerdown", at(300, 100, { pointerType: "touch", pointerId: 8 }));
    assert.deepStrictEqual(Array.from(zm()), Array.from(before), "Zug beim zweiten Finger zurückgenommen");
    assert.strictEqual(e.undo.length, nUndo);
    const svg = h.fields.svg;
    svg.fire("pointermove", at(50, 100, { pointerType: "touch", pointerId: 7 }));
    svg.fire("pointermove", at(350, 100, { pointerType: "touch", pointerId: 8 }));
    // Start: Finger (550,300)/(700,100) -> Abstand 250, Mitte (625,200); Ende (450,100)/(750,100) -> Abstand 300, Mitte (600,100)
    assert.ok(c._zoomVB && Math.abs(c._zoomVB.w - 880 * (250 / 300)) < 0.01, "auseinander = hineinzoomen: " + JSON.stringify(c._zoomVB));
    // Planpunkt unter der Start-Mitte liegt jetzt unter der neuen Mitte (viewBox-Ursprung lag bei Pixel −40/−60)
    near(c._zoomVB.x + (600 + 40) * (250 / 300), 625, 0.1, "x unter der Mitte");
    near(c._zoomVB.y + (100 + 60) * (250 / 300), 200, 0.1, "y unter der Mitte");
    assert.deepStrictEqual(Array.from(zm()), Array.from(before), "während der Geste wird nicht gemalt");
    svg.fire("pointerup", at(50, 100, { pointerType: "touch", pointerId: 7 }));
    svg.fire("pointerup", at(350, 100, { pointerType: "touch", pointerId: 8 }));
    assert.strictEqual(c._gest, null);
    assert.match(c._editHtml(), /Ansicht zurücksetzen/);
    c._editAction("e-zoom-reset", {});
    assert.strictEqual(c._zoomVB, null);
    // Möbel: ziehen, Eckgriff Größe, Griff drehen, Griff löschen
    c._editAction("e-tool", { dataset: { tool: "furn" } });
    c._editAction("e-furn-add", { dataset: { type: "sofa" } });
    const f0 = { ...e.furn[0] };
    h.fields.svg.fire("pointerdown", { clientX: f0.x + 10, clientY: f0.y });
    h.fields.svg.fire("pointermove", { clientX: f0.x + 60, clientY: f0.y + 20 });
    h.fields.svg.fire("pointerup", {});
    assert.deepStrictEqual([e.furn[0].x, e.furn[0].y], [f0.x + 50, f0.y + 20]);
    assert.strictEqual(e.undo[e.undo.length - 1].key, "furn");
    const hd = c._furnHandles(e.furn[0]);
    h.fields.svg.fire("pointerdown", { clientX: hd.size[0], clientY: hd.size[1] });
    h.fields.svg.fire("pointermove", { clientX: hd.size[0] + 20, clientY: hd.size[1] + 10 });
    h.fields.svg.fire("pointerup", {});
    assert.deepStrictEqual([e.furn[0].w, e.furn[0].h], [220, 100], "Eckgriff ohne Sprung");
    const hr = c._furnHandles(e.furn[0]);
    h.fields.svg.fire("pointerdown", { clientX: hr.rot[0], clientY: hr.rot[1] });
    assert.strictEqual(e.furn[0].rot, 15);
    const hx = c._furnHandles(e.furn[0]);
    h.fields.svg.fire("pointerdown", { clientX: hx.del[0], clientY: hx.del[1] });
    assert.strictEqual(e.furn.length, 0);
    assert.ok(!/NaN|undefined/.test(c._editHtml()), "kein NaN/undefined im Editor");
    ok("Karte: Rechteck über Zellen (geklemmt), zwei Finger brechen den Zug ab und zoomen, Möbel ziehen/Größe/Drehen/Löschen");
  }

  // Demo: Zonenstatus in Kompaktform, 32 Slots
  {
    const h = await mkCard({ config: { demo: true, devices: undefined } });
    const st = h.c._espState("demo");
    assert.ok(st && st.r && Object.keys(st.z).length === 32, JSON.stringify(st));
    assert.strictEqual(h.c._layouts.demo.zones.length, 32);
    ok("Demo: 32 Zonen-Slots, Zonenstatus in Kompaktform");
  }

  console.log(`\n${n} Tests bestanden`);
})().catch((e) => { console.error(e); process.exit(1); });
