// Physical components of a conveyor, and what is entitled to speak about each.
//
// This is the map that turns a finding into a place on the machine. A rule
// says "belt slip 14%"; this file is what makes the head pulley go orange.
//
// The `watch` list is the honest part. A component with no watching channel is
// reported as UNMONITORED and is never coloured green, because nothing on this
// rig can see it. A mining ROM belt has far more parts than this sensor set
// touches, and the model draws all of them: the ones we cannot see are drawn
// as bare steel, so the picture doubles as a coverage map. `sensorHint` says
// what it would take to light each dark part up - the instrumentation roadmap
// a mine's E&M department will actually ask for.
//
// `group` orders the roster panel. `id` values are load-bearing: rules.js
// attributes its findings by these exact strings.

/**
 * `watch`       channels whose presence means this component is observable
 * `families`    finding families that attribute to this component
 * `coverage`    what the sensors can and cannot see - shown in the UI verbatim,
 *               so an operator is never left guessing how much to trust a colour
 * `sensorHint`  what would have to be added to monitor it; null when covered
 */
export const COMPONENTS = [
  // ------------------------------------------------------------- drive end
  {
    id: 'drive_pulley',
    label: 'Head pulley (drive)',
    group: 'drive',
    watch: ['belt_speed', 'motor_rpm'],
    families: ['slip_tension'],
    coverage: 'Slip is inferred from motor RPM against measured belt speed. Lagging wear and shaft condition are not measured.',
    sensorHint: null,
  },
  {
    id: 'drive_motor',
    label: 'Drive motor',
    group: 'drive',
    watch: ['motor_current_rms', 'motor_power', 'motor_rpm'],
    families: [],
    coverage: 'Current against the configured rated current. Winding temperature and bearing condition are not measured.',
    sensorHint: 'A PT100 on the winding, and a second CT, would separate an electrical fault from a mechanical one.',
  },
  {
    id: 'drive_bearing',
    label: 'Head shaft bearings',
    group: 'drive',
    watch: ['vibration_rms', 'vibration_kurtosis', 'vibration_crest'],
    families: [],
    coverage: 'Vibration amplitude only. No threshold is configured for steady-state vibration, so this reports signal presence, not condition.',
    sensorHint: 'Set a steady-state vibration limit in config, and add a plummer-block IR spot, to turn presence into condition.',
  },
  {
    id: 'gearbox',
    label: 'Gearbox and fluid coupling',
    group: 'drive',
    watch: [],
    families: [],
    coverage: 'Nothing on this rig observes the reducer. Oil temperature and casing vibration are the two failures that strand a shift.',
    sensorHint: 'One IR spot on the casing plus an ADXL345 on the housing foot.',
  },

  // ----------------------------------------------------------------- pulleys
  {
    id: 'snub_pulley',
    label: 'Snub pulley',
    group: 'pulleys',
    watch: [],
    families: [],
    coverage: 'Unmonitored. It sets the wrap angle on the drive, so a seized snub shows up first as slip on the head pulley - indirectly, and late.',
    sensorHint: 'Bearing IR spot, or a vibration node on its pedestal.',
  },
  {
    id: 'bend_pulley',
    label: 'Bend pulley',
    group: 'pulleys',
    watch: [],
    families: [],
    coverage: 'Unmonitored. Sits on the return run where spillage collects, which is exactly where bearings die.',
    sensorHint: 'Bearing IR spot.',
  },
  {
    id: 'tail_pulley',
    label: 'Tail pulley',
    group: 'pulleys',
    watch: [],
    families: [],
    coverage: 'Nothing in the sensor set observes the tail end. Material build-up here is a common cause of mis-tracking at the loading point.',
    sensorHint: 'A second ESP32 node at the tail carrying a vibration and a temperature channel.',
  },
  {
    id: 'takeup',
    label: 'Screw take-up',
    group: 'pulleys',
    watch: [],
    families: [],
    coverage: 'Take-up travel is not instrumented, so belt elongation is only visible indirectly, through joint marker drift.',
    sensorHint: 'A draw-wire or linear pot on the take-up slide reads elongation directly - the cleanest signal on the whole machine.',
  },

  // ------------------------------------------------------------------ idlers
  {
    id: 'idlers',
    label: 'Idler set - IR spot',
    group: 'idlers',
    watch: ['temperature', 'ambient'],
    families: ['idler_anomaly'],
    coverage: 'The IR sensor reads ONE spot. A seizing idler outside that spot is invisible to it - this colour speaks for the measured point only.',
    sensorHint: null,
  },
  {
    id: 'carry_idlers',
    label: 'Carrying idler sets',
    group: 'idlers',
    watch: [],
    families: [],
    coverage: 'Every troughing set except the one under the IR spot is unwatched. A frozen roll cuts the belt bottom cover long before anyone hears it.',
    sensorHint: 'A scanning IR line, or an acoustic bearing pickup along the stringer, covers a whole run with one node.',
  },
  {
    id: 'impact_idlers',
    label: 'Impact idlers (loading point)',
    group: 'idlers',
    watch: [],
    families: [],
    coverage: 'Unmonitored. They take every tonne of drop energy from the chute, and their rubber rings are the fastest-wearing part on the machine.',
    sensorHint: 'An ADXL345 on the impact frame gives drop energy per pass directly.',
  },
  {
    id: 'training_idler',
    label: 'Self-aligning idler',
    group: 'idlers',
    watch: ['belt_offset_left', 'belt_offset_right'],
    families: ['mistracking'],
    coverage: 'Judged by the lateral offset the camera measures downstream of it. Its own pivot friction is not measured.',
    sensorHint: null,
  },
  {
    id: 'return_idlers',
    label: 'Return idlers',
    group: 'idlers',
    watch: [],
    families: [],
    coverage: 'Unmonitored. Carry-back builds on them first, so they are the earliest physical evidence that the scraper has stopped working.',
    sensorHint: 'IR spot on the return run, or a carry-back camera view.',
  },

  // -------------------------------------------------------------------- belt
  {
    id: 'belt_tracking',
    label: 'Belt tracking',
    group: 'belt',
    watch: ['belt_offset_left', 'belt_offset_right'],
    families: ['mistracking'],
    coverage: 'Lateral offset at the camera station, plus left/right marker asymmetry at each joint pass.',
    sensorHint: null,
  },
  {
    id: 'belt_carcass',
    label: 'Belt carcass',
    group: 'belt',
    watch: ['acoustic_rms', 'load_cell_kg'],
    families: [],
    coverage: 'No rule evaluates carcass condition yet. Damage between joints is only caught if the vision node reports it.',
    sensorHint: 'The vision node already frames the belt - a rip-detection pass on the same frames would cover this.',
  },

  // --------------------------------------------------------------- structure
  {
    id: 'loading_chute',
    label: 'Loading chute and skirts',
    group: 'structure',
    watch: [],
    families: [],
    coverage: 'Unmonitored. Worn skirt rubber is the commonest source of edge damage and spillage on a ROM belt.',
    sensorHint: 'The vision node can see the skirt line if the camera is moved to the loading point.',
  },
  {
    id: 'head_scraper',
    label: 'Belt scraper (head)',
    group: 'structure',
    watch: [],
    families: [],
    coverage: 'Unmonitored. Blade wear stays invisible until carry-back appears on the return idlers.',
    sensorHint: 'A tensioner position sensor on the scraper arm reads blade wear directly.',
  },
  {
    id: 'pull_cord',
    label: 'Pull-cord safety line',
    group: 'structure',
    watch: [],
    families: [],
    coverage: 'Statutory trip line. Its state is wired to the plant interlock, not to this dashboard - it is drawn so nobody mistakes its absence here for absence on the machine.',
    sensorHint: 'A dry contact from the trip relay into a spare ESP32 input.',
  },
];

/** Roster grouping, in the order the UI lists them. */
export const COMPONENT_GROUPS = [
  ['drive', 'Drive end'],
  ['pulleys', 'Pulleys and take-up'],
  ['idlers', 'Idlers'],
  ['belt', 'Belt'],
  ['structure', 'Structure and safety'],
];

const RANK = ['healthy', 'observe', 'planned_inspection', 'urgent_inspection', 'critical'];
const worseOf = (a, b) => (RANK.indexOf(a) >= RANK.indexOf(b) ? a : b);

/**
 * Fold live channel state, open alarms and rule metrics into one status per
 * component.
 *
 * States, in the order they are decided:
 *   unmonitored  nothing watches this component - never coloured as healthy
 *   blind        it had a sensor and the sensor stopped reporting
 *   <risk level> an alarm or a metric attributes to it
 *
 * `causes` carries the measurement, the limit and the ratio for every rule
 * that had something to say, so the UI can always answer "why this colour".
 */
export function componentStatus({ channels, alarms, metrics, joints }) {
  const byId = [];

  for (const c of COMPONENTS) {
    const seen = c.watch.filter((ch) => channels[ch] && channels[ch].state !== 'never');
    const liveChans = seen.filter((ch) => channels[ch].state === 'live');

    const mine = metrics.filter((m) => m.component === c.id);
    const myAlarms = alarms.filter((a) => c.families.includes(a.family) && !a.joint_id);

    // A metric with no finite ratio reached no verdict - its threshold is
    // missing or zero, so the rule could not judge anything. It counts as "a
    // rule ran" but it must never be the reason a component reads healthy.
    const judged = mine.filter((m) => Number.isFinite(m.ratio));

    const causes = mine
      .filter((m) => m.level !== 'healthy')
      .map((m) => ({
        rule: m.rule, level: m.level, message: m.message,
        value: m.value, limit: m.limit, unit: m.unit, ratio: m.ratio,
      }))
      .sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0));

    // Headroom: the closest any rule has come to its limit. Null when no rule
    // for this component could be evaluated at all.
    const ratios = mine.map((m) => m.ratio).filter((r) => Number.isFinite(r));
    const worstRatio = ratios.length ? Math.max(...ratios) : null;

    // Evidence decides first. Some components are judged by rules that fire on
    // a joint passage rather than by a telemetry channel of their own - belt
    // tracking is measured by marker asymmetry and lateral offset at each
    // joint, not by any channel in `watch`. If a rule produced a number about
    // this component, it is monitored, whatever the watch list says.
    let state;
    if (judged.length > 0 || myAlarms.length > 0) {
      state = 'healthy';
      for (const m of judged) state = worseOf(state, m.level);
      for (const a of myAlarms) state = worseOf(state, a.level);
    } else if (mine.length > 0) {
      // Rules ran but none could reach a verdict.
      state = 'no_rule';
    } else if (c.watch.length === 0 || seen.length === 0) {
      state = 'unmonitored';
    } else if (liveChans.length === 0) {
      state = 'blind';
    } else {
      // Signal is arriving but no rule was able to judge it - usually a missing
      // config value, like the geometry the slip rule needs. This must NOT be
      // green: "we have a reading" and "we checked and it is fine" are
      // different claims, and only the second one earns healthy.
      state = 'no_rule';
    }

    byId.push({
      id: c.id, label: c.label, coverage: c.coverage,
      group: c.group, sensorHint: c.sensorHint ?? null,
      state,
      watch: c.watch,
      watching: liveChans,
      everSeen: seen,
      rulesEvaluated: mine.map((m) => m.rule),
      worstRatio,
      causes,
      alarmCount: myAlarms.length,
    });
  }

  // Joints are dynamic, so they are not in COMPONENTS - they come straight
  // from the joint table, which already carries a per-joint risk.
  const jointComps = joints.map((j) => ({
    id: `joint:${j.id}`, label: j.label ?? j.id,
    coverage: 'Compared against this joint\'s own learned baseline.',
    group: 'joints', sensorHint: null,
    state: j.risk === 'unknown' || !j.risk ? 'unmonitored' : j.risk,
    watch: [], watching: [], everSeen: [],
    rulesEvaluated: (j.metrics ?? []).map((m) => m.rule),
    worstRatio: (() => {
      const rs = (j.metrics ?? []).map((m) => m.ratio).filter((r) => Number.isFinite(r));
      return rs.length ? Math.max(...rs) : null;
    })(),
    causes: (j.metrics ?? [])
      .filter((m) => m.level !== 'healthy')
      .map((m) => ({ rule: m.rule, level: m.level, message: m.message, value: m.value, limit: m.limit, unit: m.unit, ratio: m.ratio }))
      .sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0)),
    alarmCount: 0,
    joint: true, passes: j.passes ?? 0,
  }));

  return [...byId, ...jointComps];
}
