import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, Line } from 'react-native-svg';
import { palette, spacing, typography, useTheme } from '../theme/theme';
import { useLiveData } from '../store/rover';
import { useIsAdmin, useAdmin } from '../store/settings';
import { AdminLock } from '../components/AdminLock';
import { JoystickPad } from '../components/JoystickPad';
import { ArcGauge } from '../components/Gauges';
import { Card, PrimaryButton } from '../components/ui';
import { createJoystickSender, sendRoverCommand } from '../services/roverLink';

const SpeedSlider = ({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled: boolean }) => {
  const c = useTheme();
  return (
    <View>
      <View style={styles.sliderRow}>
        <Text style={[typography.body, { color: c.textMuted }]}>Speed Limit</Text>
        <Text style={[typography.body, { color: c.text, fontWeight: '700' }]}>{value}%</Text>
      </View>
      <View style={styles.sliderTrack}>
        <View style={[styles.sliderFill, { width: `${value}%`, backgroundColor: disabled ? c.border : c.primary }]} />
        <View style={[styles.sliderThumb, { left: `${Math.max(0, Math.min(96, value - 4))}%`, backgroundColor: disabled ? c.border : c.primary }]} />
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
          <View
            key={i}
            style={[styles.sliderTickHit, { left: `${i * 10}%` }]}
            onTouchEnd={disabled ? undefined : () => onChange(Math.max(10, (i + 1) * 10))}
          />
        ))}
      </View>
      <Text style={[typography.caption, { color: c.textMuted }]}>10–100% · sent with every MOVE command (FR-R4)</Text>
    </View>
  );
};

const Compass = ({ heading }: { heading: number }) => {
  const c = useTheme();
  const needle = (heading - 90) * (Math.PI / 180);
  const cx = 60;
  const cy = 60;
  return (
    <View style={{ alignItems: 'center' }}>
      <Svg width={120} height={120}>
        <Circle cx={cx} cy={cy} r={52} fill="none" stroke={c.border} strokeWidth={2} />
        {['N', 'E', 'S', 'W'].map((d, i) => {
          const a = (i * 90 - 90) * (Math.PI / 180);
          return (
            <Circle key={d} cx={cx + 44 * Math.cos(a)} cy={cy + 44 * Math.sin(a)} r={2} fill={c.textMuted} />
          );
        })}
        <Line x1={cx} y1={cy} x2={cx + 40 * Math.cos(needle)} y2={cy + 40 * Math.sin(needle)} stroke={palette.accent} strokeWidth={4} strokeLinecap="round" />
        <Circle cx={cx} cy={cy} r={5} fill={c.text} />
      </Svg>
      <Text style={[typography.caption, { color: c.textMuted }]}>{Math.round(heading)}° heading</Text>
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

  // keep speed limit in every movement command (FR-R4)
  useEffect(() => {
    sendRoverCommand({ cmd: 'SET_SPEED', value: speedLimit });
  }, [speedLimit]);

  const togglePatrol = () => {
    const next = !patrolActive;
    setPatrolActive(next);
    sendRoverCommand(next ? { cmd: 'PATROL_START' } : { cmd: 'PATROL_STOP' });
  };

  const connected = wsState === 'connected' || wsState === 'demo';

  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right']}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.statusRow}>
          <Text style={[typography.h2, { color: c.text }]}>Manual Control</Text>
          <Text style={[typography.caption, { color: connected ? palette.threatLow : palette.threatMedium }]}>
            {connected ? 'Link ready' : 'Link down'} · {wsLatency != null ? wsLatency + ' ms RTT' : 'measuring…'}
          </Text>
        </View>

        {/* Joystick — full control requires admin (FR-R1/R3); STOP always allowed */}
        <AdminLock onRequestUnlock={() => showRfidModal(true)} lockedHint="Scan RFID at rover to unlock driving">
          <JoystickPad
            disabled={!isAdmin || !connected}
            onMove={(angle, speed) => sender.move(angle, speed, speedLimit)}
            onStop={() => sender.stop()}
          />
        </AdminLock>

        <Card>
          <SpeedSlider value={speedLimit} onChange={setSpeedLimit} disabled={!isAdmin} />
        </Card>

        <Card>
          <View style={styles.controlRow}>
            <View style={styles.controlBtn}>
              <PrimaryButton label={patrolActive ? 'Stop Patrol' : 'Start Patrol'} onPress={isAdmin ? togglePatrol : () => showRfidModal(true)} disabled={!connected} sublabel={isAdmin ? undefined : 'RFID required'} />
            </View>
            <View style={styles.controlBtn}>
              <PrimaryButton label="Return Home" onPress={() => { if (isAdmin) sendRoverCommand({ cmd: 'RETURN_HOME' }); else showRfidModal(true); }} sublabel={isAdmin ? undefined : 'RFID required'} />
            </View>
          </View>
          <View style={styles.controlRow}>
            <View style={styles.controlBtn}>
              <PrimaryButton label="🔊 Horn" onPress={() => { if (isAdmin) sendRoverCommand({ cmd: 'BUZZER', duration: 1000 }); else showRfidModal(true); }} sublabel={isAdmin ? undefined : 'RFID required'} />
            </View>
            <View style={styles.controlBtn}>
              <PrimaryButton label="🛑 EMERGENCY STOP" danger onPress={() => sendRoverCommand({ cmd: 'STOP' })} sublabel="Always available" />
            </View>
          </View>
          {patrolActive ? (
            <View style={[styles.patrolPill, { backgroundColor: palette.threatLow + '22' }]}>
              <Text style={{ color: palette.threatLow, fontWeight: '800', fontSize: 12 }}>● PATROL ACTIVE (FR-R5)</Text>
            </View>
          ) : null}
        </Card>

        {/* Telemetry mini-panel (PRD §6.2.3) */}
        <Text style={[typography.h2, { color: c.text }]}>Telemetry</Text>
        <Card>
          <View style={styles.telemetryRow}>
            <ArcGauge valueCm={telemetry?.ultrasonic_cm ?? 0} />
            <Compass heading={telemetry?.heading ?? 0} />
          </View>
          <View style={styles.motorRow}>
            <View style={[styles.motorBox, { backgroundColor: c.surface }]}>
              <Text style={[typography.caption, { color: c.textMuted }]}>MOTOR L</Text>
              <Text style={[typography.h2, { color: c.text }]}>{Math.round(telemetry?.speed_l ?? 0)}%</Text>
            </View>
            <View style={[styles.motorBox, { backgroundColor: c.surface }]}>
              <Text style={[typography.caption, { color: c.textMuted }]}>MOTOR R</Text>
              <Text style={[typography.h2, { color: c.text }]}>{Math.round(telemetry?.speed_r ?? 0)}%</Text>
            </View>
            <View style={[styles.motorBox, { backgroundColor: c.surface }]}>
              <Text style={[typography.caption, { color: c.textMuted }]}>STATE</Text>
              <Text style={[typography.body, { color: c.text, fontWeight: '700' }]}>
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
  container: { padding: spacing.lg, gap: spacing.lg, paddingBottom: 40 },
  statusRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sliderRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  sliderTrack: { height: 44, borderRadius: 10, backgroundColor: 'rgba(148,163,184,0.25)', overflow: 'hidden', justifyContent: 'center' },
  sliderFill: { height: '100%', borderRadius: 10 },
  sliderThumb: { position: 'absolute', top: 8, width: 10, height: 28, borderRadius: 5 },
  sliderTickHit: { position: 'absolute', top: 0, bottom: 0, width: '12%' },
  controlRow: { flexDirection: 'row', gap: spacing.sm },
  controlBtn: { flex: 1 },
  patrolPill: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, marginTop: 8 },
  telemetryRow: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm },
  motorRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  motorBox: { flex: 1, borderRadius: 10, padding: spacing.sm, alignItems: 'center', gap: 2 },
});
