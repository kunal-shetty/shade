import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { palette, spacing, typography, useTheme } from '../theme/theme';
import { useAdmin, useSettings } from '../store/settings';
import { Card } from '../components/ui';
import { disconnectMqtt, connectMqtt } from '../services/mqtt';
import { connectRoverLink, disconnectRoverLink } from '../services/roverLink';
import { registerPushToken, requestNotificationPermission } from '../services/notifications';

const Row = ({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) => {
  const c = useTheme();
  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={[typography.body, { color: c.text }]}>{label}</Text>
        {hint ? <Text style={[typography.caption, { color: c.textMuted }]}>{hint}</Text> : null}
      </View>
      {children}
    </View>
  );
};

const NumberField = ({ value, onChange }: { value: number; onChange: (v: number) => void }) => {
  const c = useTheme();
  return (
    <TextInput
      value={String(value)}
      onChangeText={(t) => {
        const n = parseInt(t, 10);
        if (!Number.isNaN(n)) onChange(n);
      }}
      keyboardType="number-pad"
      style={[styles.input, { borderColor: c.border, color: c.text, backgroundColor: c.surface }]}
    />
  );
};

const Picker = ({ options, value, onChange }: { options: readonly string[]; value: string; onChange: (v: string) => void }) => {
  const c = useTheme();
  return (
    <View style={styles.pickerRow}>
      {options.map((o) => (
        <Text
          key={o}
          onPress={() => onChange(o)}
          style={[styles.pickerOpt, { backgroundColor: value === o ? c.primary : c.surface, color: value === o ? 'white' : c.text }]}
          accessibilityRole="button"
          accessibilityLabel={o}
        >
          {o}
        </Text>
      ))}
    </View>
  );
};

export const SettingsScreen = () => {
  const c = useTheme();
  const connection = useSettings((s) => s.connection);
  const setConnection = useSettings((s) => s.setConnection);
  const prefs = useSettings((s) => s.prefs);
  const setPrefs = useSettings((s) => s.setPrefs);
  const session = useAdmin((s) => s.session);
  const unlock = useAdmin((s) => s.unlock);
  const logout = useAdmin((s) => s.logout);
  const showRfidWait = useAdmin((s) => s.showRfidWait);

  const [hostDraft, setHostDraft] = useState(connection.host);
  const [pushStatus, setPushStatus] = useState('');

  // reconnect services when Save is pressed
  const applyAndReconnect = () => {
    setConnection({ host: hostDraft.trim() || '192.168.4.1' });
    disconnectMqtt();
    disconnectRoverLink();
    connectMqtt();
    connectRoverLink();
  };

  const handleAdminLogin = () => {
    // Opens the RFID modal (PRD §6.7.1 step 1). On real hardware the Pi publishes
    // rfid/auth | rfid/denied; in Demo Mode the modal auto-simulates a granted scan.
    showRfidWait(true);
  };

  useEffect(() => {
    if (connection.demoMode) return;
    void requestNotificationPermission().then((ok) => setPushStatus(ok ? 'Permissions granted' : 'Not granted'));
    void registerPushToken();
  }, []);

  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={[typography.h1, { color: c.text }]}>Settings</Text>

        {/* Admin section */}
        <Card>
          <Text style={[typography.caption, { color: c.textMuted }]}>ADMIN SESSION</Text>
          {session ? (
            <>
              <Text style={[typography.bodyLg, { color: palette.threatLow, fontWeight: '700' }]}>
                Unlocked · card {session.uid}
              </Text>
              <Text style={[typography.caption, { color: c.textMuted }]}>
                Expires {new Date(session.expiresAt).toLocaleTimeString()}
              </Text>
              <Text
                onPress={logout}
                style={{ color: 'white', backgroundColor: palette.threatCritical, textAlign: 'center', paddingVertical: 12, borderRadius: 10, fontWeight: '800', marginTop: spacing.md }}
                accessibilityRole="button"
                accessibilityLabel="Admin logout"
              >
                Admin Logout
              </Text>
            </>
          ) : (
            <>
              <Text style={[typography.body, { color: c.text }]}>Locked — scan RFID card at rover to unlock admin features.</Text>
              <Text
                onPress={handleAdminLogin}
                style={{ color: 'white', backgroundColor: c.primary, textAlign: 'center', paddingVertical: 12, borderRadius: 10, fontWeight: '800', marginTop: spacing.md }}
                accessibilityRole="button"
                accessibilityLabel="Admin login"
              >
                Admin Login (scan RFID at rover)
              </Text>
            </>
          )}
        </Card>

        {/* Connection section */}
        <Card>
          <Text style={[typography.caption, { color: c.textMuted }]}>RASPBERRY PI CONNECTION</Text>
          <View style={styles.hostRow}>
            <Text style={[typography.body, { color: c.text }]}>Pi IP Address</Text>
            <TextInput
              value={hostDraft}
              onChangeText={setHostDraft}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="numbers-and-punctuation"
              style={[styles.input, { borderColor: c.border, color: c.text, backgroundColor: c.surface, flex: 1 }]}
            />
          </View>
          <Row label="WebSocket Port" hint="Rover commands"><NumberField value={connection.wsPort} onChange={(v) => setConnection({ wsPort: v })} /></Row>
          <Row label="MQTT Port" hint="MQTT over WebSocket"><NumberField value={connection.mqttPort} onChange={(v) => setConnection({ mqttPort: v })} /></Row>
          <Row label="FastAPI Port" hint="REST API"><NumberField value={connection.apiPort} onChange={(v) => setConnection({ apiPort: v })} /></Row>
          <Row label="Camera Port" hint="MJPEG stream"><NumberField value={connection.streamPort} onChange={(v) => setConnection({ streamPort: v })} /></Row>
          <Row label="Auto-Reconnect" hint="Exponential backoff, max 30 s (FR-C3)">
            <Switch value={connection.autoReconnect} onValueChange={(v) => setConnection({ autoReconnect: v })} />
          </Row>
          <Row label="Demo Mode" hint="Simulated Pi data — no hardware needed">
            <Switch
              value={connection.demoMode}
              onValueChange={(v) => {
                setConnection({ demoMode: v });
                if (v) {
                  disconnectMqtt();
                  disconnectRoverLink();
                  connectMqtt();
                  connectRoverLink();
                } else {
                  connectMqtt();
                  connectRoverLink();
                }
              }}
            />
          </Row>
          <Text
            onPress={applyAndReconnect}
            style={{ color: 'white', backgroundColor: palette.primary, textAlign: 'center', paddingVertical: 12, borderRadius: 10, fontWeight: '800', marginTop: spacing.md }}
            accessibilityRole="button"
            accessibilityLabel="Save and reconnect"
          >
            Save & Reconnect
        </Text>
        </Card>

        {/* Notifications */}
        <Card>
          <Text style={[typography.caption, { color: c.textMuted }]}>NOTIFICATIONS {pushStatus ? '· ' + pushStatus : ''}</Text>
          <Row label="Push Notifications">
            <Switch value={prefs.pushEnabled} onValueChange={(v) => setPrefs({ pushEnabled: v })} />
          </Row>
          <Row label="Notify at threshold">
            <Picker options={['medium', 'high', 'critical']} value={prefs.notificationThreshold} onChange={(v) => setPrefs({ notificationThreshold: v as any })} />
          </Row>
        </Card>

        {/* Appearance & stream */}
        <Card>
          <Text style={[typography.caption, { color: c.textMuted }]}>APPEARANCE & STREAM</Text>
          <Row label="Dark Mode">
            <Picker options={['system', 'light', 'dark']} value={prefs.darkMode} onChange={(v) => setPrefs({ darkMode: v as any })} />
          </Row>
          <Row label="Stream Quality">
            <Picker options={['low', 'medium', 'high']} value={prefs.streamQuality} onChange={(v) => setPrefs({ streamQuality: v as any })} />
          </Row>
          <Row label="Admin Session Timeout">
            <Picker options={['15', '30', '60']} value={String(prefs.adminTimeoutMin)} onChange={(v) => setPrefs({ adminTimeoutMin: parseInt(v, 10) as 15 | 30 | 60 })} />
          </Row>
        </Card>

        <Text style={[typography.caption, { color: c.textMuted, textAlign: 'center' }]}>
          CyberSentinel CPS Rover · v1.0.0 · local-network only
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: { padding: spacing.lg, gap: spacing.lg, paddingBottom: 40 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6 },
  hostRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 6 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, minWidth: 90, textAlign: 'center' },
  pickerRow: { flexDirection: 'row', gap: 6 },
  pickerOpt: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, fontSize: 12, fontWeight: '700', overflow: 'hidden' },
});
