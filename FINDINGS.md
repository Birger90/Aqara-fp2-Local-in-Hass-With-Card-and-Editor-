[Deutsch](ERKENNTNISSE.md) · **English**

# Findings on the Aqara FP2 under ESPHome

Collected while converting one FP2 (Oct 2026). Every point is marked as **verified** (measured, read in source code or
tested on the device) or **not verified**. Flashing experience is in [FLASHING.en.md](FLASHING.en.md).

## Hardware

| Part | Connection | Status |
|---|---|---|
| ESP32-SOLO-1, 16 MB flash | – | verified (esptool) |
| Radar TI IWR6843AOP | UART TX GPIO19, RX GPIO18, 890,000 baud, reset GPIO13 | verified (hansihe config, running) |
| Accelerometer | I²C 0x27 | verified (scan) |
| **Light sensor TI OPT3001** | **I²C 0x44** | verified: manufacturer ID 0x5449 ("TI"), device ID 0x3001 read out |
| I²C bus | port 0, SDA GPIO33, SCL GPIO32, 400 kHz | verified (aqara_fp2_accel log) |
| GPIO35 | level 1 at rest | read; that it is the OPT3001 interrupt output is **not verified** |
| **RGB LED** | **GPIO14 red, GPIO26 green, GPIO27 blue, all active low** | verified: each pin blinked on the device and colours matched |
| Button | GPIO36, inverted | from hansihe's example |

### Light sensor (OPT3001)
- After power-up it is in shutdown mode (configuration 0xC810) and reads 0. With 0xCC10 (automatic range, 800 ms,
  continuous) it measures. Lux = 0.01 · 2^E · M (datasheet). Verified: values arrive in HA.
- The values are **not calibrated** – the sensor sits behind the housing window.
- A separate `i2c:` block in ESPHome would clash with the I²C driver of `aqara_fp2_accel`; the example YAML therefore
  reads the sensor directly through the IDF driver on port 0.

### Accelerometer
- The radar asks the ESP for the **mounting orientation** and the **tilt angle** (`ANGLE_SENSOR_DATA`, value = 90° − |tilt
  of the Z axis|); `aqara_fp2_accel` answers. Verified in source code (`fp2_component.cpp`).
  What the radar uses the angle for (presumably tilt compensation) is **not verified**.
- It only measures orientation relative to gravity. Rotation about the vertical axis (viewing direction) and sliding are
  not detected. So it gives nothing for room setup, but it does for "sensor was moved" detection
  (example YAML: `Neigung`, `Einbaulage`, `Sensor bewegt`, `Lage als Referenz übernehmen`).
- Our wall-mounted device (about 80 cm high): tilt 66°, orientation `UP_TILT_REV`.

### LED meaning on Aqara
According to an AI summary of the Aqara manual (**not** checked against the original): yellow fast = network mode/boot,
blue fast = connecting to Wi-Fi, blue slow = connecting to the Aqara service, white steady = connection error,
red = device error, off = normal operation. The example YAML mimics this (blue slow = HA not connected).

## Radar data

- Targets sensor (Base64): 1 byte count, 14 bytes per target: id, x, y, z, velocity, snr (int16, big endian),
  classifier, posture, active. Verified (decoder, hansihe).
- **x/y in cm** (int16 = 100 × metres), same scale on both axes. Wall mode: sensor at the origin, y = straight ahead,
  x = sideways. Corner modes are rotated/shifted by the radar firmware itself (45°, ±400 cm). Verified (firmware analysis, measurements).
- `z` and `active` were 0 in all measurements. There is no "ghost" flag.
- Report interval about **0.75 s**. Verified (HA history).
- Field of view about **±60°** (measured −63° … +64°). **Corners on the sensor wall are not visible** – that is why the
  original calibration via four room corners failed, and the card now uses the grid on the Aqara principle.
- After leaving the area at least one empty frame (`AA==`) arrived. Whether the radar sends regularly with no targets is
  **not verified**; `fp2_rooms` feeds in empty frames after > 2 s without frames anyway.

### Frozen tracks
With a weak signal the tracker holds the last position **bit-identical**. Example: one target stayed exactly at
(−14 cm / 377 cm) for a minute while the real person moved. Verified (HA history).
A standing person is also reported bit-identically – so "bit-identical" alone is no ghost filter.

### Reflections (ghosts behind the person)
With one person in the room the radar often reports a **second target 2–2.5 m further back** that follows sideways
(e.g. person x 134 → −88 cm, ghost x 209 → −113 cm). It was always at or beyond the back edge of the room.
Verified (HA history). Cause probably a multipath echo via the back wall or large smooth surfaces – **not verified**.
Consequence: the learned room must end at the real wall; do not paint cells behind it, then the ESP does not count the ghost.

## The Aqara app as a model

- No calibration. Fixed grid of 16 × 20 cells of 50 cm, sensor at the top centre. Room edge by walking freely,
  interference with the room empty, then painting cells. Verified (tests/reviews, app screenshots).
- Up to 30 zones; per zone colour, type (sofa area, TV area, dining table, kitchen, bed … "other") and
  sensitivity high/medium/low. Furniture as "stickers", at most 20, display only. Verified (screenshots).
- Our implementation: 32 zones, up to 40 furniture items; per-zone sensitivity is missing (the ESP has one shared filter).
- Recommended mounting height: no official figure found; 1.4–1.8 m is commonly quoted – **not verified**.

## ESPHome and Home Assistant

- `aqara_fp2` calls the global motion sensor without a null check: without `global_zone: motion:` the ESP crashes on the
  first motion report (LoadProhibited). Verified (crash, source code).
- `aqara_fp2` starts with position reporting off; `on_boot` switches on "Report Targets" after 20 s. Verified.
- `fp2_rooms` needs ESPHome ≥ 2026.9 (preferences with two arguments) and thus Python ≥ 3.12. Verified.
- Text sensors in HA are limited to 255 characters → compact zone status (at most 73 characters with 32 zones).
- ESPHome entities are static → 32 zone slots in advance; the card renames them and hides/unhides them.
- After an OTA update that removed entities, they were gone from HA (observed with the LED test switches).
- Inline dashboard resources (data URI) are limited to about 128 KB; the card is larger. Options: `/local/` or a
  jsDelivr URL of this repo pinned to a commit.
