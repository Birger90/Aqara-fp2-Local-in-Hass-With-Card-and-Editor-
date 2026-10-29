"""Wände aus Grundriss übernehmen (Browser): Erkennung gegen Wahrheitsmaske, Regler, Werkzeuge,
Speichern als Wandkarte, Einrasten der Raumecken.
Aufruf: /usr/bin/python3 test/e2e_walls.py   (Server :8767 im Repo-Root, Pläne aus test/walls/make_plans.py)"""
import base64, json, sys
from PIL import Image
from playwright.sync_api import sync_playwright

errors, fails = [], []
def check(c, m):
    print(("  ✓ " if c else "  ✗ ") + m)
    if not c: fails.append(m)
def btn(p, l): p.locator(f"fp2-room-card .btn:has-text('{l}')").first.click()
def xy(p, q): return p.evaluate("""(q)=>{const s=window.card.shadowRoot.getElementById('plan');const t=s.createSVGPoint();t.x=q[0];t.y=q[1];const r=t.matrixTransform(s.getScreenCTM());return [r.x,r.y];}""", q)
def drag(p, a, b):
    (x0, y0), (x1, y1) = xy(p, a), xy(p, b)
    p.mouse.move(x0, y0); p.mouse.down()
    for i in range(1, 7): p.mouse.move(x0 + (x1 - x0) * i / 6, y0 + (y1 - y0) * i / 6)
    p.mouse.up()
def slider(p, key, v):
    p.evaluate("""([k, v]) => { const el = window.card.shadowRoot.querySelector(`[data-act="wl-${k}"]`); el.value = v; el.dispatchEvent(new Event('input')); }""", [key, v])
    p.wait_for_timeout(400)

def iou(p, name):
    """Maske der Karte gegen Wahrheitsmaske (Vollbild, auf Planraster des Ausschnitts gebracht)"""
    st = p.evaluate("""() => { const W = window.card._walls, c = window.card._crop;
        let s = ''; const m = W.result.mask; for (let i = 0; i < m.length; i += 8192) s += String.fromCharCode(...m.subarray(i, i + 8192));
        return { w: W.w, h: W.h, rect: c.rect, mask: btoa(s) }; }""")
    w, h = st["w"], st["h"]
    mask = base64.b64decode(st["mask"])
    t = Image.open(f"test/walls/{name}_truth.png").crop(tuple(st["rect"])).resize((w, h), Image.BOX).point(lambda v: 255 if v >= 128 else 0).tobytes()
    tp = sum(1 for a, b in zip(mask, t) if a and b); fp = sum(1 for a, b in zip(mask, t) if a and not b); fn = sum(1 for a, b in zip(mask, t) if b and not a)
    return tp / (tp + fp + fn)

def open_plan(b, name):
    p = b.new_page(viewport={"width": 1100, "height": 1000})
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.on("console", lambda m: m.type == "error" and errors.append(m.text))
    p.goto("http://127.0.0.1:8767/" + __import__("os").environ.get("DEMO_PAGE", "test/demo.html")); p.wait_for_function("window.card && window.card._loaded")
    btn(p, "Einrichten")
    p.locator("fp2-room-card input[type=file]").set_input_files(f"test/walls/{name}.png")
    p.wait_for_function("window.card._view === 'crop'")
    btn(p, "Weiter")
    p.wait_for_function("window.card._view === 'walls'")
    return p

with sync_playwright() as pw:
    b = pw.chromium.launch()
    print("1. Gefüllte Wände, automatische Einstellungen")
    p = open_plan(b, "gefuellt")
    v = iou(p, "gefuellt"); par = p.evaluate("window.card._walls.result.params")
    check(v >= 0.9, f"IoU {v:.3f} mit Auto-Einstellungen {par}")
    p.locator("fp2-room-card").screenshot(path="test/out/walls_01_auto.png")
    a0 = p.evaluate("window.card._walls.result.area")
    print("2. Werkzeuge")
    p.locator("fp2-room-card [data-act='wl-tool'][data-tool='erase']").click()
    W = p.evaluate("[window.card._walls.w, window.card._walls.h]")
    drag(p, [W[0] * 0.3, 0], [W[0] * 0.45, W[1] * 0.15])           # Stück der oberen Außenwand radieren
    a1 = p.evaluate("window.card._walls.result.area")
    check(a1 < a0, f"Radieren: Fläche {a0} → {a1}")
    p.locator("fp2-room-card [data-act='wl-tool'][data-tool='add']").click()
    drag(p, [W[0] * 0.5, W[1] * 0.5], [W[0] * 0.6, W[1] * 0.52])
    a2 = p.evaluate("window.card._walls.result.area")
    check(a2 > a1, f"Wand ergänzen: Fläche {a1} → {a2}")
    p.locator("fp2-room-card").screenshot(path="test/out/walls_02_tools.png")
    btn(p, "Rückgängig"); btn(p, "Rückgängig")
    a3 = p.evaluate("window.card._walls.result.area")
    check(a3 == a0, f"2× Rückgängig: Fläche wieder {a3}")
    p.locator("fp2-room-card [data-act='wl-tool'][data-tool='part']").click()
    parts0 = p.evaluate("window.card._walls.result.parts")
    vx = p.evaluate("(() => { const W = window.card._walls, m = W.result.mask; for (let i = 0; i < m.length; i++) if (m[i]) return [i % W.w + 0.5, Math.floor(i / W.w) + 0.5]; })()")
    x, y = xy(p, vx); p.mouse.click(x, y); p.wait_for_timeout(200)
    parts1 = p.evaluate("window.card._walls.result.parts")
    check(parts1 == parts0 - 1, f"Teil entfernen: {parts0} → {parts1} Teile")
    btn(p, "Rückgängig")
    slider(p, "thickness", 30)
    check(p.evaluate("window.card._walls.result.area") == 0 and p.locator("fp2-room-card [data-act='wl-ok']").is_disabled(),
          "Regler Wandstärke 30 px: keine Wand, Übernehmen gesperrt")
    slider(p, "thickness", par["thickness"])
    print("2b. Türen und Fenster")
    ops = p.evaluate("window.card._walls.openings")
    nd = sum(1 for o in ops if o["type"] == "door"); nw = sum(1 for o in ops if o["type"] == "window")
    check(nd == 2 and nw == 3, f"erkannt: {nd} Türen, {nw} Fenster (erwartet 2/3)")
    check(p.evaluate("window.card.shadowRoot.querySelectorAll('#wl-open .win').length") == 3 and p.evaluate("window.card.shadowRoot.querySelectorAll('#wl-open .door.arc').length") == 2, "Türen/Fenster gezeichnet")
    door = next(o for o in ops if o["type"] == "door"); dc = [(door["r"][0] + door["r"][2]) / 2, (door["r"][1] + door["r"][3]) / 2]
    win = next(o for o in ops if o["type"] == "window"); wc = [(win["r"][0] + win["r"][2]) / 2, (win["r"][1] + win["r"][3]) / 2]
    p.locator("fp2-room-card [data-act='wl-tool'][data-tool='door']").click()
    x, y = xy(p, dc); p.mouse.click(x, y); p.wait_for_timeout(150)
    d2 = p.evaluate("(c) => window.card._walls.openings[FP2Math.openingAt(window.card._walls.openings, c, 6)]", dc)
    check((d2["hinge"], d2["swing"]) != (door["hinge"], door["swing"]), f"Tür antippen dreht Anschlag/Aufschlag: {door['hinge']}/{door['swing']} → {d2['hinge']}/{d2['swing']}")
    x, y = xy(p, wc); p.mouse.click(x, y); p.wait_for_timeout(150)
    check(p.evaluate("(c) => window.card._walls.openings[FP2Math.openingAt(window.card._walls.openings, c, 6)].type", wc) == "door", "Fenster mit Tür-Werkzeug antippen → Tür")
    p.locator("fp2-room-card [data-act='wl-tool'][data-tool='window']").click()
    x, y = xy(p, wc); p.mouse.click(x, y); p.wait_for_timeout(150)
    check(p.evaluate("(c) => window.card._walls.openings[FP2Math.openingAt(window.card._walls.openings, c, 6)].type", wc) == "window", "… mit Fenster-Werkzeug zurück zum Fenster")
    # neues Fenster in der rechten Außenwand aufziehen
    a_before = p.evaluate("window.card._walls.result.area")
    verts = p.evaluate("window.card._walls.result.vertices")
    xr = max(v[0] for v in verts)
    drag(p, [xr - 18, W[1] * 0.45], [xr + 2, W[1] * 0.55])
    ops2 = p.evaluate("window.card._walls.openings")
    neu = [o for o in ops2 if o["type"] == "window" and o["axis"] == "v" and o["r"][0] > xr - 25]
    check(len(neu) == 1 and p.evaluate("window.card._walls.result.area") < a_before, f"Fenster aufgezogen (senkrecht, Wand darin entfernt): {neu[0]['r'] if neu else None}")
    btn(p, "Rückgängig")
    check(len(p.evaluate("window.card._walls.openings")) == 5 and p.evaluate("window.card._walls.result.area") == a_before, "Rückgängig nimmt Fenster und Radieren zusammen zurück")
    p.locator("fp2-room-card [data-act='wl-tool'][data-tool='part']").click()
    x, y = xy(p, dc); p.mouse.click(x, y); p.wait_for_timeout(150)
    check(len(p.evaluate("window.card._walls.openings")) == 4, "Entfernen-Werkzeug löscht angetippte Tür")
    btn(p, "Rückgängig")
    p.locator("fp2-room-card").screenshot(path="test/out/walls_02b_openings.png")

    print("3. Speichern als Wandkarte, Anzeige, Einrasten")
    p.locator("fp2-room-card [data-act='wl-ok']").click()
    p.wait_for_function("window.card._view === 'setup'")
    fp = p.evaluate("window.card._store.floorplan")
    stored = p.evaluate("JSON.stringify(window.sysdata || {})") if p.evaluate("typeof window.sysdata") != "undefined" else ""
    check(fp["kind"] == "walls" and fp["d"].startswith("M") and "url" not in fp, f"Store: Wandkarte {fp['width']}×{fp['height']}, {len(fp['d'])} Zeichen, kein Bild")
    check(len(fp["openings"]) == 5 and all(set(o) >= {"type", "r", "axis"} for o in fp["openings"]), f"Store: {len(fp['openings'])} Türen/Fenster")
    check(p.evaluate("window.lastUpload || null") is None, "kein Bild-Upload an HA")
    check(p.evaluate("!!window.card.shadowRoot.querySelector('svg.thumb.walls path.wall')"), "Vorschau in der Einrichtung")
    p.locator("fp2-room-card").screenshot(path="test/out/walls_03_setup.png")
    btn(p, "Raum anlernen")
    p.wait_for_function("window.card._wiz.step === 'meta'"); btn(p, "Weiter")
    verts = p.evaluate("FP2Math.pathVertices(window.card._store.floorplan.d)")
    tx, ty = min(verts, key=lambda q: abs(q[0] - 60) + abs(q[1] - 60))     # Ecke oben links (innen/außen)
    x, y = xy(p, [tx + 7, ty + 6]); p.mouse.click(x, y)
    c = p.evaluate("window.card._wiz.corners[0]")
    check([round(c[0]), round(c[1])] in [[round(q[0]), round(q[1])] for q in verts], f"Klick neben Ecke rastet auf Wandecke {c} ein")
    p.locator("fp2-room-card").screenshot(path="test/out/walls_04_corners.png")
    btn(p, "Abbrechen")
    print("3b. Gespeicherte Wandkarte später bearbeiten")
    btn(p, "Bearbeiten")
    p.wait_for_function("window.card._view === 'walls' && window.card._walls.mode === 'existing'")
    same = p.evaluate("window.card._walls.result.d === window.card._store.floorplan.d")
    check(same and len(p.evaluate("window.card._walls.openings")) == 5, "geöffnet: Wände ohne Änderung identisch neu berechnet (gespeicherte Maske → Pfad), 5 Öffnungen")
    p.locator("fp2-room-card [data-act='wl-tool'][data-tool='door']").click()
    door = next(o for o in p.evaluate("window.card._walls.openings") if o["type"] == "door"); dc = [(door["r"][0] + door["r"][2]) / 2, (door["r"][1] + door["r"][3]) / 2]
    x, y = xy(p, dc); p.mouse.click(x, y); p.wait_for_timeout(150)
    p.locator("fp2-room-card [data-act='wl-tool'][data-tool='erase']").click()
    drag(p, [W[0] * 0.3, 0], [W[0] * 0.4, W[1] * 0.12])
    p.locator("fp2-room-card").screenshot(path="test/out/walls_06_edit_existing.png")
    btn(p, "Speichern")
    p.wait_for_function("window.card._view === 'setup'")
    fp2 = p.evaluate("window.card._store.floorplan")
    d_new = next(o for o in fp2["openings"] if o["r"] == door["r"])
    check(fp2["d"] != fp["d"] and len(fp2["openings"]) == 5 and (d_new["hinge"], d_new["swing"]) != (door["hinge"], door["swing"]) and "edited" in fp2,
          "gespeichert: Wand radiert, Tür gedreht, 5 Öffnungen")
    btn(p, "Fertig")
    p.wait_for_function("window.card._view === 'live'")
    p.close()

    print("4. Doppellinige / schraffierte Wände mit Regler „Lücken schließen“, dunkler Hintergrund")
    for name, close, lim in [("doppellinie", 6, 0.85), ("schraffiert", 4, 0.85), ("dunkel", 0, 0.9), ("farbig", 0, 0.9), ("duenn", 0, 0.85)]:
        p = open_plan(b, name)
        if close: slider(p, "close", close)
        v = iou(p, name)
        check(v >= lim, f"{name}: IoU {v:.3f} (Lücken {close}) {p.evaluate('window.card._walls.result.params')}")
        if name in ("doppellinie", "dunkel"): p.locator("fp2-room-card").screenshot(path=f"test/out/walls_05_{name}.png")
        p.close()
    b.close()
if errors: print("JS-Fehler:", errors); fails.append("js")
print("\nFEHLER: %s" % fails if fails else "\nWand-E2E bestanden"); sys.exit(1 if fails else 0)
