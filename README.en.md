[Deutsch](README.md) · **English**

# Aqara FP2 local in Home Assistant – with card and editor

Room and zone detection for the **Aqara FP2 running ESPHome firmware** ([hansihe/esphome_fp2](https://github.com/hansihe/esphome_fp2)), without the Aqara cloud.
The evaluation runs **on the ESP**; the Lovelace card is the editor and live view – modelled on the Aqara app (a fixed grid instead of calibration).

| Part | Job |
|---|---|
| `components/fp2_rooms` (ESPHome) | radar targets → grid cell; room, ignore cells and **up to 32 zones** as cell masks; filter "N of M frames" + hold time; stored in flash; HA entities |
| `card/fp2-room-card.js` (Lovelace) | live view; learn the room by walking around; learn interference with the room empty; paint cells; add/rename/delete zones; furniture; optional floor plan with walls, doors and windows |
| Home Assistant | stores card data only (floor plan as vectors, alignment, zone names/colours/types, furniture) via `frontend/set_system_data` |

## Grid

As in the Aqara app: 16 × 20 cells of 50 cm (8 m wide, 10 m deep), sensor at the top centre.
Cell from raw radar coordinates (cm): `col = floor((x + 400) / 50)`, `row = floor(y / 50)`.
The radar firmware reports x/y in cm (int16 = 100 × metres); for corner mounting it rotates the frame itself.

## Entities on the ESP

All names are set in the YAML; the example uses German names and the room "Wohnzimmer" (living room, device `fp2-wohnzimmer`).

- Room: `<room> belegt` (binary_sensor, occupancy) and `<room> Personen` (sensor) – YAML `fp2_rooms: room:`
- per zone slot (0…31): `<zone> belegt`, optionally `<zone> Personen` – YAML `fp2_rooms: zones:`; the card renames them when you add a zone
- `Zonenstatus` (text sensor, published on change only) for the card:
  `{"c":0|1,"r":[on,count],"z":"<8 hex, bit i = slot i>","n":"<32 hex, char i = count of slot i, max. 15>"}`

Also in the example YAML (hardware details in [FINDINGS.md](FINDINGS.md)):

- `Helligkeit` (illuminance, lx) – light sensor TI OPT3001 at I²C 0x44, not calibrated
- `LED` – RGB LED as a dimmable light (GPIO14 red, GPIO26 green, GPIO27 blue, active low)
- `LED Statusanzeige` – error/boot/Wi-Fi/HA connection shown on the LED like Aqara does; off in normal operation
- `Neigung` (tilt), `Einbaulage` (orientation) from the accelerometer and `Sensor bewegt` (sensor moved) – on when the
  orientation changed since the room was last transferred; the button `Lage als Referenz übernehmen` resets the reference

ESPHome entities are static, so the example YAML creates **32 zone slots in advance**.
In the card you add zones freely: it takes the next free slot, renames the HA entities and unhides them;
deleting a zone hides them again.

## Logic on the ESP

1. Every frame of the targets sensor is decoded; each target gets its grid cell.
2. A target counts if its cell belongs to the room and is not marked "ignore". Zones only count counted targets.
3. Room/zone turns **on** when a target was inside in at least N of the last M frames; **off** when none was seen for the hold time.
4. If no frames arrive for > 2 s, empty frames are fed in so states still expire.

Window filter, hold time, exclusion area and idle frames are adopted from [P43YM/ld2450_zones](https://github.com/P43YM/ld2450_zones) (MIT).

## Installation

### 1. ESPHome
Copy `components/fp2_rooms` into your ESPHome folder (or use it via `external_components`) and start from `example/fp2-wohnzimmer.yaml`. Important:

- `api.actions`: `set_layout`, `get_layout`, `clear_layout` – the card calls them as `esphome.<device>_set_layout` etc.
- `global_zone: motion:` **must** be set – aqara_fp2 calls the motion sensor without a null check, otherwise the ESP crashes.
- `on_boot` switches on "Report Targets" after 20 s (aqara_fp2 starts with position reporting off).
- `include_builtin_idf_components: [driver, esp_driver_i2c]` – otherwise `aqara_fp2_accel` does not build with ESPHome 2026.x.
- Set `mounting_position` to your mounting (`wall` | `left_corner` | `right_corner`).
- Create your own `secrets.yaml` (`wifi_ssid`, `wifi_password`, `fallback_hotspot_password`, `ota_password`, `api_encryption_key`).

Flashing the FP2: **[FLASHING.en.md](FLASHING.en.md)** (wiring, ground, backup, pitfalls) and hansihe/esphome_fp2. **Back up the original
firmware completely first** and never use `erase_flash` – the `fctry` partition holds device-specific calibration data.

### 2. Card
Copy `card/fp2-room-card.js` to `/config/www/` and add it as a dashboard resource `/local/fp2-room-card.js` (JavaScript module).

```yaml
type: custom:fp2-room-card
title: Ground floor
devices:
  - device: fp2_wohnzimmer                     # ESPHome name (dashes become _)
    name: Living room
    targets: sensor.fp2_wohnzimmer_targets
    state: sensor.fp2_wohnzimmer_zonenstatus
    mounting: sensor.fp2_wohnzimmer_mounting_position   # optional
    moved: binary_sensor.fp2_wohnzimmer_sensor_bewegt   # optional: "sensor was moved" warning
  # more FP2s possible
# full_grid: true                              # live view: whole 8×10 m grid instead of zooming to the room
```

The card's user interface is in German.

### 3. Recorder
Exclude the targets sensor from the recorder:

```yaml
recorder:
  exclude:
    entities:
      - sensor.fp2_wohnzimmer_targets
```

### Demo mode (without an FP2)
`demo: true` simulates people and a stationary ghost; the layout is then stored in HA instead of on an ESP.

## Usage

1. **Learn room:** start → walk freely through the room for 1–3 min → stop. Only cells where a target moved count; corners you cannot reach are filled in by closing/hole filling.
2. **Learn interference:** leave the room (20 s countdown), 2 min recording. Cells with targets while the room is empty are suggested as "ignore".
3. **Edit:** paint cells for room, ignore and zones (tap/drag) or drag a rectangle; undo; hold times and filter. *Transfer to the ESP*.
4. **Zones:** *add zone* → name, colour, type (sofa area, TV area, dining table, bed, kitchen …). Rename and delete at any time.
5. **Furniture:** place, move, rotate and resize symbols (door, sofa, bed, table, cabinet, plant, lamps …) – display only.
6. Optionally **import a floor plan** (PNG/JPG): walls, doors and windows are detected in the browser and stored as vectors; then **align** the sensor on the plan.

On a phone: one finger draws, two fingers pan/zoom.

## Tests (no hardware)

```bash
g++ -std=c++17 -Wall -Wextra -Icomponents/fp2_rooms test/core_test.cpp -o test/out/core_test && test/out/core_test
node test/card_grid.test.js
node test/card_math.test.js
node test/card_detect.test.js && node test/card_walls.test.js
```

The browser/host tests (`test/e2e_*.py`, `test/host_api_test.py`, `test/host-test.yaml`) date from the corner-calibration version and have **not been ported to the grid yet**.

## Verification status

| Item | Status |
|---|---|
| ESP logic (cells, masks, parser, filter, 32 zones, zone status ≤ 255 characters) | 14 unit tests pass |
| Card (grid, learning, zones, furniture, status format, pointer gestures) | 49 + 10 tests pass in Node, demo smoke test |
| Firmware for ESP32 (esp32-solo1, ESPHome 2026.9.1) | builds – RAM 28 %, flash 50 %; runs on one FP2 (updated via OTA) |
| Radar data format (cm, wall mode: sensor at origin) | derived from the radar firmware and checked against measurements |
| Used on a real FP2 | learn room, furniture, live view and person count; reflection ghosts behind the room edge are not counted |
| Learn interference / zones on a real FP2 | **not yet confirmed** |
| Light sensor, RGB LED, tilt | found or tested on the device – see [FINDINGS.md](FINDINGS.md) |
| Floor plan detection with real estate-agent plans | **not tested** |
| Mounting height | no official Aqara figure found; 1.4–1.8 m is commonly quoted (not verified) |
