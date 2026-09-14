import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, Polygon, Rect, Text as SvgText } from 'react-native-svg';
import { palette, spacing, typography, useTheme } from '../theme/theme';
import { useLiveData } from '../store/rover';

interface MapNode {
  id: string;
  x: number;
  y: number;
  label: string;
}

const SENSOR_NODES: MapNode[] = [
  { id: 'pir', x: 250, y: 90, label: 'PIR' },
  { id: 'gas', x: 60, y: 200, label: 'MQ-2' },
  { id: 'env', x: 340, y: 210, label: 'DHT22' },
  { id: 'vib', x: 150, y: 170, label: 'SW-420' },
];

const DOOR = { x: 40, y: 60, w: 46, h: 10 };

const ZONES: Record<string, { x: number; y: number; label: string }> = {
  A: { x: 80, y: 110, label: 'Zone A · Entrance' },
  B: { x: 220, y: 150, label: 'Zone B · Lab interior' },
  C: { x: 300, y: 260, label: 'Zone C · Storage' },
};

const W = 400;
const H = 300;

export const ZoneMapScreen = () => {
  const c = useTheme();
  const zone = useLiveData((s) => s.zone);
  const motionActive = useLiveData((s) => s.motionActive);
  const sensors = useLiveData((s) => s.sensors);
  const [selected, setSelected] = useState<MapNode | null>(null);

  const doorOpen = sensors['door']?.value === 'OPEN';
  const zoneKey = (zone ?? 'Zone A').replace('Zone ', '').trim().charAt(0) || 'A';
  const roverPos = ZONES[zoneKey] ?? ZONES.A;

  const nodeColor = (id: string): string => {
    const s = sensors[id];
    if (!s) return c.textMuted;
    if (s.status === 'alert') return palette.threatCritical;
    return palette.threatLow;
  };

  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right']}>
      <View style={styles.header}>
        <Text style={[typography.h1, { color: c.text }]}>Zone Map</Text>
        <Text style={[typography.caption, { color: c.textMuted }]}>Discrete zone positioning (pre-SLAM)</Text>
      </View>

      <View style={[styles.mapCard, { backgroundColor: c.card, borderColor: c.border }]}>
        <Svg width="100%" height={300} viewBox={`0 0 ${W} ${H}`}>
          {/* motion highlight */}
          {motionActive ? <Rect x={170} y={60} width={210} height={160} fill={palette.threatCritical + '22'} rx={8} /> : null}

          {/* walls */}
          <Rect x={20} y={20} width={W - 40} height={H - 40} fill={c.surface} stroke={c.border} strokeWidth={3} rx={6} />
          {/* inner partitions */}
          <Rect x={20} y={110} width={150} height={4} fill={c.border} />
          <Rect x={170} y={20} width={4} height={90} fill={c.border} />
          {/* door gap */}
          <Rect
            x={DOOR.x}
            y={DOOR.y}
            width={DOOR.w}
            height={DOOR.h}
            fill={doorOpen ? palette.threatCritical : palette.threatLow}
            rx={4}
          />
          <SvgText x={DOOR.x + 2} y={DOOR.y - 6} fontSize={10} fill={c.textMuted}>
            {doorOpen ? 'DOOR OPEN' : 'DOOR CLOSED'}
          </SvgText>

          {/* zone labels */}
          {Object.entries(ZONES).map(([k, z]) => (
            <SvgText key={k} x={z.x} y={z.y + 34} fontSize={11} fill={c.textMuted}>
              {z.label}
            </SvgText>
          ))}

          {/* sensor nodes */}
          {SENSOR_NODES.map((n) => (
            <Circle
              key={n.id}
              cx={n.x}
              cy={n.y}
              r={9}
              fill={nodeColor(n.id)}
              onPress={() => setSelected(n)}
            />
          ))}

          {/* rover marker */}
          <Polygon
            points={`${roverPos.x},${roverPos.y - 12} ${roverPos.x + 12},${roverPos.y + 10} ${roverPos.x - 12},${roverPos.y + 10}`}
            fill={palette.accent}
            stroke="white"
            strokeWidth={2}
          />
        </Svg>
      </View>

      {/* tooltip / legend */}
      <View style={[styles.legend, { backgroundColor: c.card, borderColor: c.border }]}>
        {selected ? (
          <View style={{ gap: 2 }}>
            <Text style={[typography.body, { color: c.text, fontWeight: '700' }]}>
              {selected.label} — {sensors[selected.id]?.value ?? 'no reading yet'}
            </Text>
            <Text style={[typography.caption, { color: c.textMuted }]} onPress={() => setSelected(null)}>
              Tap to dismiss
            </Text>
          </View>
        ) : (
          <>
            <View style={styles.legendRow}>
              <View style={[styles.legendDot, { backgroundColor: palette.accent }]} />
              <Text style={[typography.caption, { color: c.text }]}>Rover position (zone-based)</Text>
            </View>
            <View style={styles.legendRow}>
              <View style={[styles.legendDot, { backgroundColor: palette.threatLow }]} />
              <Text style={[typography.caption, { color: c.text }]}>Sensor node online / door closed</Text>
            </View>
            <View style={styles.legendRow}>
              <View style={[styles.legendDot, { backgroundColor: palette.threatCritical }]} />
              <Text style={[typography.caption, { color: c.text }]}>Alert state / door open · motion zone highlight</Text>
            </View>
          </>
        )}
      </View>

      <Text style={[typography.caption, { color: c.textMuted, paddingHorizontal: spacing.lg }]}>
        Full SLAM-based mapping is future scope (PRD §3.2).
      </Text>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: { padding: spacing.lg, paddingBottom: spacing.sm },
  mapCard: { margin: spacing.lg, borderWidth: 1, borderRadius: 14, overflow: 'hidden' },
  legend: { margin: spacing.lg, marginTop: 0, borderWidth: 1, borderRadius: 12, padding: spacing.md, gap: 6 },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
});
