/* ============================================================================
   BeltGuard Edge - ESP32 sensor node
   SIH26008 / Ministry of Steel - conveyor belt joint rupture prediction
   ----------------------------------------------------------------------------
   Publishes the exact MQTT contract the dashboard consumes.

   THE ONE RULE: if a sensor is not fitted or not reading, its field is
   OMITTED from the JSON. Never publish 0.0 as a placeholder - the dashboard
   shows an absent field as "NO SIGNAL" and cannot tell a fake zero from a
   real one. Every ENABLE_* flag below is off by default for that reason.
   Turn one on only once that sensor is physically wired and reading.

   Arduino IDE / arduino-cli setup
     Board manager URL : https://espressif.github.io/arduino-esp32/package_esp32_index.json
     Board             : ESP32 Dev Module
     Libraries         : PubSubClient (Nick O'Leary)
                         ArduinoJson  (Benoit Blanchon, v7)
                         Adafruit ADXL345 + Adafruit Unified Sensor
                         Adafruit MLX90614
                         EmonLib (only if you use the SCT-013 CT)
   ==========================================================================*/

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Wire.h>

// ---------------------------------------------------------------- IDENTITY

#define WIFI_SSID      "CHANGE_ME"
#define WIFI_PASS      "CHANGE_ME"
#define MQTT_HOST      "192.168.1.100"   // the laptop running `npm start`
#define MQTT_PORT      1883
#define MQTT_USER      ""                // leave "" unless set in server/config.js
#define MQTT_PASS      ""

#define SITE           "factory"
#define CONVEYOR_ID    "CV-01"
#define NODE_ID        "esp32-drive-01"
#define FIRMWARE       "beltguard-node 0.1.0"

// ------------------------------------------------------ SENSOR ENABLE FLAGS
// Flip to 1 only when the sensor is wired AND you have seen it read.

#define ENABLE_SPEED    0   // LM393 slot sensor / Hall on a roller  -> belt_speed, motor_rpm
#define ENABLE_MARKER   0   // second slot/Hall/reed for the joint fiducial -> joint passes
#define ENABLE_MARKER_R 0   // right-edge marker sensor (asymmetry needs both)
#define ENABLE_ADXL     0   // ADXL345 on the drive frame -> vibration_rms/kurtosis/crest
#define ENABLE_CT       0   // SCT-013 through a burden + bias network -> motor_current_rms
#define ENABLE_MLX      0   // MLX90614 IR -> temperature + ambient

// ------------------------------------------------------------------ PINOUT
// ESP32 DevKit v1. Avoid GPIO 6-11 (flash) and the strapping pins 0/2/12/15
// for inputs that are pulled at boot.

#define PIN_SPEED       27   // LM393 D0  (interrupt)
#define PIN_MARKER_L    26   // left  joint marker (interrupt)
#define PIN_MARKER_R    25   // right joint marker (interrupt)
#define PIN_CT          34   // SCT-013 conditioned output (ADC1, input-only)
#define PIN_I2C_SDA     21   // ADXL345 + MLX90614 share the bus
#define PIN_I2C_SCL     22

// ------------------------------------------------------------ CALIBRATION
// MEASURE these on your rig. They are not guesses you can leave alone -
// belt_speed is wrong if they are wrong, and every derived rule follows it.

const float PULSES_PER_REV   = 20.0f;   // slots in the encoder disc
const float WHEEL_CIRC_MM    = 314.16f; // circumference of the wheel it watches
const float GEAR_RATIO       = 1.0f;    // motor rev : measured-wheel rev
const float CT_CALIBRATION   = 60.6f;   // EmonLib constant: turns / burden ohms
const float BELT_LENGTH_MM   = 0.0f;    // 0 = unknown; used only for a sanity check

const uint32_t TELEMETRY_MS  = 500;     // 2 Hz. Do not go below 100 ms on WiFi.
const uint32_t STATUS_MS     = 10000;
const uint32_t VIB_WINDOW_MS = 400;     // accelerometer accumulation window

// ============================================================================

WiFiClient net;
PubSubClient mqtt(net);

char topicTelemetry[96], topicJoint[96], topicStatus[112];

// ---- speed / marker ISR state ---------------------------------------------
volatile uint32_t speedPulses = 0;
volatile uint32_t markerCountL = 0, markerCountR = 0;
volatile uint32_t lastMarkerUsL = 0, lastMarkerUsR = 0;
volatile uint32_t markerDtUsL = 0, markerDtUsR = 0;
volatile bool     markerFreshL = false, markerFreshR = false;

void IRAM_ATTR isrSpeed()  { speedPulses++; }

void IRAM_ATTR isrMarkerL() {
  uint32_t now = micros();
  if (now - lastMarkerUsL < 20000) return;          // 20 ms debounce
  if (lastMarkerUsL) { markerDtUsL = now - lastMarkerUsL; markerFreshL = true; }
  lastMarkerUsL = now;
  markerCountL++;
}

void IRAM_ATTR isrMarkerR() {
  uint32_t now = micros();
  if (now - lastMarkerUsR < 20000) return;
  if (lastMarkerUsR) { markerDtUsR = now - lastMarkerUsR; markerFreshR = true; }
  lastMarkerUsR = now;
  markerCountR++;
}

// ---- optional sensor objects ----------------------------------------------
#if ENABLE_ADXL
  #include <Adafruit_Sensor.h>
  #include <Adafruit_ADXL345_U.h>
  Adafruit_ADXL345_Unified adxl(12345);
  bool adxlOk = false;
#endif

#if ENABLE_MLX
  #include <Adafruit_MLX90614.h>
  Adafruit_MLX90614 mlx = Adafruit_MLX90614();
  bool mlxOk = false;
#endif

#if ENABLE_CT
  #include <EmonLib.h>
  EnergyMonitor emon;
  bool ctOk = false;
#endif

// ---- rolling vibration statistics ------------------------------------------
struct VibStats {
  uint32_t n = 0;
  double sum = 0, sum2 = 0, sum3 = 0, sum4 = 0, peak = 0;
  void add(double a) {
    n++; double a2 = a * a;
    sum += a; sum2 += a2; sum3 += a2 * a; sum4 += a2 * a2;
    if (fabs(a) > peak) peak = fabs(a);
  }
  bool ready() const { return n >= 32; }
  double rms()  const { return sqrt(sum2 / n); }
  double mean() const { return sum / n; }
  double sd() const {
    double m = mean();
    double v = sum2 / n - m * m;
    return v > 0 ? sqrt(v) : 0;
  }
  double kurtosis() const {
    double m = mean(), s = sd();
    if (s <= 1e-9) return 0;
    double m4 = sum4 / n - 4 * m * sum3 / n + 6 * m * m * sum2 / n - 3 * m * m * m * m;
    return m4 / (s * s * s * s);
  }
  double crest() const { double r = rms(); return r > 1e-9 ? peak / r : 0; }
  void reset() { n = 0; sum = sum2 = sum3 = sum4 = 0; peak = 0; }
};
VibStats vib, vibEvent;

uint32_t lastTelemetry = 0, lastStatus = 0, lastVibSample = 0, lastSpeedCalc = 0;
uint32_t seq = 0, lapCount = 0;
float beltSpeed = NAN, motorRpm = NAN;

// ============================================================ SETUP =========

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println(F("BeltGuard Edge node booting"));

  snprintf(topicTelemetry, sizeof(topicTelemetry), "beltguard/%s/%s/telemetry", SITE, CONVEYOR_ID);
  snprintf(topicJoint,     sizeof(topicJoint),     "beltguard/%s/%s/joint",     SITE, CONVEYOR_ID);
  snprintf(topicStatus,    sizeof(topicStatus),    "beltguard/%s/%s/node/%s/status", SITE, CONVEYOR_ID, NODE_ID);

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);

#if ENABLE_SPEED
  pinMode(PIN_SPEED, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(PIN_SPEED), isrSpeed, FALLING);
#endif
#if ENABLE_MARKER
  pinMode(PIN_MARKER_L, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(PIN_MARKER_L), isrMarkerL, FALLING);
#endif
#if ENABLE_MARKER_R
  pinMode(PIN_MARKER_R, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(PIN_MARKER_R), isrMarkerR, FALLING);
#endif
#if ENABLE_ADXL
  adxlOk = adxl.begin();
  if (adxlOk) { adxl.setRange(ADXL345_RANGE_16_G); adxl.setDataRate(ADXL345_DATARATE_800_HZ); }
  Serial.println(adxlOk ? F("ADXL345 ok") : F("ADXL345 NOT FOUND - vibration will be omitted"));
#endif
#if ENABLE_MLX
  mlxOk = mlx.begin();
  Serial.println(mlxOk ? F("MLX90614 ok") : F("MLX90614 NOT FOUND - temperature will be omitted"));
#endif
#if ENABLE_CT
  analogReadResolution(12);
  emon.current(PIN_CT, CT_CALIBRATION);
  ctOk = true;
  Serial.println(F("CT configured - verify against a clamp meter before trusting it"));
#endif

  connectWiFi();
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(1024);
}

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print(F("WiFi"));
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) { delay(400); Serial.print('.'); }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) Serial.println(WiFi.localIP());
  else Serial.println(F("WiFi FAILED - will retry"));
}

void connectMqtt() {
  if (mqtt.connected()) return;
  Serial.print(F("MQTT connect... "));
  // Last will: if this node drops, the dashboard marks it offline immediately.
  const char* willMsg = "{\"online\":false}";
  bool ok = (strlen(MQTT_USER) > 0)
    ? mqtt.connect(NODE_ID, MQTT_USER, MQTT_PASS, topicStatus, 1, true, willMsg)
    : mqtt.connect(NODE_ID, topicStatus, 1, true, willMsg);
  Serial.println(ok ? F("ok") : F("failed"));
  if (ok) publishStatus();
}

// ============================================================= LOOP ========

void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWiFi();
  connectMqtt();
  mqtt.loop();

  uint32_t now = millis();

#if ENABLE_ADXL
  if (adxlOk && now - lastVibSample >= 2) {         // ~500 Hz
    lastVibSample = now;
    sensors_event_t e;
    adxl.getEvent(&e);
    double g = sqrt(e.acceleration.x * e.acceleration.x +
                    e.acceleration.y * e.acceleration.y +
                    e.acceleration.z * e.acceleration.z) / 9.80665 - 1.0;
    vib.add(g);
    vibEvent.add(g);
  }
#endif

#if ENABLE_SPEED
  if (now - lastSpeedCalc >= 250) {
    noInterrupts();
    uint32_t p = speedPulses; speedPulses = 0;
    interrupts();
    float dt = (now - lastSpeedCalc) / 1000.0f;
    lastSpeedCalc = now;
    float revs = p / PULSES_PER_REV;
    beltSpeed = (revs * (WHEEL_CIRC_MM / 1000.0f)) / dt;   // m/s
    motorRpm  = (revs / dt) * 60.0f * GEAR_RATIO;
  }
#endif

#if ENABLE_MARKER
  if (markerFreshL) { publishJointPass(); }
#endif

  if (now - lastTelemetry >= TELEMETRY_MS) { lastTelemetry = now; publishTelemetry(); }
  if (now - lastStatus    >= STATUS_MS)    { lastStatus = now;    publishStatus(); }
}

// ======================================================== PUBLISHERS =======

void publishTelemetry() {
  if (!mqtt.connected()) return;

  JsonDocument doc;
  doc["ts"]   = nowMillisEpoch();
  doc["node"] = NODE_ID;
  doc["seq"]  = ++seq;

  JsonObject health = doc["sensor_health"].to<JsonObject>();

#if ENABLE_SPEED
  if (!isnan(beltSpeed)) { doc["belt_speed"] = round3(beltSpeed); doc["motor_rpm"] = (int)motorRpm; }
  health["speed"] = "healthy";
#else
  health["speed"] = "missing";
#endif

#if ENABLE_ADXL
  if (adxlOk && vib.ready()) {
    doc["vibration_rms"]      = round4(vib.rms());
    doc["vibration_kurtosis"] = round3(vib.kurtosis());
    doc["vibration_crest"]    = round3(vib.crest());
    vib.reset();
    health["vibration"] = "healthy";
  } else {
    health["vibration"] = adxlOk ? "stale" : "fault";
  }
#else
  health["vibration"] = "missing";
#endif

#if ENABLE_CT
  if (ctOk) {
    double irms = emon.calcIrms(1480);
    // Below ~0.15 A the SCT-013 reads its own noise floor. Report nothing
    // rather than a number that would look like a real light load.
    if (irms >= 0.15) { doc["motor_current_rms"] = round3(irms); health["ct"] = "healthy"; }
    else              { health["ct"] = "healthy"; }
  }
#else
  health["ct"] = "missing";
#endif

#if ENABLE_MLX
  if (mlxOk) {
    double obj = mlx.readObjectTempC(), amb = mlx.readAmbientTempC();
    if (!isnan(obj) && obj > -40 && obj < 380) doc["temperature"] = round2(obj);
    if (!isnan(amb) && amb > -40 && amb < 125) doc["ambient"]     = round2(amb);
    health["mlx"] = "healthy";
  } else {
    health["mlx"] = "fault";
  }
#else
  health["mlx"] = "missing";
#endif

  char buf[768];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  mqtt.publish(topicTelemetry, (const uint8_t*)buf, n, false);
}

#if ENABLE_MARKER
void publishJointPass() {
  noInterrupts();
  uint32_t dtL = markerDtUsL; bool freshL = markerFreshL; markerFreshL = false;
  uint32_t dtR = markerDtUsR; bool freshR = markerFreshR; markerFreshR = false;
  uint32_t cnt = markerCountL;
  interrupts();
  if (!freshL) return;

  lapCount = cnt;

  JsonDocument doc;
  doc["ts"]   = nowMillisEpoch();
  doc["node"] = NODE_ID;
  doc["lap"]  = lapCount;

  // Single physical marker per belt loop -> one joint. If your belt has
  // several splices, give each its own marker pattern (or an RFID tag) and
  // set joint_id from that. "J01" is the identity of the marker, not a guess.
  doc["joint_id"] = "J01";

  doc["joint_marker_dt_left"] = round2(dtL / 1000.0);
  if (freshR && dtR > 0) doc["joint_marker_dt_right"] = round2(dtR / 1000.0);

#if ENABLE_SPEED
  if (!isnan(beltSpeed) && beltSpeed > 0.02f) {
    doc["belt_speed"] = round3(beltSpeed);
    // distance = speed x time. Publish only when speed is real, because a
    // distance computed from a stale speed is a fabricated measurement.
    doc["marker_distance_left"] = round1(beltSpeed * (dtL / 1000000.0) * 1000.0);
    if (freshR && dtR > 0)
      doc["marker_distance_right"] = round1(beltSpeed * (dtR / 1000000.0) * 1000.0);
  }
#endif

#if ENABLE_ADXL
  if (adxlOk && vibEvent.ready()) {
    doc["event_vibration_rms"]  = round4(vibEvent.rms());
    doc["event_vibration_peak"] = round4(vibEvent.peak);
    doc["event_kurtosis"]       = round3(vibEvent.kurtosis());
  }
  vibEvent.reset();
#endif

  char buf[768];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  mqtt.publish(topicJoint, (const uint8_t*)buf, n, false);
  Serial.printf("joint pass lap=%lu dtL=%.1fms\n", (unsigned long)lapCount, dtL / 1000.0);
}
#endif

void publishStatus() {
  if (!mqtt.connected()) return;
  JsonDocument doc;
  doc["online"]   = true;
  doc["node"]     = NODE_ID;
  doc["firmware"] = FIRMWARE;
  doc["rssi"]     = WiFi.RSSI();
  doc["uptime_s"] = millis() / 1000;
  doc["ip"]       = WiFi.localIP().toString();
  char buf[320];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  mqtt.publish(topicStatus, (const uint8_t*)buf, n, true);   // retained
}

// ============================================================ HELPERS ======

/* The ESP32 has no RTC battery. Until you add NTP (see README), `ts` is
   milliseconds since boot, and the GATEWAY restamps it on arrival - which is
   accurate to the network hop and fine for a bench rig. For per-joint timing
   you care about DELTAS measured on-chip (micros()), which are unaffected. */
uint64_t nowMillisEpoch() { return (uint64_t)millis(); }

double round1(double v) { return round(v * 10.0) / 10.0; }
double round2(double v) { return round(v * 100.0) / 100.0; }
double round3(double v) { return round(v * 1000.0) / 1000.0; }
double round4(double v) { return round(v * 10000.0) / 10000.0; }
