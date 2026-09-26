import React, { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { palette, spacing, typography, useTheme } from '../theme/theme';
import { useVoice } from '../store/voice';
import { useLiveData } from '../store/rover';
import { cancelListening, startListening, stopListening } from '../services/voice';
import type { VoiceStage } from '../types';

const STAGE_TEXT: Record<VoiceStage, string> = {
  idle: 'Tap the mic and speak a command',
  listening: 'Listening…',
  thinking: 'Asking JEV what to do…',
  acting: 'Executing…',
  speaking: 'Responding…',
  error: 'Something went wrong',
};

const confidenceColor = (confidence: number): string =>
  confidence >= 0.9 ? palette.threatLow : confidence >= 0.55 ? palette.threatMedium : palette.threatCritical;

export const VoiceControl = ({ compact }: { compact?: boolean }) => {
  const c = useTheme();
  const stage = useVoice((s) => s.stage);
  const available = useVoice((s) => s.available);
  const transcript = useVoice((s) => s.transcript);
  const finalTranscript = useVoice((s) => s.finalTranscript);
  const lastTurn = useVoice((s) => s.lastTurn);
  const error = useVoice((s) => s.error);
  const pending = useVoice((s) => s.pending);
  const wsState = useLiveData((s) => s.wsState);

  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (stage !== 'listening') {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [stage, pulse]);

  const listening = stage === 'listening';
  const busy = stage === 'thinking' || stage === 'acting' || stage === 'speaking';

  const handlePress = () => {
    if (listening) {
      void stopListening();
      return;
    }
    if (busy) return;
    void startListening();
  };

  const micIcon: keyof typeof Ionicons.glyphMap = listening ? 'stop' : busy ? 'hourglass' : 'mic';

  const statusLine =
    pending != null
      ? `Waiting for confirmation: "${pending.action.label}"`
      : error && stage === 'error'
        ? error
        : STAGE_TEXT[stage];

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <View style={styles.headerRow}>
        <View style={[styles.iconWrap, { backgroundColor: `${c.accent}18` }]}>
          <Ionicons name="sparkles" size={14} color={c.accent} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[typography.caption, { color: c.textMuted, letterSpacing: 0.8 }]}>
            VOICE COMMAND · JEV CLASSIFIED
          </Text>
          <Text style={[typography.body, { color: c.text, fontWeight: '700' }]}>
            {wsState === 'connected' || wsState === 'demo' ? 'Rover link ready' : 'Rover link offline'}
          </Text>
        </View>
        {available === false ? (
          <View style={[styles.pill, { backgroundColor: `${palette.threatMedium}18` }]}>
            <Text style={{ color: palette.threatMedium, fontSize: 10, fontWeight: '800' }}>DEV BUILD ONLY</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.micRow}>
        <View style={styles.micWrap}>
          <Animated.View
            style={[
              styles.halo,
              {
                backgroundColor: `${listening ? palette.threatCritical : c.primary}22`,
                opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.05] }),
                transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.45] }) }],
              },
            ]}
          />
          <Pressable
            onPress={handlePress}
            onLongPress={() => void cancelListening()}
            accessibilityRole="button"
            accessibilityLabel={listening ? 'Stop listening' : 'Start voice command'}
            style={[
              styles.micBtn,
              {
                backgroundColor: listening ? palette.threatCritical : busy ? c.textMuted : c.primary,
                opacity: busy ? 0.75 : 1,
              },
            ]}
          >
            <Ionicons name={micIcon} size={30} color="white" />
          </Pressable>
        </View>

        <View style={{ flex: 1, gap: 4 }}>
          <Text style={[typography.body, { color: error && stage === 'error' ? palette.threatCritical : c.text, fontWeight: '600' }]}>
            {statusLine}
          </Text>
          {transcript.length > 0 ? (
            <Text style={[typography.body, { color: c.primary, fontStyle: 'italic' }]} numberOfLines={3}>
              “{transcript}”
            </Text>
          ) : finalTranscript.length > 0 ? (
            <Text style={[typography.caption, { color: c.textMuted }]} numberOfLines={2}>
              Heard: {finalTranscript}
            </Text>
          ) : available === false ? (
            <Text style={[typography.caption, { color: c.textMuted }]}>
              On-device speech recognition needs a dev build: `npx expo run:android` (or `run:ios`).
            </Text>
          ) : (
            <Text style={[typography.caption, { color: c.textMuted }]}>
              Try: “patrol the front yard”, “back up slowly”, “what's the status?”
            </Text>
          )}
        </View>
      </View>

      {lastTurn && !compact ? (
        <View style={[styles.turn, { borderColor: c.border, backgroundColor: c.surface }]}>
          <View style={styles.turnTop}>
            <Ionicons
              name={lastTurn.executed ? 'checkmark-circle' : 'information-circle'}
              size={14}
              color={lastTurn.executed ? palette.threatLow : c.textMuted}
            />
            <Text style={[typography.caption, { color: c.textMuted, flex: 1 }]} numberOfLines={1}>
              {lastTurn.actionLabel}
              {lastTurn.note ? ` · ${lastTurn.note}` : ''}
            </Text>
            <Text style={[typography.caption, { color: confidenceColor(lastTurn.confidence), fontWeight: '800' }]}>
              {Math.round(lastTurn.confidence * 100)}%
            </Text>
          </View>
          <View style={[styles.bar, { backgroundColor: c.border }]}>
            <View
              style={[
                styles.barFill,
                { width: `${Math.round(lastTurn.confidence * 100)}%`, backgroundColor: confidenceColor(lastTurn.confidence) },
              ]}
            />
          </View>
          <Text style={[typography.body, { color: c.text, marginTop: 6 }]}>“{lastTurn.reply}”</Text>
        </View>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  card: { borderRadius: 16, borderWidth: 1, padding: spacing.lg, gap: spacing.md },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  iconWrap: { width: 28, height: 28, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  pill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  micRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  micWrap: { width: 76, height: 76, alignItems: 'center', justifyContent: 'center' },
  halo: { position: 'absolute', width: 76, height: 76, borderRadius: 38 },
  micBtn: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  turn: { borderWidth: 1, borderRadius: 12, padding: spacing.md, gap: 4 },
  turnTop: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  bar: { height: 5, borderRadius: 3, overflow: 'hidden' },
  barFill: { height: 5, borderRadius: 3 },
});
