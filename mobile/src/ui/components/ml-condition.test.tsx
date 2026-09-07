import { render } from '@testing-library/react-native';
import { MLConditionCard } from './MLConditionCard';
import { isMLCondition, type MLCondition } from '../../gateway/types';

const condition: MLCondition = { type: 'condition', data_quality: 'valid', status: 'NORMAL',
  anomaly_score: 0, start_ms: 10000, end_ms: 20000, window_seconds: 10,
  driver_sensor: 'vibration', explanation: 'Similar to recorded operation.' };

test('renders a measured model zero and removes it when data ages or the link drops', async () => {
  const screen = await render(<MLConditionCard condition={condition} now={20000} degraded={false} />);
  expect(screen.getByText('0.0 / 100')).toBeTruthy();
  await screen.rerender(<MLConditionCard condition={condition} now={25001} degraded={false} />);
  expect(screen.queryByText('0.0 / 100')).toBeNull();
  expect(screen.getByText('Data unavailable')).toBeTruthy();
  await screen.rerender(<MLConditionCard condition={condition} now={20000} degraded />);
  expect(screen.queryByText('Within baseline range')).toBeNull();
});

test('rejects malformed model output and distinguishes warm-up from a condition verdict', async () => {
  expect(isMLCondition({ ...condition, anomaly_score: null })).toBe(false);
  expect(isMLCondition({ ...condition, end_ms: 16000 })).toBe(false);
  const quality: MLCondition = { type: 'data_quality', status: 'WARMING_UP', reason: 'Waiting for sensors', anomaly_score: null, health_score: null };
  expect(isMLCondition(quality)).toBe(true);
  const screen = await render(<MLConditionCard condition={quality} now={20000} degraded={false} />);
  expect(screen.getByText('Collecting a full window')).toBeTruthy();
  expect(screen.queryByText('0.0 / 100')).toBeNull();
});
