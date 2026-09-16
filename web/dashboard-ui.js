// Small, dependency-free dashboard controls shared with the regression tests.
export function filterComponents(components, query, filter) {
  const search = query.trim().toLowerCase();
  return components.filter(c => !c.joint
    && `${c.label} ${c.id} ${c.group}`.toLowerCase().includes(search)
    && (filter === 'attention'
      ? ['observe', 'planned_inspection', 'urgent_inspection', 'critical', 'blind'].includes(c.state)
      : filter === 'instrumented' ? c.state !== 'unmonitored' : true));
}

export function historyCSV({ conveyor, channel, unit, points }) {
  // Quote all fields and neutralise spreadsheet formula prefixes in metadata.
  const cell = value => `"${(typeof value === 'number' ? String(value) : String(value ?? '').replace(/^[\s]*[=+@-]/, "'$&")).replace(/"/g, '""')}"`;
  return [['conveyor', 'channel', 'timestamp_utc', 'value', 'unit'],
    ...points.filter(p => Number.isFinite(p.ts) && Number.isFinite(p.v))
      .map(p => [conveyor, channel, new Date(p.ts).toISOString(), p.v, unit])]
    .map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

/**
 * Y-axis range for a trend. Autoscaling to min..max turns a 0.8% wobble in a
 * steady belt into a full-height sawtooth that reads as instability, so the
 * span never drops below `minFraction` of the signal's own magnitude.
 */
export function axisRange(values, minFraction = 0.05) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return null;
  let lo = Math.min(...finite), hi = Math.max(...finite);
  const mid = (lo + hi) / 2;
  const minSpan = Math.max(Math.abs(mid) * minFraction, 1e-3);
  if (hi - lo < minSpan) { lo = mid - minSpan / 2; hi = mid + minSpan / 2; }
  const pad = (hi - lo) * 0.12;
  return [lo - pad, hi + pad];
}

/** Clock time in the plant's zone, always labelled so nobody guesses UTC vs local. */
export function formatTime(ts, timeZone) {
  if (!Number.isFinite(ts)) return '--:--:--';
  const opts = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
  try {
    const text = new Intl.DateTimeFormat('en-GB', timeZone ? { ...opts, timeZone } : opts).format(ts);
    return timeZone === 'Asia/Kolkata' ? `${text} IST` : timeZone ? `${text} ${timeZone}` : text;
  } catch { return new Intl.DateTimeFormat('en-GB', opts).format(ts); }
}

/** Operator-facing name for a sensor node id; the id stays available as a detail. */
export function nodeName(id) {
  const s = String(id ?? '');
  if (/vib/i.test(s)) return 'Vibration sensor';
  if (/therm|temp|mlx/i.test(s)) return 'Temperature sensor';
  if (/marker|hall|speed/i.test(s)) return 'Belt speed sensor';
  if (/vision|cam/i.test(s)) return 'Camera';
  return s || 'Sensor';
}

const ROLE = { vibration: 'vibration', thermal: 'temperature', speed: 'belt speed' };

/** Plain-language text for the ML worker's data-quality reason codes. */
export function humanReason(reason) {
  const r = String(reason ?? '');
  let m;
  if ((m = r.match(/^Sensor disconnected: (.+)$/))) return `${nodeName(m[1])} disconnected`;
  if ((m = r.match(/^insufficient_time_coverage:(\w+)$/))) return `Not enough recent ${ROLE[m[1]] ?? m[1]} readings to fill a 10-second window`;
  if ((m = r.match(/^sensor gap:(\w+)$/))) return `${ROLE[m[1]] ?? m[1]} readings paused`.replace(/^./, (c) => c.toUpperCase());
  if ((m = r.match(/^sequence discontinuity:(\w+)$/))) return `Some ${ROLE[m[1]] ?? m[1]} readings were skipped`;
  if ((m = r.match(/^sensor_health:(\w+):(\w+)$/))) return `${(ROLE[m[1]] ?? m[1]).replace(/^./, (c) => c.toUpperCase())} sensor reports "${m[2]}"`;
  if (/full synchronized window/i.test(r)) return 'Collecting 10 seconds of readings from all three sensors';
  // Validation errors from the ML data contract: the window restarts after each.
  if (/must be a finite number$/.test(r)) return 'An incomplete sensor reading arrived; the 10-second window restarted';
  if (/outside (channel )?range/.test(r)) return 'A reading was outside its valid range; the 10-second window restarted';
  if (/quality_issues reported by gateway/.test(r)) return 'The gateway flagged a reading as unreliable; the 10-second window restarted';
  if (/insufficient acquired samples/.test(r)) return 'The vibration sensor delivered too few samples; the 10-second window restarted';
  if (/unknown sensor node/.test(r)) return 'Readings arrived from an unrecognised sensor';
  return r;
}

const ML_RANK = { NORMAL: 0, WATCH: 1, WARNING: 2, CRITICAL: 3 };

/**
 * One ML window lasts 2.5 s. A single window is a flash, not a condition, so
 * the headline status is the least severe status across the last `need`
 * consecutive windows (steps of <= `maxStepMs`). Returns null until there are
 * enough windows. `transient` is set when the latest window is worse than
 * what has been sustained, so the UI can mention it without shouting it.
 */
export function sustainedML(windows, need = 3, maxStepMs = 3500) {
  const byEnd = new Map();
  for (const w of windows) if (Number.isFinite(w?.end_ms) && w.status in ML_RANK) byEnd.set(w.end_ms, w);
  const sorted = [...byEnd.values()].sort((a, b) => a.end_ms - b.end_ms);
  let run = sorted.length ? [sorted.at(-1)] : [];
  for (let i = sorted.length - 2; i >= 0 && run.length < need; i--) {
    if (run[0].end_ms - sorted[i].end_ms > maxStepMs) break;
    run.unshift(sorted[i]);
  }
  if (run.length < need) return { sustained: null, latest: sorted.at(-1) ?? null, transient: false };
  const sustained = run.reduce((a, b) => (ML_RANK[b.status] < ML_RANK[a.status] ? b : a));
  const latest = run.at(-1);
  return { sustained, latest, transient: ML_RANK[latest.status] > ML_RANK[sustained.status] };
}

/** What each rule means to an operator, what to check, and what it still needs. */
export const RULE_TEXT = {
  vibration_impulsive: { title: 'Impulsive vibration (shocks)', action: 'Inspect the head shaft bearings and drive coupling for looseness, impact damage or a trapped object.' },
  vibration_high: { title: 'High vibration', action: 'Check bearing lubrication, shaft alignment and mounting bolts at the drive end.' },
  thermal_delta: { title: 'Hot spot at the IR sensor', action: 'Check the measured spot for friction heat: a seizing idler, a rubbing belt edge or a hot bearing.' },
  slip_ratio: { title: 'Belt slip', action: 'Check belt tension and the drive pulley lagging.', needs: 'Needs a motor speed sensor, plus the drive pulley diameter and gear ratio in the asset settings.' },
  motor_overcurrent: { title: 'Motor overload', action: 'Check for overload, seized rollers or material build-up.', needs: 'Needs a motor current sensor (CT) and the motor’s rated current in the asset settings.' },
  speed_deviation: { title: 'Drive speed deviation', action: 'Check the drive setpoint, belt tension and load.', needs: 'Needs a motor speed sensor and the normal running speed in the asset settings.' },
  marker_asymmetry: { title: 'Joint running unevenly', action: 'Inspect the splice for one-sided stretch and check belt tracking.' },
  belt_offset: { title: 'Belt off-track', action: 'Check tracking: idler alignment, loading position and belt tension.' },
};
export const ruleTitle = (rule) => RULE_TEXT[rule]?.title
  ?? String(rule ?? 'Rule').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/**
 * What to tell the operator about a rule that did not evaluate.
 *
 * `RULE_TEXT[rule].needs` is the plain-language version of a PERMANENT gap:
 * hardware that is not fitted plus a setting that is not filled in. rules.js
 * reports transient reasons for those same rules - "belt stopped or belt_speed
 * missing", "needs motor_rpm from the Hall sensor" - and printing the canned
 * sentence for one of those tells an operator to go buy a sensor that is
 * already bolted to the machine.
 *
 * The gateway marks the full permanent gap by naming the unset config field
 * ("... in config"), so that is the only case where the friendly text is the
 * whole truth. Everything else shows the reason the gateway actually gave.
 */
export function gapReason(rule, why) {
  const reason = String(why ?? '');
  const needs = RULE_TEXT[rule]?.needs;
  return needs && /\bin config\b/.test(reason) ? needs : reason;
}

// Severity ladder for alarm levels. An unknown level sorts lowest so a
// malformed one can never masquerade as an escalation.
const ALARM_RANK = { observe: 0, planned_inspection: 1, urgent_inspection: 2, critical: 3 };
const alarmRank = (level) => ALARM_RANK[level] ?? -1;

/** Snapshot of what is currently on screen, for the next alarmAlert() call. */
export const alarmStates = (alarms) =>
  new Map(alarms.map((a) => [a.id, { level: a.level, message: a.message }]));

/**
 * Should this alarm list interrupt the operator (chime + screen flash)?
 *
 * `previous` is the map from the last render, or null on first paint - a
 * freshly opened dashboard never chimes about alarms that were already there.
 *
 * An acknowledged alarm stays silent at the level the operator accepted. But
 * the gateway escalates open alarms IN PLACE (store.updateAlarm rewrites the
 * level and leaves ack_ts set), and a fault getting materially worse is the
 * loudest thing this dashboard has to say. So an escalation re-alerts even
 * after acknowledgement - which is exactly the case where somebody has
 * already looked away.
 */
export function alarmAlert(previous, alarms) {
  if (!previous) return false;
  return alarms.some((a) => {
    const was = previous.get(a.id);
    if (was && alarmRank(a.level) > alarmRank(was.level)) return true;
    if (a.ack_ts) return false;
    return !was || was.level !== a.level || was.message !== a.message;
  });
}

/** Channels kept behind "Engineering detail": useful for diagnosis, noise for a first read. */
export const ENGINEERING_CHANNELS = new Set(['vibration_kurtosis', 'acceleration_x', 'acceleration_y',
  'acceleration_z', 'acceleration_magnitude', 'ambient']);

export function attachModelFullscreen(panel, button, onResize) {
  const doc = panel.ownerDocument;
  const status = doc.getElementById('viewerStatus');
  let fallback = false;
  let active = false;
  let busy = false;
  let savedOverflow = '';
  let background = [];
  const sync = () => {
    const next = doc.fullscreenElement === panel || fallback;
    if (next !== active) {
      if (next) {
        savedOverflow = doc.body.style.overflow;
        doc.body.style.overflow = 'hidden';
        // Preserve any pre-existing inert state, including nested page content.
        for (let node = panel; node.parentElement; node = node.parentElement) {
          for (const sibling of node.parentElement.children) {
            if (sibling !== node) { background.push([sibling, sibling.inert]); sibling.inert = true; }
          }
          if (node.parentElement === doc.body) break;
        }
      } else {
        doc.body.style.overflow = savedOverflow;
        for (const [node, inert] of background) node.inert = inert;
        background = [];
      }
      active = next;
      button.focus({ preventScroll: true });
    }
    panel.classList.toggle('is-fullscreen', next);
    button.setAttribute('aria-pressed', String(next));
    button.setAttribute('aria-label', next ? 'Exit fullscreen model' : 'View model in fullscreen');
    button.querySelector('span').textContent = next ? 'Exit fullscreen' : 'Fullscreen';
    status.textContent = next ? 'Fullscreen inspection · Press Esc to exit' : '';
    onResize();
  };
  button.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    try {
      if (doc.fullscreenElement === panel) await doc.exitFullscreen();
      else if (fallback) fallback = false;
      else {
        try {
          if (!panel.requestFullscreen || doc.fullscreenEnabled === false) throw new Error('unsupported');
          await panel.requestFullscreen();
        } catch { fallback = true; }
      }
      sync();
    } catch {
      status.textContent = 'Unable to exit fullscreen. Press Esc to return.';
    } finally { busy = false; }
  });
  doc.addEventListener('fullscreenchange', sync);
  doc.addEventListener('keydown', event => {
    if (!active) return;
    if (doc.getElementById('drawer')?.getAttribute('aria-hidden') === 'false') return;
    if (event.key === 'Escape' && fallback) {
      event.preventDefault(); event.stopImmediatePropagation();
      fallback = false; sync();
    }
    else if (event.key === 'Escape') event.stopImmediatePropagation();
    if (event.key === 'Tab') {
      const targets = [...panel.querySelectorAll('button, select, a[href], [tabindex="0"]')]
        .filter(el => !el.disabled && !el.closest('[inert]') && el.getClientRects().length);
      const first = targets[0], last = targets.at(-1);
      if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }, true);
  return { isActive: () => active };
}
