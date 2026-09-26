import * as SecureStore from 'expo-secure-store';

const TYPESAFE_KEY = 'cybersentinel.typesafe.key';

/**
 * The TypeSafe (JEV) API key is kept in the device keychain/keystore via
 * expo-secure-store. `EXPO_PUBLIC_TYPESAFE_API_KEY` is supported as a build-time
 * fallback so a dev build can be configured without typing the key on device.
 */
export const getTypesafeKey = async (): Promise<string | null> => {
  const fromEnv = process.env.EXPO_PUBLIC_TYPESAFE_API_KEY;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  try {
    const stored = await SecureStore.getItemAsync(TYPESAFE_KEY);
    return stored && stored.trim().length > 0 ? stored.trim() : null;
  } catch {
    return null;
  }
};

export const setTypesafeKey = async (value: string): Promise<void> => {
  const trimmed = value.trim();
  try {
    if (trimmed.length === 0) await SecureStore.deleteItemAsync(TYPESAFE_KEY);
    else await SecureStore.setItemAsync(TYPESAFE_KEY, trimmed);
  } catch {
    // SecureStore is unavailable on web; the env fallback still applies.
  }
};

export const hasStoredTypesafeKey = async (): Promise<boolean> => (await getTypesafeKey()) != null;
