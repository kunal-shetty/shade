import React from 'react';
import { Text, View } from 'react-native';
import { useTheme } from '../theme/theme';
import { useAdmin } from '../store/settings';
import { PrimaryButton } from './ui';

interface AdminLockProps {
  children: React.ReactNode;
  /** Called when user taps "Admin Login" while locked (opens RFID modal). */
  onRequestUnlock?: () => void;
  lockedHint?: string;
}

/**
 * FR-R3: admin-only controls must be visually disabled and non-interactive
 * without an active admin session.
 */
export const AdminLock = ({ children, onRequestUnlock, lockedHint }: AdminLockProps) => {
  const c = useTheme();
  const session = useAdmin((s) => s.session);

  if (session) return <>{children}</>;

  return (
    <View
      style={{ opacity: 0.45 }}
      pointerEvents="box-only"
      accessibilityLabel="Admin features locked. RFID authentication required."
    >
      {children}
      <View
        style={{
          position: 'absolute', left: 0, right: 0, bottom: 0, top: 0,
          alignItems: 'center', justifyContent: 'center',
        }}
        pointerEvents="box-only"
      >
        <View
          style={{
            backgroundColor: 'rgba(2,6,23,0.55)', paddingHorizontal: 14, paddingVertical: 8,
            borderRadius: 10, gap: 6, alignItems: 'center',
          }}
        >
          <Text style={{ color: 'white', fontWeight: '700', fontSize: 13 }}>🔒 Admin locked</Text>
          {lockedHint ? <Text style={{ color: 'rgba(255,255,255,0.8)', fontSize: 11 }}>{lockedHint}</Text> : null}
          {onRequestUnlock ? (
            <Text
              onPress={onRequestUnlock}
              style={{ color: '#7EB8FF', fontWeight: '800', fontSize: 12, textDecorationLine: 'underline' }}
              accessibilityRole="button"
              accessibilityLabel="Begin admin login"
            >
              Admin Login
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
};

export const AdminBadge = () => {
  const session = useAdmin((s) => s.session);
  if (!session) return null;
  const minsLeft = Math.max(0, Math.round((session.expiresAt - Date.now()) / 60000));
  return (
    <View
      style={{ backgroundColor: '#16A34A', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 }}
      accessibilityLabel={`Admin session active, ${minsLeft} minutes remaining`}
    >
      <Text style={{ color: 'white', fontWeight: '800', fontSize: 11 }}>ADMIN · {session.uid} · {minsLeft}m</Text>
    </View>
  );
};
