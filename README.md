# Aqara FP2 lokal in Home Assistant – mit Karte und Editor

Raum- und Zonenerkennung für den **Aqara FP2 mit ESPHome-Firmware** ([hansihe/esphome_fp2](https://github.com/hansihe/esphome_fp2)), ohne Aqara-Cloud.
Die Auswertung läuft **auf dem ESP**, die Lovelace-Karte ist Editor und Live-Anzeige – aufgebaut nach dem Prinzip der Aqara-App (Raster statt Einmessen).

| Teil | Aufgabe |
|---|---|
| `components/fp2_rooms` (ESPHome) | Radar-Ziele → Rasterzelle; Raum, Ignorier-Zellen und **bis 32 Zonen** als Zellmasken; Filter „N von M Frames“ + Haltezeit; Speicherung im Flash; HA-Entitäten |
| `card/fp2-room-card.js` (Lovelace) | Live-Anzeige; Raum lernen durch Herumlaufen; Störquellen lernen bei leerem Raum; Zellen malen; Zonen anlegen/benennen/löschen; Möbel; optional Grundriss mit Wänden, Türen, Fenstern |
| Home Assistant | speichert nur Kartendaten (Grundriss als Vektor, Ausrichtung, Zonennamen/-farben/-typen, Möbel) über `frontend/set_system_data` |

## Raster

Wie in der Aqara-App: 16 × 20 Zellen à 50 cm (8 m breit, 10 m tief), Sensor oben mittig.
Zelle aus Radar-Rohkoordinaten (cm): `col = floor((x + 400) / 50)`, `row = floor(y / 50)`.
Die Radar-Firmware liefert x/y in cm (int16 = 100 × Meter); Eckmontage dreht sie selbst.

## Entitäten auf dem ESP

- `Wohnzimmer belegt` (binary_sensor, occupancy) und `Wohnzimmer Personen` (sensor)
- je Zonen-Slot (0…31): `<Zone> belegt`, optional `<Zone> Personen`
- `Zonenstatus` (Text-Sensor, nur bei Änderung) für die Karte:
  `{"c":0|1,"r":[an,anzahl],"z":"<8 hex, Bit i = Slot i>","n":"<32 hex, Zeichen i = Anzahl Slot i, max. 15>"}`

Entitäten sind in ESPHome statisch, deshalb legt das Beispiel-YAML **32 Zonen-Slots auf Vorrat** an.
In der Karte fügst du Zonen frei hinzu: Sie nimmt den nächsten freien Slot, benennt die HA-Entitäten um
und blendet sie ein; beim Löschen werden sie wieder ausgeblendet.

## Logik auf dem ESP

1. Jeder Frame des Targets-Sensors wird dekodiert; jedes Ziel bekommt seine Rasterzelle.
2. Ein Ziel zählt, wenn seine Zelle zum Raum gehört und nicht als „Ignorieren“ markiert ist. Zonen zählen nur gezählte Ziele.
3. Raum/Zone **ein**, wenn in mindestens N der letzten M Frames ein Ziel darin war; **aus**, wenn seit der Haltezeit keins mehr gesehen wurde.
4. Kommen > 2 s keine Frames, werden leere Frames eingespeist, damit Zustände trotzdem ablaufen.

Konzept von Fensterfilter, Haltezeit, Sperrfläche und Leerlauf-Frames übernommen aus [P43YM/ld2450_zones](https://github.com/P43YM/ld2450_zones) (MIT).

## Installation

### 1. ESPHome
`components/fp2_rooms` in deinen ESPHome-Ordner kopieren (oder als `external_components` einbinden) und `example/fp2-wohnzimmer.yaml` als Vorlage nehmen. Wichtig daraus:

- `api.actions`: `set_layout`, `get_layout`, `clear_layout` – die Karte ruft sie als `esphome.<gerätename>_set_layout` usw. auf.
- `global_zone: motion:` **muss** gesetzt sein – aqara_fp2 ruft den Bewegungssensor ohne Null-Prüfung auf, sonst stürzt der ESP ab.
- `on_boot` schaltet „Report Targets“ nach 20 s ein (aqara_fp2 startet mit ausgeschalteter Positionsmeldung).
- `include_builtin_idf_components: [driver, esp_driver_i2c]` – sonst baut `aqara_fp2_accel` mit ESPHome 2026.x nicht.
- `mounting_position` an deine Montage anpassen (`wall` | `left_corner` | `right_corner`).
- `secrets.yaml` selbst anlegen (`wifi_ssid`, `wifi_password`, `fallback_hotspot_password`, `ota_password`, `api_encryption_key`).

Flashen des FP2: **[FLASHING.md](FLASHING.md)** (Anschluss, GND, Sicherung, Stolpersteine) und hansihe/esphome_fp2. **Vorher die Original-Firmware komplett sichern**
und kein `erase_flash` verwenden – die Partition `fctry` enthält gerätespezifische Kalibrierdaten.

### 2. Karte
`card/fp2-room-card.js` nach `/config/www/` kopieren und als Dashboard-Ressource `/local/fp2-room-card.js` (JavaScript-Modul) eintragen.

```yaml
type: custom:fp2-room-card
title: Erdgeschoss
devices:
  - device: fp2_wohnzimmer                     # ESPHome-Name (Bindestriche werden zu _)
    name: Wohnzimmer
    targets: sensor.fp2_wohnzimmer_targets
    state: sensor.fp2_wohnzimmer_zonenstatus
    mounting: sensor.fp2_wohnzimmer_mounting_position   # optional
# full_grid: true                              # Live-Ansicht: ganzes 8×10-m-Raster statt Ausschnitt auf den Raum
  # weitere FP2 möglich
```

### 3. Recorder
Den Targets-Sensor vom Recorder ausschließen:

```yaml
recorder:
  exclude:
    entities:
      - sensor.fp2_wohnzimmer_targets
```

### Demo-Modus (ohne FP2)
`demo: true` simuliert Personen und einen ortsfesten Geist; das Layout liegt dann in HA statt auf einem ESP.

## Bedienung

1. **Raum lernen:** Start → 1–3 min frei im Raum herumlaufen → Stopp. Gezählt werden nur Zellen, in denen sich ein Ziel bewegt hat; Ecken, in die man nicht kommt, werden über Schließen/Löcherfüllen ergänzt.
2. **Störquellen lernen:** Raum verlassen (20 s Countdown), 2 min Aufnahme. Zellen mit Zielen bei leerem Raum werden als „Ignorieren“ vorgeschlagen.
3. **Bearbeiten:** Zellen für Raum, Ignorieren und Zonen malen (Tippen/Ziehen) oder Rechteck aufziehen; Rückgängig; Haltezeiten und Filter. *Auf den ESP übertragen*.
4. **Zonen:** *Zone hinzufügen* → Name, Farbe, Typ (Sofa-Bereich, TV-Bereich, Esstisch, Bett, Kochbereich …). Umbenennen und Löschen jederzeit.
5. **Möbel:** Symbole (Tür, Sofa, Bett, Tisch, Schrank, Pflanze, Lampen …) platzieren, verschieben, drehen, skalieren – nur Anzeige.
6. Optional **Grundriss importieren** (PNG/JPG): Wände, Türen und Fenster werden im Browser erkannt und als Vektor gespeichert; danach den Sensor im Plan **ausrichten**.

Auf dem Handy: ein Finger zeichnet, zwei Finger verschieben/zoomen.

## Tests (ohne Hardware)

```bash
g++ -std=c++17 -Wall -Wextra -Icomponents/fp2_rooms test/core_test.cpp -o test/out/core_test && test/out/core_test
node test/card_grid.test.js
node test/card_math.test.js
node test/card_detect.test.js && node test/card_walls.test.js
```

Die Browser-/Host-Tests (`test/e2e_*.py`, `test/host_api_test.py`, `test/host-test.yaml`) stammen aus der Version mit Ecken-Einmessung und sind **noch nicht auf das Raster umgestellt**.

## Stand der Prüfung

| Punkt | Status |
|---|---|
| ESP-Logik (Zellen, Masken, Parser, Filter, 32 Zonen, Zonenstatus ≤ 255 Zeichen) | 14 Unit-Tests bestanden |
| Karte (Raster, Lernen, Zonen, Möbel, Statusformat, Zeiger-Gesten) | 49 + 10 Tests in Node bestanden, Demo-Rauchtest |
| Firmware für ESP32 (esp32-solo1, ESPHome 2026.9.1) | baut – RAM 28 %, Flash 49 %; läuft auf einem FP2 (per OTA aufgespielt) |
| Datenformat Radar (cm, Wandmodus: Sensor im Ursprung) | aus der Radar-Firmware abgeleitet und mit Messdaten geprüft |
| Raum lernen / Störquellen / Zonen am echten FP2 | **noch nicht getestet** |
| Grundriss-Erkennung mit echten Exposé-Plänen | **nicht getestet** |
| Montagehöhe | keine offizielle Aqara-Angabe gefunden; üblich genannt 1,4–1,8 m (nicht verifiziert) |
