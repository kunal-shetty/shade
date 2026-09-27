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

/**
 * The address the app ships pointed at. It must be an IP, never the mDNS name:
 * Android's resolver does not do mDNS, so `cybersentinel.local` (which resolves
 * fine on a PC through Avahi) dies on the phone with
 * `java.net.UnknownHostException` before a single packet leaves the device.
 */
export const DEFAULT_HOST = '192.168.0.115'; // Pi changed networks — update here AND in Settings → Connection on your devices

export const isIpv4 = (host: string): boolean =>
  /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(host.trim());

/**
 * Turns whatever is in the Pi address field into something Android can dial.
 * A `.local` name (or an empty field) becomes the default IP; auto-discovery
 * then corrects it if the lease has moved.
 */
export const sanitizeHost = (host: string | null | undefined): string => {
  const h = (host ?? '').trim();
  if (!h) return DEFAULT_HOST;
  // `.local`, `.lan`, `.home` … anything that is not an IP has to be resolved
  // by a real DNS/mDNS resolver, which the phone does not have for the rover.
  if (!isIpv4(h)) return DEFAULT_HOST;
  return h;
};

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      connection: {
        // The IP, not the mDNS name (see DEFAULT_HOST above).
        host: DEFAULT_HOST,
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
    {
      name: 'cybersentinel-settings',
      storage: createJSONStorage(() => AsyncStorage),
      // v2: the app used to ship (and persist) `cybersentinel.local` in the Pi
      // address field. Stored state beats the built-in default on rehydrate, so
      // fixing the default alone could never repair an installed app — this
      // migration rewrites the bad value in place on the next launch.
      version: 2,
      migrate: (persisted) => {
        const state = persisted as Partial<SettingsState> | undefined;
        if (!state?.connection) return persisted as SettingsState;
        return {
          ...state,
          connection: { ...state.connection, host: sanitizeHost(state.connection.host) },
        } as SettingsState;
      },
    },
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
