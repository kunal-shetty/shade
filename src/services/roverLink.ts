import { useLiveData } from '../store/rover';
import { useSettings } from '../store/settings';
import type { RoverCommand } from '../types';

let ws: WebSocket | null = null;
let manualStop = false;
let backoffMs = 500;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let pendingPing: number | null = null;

const listeners = new Set<(ack: Record<string, unknown>) => void>();

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
    return;
  }

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
    useLiveData.getState().setWsState('connected');
    startPing();
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
