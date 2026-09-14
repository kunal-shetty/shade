import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { palette, spacing, typography, threatColor, useTheme } from '../theme/theme';
import { useLiveData } from '../store/rover';
import { useAdmin, useIsAdmin, useSettings } from '../store/settings';
import { Card, PrimaryButton, SectionHeader, SensorCard, timeAgo } from '../components/ui';
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
        Animated.timing(pulse, { toValue: 1, duration: 650, useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 0, duration: 650, useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [threat?.level, pulse]);

  const level = threat?.level ?? 'low';
  const color = threatColor(level);
  const gradients: Record<ThreatLevel, [string, string]> = {
    low: ['#14532D', '#166534'],
    medium: ['#78350F', '#92400E'],
    high: ['#7C2D12', '#9A3412'],
    critical: ['#7F1D1D', '#B91C1C'],
  };
  const borderColor = pulse.interpolate({ inputRange: [0, 1], outputRange: [color, '#FFFFFF'] });

  const bannerIcon: keyof typeof Ionicons.glyphMap =
    level === 'critical' ? 'alert' : level === 'high' ? 'alert-circle' : level === 'medium' ? 'warning' : 'shield-checkmark';

  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Threat level ${level}. Tap for Threat Center.`}>
      <Animated.View style={[styles.bannerWrap, { borderColor, borderWidth: 2 }]}>
        <LinearGradient colors={gradients[level]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.banner}>
          <View style={styles.bannerScoreWrap}>
            <Text style={styles.bannerScore}>{threat?.score ?? 0}</Text>
            <Text style={styles.bannerScoreLabel}>/100</Text>
          </View>
          <View style={styles.bannerMid}>
            <View style={styles.bannerLevelRow}>
              <Ionicons name={bannerIcon} size={14} color="white" />
              <Text style={styles.bannerLevel}>{level.toUpperCase()} THREAT</Text>
            </View>
            <Text style={styles.bannerTrigger} numberOfLines={1}>
              {threat && threat.triggers.length > 0 ? threat.triggers.join(' · ') : 'All systems nominal'}
            </Text>
          </View>
          <View style={styles.bannerChevronWrap}>
            <Ionicons name="chevron-forward" size={18} color="rgba(255,255,255,0.8)" />
          </View>
        </LinearGradient>
      </Animated.View>
    </Pressable>
  );
};

const StatTile = ({ icon, label, value, color }: { icon: keyof typeof Ionicons.glyphMap; label: string; value: string; color: string }) => {
  const c = useTheme();
  return (
    <View style={[styles.statTile, { backgroundColor: c.card, borderColor: c.border }]}>
      <View style={[styles.statIconWrap, { backgroundColor: `${color}16` }]}>
        <Ionicons name={icon} size={16} color={color} />
      </View>
      <Text style={[typography.caption, { color: c.textMuted, marginTop: 8 }]}>{label}</Text>
      <Text style={[typography.bodyLg, { color, fontWeight: '800', marginTop: 1 }]} numberOfLines={1}>{value}</Text>
    </View>
  );
};

export const DashboardScreen = ({ navigation }: any) => {
  const c = useTheme();
  const isAdmin = useIsAdmin();
  const session = useAdmin((s) => s.session);
  const showRfidModal = useAdmin((s) => s.showRfidWait);
  const connection = useSettings((s) => s.connection);
  const roverStatus = useLiveData((s) => s.roverStatus);
  const battery = useLiveData((s) => s.battery);
  const zone = useLiveData((s) => s.zone);
  const threat = useLiveData((s) => s.threat);
  const sensors = useLiveData((s) => s.sensors);
  const lastUpdated = useLiveData((s) => s.lastUpdated);
  const wsState = useLiveData((s) => s.wsState);
  const incidents = useLiveData((s) => s.incidents);

  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (threat && LEVEL_ORDER[threat.level] >= 2) {
      void notifyThreat(threat.level, threat.score, zone);
    }
  }, [threat, zone]);

  const showToast = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 2400);
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

  const batteryColor = battery == null ? c.textMuted : battery < 20 ? palette.threatCritical : battery < 45 ? palette.threatMedium : palette.threatLow;
  const netOnline = wsState === 'connected' || wsState === 'demo';
  const lastIncident = incidents[0];
  const sensorList = useMemo(() => Object.values(sensors), [sensors]);

  const roverIcon: keyof typeof Ionicons.glyphMap =
    roverStatus?.state === 'patrolling' ? 'scan' : roverStatus?.state === 'manual' ? 'game-controller' : roverStatus?.state === 'returning' ? 'home' : 'pause-circle';

  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right']}>
      <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
        {/* header */}
        <View style={styles.headerRow}>
          <View>
            <Text style={[typography.caption, { color: c.textMuted, letterSpacing: 1.2 }]}>SECURITY COMMAND CENTER</Text>
            <Text style={[typography.h1, { color: c.text, fontSize: 26 }]}>CyberSentinel</Text>
          </View>
          <View style={[styles.liveChip, { backgroundColor: netOnline ? `${palette.threatLow}18` : `${palette.threatMedium}18` }]}>
            <View style={[styles.liveChipDot, { backgroundColor: netOnline ? palette.threatLow : palette.threatMedium }]} />
            <Text style={{ color: netOnline ? palette.threatLow : palette.threatMedium, fontSize: 11, fontWeight: '800' }}>
              {connection.demoMode ? 'DEMO' : netOnline ? 'LIVE' : 'OFFLINE'}
            </Text>
          </View>
        </View>

        {/* stat tiles */}
        <View style={styles.statGrid}>
          <StatTile icon={roverIcon} label="ROVER" value={(roverStatus?.state ?? 'offline').toUpperCase()} color={roverStatus ? c.primary : c.textMuted} />
          <StatTile icon="battery-half" label="BATTERY" value={battery != null ? `${Math.round(battery)}%` : '—'} color={batteryColor} />
          <StatTile icon="git-branch" label="ZONE" value={zone ?? '—'} color={c.text} />
          <StatTile icon="git-commit" label="LAST EVENT" value={lastIncident ? '#' + lastIncident.id : '—'} color={c.accent} />
        </View>

        <ThreatBanner onPress={() => navigation.navigate('ThreatCenter')} />

        {/* last detection */}
        <Card>
          <View style={styles.detectRow}>
            <View style={[styles.detectIcon, { backgroundColor: `${c.accent}16` }]}>
              <Ionicons name="sparkles" size={16} color={c.accent} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[typography.caption, { color: c.textMuted, letterSpacing: 0.8 }]}>LAST DETECTION</Text>
              <Text style={[typography.body, { color: c.text, fontWeight: '600' }]} numberOfLines={2}>
                {lastIncident ? `#${lastIncident.id} · ${lastIncident.summary}` : 'Waiting for incidents…'}
              </Text>
              <Text style={[typography.caption, { color: c.textMuted }]}>
                {lastUpdated ? 'Updated ' + timeAgo(lastUpdated) : 'Waiting for data…'}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={c.textMuted} />
          </View>
        </Card>

        <SectionHeader icon="flash" title="Quick Actions" />
        <View style={styles.actions}>
          <PrimaryButton
            icon="hand-left"
            label="Emergency Stop"
            danger
            onPress={() => {
              sendRoverCommand({ cmd: 'STOP' });
              showToast('EMERGENCY STOP sent');
            }}
            sublabel="No auth required"
          />
          <View style={styles.actionRow}>
            <View style={styles.actionCol}>
              <PrimaryButton icon="notifications" label="Trigger Alarm" onPress={handleTriggerAlarm} disabled={!isAdmin} sublabel={isAdmin ? undefined : 'RFID required'} />
            </View>
            <View style={styles.actionCol}>
              <PrimaryButton icon="home" label="Return Home" onPress={() => requireAdmin(() => { if (!connection.demoMode) sendRoverCommand({ cmd: 'RETURN_HOME' }); showToast('Return home sent'); })} disabled={!isAdmin} sublabel={isAdmin ? undefined : 'RFID required'} />
            </View>
          </View>
          <PrimaryButton icon="scan" label="Start Patrol" onPress={() => requireAdmin(() => { if (!connection.demoMode) sendRoverCommand({ cmd: 'PATROL_START' }); showToast('Patrol started'); })} disabled={!isAdmin} sublabel={isAdmin ? undefined : 'RFID required'} />
        </View>

        {/* zone map link */}
        <Pressable onPress={() => navigation.navigate('ZoneMap')} accessibilityRole="button" accessibilityLabel="Open zone map">
          <LinearGradient colors={[c.primary + '14', c.accent + '10']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={[styles.zoneLink, { borderColor: c.border }]}>
            <View style={[styles.zoneLinkIcon, { backgroundColor: c.primary + '1E' }]}>
              <Ionicons name="map" size={17} color={c.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[typography.body, { color: c.text, fontWeight: '700' }]}>Zone Map</Text>
              <Text style={[typography.caption, { color: c.textMuted }]}>Floor plan · rover position · sensor nodes</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={c.textMuted} />
          </LinearGradient>
        </Pressable>

        <SectionHeader icon="pulse" title="Sensors" right={<Text style={[typography.caption, { color: c.textMuted }]}>{sensorList.length} active</Text>} />
        {sensorList.length === 0 ? (
          <Card>
            <View style={styles.waitRow}>
              <Ionicons name="time" size={16} color={c.textMuted} />
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
            <Ionicons name="checkmark-circle" size={15} color={palette.threatLow} style={{ marginRight: 7 }} />
            <Text style={styles.toastText}>{toast}</Text>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: { padding: spacing.lg, gap: spacing.lg, paddingBottom: 48 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  liveChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  liveChipDot: { width: 7, height: 7, borderRadius: 4 },
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  statTile: { flexGrow: 1, minWidth: 158, borderWidth: 1, borderRadius: 16, padding: spacing.md },
  statIconWrap: { width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  bannerWrap: { borderRadius: 18, overflow: 'hidden' },
  banner: { flexDirection: 'row', alignItems: 'center', padding: spacing.lg, gap: spacing.md },
  bannerScoreWrap: { flexDirection: 'row', alignItems: 'baseline', gap: 2 },
  bannerScore: { fontSize: 42, fontWeight: '900', color: 'white' },
  bannerScoreLabel: { fontSize: 13, fontWeight: '700', color: 'rgba(255,255,255,0.65)' },
  bannerMid: { flex: 1, gap: 3 },
  bannerLevelRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  bannerLevel: { color: 'white', fontWeight: '800', fontSize: 14, letterSpacing: 0.8 },
  bannerTrigger: { color: 'rgba(255,255,255,0.8)', fontSize: 12 },
  bannerChevronWrap: { width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center' },
  detectRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  detectIcon: { width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  actions: { gap: spacing.sm },
  actionRow: { flexDirection: 'row', gap: spacing.sm },
  actionCol: { flex: 1 },
  zoneLink: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderWidth: 1, borderRadius: 16, padding: spacing.md },
  zoneLinkIcon: { width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  waitRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sensorGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  toast: { position: 'absolute', bottom: 28, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(15,23,42,0.94)', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 999 },
  toastText: { color: 'white', fontWeight: '700', fontSize: 13 },
});
