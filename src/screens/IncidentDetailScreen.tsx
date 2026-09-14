import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { palette, spacing, typography, threatColor, useTheme } from '../theme/theme';
import { useLiveData } from '../store/rover';
import { useIsAdmin } from '../store/settings';
import { Card, ThreatBadge, timeAgo } from '../components/ui';
import { api } from '../services/api';

const SEV_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  critical: 'alert',
  high: 'alert-circle',
  medium: 'warning',
  low: 'information-circle',
};

export const IncidentDetailScreen = ({ route, navigation }: any) => {
  const c = useTheme();
  const isAdmin = useIsAdmin();
  const incidents = useLiveData((s) => s.incidents);
  const updateIncident = useLiveData((s) => s.updateIncident);
  const incident = incidents.find((i) => i.id === route?.params?.id);

  if (!incident) {
    return (
      <SafeAreaView style={styles.safe} edges={['left', 'right']}>
        <View style={styles.center}>
          <Ionicons name="search" size={40} color={c.textMuted} />
          <Text style={[typography.body, { color: c.textMuted, marginTop: spacing.md }]}>Incident not found.</Text>
          <Text onPress={() => navigation.goBack()} style={{ color: c.primary, marginTop: 12, fontWeight: '700' }} accessibilityRole="button">
            Go back
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const sevColor = threatColor(incident.severity);

  const resolve = () => {
    updateIncident(incident.id, {
      status: 'resolved',
      resolvedAt: Date.now(),
      resolvedBy: 'admin (mobile)',
      resolutionNotes: incident.resolutionNotes ?? 'Resolved via mobile app',
    });
    if (incident.id < 9000) {
      api.patchIncident(incident.id, { resolved: true, resolution_notes: incident.resolutionNotes ?? 'Resolved via mobile app' }).catch(() => undefined);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right']}>
      <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
        {/* gradient severity header */}
        <View style={styles.heroWrap}>
          <LinearGradient colors={[sevColor, sevColor + 'CC']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.hero}>
            <View style={styles.heroTopRow}>
              <View style={styles.heroIconWrap}>
                <Ionicons name={SEV_ICONS[incident.severity] ?? 'alert'} size={22} color="white" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.heroTitle}>Incident #{incident.id}</Text>
                <Text style={styles.heroSub}>{incident.status.toUpperCase()} · {timeAgo(incident.ts)}</Text>
              </View>
              <ThreatBadge level={incident.severity} score={incident.score} />
            </View>
            <Text style={styles.heroSummary}>{incident.summary}</Text>
            <View style={styles.heroMetaRow}>
              <Ionicons name="location" size={12} color="rgba(255,255,255,0.8)" />
              <Text style={styles.heroMeta}> {incident.zone}</Text>
              <Ionicons name="time" size={12} color="rgba(255,255,255,0.8)" style={{ marginLeft: 12 }} />
              <Text style={styles.heroMeta}> {new Date(incident.ts).toLocaleString()}</Text>
            </View>
          </LinearGradient>
        </View>

        {/* event sequence */}
        <View style={styles.sectionHeader}>
          <Ionicons name="list" size={15} color={c.primary} />
          <Text style={[typography.h2, { color: c.text, marginLeft: 7 }]}>Event Sequence</Text>
        </View>
        <Card>
          {incident.events.map((e, idx) => (
            <View key={idx} style={styles.eventRow}>
              <View style={styles.eventRail}>
                <View style={[styles.eventDot, { backgroundColor: sevColor }]} />
                {idx < incident.events.length - 1 ? <View style={[styles.eventLine, { backgroundColor: c.border }]} /> : null}
              </View>
              <View style={{ flex: 1, paddingBottom: idx < incident.events.length - 1 ? 14 : 0 }}>
                <Text style={[typography.body, { color: c.text }]}>{e.label}</Text>
                <Text style={[typography.caption, { color: c.textMuted }]}>{new Date(e.ts).toLocaleTimeString()}</Text>
              </View>
            </View>
          ))}
        </Card>

        {/* threat score breakdown */}
        <View style={styles.sectionHeader}>
          <Ionicons name="analytics" size={15} color={c.primary} />
          <Text style={[typography.h2, { color: c.text, marginLeft: 7 }]}>Threat Score — {incident.score}/100</Text>
        </View>
        <Card>
          {incident.contributions.length === 0 ? (
            <Text style={[typography.body, { color: c.textMuted }]}>No factor breakdown recorded.</Text>
          ) : (
            incident.contributions.map((k) => (
              <View key={k.factor} style={styles.contribRow}>
                <Text style={[typography.body, { color: c.text, width: 110 }]} numberOfLines={1}>{k.label}</Text>
                <View style={styles.contribBarTrack}>
                  <View style={[styles.contribBar, { width: `${Math.min(100, (k.points / 30) * 100)}%`, backgroundColor: sevColor }]} />
                </View>
                <Text style={[typography.mono, { color: c.text, width: 30, textAlign: 'right' }]}>+{k.points}</Text>
              </View>
            ))
          )}
        </Card>

        {/* sensor snapshot */}
        <View style={styles.sectionHeader}>
          <Ionicons name="pulse" size={15} color={c.primary} />
          <Text style={[typography.h2, { color: c.text, marginLeft: 7 }]}>Sensor Snapshot</Text>
        </View>
        <Card>
          {incident.sensorSnapshot.length === 0 ? (
            <Text style={[typography.body, { color: c.textMuted }]}>No sensor data recorded.</Text>
          ) : (
            incident.sensorSnapshot.map((s) => (
              <View key={s.id} style={styles.snapRow}>
                <Text style={[typography.body, { color: c.text, flex: 1 }]}>{s.label}</Text>
                <Text style={[typography.mono, { color: s.status === 'alert' ? palette.threatCritical : c.text, fontWeight: '700' }]}>{s.value}</Text>
              </View>
            ))
          )}
        </Card>

        {/* photo evidence */}
        <View style={styles.sectionHeader}>
          <Ionicons name="image" size={15} color={c.primary} />
          <Text style={[typography.h2, { color: c.text, marginLeft: 7 }]}>Photo Evidence</Text>
        </View>
        <Card>
          <View style={[styles.photoPlaceholder, { backgroundColor: c.surface, borderColor: c.border }]}>
            <Ionicons name="camera" size={28} color={c.textMuted} />
            <Text style={[typography.caption, { color: c.textMuted, marginTop: 8 }]}>
              {incident.photoUrl ? 'Capture available on the Pi' : 'No photo attached to this incident'}
            </Text>
          </View>
        </Card>

        {/* resolution */}
        <View style={styles.sectionHeader}>
          <Ionicons name="checkmark-done" size={15} color={c.primary} />
          <Text style={[typography.h2, { color: c.text, marginLeft: 7 }]}>Resolution</Text>
        </View>
        <Card>
          {incident.status === 'resolved' ? (
            <>
              <View style={styles.resolvedRow}>
                <Ionicons name="checkmark-circle" size={16} color={palette.threatLow} />
                <Text style={[typography.body, { color: c.text, flex: 1, marginLeft: 7 }]}>{incident.resolutionNotes ?? 'Resolved'}</Text>
              </View>
              <Text style={[typography.caption, { color: c.textMuted }]}>
                by {incident.resolvedBy ?? 'unknown'} · {incident.resolvedAt ? new Date(incident.resolvedAt).toLocaleString() : ''}
              </Text>
            </>
          ) : (
            <Text style={[typography.body, { color: c.textMuted }]}>Incident is still open.</Text>
          )}
          {isAdmin && incident.status === 'open' ? (
            <View
              style={[styles.resolveBtn, { backgroundColor: palette.threatLow }]}
              onTouchEnd={resolve}
              accessibilityRole="button"
              accessibilityLabel="Mark incident resolved"
            >
              <Ionicons name="checkmark" size={16} color="white" />
              <Text style={styles.resolveBtnText}> Mark Resolved</Text>
            </View>
          ) : null}
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: { padding: spacing.lg, gap: spacing.lg, paddingBottom: 48 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  heroWrap: { borderRadius: 18, overflow: 'hidden' },
  hero: { padding: spacing.lg, gap: spacing.md },
  heroTopRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  heroIconWrap: { width: 42, height: 42, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' },
  heroTitle: { color: 'white', fontSize: 19, fontWeight: '800' },
  heroSub: { color: 'rgba(255,255,255,0.75)', fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  heroSummary: { color: 'white', fontSize: 14, fontWeight: '600', lineHeight: 20 },
  heroMetaRow: { flexDirection: 'row', alignItems: 'center' },
  heroMeta: { color: 'rgba(255,255,255,0.85)', fontSize: 11 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center' },
  eventRow: { flexDirection: 'row' },
  eventRail: { alignItems: 'center', marginRight: spacing.md },
  eventDot: { width: 11, height: 11, borderRadius: 6 },
  eventLine: { width: 2, flex: 1, marginTop: 3, borderRadius: 1 },
  contribRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 5 },
  contribBarTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: 'rgba(148,163,184,0.25)', overflow: 'hidden' },
  contribBar: { height: '100%', borderRadius: 4 },
  snapRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(148,163,184,0.3)' },
  photoPlaceholder: { borderWidth: 1, borderRadius: 12, padding: spacing.xl, alignItems: 'center', borderStyle: 'dashed' },
  resolvedRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  resolveBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 12, paddingVertical: 13, marginTop: spacing.md },
  resolveBtnText: { color: 'white', fontWeight: '800', fontSize: 14 },
});
