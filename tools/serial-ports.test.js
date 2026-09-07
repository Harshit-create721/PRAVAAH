import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SensorPorts } from './lib/serial-ports.js';

class FakePort extends EventEmitter {
  isOpen = false;
  isOpening = false;
  closes = 0;
  open(callback) {
    this.isOpening = true;
    this.finishOpen = (error = null) => {
      this.isOpening = false;
      this.isOpen = !error;
      callback(error);
    };
    if (!this.defer) this.finishOpen(this.failure);
  }
  close(callback) {
    this.closes++;
    this.isOpen = false;
    this.emit('close');
    callback?.(null);
  }
}

function fixture(options = {}) {
  let time = 0, paths = [], next = {};
  const made = [], lines = [];
  const manager = new SensorPorts({
    list: async () => paths.map((path) => ({ path })),
    create: (path) => {
      const port = Object.assign(new FakePort(), { path }, next);
      next = {};
      made.push(port);
      return port;
    },
    onPort: (path, port, current) => port.on('data', (line) => { if (current()) lines.push(line); }),
    now: () => time,
    log: () => {},
    ...options,
  });
  return { manager, made, lines, paths: (value) => { paths = value; },
    advance: (ms) => { time += ms; }, next: (value) => { next = value; } };
}

test('starts empty, detects hot-plug and renumbering, and retires the old stream', async () => {
  const f = fixture();
  await f.manager.scan();
  assert.equal(f.made.length, 0);
  f.paths(['/dev/tty.usbserial-4', '/dev/cu.usbserial-4', '/dev/cu.Bluetooth-Incoming-Port']);
  await f.manager.scan();
  assert.equal(f.made.length, 1);
  assert.equal(f.made[0].path, '/dev/cu.usbserial-4');
  f.made[0].emit('data', 'first');
  f.paths(['/dev/tty.usbserial-6']);
  await f.manager.scan();
  assert.equal(f.made[0].closes, 1);
  assert.equal(f.made[1].path, '/dev/cu.usbserial-6');
  f.made[0].emit('data', 'retired');
  f.made[1].emit('data', 'second');
  assert.deepEqual(f.lines, ['first', 'second']);
  await f.manager.scan();
  assert.equal(f.made.length, 2);
});

test('failed open without close event retries once, with bounded backoff', async () => {
  const f = fixture();
  f.paths(['/dev/cu.usbserial-4']);
  f.next({ failure: new Error('Cannot lock port') });
  await f.manager.scan();
  await f.manager.scan();
  assert.equal(f.made.length, 1);
  f.advance(2000);
  await f.manager.scan();
  assert.equal(f.made.length, 2);
  assert.equal(f.made[1].isOpen, true);
  // A late event from a failed attempt cannot retire the new stream.
  f.made[0].emit('close');
  f.made[1].emit('data', 'live');
  assert.deepEqual(f.lines, ['live']);
});

test('silent port closes before retry and fresh bytes prevent needless reopen', async () => {
  const f = fixture();
  f.paths(['/dev/cu.usbserial-4']);
  await f.manager.scan();
  f.advance(9000);
  f.made[0].emit('data', 'sample');
  f.advance(9000);
  await f.manager.scan();
  assert.equal(f.made[0].closes, 0);
  f.advance(1000);
  await f.manager.scan();
  assert.equal(f.made[0].closes, 1);
  assert.equal(f.made.length, 1);
  f.advance(2000);
  await f.manager.scan();
  assert.equal(f.made.length, 2);
});

test('serial error plus close schedules one replacement', async () => {
  const f = fixture();
  f.paths(['/dev/cu.usbserial-4']);
  await f.manager.scan();
  f.made[0].emit('error', new Error('USB disconnected'));
  f.made[0].emit('close');
  f.advance(2000);
  await f.manager.scan();
  await f.manager.scan();
  assert.equal(f.made.length, 2);
});

test('concurrent scans and shutdown cannot create extra ports', async () => {
  let resolve;
  const f = fixture({ list: () => new Promise((done) => { resolve = done; }) });
  const scan = f.manager.scan();
  await f.manager.scan();
  f.manager.stop();
  resolve([{ path: '/dev/cu.usbserial-4' }]);
  await scan;
  assert.equal(f.made.length, 0);
});

test('shutdown closes a port that finishes opening later', async () => {
  const f = fixture();
  f.paths(['/dev/cu.usbserial-4']);
  f.next({ defer: true });
  await f.manager.scan();
  f.manager.stop();
  f.made[0].finishOpen();
  assert.equal(f.made[0].closes, 1);
  f.made[0].emit('data', 'late');
  assert.deepEqual(f.lines, []);
});

test('explicit port mode waits for only the requested device', async () => {
  const f = fixture({ onlyPort: '/dev/tty.usbserial-4' });
  f.paths(['/dev/cu.usbserial-6']);
  await f.manager.scan();
  assert.equal(f.made.length, 0);
  f.paths(['/dev/cu.usbserial-4', '/dev/cu.usbserial-6']);
  await f.manager.scan();
  assert.equal(f.made.length, 1);
  assert.equal(f.made[0].path, '/dev/cu.usbserial-4');
});
