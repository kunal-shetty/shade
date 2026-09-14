import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { palette, spacing, typography, threatColor, useTheme } from '../theme/theme';
import { useLiveData } from '../store/rover';
import { useAdmin, useIsAdmin, useSettings } from '../store/settings';
import { Card, PrimaryButton, SensorCard, timeAgo } from '../components/ui';
import { sendRoverCommand } from '../services/roverLink';
import { api } from '../services/api';
import { triggerDemoAlarm } from '../services/demoEngine';
import { notifyThreat } from '../services/notifications';
import type { ThreatLevel } from '../types';

const LEVEL_ORDER: Record<ThreatLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

const ThreatBanner = ({ onPress }: { onPress: () => void }) => {
  const threat = useLiveData((s) => s.threat);
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (threat?.level !== 'critical') return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 0, duration: 700, useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [threat?.level, pulse]);

  const color = threatColor(threat?.level ?? 'low');
  const bg = pulse.interpolate({ inputRange: [0, 1], outputRange: [color, color + '55'] });

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={'Threat level ' + (threat?.level ?? 'unknown') + '. Tap for Threat Center.'}
    >
      <Animated.View style={[styles.banner, { backgroundColor: bg, borderColor: color }]}>
        <Text style={styles.bannerScore}>{threat?.score ?? 0}</Text>
        <View style={styles.bannerMid}>
          <Text style={styles.bannerLevel}>{(threat?.level ?? 'UNKNOWN').toUpperCase()} THREAT</Text>
          <Text style={styles.bannerTrigger} numberOfLines={1}>
            {threat && threat.triggers.length > 0 ? threat.triggers.join(' · ') : 'No active triggers'}
          </Text>
        </View>
        <Text style={styles.bannerChevron}>{'›'}</Text>
      </Animated.View>
    </Pressable>
  );
};

export const DashboardScreen = ({ navigation }: any) => {
  const c = useTheme();
  const isAdmin = useIsAdmin();
  const session = useAdmin((s) => s.session);
  const showRfidModal = useAdmin((s) => s.showRfidWait);
  const connection = useSettings((s) => s.connection);
  const roverStatusValue = useLiveData((s) => s.roverStatus);
  const battery = useLiveData((s) => s.battery);
  const zone = useLiveData((s) => s.zone);
  const threat = useLiveData((s) => s.threat);
  const sensors = useLiveData((s) => s.sensors);
  const lastUpdated = useLiveData((s) => s.lastUpdated);
  const wsState = useLiveData((s) => s.wsState);
  const incidents = useLiveData((s) => s.incidents);

  const [lastDetection, setLastDetection] = useState('Waiting for incidents…');
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (threat && LEVEL_ORDER[threat.level] >= 2) {
      void notifyThreat(threat.level, threat.score, zone);
    }
  }, [threat, zone]);

  useEffect(() => {
    const first = incidents[0];
    if (first) setLastDetection('#' + first.id + ' · ' + first.summary);
  }, [incidents]);

  const showToast = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 2500);
  };

  const requireAdmin = (action: () => void) => {
    if (!session) {
      showRfidModal(true);
      return;
    }
    action();
  };

  const handleTriggerAlarm = () =>
    requireAdmin(() => {
      if (connection.demoMode) triggerDemoAlarm();
      else api.triggerAlarm().catch(() => showToast('Alarm trigger failed'));
      showToast('Alarm triggered');
    });

  const handleReturnHome = () =>
    requireAdmin(() => {
      if (!connection.demoMode) sendRoverCommand({ cmd: 'RETURN_HOME' });
      showToast('Return home command sent');
    });

  const handleStartPatrol = () =>
    requireAdmin(() => {
      if (!connection.demoMode) sendRoverCommand({ cmd: 'PATROL_START' });
      showToast('Patrol started');
    });

  const batteryColor =
    battery == null
      ? c.textMuted
      : battery < 20
        ? palette.threatCritical
        : battery < 45
          ? palette.threatMedium
          : palette.threatLow;

  const sensorList = useMemo(() => Object.values(sensors), [sensors]);

  const statusCard = (label: string, value: string, color: string) => (
    <View key={label} style={[styles.statusCard, { backgroundColor: c.card, borderColor: c.border }]}>
      <Text style={[typography.caption, { color: c.textMuted }]}>{label}</Text>
      <Text style={[typography.h2, { color }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );

  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right']}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.statusGrid}>
          {statusCard('Rover Status', roverStatusValue ? roverStatusValue.state.toUpperCase() : 'OFFLINE', roverStatusValue ? c.text : palette.mutedText)}
          {statusCard('Battery', battery != null ? Math.round(battery) + '%' : '—', batteryColor)}
          {statusCard('Network', wsState === 'demo' ? 'DEMO' : wsState.toUpperCase(), wsState === 'connected' || wsState === 'demo' ? palette.threatLow : palette.threatMedium)}
          {statusCard('Current Zone', zone ?? '—', c.text)}
        </View>

        <ThreatBanner onPress={() => navigation.navigate('ThreatCenter')} />

        <Card onPress={() => navigation.navigate('ZoneMap')}>
          <View style={styles.zoneRow}>
            <Text style={[typography.bodyLg, { color: c.text, fontWeight: '700' }]}>🗺 Zone Map</Text>
            <Text style={[typography.caption, { color: c.textMuted }]}>{zone ?? '—'} · tap to open</Text>
          </View>
        </Card>

        <Card>
          <Text style={[typography.caption, { color: c.textMuted }]}>LAST DETECTION</Text>
          <Text style={[typography.bodyLg, { color: c.text }]} numberOfLines={2}>
            {lastDetection}
          </Text>
          <Text style={[typography.caption, { color: c.textMuted }]}>
            {lastUpdated ? 'Updated ' + timeAgo(lastUpdated) : 'Waiting for data…'}
          </Text>
        </Card>

        <Text style={[typography.h2, { color: c.text }]}>Quick Actions</Text>
        <View style={styles.actions}>
          <PrimaryButton
            label="🛑 Emergency Stop"
            danger
            onPress={() => {
              sendRoverCommand({ cmd: 'STOP' });
              showToast('EMERGENCY STOP sent');
            }}
            sublabel="No auth required · FR-R2"
          />
          <PrimaryButton label="Trigger Alarm" onPress={handleTriggerAlarm} disabled={!isAdmin} sublabel={isAdmin ? undefined : 'RFID required'} />
          <PrimaryButton label="Return Home" onPress={handleReturnHome} disabled={!isAdmin} sublabel={isAdmin ? undefined : 'RFID required'} />
          <PrimaryButton label="Start Patrol" onPress={handleStartPatrol} disabled={!isAdmin} sublabel={isAdmin ? undefined : 'RFID required'} />
        </View>

        <Text style={[typography.h2, { color: c.text }]}>Sensors</Text>
        {sensorList.length === 0 ? (
          <Card>
            <View style={styles.waitRow}>
              <ActivityIndicator color={c.primary} />
              <Text style={[typography.body, { color: c.textMuted }]}>Waiting for sensor data…</Text>
            </View>
          </Card>
        ) : (
          <View style={styles.sensorGrid}>
            {sensorList.map((r) => (
              <SensorCard key={r.id} reading={r} />
            ))}
          </View>
        )}

        {toast ? (
          <View style={styles.toast} pointerEvents="none">
            <Text style={styles.toastText}>{toast}</Text>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: { padding: spacing.lg, gap: spacing.lg, paddingBottom: 40 },
  statusGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  statusCard: { borderWidth: 1, borderRadius: 12, padding: spacing.md, flexGrow: 1, minWidth: 150 },
  banner: { flexDirection: 'row', alignItems: 'center', borderRadius: 14, borderWidth: 2, padding: spacing.lg, gap: spacing.md },
  bannerScore: { fontSize: 44, fontWeight: '800', color: 'white' },
  bannerMid: { flex: 1, gap: 2 },
  bannerLevel: { color: 'white', fontWeight: '800', fontSize: 15, letterSpacing: 0.5 },
  bannerTrigger: { color: 'rgba(255,255,255,0.85)', fontSize: 12 },
  bannerChevron: { color: 'white', fontSize: 28, fontWeight: '700' },
  zoneRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  actions: { gap: spacing.sm },
  waitRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sensorGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  toast: { position: 'absolute', bottom: 24, alignSelf: 'center', backgroundColor: 'rgba(15,23,42,0.92)', paddingHorizontal: 18, paddingVertical: 10, borderRadius: 999 },
  toastText: { color: 'white', fontWeight: '700', fontSize: 13 },
});
