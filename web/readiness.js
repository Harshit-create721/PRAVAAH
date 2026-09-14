// Read-only evidence from the current gateway snapshot. These checks describe
// available inputs, not certification, calibration or procurement acceptance.
const html = value => String(value ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const timestamp = value => Number.isFinite(value) ? new Date(value).toISOString() : 'Never received';

export function monitoringReadiness(cv, { connected, now }) {
  const channels = Object.values(cv.channels ?? {});
  const live = connected ? channels.filter(c => c.state === 'live').length : 0;
  const joints = cv.joints ?? [];
  const baselined = joints.filter(j => j.baselineReady).length;
  const fields = [['beltLengthM', 'belt loop length'], ['beltWidthMm', 'belt width'],
    ['pulleyDiameterMm', 'drive pulley diameter'], ['gearRatio', 'gear ratio'], ['driveRatedCurrentA', 'rated motor current']];
  const missing = fields.filter(([key]) => !(cv.geometry?.[key] > 0));
  const ml = cv.ml;
  const freshML = connected && ml?.type === 'condition' && ml.data_quality === 'valid'
    && Number.isFinite(ml.end_ms) && now - ml.end_ms <= 5000 && now - ml.end_ms >= -1000
    && Number.isFinite(ml.anomaly_score);
  const recorded = cv.stored?.telemetry ?? 0;
  return [
    { title: 'Sensor feed', value: `${live} / ${channels.length} channels live`, state: live ? 'available' : 'waiting', href: '#nodes',
      detail: !connected ? 'Gateway unavailable. Reconnect before assessing current condition.'
        : live ? 'Review coverage to see which components these channels can evaluate.' : 'Connect sensor nodes and confirm measurements reach this asset.' },
    { title: 'Joint tracking', value: `${joints.length} joints detected`, state: !joints.length ? 'waiting' : baselined === joints.length ? 'available' : 'partial', href: '#joints',
      detail: joints.length ? `${baselined} / ${joints.length} joints have an established baseline. A baseline is not proof of mechanical health.`
        : 'No splice-specific passes received. A belt-speed magnet alone does not identify individual splices.' },
    { title: 'Asset configuration', value: `${fields.length - missing.length} / ${fields.length} fields configured`, state: missing.length ? 'partial' : 'available', href: '/docs/sensor-integration-guide.html',
      detail: missing.length ? `Not configured: ${missing.map(([, label]) => label).join(', ')}. Confirm measured values before using dependent rules.`
        : 'Geometry and rated-current metadata are recorded. Physical calibration still needs separate verification.' },
    { title: 'ML baseline analysis', value: freshML ? 'Current result available' : 'Result unavailable', state: freshML ? 'available' : 'waiting', href: '#riskPanel',
      detail: freshML ? `Model ${ml.model_version ?? 'version not supplied'}; deviation score ${ml.anomaly_score.toFixed(1)} / 100. This is not failure probability.`
        : !connected ? 'Gateway unavailable; no current ML result can be verified.'
          : ml?.type === 'condition' ? 'Waiting for a fresh, valid window from all three sensors.'
            : ml?.reason ?? 'Waiting for the model service and a complete sensor window.' },
    { title: 'Recorded evidence', value: `${recorded.toLocaleString()} telemetry rows stored`, state: recorded ? 'available' : 'waiting', href: '#trends',
      detail: recorded ? `${cv.stored?.jointPasses ?? 0} joint passes stored in this gateway. Use signal history to inspect and export measurements.`
        : 'No measurements are stored in this gateway yet. Capture a real run before presenting trends or measured performance.' },
  ];
}

export function statusReportHTML(cv, { site, connected, now, generatedAt = Date.now(), source = 'Gateway snapshot' }) {
  const checks = monitoringReadiness(cv, { connected, now });
  const rows = (items, cells) => items.map(item => `<tr>${cells(item).map(value => `<td>${html(value)}</td>`).join('')}</tr>`).join('');
  const channels = Object.entries(cv.channels ?? {});
  const components = cv.components ?? [];
  const alarms = cv.alarms ?? [];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>PRAVAAH status report — ${html(cv.id)}</title><style>
    body{max-width:1050px;margin:40px auto;padding:0 24px;color:#172b38;background:#fff;font:14px/1.6 system-ui,sans-serif}h1{font-size:28px;margin-bottom:6px}h2{font-size:19px;margin-top:30px}p{margin:8px 0}table{width:100%;border-collapse:collapse;font-size:12px}th,td{padding:9px;text-align:left;vertical-align:top;border-bottom:1px solid #c9d3dc;overflow-wrap:anywhere}th{background:#eef3f6}thead{display:table-header-group}tr{break-inside:avoid}.note{padding:14px;background:#eef3f6;border-left:3px solid #287e77}.meta{color:#526574}.brand{letter-spacing:.18em;color:#287e77;font-weight:700}@media print{body{margin:0;font-size:11px}h2{break-after:avoid}a{color:inherit}}@page{margin:16mm}
    </style></head><body><p class="brand">PRAVAAH</p><h1>Conveyor monitoring status</h1>
    <p>${html(site)} / ${html(cv.id)} / ${html(cv.label)}</p>
    <p class="meta">Exported ${html(timestamp(generatedAt))} · Last sensor packet ${html(timestamp(cv.lastMessageTs))}</p>
    <p class="meta">Source: ${html(source)} · Gateway connection: ${connected ? 'Connected' : 'Unavailable; snapshot may be historical'}</p>
    <p class="note">${connected && cv.lastMessageTs !== null ? `Reported condition: ${html(cv.risk ?? 'unknown')}.` : 'Current equipment condition cannot be confirmed.'}
    This is a point-in-time monitoring record, not a safety certificate, fault diagnosis, procurement acceptance report or proof of calibrated accuracy. The 3D model is reference geometry.</p>
    <h2>Monitoring readiness</h2><table><thead><tr><th>Area</th><th>Available evidence</th><th>Qualification / next step</th></tr></thead><tbody>${rows(checks, c => [c.title, c.value, c.detail])}</tbody></table>
    <h2>Sensor channels</h2><p>Non-live numbers are last received measurements. Missing values are not zero.</p>
    <table><thead><tr><th>Signal</th><th>Value</th><th>Unit</th><th>Status</th><th>Received at (UTC)</th></tr></thead><tbody>${rows(channels, ([key, c]) => [c.label ?? key,
      Number.isFinite(c.value) ? c.value : 'NO SIGNAL', c.unit ?? '', !connected && c.state !== 'never' ? 'offline' : c.state, timestamp(c.ts)])}</tbody></table>
    <h2>Component coverage</h2><table><thead><tr><th>Component</th><th>Reported state</th><th>Rules evaluated</th><th>Coverage limits</th></tr></thead><tbody>${rows(components, c => [c.label,
      !connected && c.state !== 'unmonitored' ? 'unavailable' : c.state, connected ? c.rulesEvaluated?.length ?? 0 : 0, c.coverage ?? c.sensorHint ?? 'No coverage statement supplied'])}</tbody></table>
    <h2>Open alarms (${alarms.length})</h2>${alarms.length ? `<table><thead><tr><th>Time (UTC)</th><th>Level</th><th>Finding</th><th>Acknowledged by</th></tr></thead><tbody>${rows(alarms, a => [timestamp(a.ts), a.level, a.message, a.ack_by ?? 'Not acknowledged'])}</tbody></table>`
      : '<p>No open alarm records in this snapshot. An empty alarm list does not establish that an unmonitored asset is healthy.</p>'}
    <h2>Interpretation</h2><p>ML results describe deviation from recorded operation. They do not estimate failure probability, remaining useful life, or a confirmed mechanical fault. Monitoring supports inspection decisions; it does not replace a certified machine protection system.</p>
    <p class="meta">This locally exported HTML report can be opened and printed independently of the gateway. It is not digitally signed.</p></body></html>`;
}
