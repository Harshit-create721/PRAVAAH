// The baseline model consumes real telemetry only. It never sets rule-layer risk
// or diagnoses a fault class; its separate result describes baseline deviation.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const conditionStates = new Set(['NORMAL', 'WATCH', 'WARNING', 'CRITICAL']);
const qualityStates = new Set(['WARMING_UP', 'DATA_UNAVAILABLE']);
const unavailable = (reason) => ({ type: 'data_quality', status: 'DATA_UNAVAILABLE',
  reason, anomaly_score: null, health_score: null });

export function createMLWorker({ root, conveyor, onChange = () => {}, log = console.error,
  python, spawnProcess = spawn, now = Date.now }) {
  const mlRoot = join(root, 'ML', 'SIH-2026');
  const localPython = join(mlRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  python ??= process.env.PRAVAAH_ML_PYTHON || (existsSync(localPython) ? localPython : null);
  let child = null, state = unavailable('ML environment is not installed'), stopped = false, retryAt = 0, ready = false;
  let version = null;
  let minimumStartMs = 0;
  try {
    const metadata = JSON.parse(readFileSync(join(mlRoot, 'models/model_metadata.json'), 'utf8'));
    version = metadata.training_date_utc;
    if (metadata.dataset.conveyor !== conveyor) {
      python = null;
      state = unavailable('No baseline model trained for this conveyor');
    }
  } catch {
    python = null;
    state = unavailable('Baseline model artifacts are unavailable');
  }
  const publish = (value) => { state = { ...value, model_version: version, received_ms: now() }; onChange(); };
  function start() {
    if (!python || stopped || child || now() < retryAt) return;
    ready = false;
    publish({ ...unavailable('Loading the recorded baseline model'), status: 'WARMING_UP' });
    const proc = spawnProcess(python, ['-u', join(mlRoot, 'ml/predict.py'), '--stdin'], {
      cwd: mlRoot, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    child = proc;
    let output = '';
    function failed(reason) {
      if (child !== proc) return;
      child = null;
      retryAt = now() + 5000;
      publish(unavailable(reason));
      proc.kill();
    }
    proc.on('error', (err) => { log(`[ml] ${err.message}`); failed('ML worker could not start'); });
    proc.on('exit', () => failed('ML worker stopped; waiting to restart'));
    proc.stdin.on('error', () => failed('ML input stream closed'));
    proc.stderr.on('data', (chunk) => log(`[ml] ${String(chunk).slice(0, 2000).trim()}`));
    proc.stdout.on('data', (chunk) => {
      if (child !== proc) return;
      output += chunk.toString();
      if (output.length > 262144) return failed('ML output exceeded its buffer limit');
      let end;
      while ((end = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, end); output = output.slice(end + 1);
        let value;
        try { value = JSON.parse(line); } catch { return failed('Invalid ML worker output'); }
        if (value?.type === 'worker_ready') {
          ready = true;
          publish({ ...unavailable('Waiting for ten seconds of valid readings from all three sensors'), status: 'WARMING_UP' });
        } else if (value?.type === 'condition' && conditionStates.has(value.status)
          && Number.isFinite(value.anomaly_score) && value.anomaly_score >= 0 && value.anomaly_score <= 100
          && Number.isFinite(value.end_ms) && Number.isFinite(value.start_ms)
          && value.end_ms - value.start_ms === 10000 && value.data_quality === 'valid') {
          if (value.start_ms < minimumStartMs) continue;
          if (now() - value.end_ms > 5000 || value.end_ms > now() + 1000) {
            publish(unavailable('Model window is no longer current'));
          } else publish({ ...value, conveyor });
        } else if (value?.type === 'data_quality' && qualityStates.has(value.status)) {
          publish({ ...unavailable(String(value.reason ?? 'Sensor data unavailable')), status: value.status });
        } else if (value?.type !== 'data_quality' || value.status !== 'READY') {
          return failed('Unrecognized ML worker output');
        }
      }
    });
  }
  return {
    start,
    push(payload) {
      start();
      if (!child || stopped || !ready) return;
      if (child.stdin.writableLength > 262144) {
        this.invalidate('ML input backlog; waiting for fresh sensor readings');
        const proc = child; child = null; retryAt = now() + 5000; proc.kill();
        return;
      }
      child.stdin.write(JSON.stringify(payload) + '\n');
    },
    invalidate(reason) {
      minimumStartMs = now();
      publish(unavailable(reason));
      // Flush the Python window too: an offline notification is a segment break.
      child?.stdin.write(JSON.stringify({ control: 'invalidate', reason }) + '\n');
    },
    snapshot() {
      if (state.type === 'condition' && now() - state.end_ms > 5000) {
        return { ...unavailable('Waiting for a fresh complete model window'), model_version: version };
      }
      return state;
    },
    stop() { stopped = true; const proc = child; child = null; proc?.kill(); },
  };
}
