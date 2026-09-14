import React, { useRef, useState } from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { palette, useTheme } from '../theme/theme';

const SIZE = 220;
const RADIUS = SIZE / 2;
const KNOB = 72;

export interface JoystickPadProps {
  onMove: (angle: number, speed: number) => void; // angle deg 0=up, cw; speed 0..100
  onStop: () => void;
  disabled?: boolean;
}

export const JoystickPad = ({ onMove, onStop, disabled }: JoystickPadProps) => {
  const c = useTheme();
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const [active, setActive] = useState(false);
  const lastEmit = useRef(0);

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !disabled,
      onMoveShouldSetPanResponder: () => !disabled,
      onPanResponderGrant: () => {
        if (disabled) return;
        setActive(true);
      },
      onPanResponderMove: (_e, g) => {
        if (disabled) return;
        const dx = g.dx;
        const dy = g.dy;
        const dist = Math.hypot(dx, dy);
        const max = RADIUS - KNOB / 2;
        const clamped = Math.min(dist, max);
        const nx = dist === 0 ? 0 : (dx / dist) * clamped;
        const ny = dist === 0 ? 0 : (dy / dist) * clamped;
        setKnob({ x: nx, y: ny });
        const now = Date.now();
        if (now - lastEmit.current >= 100) {
          lastEmit.current = now;
          const angle = (Math.atan2(nx, -ny) * 180) / Math.PI; // 0 = up, clockwise
          const speed = Math.round((clamped / max) * 100);
          onMove(Math.round(angle), speed);
        }
      },
      onPanResponderRelease: () => {
        setKnob({ x: 0, y: 0 });
        setActive(false);
        onStop();
      },
      onPanResponderTerminate: () => {
        setKnob({ x: 0, y: 0 });
        setActive(false);
        onStop();
      },
    }),
  ).current;

  const ringColor = disabled ? c.border : active ? palette.accent : c.textMuted;

  return (
    <View
      style={[styles.base, { borderColor: ringColor, backgroundColor: c.surface }]}
      accessibilityLabel="Virtual joystick"
      accessibilityHint={disabled ? 'Locked: admin authentication required' : 'Drag to drive the rover; release to stop'}
      {...pan.panHandlers}
    >
      <View style={[styles.innerRing, { borderColor: c.border }]} />
      <View style={styles.crossWrap} pointerEvents="none">
        <View style={[styles.axisChip, { backgroundColor: c.card, borderColor: c.border }]}><Ionicons name="chevron-up" size={13} color={c.textMuted} /></View>
        <View style={[styles.axisChip, { backgroundColor: c.card, borderColor: c.border }]}><Ionicons name="chevron-forward" size={13} color={c.textMuted} /></View>
        <View style={[styles.axisChip, { backgroundColor: c.card, borderColor: c.border }]}><Ionicons name="chevron-down" size={13} color={c.textMuted} /></View>
        <View style={[styles.axisChip, { backgroundColor: c.card, borderColor: c.border }]}><Ionicons name="chevron-back" size={13} color={c.textMuted} /></View>
      </View>
      <View
        style={[
          styles.knob,
          { transform: [{ translateX: knob.x }, { translateY: knob.y }] },
        ]}
      >
        <LinearGradient
          colors={disabled ? ['#64748B', '#475569'] : active ? [palette.accent, '#0284C7'] : [palette.primary, '#12439E']}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={styles.knobGrad}
        >
          <Ionicons name={disabled ? 'lock-closed' : 'open'} size={24} color="white" />
        </LinearGradient>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  base: {
    width: SIZE, height: SIZE, borderRadius: RADIUS,
    borderWidth: 3, alignItems: 'center', justifyContent: 'center',
    alignSelf: 'center',
  },
  innerRing: { position: 'absolute', width: RADIUS, height: RADIUS, borderRadius: RADIUS / 2, borderWidth: 1.5 },
  crossWrap: {
    position: 'absolute', width: SIZE, height: SIZE, alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 10,
  },
  axisChip: { width: 26, height: 26, borderRadius: 13, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  knob: {
    width: KNOB, height: KNOB, borderRadius: KNOB / 2,
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 6,
  },
  knobGrad: { width: KNOB, height: KNOB, borderRadius: KNOB / 2, alignItems: 'center', justifyContent: 'center' },
});
