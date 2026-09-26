import { create } from 'zustand';
import type { VoiceAction, VoiceStage, VoiceTurn } from '../types';

interface VoiceState {
  stage: VoiceStage;
  /** null = not probed yet, false = this build/device has no speech recognizer. */
  available: boolean | null;
  /** Live (interim) transcript while the mic is open. */
  transcript: string;
  /** Final transcript of the last completed utterance. */
  finalTranscript: string;
  turns: VoiceTurn[];
  lastTurn: VoiceTurn | null;
  error: string | null;
  /** Set when JEV is only moderately confident about a safety-critical action. */
  pending: { action: VoiceAction; transcript: string } | null;

  setStage: (stage: VoiceStage) => void;
  setAvailable: (available: boolean) => void;
  setTranscript: (transcript: string) => void;
  setFinalTranscript: (transcript: string) => void;
  pushTurn: (turn: VoiceTurn) => void;
  setError: (error: string | null) => void;
  setPending: (pending: VoiceState['pending']) => void;
  reset: () => void;
}

let turnId = 0;
export const nextTurnId = () => ++turnId;

export const useVoice = create<VoiceState>((set) => ({
  stage: 'idle',
  available: null,
  transcript: '',
  finalTranscript: '',
  turns: [],
  lastTurn: null,
  error: null,
  pending: null,

  setStage: (stage) => set({ stage }),
  setAvailable: (available) => set({ available }),
  setTranscript: (transcript) => set({ transcript }),
  setFinalTranscript: (finalTranscript) => set({ finalTranscript }),
  pushTurn: (turn) =>
    set((s) => ({ turns: [turn, ...s.turns].slice(0, 25), lastTurn: turn })),
  setError: (error) => set({ error }),
  setPending: (pending) => set({ pending }),
  reset: () => set({ stage: 'idle', transcript: '', pending: null, error: null }),
}));
