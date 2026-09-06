import { normaliseHealth } from './schema.js';

const SENSOR_CHANNELS = {
  mlx: ['temperature', 'ambient', 'temperature_delta'],
  vibration: ['vibration_rms', 'vibration_kurtosis', 'vibration_crest',
    'acceleration_x', 'acceleration_y', 'acceleration_z', 'acceleration_magnitude'],
  speed: ['hall_rpm', 'motor_rpm', 'belt_speed', 'slip_ratio'],
};

// Fault-only packets must invalidate the last good reading immediately. They
// still prove the node is alive, even when no numeric measurement is usable.
export function applySensorHealth(cv, node, rawHealth, values = {}) {
  const health = normaliseHealth(rawHealth);
  cv.sensorHealth = { ...cv.sensorHealth, ...health };
  for (const [sensor, state] of Object.entries(health)) {
    if (state === 'healthy') continue;
    for (const channel of SENSOR_CHANNELS[sensor] ?? []) {
      const previous = cv.channels[channel];
      if (Number.isFinite(values[channel])) continue;
      if (previous && (previous.node === node || previous.node === 'derived')) delete cv.channels[channel];
    }
  }
}
