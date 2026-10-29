"""End-to-End: Karte (Chromium) -> Bridge -> echter fp2_rooms-Host-Build.
Voraussetzung: Host-Programm läuft (Port 6053), ha_bridge.py läuft (Port 8766).
Aufruf: /usr/bin/python3 test/e2e_card_esp.py
"""
import json, sys, time, urllib.request
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8766"
OUT = "test/out/"
# Wahre (unbekannte) Abbildung Radar-Roh -> Grundriss-Pixel; die Karte muss sie einmessen
H_TRUE = [0.62, 0.05, 330.0, -0.04, 0.58, 20.0, 0.00008, -0.00005, 1.0]
CORNERS = [[70, 70], [590, 70], [590, 340], [750, 340], [750, 630], [70, 630]]
SOFA_CLICKS = [[110, 420], [330, 420], [330, 520], [110, 520]]
FAN = [[690, 565], [735, 565], [735, 615], [690, 615]]   # Sperrfläche, wird abgelaufen
errors, fails = [], []


def drag_plan(page, a, b):
    xy = lambda q: page.evaluate("""(q)=>{const s=window.card.shadowRoot.getElementById('plan');const t=s.createSVGPoint();t.x=q[0];t.y=q[1];const r=t.matrixTransform(s.getScreenCTM());return [r.x,r.y];}""", q)
    (x0, y0), (x1, y1) = xy(a), xy(b)
    page.mouse.move(x0, y0); page.mouse.down()
    for i in range(1, 9): page.mouse.move(x0 + (x1 - x0) * i / 8, y0 + (y1 - y0) * i / 8)
    page.mouse.up()

def inv3(m):
    a, b, c, d, e, f, g, h, i = m
    A, B, C = e * i - f * h, -(d * i - f * g), d * h - e * g
    det = a * A + b * B + c * C
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det,
            -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det]


def app(H, p):
    w = H[6] * p[0] + H[7] * p[1] + H[8]
    return (H[0] * p[0] + H[1] * p[1] + H[2]) / w, (H[3] * p[0] + H[4] * p[1] + H[5]) / w


HI = inv3(H_TRUE)


def service(name, data=None, resp=False):
    req = urllib.request.Request(BASE + "/bridge/service", data=json.dumps({"service": "fp2_host_test_" + name, "data": data or {}, "return_response": resp}).encode(), method="POST")
    return json.loads(urllib.request.urlopen(req).read())["response"]


def persons(plan_pts):
    raw = ";".join("%d,%d" % tuple(round(v) for v in app(HI, p)) for p in plan_pts)
    service("sim_targets", {"pts": raw})


def states():
    return json.loads(urllib.request.urlopen(BASE + "/bridge/states").read())


def check(c, msg):
    print(("  ✓ " if c else "  ✗ ") + msg)
    if not c:
        fails.append(msg)


def text(page):
    return page.evaluate("window.card.shadowRoot.querySelector('.body').innerText")


def click_plan(page, p):
    xy = page.evaluate("""(p) => { const svg = window.card.shadowRoot.getElementById('plan');
        const pt = svg.createSVGPoint(); pt.x = p[0]; pt.y = p[1]; const s = pt.matrixTransform(svg.getScreenCTM()); return [s.x, s.y]; }""", p)
    page.mouse.click(xy[0], xy[1])


def btn(page, label):
    page.locator(f"fp2-room-card .btn:has-text('{label}')").first.click()


service("clear_layout")
persons([])
with sync_playwright() as pw:
    b = pw.chromium.launch()
    page = b.new_page(viewport={"width": 1000, "height": 1050})
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))
    page.goto(BASE + "/test/harness.html")
    page.wait_for_function("window.card && window.card._loaded", timeout=10000)

    print("1. Start ohne Einmessung (Layout vom ESP gelesen)")
    check("Noch kein Raum" in text(page), "leere Ansicht")

    print("2. Grundriss + Raum anlernen")
    btn(page, "Einrichten")
    page.locator("fp2-room-card input[type=file]").set_input_files("test/grundriss.png")
    page.wait_for_function("window.card._view === 'crop'", timeout=5000)
    btn(page, "Ganzes Bild"); btn(page, "Weiter")
    page.wait_for_function("window.card._view === 'walls'", timeout=5000)
    page.locator("fp2-room-card [data-act='wl-ok']").click()
    page.wait_for_function("window.card.shadowRoot.querySelector('.thumb') !== null", timeout=5000)
    btn(page, "Raum anlernen")
    persons([[300, 300]])
    time.sleep(0.5)
    check("1 Ziel" in text(page), "Sensorstatus im Assistenten")
    btn(page, "Weiter")
    for c in CORNERS:
        click_plan(page, c)
    snapped = page.evaluate("window.card._wiz.corners")
    verts = page.evaluate("FP2Math.pathVertices(window.card._store.floorplan.d).map(v => v.join(','))")
    check(all(",".join(str(round(v)) for v in c) in verts and abs(c[0] - k[0]) < 26 and abs(c[1] - k[1]) < 26 for c, k in zip(snapped, CORNERS)),
          "Ecken rasten an Wandecken ein: %s" % snapped)
    btn(page, "Weiter (6 Ecken)")
    # Sensor setzen: Position + Blickrichtung, Montage-Prüfung gegen ESP ("wall")
    click_plan(page, [80, 80]); click_plan(page, [330, 350])
    page.locator("fp2-room-card [data-act='w-mount'][data-mount='2']").click()
    check("passt nicht zum ESP" in text(page), "Warnung bei abweichender Montage (Karte Ecke links, ESP Wand)")
    page.locator("fp2-room-card").screenshot(path=OUT + "e2e_01a_sensor.png")
    page.locator("fp2-room-card [data-act='w-mount'][data-mount='1']").click()
    check("passt nicht zum ESP" not in text(page), "keine Warnung bei passender Montage")
    btn(page, "Weiter")
    for i, c in enumerate(snapped):
        persons([c])
        page.wait_for_function(f"(() => {{ const w = window.card._wiz; return w && (w.step === 'result' || w.measured[{i}] != null); }})()", timeout=10000)
        if i == 3:
            page.locator("fp2-room-card").screenshot(path=OUT + "e2e_01_ablaufen.png")
    time.sleep(0.3)
    res = page.evaluate("window.card._wiz.result.res.map(r => r.rel)")
    check(max(res) < 0.02, "Eck-Abweichung max %.2f %%" % (max(res) * 100))
    btn(page, "Auf den ESP übertragen")
    page.wait_for_function("window.card._view === 'setup'", timeout=10000)

    L = service("get_layout", resp=True)
    check(L["calibrated"] and len(L["room"]["pts"]) == 6, "ESP: eingemessen, 6 Ecken")
    check(L["room"]["pts"] == [[float(v) for v in c] for c in snapped] or all(abs(a - b) < 0.01 for p, q in zip(L["room"]["pts"], snapped) for a, b in zip(p, q)), "ESP: Raum-Ecken = eingerastete Wandecken")
    sp = L.get("sensor", {}).get("pos", [0, 0])
    check(L.get("sensor", {}).get("mount") == 1 and abs(sp[0] - 80) < 3 and abs(sp[1] - 80) < 3, "ESP: Sensorposition + Montage gespeichert: %s" % L.get("sensor"))
    err = max(abs(a - b) for p in [(0, 0), (200, 300), (-150, 500)] for a, b in zip(app(L["h"], p), app(H_TRUE, p)))
    check(err < 1.0, "ESP-Homographie entspricht der wahren Abbildung (max. %.2f px)" % err)

    print("3. Zone Sofa zeichnen, Sperrfläche ablaufen")
    btn(page, "Zonen & Sperrflächen")
    page.locator("fp2-room-card [data-act='e-draw-zone'][data-slot='0']").click()
    drag_plan(page, SOFA_CLICKS[0], SOFA_CLICKS[2])          # Zone als Rechteck aufziehen
    page.locator("fp2-room-card").screenshot(path=OUT + "e2e_02a_rechteck.png")
    btn(page, "Form übernehmen")
    page.locator("fp2-room-card [data-act='e-zone-hold'][data-slot='0']").fill("2")
    page.locator("fp2-room-card [data-act='e-zone-hold'][data-slot='0']").dispatch_event("change")
    btn(page, "+ Sperrfläche")
    page.locator("fp2-room-card [data-act='e-mode-points']").click()   # Sperrfläche per Punkte/Ablaufen
    for c in FAN:
        persons([c])
        time.sleep(1.4)
        btn(page, "Punkt an meiner Position")
    page.locator("fp2-room-card").screenshot(path=OUT + "e2e_02_sperrflaeche.png")
    btn(page, "Form übernehmen")
    page.locator("fp2-room-card [data-act='e-room-hold']").fill("2")
    page.locator("fp2-room-card [data-act='e-room-hold']").dispatch_event("change")
    btn(page, "Auf den ESP übertragen")
    time.sleep(1.0)
    L = service("get_layout", resp=True)
    check(len(L["zones"][0]["pts"]) == 4 and L["zones"][0]["hold"] == 2, "ESP: Zone Sofa, Haltezeit 2 s")
    check(len(L["excl"]) == 1 and len(L["excl"][0]) == 4, "ESP: Sperrfläche mit 4 Punkten")
    fx = [p[0] for p in L["excl"][0]]
    check(min(fx) > 680 and max(fx) < 745, "abgelaufene Sperrfläche liegt am Ventilator: x %.0f–%.0f" % (min(fx), max(fx)))
    btn(page, "Abbrechen")
    btn(page, "Fertig")

    print("4. Live: Sofa + Ventilator + Küche")
    persons([[220, 470], [712, 590], [880, 160]])
    time.sleep(2.0)
    persons([[226, 466], [712, 590], [880, 162]])
    time.sleep(1.5)
    st = states()
    check(st["binary_sensor.fp2_host_test_raum_belegt"]["state"] == "on", "ESP: Raum belegt")
    check(st["sensor.fp2_host_test_raum_personen"]["state"] == "1", "ESP: 1 Person (Ventilator + Küche nicht gezählt): " + st["sensor.fp2_host_test_raum_personen"]["state"])
    check(st["binary_sensor.fp2_host_test_sofa_belegt"]["state"] == "on", "ESP: Sofa belegt")
    check(st["binary_sensor.fp2_host_test_schreibtisch_belegt"]["state"] == "off", "ESP: Schreibtisch frei")
    t = text(page)
    check("Sofa" in t and "Wohnzimmer" in t, "Karte zeigt ESP-Status")
    page.locator("fp2-room-card").screenshot(path=OUT + "e2e_03_live.png")

    print("5. Sofa verlassen")
    persons([[450, 250], [712, 590]])
    time.sleep(3.0)
    st = states()
    check(st["binary_sensor.fp2_host_test_sofa_belegt"]["state"] == "off", "ESP: Sofa nach Haltezeit frei")
    check(st["binary_sensor.fp2_host_test_raum_belegt"]["state"] == "on", "ESP: Raum weiter belegt")
    page.locator("fp2-room-card").screenshot(path=OUT + "e2e_04_live2.png")

    print("6. Seite neu laden: alles kommt vom ESP")
    page.reload()
    page.wait_for_function("window.card && window.card._loaded", timeout=10000)
    time.sleep(0.5)
    check("Noch kein Raum" not in text(page), "nach Neuladen eingemessen (vom ESP gelesen)")
    b.close()

if errors:
    print("JS-Fehler:", errors)
    fails.append("JS-Fehler")
print("\nFEHLER: %s" % fails if fails else "\nE2E Karte ↔ ESP bestanden")
sys.exit(1 if fails else 0)
