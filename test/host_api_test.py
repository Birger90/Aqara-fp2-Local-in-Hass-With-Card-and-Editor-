"""Integrationstest: echter ESPHome-Host-Build von fp2_rooms, angesprochen über die native API (wie HA)."""
import asyncio, json, os, subprocess, sys, time
from aioesphomeapi import APIClient

PROG = ".esphome/build/fp2-host-test/.pioenvs/fp2-host-test/program"
PREFS = os.path.expanduser("~/.esphome/prefs/fp2-host-test.prefs")

# Wahre Abbildung Radar-Roh -> Plan (für Simulation); Karte würde sie einmessen
H = [0.62, 0.05, 330.0, -0.04, 0.58, 20.0, 0.00008, -0.00005, 1.0]


def inv3(m):
    a, b, c, d, e, f, g, h, i = m
    A, B, C = e * i - f * h, -(d * i - f * g), d * h - e * g
    det = a * A + b * B + c * C
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
            B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
            C / det, -(a * h - b * g) / det, (a * e - b * d) / det]


HI = inv3(H)


def to_raw(p):
    x, y = p
    w = HI[6] * x + HI[7] * y + HI[8]
    return round((HI[0] * x + HI[1] * y + HI[2]) / w), round((HI[3] * x + HI[4] * y + HI[5]) / w)


LAYOUT = "\n".join([
    "v1",
    "H " + " ".join(str(v) for v in H),
    "R 2 70,70 590,70 590,340 750,340 750,630 70,630",       # L-Wohnzimmer, Haltezeit 2 s
    "Z 0 3 110,420 330,420 330,520 110,520",                  # Sofa, 3 s
    "Z 1 2 380,180 500,180 500,300 380,300",                  # Schreibtisch, 2 s
    "X 680,560 740,560 740,620 680,620",                      # Ventilator in der Ecke
    "F 3 10",
])

fails = []


def check(cond, msg):
    print(("  ✓ " if cond else "  ✗ ") + msg)
    if not cond:
        fails.append(msg)


async def run():
    proc = subprocess.Popen([PROG], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    await asyncio.sleep(1.5)
    cli = APIClient("127.0.0.1", 6053, None)
    await cli.connect(login=True)
    ents, svcs = await cli.list_entities_services()
    names = {e.key: e.name for e in ents}
    svc = {s.name: s for s in svcs}
    print("Entitäten:", sorted(names.values()))
    print("Aktionen:", sorted(svc))
    states = {}
    cli.subscribe_states(lambda s: states.__setitem__(names.get(s.key, s.key), s.state))

    async def call(name, data, resp=False):
        r = await cli.execute_service(svc[name], data, return_response=True if resp else None)
        if r is None:
            return None
        return json.loads(r.response_data) if r.response_data else {"success": r.success, "error": r.error_message}

    async def sim(points_plan):
        raw = ";".join("%d,%d" % to_raw(p) for p in points_plan)
        await call("sim_targets", {"pts": raw})

    await asyncio.sleep(0.5)
    print("1. ohne Einmessung")
    check(states.get("Zonenstatus", "").startswith('{"c":0'), "Zonenstatus meldet c=0: " + states.get("Zonenstatus", ""))
    r = await call("get_layout", {}, True)
    check(r["calibrated"] is False, "get_layout: calibrated = false")

    print("2. fehlerhafte Layouts")
    r = await call("set_layout", {"layout": "v1\nH 1 2 3\n"}, True)
    check(r["ok"] is False and "Homographie" in r["error"], "Fehler gemeldet: " + r["error"])
    r = await call("set_layout", {"layout": "v1\nH 1 0 0 0 1 0 0 0 1\nZ 5 3 0,0 1,0 1,1\n"}, True)
    check(r["ok"] is False and "Slot 5" in r["error"], "nicht angelegter Slot abgelehnt: " + r["error"])

    print("3. gültiges Layout")
    r = await call("set_layout", {"layout": LAYOUT}, True)
    check(r["ok"] is True, "Layout angenommen " + str(r))
    await asyncio.sleep(0.3)
    check(states.get("Raum belegt") is False, "Raum frei")

    print("4. Person auf dem Sofa")
    await sim([(220, 470)])
    await asyncio.sleep(0.12)
    check(states.get("Raum belegt") is False, "nach 1–2 Frames noch nicht belegt (Filter 3 von 10)")
    await asyncio.sleep(1.2)
    check(states.get("Raum belegt") is True and states.get("Sofa belegt") is True, "Raum + Sofa belegt")
    check(states.get("Schreibtisch belegt") is False, "Schreibtisch frei")
    check(states.get("Raum Personen") == 1 and states.get("Sofa Personen") == 1, "Anzahl 1")
    print("    Zonenstatus:", states.get("Zonenstatus"))

    print("5. zweite Person am Schreibtisch, dritte in der Küche (außerhalb)")
    await sim([(220, 470), (440, 240), (880, 160)])
    await asyncio.sleep(1.6)
    check(states.get("Schreibtisch belegt") is True, "Schreibtisch belegt")
    check(states.get("Raum Personen") == 2, "Raum zählt 2 (Küche nicht): %s" % states.get("Raum Personen"))

    print("6. Kurzer Aussetzer (still sitzende Person verschwindet 0,6 s)")
    await sim([(220, 470)])
    await asyncio.sleep(1.2)
    await sim([])
    await asyncio.sleep(0.6)
    check(states.get("Sofa belegt") is True and states.get("Raum belegt") is True, "bleibt belegt (Haltezeit)")
    await sim([(220, 470)])
    await asyncio.sleep(0.5)

    print("7. Nur Ventilator (Sperrfläche)")
    await sim([(710, 590)])
    await asyncio.sleep(3.8)
    check(states.get("Raum belegt") is False, "Ziel in Sperrfläche zählt nicht -> Raum nach Haltezeit frei")
    check(states.get("Sofa belegt") is False, "Sofa nach 3 s Haltezeit frei")
    r = await call("get_layout", {}, True)
    check(r["diag"]["seen"] == 1 and r["diag"]["counted"] == 0, "Diagnose: gesehen 1, gezählt 0")

    print("8. Radar verstummt (keine Frames mehr) bei belegtem Raum")
    await sim([(300, 300)])
    await asyncio.sleep(1.2)
    check(states.get("Raum belegt") is True, "belegt")
    await call("sim_stop", {})
    await asyncio.sleep(1.5)
    check(states.get("Raum belegt") is True, "1,5 s ohne Frames: noch belegt")
    await asyncio.sleep(3.2)
    check(states.get("Raum belegt") is False, "nach 2 s Stille + 2 s Haltezeit frei (leere Frames eingespeist)")
    r = await call("get_layout", {}, True)
    check(r["diag"]["ms_since_frame"] > 3000, "Diagnose ms_since_frame = %d" % r["diag"]["ms_since_frame"])
    await sim([(300, 300)])
    await asyncio.sleep(0.5)

    print("9. get_layout Inhalt")
    r = await call("get_layout", {}, True)
    check(r["calibrated"] and len(r["h"]) == 9 and abs(r["h"][2] - 330) < 1e-3, "Homographie zurückgelesen")
    check(len(r["room"]["pts"]) == 6 and r["room"]["hold"] == 2, "Raum-Umriss 6 Ecken")
    check([z["label"] for z in r["zones"]] == ["Sofa", "Schreibtisch"] and len(r["zones"][0]["pts"]) == 4, "Zonen mit Labels")
    check(len(r["excl"]) == 1 and r["filter"] == {"on": 3, "window": 10}, "Sperrfläche + Filter")
    check(r["diag"]["fps"] > 0 and r["diag"]["frames"] > 50, "Diagnose fps %.1f, frames %d" % (r["diag"]["fps"], r["diag"]["frames"]))
    await cli.disconnect()
    proc.terminate()
    proc.wait()
    return proc


async def run_restart():
    print("10. Neustart: Einmessung aus Flash")
    proc = subprocess.Popen([PROG], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    await asyncio.sleep(1.5)
    cli = APIClient("127.0.0.1", 6053, None)
    await cli.connect(login=True)
    _, svcs = await cli.list_entities_services()
    svc = {s.name: s for s in svcs}
    r = await cli.execute_service(svc["get_layout"], {}, return_response=True)
    d = json.loads(r.response_data)
    check(d["calibrated"] and len(d["room"]["pts"]) == 6, "nach Neustart eingemessen")
    await cli.execute_service(svc["clear_layout"], {})
    await asyncio.sleep(0.3)
    r = await cli.execute_service(svc["get_layout"], {}, return_response=True)
    check(json.loads(r.response_data)["calibrated"] is False, "clear_layout löscht")
    await cli.disconnect()
    proc.terminate()
    out = proc.communicate()[0]
    print("\n--- Log (Auszug) ---")
    print("\n".join(l for l in out.splitlines() if "fp2_rooms" in l)[-1500:])


if os.path.exists(PREFS):
    os.remove(PREFS)
asyncio.run(run())
asyncio.run(run_restart())
print("\nFEHLER:" if fails else "\nAlle Prüfungen bestanden", fails if fails else "")
sys.exit(1 if fails else 0)
