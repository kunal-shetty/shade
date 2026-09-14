import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { palette, spacing, typography, threatColor, useTheme } from '../theme/theme';
import type { Incident, SensorReading, Severity, ThreatLevel } from '../types';

// ---------- ThreatBadge ----------
export const ThreatBadge = ({ level, score }: { level: ThreatLevel | Severity; score?: number }) => {
  const c = useTheme();
  const color = threatColor(level);
  return (
    <View style={[styles.badge, { backgroundColor: `${color}22`, borderColor: color }]}>
      <Text style={[styles.badgeText, { color }]} accessibilityLabel={`Threat level ${level}`}>
        {level === 'critical' ? 'CRITICAL' : level.toUpperCase()}
        {score != null ? ` · ${score}` : ''}
      </Text>
    </View>
  );
};

// ---------- StatusDot ----------
export const StatusDot = ({ online, alert }: { online: boolean; alert?: boolean }) => (
  <View
    style={[styles.dot, { backgroundColor: alert ? palette.threatCritical : online ? palette.threatLow : palette.mutedText }]}
    accessibilityLabel={alert ? 'alert state' : online ? 'online' : 'offline'}
  />
);

// ---------- Card ----------
export const Card: React.FC<React.PropsWithChildren<{ onPress?: () => void; style?: object }>> = ({ children, onPress, style }) => {
  const c = useTheme();
  const inner = <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }, style]}>{children}</View>;
  if (!onPress) return inner;
  return (
    <Pressable onPress={onPress} accessibilityRole="button">
      {inner}
    </Pressable>
  );
};

// ---------- SensorCard ----------
export const SensorCard = ({ reading }: { reading: SensorReading }) => {
  const c = useTheme();
  return (
    <View style={[styles.sensorCard, { backgroundColor: c.card, borderColor: c.border }]}>
      <View style={styles.sensorTopRow}>
        <Text style={[typography.body, { color: c.text, fontWeight: '600' }]}>{reading.label}</Text>
        <StatusDot online={reading.status !== 'offline'} alert={reading.status === 'alert'} />
      </View>
      <Text style={[typography.h2, { color: reading.status === 'alert' ? palette.threatCritical : c.text, marginTop: 4 }]}>
        {reading.value}
      </Text>
      <Text style={[typography.caption, { color: c.textMuted, marginTop: 2 }]}>
        {timeAgo(reading.lastSeen)}
      </Text>
    </View>
  );
};

// ---------- IncidentRow ----------
export const IncidentRow = ({ incident, onPress }: { incident: Incident; onPress: () => void }) => {
  const c = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Incident ${incident.id}: ${incident.summary}`}
      style={({ pressed }) => [styles.incidentRow, { backgroundColor: pressed ? c.surface : c.card, borderColor: c.border }]}
    >
      <View style={[styles.severityStripe, { backgroundColor: threatColor(incident.severity) }]} />
      <View style={styles.incidentMain}>
        <Text style={[typography.body, { color: c.text, fontWeight: '600' }]} numberOfLines={2}>
          {incident.summary}
        </Text>
        <Text style={[typography.caption, { color: c.textMuted, marginTop: 2 }]}>
          {new Date(incident.ts).toLocaleString()} · {incident.zone} · score {incident.score}
        </Text>
      </View>
      <View style={styles.incidentSide}>
        <ThreatBadge level={incident.severity} />
        {incident.status === 'open' && <View style={[styles.openPill, { backgroundColor: `${palette.threatCritical}22` }]}><Text style={{ color: palette.threatCritical, fontSize: 10, fontWeight: '700' }}>OPEN</Text></View>}
      </View>
      <Text style={[styles.chevron, { color: c.textMuted }]}>{'›'}</Text>
    </Pressable>
  );
};

// ---------- ConnectionBanner ----------
export const ConnectionBanner = ({ state, onRetry }: { state: 'connected' | 'reconnecting' | 'offline' | 'demo'; onRetry: () => void }) => {
  const c = useTheme();
  if (state === 'connected' || state === 'demo') return null;
  const label = state === 'reconnecting' ? 'Reconnecting to rover…' : 'Rover network offline';
  const bg = state === 'reconnecting' ? palette.threatMedium : palette.threatCritical;
  return (
    <View style={[styles.banner, { backgroundColor: bg }]} accessibilityLiveRegion="polite">
      <Text style={styles.bannerText}>{label}</Text>
      <Pressable onPress={onRetry} hitSlop={8} accessibilityRole="button" accessibilityLabel="Retry connection">
        <Text style={styles.bannerRetry}>Retry</Text>
      </Pressable>
      <Text style={styles.bannerHint}>Demo Mode is available in Settings</Text>
    </View>
  );
};

// ---------- PrimaryButton ----------
export const PrimaryButton = ({
  label, onPress, disabled, danger, sublabel,
}: { label: string; onPress: () => void; disabled?: boolean; danger?: boolean; sublabel?: string }) => {
  const c = useTheme();
  const bg = disabled ? c.border : danger ? palette.threatCritical : c.primary;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [
        styles.primaryBtn,
        { backgroundColor: bg, opacity: pressed ? 0.85 : 1 },
      ]}
    >
      <Text style={styles.primaryBtnText}>{label}</Text>
      {sublabel ? <Text style={styles.primaryBtnSub}>{sublabel}</Text> : null}
    </Pressable>
  );
};

// ---------- misc ----------
export const timeAgo = (ts: number): string => {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

export const Spinner = () => {
  const c = useTheme();
  return <ActivityIndicator color={c.primary} />;
};

const styles = StyleSheet.create({
  badge: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999, borderWidth: 1, alignSelf: 'flex-start' },
  badgeText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  card: { borderRadius: 14, borderWidth: 1, padding: spacing.lg, gap: 6 },
  sensorCard: { borderRadius: 14, borderWidth: 1, padding: spacing.md, flex: 1, minWidth: 150 },
  sensorTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  incidentRow: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, borderWidth: 1, overflow: 'hidden', marginBottom: spacing.sm },
  severityStripe: { width: 5, alignSelf: 'stretch' },
  incidentMain: { flex: 1, padding: spacing.md, gap: 2 },
  incidentSide: { alignItems: 'flex-end', gap: 4, padding: spacing.sm },
  openPill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  chevron: { fontSize: 22, paddingHorizontal: 8 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 10, paddingHorizontal: spacing.lg },
  bannerText: { color: 'white', fontWeight: '700', fontSize: 13, flex: 1 },
  bannerRetry: { color: 'white', fontWeight: '800', fontSize: 13, textDecorationLine: 'underline' },
  bannerHint: { color: 'rgba(255,255,255,0.75)', fontSize: 11, maxWidth: 130 },
  primaryBtn: { borderRadius: 12, paddingVertical: 14, alignItems: 'center', minHeight: 48, justifyContent: 'center' },
  primaryBtnText: { color: 'white', fontWeight: '800', fontSize: 15 },
  primaryBtnSub: { color: 'rgba(255,255,255,0.7)', fontSize: 11, marginTop: 2 },
});
