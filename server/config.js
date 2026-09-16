// PRAVAAH - site configuration.
// EVERY number here must be MEASURED on your rig. Nothing in this file is
// telemetry; it is asset metadata the dashboard needs in order to interpret
// what the sensors send. Leave a value null and the dashboard will show the
// dependent readout as "not configured" rather than guessing.

export default {
  // `site` is part of every MQTT topic the nodes publish on; changing it means
  // reflashing them. `siteLabel` is what people see, and can change freely.
  site: 'factory',
  siteLabel: 'Pilot test rig',
  // Every time shown on screen is in this zone, labelled. Exports stay UTC.
  timeZone: 'Asia/Kolkata',

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

  // Outbound link to the public relay. The gateway dials out, so nothing here
  // requires inbound network access.
  // OFF unless a publish secret is configured (deploy/.env) or PRAVAAH_RELAY=1:
  // plant data must never leave the site by default. When you do enable it,
  // also set RELAY_WRITE_TOKEN on the relay, or anyone can ack/close alarms.
  relay: {
    enabled: Boolean(process.env.RELAY_PUBLISH_SECRET) || process.env.PRAVAAH_RELAY === '1',
    url: 'wss://api.sih.shubhang.dev/publish',
    // Must match RELAY_PUBLISH_SECRET on the relay. null = relay accepts anyone.
    publishSecret: process.env.RELAY_PUBLISH_SECRET || null,
  },

  // A node is LIVE if it published within `liveMs`, STALE past that,
  // OFFLINE past `offlineMs`. Tune to your publish rate.
  freshness: { liveMs: 3000, staleMs: 10000, offlineMs: 30000 },

  conveyors: [
    {
      id: 'CV-01',
      label: 'Bench test conveyor',
      // Which physical machine the 3D view and part roster describe:
      // 'bench' = the flat-belt demo rig (photo in ConveryBelt/),
      // 'mining' = the imported MC-120 mining conveyor visualization.
      model: 'mining',

      // --- Measured geometry. Fill these in from the rig. ---
      beltLengthM: 1.2,         // user confirmed the full 120 cm loop on 2026-09-06
      beltWidthMm: null,        // belt width, mm
      driveRatedCurrentA: null, // motor nameplate FLA, amps
      driveRatedRpm: null,      // motor nameplate rpm
      pulleyDiameterMm: null,   // drive pulley diameter, mm (for slip calc)
      gearRatio: null,          // motor rev : pulley rev

      // --- Speed sensor calibration ---
      // This rig measures one magnet per complete belt loop. Firmware computes
      // belt speed from the 1.2 m loop. Wheel geometry is reserved for a future
      // wheel-mounted target; these metadata fields do not reconfigure a board.
      pulsesPerRev: null,
      speedWheelCircumferenceMm: null,
      hallTarget: 'belt',       // one taped magnet travels with the belt
      magnetsPerBeltLoop: 1,

      // Normal motor shaft speed, rpm. The speed rule
      // compares measured motor_rpm against this. Leave null and the rule is
      // listed under "Not yet connected" instead of guessing what normal is:
      // there is no safe default, because normal is whatever YOUR drive does.
      // This belt-mounted Hall sensor does not provide motor_rpm.
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
        // A planned-inspection alarm needs the breach on this many CONSECUTIVE
        // new samples of the rule's channel (nodes publish every 500 ms, so 3
        // is 1.5 s). The 6 Sept healthy run had two single-frame crest spikes
        // (6.16 and 7.90) that alarmed a sound belt. Urgent and critical
        // breaches (2x the limit or more) still alarm on the first sample.
        persistSamples: 3,
        speedTolerancePct: 20,     // deviation of motor_rpm from nominalRpm, %
      },
    },
  ],
};
