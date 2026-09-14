import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { palette, spacing, typography, useTheme } from '../theme/theme';
import { useAdmin, useSettings } from '../store/settings';
import { setRfidHandler } from '../services/mqtt';
import { demoRfidScan } from '../services/demoEngine';

export const RfidModal = () => {
  const c = useTheme();
  const visible = useAdmin((s) => s.rfidWaitVisible);
  const showRfidWait = useAdmin((s) => s.showRfidWait);
  const unlock = useAdmin((s) => s.unlock);
  const adminTimeoutMin = useSettings((s) => s.prefs.adminTimeoutMin);
  const demoMode = useSettings((s) => s.connection.demoMode);
  const [feedback, setFeedback] = useState<'none' | 'granted' | 'denied'>('none');

  useEffect(() => {
    setRfidHandler((ev) => {
      if (!useAdmin.getState().rfidWaitVisible) return;
      if (ev.status === 'granted') {
        setFeedback('granted');
        unlock(ev.uid, adminTimeoutMin);
        setTimeout(() => {
          showRfidWait(false);
          setFeedback('none');
        }, 900);
      } else {
        setFeedback('denied');
        setTimeout(() => setFeedback('none'), 1600);
      }
    });
    return () => setRfidHandler(null);
  }, [adminTimeoutMin, unlock, showRfidWait]);

  // Demo mode: pressing "Simulate scan" triggers the granted path (real hardware waits for Pi event)
  useEffect(() => {
    if (!visible || !demoMode || feedback !== 'none') return;
    const t = setTimeout(() => {
      if (useAdmin.getState().rfidWaitVisible) demoRfidScan(true);
    }, 2500);
    return () => clearTimeout(t);
  }, [visible, demoMode, feedback]);

  const iconName: keyof typeof Ionicons.glyphMap =
    feedback === 'granted' ? 'checkmark' : feedback === 'denied' ? 'close' : 'scan';
  const color = feedback === 'granted' ? palette.threatLow : feedback === 'denied' ? palette.threatCritical : c.primary;
  const title =
    feedback === 'granted' ? 'Admin session unlocked' : feedback === 'denied' ? 'Unauthorized card' : 'Please scan RFID card at rover';
  const sub =
    feedback === 'granted'
      ? 'Admin features unlocked for ' + adminTimeoutMin + ' minutes'
      : feedback === 'denied'
        ? 'Card is not registered on the Pi'
        : 'Tap your card on the RC522 module. This modal closes automatically once verified.';

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={() => showRfidWait(false)}>
      <View style={[styles.backdrop, { backgroundColor: 'rgba(2,6,23,0.7)' }]}>
        <View style={[styles.sheet, { backgroundColor: c.card, borderColor: c.border }]}>
          {feedback === 'none' ? (
            <View style={[styles.iconCircle, { backgroundColor: color + '14', borderColor: color + '55' }]}>
              <Ionicons name="scan" size={30} color={color} />
            </View>
          ) : (
            <View style={[styles.iconCircle, { backgroundColor: color + '18', borderColor: color }]}>
              <Ionicons name={iconName} size={30} color={color} />
            </View>
          )}
          <Text style={[typography.h2, { color: c.text, textAlign: 'center' }]}>{title}</Text>
          <Text style={[typography.body, { color: c.textMuted, textAlign: 'center' }]}>{sub}</Text>
          <Text
            onPress={() => showRfidWait(false)}
            style={{ color: c.primary, fontWeight: '800', paddingVertical: 10, marginTop: spacing.sm }}
            accessibilityRole="button"
            accessibilityLabel="Cancel RFID scan"
          >
            Cancel
          </Text>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  sheet: { width: '100%', maxWidth: 340, borderRadius: 20, borderWidth: 1, padding: spacing.xl, alignItems: 'center', gap: spacing.md },
  iconCircle: { width: 76, height: 76, borderRadius: 38, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
});
