// Reconcile discovery repeatedly: macOS can assign a different suffix after USB reconnects.
export const sensorPortPath = (path) => path.replace(/^\/dev\/tty\./, '/dev/cu.');
const SENSOR_PORT = /usbserial|usbmodem|SLAB_USBtoUART|wchusb/i;

export class SensorPorts {
  constructor({ list, create, onPort, log = console.log, onlyPort = null, now = Date.now,
    silenceMs = 10000, retryMs = 2000 }) {
    Object.assign(this, { list, create, onPort, log, now, silenceMs, retryMs });
    this.onlyPort = onlyPort && sensorPortPath(onlyPort);
    this.ports = new Map();
    this.scanning = false;
    this.stopped = false;
  }

  async scan() {
    if (this.stopped || this.scanning) return;
    this.scanning = true;
    try {
      const discovered = await this.list();
      if (this.stopped) return;
      const paths = new Set(discovered.map(({ path }) => sensorPortPath(path))
        .filter((path) => this.onlyPort ? path === this.onlyPort : SENSOR_PORT.test(path)));
      for (const [path, entry] of this.ports) {
        if (!paths.has(path)) {
          this.ports.delete(path);
          this.close(entry, 'USB device removed');
        }
      }
      for (const path of paths) {
        if (!this.ports.has(path)) {
          this.log(`${path}: USB device discovered`);
          this.ports.set(path, { path, port: null, retryAt: 0 });
        }
        const entry = this.ports.get(path);
        if (entry.port?.isOpen && !entry.closing && this.now() - entry.lastData >= this.silenceMs) {
          this.close(entry, 'no serial bytes for 10s');
        }
        if (!entry.port && this.now() >= entry.retryAt) this.open(entry);
      }
    } catch (error) {
      this.log(`USB discovery failed: ${error.message}`);
    } finally {
      this.scanning = false;
    }
  }

  open(entry) {
    const port = this.create(entry.path);
    entry.port = port;
    entry.closing = false;
    entry.lastData = this.now();
    const current = () => !this.stopped && this.ports.get(entry.path) === entry && entry.port === port;
    const closed = () => {
      if (entry.port !== port) return;
      entry.port = null;
      entry.closing = false;
      entry.retryAt = this.now() + this.retryMs;
    };
    port.on('data', () => { if (current()) entry.lastData = this.now(); });
    port.on('close', closed);
    port.on('error', (error) => {
      if (current()) this.close(entry, error.message);
    });
    this.onPort(entry.path, port, current);
    port.open((error) => {
      if (error) {
        if (current()) this.log(`${entry.path}: ${error.message}; retrying`);
        closed();
      } else if (!current()) {
        // Discovery/shutdown may have retired this entry while open was pending.
        port.close(() => {});
      } else {
        entry.lastData = this.now();
        this.log(`${entry.path}: serial port open`);
      }
    });
  }

  close(entry, why) {
    const port = entry.port;
    if (!port || entry.closing) return;
    this.log(`${entry.path}: ${why}`);
    entry.closing = true;
    if (port.isOpen) {
      port.close((error) => {
        if (entry.port !== port) return;
        if (error && port.isOpen) {
          entry.closing = false;
          this.log(`${entry.path}: close failed: ${error.message}`);
          return;
        }
        entry.port = null;
        entry.closing = false;
        entry.retryAt = this.now() + this.retryMs;
      });
    } else if (!port.isOpening) {
      entry.port = null;
      entry.closing = false;
      entry.retryAt = this.now() + this.retryMs;
    }
  }

  stop() {
    this.stopped = true;
    for (const entry of this.ports.values()) this.close(entry, 'bridge stopping');
    this.ports.clear();
  }
}
