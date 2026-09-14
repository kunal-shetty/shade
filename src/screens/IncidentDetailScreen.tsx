import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { palette, spacing, typography, threatColor, useTheme } from '../theme/theme';
import { useLiveData } from '../store/rover';
import { useIsAdmin } from '../store/settings';
import { Card, ThreatBadge, timeAgo } from '../components/ui';
import { api } from '../services/api';

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
          <Text style={[typography.body, { color: c.textMuted }]}>Incident not found.</Text>
          <Text onPress={() => navigation.goBack()} style={{ color: c.primary, marginTop: 12 }} accessibilityRole="button">
            ← Back
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const resolve = () => {
    updateIncident(incident.id, {
      status: 'resolved',
      resolvedAt: Date.now(),
      resolvedBy: 'admin (mobile)',
      resolutionNotes: incident.resolutionNotes ?? 'Resolved via mobile app',
    });
    if (!incident.id.toString().startsWith('9')) {
      api.patchIncident(incident.id, { resolved: true, resolution_notes: incident.resolutionNotes ?? 'Resolved via mobile app' }).catch(() => undefined);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right']}>
      <ScrollView contentContainerStyle={styles.container}>
        {/* header */}
        <Card>
          <View style={styles.headerRow}>
            <ThreatBadge level={incident.severity} score={incident.score} />
            <Text style={[typography.caption, { color: c.textMuted }]}>
              #{incident.id} · {incident.status.toUpperCase()}
            </Text>
          </View>
          <Text style={[typography.h2, { color: c.text }]}>{incident.summary}</Text>
          <Text style={[typography.caption, { color: c.textMuted }]}>
            {new Date(incident.ts).toLocaleString()} · {incident.zone} · {timeAgo(incident.ts)}
          </Text>
        </Card>

        {/* event sequence */}
        <Text style={[typography.h2, { color: c.text }]}>Event Sequence</Text>
        <Card>
          {incident.events.map((e, idx) => (
            <View key={idx} style={styles.eventRow}>
              <View style={[styles.eventDot, { backgroundColor: threatColor(incident.severity) }]} />
              <View style={[styles.eventLine, idx === incident.events.length - 1 && { display: 'none' }]} />
              <View style={{ flex: 1 }}>
                <Text style={[typography.body, { color: c.text }]}>{e.label}</Text>
                <Text style={[typography.caption, { color: c.textMuted }]}>{new Date(e.ts).toLocaleTimeString()}</Text>
              </View>
            </View>
          ))}
        </Card>

        {/* threat score breakdown */}
        <Text style={[typography.h2, { color: c.text }]}>Threat Score — {incident.score}/100</Text>
        <Card>
          {incident.contributions.map((k) => (
            <View key={k.factor} style={styles.contribRow}>
              <Text style={[typography.body, { color: c.text, flex: 1 }]}>{k.label}</Text>
              <View style={styles.contribBarTrack}>
                <View style={[styles.contribBar, { width: `${(k.points / 30) * 100}%`, backgroundColor: threatColor(incident.severity) }]} />
              </View>
              <Text style={[typography.mono, { color: c.text, width: 28, textAlign: 'right' }]}>+{k.points}</Text>
            </View>
          ))}
        </Card>

        {/* sensor snapshot */}
        <Text style={[typography.h2, { color: c.text }]}>Sensor Snapshot</Text>
        <Card>
          {incident.sensorSnapshot.length === 0 ? (
            <Text style={[typography.body, { color: c.textMuted }]}>No sensor data recorded.</Text>
          ) : (
            incident.sensorSnapshot.map((s) => (
              <View key={s.id} style={styles.snapRow}>
                <Text style={[typography.body, { color: c.text, flex: 1 }]}>{s.label}</Text>
                <Text style={[typography.mono, { color: s.status === 'alert' ? palette.threatCritical : c.text }]}>{s.value}</Text>
              </View>
            ))
          )}
        </Card>

        {/* photo evidence */}
        <Text style={[typography.h2, { color: c.text }]}>Photo Evidence</Text>
        <Card>
          {incident.photoUrl ? (
            <Text style={[typography.body, { color: c.accent }]} onPress={() => undefined}>
              Open captured image (Pi-hosted)
            </Text>
          ) : (
            <Text style={[typography.body, { color: c.textMuted }]}>No photo attached to this incident.</Text>
          )}
        </Card>

        {/* resolution */}
        <Text style={[typography.h2, { color: c.text }]}>Resolution</Text>
        <Card>
          {incident.status === 'resolved' ? (
            <>
              <Text style={[typography.body, { color: c.text }]}>
                {incident.resolutionNotes ?? 'Resolved'}
              </Text>
              <Text style={[typography.caption, { color: c.textMuted }]}>
                by {incident.resolvedBy ?? 'unknown'} · {incident.resolvedAt ? new Date(incident.resolvedAt).toLocaleString() : ''}
              </Text>
            </>
          ) : (
            <Text style={[typography.body, { color: c.textMuted }]}>Incident is still open.</Text>
          )}
          {isAdmin && incident.status === 'open' ? (
            <View style={{ marginTop: spacing.md }}>
              <Text
                onPress={resolve}
                style={{ color: 'white', backgroundColor: palette.threatLow, textAlign: 'center', paddingVertical: 12, borderRadius: 10, fontWeight: '800' }}
                accessibilityRole="button"
                accessibilityLabel="Mark incident resolved"
              >
                Mark Resolved
              </Text>
            </View>
          ) : null}
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: { padding: spacing.lg, gap: spacing.lg, paddingBottom: 40 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  eventRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, paddingVertical: 6 },
  eventDot: { width: 10, height: 10, borderRadius: 5, marginTop: 5 },
  eventLine: { width: 2, height: 22, backgroundColor: 'rgba(148,163,184,0.4)', marginLeft: 4 },
  contribRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 4 },
  contribBarTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: 'rgba(148,163,184,0.25)', overflow: 'hidden' },
  contribBar: { height: '100%', borderRadius: 4 },
  snapRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(148,163,184,0.3)' },
});
