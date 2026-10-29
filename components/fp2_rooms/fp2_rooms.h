#pragma once

#include "esphome/core/component.h"
#include "esphome/core/preferences.h"
#include "esphome/components/text_sensor/text_sensor.h"
#include "esphome/components/binary_sensor/binary_sensor.h"
#include "esphome/components/sensor/sensor.h"
#include "esphome/components/json/json_util.h"

#include "fp2_rooms_core.h"

namespace esphome {
namespace fp2_rooms {

struct ZoneSlot {
  bool configured{false};
  std::string label;
  binary_sensor::BinarySensor *presence{nullptr};
  sensor::Sensor *count{nullptr};
  Presence filter;
  int16_t pub_count{-1};
  uint32_t pub_count_ms{0};
};

class FP2Rooms : public Component {
 public:
  void set_source(text_sensor::TextSensor *s) { this->source_ = s; }
  void set_room_presence(binary_sensor::BinarySensor *s) { this->room_presence_ = s; }
  void set_room_count(sensor::Sensor *s) { this->room_count_ = s; }
  void set_state_sensor(text_sensor::TextSensor *s) { this->state_sensor_ = s; }
  void add_zone(uint8_t slot, const std::string &label, binary_sensor::BinarySensor *presence, sensor::Sensor *count);

  void setup() override;
  void loop() override;
  void dump_config() override;
  float get_setup_priority() const override { return setup_priority::DATA; }

  /// Neues Layout im Textformat v2 (Rastermasken, siehe fp2_rooms_core.h). Speichert im Flash. Fehler -> false + Meldung.
  bool set_layout(const std::string &text, std::string &err);
  /// Layout löschen (alle Zustände gehen auf "aus")
  void clear_layout();
  /// Layout (Masken als Hex) + Raster + Diagnose als JSON (für api.respond)
  void layout_json(JsonObject root);

 protected:
  void on_frame_(const std::string &b64);
  void process_(const Target *t, uint8_t n, uint32_t now);
  void publish_(uint32_t now, bool force);
  void reset_filters_();

  text_sensor::TextSensor *source_{nullptr};
  binary_sensor::BinarySensor *room_presence_{nullptr};
  sensor::Sensor *room_count_{nullptr};
  text_sensor::TextSensor *state_sensor_{nullptr};
  ZoneSlot zones_[MAX_ZONES];

  Layout layout_{};
  // Layout in Blöcken <= 240 Byte (Host-Backend erlaubt max. 255 Byte je Eintrag) + Prüfsumme
  // (32 Zonen: 1432 Byte -> 6 Blöcke, Schlüssel fp2_rooms_layout_v3_0..5 und _sum)
  static constexpr size_t CHUNK = 240;
  static constexpr size_t N_CHUNKS = (sizeof(Layout) + CHUNK - 1) / CHUNK;  ESPPreferenceObject pref_chunks_[N_CHUNKS];
  ESPPreferenceObject pref_sum_;
  bool save_layout_();
  bool load_layout_(Layout &out);
  Presence room_filter_;
  int16_t pub_room_count_{-1};
  uint32_t pub_room_count_ms_{0};
  std::string last_state_json_;

  // Diagnose
  uint32_t frames_{0};
  uint32_t bad_frames_{0};
  uint32_t last_frame_ms_{0};
  uint32_t last_tick_ms_{0};
  uint32_t fps_t0_{0};
  uint32_t fps_frames_{0};
  float fps_{0};
  FrameResult last_result_{};
};

}  // namespace fp2_rooms
}  // namespace esphome
