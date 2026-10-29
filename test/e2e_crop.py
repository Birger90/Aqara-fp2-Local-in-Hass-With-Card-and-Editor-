"""Grundriss zuschneiden: automatische Erkennung + manueller Rahmen, danach Wandkarte. Aufruf: /usr/bin/python3 test/e2e_crop.py (Server :8767)"""
import json, sys, time
from playwright.sync_api import sync_playwright
truth = json.load(open("test/plans/truth.json"))
errors, fails = [], []
def check(c, m):
    print(("  ✓ " if c else "  ✗ ") + m)
    if not c: fails.append(m)
def btn(p, l): p.locator(f"fp2-room-card .btn:has-text('{l}')").first.click()
def xy(p, q): return p.evaluate("""(q)=>{const s=window.card.shadowRoot.getElementById('plan');const t=s.createSVGPoint();t.x=q[0];t.y=q[1];const r=t.matrixTransform(s.getScreenCTM());return [r.x,r.y];}""", q)
with sync_playwright() as pw:
    b = pw.chromium.launch()
    for name in ["expose", "rand", "dunkel"]:
        p = b.new_page(viewport={"width": 1000, "height": 1000})
        p.on("pageerror", lambda e: errors.append(str(e)))
        p.goto("http://127.0.0.1:8767/test/demo.html"); p.wait_for_function("window.card && window.card._loaded")
        btn(p, "Einrichten")
        p.locator("fp2-room-card input[type=file]").set_input_files(f"test/plans/{name}.png")
        p.wait_for_function("window.card._view === 'crop'")
        r = p.evaluate("window.card._crop.rect"); t = truth[name]
        check(r[0] <= t[0] and r[1] <= t[1] and r[2] >= t[2] and r[3] >= t[3] and t[0] - r[0] < 150 and r[2] - t[2] < 150,
              f"{name}: Rahmen {r} umschließt Wände {t} eng")
        p.locator("fp2-room-card").screenshot(path=f"test/out/crop_{name}.png")
        if name == "expose":
            # manuell neuen Rahmen aufziehen
            (x0, y0), (x1, y1) = xy(p, [200, 200]), xy(p, [1300, 950])
            p.mouse.move(x0, y0); p.mouse.down(); p.mouse.move((x0+x1)/2, (y0+y1)/2); p.mouse.move(x1, y1); p.mouse.up()
            r2 = p.evaluate("window.card._crop.rect")
            check(abs(r2[0] - 200) < 4 and abs(r2[3] - 950) < 4, f"manueller Rahmen {r2}")
            btn(p, "Automatisch"); r3 = p.evaluate("window.card._crop.rect"); check(r3 == r, "Automatisch stellt Erkennung wieder her")
        btn(p, "Weiter")
        p.wait_for_function("window.card._view === 'walls'")
        p.locator("fp2-room-card [data-act='wl-ok']").click()
        p.wait_for_function("window.card.shadowRoot.querySelector('.thumb') !== null")
        fp = p.evaluate("window.card._store.floorplan"); up = p.evaluate("window.lastUpload || null")
        sc = 1000 / max(r[2] - r[0], r[3] - r[1])
        check(fp["kind"] == "walls" and max(fp["width"], fp["height"]) == 1000 and abs(fp["width"] - (r[2] - r[0]) * sc) <= 1 and abs(fp["height"] - (r[3] - r[1]) * sc) <= 1,
              f"{name}: Wandkarte {fp['width']}×{fp['height']}, Pfad {len(fp['d']) // 1024 + 1} KB")
        check(up is None, f"{name}: kein Bild hochgeladen")
        if name == "expose": p.locator("fp2-room-card").screenshot(path="test/out/crop_done.png")
        p.close()
    b.close()
if errors: print("JS-Fehler:", errors); fails.append("js")
print("\nFEHLER" if fails else "\nZuschnitt-E2E bestanden"); sys.exit(1 if fails else 0)
