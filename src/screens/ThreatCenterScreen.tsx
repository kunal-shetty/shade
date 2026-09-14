import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { palette, spacing, typography, threatColor, useTheme } from '../theme/theme';
import { useLiveData } from '../store/rover';
import { useIsAdmin } from '../store/settings';
import { ThreatRadar } from '../components/Gauges';
import { Card, StatusDot, ThreatBadge } from '../components/ui';
import { THREAT_FACTORS } from '../types';
import { api } from '../services/api';
import { useSettings } from '../store/settings';

export const ThreatCenterScreen = () => {
  const c = useTheme();
  const isAdmin = useIsAdmin();
  const threat = useLiveData((s) => s.threat);
  const deviceHealth = useLiveData((s) => s.deviceHealth);
  const connection = useSettings((s) => s.connection);

  const triggers = new Set(threat?.triggers ?? []);

  const resetAlarm = () => {
    if (!connection.demoMode) api.resetAlarm().catch(() => undefined);
  };

  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right']}>
      <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
        <View style={{ alignItems: 'center' }}>
          <Text style={[typography.caption, { color: c.textMuted, letterSpacing: 1.2 }]}>CYBER-PHYSICAL CORRELATION</Text>
          <Text style={[typography.h1, { color: c.text, fontSize: 26 }]}>Threat Center</Text>
        </View>

        <ThreatRadar threat={threat} />

        <Card>
          <View style={styles.rowBetween}>
            <Text style={[typography.h2, { color: c.text }]}>{threat ? threat.score : 0}/100</Text>
            <ThreatBadge level={threat?.level ?? 'low'} />
          </View>
          {isAdmin ? (
            <View
              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: palette.primary, borderRadius: 12, paddingVertical: 13, marginTop: spacing.md }}
              onTouchEnd={resetAlarm}
              accessibilityRole="button"
              accessibilityLabel="Reset alarm"
            >
              <Ionicons name="refresh" size={15} color="white" />
              <Text style={{ color: 'white', fontWeight: '800', fontSize: 14 }}>Reset Alarm</Text>
            </View>
          ) : null}
        </Card>

        <View style={styles.sectionHeader}>
          <Ionicons name="analytics" size={15} color={c.primary} />
          <Text style={[typography.h2, { color: c.text, marginLeft: 7 }]}>Score Breakdown</Text>
        </View>
        <Card>
          {THREAT_FACTORS.map((f) => {
            const active = triggers.has(f.id);
            return (
              <View key={f.id} style={styles.factorRow}>
                <View style={[styles.factorDot, { backgroundColor: active ? threatColor(threat!.level) : c.border }]} />
                <Text style={[typography.body, { color: active ? c.text : c.textMuted, flex: 1, fontWeight: active ? '700' : '400' }]}>
                  {f.label}
                </Text>
                <Text style={[typography.mono, { color: active ? threatColor(threat!.level) : c.textMuted }]}>
                  {active ? '+' + f.max : '0'}/{f.max}
                </Text>
              </View>
            );
          })}
          <View style={[styles.totalRow, { borderTopColor: c.border }]}>
            <Text style={[typography.body, { color: c.text, fontWeight: '800' }]}>TOTAL (cap 100)</Text>
            <Text style={[typography.h2, { color: threatColor(threat?.level ?? 'low') }]}>{threat?.score ?? 0}</Text>
          </View>
        </Card>

        <View style={styles.sectionHeader}>
          <Ionicons name="hardware-chip" size={15} color={c.primary} />
          <Text style={[typography.h2, { color: c.text, marginLeft: 7 }]}>Sensor Health</Text>
        </View>
        {Object.values(deviceHealth).length === 0 ? (
          <Card>
            <Text style={[typography.body, { color: c.textMuted }]}>No device health data — waiting for device/health packets.</Text>
          </Card>
        ) : (
          <Card>
            {Object.values(deviceHealth).map((d) => (
              <View key={d.id} style={styles.healthRow}>
                <StatusDot online={d.online} />
                <View style={{ flex: 1 }}>
                  <Text style={[typography.body, { color: c.text, fontWeight: '600' }]}>{d.label}</Text>
                  <Text style={[typography.caption, { color: c.textMuted }]}>{d.detail}</Text>
                </View>
                <Text style={[typography.caption, { color: d.online ? palette.threatLow : palette.threatCritical, fontWeight: '800' }]}>
                  {d.online ? 'ONLINE' : 'OFFLINE'}
                </Text>
              </View>
            ))}
          </Card>
        )}
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: { padding: spacing.lg, gap: spacing.lg, paddingBottom: 40, alignItems: 'stretch' },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionHeader: { flexDirection: 'row', alignItems: 'center' },
  factorRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 5 },
  factorDot: { width: 10, height: 10, borderRadius: 5 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderTopWidth: 1, paddingTop: spacing.sm, marginTop: spacing.xs },
  healthRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 7, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(148,163,184,0.3)' },
});
