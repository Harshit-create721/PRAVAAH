import test from 'node:test';
import assert from 'node:assert/strict';
import { attachModelFullscreen, filterComponents, historyCSV } from '../web/dashboard-ui.js';

test('component filters include lost sensors in attention and exclude uninstrumented parts', () => {
  const parts = [
    { id: 'motor', label: 'Drive motor', group: 'drive', state: 'healthy' },
    { id: 'pulley', label: 'Head pulley', group: 'drive', state: 'blind' },
    { id: 'belt', label: 'Belt', group: 'belt', state: 'critical' },
    { id: 'chute', label: 'Loading chute', group: 'structure', state: 'unmonitored' },
    { id: 'joint:1', label: 'Splice', joint: true, state: 'critical' },
  ];
  assert.deepEqual(filterComponents(parts, ' DRIVE ', 'all').map(c => c.id), ['motor', 'pulley']);
  assert.deepEqual(filterComponents(parts, '', 'attention').map(c => c.id), ['pulley', 'belt']);
  assert.equal(filterComponents(parts, '', 'instrumented').length, 3);
  assert.equal(filterComponents(parts, 'missing', 'all').length, 0);
});

test('CSV retains numeric zero and negatives, escapes metadata, and excludes invalid samples', () => {
  const csv = historyCSV({ conveyor: '=FORMULA()', channel: 'a,"b', unit: 'g', points: [
    { ts: 0, v: 0 }, { ts: 1000, v: -0.12 }, { ts: 2000, v: null }, { ts: NaN, v: 12 },
  ] });
  assert.match(csv, /"'=FORMULA\(\)"/);
  assert.match(csv, /"a,""b"/);
  assert.match(csv, /"1970-01-01T00:00:00.000Z","0"/);
  assert.match(csv, /"-0.12"/);
  assert.equal(csv.trim().split('\r\n').length, 3);
});

// Exercise the fullscreen state machine without adding a browser dependency.
function fixture(mode = 'native') {
  class Target {
    handlers = {}; children = []; attrs = {}; style = {}; inert = false;
    addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); }
    async emit(type, event = {}) { for (const fn of this.handlers[type] ?? []) await fn(event); }
    setAttribute(key, value) { this.attrs[key] = value; }
    getAttribute(key) { return this.attrs[key]; }
    focus() { doc.activeElement = this; }
    append(...nodes) { for (const node of nodes) { this.children.push(node); node.parentElement = this; } }
    querySelector() { return this.label; }
    querySelectorAll() { return []; }
    classList = { values: new Set(), toggle(name, on) { on ? this.values.add(name) : this.values.delete(name); } };
  }
  const doc = new Target();
  doc.body = new Target(); doc.body.style.overflow = 'auto';
  const header = new Target(), main = new Target(), panel = new Target(), other = new Target();
  other.inert = true;
  doc.body.append(header, main); main.append(panel, other);
  panel.ownerDocument = doc;
  const button = new Target(); button.label = {};
  const status = new Target();
  doc.getElementById = id => id === 'viewerStatus' ? status : null;
  doc.fullscreenEnabled = mode !== 'unsupported';
  panel.requestFullscreen = async () => {
    if (mode === 'rejected') throw new Error('Fullscreen denied');
    doc.fullscreenElement = panel; await doc.emit('fullscreenchange');
  };
  doc.exitFullscreen = async () => { doc.fullscreenElement = null; await doc.emit('fullscreenchange'); };
  let draws = 0;
  const control = attachModelFullscreen(panel, button, () => draws++);
  return { doc, panel, button, header, other, control, draws: () => draws };
}

test('native fullscreen updates controls, resizes, and restores focus and existing inert state on browser exit', async () => {
  const f = fixture();
  await f.button.emit('click');
  assert.equal(f.doc.fullscreenElement, f.panel);
  assert.equal(f.button.attrs['aria-pressed'], 'true');
  assert.equal(f.header.inert, true);
  assert.equal(f.doc.body.style.overflow, 'hidden');
  await f.doc.exitFullscreen();
  assert.equal(f.control.isActive(), false);
  assert.equal(f.button.label.textContent, 'Fullscreen');
  assert.equal(f.header.inert, false);
  assert.equal(f.other.inert, true);
  assert.equal(f.doc.body.style.overflow, 'auto');
  assert.equal(f.doc.activeElement, f.button);
  assert.ok(f.draws() >= 2);
});

for (const mode of ['unsupported', 'rejected']) {
  test(`${mode} native fullscreen falls back and Escape restores the page`, async () => {
    const f = fixture(mode);
    await f.button.emit('click');
    assert.equal(f.control.isActive(), true);
    assert.ok(f.panel.classList.values.has('is-fullscreen'));
    let prevented = false;
    await f.doc.emit('keydown', { key: 'Escape', preventDefault() { prevented = true; }, stopImmediatePropagation() {} });
    assert.ok(prevented);
    assert.equal(f.control.isActive(), false);
    assert.equal(f.header.inert, false);
    assert.equal(f.doc.body.style.overflow, 'auto');
  });
}

test('fullscreen button toggles out of both native and fallback modes', async () => {
  for (const mode of ['native', 'unsupported']) {
    const f = fixture(mode);
    await f.button.emit('click');
    await f.button.emit('click');
    assert.equal(f.control.isActive(), false);
    assert.equal(f.button.attrs['aria-pressed'], 'false');
  }
});
