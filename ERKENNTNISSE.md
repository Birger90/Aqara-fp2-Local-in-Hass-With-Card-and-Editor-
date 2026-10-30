**Deutsch** · [English](FINDINGS.md)

# Erkenntnisse zum Aqara FP2 unter ESPHome

Gesammelt beim Umbau eines FP2 (Okt. 2026). Jeder Punkt ist als **belegt** (gemessen, im Quellcode gelesen
oder am Gerät getestet) oder als **nicht verifiziert** gekennzeichnet. Flash-Erfahrungen stehen in [FLASHING.md](FLASHING.md).

## Hardware

| Teil | Anschluss | Status |
|---|---|---|
| ESP32-SOLO-1, 16 MB Flash | – | belegt (esptool) |
| Radar TI IWR6843AOP | UART TX GPIO19, RX GPIO18, 890 000 Baud, Reset GPIO13 | belegt (hansihe-Konfiguration, läuft) |
| Beschleunigungssensor | I²C 0x27 | belegt (Scan) |
| **Lichtsensor TI OPT3001** | **I²C 0x44** | belegt: Hersteller-ID 0x5449 („TI“), Geräte-ID 0x3001 ausgelesen |
| I²C-Bus | Port 0, SDA GPIO33, SCL GPIO32, 400 kHz | belegt (Log von aqara_fp2_accel) |
| GPIO35 | Pegel 1 im Ruhezustand | gelesen; dass es der Interrupt-Ausgang des OPT3001 ist, ist **nicht verifiziert** |
| **RGB-LED** | **GPIO14 rot, GPIO26 grün, GPIO27 blau, alle low-aktiv** | belegt: am Gerät einzeln geblinkt und Farben abgeglichen |
| Taste | GPIO36, invertiert | aus hansihes Beispiel |

### Lichtsensor (OPT3001)
- Nach dem Einschalten steht er im Ruhemodus (Konfiguration 0xC810) und liefert 0. Mit 0xCC10 (automatischer Bereich,
  800 ms, Dauerbetrieb) misst er. Lux = 0,01 · 2^E · M (Datenblatt). Belegt: Werte kommen in HA an.
- Die Werte sind **nicht kalibriert** – der Sensor sitzt hinter dem Gehäusefenster.
- Ein eigener `i2c:`-Block in ESPHome würde mit dem I²C-Treiber von `aqara_fp2_accel` kollidieren; deshalb liest das
  Beispiel-YAML den Sensor direkt über den IDF-Treiber auf Port 0.

### Beschleunigungssensor
- Der Radar fragt beim ESP die **Einbaulage** und den **Neigungswinkel** ab (`ANGLE_SENSOR_DATA`, Wert = 90° − |Neigung
  der Z-Achse|); `aqara_fp2_accel` beantwortet das. Belegt im Quellcode (`fp2_component.cpp`).
  Wofür der Radar den Winkel nutzt (vermutlich Ausgleich der Neigung), ist **nicht verifiziert**.
- Er misst nur die Lage zur Schwerkraft. Drehung um die senkrechte Achse (Blickrichtung) und Verschieben erkennt er nicht.
  Für das Einrichten des Raums liefert er deshalb nichts, wohl aber für die Erkennung „Sensor wurde bewegt“
  (Beispiel-YAML: `Neigung`, `Einbaulage`, `Sensor bewegt`, `Lage als Referenz übernehmen`).
- Unser Gerät an der Wand (ca. 80 cm Höhe): Neigung 66°, Einbaulage `UP_TILT_REV`.

### LED-Bedeutung bei Aqara
Laut einer KI-Zusammenfassung der Aqara-Anleitung (**nicht** am Original geprüft): gelb schnell = Netzwerkmodus/Start,
blau schnell = verbindet mit WLAN, blau langsam = verbindet mit Aqara-Dienst, weiß dauerhaft = Verbindungsfehler,
rot = Gerätefehler, aus = Normalbetrieb. Das Beispiel-YAML bildet das nach (blau langsam = HA nicht verbunden).

## Radar-Daten

- Targets-Sensor (Base64): 1 Byte Anzahl, je Ziel 14 Byte: id, x, y, z, velocity, snr (int16, Big Endian),
  classifier, posture, active. Belegt (Dekoder, hansihe).
- **x/y in cm** (int16 = 100 × Meter), gleicher Maßstab in beiden Achsen. Wandmodus: Sensor im Ursprung, y = geradeaus,
  x = seitlich. Eckmodi dreht/verschiebt die Radar-Firmware selbst (45°, ±400 cm). Belegt (Firmware-Analyse, Messdaten).
- `z` und `active` waren in allen Messungen 0. Ein „Geister“-Kennzeichen gibt es nicht.
- Meldeabstand ca. **0,75 s**. Belegt (HA-Verlauf).
- Blickfeld etwa **±60°** (gemessen −63° … +64°). **Ecken an der Sensorwand sind nicht sichtbar** – deshalb scheiterte
  das ursprüngliche Einmessen über vier Raumecken, und die Karte nutzt jetzt das Raster nach Aqara-Prinzip.
- Nach dem Verlassen des Bereichs kam mindestens einmal ein leerer Frame (`AA==`). Ob der Radar ohne Ziele regelmäßig
  sendet, ist **nicht verifiziert**; `fp2_rooms` speist bei > 2 s ohne Frames ohnehin Leer-Frames ein.

### Eingefrorene Spuren
Der Tracker hält bei schwachem Signal die letzte Position **bitgleich** fest. Beispiel: Ein Ziel stand eine Minute lang
exakt auf (−14 cm / 377 cm), während die echte Person sich bewegte. Belegt (HA-Verlauf).
Eine stehende Person wird aber ebenfalls bitgleich gemeldet – „bitgleich“ allein taugt deshalb nicht als Geister-Filter.

### Spiegelungen (Geister hinter der Person)
Mit einer Person im Raum meldet der Radar oft ein **zweites Ziel 2–2,5 m weiter hinten**, das seitlich mitläuft
(z. B. Person x 134 → −88 cm, Geist x 209 → −113 cm). Es lag immer am oder hinter dem hinteren Raumrand.
Belegt (HA-Verlauf). Ursache vermutlich ein Umweg-Echo über die Rückwand oder große glatte Flächen – **nicht verifiziert**.
Konsequenz: Der gelernte Raum muss an der echten Wand enden; Zellen dahinter nicht malen, dann zählt der ESP den Geist nicht.

## Aqara-App als Vorbild

- Kein Einmessen. Festes Raster 16 × 20 Zellen à 50 cm, Sensor oben mittig. Raumrand durch freies Herumlaufen,
  Störquellen bei leerem Raum, danach Zellen malen. Belegt (Tests/Berichte, Screenshots der App).
- Bis zu 30 Zonen; je Zone Farbe, Typ (Sofa-Bereich, TV-Bereich, Esstisch, Kochbereich, Bett … „Andere“) und
  Empfindlichkeit Hoch/Mittel/Niedrig. Möbel als „Aufkleber“, höchstens 20, nur Anzeige. Belegt (Screenshots).
- Unsere Umsetzung: 32 Zonen, Möbel bis 40; die Empfindlichkeit je Zone fehlt (der ESP hat nur einen gemeinsamen Filter).
- Empfohlene Montagehöhe: keine offizielle Angabe gefunden; genannt werden 1,4–1,8 m – **nicht verifiziert**.

## ESPHome und Home Assistant

- `aqara_fp2` ruft den globalen Bewegungssensor ohne Null-Prüfung auf: ohne `global_zone: motion:` stürzt der ESP bei der
  ersten Bewegungsmeldung ab (LoadProhibited). Belegt (Absturz, Quellcode).
- `aqara_fp2` startet mit ausgeschalteter Positionsmeldung; `on_boot` schaltet „Report Targets“ nach 20 s ein. Belegt.
- `fp2_rooms` braucht ESPHome ≥ 2026.9 (Preferences mit zwei Argumenten) und damit Python ≥ 3.12. Belegt.
- Text-Sensoren dürfen in HA höchstens 255 Zeichen haben → kompakter Zonenstatus (höchstens 73 Zeichen bei 32 Zonen).
- Entitäten sind in ESPHome statisch → 32 Zonen-Slots auf Vorrat; die Karte benennt sie um und blendet ein/aus.
- Nach einem OTA-Update mit entfernten Entitäten waren diese in HA verschwunden (beobachtet bei den LED-Testschaltern).
- Inline-Dashboard-Ressourcen (data-URI) sind auf ca. 128 KB begrenzt; die Karte ist größer. Wege: `/local/` oder eine
  auf einen Commit festgelegte jsDelivr-URL dieses Repos.
