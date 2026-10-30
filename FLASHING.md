**Deutsch** · [English](FLASHING.en.md)

# FP2 flashen – Erfahrungsbericht und Anleitung

So haben wir einen Aqara FP2 (ESP32-SOLO-1, Radar TI IWR6843AOP) gesichert und mit ESPHome geflasht.
Grundlage ist [hansihe/esphome_fp2](https://github.com/hansihe/esphome_fp2) (FLASHING.md mit dem Bild der Testpunkte).
Dieses Dokument ergänzt es um das, was bei uns tatsächlich nötig war.

**Unsere wichtigste Lehre: saubere Masse (GND) und stabile Versorgung.** Ohne sie bricht die Verbindung immer wieder ab.

> Auf eigenes Risiko. Das Gerät wird geöffnet und gelötet.

## Was du brauchst

- USB-TTL-Adapter mit **3,3-V-Pegel**. Bei uns: Waveshare USB-TTL-Kabel mit FTDI FT232RNL (VID:PID 0403:6001),
  Schalter auf **3V3**. Den 3,3-V-*Versorgungs*pin des Adapters haben wir **nicht** angeschlossen.
- Eigene 5-V-Versorgung für den FP2. Bei uns ein Labornetzteil. Empfehlung (nicht gemessen): Strombegrenzung ≥ 1 A,
  denn bei zu knapper Begrenzung bricht die Spannung ein, wenn Radar und WLAN anlaufen.
- Feiner Lötkolben, dünne Litzen (kurz halten), Lupe.
- [esptool](https://github.com/espressif/esptool) (bei uns 5.3.0) und ESPHome (bei uns 2026.9.1, braucht Python ≥ 3.12).

## Anschluss

| FP2 (Testpunkt) | Funktion | Adapter |
|---|---|---|
| TP8 | TXD0 des ESP32 | **RXD** |
| TP9 | RXD0 des ESP32 | **TXD** |
| TP28 | GPIO0 (Boot-Modus) | zum Flashen an GND |
| GND (beide Punkte) | Masse | **GND** – siehe unten |

TX und RX werden gekreuzt. RST haben wir nicht gebraucht; neu gestartet wird durch Aus-/Einschalten der Versorgung.

### GND – der entscheidende Punkt

Unsere ersten Sicherungsversuche brachen immer wieder ab: erst Meldungen wie *„serial noise or corruption“* bzw.
*„chip stopped responding“*, danach *„No serial data received“*. Fast jedes dritte 64-KB-Stück brauchte einen zweiten Versuch.

- Ein **Loopback-Test** (TXD↔RXD am Adapter gebrückt, Zufallsdaten bei 57 600 bis 921 600 Baud: 0 Fehler) hat Adapter,
  Kabel, Treiber und USB als Ursache ausgeschlossen.
- Danach haben wir **beide GND-Punkte aus hansihes Bild** mit der Masse verbunden und das Labornetzteil geprüft.
  Ab da lief die Sicherung über mehrere MB ohne einen einzigen Fehler oder Wiederholversuch.
- Spätere einzelne Abbrüche kamen meist kurz nach dem Einschalten oder wenn Kabel bewegt wurden.

Unser Rat: **Adapter-GND, Netzteil-GND und beide GND-Punkte des FP2 gemeinsam verbinden**, gelötet statt nur angedrückt,
kurze Drähte, und während des Lesens/Schreibens **nichts anfassen**. Ob die Masse oder das Netzteil den Ausschlag gab,
ließ sich nicht sauber trennen – beides zusammen hat geholfen.

Lötstellen an TP8/TP9 mit der Lupe prüfen: glänzend und verlaufen ist gut, matt/kugelig ist verdächtig.
Sind RX/TX vertauscht, kommt **gar keine** Verbindung zustande; zeitweise Aussetzer deuten dagegen auf Masse,
Versorgung oder Lötstellen.

## Download-Modus

1. Versorgung aus.
2. GPIO0 (TP28) mit GND verbinden.
3. Versorgung ein. Der ESP32 startet im ROM-Bootloader.

Bei uns lief es stabiler, wenn **GPIO0 während der ganzen Sicherung bzw. des ganzen Schreibens auf GND blieb**.
Der Download-Modus liegt fest im ROM – ein Abbruch mittendrin ist ungefährlich, man kann jederzeit neu ansetzen.

## 1. Original-Firmware sichern (Pflicht)

Der Flash ist 16 MB groß. Die Partition **`fctry` (0x833000, 24 KB) enthält gerätespezifische Kalibrierdaten** des Radars.
Sie gibt es nur auf diesem einen Gerät. **Niemals `erase-flash` verwenden.**

Bei instabiler Verbindung hat sich bewährt: niedrige Baudrate (57 600), den Stub einmal laden und danach ohne Reset
in 64-KB-Stücken lesen, jedes Stück mit Wiederholungen. esptool prüft jedes Stück per MD5.

```bash
# zuerst die Kalibrierdaten einzeln
esptool --port COM24 --baud 57600 --before no-reset --after no-reset-stub --connect-attempts 0 read-flash 0x833000 0x6000 fctry_0x833000.bin
# dann der Rest; bei Abbrüchen in Stücken (z. B. 64 KB) lesen und die Stücke zusammenfügen
esptool --port COM24 --baud 57600 --before no-reset --after no-reset-stub read-flash 0x0 0x1000000 aqara_fp2_original.bin
```

`--before no-reset --after no-reset-stub` lässt den geladenen Stub laufen, sodass weitere Aufrufe ohne neuen
Boot-Vorgang weiterlesen. Aufbau des Flash bei uns:

| Bereich | Inhalt |
|---|---|
| 0x0–0x20000 | Bootloader, Partitionstabelle, nvs, otadata, phy_init |
| 0x20000 / 0x220000 | aqara_fw1 / aqara_fw2 (je 2 MB) |
| 0x420000 | test |
| 0x433000 | mcu_ota (4 MB, bei uns teilweise gefüllt) |
| **0x833000** | **fctry – Kalibrierdaten** |
| ab 0x839000 | außerhalb jeder Partition, bei uns leer (FF) |

`nvs` enthält WLAN-Zugangsdaten und Schlüssel der Aqara-Firmware – die Sicherung nicht veröffentlichen.
`fctry` am besten zweimal lesen und vergleichen; SHA256-Prüfsummen der Dateien notieren.

Zurückspielen (Download-Modus):

```bash
esptool --port COM24 write-flash 0x0 aqara_fp2_original.bin
esptool --port COM24 write-flash 0x833000 fctry_0x833000.bin   # nur die Kalibrierdaten
```

## 2. ESPHome bauen

`example/fp2-wohnzimmer.yaml` als Vorlage nehmen und `secrets.yaml` anlegen. Stolpersteine, vor allem unter Windows:

- **WLAN-Name exakt** schreiben – Groß-/Kleinschreibung zählt. Der ESP32 kann nur **2,4 GHz**.
  „No networks found“ im Log heißt nur: *dieses* Netz wurde nicht gefunden (der Scan ist auf die SSID gefiltert),
  nicht, dass die Antenne defekt ist.
- ESP-IDF lehnt Git-Bash/MSYS ab → aus PowerShell bauen.
- Leerzeichen im Projektpfad → `esphome: build_path:` auf einen Pfad ohne Leerzeichen setzen
  (siehe `example/fp2-wohnzimmer-windows.yaml`).
- Zu lange Pfade (MAX_PATH) → Umgebungsvariable `ESPHOME_ESP_IDF_PREFIX` auf einen kurzen Pfad setzen.
- `global_zone: motion:` muss gesetzt sein, sonst stürzt der ESP bei der ersten Bewegungsmeldung ab (Nullzeiger in aqara_fp2).

```powershell
$env:ESPHOME_ESP_IDF_PREFIX = 'C:\esp-idf'
esphome compile fp2-wohnzimmer-windows.yaml
```

## 3. Erstes Flashen per Kabel

Geschrieben wird `firmware.factory.bin` ab 0x0. ESPHomes Partitionstabelle endet bei 0x400000 –
**`fctry` bei 0x833000 bleibt unberührt.**

```bash
esptool --port COM24 --baud 57600 --before no-reset --after no-reset-stub --connect-attempts 0 write-flash 0x0 firmware.factory.bin
# Reste der Aqara-Firmware im nvs-Bereich von ESPHome löschen (nur dieser Bereich!)
esptool --port COM24 --baud 57600 --before no-reset --after no-reset-stub erase-region 0x390000 0x70000
```

esptool meldet „Hash of data verified“. Danach **GPIO0 von GND lösen** und die Versorgung aus- und wieder einschalten.
Auf der seriellen Leitung siehst du den Start, die Radar-Initialisierung und die WLAN-Verbindung.

## 4. Danach: Updates per WLAN

Sobald der FP2 im WLAN ist, gehen alle weiteren Updates per OTA:

```powershell
esphome upload fp2-wohnzimmer-windows.yaml --device <IP des FP2>
```

Vor dem Zusammenbau: **alle Drähte ablöten, auch GPIO0** (berührt er GND, startet der FP2 im Download-Modus),
das Antennenkabel wieder fest aufstecken und das normale USB-Netzteil verwenden.

## Checkliste bei Verbindungsabbrüchen

1. Loopback-Test des Adapters (TXD↔RXD brücken) – schließt Adapter und USB aus.
2. **GND: beide Massepunkte des FP2, Adapter und Netzteil verbunden, gelötet.**
3. Versorgung: 5 V, Strombegrenzung nicht zu knapp; die CC-Anzeige darf nicht anspringen.
4. Lötstellen TP8/TP9 prüfen, Drähte kurz halten.
5. Niedrige Baudrate (57 600), GPIO0 dauerhaft auf GND, Stub mit `--after no-reset-stub` am Leben halten, in Stücken lesen.
6. Während des Vorgangs nichts bewegen.
