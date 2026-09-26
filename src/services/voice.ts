import * as Speech from 'expo-speech';
import { api } from './api';
import { runSystemOne, choice, noul, score, JevError, type JevAnswer } from './jev';
import { getTypesafeKey } from './secrets';
import { sendRoverCommand } from './roverLink';
import { useLiveData } from '../store/rover';
import { useSettings } from '../store/settings';
import { nextTurnId, useVoice } from '../store/voice';
import type { RoverCommand, VoiceAction, VoiceActionId, VoiceTurn } from '../types';

// ============================================================================
// Voice pipeline
//
//   mic (on-device STT) -> transcript -> JEV typed classification
//       -> rover command + spoken reply (Raspberry Pi speaker, phone fallback)
//
// JEV returns a typed choice with calibrated confidence; this file owns the
// "boring part" the docs describe: thresholds, branching, and the reply text
// (JEV cannot generate prose, so replies are deterministic templates).
// ============================================================================

const VOICE_TURN_TIMEOUT_MS = 8000;

// ---- Action catalog --------------------------------------------------------

interface ActionDef {
  id: VoiceActionId;
  label: string;
  /** Needs near-certain confidence before running unattended. */
  highStakes: boolean;
  /** Wording handed to JEV as a Choice criterion. */
  criterion: string;
  /** Deterministic spoken reply; JEV never writes text. */
  reply: (ctx: VoiceContext) => string;
}

export interface VoiceContext {
  roverState: string;
  zone: string;
  battery: number | null;
  threatLevel: string;
  threatScore: number | null;
  speedPct: number;
}

const num = (v: number | null, suffix = '') => (v == null ? 'unknown' : `${Math.round(v)}${suffix}`);

/** Picks one phrasing at random so repeated commands don't sound robotic. */
const pick = (options: readonly string[]): string =>
  options[Math.floor(Math.random() * options.length)]!;

/**
 * The phone's fallback voice. Slightly raised pitch for a friendlier, chirpier
 * delivery — the Pi's voice is tuned separately (CS_TTS_VOICE / CS_TTS_PITCH).
 */
const PHONE_VOICE = { pitch: 1.18, rate: 1.04 } as const;

export const VOICE_ACTIONS: ActionDef[] = [
  {
    id: 'none',
    label: 'No action',
    highStakes: false,
    criterion:
      'Do nothing. Use when `spoken_command` is not addressed to the rover, is general conversation or a question, is too vague, or asks for something that is not in this list.',
    reply: () =>
      pick([
        "Hmm, I couldn't find a rover command in that, so nothing's changed.",
        "That didn't sound like a rover command, so I've left everything as it was.",
        "Not sure that one was for me — I didn't touch a thing.",
      ]),
  },
  {
    id: 'stop',
    label: 'Stop',
    highStakes: false,
    criterion: 'Stop all movement immediately. Halt, freeze, emergency stop, cut the motors.',
    reply: () => pick(['Stopping right away!', 'All stop — holding still.', 'Brakes on!']),
  },
  {
    id: 'move_forward',
    label: 'Move forward',
    highStakes: false,
    criterion: 'Drive forward. Go ahead, advance, move up, proceed.',
    reply: (ctx) =>
      pick([
        `Rolling forward at ${ctx.speedPct} percent!`,
        `Forward we go — ${ctx.speedPct} percent.`,
        `Scooting ahead at ${ctx.speedPct} percent.`,
      ]),
  },
  {
    id: 'move_backward',
    label: 'Move backward',
    highStakes: false,
    criterion: 'Drive backward. Reverse, back up, retreat.',
    reply: (ctx) =>
      pick([
        `Backing up at ${ctx.speedPct} percent.`,
        `Reversing — nice and slow, ${ctx.speedPct} percent.`,
      ]),
  },
  {
    id: 'turn_left',
    label: 'Turn left',
    highStakes: false,
    criterion: 'Turn or rotate to the left.',
    reply: () => pick(['Turning left!', 'Swinging left.', 'Left it is!']),
  },
  {
    id: 'turn_right',
    label: 'Turn right',
    highStakes: false,
    criterion: 'Turn or rotate to the right.',
    reply: () => pick(['Turning right!', 'Swinging right.', 'Right it is!']),
  },
  {
    id: 'patrol_start',
    label: 'Start patrol',
    highStakes: false,
    criterion: 'Begin the autonomous patrol sweep around the zones.',
    reply: () => pick(['Patrol started — off I go!', 'Starting the rounds!', 'Patrol under way!']),
  },
  {
    id: 'patrol_stop',
    label: 'Stop patrol',
    highStakes: true,
    criterion: 'End the autonomous patrol and hold position.',
    reply: () => pick(['Patrol stopped. Holding position.', 'Ending the patrol — standing by.']),
  },
  {
    id: 'return_home',
    label: 'Return home',
    highStakes: false,
    criterion: 'Return to the charging dock / home base.',
    reply: () => pick(['Heading home to the dock.', 'Homeward bound!', 'On my way back to the dock.']),
  },
  {
    id: 'horn',
    label: 'Horn',
    highStakes: false,
    criterion: 'Sound the horn or buzzer once. Beep, honk.',
    reply: () => pick(['Beep beep!', 'Honk honk!', 'Sounding the horn!']),
  },
  {
    id: 'trigger_alarm',
    label: 'Trigger alarm',
    highStakes: true,
    criterion: 'Raise the intruder alarm or siren, e.g. to scare someone off.',
    reply: () => pick(['Alarm raised — heads up!', 'Sounding the intruder alarm!', 'Alarm triggered!']),
  },
  {
    id: 'night_mode',
    label: 'Night mode',
    highStakes: false,
    criterion: 'Switch the camera into night vision / infrared mode.',
    reply: () => pick(['Night vision on.', 'Switching to night vision — say cheese!', 'Night mode engaged.']),
  },
  {
    id: 'start_recording',
    label: 'Start recording',
    highStakes: false,
    criterion: 'Start recording camera footage.',
    reply: () => pick(['Camera rolling!', 'Recording now.', 'Got it — recording.']),
  },
  {
    id: 'status_report',
    label: 'Status report',
    highStakes: false,
    criterion: 'Report the current status: battery, zone, threat level and rover state.',
    reply: (ctx) =>
      pick(['Here you go!', 'Quick status:', 'Right, here is where things stand.']) +
      ` Battery ${num(ctx.battery, ' percent')}, I'm in ${ctx.zone}, ` +
      `the rover is ${ctx.roverState}, and the threat level is ${ctx.threatLevel}` +
      (ctx.threatScore == null ? '.' : ` at ${Math.round(ctx.threatScore)} out of 100.`),
  },
];

const ACTION_BY_ID = new Map(VOICE_ACTIONS.map((a) => [a.id, a]));

const toCriteria = (): Record<string, string> =>
  Object.fromEntries(VOICE_ACTIONS.map((a) => [a.id, a.criterion]));

// ---- JEV classification ----------------------------------------------------

const ACTION_QUESTION = choice(
  'Which single action should the security rover perform in response to the spoken command in `spoken_command`? ' +
    'Pick `none` unless the command clearly requests one of the other actions.',
  toCriteria(),
);

const COMMAND_QUESTION = noul(
  'Is `spoken_command` a directive addressed to the security rover, rather than general conversation, a question about the world, or speech aimed at another person?',
  {
    true: 'It tells the rover to do something (move, stop, patrol, report, alarm, camera).',
    false: 'It is chit-chat, a question, or addressed to someone else.',
  },
);

const DESTRUCTIVE_QUESTION = noul(
  'Does `spoken_command` ask for a safety-critical or hard-to-undo action, such as raising the intruder alarm, ending the patrol, or an emergency stop?',
  {
    true: 'A high-impact or safety-relevant action is requested.',
    false: 'A routine, easily reversible action (or no action) is requested.',
  },
);

const SPEED_QUESTION = score(
  'If the command involves driving, how fast should the rover move? Use level 0 when the command is not a movement command.',
  ['Stationary — no driving requested', 'Slow and careful', 'Normal cruising pace', 'Fast and urgent'],
);

export interface VoiceClassification {
  action: VoiceAction;
  isCommand: boolean;
  destructive: boolean;
  speedPct: number;
  model: string;
}

/** Build the compact `state` JEV sees. Docs warn: only send what the questions need. */
const buildState = (transcript: string) => {
  const L = useLiveData.getState();
  return {
    spoken_command: transcript,
    rover: {
      state: L.roverStatus?.state ?? 'unknown',
      zone: L.zone ?? 'unknown',
      battery_pct: L.battery == null ? null : Math.round(L.battery),
      threat_level: L.threat?.level ?? 'unknown',
      threat_score: L.threat?.score ?? null,
      camera_online: L.cameraOnline,
      last_incident: L.incidents[0]?.summary ?? null,
    },
  };
};

const SPEED_STEPS = [0, 30, 50, 70];

export async function classifyTranscript(transcript: string, signal?: AbortSignal): Promise<VoiceClassification> {
  const settings = useSettings.getState().connection;
  const response = await runSystemOne(
    {
      state: buildState(transcript),
      questions: {
        action: ACTION_QUESTION,
        is_command: COMMAND_QUESTION,
        is_destructive: DESTRUCTIVE_QUESTION,
        speed: SPEED_QUESTION,
      },
    },
    { timeoutMs: VOICE_TURN_TIMEOUT_MS, signal },
  );

  const answers = response.answers;
  const actionAnswer = answers.action;
  const chosen = actionAnswer?.type === 'choice' ? actionAnswer.choice : 'none';
  const confidence =
    actionAnswer?.type === 'choice' && Number.isFinite(actionAnswer.confidence) ? actionAnswer.confidence : 0;
  const def = ACTION_BY_ID.get(chosen as VoiceActionId) ?? ACTION_BY_ID.get('none')!;

  const isCommand = readNoul(answers.is_command) > 0.5;
  const destructive = readNoul(answers.is_destructive) > 0.75 || def.highStakes;

  const speedAnswer = answers.speed;
  const rawLevel = speedAnswer?.type === 'score' && Number.isFinite(speedAnswer.score) ? Math.round(speedAnswer.score) : 0;
  const speedLevel = Math.max(0, Math.min(SPEED_STEPS.length - 1, rawLevel));
  // A movement command with no explicit pace gets a sane default, never 0.
  const isMovement = MOVE_ANGLES[def.id] != null;
  const speedPct = isMovement && speedLevel === 0 ? SPEED_STEPS[2] : SPEED_STEPS[speedLevel];

  return {
    action: { id: def.id, label: def.label, confidence, destructive },
    isCommand,
    destructive,
    speedPct,
    model: response.model,
  };
}

const readNoul = (answer: JevAnswer | undefined): number =>
  answer?.type === 'noul' ? answer.noul : 0;

// ---- Execution -------------------------------------------------------------

const context = (speedPct: number): VoiceContext => {
  const L = useLiveData.getState();
  return {
    roverState: L.roverStatus?.state ?? 'unknown',
    zone: L.zone ?? 'unknown zone',
    battery: L.battery,
    threatLevel: L.threat?.level ?? 'unknown',
    threatScore: L.threat?.score ?? null,
    speedPct,
  };
};

const MOVE_ANGLES: Partial<Record<VoiceActionId, number>> = {
  move_forward: 0,
  move_backward: 180,
  turn_left: -90,
  turn_right: 90,
};

const executeAction = async (classification: VoiceClassification): Promise<{ executed: boolean; note?: string }> => {
  const { action, speedPct } = classification;
  const demoMode = useSettings.getState().connection.demoMode;
  const send = (cmd: RoverCommand) => {
    if (!demoMode) sendRoverCommand(cmd);
  };

  const angle = MOVE_ANGLES[action.id];
  if (angle != null) {
    send({ cmd: 'MOVE', angle, speed: speedPct });
    return { executed: true };
  }

  switch (action.id) {
    case 'none':
      return { executed: false, note: 'No rover action requested' };
    case 'stop':
      send({ cmd: 'STOP' });
      return { executed: true };
    case 'patrol_start':
      send({ cmd: 'PATROL_START' });
      return { executed: true };
    case 'patrol_stop':
      send({ cmd: 'PATROL_STOP' });
      return { executed: true };
    case 'return_home':
      send({ cmd: 'RETURN_HOME' });
      return { executed: true };
    case 'horn':
      send({ cmd: 'BUZZER', duration: 800 });
      return { executed: true };
    case 'trigger_alarm':
      if (!demoMode) {
        try {
          await api.triggerAlarm();
        } catch {
          return { executed: false, note: 'Alarm endpoint unreachable' };
        }
      }
      return { executed: true };
    case 'night_mode':
      if (!demoMode) {
        try {
          await api.cameraNightMode();
        } catch {
          return { executed: false, note: 'Camera endpoint unreachable' };
        }
      }
      return { executed: true };
    case 'start_recording':
      if (!demoMode) {
        try {
          await api.cameraRecord();
        } catch {
          return { executed: false, note: 'Camera endpoint unreachable' };
        }
      }
      return { executed: true };
    case 'status_report':
      return { executed: false, note: 'Spoken status only' };
    default:
      return { executed: false };
  }
};

// ---- Spoken reply (Pi speaker, phone fallback) -----------------------------

export async function speakReply(text: string): Promise<void> {
  const prefs = useSettings.getState().prefs;
  const wsState = useLiveData.getState().wsState;

  // Prefer the Pi's speaker; sendRoverCommand reports whether it actually went out.
  if (prefs.piSpeakerEnabled && wsState === 'connected') {
    if (sendRoverCommand({ cmd: 'SPEAK', text })) return;
  }
  if (prefs.phoneSpeakerFallback) {
    try {
      Speech.stop();
      Speech.speak(text, {
        language: prefs.voiceLanguage,
        pitch: PHONE_VOICE.pitch,
        rate: PHONE_VOICE.rate,
      });
    } catch {
      // ignore: nothing else to fall back to
    }
  }
}

// ---- Turn handling ---------------------------------------------------------

let inFlight: AbortController | null = null;
let hasActionedTurn = false;

export const handleTranscript = async (transcript: string): Promise<void> => {
  const V = useVoice.getState();
  const prefs = useSettings.getState().prefs;
  const clean = transcript.trim();
  if (clean.length === 0) {
    V.setStage('idle');
    return;
  }

  V.setFinalTranscript(clean);
  V.setError(null);

  // Resolve a pending confirmation first — no JEV round-trip needed.
  if (V.pending) {
    const pending = V.pending;
    V.setPending(null);
    if (/^(yes|yeah|yep|confirm|confirmed|do it|go ahead|proceed)\b/i.test(clean)) {
      if (pending.action.id === 'none') {
        await finishTurn(clean, pending.action, pending.action.confidence, false, 'Nothing to confirm.');
        return;
      }
      V.setStage('acting');
      const { executed, note } = await executeAction({
        action: pending.action,
        isCommand: true,
        destructive: true,
        speedPct: 0,
        model: 'confirmed',
      });
      await finishTurn(clean, pending.action, pending.action.confidence, executed, buildReply(pending.action, 0), note);
      return;
    }
    V.setTranscript('');
    await finishTurn(
      clean,
      { ...pending.action, id: 'none', label: 'No action', destructive: false },
      pending.action.confidence,
      false,
      pick(['Okay, cancelled — nothing was changed.', 'No problem, I left it alone.']),
    );
    return;
  }

  V.setStage('thinking');
  inFlight?.abort();
  inFlight = new AbortController();

  let classification: VoiceClassification;
  try {
    classification = await classifyTranscript(clean, inFlight.signal);
  } catch (err) {
    const message =
      err instanceof JevError
        ? err.code === 'no-key'
          ? "Pop into Settings and add your TypeSafe key, and I'll be all ears!"
          : err.message
        : 'Voice classification failed.';
    V.setError(message);
    V.setStage('error');
    const turn: VoiceTurn = {
      id: nextTurnId(),
      ts: Date.now(),
      transcript: clean,
      action: 'none',
      actionLabel: 'Error',
      confidence: 0,
      reply: message,
      executed: false,
      note: 'JEV unavailable',
    };
    V.pushTurn(turn);
    if (err instanceof JevError && err.code === 'no-key') await speakReply(message);
    return;
  } finally {
    inFlight = null;
  }

  const { action, isCommand, destructive } = classification;
  const minConfidence = prefs.voiceMinConfidence;

  // 1. Not addressed to the rover, or explicitly nothing to do.
  if (!isCommand || action.id === 'none') {
    const reply = ACTION_BY_ID.get('none')!.reply(context(classification.speedPct));
    await finishTurn(clean, action, action.confidence, false, reply, 'Not a rover command');
    return;
  }

  // 2. Too unsure to act (stopping is always allowed — it is the safe default).
  const threshold = action.id === 'stop' ? Math.min(minConfidence, 0.4) : minConfidence;
  if (action.confidence < threshold) {
    const reply = pick([
      `Sorry, I didn't quite catch "${clean}". Could you say that again?`,
      `Hmm, I'm not sure about "${clean}" — one more time?`,
    ]);
    await finishTurn(clean, action, action.confidence, false, reply, 'Below confidence threshold');
    return;
  }

  // 3. Safety-critical actions need near-certainty; otherwise ask to confirm.
  if (destructive && action.confidence < 0.9) {
    const reply = pick([
      `Just to be sure — did you want me to ${action.label.toLowerCase()}? Say confirm and I'll do it.`,
      `That one's a big deal, so I'd rather check: shall I ${action.label.toLowerCase()}? Say confirm.`,
    ]);
    V.setPending({ action, transcript: clean });
    V.setStage('speaking');
    await speakReply(reply);
    V.pushTurn({
      id: nextTurnId(),
      ts: Date.now(),
      transcript: clean,
      action: action.id,
      actionLabel: action.label,
      confidence: action.confidence,
      reply,
      executed: false,
      note: 'Awaiting spoken confirmation',
    });
    V.setStage('idle');
    return;
  }

  // 4. Execute.
  V.setStage('acting');
  const { executed, note } = await executeAction(classification);

  // Movement is a pulse, not a latching state: stop after a short window unless
  // it was an explicit stop/patrol command.
  if (executed && MOVE_ANGLES[action.id] != null) {
    scheduleMovementStop();
  }

  const reply = ACTION_BY_ID.get(action.id)!.reply(context(classification.speedPct));
  await finishTurn(clean, action, action.confidence, executed, reply, note);
};

const buildReply = (action: VoiceAction, speedPct: number) =>
  (ACTION_BY_ID.get(action.id) ?? ACTION_BY_ID.get('none')!).reply(context(speedPct));

let movementStopTimer: ReturnType<typeof setTimeout> | null = null;
const MOVEMENT_PULSE_MS = 1500;

/** Voice "move forward" is a nudge: auto-stop unless the user issues another command. */
const scheduleMovementStop = () => {
  if (movementStopTimer) clearTimeout(movementStopTimer);
  movementStopTimer = setTimeout(() => {
    movementStopTimer = null;
    if (!useSettings.getState().connection.demoMode) sendRoverCommand({ cmd: 'STOP' });
  }, MOVEMENT_PULSE_MS);
};

const finishTurn = async (
  transcript: string,
  action: VoiceAction,
  confidence: number,
  executed: boolean,
  reply: string,
  note?: string,
): Promise<void> => {
  const V = useVoice.getState();
  V.pushTurn({
    id: nextTurnId(),
    ts: Date.now(),
    transcript,
    action: action.id,
    actionLabel: action.label,
    confidence,
    reply,
    executed,
    note,
  });
  V.setStage('speaking');
  V.setTranscript('');
  await speakReply(reply);
  V.setStage('idle');
};

// ---- Speech recognition (lazy-loaded; needs a dev build) -------------------

type SpeechRecognitionModule = typeof import('expo-speech-recognition');

let injectedModule: SpeechRecognitionModule | null = null;
let loaded = false;

/** Test/DI hook so the pipeline can be exercised without the native module. */
export const __setSpeechModuleForTests = (mod: SpeechRecognitionModule | null) => {
  injectedModule = mod;
  loaded = true;
};

const loadSpeechModule = async (): Promise<SpeechRecognitionModule | null> => {
  if (loaded) return injectedModule;
  loaded = true;
  try {
    injectedModule = await import('expo-speech-recognition');
  } catch {
    injectedModule = null;
  }
  return injectedModule;
};

let listenersBound = false;

export const initVoice = async (): Promise<void> => {
  const mod = await loadSpeechModule();
  const V = useVoice.getState();
  if (!mod) {
    V.setAvailable(false);
    return;
  }
  if (listenersBound) {
    V.setAvailable(mod.ExpoSpeechRecognitionModule.isRecognitionAvailable());
    return;
  }
  listenersBound = true;
  try {
    V.setAvailable(mod.ExpoSpeechRecognitionModule.isRecognitionAvailable());
    mod.ExpoSpeechRecognitionModule.addListener('start', () => {
      useVoice.getState().setStage('listening');
      useVoice.getState().setError(null);
    });
    mod.ExpoSpeechRecognitionModule.addListener('end', () => {
      const s = useVoice.getState().stage;
      if (s === 'listening') useVoice.getState().setStage('idle');
    });
    mod.ExpoSpeechRecognitionModule.addListener('result', (event) => {
      const best = event.results[0]?.transcript ?? '';
      useVoice.getState().setTranscript(best);
      if (event.isFinal && !hasActionedTurn) {
        hasActionedTurn = true;
        void handleTranscript(best).finally(() => {
          hasActionedTurn = false;
        });
      }
    });
    mod.ExpoSpeechRecognitionModule.addListener('error', (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      const V2 = useVoice.getState();
      V2.setError(speechErrorMessage(event.error));
      V2.setStage('error');
    });
  } catch {
    V.setAvailable(false);
  }
};

const speechErrorMessage = (code: string): string => {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone / speech permission denied. Enable it in system settings.';
    case 'network':
      return 'Speech recognition needs a network connection.';
    case 'audio-capture':
      return 'No microphone input detected.';
    case 'busy':
      return 'The speech recognizer is busy. Try again.';
    default:
      return `Speech recognition error: ${code}`;
  }
};

export const startListening = async (): Promise<void> => {
  const mod = await loadSpeechModule();
  const V = useVoice.getState();
  if (!mod) {
    V.setAvailable(false);
    V.setError('Speech recognition needs a development build (not Expo Go). Run `npx expo run:android`.');
    V.setStage('error');
    return;
  }

  const permission = await mod.ExpoSpeechRecognitionModule.requestPermissionsAsync();
  if (!permission.granted) {
    V.setError('Microphone permission is required for voice control.');
    V.setStage('error');
    return;
  }

  const prefs = useSettings.getState().prefs;
  V.setTranscript('');
  V.setError(null);
  V.setStage('listening');
  try {
    mod.ExpoSpeechRecognitionModule.start({
      lang: prefs.voiceLanguage,
      interimResults: true,
      continuous: false,
      maxAlternatives: 1,
      addsPunctuation: true,
      requiresOnDeviceRecognition: false,
      iosTaskHint: 'confirmation',
    });
  } catch (err) {
    V.setError(`Could not start the microphone: ${(err as Error).message}`);
    V.setStage('error');
  }
};

export const stopListening = async (): Promise<void> => {
  const mod = await loadSpeechModule();
  try {
    mod?.ExpoSpeechRecognitionModule.stop();
  } catch {
    // ignore
  }
};

export const cancelListening = async (): Promise<void> => {
  const mod = await loadSpeechModule();
  try {
    mod?.ExpoSpeechRecognitionModule.abort();
  } catch {
    // ignore
  }
  const V = useVoice.getState();
  V.setTranscript('');
  V.setPending(null);
  V.setStage('idle');
};

/** True when the user can actually use the mic in this build. */
export const isVoiceSupported = async (): Promise<boolean> => {
  const mod = await loadSpeechModule();
  if (!mod) return false;
  try {
    return mod.ExpoSpeechRecognitionModule.isRecognitionAvailable();
  } catch {
    return false;
  }
};

export const hasTypesafeKeyConfigured = async (): Promise<boolean> => (await getTypesafeKey()) != null;
