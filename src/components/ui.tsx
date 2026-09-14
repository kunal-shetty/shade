import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { palette, spacing, typography, threatColor, useTheme } from '../theme/theme';
import type { Incident, SensorReading, Severity, ThreatLevel } from '../types';

// ---------- ThreatBadge ----------
export const ThreatBadge = ({ level, score }: { level: ThreatLevel | Severity; score?: number }) => {
  const color = threatColor(level);
  const icon: keyof typeof Ionicons.glyphMap =
    level === 'critical' ? 'alert' : level === 'high' ? 'alert-circle' : level === 'medium' ? 'warning' : 'shield-checkmark';
  return (
    <View style={[styles.badge, { backgroundColor: `${color}1F`, borderColor: `${color}66` }]}>
      <Ionicons name={icon} size={12} color={color} />
      <Text style={[styles.badgeText, { color }]}>
        {level.toUpperCase()}
        {score != null ? ` · ${score}` : ''}
      </Text>
    </View>
  );
};

// ---------- StatusDot ----------
export const StatusDot = ({ online, alert }: { online: boolean; alert?: boolean }) => (
  <View
    style={[styles.dotWrap, { borderColor: alert ? `${palette.threatCritical}55` : online ? `${palette.threatLow}55` : '#94A3B855' }]}
    accessibilityLabel={alert ? 'alert state' : online ? 'online' : 'offline'}
  >
    <View style={[styles.dot, { backgroundColor: alert ? palette.threatCritical : online ? palette.threatLow : '#94A3B8' }]} />
  </View>
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

// ---------- SectionHeader ----------
export const SectionHeader = ({ icon, title, right }: { icon: keyof typeof Ionicons.glyphMap; title: string; right?: React.ReactNode }) => {
  const c = useTheme();
  return (
    <View style={styles.sectionHeader}>
      <View style={[styles.sectionIconWrap, { backgroundColor: `${c.primary}18` }]}>
        <Ionicons name={icon} size={15} color={c.primary} />
      </View>
      <Text style={[typography.h2, { color: c.text, flex: 1 }]}>{title}</Text>
      {right}
    </View>
  );
};

// ---------- SensorCard ----------
export const SensorCard = ({ reading }: { reading: SensorReading }) => {
  const c = useTheme();
  const alertState = reading.status === 'alert';
  const iconName: keyof typeof Ionicons.glyphMap =
    reading.id === 'door' ? 'git-merge' : reading.id === 'pir' ? 'radio-outline' : reading.id === 'gas' ? 'flame' : reading.id === 'rover' ? 'car-sport' : 'pulse';
  return (
    <View style={[styles.sensorCard, { backgroundColor: c.card, borderColor: alertState ? `${palette.threatCritical}55` : c.border }]}>
      <View style={styles.sensorTopRow}>
        <View style={[styles.sensorIcon, { backgroundColor: alertState ? `${palette.threatCritical}18` : `${c.primary}14` }]}>
          <Ionicons name={iconName} size={14} color={alertState ? palette.threatCritical : c.primary} />
        </View>
        <StatusDot online={reading.status !== 'offline'} alert={alertState} />
      </View>
      <Text style={[typography.caption, { color: c.textMuted, marginTop: spacing.sm }]} numberOfLines={1}>{reading.label}</Text>
      <Text style={[typography.h2, { color: alertState ? palette.threatCritical : c.text, marginTop: 2 }]} numberOfLines={1}>
        {reading.value}
      </Text>
      <Text style={[typography.caption, { color: c.textMuted, marginTop: 2 }]}>{timeAgo(reading.lastSeen)}</Text>
    </View>
  );
};

// ---------- IncidentRow ----------
export const IncidentRow = ({ incident, onPress }: { incident: Incident; onPress: () => void }) => {
  const c = useTheme();
  const sevIcon: keyof typeof Ionicons.glyphMap =
    incident.severity === 'critical' ? 'alert' : incident.severity === 'high' ? 'alert-circle' : incident.severity === 'medium' ? 'warning' : 'information-circle';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Incident ${incident.id}: ${incident.summary}`}
      style={({ pressed }) => [styles.incidentRow, { backgroundColor: pressed ? c.surface : c.card, borderColor: c.border }]}
    >
      <View style={[styles.sevIconWrap, { backgroundColor: `${threatColor(incident.severity)}18` }]}>
        <Ionicons name={sevIcon} size={17} color={threatColor(incident.severity)} />
      </View>
      <View style={styles.incidentMain}>
        <Text style={[typography.body, { color: c.text, fontWeight: '600' }]} numberOfLines={2}>
          {incident.summary}
        </Text>
        <Text style={[typography.caption, { color: c.textMuted, marginTop: 3 }]} numberOfLines={1}>
          {new Date(incident.ts).toLocaleString()} · {incident.zone}
        </Text>
      </View>
      <View style={styles.incidentSide}>
        {incident.status === 'open' ? (
          <View style={[styles.openPill, { backgroundColor: `${palette.threatCritical}18` }]}>
            <View style={[styles.openPillDot, { backgroundColor: palette.threatCritical }]} />
            <Text style={{ color: palette.threatCritical, fontSize: 10, fontWeight: '800' }}>OPEN</Text>
          </View>
        ) : (
          <Ionicons name="checkmark-circle" size={15} color={palette.threatLow} />
        )}
        <Ionicons name="chevron-forward" size={15} color={c.textMuted} />
      </View>
    </Pressable>
  );
};

// ---------- ConnectionBanner ----------
export const ConnectionBanner = ({ state, onRetry }: { state: 'connected' | 'reconnecting' | 'offline' | 'demo'; onRetry: () => void }) => {
  if (state === 'connected' || state === 'demo') return null;
  const label = state === 'reconnecting' ? 'Reconnecting to rover…' : 'Rover network offline';
  const colors: [string, string] = state === 'reconnecting' ? [palette.threatMedium, '#B45309'] : [palette.threatCritical, '#991B1B'];
  return (
    <LinearGradient colors={colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
      <View style={styles.banner}>
        <Ionicons name="cloud-offline" size={15} color="white" />
        <Text style={styles.bannerText}>{label}</Text>
        <Pressable onPress={onRetry} hitSlop={8} accessibilityRole="button" accessibilityLabel="Retry connection">
          <Text style={styles.bannerRetry}>Retry</Text>
        </Pressable>
      </View>
    </LinearGradient>
  );
};

// ---------- PrimaryButton ----------
export const PrimaryButton = ({
  label, onPress, disabled, danger, sublabel, icon,
}: { label: string; onPress: () => void; disabled?: boolean; danger?: boolean; sublabel?: string; icon?: keyof typeof Ionicons.glyphMap }) => {
  const c = useTheme();
  const content = (
    <>
      <View style={styles.btnLabelRow}>
        {icon ? <Ionicons name={icon} size={16} color="white" style={{ marginRight: 7 }} /> : null}
        <Text style={styles.primaryBtnText}>{label}</Text>
      </View>
      {sublabel ? <Text style={styles.primaryBtnSub}>{sublabel}</Text> : null}
    </>
  );
  if (disabled) {
    return (
      <View style={[styles.primaryBtn, { backgroundColor: c.border }]} accessibilityLabel={label}>
        {content}
      </View>
    );
  }
  if (danger) {
    return (
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [{ opacity: pressed ? 0.85 : 1 }]}>
        <LinearGradient colors={[palette.threatCritical, '#B91C1C']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.primaryBtn}>
          {content}
        </LinearGradient>
      </Pressable>
    );
  }
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [{ opacity: pressed ? 0.85 : 1 }]}>
      <LinearGradient colors={[palette.primary, '#12439E']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.primaryBtn}>
        {content}
      </LinearGradient>
    </Pressable>
  );
};

// ---------- GhostButton ----------
export const GhostButton = ({ icon, label, onPress, disabled }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void; disabled?: boolean }) => {
  const c = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.ghostBtn,
        { backgroundColor: c.surface, borderColor: c.border, opacity: disabled ? 0.45 : pressed ? 0.75 : 1 },
      ]}
    >
      <Ionicons name={icon} size={16} color={disabled ? c.textMuted : c.primary} />
      <Text style={[styles.ghostText, { color: disabled ? c.textMuted : c.text }]}>{label}</Text>
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
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999, borderWidth: 1, alignSelf: 'flex-start' },
  badgeText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.6 },
  dotWrap: { width: 16, height: 16, borderRadius: 8, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 7, height: 7, borderRadius: 4 },
  card: { borderRadius: 16, borderWidth: 1, padding: spacing.lg, gap: 6 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sectionIconWrap: { width: 28, height: 28, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  sensorCard: { borderRadius: 16, borderWidth: 1, padding: spacing.md, flex: 1, minWidth: 150 },
  sensorTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sensorIcon: { width: 28, height: 28, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  incidentRow: { flexDirection: 'row', alignItems: 'center', borderRadius: 16, borderWidth: 1, overflow: 'hidden', marginBottom: spacing.sm, padding: spacing.md, gap: spacing.md },
  sevIconWrap: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  incidentMain: { flex: 1, gap: 2 },
  incidentSide: { alignItems: 'flex-end', gap: 6 },
  openPill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  openPillDot: { width: 6, height: 6, borderRadius: 3 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 10, paddingHorizontal: spacing.lg },
  bannerText: { color: 'white', fontWeight: '700', fontSize: 13, flex: 1 },
  bannerRetry: { color: 'white', fontWeight: '800', fontSize: 13, textDecorationLine: 'underline' },
  primaryBtn: { borderRadius: 14, paddingVertical: 13, alignItems: 'center', minHeight: 50, justifyContent: 'center' },
  btnLabelRow: { flexDirection: 'row', alignItems: 'center' },
  primaryBtnText: { color: 'white', fontWeight: '800', fontSize: 14, letterSpacing: 0.3 },
  primaryBtnSub: { color: 'rgba(255,255,255,0.72)', fontSize: 11, marginTop: 2 },
  ghostBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderRadius: 12, borderWidth: 1, paddingVertical: 10, paddingHorizontal: 14, minHeight: 44 },
  ghostText: { fontSize: 13, fontWeight: '700' },
});
