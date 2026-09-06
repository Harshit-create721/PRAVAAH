/* PRAVAAH USB sensor nodes: MLX90614, ADXL345, Hall on GPIO27.
   One sketch detects the attached I2C sensor. Missing/invalid measurements are
   omitted. Firmware diagnostics travel with each frame for recording/debugging.
   See docs/sensor-debugging.md for the measured rig configuration. */
#include <Wire.h>
#include <ArduinoJson.h>
#include <soc/gpio_reg.h>
#include <soc/soc.h>
#include "sensor_math.h"

#define PIN_I2C_SDA 21
#define PIN_I2C_SCL 22
#define PIN_MARKER 27
static const char *FIRMWARE = "pravaah-serial-node 0.2.2";
static const uint32_t TELEMETRY_MS = 500;
static const uint16_t VIB_MAX_SAMPLES = 128;
// Filled only from the physical magnet arrangement, not from pulse frequency.
static const float MAGNETS_PER_CYCLE = 1.0f;
static const float BELT_LENGTH_M = 1.2f; // user supplied 120 cm; used only for a belt-mounted magnet
static const bool HALL_ON_BELT = true; // confirmed: one taped magnet returns once per full loop

static const uint8_t ADDR_MLX = 0x5A;
static const uint8_t ADXL_DEVID = 0x00, ADXL_BW_RATE = 0x2C;
static const uint8_t ADXL_POWER_CTL = 0x2D, ADXL_DATA_FORMAT = 0x31;
static const uint8_t ADXL_DATAX0 = 0x32, ADXL_FIFO_CTL = 0x38, ADXL_FIFO_STATUS = 0x39;
static const float ADXL_LSB_PER_G = 256.0f;
enum Role { ROLE_UNKNOWN, ROLE_THERMAL, ROLE_VIBRATION, ROLE_MARKER };
static Role g_role = ROLE_UNKNOWN;
static const char *g_nodeId = "esp32-unknown";
static uint8_t g_adxlAddr = 0x53;
static bool g_adxlOk = false;
static uint32_t g_seq = 0, g_readErrors = 0, g_invalidSamples = 0, g_fifoOverruns = 0;
static uint16_t g_vibN = 0;
static bool g_windowFault = false, g_clipped = false;
static pravaah::Acceleration g_samples[VIB_MAX_SAMPLES];
static pravaah::HallPeriod g_hall;
static pravaah::HallPulseFilter g_hallFilter;
static volatile uint32_t g_rawEdges = 0, g_edgeOverflows = 0;
static volatile uint32_t g_edgeTimes[128];
static volatile uint8_t g_edgeLevels[128], g_edgeWrite = 0, g_edgeRead = 0;

static void IRAM_ATTR markerIsr() {
  const uint8_t level = (REG_READ(GPIO_IN_REG) >> PIN_MARKER) & 1;
  const uint32_t now = micros();
  ++g_rawEdges;
  const uint8_t next = (g_edgeWrite + 1) & 127;
  if (next == g_edgeRead) { ++g_edgeOverflows; return; }
  g_edgeTimes[g_edgeWrite] = now;
  g_edgeLevels[g_edgeWrite] = level;
  g_edgeWrite = next;
}

static bool i2cProbe(uint8_t address) {
  Wire.beginTransmission(address);
  return Wire.endTransmission() == 0;
}

static bool readRegisters(uint8_t address, uint8_t reg, uint8_t *out, uint8_t n) {
  Wire.beginTransmission(address); Wire.write(reg);
  if (Wire.endTransmission(false) != 0 || Wire.requestFrom((int)address, (int)n) != n) {
    ++g_readErrors; return false;
  }
  for (uint8_t i = 0; i < n; ++i) out[i] = Wire.read();
  return true;
}

static bool adxlWrite(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(g_adxlAddr); Wire.write(reg); Wire.write(value);
  return Wire.endTransmission() == 0;
}

static bool initAdxl() {
  uint8_t id = 0, format = 0, rate = 0, power = 0, fifo = 0;
  bool ok = readRegisters(g_adxlAddr, ADXL_DEVID, &id, 1) && id == 0xE5;
  ok = ok && adxlWrite(ADXL_POWER_CTL, 0) && adxlWrite(ADXL_DATA_FORMAT, 0x0A)
    && adxlWrite(ADXL_BW_RATE, 0x0B) // 200 Hz ODR, 100 Hz bandwidth (0x0C is 400 Hz)
    && adxlWrite(ADXL_FIFO_CTL, 0) && adxlWrite(ADXL_FIFO_CTL, 0x80)
    && adxlWrite(ADXL_POWER_CTL, 0x08);
  ok = ok && readRegisters(g_adxlAddr, ADXL_DATA_FORMAT, &format, 1)
    && readRegisters(g_adxlAddr, ADXL_BW_RATE, &rate, 1)
    && readRegisters(g_adxlAddr, ADXL_POWER_CTL, &power, 1)
    && readRegisters(g_adxlAddr, ADXL_FIFO_CTL, &fifo, 1)
    && format == 0x0A && rate == 0x0B && power == 0x08 && fifo == 0x80;
  Serial.printf("ADXL id=0x%02X format=0x%02X rate=0x%02X power=0x%02X fifo=0x%02X verified=%d\n",
    id, format, rate, power, fifo, ok);
  return ok;
}

static bool readTemperature(uint8_t reg, float &value) {
  uint8_t reply[3];
  for (int attempt = 0; attempt < 3; ++attempt) {
    if (!readRegisters(ADDR_MLX, reg, reply, 3)) continue;
    if (pravaah::mlxTemperature(ADDR_MLX, reg, reply, value)) return true;
    ++g_readErrors;
  }
  return false;
}

static void collectAcceleration() {
  if (!g_adxlOk) return;
  uint8_t status;
  if (!readRegisters(g_adxlAddr, ADXL_FIFO_STATUS, &status, 1)) { g_windowFault = true; return; }
  const uint8_t available = status & 0x3F;
  if (available >= 32) { ++g_fifoOverruns; g_windowFault = true; }
  if (available > 32) { ++g_invalidSamples; g_windowFault = true; return; }
  for (uint8_t i = 0; i < available; ++i) {
    uint8_t b[6];
    if (!readRegisters(g_adxlAddr, ADXL_DATAX0, b, 6)) { g_windowFault = true; return; }
    const int16_t raw[3] = {(int16_t)((b[1] << 8) | b[0]), (int16_t)((b[3] << 8) | b[2]), (int16_t)((b[5] << 8) | b[4])};
    bool valid = true;
    for (int axis = 0; axis < 3; ++axis) {
      valid = valid && pravaah::validAdxlRaw(raw[axis]);
      if (pravaah::clippedAdxlRaw(raw[axis])) g_clipped = true;
    }
    if (!valid) { ++g_invalidSamples; g_windowFault = true; continue; }
    if (g_vibN >= VIB_MAX_SAMPLES) { g_windowFault = true; continue; }
    g_samples[g_vibN++] = {raw[0] / ADXL_LSB_PER_G, raw[1] / ADXL_LSB_PER_G, raw[2] / ADXL_LSB_PER_G};
  }
}

static void detectRole() {
  // Retry the boot probe so a slow power-up does not silently become a Hall node.
  for (int attempt = 0; attempt < 5 && g_role == ROLE_UNKNOWN; ++attempt) {
    if (i2cProbe(ADDR_MLX)) { g_role = ROLE_THERMAL; g_nodeId = "esp32-thermal-01"; }
    else if (i2cProbe(0x53) || i2cProbe(0x1D)) {
      g_adxlAddr = i2cProbe(0x53) ? 0x53 : 0x1D;
      g_role = ROLE_VIBRATION; g_nodeId = "esp32-vibration-01"; g_adxlOk = initAdxl();
    } else delay(100);
  }
  if (g_role == ROLE_UNKNOWN) {
    g_role = ROLE_MARKER; g_nodeId = "esp32-marker-01";
    pinMode(PIN_MARKER, INPUT_PULLUP);
    g_hallFilter.high = digitalRead(PIN_MARKER) == HIGH;
    g_hallFilter.changedUs = micros();
    attachInterrupt(digitalPinToInterrupt(PIN_MARKER), markerIsr, CHANGE);
  }
  Serial.printf("role node=%s firmware=%s\n", g_nodeId, FIRMWARE);
}

static void emit(JsonDocument &doc) {
  serializeJson(doc, Serial); Serial.println();
}

static void pollHall() {
  while (g_edgeRead != g_edgeWrite) {
    noInterrupts();
    const uint32_t at = g_edgeTimes[g_edgeRead];
    const uint8_t level = g_edgeLevels[g_edgeRead];
    g_edgeRead = (g_edgeRead + 1) & 127;
    interrupts();
    uint32_t arrival;
    if (g_hallFilter.transition(at, level == HIGH, arrival)) g_hall.edge(arrival);
  }
}

static void publishTelemetry() {
  JsonDocument doc;
  doc["kind"] = "telemetry"; doc["node"] = g_nodeId; doc["seq"] = ++g_seq;
  doc["firmware"] = FIRMWARE;
  JsonObject health = doc["sensor_health"].to<JsonObject>();
  JsonObject debug = doc["diagnostics"].to<JsonObject>();
  if (g_role == ROLE_THERMAL) {
    float object, ambient;
    const bool objOk = readTemperature(0x07, object), ambOk = readTemperature(0x06, ambient);
    if (objOk) doc["temperature"] = round(object * 100) / 100.0;
    if (ambOk) doc["ambient"] = round(ambient * 100) / 100.0;
    health["mlx"] = objOk && ambOk ? "healthy" : "fault";
    debug["read_errors"] = g_readErrors;
    debug["pec_checked"] = true;
  } else if (g_role == ROLE_VIBRATION) {
    pravaah::VibrationStats stats;
    debug["samples"] = g_vibN; debug["odr_hz"] = 200;
    debug["read_errors"] = g_readErrors; debug["invalid_samples"] = g_invalidSamples;
    debug["fifo_overruns"] = g_fifoOverruns;
    // One corrupt/clipped sample invalidates the window; do not hide it by
    // dropping the sample and calculating a reassuring RMS from what remains.
    if (g_adxlOk && !g_windowFault && !g_clipped && pravaah::vibrationStats(g_samples, g_vibN, stats)) {
      doc["acceleration_x"] = round(stats.mean.x * 10000) / 10000.0;
      doc["acceleration_y"] = round(stats.mean.y * 10000) / 10000.0;
      doc["acceleration_z"] = round(stats.mean.z * 10000) / 10000.0;
      doc["acceleration_magnitude"] = round(stats.magnitude * 10000) / 10000.0;
      doc["vibration_rms"] = round(stats.rms * 10000) / 10000.0;
      if (stats.ratiosValid) {
        doc["vibration_crest"] = round(stats.crest * 1000) / 1000.0;
        doc["vibration_kurtosis"] = round(stats.kurtosis * 1000) / 1000.0;
      }
      health["vibration"] = "healthy";
    } else health["vibration"] = g_windowFault || !g_adxlOk ? "fault" : g_clipped ? "clipped" : "stale";
    g_vibN = 0; g_windowFault = g_clipped = false;
  } else {
    float rpm;
    const uint32_t now = micros();
    const bool measured = g_hall.rpm(now, MAGNETS_PER_CYCLE, rpm);
    if (measured) {
      doc["hall_rpm"] = round(rpm * 100) / 100.0;
      if (HALL_ON_BELT && BELT_LENGTH_M > 0) doc["belt_speed"] = round(rpm / 60 * BELT_LENGTH_M * 10000) / 10000.0;
    }
    health["speed"] = measured ? (rpm > 0 ? "healthy" : "stale") : "missing";
    debug["pulses"] = g_hall.count; debug["raw_edges"] = g_rawEdges;
    debug["period_ms"] = g_hall.periodUs / 1000.0;
    if (g_hall.seen) debug["last_pulse_age_ms"] = (now - g_hall.lastEdgeUs) / 1000;
    debug["pin_level"] = digitalRead(PIN_MARKER);
    debug["low_pulses"] = g_hallFilter.lowPulses;
    debug["last_low_us"] = g_hallFilter.lastLowUs;
    debug["max_low_us"] = g_hallFilter.maxLowUs;
    debug["edge_overflows"] = g_edgeOverflows;
    debug["magnets_per_cycle"] = MAGNETS_PER_CYCLE;
    debug["hall_target"] = HALL_ON_BELT ? "belt" : "unconfirmed";
  }
  emit(doc);
}

void setup() {
  Serial.begin(115200); delay(400);
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, 100000); Wire.setTimeOut(20); delay(100);
  detectRole();
}

void loop() {
  static uint32_t lastTelemetry = millis(), lastSamplePoll = 0, lastRetry = 0;
  const uint32_t now = millis();
  if (g_role == ROLE_VIBRATION && now - lastSamplePoll >= 2) {
    lastSamplePoll = now; collectAcceleration();
    if (!g_adxlOk && now - lastRetry >= 3000) { lastRetry = now; g_adxlOk = initAdxl(); }
  }
  if (g_role == ROLE_MARKER) pollHall();
  if (now - lastTelemetry >= TELEMETRY_MS) { lastTelemetry = now; publishTelemetry(); }
}
