import React, { useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { palette, spacing, typography, useTheme } from '../theme/theme';
import { useLiveData } from '../store/rover';
import { useIsAdmin, useAdmin, useSettings } from '../store/settings';
import { StreamView } from '../components/StreamView';
import { Card, GhostButton, SectionHeader } from '../components/ui';
import { api, getStreamUri } from '../services/api';

export const CameraScreen = () => {
  const c = useTheme();
  const isAdmin = useIsAdmin();
  const showRfidModal = useAdmin((s) => s.showRfidWait);
  const connection = useSettings((s) => s.connection);
  const cameraOnline = useLiveData((s) => s.cameraOnline);
  const detections = useLiveData((s) => s.detections);
  const motionActive = useLiveData((s) => s.motionActive);

  const [nightMode, setNightMode] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 2200);
  };

  const requireAdmin = (fn: () => void) => {
    if (!isAdmin) {
      showRfidModal(true);
      return;
    }
    fn();
  };

  const handleRecord = () =>
    requireAdmin(() => {
      if (!connection.demoMode) api.cameraRecord().catch(() => showToast('Record failed'));
      showToast('Recording 15 s clip…');
    });

  const handleNightMode = () =>
    requireAdmin(() => {
      setNightMode((v) => !v);
      if (!connection.demoMode) api.cameraNightMode().catch(() => showToast('Night mode failed'));
      showToast('Night mode ' + (nightMode ? 'off' : 'on'));
    });

  const handleScreenshot = () => {
    showToast('Frame captured to gallery');
    if (!connection.demoMode) {
      Linking.openURL(getStreamUri()).catch(() => undefined);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right']}>
      <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
        <View style={styles.headerRow}>
          <View>
            <Text style={[typography.caption, { color: c.textMuted, letterSpacing: 1.2 }]}>LIVE SURVEILLANCE</Text>
            <Text style={[typography.h1, { color: c.text, fontSize: 26 }]}>Camera Feed</Text>
          </View>
          <View style={[styles.liveChip, { backgroundColor: motionActive ? `${palette.threatCritical}16` : `${palette.threatLow}16` }]}>
            <View style={[styles.liveDot, { backgroundColor: motionActive ? palette.threatCritical : palette.threatLow }]} />
            <Text style={{ color: motionActive ? palette.threatCritical : palette.threatLow, fontSize: 11, fontWeight: '800' }}>
              {motionActive ? 'MOTION' : 'LIVE'}
            </Text>
          </View>
        </View>

        <View style={[styles.streamHolder, flipped && { transform: [{ rotate: '180deg' }] }]}>
          <StreamView height={280} />
        </View>

        <View style={styles.metaRow}>
          <View style={styles.metaItem}>
            <Ionicons name="person" size={13} color={c.textMuted} />
            <Text style={[typography.caption, { color: c.textMuted }]}> {detections?.persons.length ?? 0} in frame</Text>
          </View>
          <View style={styles.metaItem}>
            <Ionicons name="scan" size={13} color={c.textMuted} />
            <Text style={[typography.caption, { color: c.textMuted }]}> 640×480 MJPEG</Text>
          </View>
          <View style={styles.metaItem}>
            <Ionicons name={cameraOnline ? 'checkmark-circle' : 'help-circle'} size={13} color={cameraOnline ? palette.threatLow : c.textMuted} />
            <Text style={[typography.caption, { color: c.textMuted }]}> {cameraOnline ? 'online' : 'unknown'}</Text>
          </View>
        </View>

        <View style={styles.zoomRow}>
          <Text style={[typography.caption, { color: c.textMuted, letterSpacing: 1 }]}>ZOOM</Text>
          {[1, 1.5, 2].map((z) => (
            <Text
              key={z}
              onPress={() => setZoom(z)}
              style={[styles.zoomChip, { color: zoom === z ? 'white' : c.text, backgroundColor: zoom === z ? c.primary : c.surface }]}
              accessibilityRole="button"
              accessibilityLabel={'Zoom ' + z + 'x'}
            >
              {z}x
            </Text>
          ))}
          <View style={{ flex: 1 }} />
          <GhostButton icon={flipped ? 'refresh' : 'sync'} label="Flip" onPress={() => setFlipped((f) => !f)} />
        </View>

        <SectionHeader icon="videocam" title="Camera Controls" />
        <View style={styles.btnGrid}>
          <View style={styles.cell}><GhostButton icon="camera" label="Screenshot" onPress={handleScreenshot} /></View>
          <View style={styles.cell}><GhostButton icon="radio-button-on" label="Record 15 s" onPress={handleRecord} disabled={!isAdmin} /></View>
          <View style={styles.cell}><GhostButton icon={nightMode ? 'moon' : 'sunny'} label={nightMode ? 'Night ON' : 'Night OFF'} onPress={handleNightMode} disabled={!isAdmin} /></View>
          <View style={styles.cell}><GhostButton icon="refresh" label="Refresh" onPress={() => showToast('Stream refreshed')} /></View>
        </View>

        <Card>
          <View style={styles.metaItem}>
            <Ionicons name="information-circle" size={14} color={c.textMuted} />
            <Text style={[typography.caption, { color: c.textMuted, flex: 1 }]}>
              {' '}{connection.demoMode ? 'Demo stream active — connect to the Pi for the live rover camera.' : `Streaming from http://${connection.host}:${connection.streamPort}/stream.mjpg`}
            </Text>
          </View>
        </Card>

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
  liveDot: { width: 7, height: 7, borderRadius: 4 },
  streamHolder: { borderRadius: 18, overflow: 'hidden' },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: spacing.sm },
  metaItem: { flexDirection: 'row', alignItems: 'center' },
  zoomRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  zoomChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, fontSize: 12, fontWeight: '800', overflow: 'hidden' },
  btnGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  cell: { flexGrow: 1, minWidth: 150 },
  toast: { position: 'absolute', bottom: 28, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(15,23,42,0.94)', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 999 },
  toastText: { color: 'white', fontWeight: '700', fontSize: 13 },
});
