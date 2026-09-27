import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type NotificationThreshold = 'medium' | 'high' | 'critical';
export type StreamQuality = 'low' | 'medium' | 'high';
export type DarkModeSetting = 'system' | 'light' | 'dark';

export interface ConnectionSettings {
  host: string;
  wsPort: number;
  mqttPort: number;
  apiPort: number;
  streamPort: number;
  autoReconnect: boolean;
  demoMode: boolean;
  /** Automatically find the Pi on the current WiFi (mDNS then subnet scan). */
  autoDiscover: boolean;
  /** mDNS name advertised by the Pi via Avahi. */
  hostname: string;
}

export interface Preferences {
  pushEnabled: boolean;
  notificationThreshold: NotificationThreshold;
  darkMode: DarkModeSetting;
  streamQuality: StreamQuality;
  adminTimeoutMin: 15 | 30 | 60;
  /** BCP-47 locale used for on-device speech recognition. */
  voiceLanguage: string;
  /** Below this JEV confidence the app asks for a repeat instead of acting. */
  voiceMinConfidence: number;
  /** Send the spoken reply to the Raspberry Pi's speaker. */
  piSpeakerEnabled: boolean;
  /** Fall back to the phone's speaker when the Pi is unreachable. */
  phoneSpeakerFallback: boolean;
}

interface SettingsState {
  connection: ConnectionSettings;
  prefs: Preferences;
  setConnection: (patch: Partial<ConnectionSettings>) => void;
  setPrefs: (patch: Partial<Preferences>) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      connection: {
        // The IP, not the mDNS name: Android's resolver does not do mDNS, so an
        // app pointed at cybersentinel.local dies with java.net.UnknownHostException
        // before a single packet leaves the phone. Auto-discovery below corrects
        // this if the lease ever changes.
        host: '192.168.0.115',
        wsPort: 8765,
        mqttPort: 9001,
        apiPort: 8000,
        streamPort: 8080,
        autoReconnect: true,
        demoMode: false,
        autoDiscover: true,
        hostname: 'cybersentinel.local',
      },
      prefs: {
        pushEnabled: true,
        notificationThreshold: 'high',
        darkMode: 'system',
        streamQuality: 'medium',
        adminTimeoutMin: 30,
        voiceLanguage: 'en-US',
        voiceMinConfidence: 0.55,
        piSpeakerEnabled: true,
        phoneSpeakerFallback: true,
      },
      setConnection: (patch) => set((s) => ({ connection: { ...s.connection, ...patch } })),
      setPrefs: (patch) => set((s) => ({ prefs: { ...s.prefs, ...patch } })),
    }),
    { name: 'cybersentinel-settings', storage: createJSONStorage(() => AsyncStorage) },
  ),
);

export interface AdminSession {
  uid: string;
  startedAt: number;
  expiresAt: number;
}

interface AdminState {
  session: AdminSession | null;
  rfidWaitVisible: boolean;
  unlock: (uid: string, timeoutMin: number) => void;
  logout: () => void;
  tick: () => void; // clears expired sessions
  showRfidWait: (visible: boolean) => void;
}

export const useAdmin = create<AdminState>()((set) => ({
  session: { uid: 'DEFAULT_ADMIN', startedAt: Date.now(), expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 365 },
  rfidWaitVisible: false,
  unlock: (uid, timeoutMin) =>
    set({ session: { uid, startedAt: Date.now(), expiresAt: Date.now() + timeoutMin * 60_000 } }),
  logout: () => set({ session: null }),
  tick: () =>
    set((s) =>
      s.session && s.session.expiresAt <= Date.now() ? { session: null } : s,
    ),
  showRfidWait: (rfidWaitVisible) => set({ rfidWaitVisible }),
}));

export const useIsAdmin = (): boolean => useAdmin((s) => s.session !== null);
