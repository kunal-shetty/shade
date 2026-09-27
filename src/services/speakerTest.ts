import * as Speech from 'expo-speech';
import { api } from './api';
import { onRoverAck, sendRoverCommand } from './roverLink';
import { PHONE_VOICE } from './voice';
import { useLiveData } from '../store/rover';
import { useSettings } from '../store/settings';

// ============================================================================
// Speaker test
//
// Drives the Raspberry Pi's speaker from the phone and reports what happened,
// using the same two paths a spoken reply can take:
//
//   1. control socket (:8765)  -> {cmd:'SPEAK'} -> ack {speaking, source}
//   2. REST (POST /speak)      -> {ok, speaking, source}
//   3. phone speaker (expo-speech) when the Pi cannot be reached
//
// `source` is `groq` when the gateway rewrote the line and `template` when it
// spoke the app's wording verbatim; GET /voice/status names the TTS engine so
// "it acked but nothing came out" can be told apart from "no engine installed".
// ============================================================================

export type SpeakerTestPath = 'ws' | 'rest' | 'phone';

export interface SpeakerTestResult {
  ok: boolean;
  path: SpeakerTestPath;
  /** The line the Pi queued (or the phone spoke). */
  speaking: string;
  /** `groq` when rewritten on the Pi, `template` when spoken as sent. */
  source?: string;
  /** TTS engine from GET /voice/status, e.g. `espeak-ng`. */
  engine?: string;
  voice?: string;
  /** One-line summary for the Settings card. */
  detail: string;
}

export const DEFAULT_SPEAKER_TEST_TEXT =
  'Speaker test. If you can hear this, the CyberSentinel voice is working.';

const ACK_TIMEOUT_MS = 6000;

const describeEngine = (engine?: string, voice?: string): string => {
  if (!engine) return '';
  return ` via ${engine}${voice ? ` (${voice})` : ''}`;
};

/** Engine name only when one is actually installed; `none` means silence. */
const readEngine = async (): Promise<{ engine?: string; voice?: string }> => {
  try {
    const status = await api.voiceStatus();
    return {
      engine: status.tts_engine && status.tts_engine !== 'none' ? status.tts_engine : undefined,
      voice: status.tts_voice || undefined,
    };
  } catch {
    return {};
  }
};

/** Resolves with the gateway's reply to a SPEAK, or null if none arrives. */
const waitForSpeakAck = (timeoutMs = ACK_TIMEOUT_MS): Promise<Record<string, unknown> | null> =>
  new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish(null), timeoutMs);
    const off = onRoverAck((ack) => {
      if (ack.cmd === 'SPEAK' && (ack.type === 'ack' || ack.type === 'error')) finish(ack);
    });
    function finish(ack: Record<string, unknown> | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      resolve(ack);
    }
  });

const speakOnPhone = (text: string, detail: string): SpeakerTestResult => {
  const prefs = useSettings.getState().prefs;
  try {
    Speech.stop();
    Speech.speak(text, {
      language: prefs.voiceLanguage,
      pitch: PHONE_VOICE.pitch,
      rate: PHONE_VOICE.rate,
    });
    return { ok: true, path: 'phone', speaking: text, detail };
  } catch (err) {
    return {
      ok: false,
      path: 'phone',
      speaking: text,
      detail: `The phone's speech engine failed too: ${(err as Error).message}`,
    };
  }
};

/**
 * Play a line on the Pi's speaker and report which path carried it.
 * Never throws — the result always carries a human-readable `detail`.
 */
export async function testPiSpeaker(text = DEFAULT_SPEAKER_TEST_TEXT): Promise<SpeakerTestResult> {
  const line = text.trim() || DEFAULT_SPEAKER_TEST_TEXT;
  const { demoMode } = useSettings.getState().connection;

  if (demoMode) {
    return speakOnPhone(line, 'Demo Mode is on, so the Pi was skipped — spoke on the phone instead.');
  }

  // 1. Control socket — the path voice replies normally take.
  if (useLiveData.getState().wsState === 'connected') {
    const acked = waitForSpeakAck();
    if (sendRoverCommand({ cmd: 'SPEAK', text: line })) {
      const ack = await acked;
      if (ack && ack.type === 'error') {
        return {
          ok: false,
          path: 'ws',
          speaking: line,
          detail: `The gateway refused the SPEAK command: ${String(ack.message ?? 'unknown error')}.`,
        };
      }
      if (ack) {
        const spoken = String(ack.speaking ?? line);
        const { engine, voice } = await readEngine();
        const rewritten = ack.source === 'groq' ? ' (rewritten by Groq)' : '';
        if (!engine) {
          return {
            ok: false,
            path: 'ws',
            speaking: spoken,
            source: ack.source ? String(ack.source) : undefined,
            detail:
              `The gateway acked but has no TTS engine installed (GET /voice/status says none), so nothing ` +
              `was audible. Install espeak-ng on the Pi or set CS_TTS_ENGINE.`,
          };
        }
        return {
          ok: true,
          path: 'ws',
          speaking: spoken,
          source: ack.source ? String(ack.source) : undefined,
          engine,
          voice,
          detail: `Queued on the Pi over the control socket${describeEngine(engine, voice)}${rewritten}.`,
        };
      }
      // Ack timed out — fall through to REST in case the socket is half-open.
    }
  }

  // 2. REST — the control socket is down but the API may still answer.
  try {
    const res = await api.speak(line);
    const { engine, voice } = await readEngine();
    const spoken = res.speaking || line;
    if (!engine) {
      return {
        ok: false,
        path: 'rest',
        speaking: spoken,
        source: res.source,
        detail:
          'The gateway accepted the line but reports no TTS engine, so the Pi stayed silent. ' +
          'Install espeak-ng on the Pi or set CS_TTS_ENGINE.',
      };
    }
    return {
      ok: res.ok !== false,
      path: 'rest',
      speaking: spoken,
      source: res.source,
      engine,
      voice,
      detail: `Control socket unavailable — queued over REST instead${describeEngine(engine, voice)}.`,
    };
  } catch (err) {
    const why = (err as Error).message;
    if (useSettings.getState().prefs.phoneSpeakerFallback) {
      return speakOnPhone(line, `Pi unreachable on :8765 and :8000 (${why}) — spoke on the phone instead.`);
    }
    return {
      ok: false,
      path: 'rest',
      speaking: line,
      detail: `Pi unreachable on the control socket and over REST (${why}). Enable “Phone speaker fallback” to test the phone instead.`,
    };
  }
}

/** Silence whatever is currently playing, on the Pi and the phone. */
export const stopSpeakerTest = (): void => {
  try {
    sendRoverCommand({ cmd: 'TTS_STOP' });
  } catch {
    // ignore: the socket may already be closed
  }
  try {
    Speech.stop();
  } catch {
    // ignore
  }
};
