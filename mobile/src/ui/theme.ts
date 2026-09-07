import { Platform, StyleSheet } from 'react-native';
export const colors = {
  bg: '#080A0D', panel: '#12151A', raised: '#1A1E24', border: '#2B3038', text: '#E9E3D6',
  muted: '#AAA59B', faint: '#777C85', amber: '#E0A03C', amberBg: '#2A2217',
  green: '#9ABD73', red: '#F17B6D', orange: '#ECA06C',
};
export const fonts = { body: 'IBMPlexSans_400Regular', medium: 'IBMPlexSans_500Medium', bold: 'IBMPlexSans_600SemiBold',
  display: 'SairaCondensed_600SemiBold', mono: Platform.OS === 'ios' ? 'Menlo' : Platform.OS === 'web' ? 'monospace' : 'monospace' };
export const riskColor = (risk: string): string => ({ healthy: colors.green, observe: '#D3C373', planned_inspection: colors.amber,
  urgent_inspection: colors.orange, critical: colors.red }[risk] ?? colors.muted);
export const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, paddingBottom: 36, gap: 24, width: '100%', maxWidth: 700, alignSelf: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  stack: { gap: 12 },
  card: { padding: 18, gap: 12, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: 12, borderCurve: 'continuous' },
  title: { fontFamily: fonts.display, fontSize: 36, lineHeight: 40, color: colors.text },
  section: { fontFamily: fonts.bold, fontSize: 18, color: colors.text },
  label: { fontFamily: fonts.medium, fontSize: 11, letterSpacing: 1.5, color: colors.muted, textTransform: 'uppercase' },
  body: { fontFamily: fonts.body, fontSize: 14, lineHeight: 21, color: colors.text },
  muted: { fontFamily: fonts.body, fontSize: 13, lineHeight: 20, color: colors.muted },
  error: { fontFamily: fonts.body, fontSize: 13, lineHeight: 20, color: colors.red },
  mono: { fontFamily: fonts.mono, fontSize: 12, color: colors.muted, fontVariant: ['tabular-nums'] },
  input: { fontFamily: fonts.body, color: colors.text, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border,
    borderRadius: 8, borderCurve: 'continuous', paddingHorizontal: 14, paddingVertical: 14, minHeight: 50, fontSize: 15 },
  rule: { height: 1, backgroundColor: colors.border },
});
