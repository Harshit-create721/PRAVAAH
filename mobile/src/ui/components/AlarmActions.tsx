import { Text, View } from 'react-native';
import { Button } from './Common';
import { styles as s } from '../theme';
export function AlarmActions({ offline, readOnly, acknowledged, busy, onAck, onClose }: {
  offline: boolean; readOnly: boolean; acknowledged: boolean; busy: boolean; onAck: () => void; onClose: () => void;
}) {
  return <View style={s.stack}>
    {offline ? <Text style={s.error}>Gateway offline or stale. Actions are unavailable until it reconnects.</Text> : readOnly ? <Text style={s.muted}>Read-only access. Add your write token in connection settings on the Android app.</Text> : null}
    <Button title={acknowledged ? 'Acknowledged' : 'Acknowledge alarm'} disabled={offline || readOnly || acknowledged} busy={busy} onPress={onAck} />
    <Button title="Close with maintenance record" secondary disabled={offline || readOnly || busy} onPress={onClose} />
  </View>;
}
