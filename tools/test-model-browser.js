// End-to-end local dashboard verification in an isolated headless Chrome profile.
// Uses Chrome DevTools directly and the project's existing ws dependency.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import assert from 'node:assert/strict';

const base = process.env.PRAVAAH_TEST_URL ?? 'http://localhost:8812';
const output = join(import.meta.dirname, '..', '_snapshots', 'blender-model-verification');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'pravaah-model-test-'));
const chrome = spawn(process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking', '--window-size=1440,1000', 'about:blank'],
  { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
const endpoint = await new Promise((resolve, reject) => {
  let log = '';
  const timer = setTimeout(() => reject(new Error('Chrome did not start')), 15000);
  chrome.on('error', reject);
  chrome.stderr.on('data', chunk => { log += chunk; const match = log.match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
});
const socket = new WebSocket(endpoint);
await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
let seq = 0, sessionId;
const pending = new Map(), errors = [], checks = [];
socket.on('message', bytes => {
  const msg = JSON.parse(bytes);
  if (msg.id) { const p = pending.get(msg.id); if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); } }
  if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
});
function send(method, params = {}, session = sessionId) {
  return new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) })); });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(expression, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await evaluate(expression)) return; await delay(100); }
  throw new Error(`Timed out: ${expression}`);
}
async function shot(name) { const r = await send('Page.captureScreenshot', { format: 'png' }); await writeFile(join(output, name + '.png'), Buffer.from(r.data, 'base64')); }
function check(name, value) { assert.ok(value, name); checks.push(name); console.log('PASS', name); }
try {
  const target = await send('Target.createTarget', { url: 'about:blank' }, null);
  sessionId = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null)).sessionId;
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `const NativeSocket=window.WebSocket; window.WebSocket=class extends NativeSocket { constructor(...args){ super(...args); window.__testSocket=this; } };` });
  await send('Page.navigate', { url: base });
  await until("document.getElementById('schematic')?.dataset.faceCount > 10000");
  check('actual imported geometry renders', await evaluate("+document.getElementById('schematic').dataset.faceCount > 10000"));
  check('WebGL renderer active', await evaluate("document.getElementById('schematic').dataset.renderer === 'webgl'"));
  check('sensor assemblies available without individual mesh targets', await evaluate("document.getElementById('modelPartSelect').options.length > 3 && ![...document.getElementById('modelPartSelect').options].some(o=>o.value.startsWith('part:'))"));
  await shot('overview');
  console.log('VIEW', await evaluate("({mode:document.getElementById('schematic').dataset, motion:document.getElementById('motionStatus').textContent})"));
  if (process.argv.includes('--smoke')) {
    if (process.argv.includes('--recording')) {
      await until("document.getElementById('motionReadout').dataset.state==='moving'", 15000);
      const phase = await evaluate("+document.getElementById('schematic').dataset.motionPhase");
      await delay(750);
      check('recorded sensor data animates the conveyor', await evaluate("+document.getElementById('schematic').dataset.motionPhase") !== phase);
      check('model labels the recorded source', await evaluate("document.getElementById('motionSource').textContent.includes('Recorded playback')"));
      await shot('recorded-playback');
    }
    check('no JavaScript exceptions', errors.length === 0);
  }
  else {
    // Freeze gateway delivery only in this isolated browser. Controlled fixtures
    // never go to MQTT, the server, alarms, history or the user's browser.
    await evaluate(`(async()=>{window.__snapshot=await (await fetch('/api/state')).json(); window.__deliver=window.__testSocket.onmessage; window.__testSocket.onmessage=()=>{}; window.__sendSnapshot=()=>{const s=window.__snapshot; s.server.now=Date.now(); window.__deliver({data:JSON.stringify(s)});};})()`);
    await evaluate(`window.__cv=window.__snapshot.conveyors[0]; window.__cv.channels.belt_speed.value=.4; window.__cv.channels.belt_speed.state='live'; window.__cv.sensorHealth={...(window.__cv.sensorHealth??{}),speed:'healthy'}; window.__snapshot.nodes.forEach(n=>n.state='live'); window.__freshSpeed=true; window.__tick=()=>{if(window.__freshSpeed)window.__cv.channels.belt_speed.ts=Date.now();window.__sendSnapshot();}; window.__tick(); window.__timer=setInterval(window.__tick,1000);`);
    const phase = () => evaluate("+document.getElementById('schematic').dataset.motionPhase");
    await until("document.getElementById('motionReadout').dataset.state==='moving'");
    let start = await phase(); const motionStarted = Date.now(); await delay(700);
    const traveledPhase = ((await phase()) - start + 1) % 1;
    check('sensor speed advances belt and attached motion', traveledPhase > 0);
    const visibleSpeed = traveledPhase * (20 + 2 * Math.PI * .55) / ((Date.now() - motionStarted) / 1000);
    check('model travel matches measured metres per second', Math.abs(visibleSpeed - .4) < .1);
    await evaluate("document.getElementById('modelMotion').click()");
    await delay(120); start = await phase(); await delay(300);
    check('pause freezes the complete animation', await phase() === start);
    check('monitoring continues during pause', await evaluate("document.getElementById('wsLabel').textContent==='GATEWAY ONLINE'"));
    await evaluate("document.getElementById('modelMotion').click()"); await delay(300);
    check('resume restarts animation', await phase() !== start);
    await evaluate('window.__cv.channels.belt_speed.value=0;window.__tick()');
    await delay(100); start = await phase(); await delay(250);
    check('zero speed holds motion', await phase() === start);
    await evaluate('window.__cv.channels.belt_speed.value=.4;window.__freshSpeed=false;window.__cv.channels.belt_speed.ts=Date.now()-5000;window.__tick()');
    await delay(100); start = await phase(); await delay(250);
    check('stale speed holds motion', await phase() === start && await evaluate("document.getElementById('motionReadout').dataset.state==='unavailable'"));
    await evaluate('window.__freshSpeed=true;window.__tick()');
    await until("document.getElementById('motionReadout').dataset.state==='moving'");
    await evaluate("document.getElementById('modelMotion').click();document.getElementById('modelPartBrowser').open=true;document.getElementById('modelPartSearch').value='motor';document.getElementById('modelPartSearch').dispatchEvent(new Event('input'))");
    check('component search finds the motor assembly', await evaluate("document.getElementById('modelPartSelect').options.length===2"));
    await evaluate("let select=document.getElementById('modelPartSelect');select.value='drive_motor';select.dispatchEvent(new Event('change'))");
    await until("document.getElementById('componentTitle').textContent==='Drive motor'");
    await delay(500); await shot('motor-inspection');
    await evaluate("document.getElementById('viewReset').click();document.getElementById('modelPartSearch').value='';document.getElementById('modelPartSearch').dispatchEvent(new Event('input'));document.getElementById('modelPartBrowser').open=false");
    check('structure has no clickable roster rows or keyboard targets', await evaluate("!document.querySelector('button.pc-row[data-comp=structural_frame]') && !document.querySelector('.sch-focus[data-comp=gearbox]')"));
    await evaluate("Object.assign(window.__cv.channels.hall_rpm,{value:42.5,state:'live',ts:Date.now()});window.__tick();document.querySelector('button.pc-row[data-comp=drive_pulley]').click()");
    await until("document.getElementById('componentDetailBody').textContent.includes('42.5 rpm')");
    check('roller inspection shows the existing Hall RPM', await evaluate("document.getElementById('componentDetailBody').textContent.includes('Belt RPM (Hall)')"));
    await shot('roller-rpm');
    await evaluate("document.getElementById('viewReset').click();document.querySelector('button.pc-row[data-comp=belt_carcass]').click()");
    await until("document.getElementById('componentTitle').textContent==='Belt carcass'");
    check('belt inspection opens sensor details', await evaluate("document.getElementById('componentDetailBody').textContent.includes('Belt RPM (Hall)')"));
    await evaluate("document.getElementById('viewReset').click()");
    for (const view of ['side','top','head','tail','iso']) {
      await evaluate(`document.querySelector('[data-view=${view}]').click()`); await delay(450);
      check(`${view} camera preset`, await evaluate(`document.querySelector('[data-view=${view}]').getAttribute('aria-pressed')==='true'`));
      await shot('camera-' + view);
    }
    await evaluate("document.getElementById('modelLabels').click()");
    check('labels toggle preserves keyboard targets', await evaluate("document.querySelectorAll('#sceneLabels .sch-label').length===0 && document.querySelectorAll('#sceneLabels .sch-focus').length>0"));
    await evaluate("document.getElementById('modelLabels').click()");
    check('texture toggle removed', await evaluate("!document.getElementById('modelTextures')"));
    await evaluate("document.getElementById('modelFullscreen').click()");
    await until('!!document.fullscreenElement');check('fullscreen works', true);
    await evaluate('document.exitFullscreen()');await delay(100);
    await evaluate(`window.__cv.joints.push({id:'TEST-J01',label:'Test splice',risk:'observe',passes:4,lap:4,last_ts:Date.now(),last:{crack_length:12.4,opening:1.5},metrics:[]});window.__cv.components.push({id:'joint:TEST-J01',label:'Test splice',joint:true,state:'observe',group:'joints',watch:[],watching:[],everSeen:[],rulesEvaluated:[],causes:[],alarmCount:0,passes:4});window.__tick();`);
    await until("!!document.querySelector('.sch-focus[data-comp=\"joint:TEST-J01\"]')");
    await evaluate("document.querySelector('.sch-focus[data-comp=\"joint:TEST-J01\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
    await until("document.getElementById('componentTitle').textContent==='Test splice'");
    check('wear graphic shows measured vision damage', await evaluate("document.querySelector('.vision-damage').textContent.includes('12.4 mm')"));
    await shot('vision-wear-detail');
    check('joint markers retain keyboard inspection and history action', await evaluate("document.getElementById('componentJointRecord')?.textContent==='Open joint history'"));
    await evaluate("document.getElementById('componentJointRecord').click()");
    await until("document.getElementById('drawer').getAttribute('aria-hidden')==='false'");
    check('joint history drawer remains connected', true);
    await evaluate("document.getElementById('drawerClose').click();document.getElementById('viewReset').click();window.__cv.joints=[];window.__cv.components=window.__cv.components.filter(c=>!c.joint);window.__tick()");
    await evaluate("document.getElementById('schematicCanvas').getContext('webgl').getExtension('WEBGL_lose_context').loseContext()");
    await until("document.getElementById('schematic').dataset.renderer==='svg'");
    check('SVG fallback retains sensor assembly picking', await evaluate("document.querySelectorAll('#sceneSurfaces polygon[data-comp=drive_motor]').length > 0 && !document.querySelector('#sceneSurfaces polygon[data-comp^=\"part:\"]')"));
    await shot('svg-fallback');
    check('no JavaScript exceptions', errors.length === 0);
  }
  await writeFile(join(output, 'browser-results.json'), JSON.stringify({ checks, errors }, null, 2));
} finally {
  await send('Browser.close', {}, null).catch(() => {}); socket.close(); chrome.kill();
}
