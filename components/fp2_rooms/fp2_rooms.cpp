#include "fp2_rooms.h"
#include <algorithm>
#include <memory>
#include "esphome/core/hal.h"
#include "esphome/core/helpers.h"
#include "esphome/core/log.h"

namespace esphome {
namespace fp2_rooms {

static const char *const TAG = "fp2_rooms";
static constexpr uint32_t QUIET_MS = 2000;       // ohne Frame -> leere Frames einspeisen
static constexpr uint32_t QUIET_TICK_MS = 100;
static constexpr uint32_t COUNT_THROTTLE_MS = 1000;

void FP2Rooms::add_zone(uint8_t slot, const std::string &label, binary_sensor::BinarySensor *presence,
                        sensor::Sensor *count) {
  if (slot >= MAX_ZONES) return;
  ZoneSlot &z = this->zones_[slot];
  z.configured = true;
  z.label = label;
  z.presence = presence;
  z.count = count;
}

/// Liegt noch ein altes v1-Layout (Ecken/Homographie) im Flash? Nur für den Log-Hinweis beim Start.
static bool old_v1_layout_present() {
#ifdef USE_PREFERENCE_KEY_LOOKUP
  // einmaliges Lesen über den Schlüssel (make_preference legt jedes Mal ein Backend an, das nie freigegeben wird)
  uint32_t old_sum = 0;
  return global_preferences->load_from_key(fnv1_hash("fp2_rooms_layout_v1_sum"), reinterpret_cast<uint8_t *>(&old_sum),
                                           sizeof(old_sum));
#else
  return false;  // Plattform ohne Lesen über den Schlüssel: kein Hinweis
#endif
}

/// Gespeichertes 8-Zonen-Layout (Schlüssel fp2_rooms_layout_v2_*) lesen und prüfen. false, wenn keins da ist.
static bool load_v2_layout(Layout &out) {
#ifdef USE_PREFERENCE_KEY_LOOKUP
  LayoutV2 old;
  uint8_t *b = reinterpret_cast<uint8_t *>(&old);
  static constexpr size_t CHUNK_V2 = 240;  // Blockgröße wie beim damaligen Speichern
  for (size_t i = 0; i * CHUNK_V2 < sizeof(LayoutV2); i++) {
    const size_t len = std::min(CHUNK_V2, sizeof(LayoutV2) - i * CHUNK_V2);
    if (!global_preferences->load_from_key(fnv1_hash("fp2_rooms_layout_v2_" + std::to_string(i)), b + i * CHUNK_V2, len))
      return false;
  }
  uint32_t sum = 0;
  if (!global_preferences->load_from_key(fnv1_hash("fp2_rooms_layout_v2_sum"), reinterpret_cast<uint8_t *>(&sum),
                                         sizeof(sum)) ||
      sum != fnv1a(&old, sizeof(old)))
    return false;
  return layout_from_v2(old, out);
#else
  (void) out;
  return false;  // Plattform ohne Lesen über den Schlüssel: keine Übernahme
#endif
}

void FP2Rooms::setup() {
  // Schlüssel v3: 32 statt 8 Zonen -> anderer Aufbau und andere Größe als v2 (und als v1 mit Homographie/Polygonen)
  for (size_t i = 0; i < N_CHUNKS; i++) {
    const size_t len = std::min(CHUNK, sizeof(Layout) - i * CHUNK);
    this->pref_chunks_[i] =
        global_preferences->make_preference(len, fnv1_hash("fp2_rooms_layout_v3_" + std::to_string(i)), true);
  }
  this->pref_sum_ = global_preferences->make_preference<uint32_t>(fnv1_hash("fp2_rooms_layout_v3_sum"), true);
  Layout stored;
  uint32_t sum = 0;
  if (this->load_layout_(stored) && stored.magic == LAYOUT_MAGIC) {
    this->layout_ = stored;
    ESP_LOGI(TAG, "Layout aus Flash geladen (Raum: %u Zelle(n))", mask_count(stored.room));
  } else if (this->pref_sum_.load(&sum)) {
    // v3 schon einmal gespeichert: nach clear_layout oder beschädigt (Prüfsumme schon gemeldet) – kein Rückgriff auf v2/v1
    ESP_LOGI(TAG, "Kein Layout gespeichert – Raum über die Karte einrichten");
  } else if (load_v2_layout(stored)) {
    // noch nie ein v3-Layout gespeichert, aber ein gültiges 8-Zonen-Layout: übernehmen und unter v3 speichern
    this->layout_ = stored;
    ESP_LOGI(TAG, "Layout mit 8 Zonen aus Flash übernommen (Raum: %u Zelle(n))", mask_count(stored.room));
    if (!this->save_layout_()) ESP_LOGW(TAG, "Übernommenes Layout konnte nicht gespeichert werden");
  } else if (old_v1_layout_present()) {
    // altes v1-Layout im Flash: wird nicht übernommen
    ESP_LOGW(TAG, "Altes Layout (v1, Ecken/Homographie) im Flash wird ignoriert – Raum in der Karte neu einrichten");
  } else {
    ESP_LOGI(TAG, "Kein Layout gespeichert – Raum über die Karte einrichten");
  }
  if (this->source_ != nullptr)
    this->source_->add_on_state_callback([this](const std::string &s) { this->on_frame_(s); });
  this->last_frame_ms_ = millis();
  this->fps_t0_ = millis();
  this->publish_(millis(), true);
}

static uint32_t layout_checksum(const Layout &L) { return fnv1a(&L, sizeof(Layout)); }

bool FP2Rooms::save_layout_() {
  const uint8_t *b = reinterpret_cast<const uint8_t *>(&this->layout_);
  for (size_t i = 0; i < N_CHUNKS; i++) {
    const size_t len = std::min(CHUNK, sizeof(Layout) - i * CHUNK);
    if (!this->pref_chunks_[i].save(b + i * CHUNK, len)) return false;
  }
  const uint32_t sum = layout_checksum(this->layout_);
  if (!this->pref_sum_.save(&sum)) return false;
  return global_preferences->sync();
}

/// Lädt direkt in out (Layout ist ~1,4 kB groß, keine zweite Kopie auf dem Stack). Bei false ist out unbrauchbar.
bool FP2Rooms::load_layout_(Layout &out) {
  uint8_t *b = reinterpret_cast<uint8_t *>(&out);
  for (size_t i = 0; i < N_CHUNKS; i++) {
    const size_t len = std::min(CHUNK, sizeof(Layout) - i * CHUNK);
    if (!this->pref_chunks_[i].load(b + i * CHUNK, len)) return false;
  }
  uint32_t sum = 0;
  if (!this->pref_sum_.load(&sum) || sum != layout_checksum(out)) {
    ESP_LOGW(TAG, "Gespeichertes Layout beschädigt (Prüfsumme) – wird ignoriert");
    return false;
  }
  return true;
}

void FP2Rooms::on_frame_(const std::string &b64) {
  const uint32_t now = millis();
  uint8_t buf[1 + 16 * 14];
  const size_t len = base64_decode(b64, buf, sizeof(buf));
  Target t[MAX_TARGETS];
  uint8_t n = 0;
  if (len >= 1 && len >= 1 + (size_t) buf[0] * 14) {
    n = decode_targets(buf, len, t, MAX_TARGETS);
  } else if (!b64.empty()) {
    this->bad_frames_++;
  }
  this->frames_++;
  this->fps_frames_++;
  this->last_frame_ms_ = now;
  if (now - this->fps_t0_ >= 5000) {
    this->fps_ = this->fps_frames_ * 1000.0f / (float) (now - this->fps_t0_);
    this->fps_frames_ = 0;
    this->fps_t0_ = now;
  }
  this->process_(t, n, now);
}

void FP2Rooms::loop() {
  // Radar still (z. B. Positionsmeldung aus): leere Frames einspeisen, damit Zustände nach Haltezeit ablaufen
  const uint32_t now = millis();
  if (now - this->last_frame_ms_ > QUIET_MS && now - this->last_tick_ms_ >= QUIET_TICK_MS) {
    this->process_(nullptr, 0, now);
  }
  // gedrosselte Zählwerte nachreichen
  this->publish_(now, false);
}

void FP2Rooms::process_(const Target *t, uint8_t n, uint32_t now) {
  this->last_tick_ms_ = now;
  const Layout &L = this->layout_;
  FrameResult r = evaluate(L, t, n);
  this->last_result_ = r;
  if (!L.calibrated()) return;
  this->room_filter_.update(r.room_count, L.on_count, L.window, now, (uint32_t) L.room_hold_s * 1000u);
  for (uint8_t z = 0; z < MAX_ZONES; z++) {
    if (!this->zones_[z].configured) continue;
    this->zones_[z].filter.update(r.zone_count[z], L.on_count, L.window, now,
                                  (uint32_t) L.zones[z].hold_s * 1000u);
  }
  this->publish_(now, false);
}

void FP2Rooms::publish_(uint32_t now, bool force) {
  const Layout &L = this->layout_;
  const bool cal = L.calibrated();
  bool changed = force;

  const bool room_on = cal && this->room_filter_.on;
  if (this->room_presence_ != nullptr && (force || !this->room_presence_->has_state() || this->room_presence_->state != room_on)) {
    this->room_presence_->publish_state(room_on);
    changed = true;
  }
  const int16_t room_cnt = cal ? this->room_filter_.count(L.window) : 0;
  if (room_cnt != this->pub_room_count_ && (force || this->pub_room_count_ < 0 || now - this->pub_room_count_ms_ >= COUNT_THROTTLE_MS)) {
    if (this->room_count_ != nullptr) this->room_count_->publish_state(room_cnt);
    this->pub_room_count_ = room_cnt;
    this->pub_room_count_ms_ = now;
    changed = true;
  }
  for (uint8_t i = 0; i < MAX_ZONES; i++) {
    ZoneSlot &z = this->zones_[i];
    if (!z.configured) continue;
    const bool on = cal && mask_any(L.zones[i].mask) && z.filter.on;
    if (z.presence != nullptr && (force || !z.presence->has_state() || z.presence->state != on)) {
      z.presence->publish_state(on);
      changed = true;
    }
    const int16_t c = on ? z.filter.count(L.window) : 0;
    if (c != z.pub_count && (force || z.pub_count < 0 || now - z.pub_count_ms >= COUNT_THROTTLE_MS)) {
      if (z.count != nullptr) z.count->publish_state(c);
      z.pub_count = c;
      z.pub_count_ms = now;
      changed = true;
    }
  }

  if (this->state_sensor_ != nullptr && changed) {
    // kompakt (HA: höchstens 255 Zeichen), nur bei Änderung – Format siehe state_json() in fp2_rooms_core.h
    uint32_t zone_on = 0;
    uint8_t zone_cnt[MAX_ZONES]{};
    for (uint8_t i = 0; i < MAX_ZONES; i++) {
      const ZoneSlot &z = this->zones_[i];
      if (!z.configured) continue;  // nicht angelegte Slots bleiben 0
      if (cal && mask_any(L.zones[i].mask) && z.filter.on) zone_on |= 1u << i;
      zone_cnt[i] = (uint8_t) std::min<int16_t>(z.pub_count < 0 ? 0 : z.pub_count, 255);
    }
    const std::string s = state_json(cal, room_on, this->pub_room_count_ < 0 ? 0u : (unsigned) this->pub_room_count_,
                                     zone_on, zone_cnt);
    if (s != this->last_state_json_) {
      this->last_state_json_ = s;
      this->state_sensor_->publish_state(s);
    }
  }
}

void FP2Rooms::reset_filters_() {
  this->room_filter_ = Presence{};
  for (auto &z : this->zones_) {
    z.filter = Presence{};
  }
}

bool FP2Rooms::set_layout(const std::string &text, std::string &err) {
  // Zwischenlayout auf dem Heap: parse_layout legt selbst schon eins (~1,4 kB) auf den Stack der API-Aktion
  auto L = std::make_unique<Layout>();
  if (!parse_layout(text, *L, err)) {
    ESP_LOGW(TAG, "Layout abgelehnt: %s", err.c_str());
    return false;
  }
  for (uint8_t i = 0; i < MAX_ZONES; i++) {
    if (mask_any(L->zones[i].mask) && !this->zones_[i].configured) {
      err = "Zonen-Slot " + std::to_string(i) + " ist im YAML nicht angelegt";
      ESP_LOGW(TAG, "Layout abgelehnt: %s", err.c_str());
      return false;
    }
  }
  this->layout_ = *L;
  this->reset_filters_();
  if (!this->save_layout_()) {
    err = "Speichern im Flash fehlgeschlagen";
    ESP_LOGE(TAG, "%s", err.c_str());
    // Layout ist trotzdem aktiv, bis zum Neustart
    this->publish_(millis(), true);
    return false;
  }
  ESP_LOGI(TAG, "Neues Layout gespeichert (Raum: %u Zelle(n), ignoriert: %u)", mask_count(this->layout_.room),
           mask_count(this->layout_.excl));
  this->publish_(millis(), true);
  return true;
}

void FP2Rooms::clear_layout() {
  this->layout_ = Layout{};
  this->reset_filters_();
  this->save_layout_();
  ESP_LOGI(TAG, "Layout gelöscht");
  this->publish_(millis(), true);
}

void FP2Rooms::layout_json(JsonObject root) {
  const Layout &L = this->layout_;
  root["version"] = 2;
  root["calibrated"] = L.calibrated();
  JsonObject g = root["grid"].to<JsonObject>();
  g["cols"] = GRID_COLS;
  g["rows"] = GRID_ROWS;
  g["cell"] = CELL_CM;
  g["x0"] = GRID_X0;
  g["y0"] = GRID_Y0;
  JsonObject room = root["room"].to<JsonObject>();
  room["hold"] = L.room_hold_s;
  room["mask"] = mask_to_hex(L.room);
  root["excl"] = mask_to_hex(L.excl);
  // jeder im YAML angelegte Slot, auch mit leerer Maske
  JsonArray zones = root["zones"].to<JsonArray>();
  for (uint8_t z = 0; z < MAX_ZONES; z++) {
    if (!this->zones_[z].configured) continue;
    JsonObject o = zones.add<JsonObject>();
    o["slot"] = z;
    o["label"] = this->zones_[z].label;
    o["hold"] = L.zones[z].hold_s;
    o["mask"] = mask_to_hex(L.zones[z].mask);
  }
  JsonObject f = root["filter"].to<JsonObject>();
  f["on"] = L.on_count;
  f["window"] = L.window;
  JsonObject d = root["diag"].to<JsonObject>();
  d["frames"] = this->frames_;
  d["bad_frames"] = this->bad_frames_;
  d["fps"] = this->fps_;
  d["ms_since_frame"] = millis() - this->last_frame_ms_;
  d["seen"] = this->last_result_.seen;
  d["counted"] = this->last_result_.counted;
  JsonObject lim = root["limits"].to<JsonObject>();
  lim["zones"] = MAX_ZONES;
}

void FP2Rooms::dump_config() {
  const Layout &L = this->layout_;
  ESP_LOGCONFIG(TAG, "FP2 Rooms:");
  ESP_LOGCONFIG(TAG, "  Raster: %dx%d Zellen à %d cm", GRID_COLS, GRID_ROWS, CELL_CM);
  ESP_LOGCONFIG(TAG, "  Eingerichtet: %s", YESNO(L.calibrated()));
  ESP_LOGCONFIG(TAG, "  Raum: %u Zelle(n), Haltezeit %us", mask_count(L.room), L.room_hold_s);
  ESP_LOGCONFIG(TAG, "  Ignoriert: %u Zelle(n)", mask_count(L.excl));
  ESP_LOGCONFIG(TAG, "  Filter: %u von %u Frames", L.on_count, L.window);
  for (uint8_t i = 0; i < MAX_ZONES; i++)
    if (this->zones_[i].configured)
      ESP_LOGCONFIG(TAG, "  Zone %u '%s': %u Zelle(n), Haltezeit %us", i, this->zones_[i].label.c_str(),
                    mask_count(L.zones[i].mask), L.zones[i].hold_s);
  if (this->source_ == nullptr) ESP_LOGE(TAG, "  Keine Quelle (targets) gesetzt!");
}

}  // namespace fp2_rooms
}  // namespace esphome
