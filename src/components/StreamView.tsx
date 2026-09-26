import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import Svg, { Rect } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { palette, spacing, useTheme } from '../theme/theme';
import { useLiveData } from '../store/rover';
import { useSettings } from '../store/settings';
import { getStreamUri } from '../services/api';

export const StreamView = ({
  height = 260,
  reloadToken = 0,
}: {
  height?: number;
  /** Increment to force the WebView to reload the stream. */
  reloadToken?: number;
}) => {
  const c = useTheme();
  const detections = useLiveData((s) => s.detections);
  const motionActive = useLiveData((s) => s.motionActive);
  const cameraOnline = useLiveData((s) => s.cameraOnline);
  // Re-resolve when discovery changes the host, otherwise the WebView keeps a stale URL.
  const host = useSettings((s) => s.connection.host);
  const streamPort = useSettings((s) => s.connection.streamPort);
  const demoMode = useSettings((s) => s.connection.demoMode);
  const uri = useMemo(() => getStreamUri(), [host, streamPort, demoMode, reloadToken]);

  const boxes = detections?.persons ?? [];
  const showOffline = !demoMode && cameraOnline === false;

  return (
    <View style={[styles.wrap, { height, backgroundColor: '#0b1220' }]}>
      {uri ? (
        <WebView
          key={`stream-${reloadToken}`}
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

      {/* camera offline state */}
      {showOffline ? (
        <View style={[styles.center, StyleSheet.absoluteFill, styles.offline]}>
          <Ionicons name="videocam-off" size={26} color={palette.threatMedium} />
          <Text style={styles.offlineTitle}>Camera offline</Text>
          <Text style={styles.offlineHint}>
            No MJPEG stream on {host}:{streamPort} — check the Pi camera
          </Text>
        </View>
      ) : null}

      {/* top status row: motion dot + live tag */}
      <View style={styles.topRow} pointerEvents="none">
        <View style={styles.livePill}>
          <View
            style={[
              styles.motionDot,
              { backgroundColor: showOffline ? palette.threatMedium : motionActive ? palette.threatCritical : palette.threatLow },
            ]}
          />
          <Text style={styles.liveText}>{showOffline ? 'OFFLINE' : motionActive ? 'MOTION' : 'LIVE'}</Text>
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
  center: { alignItems: 'center', justifyContent: 'center', gap: 4, padding: spacing.lg },
  offline: { backgroundColor: 'rgba(11,18,32,0.94)' },
  offlineTitle: { color: 'white', fontWeight: '800', fontSize: 14, marginTop: 4 },
  offlineHint: { color: 'rgba(226,232,240,0.7)', fontSize: 11, textAlign: 'center' },
  topRow: { position: 'absolute', top: spacing.sm, left: spacing.sm, right: spacing.sm, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  livePill: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(2,6,23,0.65)', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  tsPill: { backgroundColor: 'rgba(2,6,23,0.65)', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  motionDot: { width: 8, height: 8, borderRadius: 4 },
  liveText: { color: 'white', fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
});
