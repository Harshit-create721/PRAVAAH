/* ============================================================================
   PRAVAAH - ESP32 sensor node, USB SERIAL transport
   ----------------------------------------------------------------------------
   Same wire contract as beltguard_node.ino, but over USB instead of WiFi.
   Written for demonstrating at a venue whose WiFi is unknown: nothing here
   needs an SSID, an IP, or a router that lets peers talk to each other.

   Each line printed to Serial that begins with '{' is one contract frame.
   `tools/serial-bridge.js` reads those lines, stamps `ts`, and republishes
   them to the same MQTT topics the dashboard already listens on. The server
   and the dashboard are unchanged and cannot tell the difference.

   ONE FIRMWARE, THREE BOARDS. The node scans I2C at boot and adopts a role
   from what answers, so the same binary goes on all three and no board needs
   its own build or a label that can be put on the wrong one:

       0x5A         -> MLX90614  -> thermal node
       0x53 / 0x1D  -> ADXL345   -> vibration node
       neither      -> A3144 on GPIO27 -> marker node

   THE ONE RULE, inherited from the project: if a value was not measured, its
   field is OMITTED. Never 0, never -1, never null. The dashboard renders an
   absent field as NO SIGNAL and cannot tell a placeholder from a reading.

   Libraries: ArduinoJson v7, Adafruit MLX90614.
   ==========================================================================*/

#include <Wire.h>
#include <ArduinoJson.h>
#include <Adafruit_MLX90614.h>

// ------------------------------------------------------------------ PINOUT
#define PIN_I2C_SDA   21
#define PIN_I2C_SCL   22
#define PIN_MARKER    27      // A3144 OUT

// --------------------------------------------------------------- CADENCE
static const uint32_t TELEMETRY_MS   = 500;   // 2 Hz, matches the contract
static const uint32_t VIB_SAMPLE_MS  = 5;     // 200 Hz accelerometer sampling
static const uint16_t VIB_MAX_SAMPLES = 128;
static const uint32_t MARKER_DEBOUNCE_US = 5000;

// --------------------------------------------------------- SPEED CALIBRATION
// The Hall sensor is the conveyor's speed sensor. RPM needs only the magnet
// count, so it is always published:
//     RPM = (pulses / MAGNETS_PER_REV) * 60 / window_seconds
// belt_speed additionally needs the circumference of the wheel the magnets ride
// on. Leave ROLLER_CIRC_MM at 0 and belt_speed is OMITTED rather than derived
// from a guessed diameter - a fabricated speed would feed the slip rule and
// produce fabricated alarms.
static const float MAGNETS_PER_REV = 1.0f;   // magnets glued to the roller/shaft
static const float ROLLER_CIRC_MM  = 0.0f;   // measured circumference, mm. 0 = unknown

// I2C addresses used for role detection.
static const uint8_t ADDR_MLX       = 0x5A;
static const uint8_t ADDR_ADXL_LOW  = 0x53;
static const uint8_t ADDR_ADXL_HIGH = 0x1D;

// ADXL345 registers
static const uint8_t ADXL_DEVID       = 0x00;
static const uint8_t ADXL_BW_RATE     = 0x2C;
static const uint8_t ADXL_POWER_CTL   = 0x2D;
static const uint8_t ADXL_DATA_FORMAT = 0x31;
static const uint8_t ADXL_DATAX0      = 0x32;
static const float   ADXL_LSB_PER_G   = 256.0f;

enum Role { ROLE_UNKNOWN, ROLE_THERMAL, ROLE_VIBRATION, ROLE_MARKER };

static Role     g_role   = ROLE_UNKNOWN;
static const char *g_nodeId = "esp32-unknown";
static uint8_t  g_adxlAddr = ADDR_ADXL_LOW;
static uint32_t g_seq = 0;

Adafruit_MLX90614 mlx = Adafruit_MLX90614();
static bool g_mlxOk = false;

// ---------------------------------------------------------- marker ISR state
// Written in interrupt context, read with interrupts masked.
static volatile uint32_t g_markerCount = 0;
static volatile uint32_t g_markerDtUs  = 0;
static volatile bool     g_markerFresh = false;
static volatile uint32_t g_lastEdgeUs  = 0;

// One FALLING edge occurs exactly once per magnet passage whether the module
// is active-low (bare A3144) or active-high (breakout with a comparator), so
// counting this edge is polarity-independent.
static void IRAM_ATTR markerIsr() {
  uint32_t now = micros();
  uint32_t dt  = now - g_lastEdgeUs;
  if (dt < MARKER_DEBOUNCE_US) return;      // contact bounce / electrical noise
  if (g_lastEdgeUs != 0) { g_markerDtUs = dt; g_markerFresh = true; }
  g_lastEdgeUs = now;
  g_markerCount++;
}

// ============================================================ I2C helpers ==

static bool i2cProbe(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

static bool adxlWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(g_adxlAddr);
  Wire.write(reg); Wire.write(val);
  return Wire.endTransmission() == 0;
}

static bool adxlRead(uint8_t reg, uint8_t *buf, uint8_t n) {
  Wire.beginTransmission(g_adxlAddr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;   // repeated START
  if (Wire.requestFrom((int)g_adxlAddr, (int)n) != n) return false;
  for (uint8_t i = 0; i < n; i++) buf[i] = Wire.read();
  return true;
}

static bool adxlMagnitude(float *mag) {
  uint8_t b[6];
  if (!adxlRead(ADXL_DATAX0, b, 6)) return false;
  float x = (int16_t)((b[1] << 8) | b[0]) / ADXL_LSB_PER_G;
  float y = (int16_t)((b[3] << 8) | b[2]) / ADXL_LSB_PER_G;
  float z = (int16_t)((b[5] << 8) | b[4]) / ADXL_LSB_PER_G;
  *mag = sqrtf(x * x + y * y + z * z);
  return true;
}

// ====================================================== vibration window ===
// Buffers one telemetry window of |a| samples. Gravity is a large DC term, so
// every statistic below is computed on the deviation from the window mean --
// that is the vibration, and the 1 g offset is not.

static float    g_vibBuf[VIB_MAX_SAMPLES];
static uint16_t g_vibN = 0;

static void vibReset() { g_vibN = 0; }

static void vibPush(float mag) {
  if (g_vibN < VIB_MAX_SAMPLES) g_vibBuf[g_vibN++] = mag;
}

// Returns false when the window holds too few samples to say anything.
static bool vibStats(float *rms, float *kurtosis, float *crest) {
  if (g_vibN < 8) return false;

  double sum = 0;
  for (uint16_t i = 0; i < g_vibN; i++) sum += g_vibBuf[i];
  double mean = sum / g_vibN;

  double m2 = 0, m4 = 0, peak = 0;
  for (uint16_t i = 0; i < g_vibN; i++) {
    double d = g_vibBuf[i] - mean;
    double d2 = d * d;
    m2 += d2;
    m4 += d2 * d2;
    if (fabs(d) > peak) peak = fabs(d);
  }
  double var = m2 / g_vibN;
  *rms = sqrt(var);

  // Below the sensor's own noise floor these two are meaningless: kurtosis
  // divides by variance squared and crest by the RMS. Report neither rather
  // than an artefact of dividing by nearly zero.
  if (var < 1e-8) return false;

  *kurtosis = (float)((m4 / g_vibN) / (var * var));
  *crest    = (float)(peak / sqrt(var));
  return true;
}

// ========================================================= role detection ==

static void detectRole() {
  Serial.println(F("scanning I2C to determine node role..."));

  bool mlxPresent  = i2cProbe(ADDR_MLX);
  bool adxlLow     = i2cProbe(ADDR_ADXL_LOW);
  bool adxlHigh    = i2cProbe(ADDR_ADXL_HIGH);

  Serial.printf("  0x5A MLX90614 : %s\n", mlxPresent ? "yes" : "no");
  Serial.printf("  0x53 ADXL345  : %s\n", adxlLow  ? "yes" : "no");
  Serial.printf("  0x1D ADXL345  : %s\n", adxlHigh ? "yes" : "no");

  if (mlxPresent) {
    g_role = ROLE_THERMAL;
    g_nodeId = "esp32-thermal-01";
    g_mlxOk = mlx.begin(ADDR_MLX, &Wire);
  } else if (adxlLow || adxlHigh) {
    g_role = ROLE_VIBRATION;
    g_nodeId = "esp32-vibration-01";
    g_adxlAddr = adxlLow ? ADDR_ADXL_LOW : ADDR_ADXL_HIGH;

    uint8_t devid = 0;
    adxlRead(ADXL_DEVID, &devid, 1);
    Serial.printf("  ADXL345 DEVID = 0x%02X (expect 0xE5)\n", devid);

    // FULL_RES at +/-8g: a hand-shake exceeds 2 g and would clip, flattening
    // the peaks the statistics are made of. FULL_RES keeps 4 mg/LSB anyway.
    adxlWrite(ADXL_DATA_FORMAT, 0x0A);
    adxlWrite(ADXL_BW_RATE, 0x0C);       // 200 Hz, matches VIB_SAMPLE_MS
    adxlWrite(ADXL_POWER_CTL, 0x08);     // leave standby
  } else {
    g_role = ROLE_MARKER;
    g_nodeId = "esp32-marker-01";
    pinMode(PIN_MARKER, INPUT_PULLUP);
    attachInterrupt(digitalPinToInterrupt(PIN_MARKER), markerIsr, FALLING);
  }

  const char *name = g_role == ROLE_THERMAL   ? "THERMAL (MLX90614)"
                   : g_role == ROLE_VIBRATION ? "VIBRATION (ADXL345)"
                                              : "MARKER (A3144 on GPIO27)";
  Serial.printf("role: %s   node id: %s\n", name, g_nodeId);
  Serial.println(F("emitting contract frames; lines starting with '{' are data"));
}

// ============================================================= publishers ==
// `ts` is deliberately absent: the ESP32 has no RTC, so the bridge stamps each
// frame with the laptop's clock on arrival. That is accurate to the USB hop.

static void emit(JsonDocument &doc) {
  serializeJson(doc, Serial);
  Serial.println();
}

static void publishTelemetry() {
  JsonDocument doc;
  doc["kind"] = "telemetry";
  doc["node"] = g_nodeId;
  doc["seq"]  = ++g_seq;
  JsonObject health = doc["sensor_health"].to<JsonObject>();

  if (g_role == ROLE_THERMAL) {
    if (g_mlxOk) {
      double obj = mlx.readObjectTempC();
      double amb = mlx.readAmbientTempC();
      bool any = false;
      if (!isnan(obj) && obj > -40 && obj < 380) { doc["temperature"] = round(obj * 100) / 100.0; any = true; }
      if (!isnan(amb) && amb > -40 && amb < 125) { doc["ambient"]     = round(amb * 100) / 100.0; any = true; }
      health["mlx"] = any ? "healthy" : "fault";
    } else {
      health["mlx"] = "fault";
    }
  } else if (g_role == ROLE_VIBRATION) {
    float rms, kurt, crest;
    if (vibStats(&rms, &kurt, &crest)) {
      doc["vibration_rms"] = round(rms * 10000) / 10000.0;
      // Schema caps these at 100; past that they are numerical artefacts.
      if (kurt  < 100) doc["vibration_kurtosis"] = round(kurt  * 1000) / 1000.0;
      if (crest < 100) doc["vibration_crest"]    = round(crest * 1000) / 1000.0;
      health["vibration"] = "healthy";
    } else if (g_vibN >= 8) {
      // Sampling fine, but the board is dead still - RMS alone is honest.
      float r2, k2, c2;
      (void)k2; (void)c2;
      double sum = 0;
      for (uint16_t i = 0; i < g_vibN; i++) sum += g_vibBuf[i];
      double mean = sum / g_vibN, m2 = 0;
      for (uint16_t i = 0; i < g_vibN; i++) { double d = g_vibBuf[i] - mean; m2 += d * d; }
      r2 = (float)sqrt(m2 / g_vibN);
      doc["vibration_rms"] = round(r2 * 10000) / 10000.0;
      health["vibration"] = "healthy";
    } else {
      health["vibration"] = "stale";
    }
    vibReset();
  } else {
    // Rotation speed from the Hall pulse train over the window just elapsed.
    static uint32_t lastCount = 0;
    static uint32_t lastRpmMs = 0;
    uint32_t nowMs = millis();

    noInterrupts();
    uint32_t count = g_markerCount;
    interrupts();

    if (lastRpmMs != 0) {
      uint32_t dtMs = nowMs - lastRpmMs;
      uint32_t pulses = count - lastCount;
      if (dtMs > 0) {
        float revs = pulses / MAGNETS_PER_REV;
        float rpm  = revs * 60000.0f / dtMs;
        // A measured zero is a real reading here - it means "not turning" -
        // so unlike an absent sensor this IS published, and the dashboard
        // reports the belt as stopped rather than as unmonitored.
        if (rpm >= 0 && rpm <= 6000) {
          doc["motor_rpm"] = (int)(rpm + 0.5f);
          if (ROLLER_CIRC_MM > 0.0f) {
            float mps = (rpm / 60.0f) * (ROLLER_CIRC_MM / 1000.0f);
            if (mps >= 0 && mps <= 12) doc["belt_speed"] = round(mps * 1000) / 1000.0;
          }
        }
      }
    }
    lastCount = count;
    lastRpmMs = nowMs;
    health["speed"] = "healthy";
  }

  emit(doc);
}

static void publishJointPass() {
  noInterrupts();
  uint32_t dtUs = g_markerDtUs;
  uint32_t cnt  = g_markerCount;
  g_markerFresh = false;
  interrupts();

  JsonDocument doc;
  doc["kind"]     = "joint";
  doc["node"]     = g_nodeId;
  doc["joint_id"] = "J01";          // identity of the one physical marker
  doc["lap"]      = cnt;
  doc["joint_marker_dt_left"] = round((dtUs / 1000.0) * 100) / 100.0;

  // belt_speed and marker_distance_* are omitted on purpose: they need the
  // wheel circumference and pulses-per-rev of a real rig. Publishing them from
  // assumed geometry would be a fabricated measurement.
  emit(doc);
}

// =================================================================== main ==

void setup() {
  Serial.begin(115200);
  delay(400);
  Serial.println();
  Serial.println(F("=== PRAVAAH serial node ==="));

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, 100000);
  delay(100);

  detectRole();
}

void loop() {
  static uint32_t lastTelemetry = 0;
  static uint32_t lastVibSample = 0;
  uint32_t now = millis();

  if (g_role == ROLE_VIBRATION && now - lastVibSample >= VIB_SAMPLE_MS) {
    lastVibSample = now;
    float mag;
    if (adxlMagnitude(&mag)) vibPush(mag);
  }

  if (g_role == ROLE_MARKER && g_markerFresh) publishJointPass();

  if (now - lastTelemetry >= TELEMETRY_MS) {
    lastTelemetry = now;
    publishTelemetry();
  }
}
