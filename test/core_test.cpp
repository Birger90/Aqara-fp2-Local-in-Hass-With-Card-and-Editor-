// Native Tests der fp2_rooms-Logik (v2, Raster):
//   g++ -std=c++17 -Wall -Wextra -I../components/fp2_rooms core_test.cpp -o core_test && ./core_test
//   oder (Ordner einmalig anlegen: mkdir test/out):
//   python -m ziglang c++ -std=c++17 -Wall -Wextra -I components/fp2_rooms test/core_test.cpp -o test/out/core_test.exe
//   (Ausgaben nur als test/core_test bzw. unter test/out/ – beides per .gitignore ausgenommen)
#include "fp2_rooms_core.h"
#include <cctype>
#include <cstdio>

using namespace esphome::fp2_rooms;

static int passed = 0;
#define CHECK(c) do { if (!(c)) { printf("FEHLER %s:%d  %s\n", __FILE__, __LINE__, #c); return 1; } } while (0)
#define OK(name) do { passed++; printf("✓ %s\n", name); } while (0)

static std::vector<uint8_t> enc(const std::vector<std::pair<int, int>> &pts) {
  std::vector<uint8_t> b(1 + pts.size() * 14, 0);
  b[0] = (uint8_t) pts.size();
  for (size_t i = 0; i < pts.size(); i++) {
    size_t o = 1 + i * 14;
    b[o] = (uint8_t) (i + 1);
    b[o + 1] = (uint8_t) ((uint16_t) pts[i].first >> 8);
    b[o + 2] = (uint8_t) (pts[i].first & 0xFF);
    b[o + 3] = (uint8_t) ((uint16_t) pts[i].second >> 8);
    b[o + 4] = (uint8_t) (pts[i].second & 0xFF);
  }
  return b;
}

/// Rechteck in Rohkoordinaten (cm, Zellmitten in [x0,x1) x [y0,y1)) als Maske
static void rect(Mask &m, int x0, int y0, int x1, int y1) {
  for (int y = y0 + 25; y < y1; y += 50)
    for (int x = x0 + 25; x < x1; x += 50) mask_set(m, cell_of(x, y));
}

static bool contains(const std::string &s, const char *part) { return s.find(part) != std::string::npos; }

int main() {
  // --- Decoder ---
  {
    auto b = enc({{-400, 800}, {399, -7}});
    Target t[MAX_TARGETS];
    uint8_t n = decode_targets(b.data(), b.size(), t, MAX_TARGETS);
    CHECK(n == 2 && t[0].x == -400 && t[0].y == 800 && t[1].x == 399 && t[1].y == -7 && t[1].id == 2);
    n = decode_targets(b.data(), 1 + 14 + 3, t, MAX_TARGETS);  // abgeschnitten
    CHECK(n == 1);
    OK("Decoder");
  }

  // --- Raster ---
  {
    CHECK(cell_of(-400, 0) == 0);
    CHECK(cell_of(-351, 49) == 0 && cell_of(-350, 49) == 1 && cell_of(-351, 50) == 16);
    CHECK(cell_of(0, 0) == 8 && cell_of(-1, 0) == 7);
    CHECK(cell_of(399, 0) == 15);
    CHECK(cell_of(-401, 0) == -1 && cell_of(400, 0) == -1);
    CHECK(cell_of(0, 999) == 19 * 16 + 8 && cell_of(399, 999) == 319);
    CHECK(cell_of(0, 1000) == -1);
    CHECK(cell_of(0, -1) == -1 && cell_of(0, -49) == -1 && cell_of(0, -50) == -1 && cell_of(-400, -1) == -1);
    CHECK(cell_of(-32768, -32768) == -1 && cell_of(32767, 32767) == -1);
    OK("Raster: Zellberechnung inkl. Ränder");
  }

  // --- Masken / Hex ---
  {
    Mask m{};
    CHECK(!mask_any(m) && mask_count(m) == 0);
    CHECK(mask_to_hex(m) == std::string(80, '0'));
    mask_set(m, 0);  // col 0 = MSB von Zeile 0
    CHECK(m[0] == 0x8000 && mask_get(m, 0) && !mask_get(m, 1));
    mask_set(m, 15);
    CHECK(m[0] == 0x8001);
    mask_set(m, 319);  // letzte Zelle = Bit 0 von Zeile 19
    CHECK(m[19] == 0x0001 && mask_count(m) == 3);
    const std::string h = mask_to_hex(m);
    CHECK(h.size() == 80 && h.substr(0, 4) == "8001" && h.substr(76) == "0001");
    mask_set(m, 15, false);
    CHECK(m[0] == 0x8000 && !mask_get(m, 15));
    CHECK(!mask_get(m, -1) && !mask_get(m, 320));
    mask_set(m, 320);  // ungültig -> keine Änderung
    CHECK(mask_count(m) == 2);

    // Roundtrip mit gemischtem Muster
    Mask a{}, b{};
    for (int i = 0; i < GRID_CELLS; i++)
      if ((i * 7 + i / 5) % 3 == 0) mask_set(a, i);
    const std::string ha = mask_to_hex(a);
    CHECK(mask_from_hex(ha, b) && memcmp(a, b, sizeof(Mask)) == 0);
    std::string up = ha;
    for (auto &c : up) c = (char) toupper((unsigned char) c);
    Mask c{};
    CHECK(mask_from_hex(up, c) && memcmp(a, c, sizeof(Mask)) == 0);
    // Fehler: Länge, Zeichen; Ziel bleibt unverändert
    Mask keep;
    memcpy(keep, b, sizeof(Mask));
    CHECK(!mask_from_hex(ha.substr(0, 79), b));
    CHECK(!mask_from_hex(ha + "0", b));
    std::string bad = ha;
    bad[40] = 'g';
    CHECK(!mask_from_hex(bad, b));
    CHECK(memcmp(keep, b, sizeof(Mask)) == 0);
    OK("Masken: Bitlage, Hex-Roundtrip, Groß/klein, Fehler");
  }

  // Raum 4 x 5 m vor dem Sensor (x -200..200, y 0..500), Ventilator als Störquelle,
  // Zone 0 Sofa (hinten links), Zone 2 Schreibtisch (vorne rechts), Zone 3 teilweise außerhalb des Raums
  Mask room{}, excl{}, sofa{}, desk{}, z3{};
  rect(room, -200, 0, 200, 500);
  rect(excl, 100, 50, 150, 100);
  rect(sofa, -200, 350, 0, 500);
  rect(desk, 50, 0, 200, 150);
  rect(z3, 150, 400, 300, 500);
  const std::string R = mask_to_hex(room), X = mask_to_hex(excl), Z0 = mask_to_hex(sofa), Z2 = mask_to_hex(desk),
                    Z3 = mask_to_hex(z3), E = std::string(80, '0');

  // --- Parser ---
  Layout L;
  std::string err;
  {
    const std::string txt = "v2\nR 10 " + R + "\nX " + X + "\nZ 0 30 " + Z0 + "\nZ 2 5 " + Z2 + "\nZ 3 0 " + Z3 +
                            "\nF 2 6\n";
    CHECK(parse_layout(txt, L, err));
    CHECK(L.magic == LAYOUT_MAGIC && L.calibrated() && L.room_hold_s == 10);
    CHECK(memcmp(L.room, room, sizeof(Mask)) == 0 && mask_count(L.room) == 80);
    CHECK(memcmp(L.excl, excl, sizeof(Mask)) == 0 && mask_count(L.excl) == 1);
    CHECK(memcmp(L.zones[0].mask, sofa, sizeof(Mask)) == 0 && L.zones[0].hold_s == 30);
    CHECK(!mask_any(L.zones[1].mask) && L.zones[1].hold_s == 5);
    CHECK(memcmp(L.zones[2].mask, desk, sizeof(Mask)) == 0 && L.zones[2].hold_s == 5);
    CHECK(L.zones[3].hold_s == 0 && L.on_count == 2 && L.window == 6);
    OK("Parser: vollständiges Layout");

    Layout L2;
    CHECK(parse_layout("v2;R 5 " + R, L2, err));
    CHECK(L2.calibrated() && !mask_any(L2.excl) && L2.on_count == 3 && L2.window == 10);
    OK("Parser: ';' als Trenner, Standardwerte");

    Layout L3;
    CHECK(parse_layout("\r\n  v2  \r\n\r\n R 7 " + R + "  \r\n\n;X " + X + "\t\r\n", L3, err));
    CHECK(L3.room_hold_s == 7 && mask_count(L3.excl) == 1);
    Layout L4;
    CHECK(parse_layout("v2\nR 0 " + R + "\nZ 1 3600 " + E + "\nF 32 32", L4, err));
    CHECK(L4.room_hold_s == 0 && L4.zones[1].hold_s == 3600 && !mask_any(L4.zones[1].mask) && L4.window == 32);
    OK("Parser: Leerzeilen, \\r, Leerraum, Grenzwerte");

    // 32 Zonen-Slots: 31 ist der letzte gültige, alle gleichzeitig möglich
    Layout L5;
    CHECK(parse_layout("v2\nR 5 " + R + "\nZ 31 12 " + Z0, L5, err));
    CHECK(MAX_ZONES == 32 && L5.zones[31].hold_s == 12 && memcmp(L5.zones[31].mask, sofa, sizeof(Mask)) == 0);
    CHECK(!mask_any(L5.zones[0].mask) && L5.zones[30].hold_s == 5);
    std::string all = "v2\nR 5 " + R;
    for (int z = 0; z < MAX_ZONES; z++) all += "\nZ " + std::to_string(z) + " " + std::to_string(z) + " " + Z2;
    Layout L6;
    CHECK(parse_layout(all, L6, err));
    for (int z = 0; z < MAX_ZONES; z++) CHECK(L6.zones[z].hold_s == z && memcmp(L6.zones[z].mask, desk, sizeof(Mask)) == 0);
    OK("Parser: Zonen-Slots 0..31");

    Layout keep = L;
    struct Bad {
      std::string txt;
      const char *msg;
    };
    const Bad bad[] = {
        {"v1\nH 1 0 0 0 1 0 0 0 1\nR 5 0,0 10,0 10,10", "Format v1 wird nicht mehr unterstützt – Raum in der Karte neu einrichten"},
        {"v1;R 5 " + R, "Format v1"},
        {"R 5 " + R, "Versionszeile 'v2' fehlt"},
        {"v3\nR 5 " + R, "Zeile 1: unbekannte Version"},
        {"v2\n", "Raum (R) fehlt"},
        {"v2\nX " + X, "Raum (R) fehlt"},
        {"v2\nR 5 " + E, "Zeile 2: Raum braucht mindestens 1 Zelle"},
        {"v2\nR 5 " + R + "\nR 5 " + R, "Zeile 3: Raum (R) doppelt"},
        {"v2\nR 3601 " + R, "Haltezeit 0..3600 s"},
        {"v2\nR -1 " + R, "Haltezeit"},
        {"v2\nR " + R, "Haltezeit"},
        {"v2\nR 5x " + R, "Haltezeit"},
        {"v2\nR 5", "80 Hex-Zeichen (0 gefunden)"},
        {"v2\nR 5 " + R.substr(1), "80 Hex-Zeichen (79 gefunden)"},
        {"v2\nR 5 " + R + "0", "80 Hex-Zeichen (81 gefunden)"},
        {"v2\nR 5 " + R.substr(0, 79) + "z", "ungültiges Zeichen"},
        {"v2\nR 5 " + R + " 1", "zu viele Werte"},
        {"v2\nR 5 " + R + "\nX " + X + "\nX " + X, "Zeile 4: Ignorier-Zellen (X) doppelt"},
        {"v2\nR 5 " + R + "\nX " + X.substr(2), "Zeile 3: Maske braucht"},
        {"v2\nR 5 " + R + "\nX " + X + " " + X, "zu viele Werte"},
        {"v2\nR 5 " + R + "\nZ 32 5 " + Z0, "Zeile 3: Zonen-Slot 0..31"},
        {"v2\nR 5 " + R + "\nZ -1 5 " + Z0, "Zonen-Slot 0..31"},
        {"v2\nR 5 " + R + "\nZ 31 5 " + Z0 + "\nZ 31 5 " + Z2, "Zeile 4: Zone 31 doppelt"},
        {"v2\nR 5 " + R + "\nZ 0 5 " + Z0 + "\nZ 0 5 " + Z2, "Zeile 4: Zone 0 doppelt"},
        {"v2\nR 5 " + R + "\nZ 0 4000 " + Z0, "Haltezeit"},
        {"v2\nR 5 " + R + "\nZ 0 5", "Maske braucht"},
        {"v2\nR 5 " + R + "\nF 0 5", "1 <= on_count <= window <= 32"},
        {"v2\nR 5 " + R + "\nF 7 6", "1 <= on_count"},
        {"v2\nR 5 " + R + "\nF 1 33", "1 <= on_count"},
        {"v2\nR 5 " + R + "\nF 3", "1 <= on_count"},
        {"v2\nR 5 " + R + "\nF 3 10 2", "zu viele Werte"},
        {"v2\nR 5 " + R + "\nF 3 10\nF 3 10", "Filter (F) doppelt"},
        {"v2\nR 5 " + R + "\nH 1 0 0 0 1 0 0 0 1", "Zeile 3: unbekannter Eintrag 'H'"},
        {"v2\nR 5 " + R + "\nS 1 1,2 3,4", "unbekannter Eintrag 'S'"},
        {"v2;R 5 " + R + ";Q 1", "Zeile 3: unbekannter Eintrag 'Q'"},
        {"v2\nR 5 " + R + std::string("\0 R 9 xyz", 9), "Zeile 2: ungültiges Zeichen (NUL)"},
        {"v2\nR 5 " + R + std::string("\n\0", 2), "Zeile 3: ungültiges Zeichen (NUL)"},
    };
    for (const auto &b : bad) {
      err.clear();
      const bool ok = parse_layout(b.txt, L, err);
      if (ok || !contains(err, b.msg)) printf("   erwartet '%s', erhalten '%s'\n", b.msg, err.c_str());
      CHECK(!ok && contains(err, b.msg));
    }
    CHECK(memcmp(&keep, &L, sizeof(Layout)) == 0);  // bei Fehler unverändert
    parse_layout("v1\nH 1 0 0 0 1 0 0 0 1", L, err);
    printf("   Fehlermeldung v1: %s\n", err.c_str());
    OK("Parser: Fehlerfälle, Layout bleibt bei Fehler unverändert");
  }

  // --- Auswertung ---
  {
    Target t[6] = {};
    t[0].x = -100; t[0].y = 400;  // im Raum + Sofa
    t[1].x = 120;  t[1].y = 60;   // im Raum, aber Ventilator (ignoriert), läge auch im Schreibtisch
    t[2].x = 250;  t[2].y = 300;  // außerhalb des Raums
    t[3].x = 0;    t[3].y = -10;  // hinter der Sensorwand (ungültige Zelle)
    t[4].x = 175;  t[4].y = 450;  // im Raum + Zone 3
    t[5].x = 250;  t[5].y = 450;  // Zone 3, aber außerhalb des Raums
    FrameResult r = evaluate(L, t, 6);
    CHECK(r.seen == 6 && r.counted == 2 && r.room_count == 2);
    CHECK(r.zone_count[0] == 1 && r.zone_count[1] == 0 && r.zone_count[2] == 0 && r.zone_count[3] == 1);
    t[1].x = 75; t[1].y = 60;     // Schreibtisch, nicht ignoriert
    r = evaluate(L, t, 6);
    CHECK(r.counted == 3 && r.zone_count[2] == 1);
    // Zone im letzten Slot (31) wird ausgewertet
    Layout L31 = L;
    memcpy(L31.zones[31].mask, sofa, sizeof(Mask));
    r = evaluate(L31, t, 6);
    CHECK(r.zone_count[31] == 1 && r.zone_count[0] == 1 && r.zone_count[30] == 0);
    // Zellränder: x = 200 gehört zur Zelle rechts vom Raum, y = 499 noch zum Raum
    Target e[2] = {};
    e[0].x = 199; e[0].y = 499;
    e[1].x = 200; e[1].y = 499;
    r = evaluate(L, e, 2);
    CHECK(r.counted == 1);
    // unkalibriert: nichts zählt
    Layout U;
    r = evaluate(U, t, 6);
    CHECK(!U.calibrated() && r.seen == 6 && r.counted == 0 && r.room_count == 0);
    // falsche Magic (z. B. altes v1-Layout) bzw. leerer Raum gilt als nicht eingerichtet
    Layout M = L;
    M.magic = 0x46523202;
    CHECK(!M.calibrated() && evaluate(M, t, 6).counted == 0);
    Layout N = L;
    memset(N.room, 0, sizeof(Mask));
    CHECK(!N.calibrated());
    OK("Auswertung: Raum, Ignorieren, Zonen, Ränder, unkalibriert");
  }

  // --- Filter ---
  {
    Presence p;
    uint32_t now = 0;
    // einzelner Ausreißer schaltet nicht ein (2 von 6)
    p.update(1, 2, 6, now += 100, 5000);
    CHECK(!p.on);
    for (int i = 0; i < 5; i++) p.update(0, 2, 6, now += 100, 5000);
    CHECK(!p.on);
    p.update(1, 2, 6, now += 100, 5000);
    p.update(2, 2, 6, now += 100, 5000);
    CHECK(p.on && p.count(6) == 2);
    // kurze Aussetzer: bleibt an, Zählung hält das Maximum im Fenster
    for (int i = 0; i < 4; i++) p.update(0, 2, 6, now += 100, 5000);
    CHECK(p.on && p.count(6) == 2);
    for (int i = 0; i < 3; i++) p.update(0, 2, 6, now += 100, 5000);
    CHECK(p.on && p.count(6) == 0);  // Fenster ohne Ziel, aber Haltezeit läuft noch
    // Haltezeit abgelaufen
    for (int i = 0; i < 50; i++) p.update(0, 2, 6, now += 100, 5000);
    CHECK(!p.on);
    // Überlauf von millis()
    Presence q;
    uint32_t t0 = 0xFFFFFF00u;
    q.update(1, 1, 1, t0, 1000);
    CHECK(q.on);
    q.update(0, 1, 1, t0 + 0x80, 1000);  // nach Überlauf, 128 ms
    CHECK(q.on);
    q.update(0, 1, 1, t0 + 2000, 1000);
    CHECK(!q.on);
    OK("Filter: Einschalten N von M, Haltezeit, Zählung, millis-Überlauf");
  }

  // --- Filter bei FP2-Bildrate (750 ms/Frame, Standard 3/10): nach Ablauf der Haltezeit kein
  //     Wieder-Einschalten aus den alten Treffern im Fenster ---
  {
    for (uint32_t hold_s = 0; hold_s <= 6; hold_s++) {
      const uint32_t hold_ms = hold_s * 1000u;
      Presence p;
      uint32_t now = 0;
      for (int i = 0; i < 4; i++) p.update(1, 3, 10, now += 750, hold_ms);
      CHECK(p.on);
      const uint32_t last_seen = now;
      int offs = 0, ons = 0;
      uint32_t off_at = 0;
      bool prev = true;
      for (int i = 0; i < 20; i++) {  // 15 s ohne Ziel
        p.update(0, 3, 10, now += 750, hold_ms);
        if (prev && !p.on) { offs++; off_at = now; }
        if (!prev && p.on) ons++;
        prev = p.on;
      }
      if (offs != 1 || ons != 0) printf("   Haltezeit %u s: %d x aus, %d x wieder an\n", (unsigned) hold_s, offs, ons);
      CHECK(!p.on && offs == 1 && ons == 0);
      CHECK(off_at - last_seen >= hold_ms && off_at - last_seen <= hold_ms + 750);
      // neue Sichtungen schalten wieder ein, aber erst nach on_count Frames
      p.update(1, 3, 10, now += 750, hold_ms);
      p.update(1, 3, 10, now += 750, hold_ms);
      CHECK(!p.on);
      p.update(1, 3, 10, now += 750, hold_ms);
      CHECK(p.on && p.count(10) == 1);
    }
    OK("Filter: 750 ms/Frame, Haltezeit 0..6 s, kein Flattern nach dem Ausschalten");
  }

  // --- Auswertung + Filter über mehrere Frames (wie process_) ---
  {
    Presence room_f, sofa_f;
    uint32_t now = 0;
    Target t[1] = {};
    t[0].x = -100; t[0].y = 400;
    for (int i = 0; i < 2; i++) {
      FrameResult r = evaluate(L, t, 1);
      room_f.update(r.room_count, L.on_count, L.window, now += 750, L.room_hold_s * 1000u);
      sofa_f.update(r.zone_count[0], L.on_count, L.window, now, L.zones[0].hold_s * 1000u);
    }
    CHECK(room_f.on && sofa_f.on && room_f.count(L.window) == 1);
    t[0].x = 120; t[0].y = 60;  // nur noch Geist im Ventilator -> zählt nicht
    for (int i = 0; i < 20; i++) {  // 15 s
      FrameResult r = evaluate(L, t, 1);
      room_f.update(r.room_count, L.on_count, L.window, now += 750, L.room_hold_s * 1000u);
      sofa_f.update(r.zone_count[0], L.on_count, L.window, now, L.zones[0].hold_s * 1000u);
    }
    CHECK(!room_f.on && sofa_f.on);  // Raum 10 s Haltezeit abgelaufen, Sofa 30 s noch nicht
    OK("Auswertung + Filter über mehrere Frames, Störquelle hält nicht an");
  }

  // --- Zonenstatus (Text-Sensor, HA erlaubt höchstens 255 Zeichen) ---
  {
    const std::string N0(32, '0');
    uint8_t cnt[MAX_ZONES] = {};
    CHECK(state_json(false, false, 0, 0, cnt) == "{\"c\":0,\"r\":[0,0],\"z\":\"00000000\",\"n\":\"" + N0 + "\"}");
    // Slot 0 (niederwertigstes Bit) mit 2 Personen, Slot 2 mit 1, Slot 31 (höchstes Bit) mit 20 -> auf 15 begrenzt
    cnt[0] = 2;
    cnt[2] = 1;
    cnt[31] = 20;
    const std::string s = state_json(true, true, 3, (1u << 0) | (1u << 2) | (1u << 31), cnt);
    printf("   Zonenstatus Beispiel: %s\n", s.c_str());
    CHECK(s == "{\"c\":1,\"r\":[1,3],\"z\":\"80000005\",\"n\":\"201" + std::string(28, '0') + "f\"}");
    // Slot 9 -> Bit 9 = 0x200; Anzahl an Position 9
    uint8_t c9[MAX_ZONES] = {};
    c9[9] = 7;
    CHECK(state_json(true, false, 0, 1u << 9, c9) ==
          "{\"c\":1,\"r\":[0,0],\"z\":\"00000200\",\"n\":\"0000000007" + std::string(22, '0') + "\"}");
    // ungünstigster Fall: alles belegt, alle Zahlen maximal
    uint8_t full[MAX_ZONES];
    memset(full, 255, sizeof(full));
    const std::string w = state_json(true, true, 65535, 0xFFFFFFFFu, full);
    printf("   Zonenstatus ungünstigster Fall (%zu Zeichen): %s\n", w.size(), w.c_str());
    CHECK(w == "{\"c\":1,\"r\":[1,255],\"z\":\"ffffffff\",\"n\":\"" + std::string(32, 'f') + "\"}");
    CHECK(w.size() <= STATE_JSON_MAX && w.size() == 73);
    OK("Zonenstatus: kompaktes Format, Bitlage, Begrenzung, <= 255 Zeichen");
  }

  // --- Übernahme eines gespeicherten 8-Zonen-Layouts ---
  {
    LayoutV2 old;
    old.magic = LAYOUT_V2_MAGIC;
    memcpy(old.room, room, sizeof(Mask));
    old.room_hold_s = 42;
    memcpy(old.excl, excl, sizeof(Mask));
    memcpy(old.zones[7].mask, desk, sizeof(Mask));
    old.zones[7].hold_s = 99;
    old.on_count = 4;
    old.window = 9;
    Layout N;
    CHECK(layout_from_v2(old, N));
    CHECK(N.magic == LAYOUT_MAGIC && N.calibrated() && N.room_hold_s == 42 && N.on_count == 4 && N.window == 9);
    CHECK(memcmp(N.room, room, sizeof(Mask)) == 0 && memcmp(N.excl, excl, sizeof(Mask)) == 0);
    CHECK(memcmp(N.zones[7].mask, desk, sizeof(Mask)) == 0 && N.zones[7].hold_s == 99);
    for (int z = 8; z < MAX_ZONES; z++) CHECK(!mask_any(N.zones[z].mask) && N.zones[z].hold_s == 5);
    Layout keep = N;
    old.magic = 0x46523202;
    CHECK(!layout_from_v2(old, N) && memcmp(&keep, &N, sizeof(Layout)) == 0);
    CHECK(sizeof(LayoutV2) == 424 && sizeof(Layout) == 1432);
    // Prüfsumme (FNV-1a, Referenzwerte)
    CHECK(fnv1a("", 0) == 2166136261u && fnv1a("a", 1) == 0xe40c292cu);
    OK("Layout: Übernahme 8 Zonen -> 32 Zonen, Prüfsumme");
  }

  static_assert(std::is_trivially_copyable<Layout>::value, "Layout trivial kopierbar");
  printf("\n%d Tests bestanden, sizeof(Layout) = %zu Byte\n", passed, sizeof(Layout));
  return 0;
}
