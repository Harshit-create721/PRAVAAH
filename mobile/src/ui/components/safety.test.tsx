import { render, fireEvent } from '@testing-library/react-native';
import { ChannelTile } from './ChannelTile';
import { AlarmActions } from './AlarmActions';
import { channel } from '../../../tests/fixtures';
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('../../store/useRelay', () => ({ useRelay: jest.fn() }));
jest.mock('lucide-react-native', () => {
  const { View } = require('react-native');
  return { ArrowUpRight: View, ArrowLeft: View, Activity: View, Settings2: View, Wifi: View, WifiOff: View };
});
test('an absent channel shows NO SIGNAL while a measured zero is rendered', async () => {
  const screen = await render(<ChannelTile channel={{ ...channel, value: null }} state="never" age={null} onPress={() => {}} />);
  expect(screen.getByText('NO SIGNAL')).toBeTruthy();
  await screen.rerender(<ChannelTile channel={channel} state="live" age={0} onPress={() => {}} />);
  expect(screen.getByText('0')).toBeTruthy(); expect(screen.queryByText('NO SIGNAL')).toBeNull();
});
test.each([{ offline: true, readOnly: false }, { offline: false, readOnly: true }])('alarm actions are disabled when unavailable: %p', async flags => {
  const onAck = jest.fn(), onClose = jest.fn();
  const screen = await render(<AlarmActions {...flags} acknowledged={false} busy={false} onAck={onAck} onClose={onClose} />);
  const ack = screen.getByRole('button', { name: 'Acknowledge alarm' }); const close = screen.getByRole('button', { name: 'Close with maintenance record' });
  expect(ack).toBeDisabled(); expect(close).toBeDisabled(); await fireEvent.press(ack); await fireEvent.press(close);
  expect(onAck).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
});
