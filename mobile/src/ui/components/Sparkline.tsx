import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import { colors, styles as s } from '../theme';
import { numberText, timeText } from '../../domain/format';

export function Sparkline({ points, unit, color = colors.amber }: { points: { ts: number; v: number }[]; unit: string; color?: string }) {
  const [width, setWidth] = useState(300);
  const chart = useMemo(() => {
    if (!points.length) return null;
    const min = Math.min(...points.map(p => p.v)); const max = Math.max(...points.map(p => p.v));
    const pad = Math.max((max - min) * 0.12, Math.abs(max) * 0.02, 0.05);
    const bottom = min - pad; const top = max + pad;
    const start = points[0].ts; const end = points[points.length - 1].ts;
    const x = (ts: number) => 8 + (end === start ? 0.5 : (ts - start) / (end - start)) * (width - 16);
    const y = (v: number) => 12 + (1 - (v - bottom) / (top - bottom)) * 148;
    // Split paths at missing intervals; never draw a continuous signal through an outage.
    const gaps = points.slice(1).map((p, i) => p.ts - points[i].ts).filter(v => v > 0).sort((a, b) => a - b);
    const gapLimit = Math.max(10000, (gaps[Math.floor(gaps.length / 2)] ?? 2000) * 5);
    // Bound path complexity while preserving each bucket's min and max excursions.
    const sampled: typeof points = [];
    const stride = Math.max(1, Math.ceil(points.length / Math.max(50, width)));
    for (let i = 0; i < points.length; i += stride) {
      const bucket = points.slice(i, i + stride);
      const lo = bucket.reduce((a, b) => a.v < b.v ? a : b);
      const hi = bucket.reduce((a, b) => a.v > b.v ? a : b);
      sampled.push(...[bucket[0], lo, hi, bucket[bucket.length - 1]].filter((p, j, a) => a.indexOf(p) === j).sort((a, b) => a.ts - b.ts));
    }
    const path = sampled.map((p, i) => `${i === 0 || p.ts - sampled[i - 1].ts > gapLimit ? 'M' : 'L'}${x(p.ts).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
    return { path, min, max, lastX: x(end), lastY: y(points[points.length - 1].v), start, end };
  }, [points, width]);
  if (!chart) return <View style={{ minHeight: 180, justifyContent: 'center', alignItems: 'center', gap: 10 }}><Text style={s.section}>NO SIGNAL</Text><Text style={s.muted}>No recorded samples in this window.</Text></View>;
  return <View style={{ gap: 10 }} onLayout={e => setWidth(Math.max(100, e.nativeEvent.layout.width))} accessibilityLabel={`Trend with ${points.length} recorded samples. Minimum ${numberText(chart.min)} ${unit}, maximum ${numberText(chart.max)} ${unit}.`}>
    <Text style={s.mono}>{numberText(chart.max)} {unit}</Text>
    <Svg width="100%" height={176} viewBox={`0 0 ${width} 176`}>
      {[12, 86, 160].map(y => <Line key={y} x1={0} y1={y} x2={width} y2={y} stroke={colors.border} strokeDasharray="3 6" />)}
      <Path d={chart.path} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Circle cx={chart.lastX} cy={chart.lastY} r={3.5} fill={color} />
    </Svg>
    <Text style={s.mono}>{numberText(chart.min)} {unit}</Text>
    <View style={s.between}><Text style={s.mono}>{timeText(chart.start)}</Text><Text style={s.mono}>{timeText(chart.end)}</Text></View>
  </View>;
}
