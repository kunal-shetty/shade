import React, { useEffect, useRef, useState } from 'react';
import { PanResponder, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, Line } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { palette, spacing, typography, useTheme } from '../theme/theme';
import { useLiveData } from '../store/rover';
import { useIsAdmin, useAdmin } from '../store/settings';
import { AdminLock } from '../components/AdminLock';
import { JoystickPad } from '../components/JoystickPad';
import { ArcGauge } from '../components/Gauges';
import { Card, PrimaryButton, SectionHeader } from '../components/ui';
import { createJoystickSender, sendRoverCommand } from '../services/roverLink';

const SpeedSlider = ({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled: boolean }) => {
  const c = useTheme();
  const trackW = useRef(0);
  const drag = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !disabled,
      onMoveShouldSetPanResponder: () => !disabled,
      onPanResponderGrant: (e) => {
        const pct = Math.round((e.nativeEvent.locationX / Math.max(1, trackW.current)) * 100);
        onChange(Math.max(10, Math.min(100, pct)));
      },
      onPanResponderMove: (e) => {
        const pct = Math.round((e.nativeEvent.locationX / Math.max(1, trackW.current)) * 100);
        onChange(Math.max(10, Math.min(100, pct)));
      },
    }),
  ).current;

  return (
    <View>
      <View style={styles.sliderRow}>
        <View style={styles.sliderLabel}>
          <Ionicons name="speedometer" size={14} color={c.primary} />
          <Text style={[typography.body, { color: c.textMuted }]}> Speed Limit</Text>
        </View>
        <Text style={[typography.bodyLg, { color: c.primary, fontWeight: '800' }]}>{value}%</Text>
      </View>
      <View
        style={styles.sliderTrackWrap}
        onLayout={(e) => (trackW.current = e.nativeEvent.layout.width)}
        {...drag.panHandlers}
      >
        <View style={[styles.sliderTrack, { backgroundColor: c.surface }]}>
          <View style={[styles.sliderFill, { width: `${value}%` }]} />
          <View style={[styles.sliderThumb, { left: `${Math.max(0, Math.min(92, value - 4))}%` }]} />
        </View>
      </View>
      <View style={styles.sliderHintRow}>
        <Text style={[typography.caption, { color: c.textMuted }]}>10%</Text>
        <Text style={[typography.caption, { color: c.textMuted }]}>sent with every MOVE · FR-R4</Text>
        <Text style={[typography.caption, { color: c.textMuted }]}>100%</Text>
      </View>
    </View>
  );
};

const Compass = ({ heading }: { heading: number }) => {
  const c = useTheme();
  const needle = (heading - 90) * (Math.PI / 180);
  const cx = 56;
  const cy = 56;
  return (
    <View style={{ alignItems: 'center' }}>
      <Svg width={112} height={112}>
        <Circle cx={cx} cy={cy} r={50} fill="none" stroke={c.border} strokeWidth={2} />
        <Circle cx={cx} cy={cy} r={38} fill="none" stroke={c.border} strokeWidth={1} strokeDasharray="3 4" />
        {['N', 'E', 'S', 'W'].map((d, i) => {
          const a = (i * 90 - 90) * (Math.PI / 180);
          return <Circle key={d} cx={cx + 44 * Math.cos(a)} cy={cy + 44 * Math.sin(a)} r={2.5} fill={c.textMuted} />;
        })}
        <Line x1={cx} y1={cy} x2={cx + 40 * Math.cos(needle)} y2={cy + 40 * Math.sin(needle)} stroke={palette.accent} strokeWidth={4} strokeLinecap="round" />
        <Circle cx={cx} cy={cy} r={5} fill={c.text} />
      </Svg>
      <Text style={[typography.caption, { color: c.textMuted, marginTop: 4 }]}>{Math.round(heading)}° heading</Text>
    </View>
  );
};

export const ControlScreen = () => {
  const c = useTheme();
  const isAdmin = useIsAdmin();
  const showRfidModal = useAdmin((s) => s.showRfidWait);
  const telemetry = useLiveData((s) => s.telemetry);
  const roverStatus = useLiveData((s) => s.roverStatus);
  const wsLatency = useLiveData((s) => s.wsLatencyMs);
  const wsState = useLiveData((s) => s.wsState);

  const [speedLimit, setSpeedLimit] = useState(60);
  const [patrolActive, setPatrolActive] = useState(false);
  const sender = useRef(createJoystickSender()).current;

  useEffect(() => {
    sendRoverCommand({ cmd: 'SET_SPEED', value: speedLimit });
  }, [speedLimit]);

  const togglePatrol = () => {
    const next = !patrolActive;
    setPatrolActive(next);
    sendRoverCommand(next ? { cmd: 'PATROL_START' } : { cmd: 'PATROL_STOP' });
  };

  const connected = wsState === 'connected' || wsState === 'demo';
  const lock = (fn: () => void) => () => (isAdmin ? fn() : showRfidModal(true));

  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right']}>
      <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
        <View style={styles.headerRow}>
          <View>
            <Text style={[typography.caption, { color: c.textMuted, letterSpacing: 1.2 }]}>MANUAL OVERRIDE</Text>
            <Text style={[typography.h1, { color: c.text, fontSize: 26 }]}>Rover Control</Text>
          </View>
          <View style={[styles.linkChip, { backgroundColor: connected ? `${palette.threatLow}16` : `${palette.threatMedium}16` }]}>
            <Ionicons name={connected ? 'wifi' : 'wifi-outline'} size={12} color={connected ? palette.threatLow : palette.threatMedium} />
            <Text style={{ color: connected ? palette.threatLow : palette.threatMedium, fontSize: 11, fontWeight: '800' }}>
              {connected ? (wsLatency != null ? `${wsLatency} ms` : 'READY') : 'DOWN'}
            </Text>
          </View>
        </View>

        {/* Joystick */}
        <AdminLock onRequestUnlock={() => showRfidModal(true)} lockedHint="Scan RFID at rover to unlock driving">
          <View style={[styles.joyCard, { backgroundColor: c.card, borderColor: c.border }]}>
            <JoystickPad
              disabled={false}
              onMove={(angle, speed) => sender.move(angle, speed, speedLimit)}
              onStop={() => sender.stop()}
            />
            <Text style={[typography.caption, { color: c.textMuted, marginTop: spacing.md, textAlign: 'center' }]}>
              Drag to drive · release to stop · FR-R1
            </Text>
          </View>
        </AdminLock>

        <Card>
          <SpeedSlider value={speedLimit} onChange={setSpeedLimit} disabled={!isAdmin} />
        </Card>

        <SectionHeader icon="extension-puzzle" title="Drive Commands" />
        <View style={styles.btnGrid}>
          <View style={styles.cell}>
            <PrimaryButton icon={patrolActive ? 'stop' : 'play'} label={patrolActive ? 'Stop Patrol' : 'Start Patrol'} onPress={lock(togglePatrol)} disabled={!connected} sublabel={isAdmin ? undefined : 'RFID required'} />
          </View>
          <View style={styles.cell}>
            <PrimaryButton icon="home" label="Return Home" onPress={lock(() => { sendRoverCommand({ cmd: 'RETURN_HOME' }); })} sublabel={isAdmin ? undefined : 'RFID required'} />
          </View>
          <View style={styles.cell}>
            <PrimaryButton icon="megaphone" label="Horn" onPress={lock(() => { sendRoverCommand({ cmd: 'BUZZER', duration: 1000 }); })} sublabel={isAdmin ? undefined : 'RFID required'} />
          </View>
          <View style={styles.cell}>
            <PrimaryButton icon="hand-left" label="E-Stop" danger onPress={() => sendRoverCommand({ cmd: 'STOP' })} sublabel="Always available" />
          </View>
        </View>

        {patrolActive ? (
          <View style={[styles.patrolPill, { backgroundColor: `${palette.threatLow}16` }]}>
            <View style={[styles.patrolDot, { backgroundColor: palette.threatLow }]} />
            <Text style={{ color: palette.threatLow, fontWeight: '800', fontSize: 12 }}>PATROL ACTIVE · FR-R5</Text>
          </View>
        ) : null}

        {/* Telemetry */}
        <SectionHeader icon="speedometer" title="Telemetry" />
        <Card>
          <View style={styles.telemetryRow}>
            <ArcGauge valueCm={telemetry?.ultrasonic_cm ?? 0} />
            <Compass heading={telemetry?.heading ?? 0} />
          </View>
          <View style={styles.motorRow}>
            <View style={[styles.motorBox, { backgroundColor: c.surface }]}>
              <Ionicons name="swap-horizontal" size={13} color={c.textMuted} />
              <Text style={[typography.caption, { color: c.textMuted }]}>MOTOR L</Text>
              <Text style={[typography.h2, { color: c.text }]}>{Math.round(telemetry?.speed_l ?? 0)}%</Text>
            </View>
            <View style={[styles.motorBox, { backgroundColor: c.surface }]}>
              <Ionicons name="swap-horizontal" size={13} color={c.textMuted} />
              <Text style={[typography.caption, { color: c.textMuted }]}>MOTOR R</Text>
              <Text style={[typography.h2, { color: c.text }]}>{Math.round(telemetry?.speed_r ?? 0)}%</Text>
            </View>
            <View style={[styles.motorBox, { backgroundColor: c.surface }]}>
              <Ionicons name="navigate" size={13} color={c.textMuted} />
              <Text style={[typography.caption, { color: c.textMuted }]}>STATE</Text>
              <Text style={[typography.body, { color: c.text, fontWeight: '800' }]}>
                {(roverStatus?.state ?? 'offline').toUpperCase()}
              </Text>
            </View>
          </View>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: { padding: spacing.lg, gap: spacing.lg, paddingBottom: 48 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  linkChip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  joyCard: { borderWidth: 1, borderRadius: 18, padding: spacing.xl, alignItems: 'center' },
  sliderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  sliderLabel: { flexDirection: 'row', alignItems: 'center' },
  sliderTrackWrap: { paddingVertical: 10 },
  sliderTrack: { height: 14, borderRadius: 7, overflow: 'hidden', justifyContent: 'center' },
  sliderFill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 7, backgroundColor: palette.primary },
  sliderThumb: { position: 'absolute', top: -4, width: 22, height: 22, borderRadius: 11, backgroundColor: 'white', borderWidth: 4, borderColor: palette.primary, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 4 },
  sliderHintRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 },
  btnGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  cell: { flexGrow: 1, minWidth: 160 },
  patrolPill: { flexDirection: 'row', alignItems: 'center', gap: 7, alignSelf: 'center', paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999 },
  patrolDot: { width: 7, height: 7, borderRadius: 4 },
  telemetryRow: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', flexWrap: 'wrap', gap: spacing.md },
  motorRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  motorBox: { flex: 1, borderRadius: 12, padding: spacing.md, alignItems: 'center', gap: 3 },
});
