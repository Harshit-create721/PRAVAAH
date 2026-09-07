export const humanize = (text: string | null | undefined) => (text || 'unknown').replaceAll('_', ' ');
export function numberText(value: number, unit = '') {
  const decimals = unit === 'rpm' || unit === 'W' ? 0 : unit === 'g' ? 3 : 2;
  return Number(value.toFixed(decimals)).toString();
}
export function formatValue(ch: { value: number | null; unit: string }) {
  return ch.value === null || !Number.isFinite(ch.value) ? 'NO SIGNAL' : `${numberText(ch.value, ch.unit)}${ch.unit ? ` ${ch.unit}` : ''}`;
}
export function ageText(age: number | null) {
  if (age === null) return 'never received';
  if (age < 1000) return 'just now';
  if (age < 60000) return `${Math.floor(age / 1000)}s ago`;
  if (age < 3600000) return `${Math.floor(age / 60000)}m ago`;
  if (age < 86400000) return `${Math.floor(age / 3600000)}h ago`;
  return `${Math.floor(age / 86400000)}d ago`;
}
const timeFormatter = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit' });
export const timeText = (ts: number) => timeFormatter.format(new Date(ts));
