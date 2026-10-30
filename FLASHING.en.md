[Deutsch](FLASHING.md) · **English**

# Flashing the FP2 – field report and guide

How we backed up an Aqara FP2 (ESP32-SOLO-1, radar TI IWR6843AOP) and flashed it with ESPHome.
It builds on [hansihe/esphome_fp2](https://github.com/hansihe/esphome_fp2) (FLASHING.md with the test point picture)
and adds what we actually needed.

**Our main lesson: a clean ground (GND) and a stable supply.** Without them the connection keeps dropping.

> At your own risk. The device is opened and soldered.

## What you need

- USB-TTL adapter with **3.3 V logic**. We used a Waveshare USB-TTL cable with FTDI FT232RNL (VID:PID 0403:6001),
  switch set to **3V3**. We did **not** connect the adapter's 3.3 V *supply* pin.
- A separate 5 V supply for the FP2. We used a bench supply. Recommendation (not measured): current limit ≥ 1 A,
  because a tight limit makes the voltage dip when the radar and Wi-Fi start.
- Fine soldering iron, thin wires (keep them short), magnifier.
- [esptool](https://github.com/espressif/esptool) (we used 5.3.0) and ESPHome (we used 2026.9.1, needs Python ≥ 3.12).

## Wiring

| FP2 (test point) | Function | Adapter |
|---|---|---|
| TP8 | ESP32 TXD0 | **RXD** |
| TP9 | ESP32 RXD0 | **TXD** |
| TP28 | GPIO0 (boot mode) | to GND for flashing |
| GND (both points) | ground | **GND** – see below |

TX and RX are crossed. We did not need RST; restart by switching the supply off and on.

### GND – the decisive point

Our first backup attempts kept failing: first messages like *"serial noise or corruption"* or
*"chip stopped responding"*, then *"No serial data received"*. Almost every third 64 KB chunk needed a retry.

- A **loopback test** (TXD↔RXD bridged on the adapter, random data at 57,600 to 921,600 baud: 0 errors) ruled out the
  adapter, cable, driver and USB.
- We then connected **both GND points from hansihe's picture** to ground and checked the bench supply.
  From then on the backup ran for several MB without a single error or retry.
- Later single dropouts mostly happened right after power-up or when cables were moved.

Our advice: **connect adapter GND, supply GND and both FP2 GND points together**, soldered rather than just pressed on,
short wires, and **touch nothing** while reading/writing. Whether the ground or the supply made the difference could
not be separated – both together helped.

Check the solder joints on TP8/TP9 with a magnifier: shiny and flowed is good, dull/balled is suspect.
If RX/TX are swapped you get **no** connection at all; intermittent dropouts point to ground, supply or solder joints.

## Download mode

1. Supply off.
2. Connect GPIO0 (TP28) to GND.
3. Supply on. The ESP32 starts in the ROM bootloader.

For us it was more stable to **keep GPIO0 on GND for the whole backup or write**.
Download mode lives in ROM – an abort halfway is harmless, you can always start again.

## 1. Back up the original firmware (mandatory)

The flash is 16 MB. The **`fctry` partition (0x833000, 24 KB) holds device-specific radar calibration data**.
It exists only on this one device. **Never use `erase-flash`.**

With an unstable link this worked: low baud rate (57,600), load the stub once and then read in 64 KB chunks without
reset, each chunk with retries. esptool checks every chunk by MD5.

```bash
# the calibration data first, on its own
esptool --port COM24 --baud 57600 --before no-reset --after no-reset-stub --connect-attempts 0 read-flash 0x833000 0x6000 fctry_0x833000.bin
# then the rest; on dropouts read in chunks (e.g. 64 KB) and join them
esptool --port COM24 --baud 57600 --before no-reset --after no-reset-stub read-flash 0x0 0x1000000 aqara_fp2_original.bin
```

`--before no-reset --after no-reset-stub` keeps the loaded stub running, so further calls continue reading without a new
boot. Flash layout on our device:

| Range | Content |
|---|---|
| 0x0–0x20000 | bootloader, partition table, nvs, otadata, phy_init |
| 0x20000 / 0x220000 | aqara_fw1 / aqara_fw2 (2 MB each) |
| 0x420000 | test |
| 0x433000 | mcu_ota (4 MB, partly filled on ours) |
| **0x833000** | **fctry – calibration data** |
| from 0x839000 | outside any partition, empty (FF) on ours |

`nvs` contains Wi-Fi credentials and keys of the Aqara firmware – do not publish the backup.
Read `fctry` twice and compare; note SHA256 checksums of the files.

Restore (download mode):

```bash
esptool --port COM24 write-flash 0x0 aqara_fp2_original.bin
esptool --port COM24 write-flash 0x833000 fctry_0x833000.bin   # calibration data only
```

## 2. Build ESPHome

Start from `example/fp2-wohnzimmer.yaml` and create `secrets.yaml`. Pitfalls, mostly on Windows:

- Write the **Wi-Fi name exactly** – it is case-sensitive. The ESP32 only does **2.4 GHz**.
  "No networks found" in the log only means *this* network was not found (the scan is filtered by SSID),
  not that the antenna is broken.
- ESP-IDF refuses Git Bash/MSYS → build from PowerShell.
- Spaces in the project path → set `esphome: build_path:` to a path without spaces
  (see `example/fp2-wohnzimmer-windows.yaml`).
- Paths too long (MAX_PATH) → set the environment variable `ESPHOME_ESP_IDF_PREFIX` to a short path.
- `global_zone: motion:` must be set, otherwise the ESP crashes on the first motion report (null pointer in aqara_fp2).

```powershell
$env:ESPHOME_ESP_IDF_PREFIX = 'C:\esp-idf'
esphome compile fp2-wohnzimmer-windows.yaml
```

## 3. First flash over the cable

`firmware.factory.bin` is written from 0x0. ESPHome's partition table ends at 0x400000 –
**`fctry` at 0x833000 stays untouched.**

```bash
esptool --port COM24 --baud 57600 --before no-reset --after no-reset-stub --connect-attempts 0 write-flash 0x0 firmware.factory.bin
# erase leftovers of the Aqara firmware in ESPHome's nvs area (this area only!)
esptool --port COM24 --baud 57600 --before no-reset --after no-reset-stub erase-region 0x390000 0x70000
```

esptool reports "Hash of data verified". Then **disconnect GPIO0 from GND** and switch the supply off and on.
The serial line shows the boot, the radar initialisation and the Wi-Fi connection.

## 4. Afterwards: updates over Wi-Fi

Once the FP2 is on Wi-Fi, all further updates go over the air:

```powershell
esphome upload fp2-wohnzimmer-windows.yaml --device <IP of the FP2>
```

Before reassembly: **desolder all wires, including GPIO0** (if it touches GND the FP2 boots into download mode),
plug the antenna cable back on firmly and use the normal USB power supply.

## Checklist for dropouts

1. Loopback test of the adapter (bridge TXD↔RXD) – rules out adapter and USB.
2. **GND: both FP2 ground points, adapter and supply connected, soldered.**
3. Supply: 5 V, current limit not too tight; the CC indicator must not light up.
4. Check solder joints on TP8/TP9, keep wires short.
5. Low baud rate (57,600), GPIO0 permanently on GND, keep the stub alive with `--after no-reset-stub`, read in chunks.
6. Do not move anything during the process.
