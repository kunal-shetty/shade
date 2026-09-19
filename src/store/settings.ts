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
}

export interface Preferences {
  pushEnabled: boolean;
  notificationThreshold: NotificationThreshold;
  darkMode: DarkModeSetting;
  streamQuality: StreamQuality;
  adminTimeoutMin: 15 | 30 | 60;
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
        host: '192.168.0.115',
        wsPort: 8765,
        mqttPort: 1883,
        apiPort: 8000,
      streamPort: 5000,
      autoReconnect: true,
      demoMode: false,
    },
      prefs: {
        pushEnabled: true,
        notificationThreshold: 'high',
        darkMode: 'system',
        streamQuality: 'medium',
        adminTimeoutMin: 30,
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
