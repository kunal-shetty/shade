// ============================================================================
// NOTIFICATIONS — FULLY DISABLED FOR EXPO GO COMPATIBILITY
//
// expo-notifications hard-crashes on load inside Expo Go on Android (remote
// push removed in SDK 53), so ALL notification code is commented out below.
// Nothing in this file imports expo-notifications anymore, which means Metro
// doesn't even bundle it. All exports are safe no-ops.
//
// TO RE-ENABLE (dev build / APK only — NOT Expo Go):
//   1. Restore the implementation below.
//   2. Build with `npx expo run:android` or eas build.
// ============================================================================

import type { ThreatLevel } from '../types';

// ---- ORIGINAL IMPLEMENTATION (disabled) ------------------------------------
// import * as Notifications from 'expo-notifications';
// import Constants, { ExecutionEnvironment } from 'expo-constants';
// import { api } from './api';
// import { useSettings } from '../store/settings';
//
// Notifications.setNotificationHandler({
//   handleNotification: async () => ({
//     shouldShowBanner: true,
//     shouldShowList: true,
//     shouldPlaySound: true,
//     shouldSetBadge: true,
//   }),
// });
//
// const LEVEL_ORDER: Record<ThreatLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
//
// export const isExpoGo = (): boolean =>
//   Constants.executionEnvironment === ExecutionEnvironment.StoreClient ||
//   Constants.appOwnership === 'expo';
//
// export const requestNotificationPermission = async (): Promise<boolean> => {
//   const { status } = await Notifications.requestPermissionsAsync();
//   return status === 'granted';
// };
//
// export const registerPushToken = async (): Promise<string | null> => {
//   const token = (await Notifications.getDevicePushTokenAsync()).data;
//   if (typeof token === 'string' && token.length > 0) {
//     await api.fcmRegister(token);
//     return token;
//   }
//   return null;
// };
//
// export const notifyThreat = async (level: ThreatLevel, score: number, zone: string | null) => {
//   const { prefs, connection } = useSettings.getState();
//   if (!prefs.pushEnabled) return;
//   if (LEVEL_ORDER[level] < LEVEL_ORDER[prefs.notificationThreshold]) return;
//   await Notifications.scheduleNotificationAsync({
//     content: {
//       title: `${level === 'critical' ? 'Critical Threat' : 'Threat Alert'}${zone ? `: ${zone}` : ''}`,
//       body: `Threat score ${score}/100 — tap to open Camera Feed`,
//       sound: 'default',
//     },
//     trigger: null,
//   });
// };
// --------------------------------------------------------------------------

// Safe no-op stubs (same API surface so callers don't change):

export const isExpoGo = (): boolean => true;

export const requestNotificationPermission = async (): Promise<boolean> => true;

export const registerPushToken = async (): Promise<string | null> => {
  console.log('[notifications] Push disabled in this build (Expo Go). In-app threat alerts remain active.');
  return null;
};

export const notifyThreat = async (_level: ThreatLevel, _score: number, _zone: string | null): Promise<void> => {
  // No-op: the in-app threat banner + incident badge surface critical alerts.
};
