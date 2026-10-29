"""Erzeugt synthetische Grundrisse mit bekannter Wandfläche (Wahrheitsmaske) für den Test der
Wand-Erkennung.  Aufruf: /usr/bin/python3 test/walls/make_plans.py

Je Plan entstehen in test/walls/:
  <name>.png        Vollbild wie aus einem Exposé
  <name>_truth.png  Wahrheitsmaske im Vollbild (für den Browser-Test)
  <name>.gray       Graustufen des Planausschnitts, längste Seite 1000 px (wie in der Karte)
  <name>.truth      Wahrheitsmaske (1 = Wand) in derselben Auflösung
  <name>.json       {w, h, kind}
"""
import json, math, os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.dirname(os.path.abspath(__file__))
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
W, H = 1600, 1200
X0, Y0, X1, Y1 = 300, 260, 1220, 900          # Außenkante des Gebäudes


def font(sz):
    return ImageFont.truetype(FONT, sz)


def walls_geometry(t_out, t_in):
    """Wandpolygone (Außenkontur) und Öffnungen. Öffnung wie im Datenmodell der Karte:
    {type, r:[x0,y0,x1,y1], axis:'h'|'v', hinge:0|1, swing:1|-1}
    hinge 0 = Anschlag an r[0] (h) bzw. r[1] (v); swing +1 = Tür schlägt nach +y (h) bzw. +x (v) auf."""
    rects = []
    # Außenwände mit Fensterlücken
    rects += [(X0, Y0, 640, Y0 + t_out), (760, Y0, X1, Y0 + t_out)]             # oben, Fenster 640-760
    rects += [(X0, Y1 - t_out, 900, Y1), (1000, Y1 - t_out, X1, Y1)]           # unten, Fenster 900-1000
    rects += [(X0, Y0, X0 + t_out, 500), (X0, 600, X0 + t_out, Y1)]            # links, Fenster 500-600
    rects += [(X1 - t_out, Y0, X1, Y1)]                                        # rechts
    # Innenwände mit Türlücken
    rects += [(860, Y0, 860 + t_in, 470), (860, 560, 860 + t_in, 640)]         # senkrecht, Tür 470-560
    rects += [(860, 640, 1090, 640 + t_in), (1180, 640, X1, 640 + t_in)]       # waagerecht, Badtür 1090-1180
    rects += [(1040, 640 + t_in, 1040 + t_in, Y1)]                             # Bad
    polys = [[(a, b), (c, b), (c, d), (a, d)] for a, b, c, d in rects]
    # Schräge Wand (Erker unten links), Dicke t_in
    ax, ay, bx, by = X0 + t_out, 760, 520, Y1 - t_out
    nx, ny = (by - ay), -(bx - ax)
    n = math.hypot(nx, ny)
    nx, ny = nx / n * t_in, ny / n * t_in
    polys.append([(ax, ay), (bx, by), (bx + nx, by + ny), (ax + nx, ay + ny)])
    openings = [
        {"type": "window", "r": [640, Y0, 760, Y0 + t_out], "axis": "h"},
        {"type": "window", "r": [900, Y1 - t_out, 1000, Y1], "axis": "h"},
        {"type": "window", "r": [X0, 500, X0 + t_out, 600], "axis": "v"},
        {"type": "door", "r": [860, 470, 860 + t_in, 560], "axis": "v", "hinge": 0, "swing": -1},
        {"type": "door", "r": [1090, 640, 1180, 640 + t_in], "axis": "h", "hinge": 0, "swing": 1},
    ]
    return polys, openings


def furniture_and_text(d, col_text=(70, 70, 70), col_furn=(140, 140, 140)):
    d.text((80, 40), "Erdgeschoss – Musterstraße 12, Hannover", fill=(20, 20, 20), font=font(40))
    d.rectangle((1380, 30, 1540, 110), fill=(30, 60, 120))
    d.text((1400, 55), "LOGO", fill=(255, 255, 255), font=font(28))
    d.polygon([(1480, 620), (1450, 700), (1510, 700)], fill=(0, 0, 0))
    d.text((1468, 585), "N", fill=(0, 0, 0), font=font(24))
    for name, (x, y) in {"Wohnen/Essen": (480, 380), "Küche": (980, 400), "Bad": (1100, 760), "Flur": (700, 700)}.items():
        d.text((x, y), name, fill=col_text, font=font(26))
        d.text((x, y + 34), "24,5 m²", fill=col_text, font=font(20))
    d.ellipse((620, 420, 720, 520), outline=col_furn, width=2)                 # Tisch
    d.rectangle((360, 640, 560, 720), outline=col_furn, width=2)               # Sofa
    d.rectangle((1120, 300, 1200, 600), outline=col_furn, width=2)             # Küchenzeile
    for i in range(4):
        d.ellipse((1135, 320 + i * 70, 1185, 370 + i * 70), outline=col_furn, width=2)
    d.rectangle((1070, 820, 1130, 880), outline=col_furn, width=2)             # WC
    # Bemaßung
    d.line((X0, 960, X1, 960), fill=(40, 40, 40), width=1)
    for x in (X0, 860, X1):
        d.line((x - 8, 968, x + 8, 952), fill=(40, 40, 40), width=2)
    d.text((700, 970), "9,20 m", fill=(40, 40, 40), font=font(22))
    d.line((1270, Y0, 1270, Y1), fill=(40, 40, 40), width=1)
    d.text((1285, 560), "6,40", fill=(40, 40, 40), font=font(22))
    d.text((1000, 1060), "Wohnfläche ca. 78 m²\nAlle Angaben ohne Gewähr", fill=(30, 30, 30), font=font(26))


def draw_openings(d, openings, col=(60, 60, 60), w=2):
    for o in openings:
        x0, y0, x1, y1 = o["r"]
        if o["type"] == "window":                       # drei Linien längs der Wand
            for k in (0.2, 0.5, 0.8):
                if o["axis"] == "h":
                    y = y0 + (y1 - y0) * k; d.line((x0, y, x1, y), fill=col, width=1)
                else:
                    x = x0 + (x1 - x0) * k; d.line((x, y0, x, y1), fill=col, width=1)
            continue
        # Tür: Blatt senkrecht zur Wand im offenen Zustand, Viertelkreis bis zur Gegenseite
        if o["axis"] == "h":
            L, c = x1 - x0, (y0 + y1) / 2
            hx = x1 if o["hinge"] else x0
            ox = x0 if o["hinge"] else x1
            ey = c + o["swing"] * L
            d.line((hx, c, hx, ey), fill=col, width=w)
            pts = [(hx + (ox - hx) * math.cos(t), c + o["swing"] * L * math.sin(t)) for t in [i * math.pi / 40 for i in range(21)]]
        else:
            L, c = y1 - y0, (x0 + x1) / 2
            hy = y1 if o["hinge"] else y0
            oy = y0 if o["hinge"] else y1
            ex = c + o["swing"] * L
            d.line((c, hy, ex, hy), fill=col, width=w)
            pts = [(c + o["swing"] * L * math.sin(t), hy + (oy - hy) * math.cos(t)) for t in [i * math.pi / 40 for i in range(21)]]
        d.line(pts, fill=col, width=w)


def make(name, kind):
    bg = (25, 25, 30) if kind == "dunkel" else (255, 255, 255)
    img = Image.new("RGB", (W, H), bg)
    truth = Image.new("L", (W, H), 0)
    d, td = ImageDraw.Draw(img), ImageDraw.Draw(truth)
    t_out, t_in = {"duenn": (6, 4)}.get(kind, (14, 9))
    polys, openings = walls_geometry(t_out, t_in)
    if kind == "farbig":
        d.rectangle((X0, Y0, 860, Y1), fill=(240, 228, 205))       # Parkett
        d.rectangle((860, Y0, X1, 640), fill=(215, 230, 240))      # Fliesen Küche
        d.rectangle((1040, 640, X1, Y1), fill=(205, 235, 225))     # Bad
    wall_col = {"farbig": (70, 70, 70), "dunkel": (225, 225, 225)}.get(kind, (30, 30, 30))
    for p in polys:
        td.polygon(p, fill=1)
        if kind in ("doppellinie", "schraffiert"):
            d.polygon(p, outline=wall_col, width=2)
        else:
            d.polygon(p, fill=wall_col)
    if kind == "schraffiert":
        hatch = Image.new("L", (W, H), 0)
        hd = ImageDraw.Draw(hatch)
        for k in range(-H, W, 7):
            hd.line((k, 0, k + H, H), fill=255, width=1)
        mask = Image.new("L", (W, H), 0)
        md = ImageDraw.Draw(mask)
        for p in polys:
            md.polygon(p, fill=255)
        from PIL import ImageChops
        hm = ImageChops.multiply(hatch, mask)
        img.paste(Image.new("RGB", (W, H), wall_col), (0, 0), hm)
    tcol, fcol = ((200, 200, 200), (150, 150, 150)) if kind == "dunkel" else ((70, 70, 70), (140, 140, 140))
    draw_openings(d, openings, col=(180, 180, 180) if kind == "dunkel" else (60, 60, 60))
    furniture_and_text(d, tcol, fcol)
    img.save(f"{OUT}/{name}.png")
    truth.point(lambda v: 255 if v else 0).save(f"{OUT}/{name}_truth.png")
    # Planausschnitt wie nach dem Zuschneiden: Außenkante + 4 % Rand, längste Seite 1000 px
    m = 0.04 * max(X1 - X0, Y1 - Y0)
    box = (int(X0 - m), int(Y0 - m), int(X1 + m), int(Y1 + m))
    cw, ch = box[2] - box[0], box[3] - box[1]
    s = 1000 / max(cw, ch)
    size = (round(cw * s), round(ch * s))
    g = img.crop(box).convert("L").resize(size, Image.BOX)
    t = truth.crop(box).point(lambda v: 255 if v else 0).resize(size, Image.BOX).point(lambda v: 1 if v >= 128 else 0)
    open(f"{OUT}/{name}.gray", "wb").write(g.tobytes())
    open(f"{OUT}/{name}.truth", "wb").write(t.tobytes())
    ops = []
    for o in openings:                                   # Öffnungen in Plan-Koordinaten des Ausschnitts
        q = dict(o)
        q["r"] = [round((o["r"][0] - box[0]) * s, 1), round((o["r"][1] - box[1]) * s, 1), round((o["r"][2] - box[0]) * s, 1), round((o["r"][3] - box[1]) * s, 1)]
        ops.append(q)
    json.dump({"w": size[0], "h": size[1], "kind": kind, "openings": ops}, open(f"{OUT}/{name}.json", "w"))
    print(name, size)


for k in ("gefuellt", "doppellinie", "schraffiert", "farbig", "dunkel", "duenn"):
    make(k, k)


# Graustufen für den Zuschnitt-Test (test/card_detect.test.js): Vollbild, längste Seite 1000 px
PLANS = os.path.join(os.path.dirname(OUT), "plans")
truth_bbox = json.load(open(f"{PLANS}/truth.json"))
src = {k: f"{PLANS}/{k}.png" for k in ("expose", "rand", "dunkel")}
src.update({"w_" + k: f"{OUT}/{k}.png" for k in ("gefuellt", "doppellinie", "schraffiert", "farbig", "dunkel", "duenn")})
for k, f in src.items():
    im = Image.open(f).convert("L")
    s = 1000 / max(im.size)
    g = im.resize((round(im.size[0] * s), round(im.size[1] * s)), Image.BILINEAR)
    open(f"{PLANS}/{k}.gray", "wb").write(g.tobytes())
    json.dump({"w": g.size[0], "h": g.size[1], "scale": s}, open(f"{PLANS}/{k}.json", "w"))
    if k.startswith("w_"):
        truth_bbox[k] = [X0, Y0, X1, Y1]
json.dump(truth_bbox, open(f"{PLANS}/truth.json", "w"))
print("Zuschnitt-Testdaten:", ", ".join(src))
