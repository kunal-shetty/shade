import * as Speech from 'expo-speech';
import { useLiveData } from '../store/rover';
import { isIpv4, useSettings } from '../store/settings';
import { discoverPi } from './discovery';
import type { RoverCommand } from '../types';

let ws: WebSocket | null = null;
let manualStop = false;
let backoffMs = 500;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let pendingPing: number | null = null;
let healTimer: ReturnType<typeof setTimeout> | null = null;
let healRunning = false;
let healBackoffMs = 1500;

/**
 * Last-resort repair for a host the phone cannot dial (e.g. a saved
 * `cybersentinel.local`): sweep the WiFi for the gateway and reconnect to
 * whatever answers. Without this a stale mDNS name leaves the rover dead to
 * the app while everything on the Pi is healthy.
 */
const scheduleHostHeal = (immediate = false) => {
  const { autoDiscover, demoMode } = useSettings.getState().connection;
  if (demoMode || !autoDiscover || manualStop) return;
  if (healTimer || healRunning) return;
  const delayMs = immediate ? 0 : healBackoffMs;
  // A full subnet sweep is not free, so space the attempts out when the Pi is
  // genuinely absent (wrong WiFi) instead of re-scanning on every timeout.
  healBackoffMs = Math.min(healBackoffMs * 2, 30_000);
  healTimer = setTimeout(async () => {
    healTimer = null;
    if (manualStop || ws !== null) return;
    healRunning = true;
    const found = await discoverPi({ deep: true }).catch(() => null);
    healRunning = false;
    if (!found || manualStop) return;
    // discovery wrote the new host into settings when it differed
    connectRoverLink();
  }, delayMs);
};

const listeners = new Set<(ack: Record<string, unknown>) => void>();

// ---- Startup greeting ------------------------------------------------------
// Spoken once per app launch, as soon as a link exists to speak through. The
// rover's speaker is preferred (same SPEAK path voice replies use); demo mode
// or a dead Pi falls back to the phone's own voice.
export const STARTUP_GREETING = 'Good morning Mohini maam';
let greetedThisSession = false;

const speakGreeting = () => {
  if (greetedThisSession) return;
  greetedThisSession = true;
  const { piSpeakerEnabled, phoneSpeakerFallback, voiceLanguage } = useSettings.getState().prefs;
  if (piSpeakerEnabled && sendRoverCommand({ cmd: 'SPEAK', text: STARTUP_GREETING })) return;
  if (phoneSpeakerFallback) {
    try {
      Speech.stop();
      Speech.speak(STARTUP_GREETING, { language: voiceLanguage || 'en-IN' });
    } catch {
      // ignore: a greeting must never break the connection it rides on
    }
  }
};

export const onRoverAck = (fn: (ack: Record<string, unknown>) => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

const emitAck = (ack: Record<string, unknown>) => {
  for (const fn of listeners) fn(ack);
};

export const sendRoverCommand = (cmd: RoverCommand): boolean => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(cmd));
    return true;
  } catch {
    return false;
  }
};

export const getWsState = () => useLiveData.getState().wsState;

export const disconnectRoverLink = () => {
  manualStop = true;
  stopPing();
  try {
    ws?.close();
  } catch {
    // ignore
  }
  ws = null;
  useLiveData.getState().setWsState('offline');
};

export const connectRoverLink = () => {
  const { host, wsPort, demoMode, autoReconnect } = useSettings.getState().connection;
  disconnectRoverLink();
  manualStop = false;

  if (demoMode) {
    useLiveData.getState().setWsState('demo');
    speakGreeting();
    return;
  }

  // Something a DNS-free phone can actually resolve is the only thing worth
  // dialling; otherwise hunt for the Pi straight away.
  if (!isIpv4(host)) scheduleHostHeal(true);

  const url = `ws://${host}:${wsPort}`;
  let socket: WebSocket;
  try {
    socket = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }
  ws = socket;

  socket.onopen = () => {
    backoffMs = 500;
    healBackoffMs = 1500;
    useLiveData.getState().setWsState('connected');
    startPing();
    speakGreeting();
  };

  socket.onmessage = (ev) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (msg.type === 'pong') {
      if (pendingPing != null) {
        useLiveData.getState().setWsLatency(Date.now() - pendingPing);
        pendingPing = null;
    }
      return;
    }
    // Telemetry may also arrive over WS if the Pi mirrors it here
    if (msg.type === 'telemetry') {
      useLiveData.getState().setTelemetry({
        ultrasonic_cm: Number(msg.ultrasonic_cm ?? 0),
        speed_l: Number(msg.speed_l ?? 0),
        speed_r: Number(msg.speed_r ?? 0),
        heading: msg.heading != null ? Number(msg.heading) : undefined,
      });
      return;
    }
    emitAck(msg);
  };

  socket.onerror = () => {
    // close handler drives state
  };

  socket.onclose = () => {
    if (manualStop || ws !== socket) return;
    ws = null;
    stopPing();
    useLiveData.getState().setWsState('reconnecting');
    // A refused/unresolvable address is not fixed by retrying the same host,
    // so look the Pi up again alongside the normal backoff.
    scheduleHostHeal();
    if (useSettings.getState().connection.autoReconnect) scheduleReconnect();
  };
};

const scheduleReconnect = () => {
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, 30_000);
  setTimeout(() => {
    if (!manualStop && ws === null) connectRoverLink();
    if (ws !== null) backoffMs = 500;
  }, delay);
};

const startPing = () => {
  stopPing();
  pingTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      pendingPing = Date.now();
      try {
        ws.send(JSON.stringify({ cmd: 'PING' }));
      } catch {
        // ignore
      }
    }
    if (pendingPing != null && Date.now() - pendingPing > 5000) {
      useLiveData.getState().setWsLatency(null);
      pendingPing = null;
    }
  }, 3000);
};

const stopPing = () => {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
};

/** Throttled joystick sender: emits MOVE at most every 100ms, STOP on release. */
export const createJoystickSender = () => {
  let lastSent = 0;
  let lastPayload = '';
  return {
    move: (angle: number, speed: number, speedLimit: number) => {
      const now = Date.now();
      const payload = JSON.stringify({ cmd: 'MOVE', angle, speed, limit: speedLimit });
      if (now - lastSent >= 100 && payload !== lastPayload) {
        sendRoverCommand({ cmd: 'MOVE', angle, speed });
        lastSent = now;
        lastPayload = payload;
      }
    },
    stop: () => {
      lastSent = 0;
      lastPayload = '';
      sendRoverCommand({ cmd: 'STOP' });
    },
  };
};
