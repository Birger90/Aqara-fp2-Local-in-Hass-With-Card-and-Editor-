"""Mini-"Home Assistant" für den End-to-End-Test: verbindet die Karte im Browser mit dem
echten ESPHome-Host-Build (fp2_rooms) über die native API – wie es die ESPHome-Integration tut.

  GET  /bridge/states            -> {entity_id: {state, attributes}}
  POST /bridge/service           {service, data, return_response} -> {response}
  statische Dateien aus dem Repo-Wurzelverzeichnis (Karte, Testseite, Grundriss)

Aufruf: python ha_bridge.py <repo-root>
"""
import asyncio, json, sys
from pathlib import Path
from aiohttp import web
from aioesphomeapi import APIClient, BinarySensorState, SensorState, TextSensorState

ROOT = Path(sys.argv[1]).resolve()
DEVICE = "fp2_host_test"
cli = None
ent_by_key, states, svcs = {}, {}, {}


def slug(name):
    return "".join(c if c.isalnum() else "_" for c in name.lower().replace("ä", "a").replace("ö", "o").replace("ü", "u")).strip("_")


def on_state(s):
    e = ent_by_key.get(s.key)
    if not e:
        return
    if isinstance(s, BinarySensorState):
        v = "on" if s.state else "off"
    elif isinstance(s, SensorState):
        v = "unknown" if s.missing_state else str(int(s.state)) if float(s.state).is_integer() else str(s.state)
    elif isinstance(s, TextSensorState):
        v = "unknown" if s.missing_state else s.state
    else:
        return
    states[e] = {"entity_id": e, "state": v, "attributes": {}}


async def h_states(_):
    return web.json_response(states)


async def h_service(req):
    body = await req.json()
    name = body["service"]
    if not name.startswith(DEVICE + "_"):
        return web.json_response({"error": "unbekannte Aktion " + name}, status=400)
    svc = svcs.get(name[len(DEVICE) + 1:])
    if not svc:
        return web.json_response({"error": "Aktion nicht vorhanden"}, status=400)
    r = await cli.execute_service(svc, body.get("data", {}), return_response=True if body.get("return_response") else None)
    resp = json.loads(r.response_data) if r is not None and r.response_data else None
    return web.json_response({"response": resp})


async def main():
    global cli
    cli = APIClient("127.0.0.1", 6053, None)
    await cli.connect(login=True)
    ents, sv = await cli.list_entities_services()
    for e in ents:
        dom = {"BinarySensorInfo": "binary_sensor"}.get(type(e).__name__, "sensor")
        ent_by_key[e.key] = f"{dom}.{DEVICE}_{slug(e.name)}"
    for s in sv:
        svcs[s.name] = s
    cli.subscribe_states(on_state)
    app = web.Application()
    app.router.add_get("/bridge/states", h_states)
    app.router.add_post("/bridge/service", h_service)
    app.router.add_static("/", ROOT, show_index=True)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", 8766).start()
    print("Bridge läuft, Entitäten:", sorted(ent_by_key.values()), flush=True)
    await asyncio.Event().wait()


asyncio.run(main())
