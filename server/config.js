// PRAVAAH - site configuration.
// EVERY number here must be MEASURED on your rig. Nothing in this file is
// telemetry; it is asset metadata the dashboard needs in order to interpret
// what the sensors send. Leave a value null and the dashboard will show the
// dependent readout as "not configured" rather than guessing.

export default {
  site: 'factory',

  // HTTP + WebSocket for the dashboard UI.
  http: { host: '0.0.0.0', port: 8811 },

  // Embedded MQTT broker. The ESP32 and the vision node connect here.
  // Set `embedded: false` and point `url` at an external broker
  // (e.g. mqtt://192.168.1.50:1883) if you'd rather run Mosquitto.
  mqtt: {
    embedded: true,
    host: '0.0.0.0',
    port: 1883,
    url: 'mqtt://127.0.0.1:1883',
    // Optional. If set, nodes must supply these. Leave null for an open
    // lab network; set them before anything leaves the bench.
    username: null,
    password: null,
  },

  // Data retention. Raw frames are kept for `rawDays`; per-joint records and
  // alarms are kept indefinitely (they are the longitudinal health record).
  storage: {
    file: 'data/beltguard.db',
    rawDays: 14,
  },

  // A node is LIVE if it published within `liveMs`, STALE past that,
  // OFFLINE past `offlineMs`. Tune to your publish rate.
  freshness: { liveMs: 3000, staleMs: 10000, offlineMs: 30000 },

  conveyors: [
    {
      id: 'CV-01',
      label: 'Test conveyor 1',

      // --- Measured geometry. Fill these in from the rig. ---
      beltLengthM: null,        // total belt loop length, metres (tape measure)
      beltWidthMm: null,        // belt width, mm
      driveRatedCurrentA: null, // motor nameplate FLA, amps
      driveRatedRpm: null,      // motor nameplate rpm
      pulleyDiameterMm: null,   // drive pulley diameter, mm (for slip calc)
      gearRatio: null,          // motor rev : pulley rev

      // --- Speed sensor calibration ---
      // Pulses the LM393/Hall sensor emits per full revolution of the wheel
      // it watches, and that wheel's circumference in mm. belt_speed is
      // computed on the ESP32 from these; they are repeated here so the
      // dashboard can flag a mismatch.
      pulsesPerRev: null,
      speedWheelCircumferenceMm: null,

      // Rotation speed the roller runs at when healthy, rpm. The speed rule
      // compares measured motor_rpm against this. Leave null and the rule is
      // listed under "Not yet connected" instead of guessing what normal is:
      // there is no safe default, because normal is whatever YOUR drive does.
      // Run the belt, read motor_rpm off the dashboard, put that number here.
      nominalRpm: null,

      // --- Joints / splices ---
      // Leave empty. Joints self-register the first time their marker is
      // detected, so this fills itself from real passes. Add entries only to
      // give a joint a human label or record its type.
      // e.g. { id: 'J01', label: 'Vulcanised splice, near drive', type: 'vulcanised' }
      joints: [],

      // --- Alert thresholds ---
      // These are DEVIATION limits against each joint's own learned baseline,
      // not absolute values, so they are safe to ship as defaults. The
      // baseline is built from the first `baselineLaps` clean passes.
      baselineLaps: 20,
      thresholds: {
        markerAsymmetryPct: 1.5,   // L/R marker timing difference, % -> mis-tracking or one-sided elongation
        markerDriftPct: 2.0,       // joint marker spacing vs own baseline, % -> elongation
        impactRmsRisePct: 40,      // joint-passage vibration RMS vs baseline, %
        slipRatioPct: 5.0,         // (expected - measured) belt speed, %
        tempRiseC: 15,             // temperature above ambient, degC
        currentResidualPct: 25,    // load-adjusted motor current vs baseline, %
        beltOffsetMm: 15,          // lateral tracking displacement, mm
        crackGrowthMmPerLap: 0.05, // vision crack length growth rate

        // --- Vibration and speed ---
        // Unlike the joint thresholds above, these two are ABSOLUTE, not
        // deviations from a learned baseline, so they are only as good as the
        // numbers you put here. The defaults are bench figures for an ADXL345
        // on a desk: a loaded mining conveyor idles far higher and would alarm
        // continuously. Measure your rig's healthy steady-state RMS first and
        // set this above it, or the alarm is noise.
        vibrationRmsG: 0.35,       // steady-state vibration RMS, g
        vibrationCrest: 6.0,       // crest factor -> impulsive/bearing damage
        // Crest factor is peak/RMS, so as RMS approaches the sensor's noise
        // floor the ratio is decided by noise and will cross any threshold at
        // random. Below this RMS the crest rule reports nothing rather than
        // raising an alarm about a stationary machine.
        vibrationCrestMinRmsG: 0.05,
        speedTolerancePct: 20,     // deviation of motor_rpm from nominalRpm, %
      },
    },
  ],
};
