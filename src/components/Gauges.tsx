import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path, Text as SvgText } from 'react-native-svg';
import { palette, threatColor, useTheme } from '../theme/theme';
import type { ThreatState } from '../types';

// ---------------- ThreatRadar ----------------

const RINGS = [
  { r: 0.25, label: 'Low', color: palette.threatLow },
  { r: 0.5, label: 'Medium', color: palette.threatMedium },
  { r: 0.75, label: 'High', color: palette.threatHigh },
  { r: 1.0, label: 'Critical', color: palette.threatCritical },
];

export const ThreatRadar = ({ threat }: { threat: ThreatState | null }) => {
  const c = useTheme();
  const sweep = useRef(new Animated.Value(0)).current;
  const score = useRef(new Animated.Value(0)).current;
  const scoreVal = threat?.score ?? 0;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(sweep, { toValue: 1, duration: 2600, easing: Easing.linear, useNativeDriver: false }),
    );
    loop.start();
    return () => loop.stop();
  }, [sweep]);

  useEffect(() => {
    Animated.timing(score, { toValue: scoreVal, duration: 700, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  }, [scoreVal, score]);

  const SIZE = 240;
  const R = SIZE / 2 - 8;
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const levelColor = threatColor(threat?.level ?? 'low');

  const sweepDeg = sweep.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <View style={{ alignItems: 'center' }}>
      <View style={{ width: SIZE, height: SIZE }}>
        <Svg width={SIZE} height={SIZE}>
          <Circle cx={cx} cy={cy} r={R} fill={c.surface} stroke={c.border} strokeWidth={1.5} />
          {RINGS.map((ring) => (
            <Circle key={ring.label} cx={cx} cy={cy} r={R * ring.r} fill="none" stroke={c.border} strokeWidth={1} strokeDasharray="3 4" />
          ))}
          <Circle cx={cx} cy={cy} r={4} fill={c.textMuted} />
        </Svg>

        {/* score fill: vertical rise from bottom of circle */}
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <Animated.View
            style={{
              position: 'absolute', left: 8, right: 8, bottom: 8,
              height: score.interpolate({
                inputRange: [0, 100],
                outputRange: [0, (R * 2) * 0.999],
              }),
              backgroundColor: `${levelColor}33`,
              borderTopColor: levelColor,
              borderTopWidth: 2,
              borderBottomLeftRadius: R,
              borderBottomRightRadius: R,
            }}
          />
        </View>

        {/* radar sweep */}
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { transform: [{ rotate: sweepDeg }] }]}
        >
          <View
            style={{
              width: R * 2, height: R * 2, borderRadius: R, marginLeft: (SIZE - R * 2) / 2, marginTop: (SIZE - R * 2) / 2,
              backgroundColor: 'transparent',
              borderLeftWidth: 2, borderLeftColor: `${levelColor}AA`,
            }}
          />
        </Animated.View>

        {/* center readout */}
        <View style={styles.readout} pointerEvents="none">
          <Text style={[styles.scoreText, { color: levelColor }]}>{Math.round(scoreVal)}</Text>
          <Text style={[styles.levelText, { color: c.textMuted }]}>{(threat?.level ?? '—').toUpperCase()}</Text>
          {threat && threat.triggers.length > 0 ? (
            <Text style={[styles.triggerText, { color: c.text }]} numberOfLines={2}>{threat.triggers.join(' · ')}</Text>
          ) : null}
        </View>
      </View>
    </View>
  );
};

// ---------------- ArcGauge (ultrasonic) ----------------

export const ArcGauge = ({ valueCm, max = 200 }: { valueCm: number; max?: number }) => {
  const c = useTheme();
  const ratio = Math.max(0, Math.min(1, valueCm / max));
  const W = 150;
  const H = 90;
  const r = 60;
  const cx = W / 2;
  const cy = H;
  const startAngle = Math.PI;
  const endAngle = 0;
  const a = startAngle + (endAngle - startAngle) * ratio;
  const px = cx + r * Math.cos(a);
  const py = cy - r * Math.sin(a);
  const largeArc = 0;
  const color = valueCm < 20 ? palette.threatCritical : valueCm < 40 ? palette.threatMedium : palette.threatLow;
  const arcPath = `M ${cx - r} ${cy} A ${r} ${r} 0 ${largeArc} 1 ${cx + r} ${cy}`;
  const valPath = `M ${cx - r} ${cy} A ${r} ${r} 0 ${largeArc} 1 ${px.toFixed(2)} ${py.toFixed(2)}`;

  return (
    <View style={{ alignItems: 'center' }}>
      <Svg width={W} height={H + 4}>
        <Path d={arcPath} stroke={c.border} strokeWidth={10} fill="none" strokeLinecap="round" />
        <Path d={valPath} stroke={color} strokeWidth={10} fill="none" strokeLinecap="round" />
        <SvgText x={cx} y={cy - 8} textAnchor="middle" fontSize={20} fontWeight="700" fill={c.text}>
          {Math.round(valueCm)}
        </SvgText>
        <SvgText x={cx} y={cy + 2} textAnchor="middle" fontSize={9} fill={c.textMuted}>
          cm · ultrasonic
        </SvgText>
      </Svg>
    </View>
  );
};

const styles = StyleSheet.create({
  readout: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  scoreText: { fontSize: 48, fontWeight: '800' },
  levelText: { fontSize: 13, fontWeight: '700', letterSpacing: 1 },
  triggerText: { fontSize: 11, marginTop: 4, maxWidth: 150, textAlign: 'center' },
});
