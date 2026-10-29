#pragma once
// Plattformunabhängige Logik von fp2_rooms (ohne ESPHome-Abhängigkeiten, nativ testbar).
//
//  - Dekodieren der Ziel-Datensätze aus aqara_fp2 (hansihe/esphome_fp2):
//      [count u8][je Ziel 14 Byte: id u8, x s16 BE, y s16 BE, z s16 BE, v s16 BE, snr s16 BE, cls u8, posture u8, active u8]
//  - Raster nach dem Aqara-Prinzip: 16 x 20 Zellen à 50 cm in Radar-Rohkoordinaten (1 Einheit = 1 cm),
//    Sensor oben mittig (x -400..400, y 0..1000). Kein Einmessen, keine Homographie.
//  - Layout: Raum-, Ignorier- und bis zu 32 Zonenmasken (je 20 Zeilen x 16 Bit), Haltezeiten, Filter
//  - Auswertung je Frame mit Fensterfilter ("N von M Frames") und Haltezeit
//  - kompakter Zonenstatus (Text-Sensor, HA erlaubt höchstens 255 Zeichen je Zustand)
//
// Konzept Fensterfilter/Haltezeit übernommen von P43YM/ld2450_zones (MIT-Lizenz).

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <type_traits>
#include <vector>

namespace esphome {
namespace fp2_rooms {

static constexpr uint8_t MAX_TARGETS = 8;
static constexpr uint8_t MAX_ZONES = 32;  // Zonenstatus kodiert die Belegung als 32-Bit-Maske ("z")
static constexpr uint32_t LAYOUT_MAGIC = 0x46523204;     // "FR2" + Formatversion 4 (Raster-Masken, 32 Zonen)
static constexpr uint32_t LAYOUT_V2_MAGIC = 0x46523203;  // Formatversion 3 (Raster-Masken, 8 Zonen)
static constexpr uint8_t LAYOUT_V2_ZONES = 8;
static_assert(MAX_ZONES <= 32, "Zonenstatus: höchstens 32 Zonen (Bitmaske uint32)");

// Raster (gemeinsamer Vertrag mit der Karte)
static constexpr int GRID_COLS = 16;
static constexpr int GRID_ROWS = 20;
static constexpr int GRID_CELLS = GRID_COLS * GRID_ROWS;
static constexpr int CELL_CM = 50;
static constexpr int GRID_X0 = -400;  // linker Rand (cm)
static constexpr int GRID_Y0 = 0;     // Sensorwand (cm)
static constexpr size_t MASK_HEX_LEN = GRID_ROWS * 4;

struct Target {
  uint8_t id;
  int16_t x, y, z, velocity, snr;
  uint8_t classifier, posture, active;
};

/// Dekodiert den binären Ziel-Datensatz (nach Base64-Dekodierung). Unvollständige Ziele werden verworfen.
inline uint8_t decode_targets(const uint8_t *b, size_t len, Target *out, uint8_t max_out) {
  if (len < 1) return 0;
  const uint8_t count = b[0];
  uint8_t n = 0;
  for (uint8_t i = 0; i < count && n < max_out; i++) {
    const size_t o = 1 + (size_t) i * 14;
    if (o + 14 > len) break;
    auto s16 = [&](size_t k) { return (int16_t) (((uint16_t) b[k] << 8) | b[k + 1]); };
    Target &t = out[n++];
    t.id = b[o];
    t.x = s16(o + 1);
    t.y = s16(o + 3);
    t.z = s16(o + 5);
    t.velocity = s16(o + 7);
    t.snr = s16(o + 9);
    t.classifier = b[o + 11];
    t.posture = b[o + 12];
    t.active = b[o + 13];
  }
  return n;
}

/* ---------------- Raster und Masken ----------------
 *  Zelle: col = floor((x + 400) / 50), row = floor(y / 50), Index i = row * 16 + col (0..319).
 *  Maske: 20 Zeilen à uint16, Bit 15 (MSB) = col 0, Bit 0 = col 15 (Bitlage wie Aqaras Radar-Bitmaps).
 *  Textform: 80 Hex-Zeichen, Zeile 0 (direkt vor dem Sensor) zuerst, je Zeile 4 Ziffern.
 */
using Mask = uint16_t[GRID_ROWS];

/// Zellindex aus Rohkoordinaten (cm), -1 außerhalb des Rasters.
inline int cell_of(int x, int y) {
  const int dx = x - GRID_X0, dy = y - GRID_Y0;
  if (dx < 0 || dy < 0) return -1;  // links vom Raster bzw. hinter der Sensorwand
  const int col = dx / CELL_CM, row = dy / CELL_CM;
  if (col >= GRID_COLS || row >= GRID_ROWS) return -1;
  return row * GRID_COLS + col;
}

inline bool mask_get(const Mask &m, int i) {
  if (i < 0 || i >= GRID_CELLS) return false;
  return (m[i / GRID_COLS] >> (15 - i % GRID_COLS)) & 1u;
}

inline void mask_set(Mask &m, int i, bool on = true) {
  if (i < 0 || i >= GRID_CELLS) return;
  const uint16_t bit = (uint16_t) (1u << (15 - i % GRID_COLS));
  if (on) m[i / GRID_COLS] |= bit;
  else m[i / GRID_COLS] &= (uint16_t) ~bit;
}

inline bool mask_any(const Mask &m) {
  for (uint16_t r : m)
    if (r) return true;
  return false;
}

inline uint16_t mask_count(const Mask &m) {
  uint16_t n = 0;
  for (uint16_t r : m) n += (uint16_t) __builtin_popcount(r);
  return n;
}

inline std::string mask_to_hex(const Mask &m) {
  static const char *const DIGITS = "0123456789abcdef";
  std::string s(MASK_HEX_LEN, '0');
  for (int r = 0; r < GRID_ROWS; r++)
    for (int k = 0; k < 4; k++) s[r * 4 + k] = DIGITS[(m[r] >> (12 - 4 * k)) & 0xF];
  return s;
}

namespace detail {
inline int hex_val(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}
}  // namespace detail

/// 80 Hex-Zeichen -> Maske. Bei falscher Länge oder ungültigem Zeichen: false, out bleibt unverändert.
inline bool mask_from_hex(const char *s, size_t len, Mask &out) {
  if (len != MASK_HEX_LEN) return false;
  Mask tmp{};
  for (int r = 0; r < GRID_ROWS; r++) {
    uint16_t v = 0;
    for (int k = 0; k < 4; k++) {
      const int d = detail::hex_val(s[r * 4 + k]);
      if (d < 0) return false;
      v = (uint16_t) ((v << 4) | d);
    }
    tmp[r] = v;
  }
  memcpy(out, tmp, sizeof(Mask));
  return true;
}

inline bool mask_from_hex(const std::string &s, Mask &out) { return mask_from_hex(s.data(), s.size(), out); }

struct ZoneDef {
  uint16_t hold_s{5};
  Mask mask{};
};

/// Persistiertes Layout (trivial kopierbar -> direkt als ESPHome-Preference speicherbar)
struct Layout {
  uint32_t magic{0};
  Mask room{};
  uint16_t room_hold_s{5};
  Mask excl{};  // Ignorier-/Störquellen-Zellen
  ZoneDef zones[MAX_ZONES];
  uint8_t on_count{3};
  uint8_t window{10};

  bool calibrated() const { return magic == LAYOUT_MAGIC && mask_any(room); }
};
static_assert(std::is_trivially_copyable<Layout>::value, "Layout muss trivial kopierbar sein (Preference)");

/// Vorgänger-Layout mit 8 Zonen (Preference-Schlüssel fp2_rooms_layout_v2_*), nur zum Übernehmen beim Start.
/// Aufbau darf sich nicht ändern – er muss bitgleich zum früher gespeicherten Block sein.
struct LayoutV2 {
  uint32_t magic{0};
  Mask room{};
  uint16_t room_hold_s{5};
  Mask excl{};
  ZoneDef zones[LAYOUT_V2_ZONES];
  uint8_t on_count{3};
  uint8_t window{10};
};
static_assert(std::is_trivially_copyable<LayoutV2>::value, "LayoutV2 muss trivial kopierbar sein (Preference)");
static_assert(sizeof(LayoutV2) == 424, "LayoutV2 muss dem früher gespeicherten Block entsprechen");

/// Übernimmt ein gespeichertes 8-Zonen-Layout (Slots 0..7, restliche Slots leer). false bei falscher Magic.
inline bool layout_from_v2(const LayoutV2 &old, Layout &out) {
  if (old.magic != LAYOUT_V2_MAGIC) return false;
  out = Layout{};  // direkt in out (kein zweites Layout auf dem Stack)
  out.magic = LAYOUT_MAGIC;
  memcpy(out.room, old.room, sizeof(Mask));
  out.room_hold_s = old.room_hold_s;
  memcpy(out.excl, old.excl, sizeof(Mask));
  for (uint8_t z = 0; z < LAYOUT_V2_ZONES; z++) out.zones[z] = old.zones[z];
  out.on_count = old.on_count;
  out.window = old.window;
  return true;
}

/// FNV-1a über einen Speicherblock (Prüfsumme des gespeicherten Layouts)
inline uint32_t fnv1a(const void *data, size_t len) {
  const uint8_t *b = static_cast<const uint8_t *>(data);
  uint32_t h = 2166136261u;
  for (size_t i = 0; i < len; i++) h = (h ^ b[i]) * 16777619u;
  return h;
}

/// Fensterfilter mit Haltezeit (Prinzip aus ld2450_zones):
/// ein: Ziel in >= on_count der letzten window Frames; aus: hold_ms nach der letzten Sichtung.
/// Beim Ausschalten wird das Fenster geleert: Wieder-Einschalten nur durch on_count neue Sichtungen,
/// nicht durch Treffer von vor dem Ausschalten (sonst bei kurzer Haltezeit Flattern ohne Ziel).
struct Presence {
  uint32_t hist{0};
  uint32_t last_seen{0};
  bool on{false};
  uint8_t max_count_hist[32]{};  // Anzahl je Frame, für geglättete Zählung
  uint8_t idx{0};

  static uint32_t elapsed(uint32_t now, uint32_t then) { return now - then; }  // überlaufsicher (unsigned)

  void update(uint8_t count, uint8_t on_count, uint8_t window, uint32_t now, uint32_t hold_ms) {
    const bool seen = count > 0;
    hist = (hist << 1) | (seen ? 1u : 0u);
    max_count_hist[idx] = count;
    idx = (idx + 1) % 32;
    const uint32_t mask = window >= 32 ? 0xFFFFFFFFu : ((1u << window) - 1u);
    const uint8_t hits = (uint8_t) __builtin_popcount(hist & mask);
    if (on) {
      if (seen) {
        last_seen = now;
      } else if (elapsed(now, last_seen) >= hold_ms) {
        on = false;
        hist = 0;
      }
    } else if (hits >= on_count) {
      on = true;
      last_seen = now;
    }
  }

  /// Zählung: Maximum der letzten window Frames, solange belegt; sonst 0.
  uint8_t count(uint8_t window) const {
    if (!on) return 0;
    uint8_t m = 0;
    const uint8_t w = window > 32 ? 32 : window;
    for (uint8_t k = 1; k <= w; k++) {
      const uint8_t v = max_count_hist[(idx + 32 - k) % 32];
      if (v > m) m = v;
    }
    return m;
  }
};

struct FrameResult {
  uint8_t room_count{0};
  uint8_t zone_count[MAX_ZONES]{};
  uint8_t seen{0};      // Ziele vom Radar
  uint8_t counted{0};   // in Raum-Zellen und nicht ignoriert
};

/// Wertet einen Frame aus. Ein Ziel zählt, wenn seine Zelle gültig, im Raum und nicht ignoriert ist;
/// eine Zone zählt nur gezählte Ziele in ihren Zellen.
inline FrameResult evaluate(const Layout &L, const Target *t, uint8_t n) {
  FrameResult r;
  r.seen = n;
  if (!L.calibrated()) return r;
  for (uint8_t i = 0; i < n; i++) {
    const int c = cell_of(t[i].x, t[i].y);
    if (c < 0 || !mask_get(L.room, c) || mask_get(L.excl, c)) continue;
    r.counted++;
    r.room_count++;
    for (uint8_t z = 0; z < MAX_ZONES; z++)
      if (mask_get(L.zones[z].mask, c)) r.zone_count[z]++;
  }
  return r;
}

/* ---------------- Zonenstatus (Text-Sensor) ----------------
 *  {"c":<0|1>,"r":[<an>,<anzahl>],"z":"<8 Hex>","n":"<32 Hex>"}
 *  c  eingerichtet; r  Raum belegt (0/1) und Personenzahl
 *  z  Belegung als 32-Bit-Maske in Hex (8 Ziffern, Bit i = Slot i, Slot 0 = niederwertigstes Bit)
 *  n  Personenzahl je Slot: Ziffer an Position i (von links, 0-basiert) = Slot i, höchstens 15 (f)
 *  Nicht angelegte Slots sind immer 0. Höchstens STATE_JSON_MAX Zeichen (HA lehnt > 255 ab).
 */
static constexpr size_t STATE_JSON_MAX = 255;

/// Zonenstatus als JSON (höchstens 73 Zeichen). zone_on: Bit i = Slot i belegt; zone_count: Anzahl je Slot.
inline std::string state_json(bool calibrated, bool room_on, unsigned room_count, uint32_t zone_on,
                              const uint8_t zone_count[MAX_ZONES]) {
  static const char *const DIGITS = "0123456789abcdef";
  char z[9];
  for (int k = 0; k < 8; k++) z[k] = DIGITS[(zone_on >> (28 - 4 * k)) & 0xF];
  z[8] = 0;
  char n[MAX_ZONES + 1];
  for (uint8_t i = 0; i < MAX_ZONES; i++) n[i] = DIGITS[zone_count[i] > 15 ? 15 : zone_count[i]];
  n[MAX_ZONES] = 0;
  if (room_count > 255) room_count = 255;
  char buf[96];
  snprintf(buf, sizeof(buf), "{\"c\":%d,\"r\":[%d,%u],\"z\":\"%s\",\"n\":\"%s\"}", calibrated ? 1 : 0,
           room_on ? 1 : 0, room_count, z, n);
  return buf;
}

/* ---------------- Textformat für die Übertragung aus der Karte ----------------
 *  v2
 *  R hold_s hex80                  Raum (Pflicht, mindestens 1 Zelle)
 *  X hex80                         Ignorier-/Störquellen-Zellen (optional, höchstens einmal)
 *  Z slot hold_s hex80             Zone (slot 0..31, je Slot höchstens einmal)
 *  F on_count window               Filter (optional, Standard 3/10)
 *  Zeilen getrennt durch '\n' oder ';'. Leerzeilen erlaubt, '\r' und Leerzeichen am Ende werden ignoriert.
 */

namespace detail {
inline bool is_ws(char c) { return c == ' ' || c == '\t'; }
inline const char *skip_ws(const char *s) {
  while (is_ws(*s)) s++;
  return s;
}
/// Ganzzahl in [lo, hi], danach Leerraum oder Zeilenende. s zeigt danach hinter die Zahl.
inline bool parse_int(const char *&s, long lo, long hi, long &out) {
  s = skip_ws(s);
  char *e;
  const long v = strtol(s, &e, 10);
  if (e == s || (*e != 0 && !is_ws(*e)) || v < lo || v > hi) return false;
  out = v;
  s = e;
  return true;
}
/// Maske als 80 Hex-Zeichen (ein Wort). s zeigt danach hinter das Wort.
inline bool parse_mask(const char *&s, Mask &out, std::string &err) {
  s = skip_ws(s);
  size_t len = 0;
  while (s[len] != 0 && !is_ws(s[len])) len++;
  if (len != MASK_HEX_LEN) {
    err = "Maske braucht " + std::to_string(MASK_HEX_LEN) + " Hex-Zeichen (" + std::to_string(len) + " gefunden)";
    return false;
  }
  if (!mask_from_hex(s, len, out)) { err = "ungültiges Zeichen in der Maske (nur 0-9, a-f, A-F)"; return false; }
  s += len;
  return true;
}
}  // namespace detail

/// Parst das Textformat in ein neues Layout. Bei Fehler: false + Meldung, out bleibt unverändert.
inline bool parse_layout(const std::string &text, Layout &out, std::string &err) {
  Layout L;
  L.magic = LAYOUT_MAGIC;
  bool version_ok = false, has_room = false, has_excl = false, has_filter = false;
  bool has_zone[MAX_ZONES]{};
  size_t pos = 0;
  int line_no = 0;
  while (pos <= text.size()) {
    size_t end = text.find_first_of("\n;", pos);
    if (end == std::string::npos) end = text.size();
    std::string line = text.substr(pos, end - pos);
    pos = end + 1;
    line_no++;
    while (!line.empty() && (line.back() == '\r' || detail::is_ws(line.back()))) line.pop_back();
    const std::string where = "Zeile " + std::to_string(line_no) + ": ";
    // geparst wird über c_str(): alles hinter einem NUL-Zeichen bliebe sonst unbemerkt
    if (line.find('\0') != std::string::npos) { err = where + "ungültiges Zeichen (NUL)"; return false; }
    const char *s = detail::skip_ws(line.c_str());
    if (*s == 0) { if (end >= text.size()) break; continue; }
    const char tag = *s++;
    std::string perr;
    long v = 0;
    if (tag == 'v') {
      s = detail::skip_ws(s);
      if (strcmp(s, "1") == 0) { err = "Format v1 wird nicht mehr unterstützt – Raum in der Karte neu einrichten"; return false; }
      if (strcmp(s, "2") != 0) { err = where + "unbekannte Version"; return false; }
      version_ok = true;
    } else if (tag == 'R') {
      if (has_room) { err = where + "Raum (R) doppelt"; return false; }
      if (!detail::parse_int(s, 0, 3600, v)) { err = where + "Haltezeit 0..3600 s"; return false; }
      if (!detail::parse_mask(s, L.room, perr)) { err = where + perr; return false; }
      if (*detail::skip_ws(s)) { err = where + "zu viele Werte"; return false; }
      if (!mask_any(L.room)) { err = where + "Raum braucht mindestens 1 Zelle"; return false; }
      L.room_hold_s = (uint16_t) v;
      has_room = true;
    } else if (tag == 'X') {
      if (has_excl) { err = where + "Ignorier-Zellen (X) doppelt"; return false; }
      if (!detail::parse_mask(s, L.excl, perr)) { err = where + perr; return false; }
      if (*detail::skip_ws(s)) { err = where + "zu viele Werte"; return false; }
      has_excl = true;
    } else if (tag == 'Z') {
      long slot = 0;
      if (!detail::parse_int(s, 0, MAX_ZONES - 1, slot)) {
        err = where + "Zonen-Slot 0.." + std::to_string(MAX_ZONES - 1);
        return false;
      }
      if (has_zone[slot]) { err = where + "Zone " + std::to_string(slot) + " doppelt"; return false; }
      if (!detail::parse_int(s, 0, 3600, v)) { err = where + "Haltezeit 0..3600 s"; return false; }
      if (!detail::parse_mask(s, L.zones[slot].mask, perr)) { err = where + perr; return false; }
      if (*detail::skip_ws(s)) { err = where + "zu viele Werte"; return false; }
      L.zones[slot].hold_s = (uint16_t) v;
      has_zone[slot] = true;
    } else if (tag == 'F') {
      if (has_filter) { err = where + "Filter (F) doppelt"; return false; }
      long on = 0, win = 0;
      if (!detail::parse_int(s, 1, 32, on) || !detail::parse_int(s, 1, 32, win) || on > win) {
        err = where + "1 <= on_count <= window <= 32";
        return false;
      }
      if (*detail::skip_ws(s)) { err = where + "zu viele Werte"; return false; }
      L.on_count = (uint8_t) on;
      L.window = (uint8_t) win;
      has_filter = true;
    } else {
      err = where + "unbekannter Eintrag '" + std::string(1, tag) + "'";
      return false;
    }
    if (end >= text.size()) break;
  }
  if (!version_ok) { err = "Versionszeile 'v2' fehlt"; return false; }
  if (!has_room) { err = "Raum (R) fehlt"; return false; }
  out = L;
  return true;
}

}  // namespace fp2_rooms
}  // namespace esphome
