import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import Svg, { Rect } from 'react-native-svg';
import { palette, spacing, useTheme } from '../theme/theme';
import { useLiveData } from '../store/rover';
import { getStreamUri } from '../services/api';

export const StreamView = ({ height = 260 }: { height?: number }) => {
  const c = useTheme();
  const detections = useLiveData((s) => s.detections);
  const motionActive = useLiveData((s) => s.motionActive);
  const uri = useMemo(() => getStreamUri(), []);

  const boxes = detections?.persons ?? [];

  return (
    <View style={[styles.wrap, { height, backgroundColor: '#0b1220' }]}>
      {uri ? (
        <WebView
          source={{ uri }}
          style={styles.webview}
          containerStyle={styles.webview}
          scrollEnabled={false}
          setBuiltInZoomControls={false}
          domStorageEnabled
          originWhitelist={['*']}
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
        />
      ) : (
        <View style={[styles.center, StyleSheet.absoluteFill]}>
          <Text style={{ color: 'white' }}>Camera offline (FR-V4)</Text>
        </View>
      )}

      {/* detection overlay */}
      <Svg style={StyleSheet.absoluteFill} viewBox="0 0 100 100" preserveAspectRatio="none" pointerEvents="none">
        {boxes.map((b, i) => (
          <Rect
            key={i}
            x={(b.x / 640) * 100}
            y={(b.y / 480) * 100}
            width={(b.w / 640) * 100}
            height={(b.h / 480) * 100}
            fill="none"
            stroke={palette.accent}
            strokeWidth={0.7}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </Svg>

      {/* top status row: motion dot + live tag */}
      <View style={styles.topRow} pointerEvents="none">
        <View style={styles.livePill}>
          <View style={[styles.motionDot, { backgroundColor: motionActive ? palette.threatCritical : palette.threatLow }]} />
          <Text style={styles.liveText}>{motionActive ? 'MOTION' : 'LIVE'}</Text>
        </View>
        <View style={styles.tsPill}>
          <Text style={styles.liveText}>{new Date().toLocaleTimeString()}</Text>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: palette.borderDark },
  webview: { flex: 1, backgroundColor: '#0b1220' },
  center: { alignItems: 'center', justifyContent: 'center' },
  topRow: { position: 'absolute', top: spacing.sm, left: spacing.sm, right: spacing.sm, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  livePill: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(2,6,23,0.65)', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  tsPill: { backgroundColor: 'rgba(2,6,23,0.65)', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  motionDot: { width: 8, height: 8, borderRadius: 4 },
  liveText: { color: 'white', fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
});
