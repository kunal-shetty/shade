import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { palette, spacing, typography, useTheme } from '../theme/theme';
import { useAdmin, useSettings } from '../store/settings';
import { useDiscovery } from '../store/discovery';
import { Card } from '../components/ui';
import { disconnectMqtt, connectMqtt } from '../services/mqtt';
import { connectRoverLink, disconnectRoverLink } from '../services/roverLink';
import { discoverPi } from '../services/discovery';
import { DEFAULT_SPEAKER_TEST_TEXT, stopSpeakerTest, testPiSpeaker } from '../services/speakerTest';
import { getTypesafeKey, setTypesafeKey } from '../services/secrets';
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
  // Persisted settings rehydrate from AsyncStorage asynchronously, so this
  // screen can mount before the saved host is known. Without following the store
  // the field keeps showing the built-in default and "Save & Reconnect" writes
  // that stale value straight back over a discovered address.
  const hostEdited = useRef(false);
  const [pushStatus, setPushStatus] = useState('');
  const [keyDraft, setKeyDraft] = useState('');
  const [keyStatus, setKeyStatus] = useState('');
  const [discoveryBusy, setDiscoveryBusy] = useState(false);
  const [speakerDraft, setSpeakerDraft] = useState('');
  const [speakerBusy, setSpeakerBusy] = useState(false);
  const [speakerStatus, setSpeakerStatus] = useState('');
  const [speakerOk, setSpeakerOk] = useState<boolean | null>(null);
  const discovery = useDiscovery();

  useEffect(() => {
    void getTypesafeKey().then((k) => setKeyStatus(k ? 'Key configured' : 'No key set'));
  }, []);

  useEffect(() => {
    if (!hostEdited.current) setHostDraft(connection.host);
  }, [connection.host]);

  const saveKey = async () => {
    await setTypesafeKey(keyDraft);
    setKeyDraft('');
    const k = await getTypesafeKey();
    setKeyStatus(k ? 'Key saved' : 'No key set');
  };

  const findPi = async () => {
    setDiscoveryBusy(true);
    try {
      const host = await discoverPi({ deep: true });
      if (host) {
        setHostDraft(host);
        disconnectMqtt();
        disconnectRoverLink();
        connectMqtt();
        connectRoverLink();
      }
    } finally {
      setDiscoveryBusy(false);
    }
  };

  // reconnect services when Save is pressed
  const applyAndReconnect = () => {
    setConnection({ host: hostDraft.trim() || connection.hostname || 'cybersentinel.local' });
    disconnectMqtt();
    disconnectRoverLink();
    connectMqtt();
    connectRoverLink();
  };

  // Plays a line on the Pi's speaker and reports which path carried it, so a
  // silent rover can be told apart from "Queued on the Pi over the control socket".
  const runSpeakerTest = async () => {
    if (speakerBusy) return;
    setSpeakerBusy(true);
    setSpeakerOk(null);
    setSpeakerStatus('Sending to the Pi…');
    try {
      const result = await testPiSpeaker(speakerDraft);
      setSpeakerOk(result.ok);
      const via = result.path === 'ws' ? 'control socket' : result.path === 'rest' ? 'REST' : 'phone speaker';
      setSpeakerStatus(`${result.detail} Heard over the ${via}: “${result.speaking}”`);
    } finally {
      setSpeakerBusy(false);
    }
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
      <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
        <View style={styles.headerRow}>
          <View>
            <Text style={[typography.caption, { color: c.textMuted, letterSpacing: 1.2 }]}>CONFIGURATION</Text>
            <Text style={[typography.h1, { color: c.text, fontSize: 26 }]}>Settings</Text>
          </View>
          <Ionicons name="settings" size={22} color={c.primary} />
        </View>

        {/* Admin section */}
        <Card>
          <View style={styles.cardTitleRow}>
            <Ionicons name="shield-checkmark" size={14} color={c.primary} />
            <Text style={[typography.caption, { color: c.textMuted, marginLeft: 6, letterSpacing: 0.8 }]}>ADMIN SESSION</Text>
          </View>
          {session ? (
            <>
              <View style={styles.sessionRow}>
                <Ionicons name="lock-open" size={16} color={palette.threatLow} />
                <Text style={[typography.bodyLg, { color: palette.threatLow, fontWeight: '700' }]}> Unlocked · card {session.uid}</Text>
              </View>
              <Text style={[typography.caption, { color: c.textMuted }]}>
                Expires {new Date(session.expiresAt).toLocaleTimeString()}
              </Text>
              <View
                style={[styles.wideBtn, { backgroundColor: palette.threatCritical }]}
                onTouchEnd={logout}
                accessibilityRole="button"
                accessibilityLabel="Admin logout"
              >
                <Ionicons name="log-out" size={15} color="white" />
                <Text style={styles.wideBtnText}> Admin Logout</Text>
              </View>
            </>
          ) : (
            <>
              <View style={styles.sessionRow}>
                <Ionicons name="lock-closed" size={16} color={c.textMuted} />
                <Text style={[typography.body, { color: c.text, flex: 1 }]}> Locked — scan RFID card at the rover to unlock admin features.</Text>
              </View>
              <View style={styles.wideBtn} onTouchEnd={handleAdminLogin} accessibilityRole="button" accessibilityLabel="Admin login">
                <Ionicons name="scan" size={15} color="white" />
                <Text style={styles.wideBtnText}> Admin Login (scan RFID)</Text>
              </View>
            </>
          )}
        </Card>

        {/* Connection section */}
        <Card>
          <View style={styles.cardTitleRow}>
            <Ionicons name="hardware-chip" size={14} color={c.primary} />
            <Text style={[typography.caption, { color: c.textMuted, marginLeft: 6, letterSpacing: 0.8 }]}>RASPBERRY PI CONNECTION</Text>
          </View>
          <Row label="Auto-discover on WiFi" hint="Find the Pi automatically on the shared network">
            <Switch
              value={connection.autoDiscover}
              onValueChange={(v) => {
                setConnection({ autoDiscover: v });
                if (v) void findPi();
              }}
            />
          </Row>
          <Row label="Pi hostname (mDNS)" hint="Avahi name advertised by the Pi">
            <TextInput
              value={connection.hostname}
              onChangeText={(t) => setConnection({ hostname: t.trim() })}
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.input, { borderColor: c.border, color: c.text, backgroundColor: c.surface, width: 190, textAlign: 'left' }]}
            />
          </Row>
          <View style={styles.hostRow}>
            <Text style={[typography.body, { color: c.text }]}>Pi IP Address</Text>
            <TextInput
              value={hostDraft}
              onChangeText={(t) => {
                hostEdited.current = true;
                setHostDraft(t);
              }}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="numbers-and-punctuation"
              style={[styles.input, { borderColor: c.border, color: c.text, backgroundColor: c.surface, flex: 1 }]}
            />
          </View>
          <View style={styles.discoveryStatus}>
            <Ionicons
              name={
                discovery.stage === 'found'
                  ? 'checkmark-circle'
                  : discovery.stage === 'searching'
                    ? 'search'
                    : discovery.stage === 'not-found'
                      ? 'alert-circle'
                      : 'wifi-outline'
              }
              size={14}
              color={discovery.stage === 'found' ? palette.threatLow : discovery.stage === 'not-found' ? palette.threatMedium : c.textMuted}
            />
            <Text style={[typography.caption, { color: c.textMuted, flex: 1 }]} numberOfLines={2}>
              {discovery.message}
            </Text>
          </View>
          <View
            style={[styles.wideBtn, { backgroundColor: discoveryBusy ? c.border : c.accent }]}
            onTouchEnd={() => {
              if (!discoveryBusy) void findPi();
            }}
            accessibilityRole="button"
            accessibilityLabel="Find Pi on this WiFi"
          >
            <Ionicons name="wifi" size={15} color="white" />
            <Text style={styles.wideBtnText}>{discoveryBusy ? ' Searching…' : ' Find Pi on this WiFi'}</Text>
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
          <View
            style={styles.wideBtn}
            onTouchEnd={applyAndReconnect}
            accessibilityRole="button"
            accessibilityLabel="Save and reconnect"
          >
            <Ionicons name="save" size={15} color="white" />
            <Text style={styles.wideBtnText}> Save & Reconnect</Text>
          </View>
        </Card>

        {/* Voice control (JEV) */}
        <Card>
          <View style={styles.cardTitleRow}>
            <Ionicons name="mic" size={14} color={c.primary} />
            <Text style={[typography.caption, { color: c.textMuted, marginLeft: 6, letterSpacing: 0.8 }]}>
              VOICE CONTROL · JEV {keyStatus ? '· ' + keyStatus.toUpperCase() : ''}
            </Text>
          </View>
          <Text style={[typography.caption, { color: c.textMuted }]}>
            Paste a TypeSafe API key to classify spoken commands with JEV. The key is stored in the device
            keychain and never leaves the phone except to api.typesafe.ai.
          </Text>
          <View style={styles.hostRow}>
            <TextInput
              value={keyDraft}
              onChangeText={setKeyDraft}
              placeholder="ts_live_…"
              placeholderTextColor={c.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              style={[styles.input, { borderColor: c.border, color: c.text, backgroundColor: c.surface, flex: 1, textAlign: 'left' }]}
            />
          </View>
          <View style={styles.wideBtn} onTouchEnd={() => void saveKey()} accessibilityRole="button" accessibilityLabel="Save TypeSafe key">
            <Ionicons name="key" size={15} color="white" />
            <Text style={styles.wideBtnText}> Save JEV Key</Text>
          </View>
          <Row label="Speak on the Pi" hint="Use the Raspberry Pi speaker for replies">
            <Switch value={prefs.piSpeakerEnabled} onValueChange={(v) => setPrefs({ piSpeakerEnabled: v })} />
          </Row>
          <Row label="Phone speaker fallback" hint="Speak on the phone when the Pi is unreachable">
            <Switch value={prefs.phoneSpeakerFallback} onValueChange={(v) => setPrefs({ phoneSpeakerFallback: v })} />
          </Row>
          <Row label="Minimum confidence" hint="Below this, the rover asks you to repeat">
            <Picker
              options={['0.4', '0.55', '0.7', '0.85']}
              value={String(prefs.voiceMinConfidence)}
              onChange={(v) => setPrefs({ voiceMinConfidence: parseFloat(v) })}
            />
          </Row>
          <Row label="Recognition language">
            <Picker
              options={['en-US', 'en-GB', 'en-IN', 'hi-IN', 'es-ES']}
              value={prefs.voiceLanguage}
              onChange={(v) => setPrefs({ voiceLanguage: v })}
            />
          </Row>
        </Card>

        {/* Speaker test */}
        <Card>
          <View style={styles.cardTitleRow}>
            <Ionicons name="volume-high" size={14} color={c.primary} />
            <Text style={[typography.caption, { color: c.textMuted, marginLeft: 6, letterSpacing: 0.8 }]}>SPEAKER TEST</Text>
          </View>
          <Text style={[typography.caption, { color: c.textMuted }]}>
            Sends a line to the Pi's speaker over the same path voice replies use, then reports the TTS engine that
            spoke it. Silence with a green result means the Pi has no engine installed.
          </Text>
          <TextInput
            value={speakerDraft}
            onChangeText={setSpeakerDraft}
            placeholder={DEFAULT_SPEAKER_TEST_TEXT}
            placeholderTextColor={c.textMuted}
            multiline
            style={[styles.input, { borderColor: c.border, color: c.text, backgroundColor: c.surface, textAlign: 'left', width: '100%' }]}
          />
          <View
            style={[styles.wideBtn, { backgroundColor: speakerBusy ? c.border : palette.accent }]}
            onTouchEnd={() => {
              if (!speakerBusy) void runSpeakerTest();
            }}
            accessibilityRole="button"
            accessibilityLabel="Test the Pi speaker"
          >
            <Ionicons name="volume-high" size={15} color="white" />
            <Text style={styles.wideBtnText}>{speakerBusy ? ' Sending…' : ' Test Pi Speaker'}</Text>
          </View>
          <View
            style={[styles.wideBtn, { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border }]}
            onTouchEnd={stopSpeakerTest}
            accessibilityRole="button"
            accessibilityLabel="Stop speaking"
          >
            <Ionicons name="stop-circle" size={15} color={c.text} />
            <Text style={[styles.wideBtnText, { color: c.text }]}> Stop Speaking</Text>
          </View>
          {speakerStatus ? (
            <View style={styles.discoveryStatus}>
              <Ionicons
                name={speakerOk == null ? 'ellipsis-horizontal' : speakerOk ? 'checkmark-circle' : 'alert-circle'}
                size={14}
                color={speakerOk == null ? c.textMuted : speakerOk ? palette.threatLow : palette.threatCritical}
              />
              <Text style={[typography.caption, { color: c.textMuted, flex: 1 }]}>{speakerStatus}</Text>
            </View>
          ) : null}
        </Card>

        {/* Notifications */}
        <Card>
          <View style={styles.cardTitleRow}>
            <Ionicons name="notifications" size={14} color={c.primary} />
            <Text style={[typography.caption, { color: c.textMuted, marginLeft: 6, letterSpacing: 0.8 }]}>
              NOTIFICATIONS{pushStatus ? ' · ' + pushStatus : ''}
            </Text>
          </View>
          <Row label="Push Notifications">
            <Switch value={prefs.pushEnabled} onValueChange={(v) => setPrefs({ pushEnabled: v })} />
          </Row>
          <Row label="Notify at threshold">
            <Picker options={['medium', 'high', 'critical']} value={prefs.notificationThreshold} onChange={(v) => setPrefs({ notificationThreshold: v as any })} />
          </Row>
        </Card>

        {/* Appearance & stream */}
        <Card>
          <View style={styles.cardTitleRow}>
            <Ionicons name="contrast" size={14} color={c.primary} />
            <Text style={[typography.caption, { color: c.textMuted, marginLeft: 6, letterSpacing: 0.8 }]}>APPEARANCE & STREAM</Text>
          </View>
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
  container: { padding: spacing.lg, gap: spacing.lg, paddingBottom: 48 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm },
  sessionRow: { flexDirection: 'row', alignItems: 'center' },
  wideBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: palette.primary, borderRadius: 12, paddingVertical: 13, marginTop: spacing.md },
  wideBtnText: { color: 'white', fontWeight: '800', fontSize: 14 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6 },
  hostRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 6 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, minWidth: 90, textAlign: 'center' },
  discoveryStatus: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4 },
  pickerRow: { flexDirection: 'row', gap: 6 },
  pickerOpt: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, fontSize: 12, fontWeight: '700', overflow: 'hidden' },
});
