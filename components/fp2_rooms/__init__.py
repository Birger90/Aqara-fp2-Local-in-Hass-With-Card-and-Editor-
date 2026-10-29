"""fp2_rooms – Raum-/Zonenauswertung für den Aqara FP2 (ESPHome-Firmware hansihe/esphome_fp2).

Liest den Text-Sensor "Targets" der Komponente aqara_fp2 und ordnet die Radar-Rohkoordinaten
einem festen Raster zu (16 x 20 Zellen à 50 cm, Sensor oben mittig – wie in der Aqara-App, ohne
Einmessen). Raum, Ignorier-Zellen (Störquellen) und bis zu 32 Zonen sind Zellmasken; daraus
entstehen Anwesenheit und Personenzahl. Das Layout wird in der Lovelace-Karte fp2-room-card
angelernt bzw. gemalt und per API-Aktion auf den ESP übertragen (Flash-Speicherung).
"""

import esphome.codegen as cg
from esphome.components import binary_sensor, sensor, text_sensor
import esphome.config_validation as cv
from esphome.const import (
    CONF_COUNT,
    CONF_ID,
    DEVICE_CLASS_OCCUPANCY,
    ENTITY_CATEGORY_DIAGNOSTIC,
    STATE_CLASS_MEASUREMENT,
)

AUTO_LOAD = ["binary_sensor", "sensor", "text_sensor", "json"]
CODEOWNERS = []

fp2_rooms_ns = cg.esphome_ns.namespace("fp2_rooms")
FP2Rooms = fp2_rooms_ns.class_("FP2Rooms", cg.Component)

CONF_TARGETS = "targets"
CONF_ROOM = "room"
CONF_ZONES = "zones"
CONF_SLOT = "slot"
CONF_LABEL = "label"
CONF_STATE = "state"
CONF_PRESENCE = "presence"
MAX_ZONES = 32  # wie MAX_ZONES in fp2_rooms_core.h

COUNT_SCHEMA = sensor.sensor_schema(
    accuracy_decimals=0,
    state_class=STATE_CLASS_MEASUREMENT,
    icon="mdi:account-multiple",
)
PRESENCE_SCHEMA = binary_sensor.binary_sensor_schema(device_class=DEVICE_CLASS_OCCUPANCY)

ZONE_SCHEMA = cv.Schema(
    {
        cv.Required(CONF_SLOT): cv.int_range(min=0, max=MAX_ZONES - 1),
        cv.Required(CONF_LABEL): cv.string_strict,
        cv.Optional(CONF_PRESENCE): PRESENCE_SCHEMA,
        cv.Optional(CONF_COUNT): COUNT_SCHEMA,
    }
)


def _unique_slots(zones):
    slots = [z[CONF_SLOT] for z in zones]
    if len(slots) != len(set(slots)):
        raise cv.Invalid("Jeder Zonen-Slot darf nur einmal vorkommen")
    return zones


CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(): cv.declare_id(FP2Rooms),
        cv.Required(CONF_TARGETS): cv.use_id(text_sensor.TextSensor),
        cv.Optional(CONF_ROOM, default={}): cv.Schema(
            {
                cv.Optional(CONF_PRESENCE): PRESENCE_SCHEMA,
                cv.Optional(CONF_COUNT): COUNT_SCHEMA,
            }
        ),
        cv.Optional(CONF_ZONES, default=[]): cv.All(
            cv.ensure_list(ZONE_SCHEMA), cv.Length(max=MAX_ZONES), _unique_slots
        ),
        cv.Optional(CONF_STATE): text_sensor.text_sensor_schema(
            entity_category=ENTITY_CATEGORY_DIAGNOSTIC, icon="mdi:floor-plan"
        ),
    }
).extend(cv.COMPONENT_SCHEMA)


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)

    src = await cg.get_variable(config[CONF_TARGETS])
    cg.add(var.set_source(src))

    room = config[CONF_ROOM]
    if CONF_PRESENCE in room:
        cg.add(var.set_room_presence(await binary_sensor.new_binary_sensor(room[CONF_PRESENCE])))
    if CONF_COUNT in room:
        cg.add(var.set_room_count(await sensor.new_sensor(room[CONF_COUNT])))

    for z in config[CONF_ZONES]:
        pres = await binary_sensor.new_binary_sensor(z[CONF_PRESENCE]) if CONF_PRESENCE in z else cg.nullptr
        cnt = await sensor.new_sensor(z[CONF_COUNT]) if CONF_COUNT in z else cg.nullptr
        cg.add(var.add_zone(z[CONF_SLOT], z[CONF_LABEL], pres, cnt))

    if CONF_STATE in config:
        cg.add(var.set_state_sensor(await text_sensor.new_text_sensor(config[CONF_STATE])))
