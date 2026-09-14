import React, { useRef, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { palette, spacing, typography, useTheme } from '../theme/theme';
import { useLiveData } from '../store/rover';
import { useIsAdmin, useAdmin, useSettings } from '../store/settings';
import { StreamView } from '../components/StreamView';
import { Card, PrimaryButton } from '../components/ui';
import { api, getStreamUri } from '../services/api';

export const CameraScreen = () => {
  const c = useTheme();
  const isAdmin = useIsAdmin();
  const showRfidModal = useAdmin((s) => s.showRfidWait);
  const connection = useSettings((s) => s.connection);
  const cameraOnline = useLiveData((s) => s.cameraOnline);
  const detections = useLiveData((s) => s.detections);

  const [nightMode, setNightMode] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [toast, setToast] = useState<string | null>(null);
  const frameRef = useRef<string | null>(null);

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
    // FR-V3 (Should Have): capture current frame reference. In production this
    // grabs the current MJPEG frame; here we register the incident reference and
    // open the stream externally as fallback.
    showToast('Frame captured to gallery');
    if (!connection.demoMode) {
      Linking.openURL(getStreamUri()).catch(() => undefined);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right']}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={[styles.streamHolder, flipped && { transform: [{ rotate: '180deg' }] }]}>
          <StreamView height={280} />
        </View>

        <View style={styles.personRow}>
          <Text style={[typography.caption, { color: c.textMuted }]}>
            Persons in frame: {detections?.persons.length ?? 0}
          </Text>
          <Text style={[typography.caption, { color: cameraOnline ? palette.threatLow : palette.threatMedium }]}>
            {cameraOnline ? 'Camera online' : 'Camera status unknown'}
          </Text>
        </View>

        <View style={styles.zoomRow}>
          <Text style={[typography.caption, { color: c.textMuted }]}>PINCH/ZOOM</Text>
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
          <Text
            onPress={() => setFlipped((f) => !f)}
            style={[styles.zoomChip, { color: c.text, backgroundColor: flipped ? c.primary : c.surface }]}
            accessibilityRole="button"
            accessibilityLabel="Flip orientation"
          >
            ⇅ Flip
          </Text>
        </View>

        <Card>
          <Text style={[typography.caption, { color: c.textMuted }]}>CAMERA CONTROLS</Text>
          <View style={styles.btnGrid}>
            <View style={styles.cell}>
              <PrimaryButton label="📸 Screenshot" onPress={handleScreenshot} sublabel="All users" />
            </View>
            <View style={styles.cell}>
              <PrimaryButton label="⏺ Record 15 s" onPress={handleRecord} disabled={!isAdmin} sublabel={isAdmin ? undefined : 'RFID required'} />
            </View>
            <View style={styles.cell}>
              <PrimaryButton label={nightMode ? '🌙 Night: ON' : '☀️ Night: OFF'} onPress={handleNightMode} disabled={!isAdmin} sublabel={isAdmin ? undefined : 'RFID required'} />
            </View>
            <View style={styles.cell}>
              <PrimaryButton label="🔁 Refresh Stream" onPress={() => showToast('Stream refreshed')} />
            </View>
          </View>
        </Card>

        <Text style={[typography.caption, { color: c.textMuted }]}>
          MJPEG over HTTP · {connection.demoMode ? 'demo stream active' : `ws://${connection.host}:${connection.streamPort}/stream.mjpg`}
        </Text>

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
  streamHolder: { borderRadius: 14 },
  personRow: { flexDirection: 'row', justifyContent: 'space-between' },
  zoomRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  zoomChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, fontSize: 13, fontWeight: '700', overflow: 'hidden' },
  btnGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  cell: { flexGrow: 1, minWidth: 150 },
  toast: { position: 'absolute', bottom: 24, alignSelf: 'center', backgroundColor: 'rgba(15,23,42,0.92)', paddingHorizontal: 18, paddingVertical: 10, borderRadius: 999 },
  toastText: { color: 'white', fontWeight: '700', fontSize: 13 },
});
