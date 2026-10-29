"""Demo-Modus der Karte: kompletter Ablauf ohne FP2. Aufruf: /usr/bin/python3 test/e2e_demo.py (Server :8767 im Repo-Root)"""
import sys, time
from playwright.sync_api import sync_playwright
CORNERS = [[70, 70], [590, 70], [590, 340], [750, 340], [750, 630], [70, 630]]
errors = []
def text(p): return p.evaluate("window.card.shadowRoot.querySelector('.body').innerText")
def btn(p, l): p.locator(f"fp2-room-card .btn:has-text('{l}')").first.click()
def click_plan(p, pt):
    xy = p.evaluate("""(q)=>{const s=window.card.shadowRoot.getElementById('plan');const t=s.createSVGPoint();t.x=q[0];t.y=q[1];const r=t.matrixTransform(s.getScreenCTM());return [r.x,r.y];}""", pt)
    p.mouse.click(*xy)

def drag_plan(page, a, b):
    xy = lambda q: page.evaluate("""(q)=>{const s=window.card.shadowRoot.getElementById('plan');const t=s.createSVGPoint();t.x=q[0];t.y=q[1];const r=t.matrixTransform(s.getScreenCTM());return [r.x,r.y];}""", q)
    (x0, y0), (x1, y1) = xy(a), xy(b)
    page.mouse.move(x0, y0); page.mouse.down()
    for i in range(1, 9): page.mouse.move(x0 + (x1 - x0) * i / 8, y0 + (y1 - y0) * i / 8)
    page.mouse.up()
with sync_playwright() as pw:
    b = pw.chromium.launch(); p = b.new_page(viewport={"width": 1000, "height": 1050})
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.goto("http://127.0.0.1:8767/" + __import__("os").environ.get("DEMO_PAGE", "test/demo.html")); p.wait_for_function("window.card && window.card._loaded")
    btn(p, "Einrichten"); p.locator("fp2-room-card input[type=file]").set_input_files("test/grundriss.png")
    p.wait_for_function("window.card._view === 'crop'"); btn(p, "Ganzes Bild"); btn(p, "Weiter")
    p.wait_for_function("window.card._view === 'walls'"); p.locator("fp2-room-card [data-act='wl-ok']").click()
    p.wait_for_function("window.card.shadowRoot.querySelector('.thumb') !== null")
    btn(p, "Raum anlernen"); btn(p, "Weiter")
    for c in CORNERS: click_plan(p, c)
    print("eingerastete Ecken:", p.evaluate("window.card._wiz.corners"))
    btn(p, "Weiter (6 Ecken)")
    click_plan(p, [80, 80]); click_plan(p, [330, 350]); btn(p, "Weiter")
    p.wait_for_function("window.card._wiz && window.card._wiz.step === 'result'", timeout=90000)
    res = p.evaluate("window.card._wiz.result.res.map(r=>r.rel)"); print("Eck-Abweichung max %.2f %%" % (max(res)*100))
    btn(p, "Auf den ESP übertragen"); p.wait_for_function("window.card._view === 'setup'")
    btn(p, "Zonen & Sperrflächen"); p.locator("fp2-room-card [data-act='e-draw-zone'][data-slot='0']").click()
    drag_plan(p, [110, 420], [330, 520])
    btn(p, "Form übernehmen"); btn(p, "+ Sperrfläche"); drag_plan(p, [690, 565], [735, 615])
    btn(p, "Form übernehmen"); btn(p, "Auf den ESP übertragen"); time.sleep(0.5); btn(p, "Abbrechen"); btn(p, "Fertig")
    L = p.evaluate("window.card._layouts.demo"); assert abs(L["sensor"]["pos"][0] - 80) < 3 and abs(L["sensor"]["pos"][1] - 80) < 3 and len(L["excl"]) == 1 and len(L["excl"][0]) == 4 and len(L["zones"][0]["pts"]) == 4, L
    time.sleep(4); p.locator("fp2-room-card").screenshot(path="test/out/demo_live.png")
    t = text(p); print(t.replace("\n", " | ")); assert "Personen" in t or "Demo-Raum" in t
    p.reload(); p.wait_for_function("window.card && window.card._loaded"); time.sleep(0.5)
    b.close()
print("JS-Fehler:", errors) if errors else print("Demo-E2E bestanden")
sys.exit(1 if errors else 0)
