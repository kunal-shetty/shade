import mqtt, { type MqttClient } from 'mqtt';
import { useLiveData, type LinkState } from '../store/rover';
import { useSettings } from '../store/settings';
import type {
  CameraDetections,
  MqttDeviceHealth,
  MqttRoverStatus,
  MqttThreat,
  RfidAuthEvent,
} from '../types';

export type RfidHandler = (ev: RfidAuthEvent) => void;

let client: MqttClient | null = null;
let manualStop = false;
let rfidHandler: RfidHandler | null = null;
let lastMsgAt = 0;
let watchdog: ReturnType<typeof setInterval> | null = null;

export const setRfidHandler = (h: RfidHandler | null) => {
  rfidHandler = h;
};

export const getMqttState = (): LinkState =>
  client?.connected ? 'connected' : useLiveData.getState().mqttState;

export const disconnectMqtt = () => {
  manualStop = true;
  stopWatchdog();
  try {
    client?.end(true);
  } catch {
    // ignore
  }
  client = null;
  useLiveData.getState().setMqttState('offline');
};

export const connectMqtt = () => {
  const { host, mqttPort, demoMode, autoReconnect } = useSettings.getState().connection;
  disconnectMqtt();
  manualStop = false;

  if (demoMode) {
    useLiveData.getState().setMqttState('demo');
    return;
  }

  const url = `ws://${host}:${mqttPort}/`;
  const c = mqtt.connect(url, {
    connectTimeout: 4000,
    reconnectPeriod: autoReconnect ? 2000 : 0, // mqtt.js retries; FR-C3 cap handled below
    keepalive: 10,
    wsOptions: { headers: { 'Sec-WebSocket-Protocol': 'mqtt' } },
  });
  client = c;

  c.on('connect', () => {
    useLiveData.getState().setMqttState('connected');
    for (const t of ALL_TOPICS) c.subscribe(t, { qos: 1 });
  });

  c.on('reconnect', () => {
    if (manualStop) return;
    useLiveData.getState().setMqttState('reconnecting');
  });

  c.on('close', () => {
    if (manualStop) return;
    useLiveData.getState().setMqttState('reconnecting');
    if (useSettings.getState().connection.autoReconnect) {
      startWatchdog();
    }
  });

  c.on('error', () => {
    // state handled by close/reconnect
  });

  c.on('message', (_topic, payload) => {
    lastMsgAt = Date.now();
    handleMqttMessage(_topic, payload.toString());
  });
};

const ALL_TOPICS = [
  'rover/status',
  'rover/telemetry',
  'threat/level',
  'sensor/door',
  'sensor/pir',
  'sensor/gas',
  'sensor/env',
  'camera/detections',
  'rfid/auth',
  'rfid/denied',
  'incident/new',
  'device/health',
] as const;

export const handleMqttMessage = (topic: string, raw: string) => {
  const L = useLiveData.getState();
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  const m = msg as Record<string, unknown>;

  switch (topic) {
    case 'rover/status': {
      const p = m as unknown as MqttRoverStatus;
      L.setRoverStatus(p);
      L.upsertSensor('rover', { label: 'Rover', value: String(p.state), status: 'online' });
      break;
    }
    case 'rover/telemetry': {
      L.setTelemetry({
        ultrasonic_cm: Number(m.ultrasonic_cm ?? 0),
        speed_l: Number(m.speed_l ?? 0),
        speed_r: Number(m.speed_r ?? 0),
        heading: m.heading != null ? Number(m.heading) : undefined,
      });
      break;
    }
    case 'threat/level': {
      L.setThreat(m as unknown as MqttThreat);
      break;
    }
    case 'sensor/door': {
      const open = Boolean(m.open);
      L.upsertSensor('door', { label: 'Door (Reed)', value: open ? 'OPEN' : 'Closed', status: open ? 'alert' : 'online' });
      break;
    }
    case 'sensor/pir': {
      const motion = Boolean(m.motion);
      L.upsertSensor('pir', { label: 'PIR Motion', value: motion ? 'Motion' : 'Clear', status: motion ? 'alert' : 'online' });
      L.setMotionActive(motion);
      break;
    }
    case 'sensor/gas': {
      const ppm = Number(m.ppm ?? 0);
      const alarm = Boolean(m.alarm);
      L.upsertSensor('gas', { label: 'Gas / MQ-2', value: `${ppm} ppm`, status: alarm ? 'alert' : 'online' });
      break;
    }
    case 'sensor/env': {
      L.upsertSensor('env', { label: 'Temp / Humidity', value: `${m.temp}°C · ${m.humidity}%`, status: 'online' });
      break;
    }
    case 'camera/detections': {
      L.setDetections(m as unknown as CameraDetections);
      break;
    }
    case 'rfid/auth': {
      rfidHandler?.({ status: 'granted', uid: String(m.uid ?? ''), admin: m.admin !== false });
      break;
    }
    case 'rfid/denied': {
      rfidHandler?.({ status: 'denied', uid: String(m.uid ?? '') });
      break;
    }
    case 'incident/new': {
      // Full detail arrives via REST refresh; bump unread badge now.
      const id = Number(m.id ?? 0);
      if (id) useLiveData.getState().updateIncident(-1, {}); // no-op keeps selector churn low
      break;
    }
    case 'device/health': {
      L.setDeviceHealth(m as unknown as MqttDeviceHealth);
      break;
    }
    default:
      break;
  }
};

// Watchdog ensures mqtt.js reconnect storms don't leave stale "connected" UI state.
const startWatchdog = () => {
  stopWatchdog();
  lastMsgAt = Date.now();
  watchdog = setInterval(() => {
    if (!client?.connected) {
      stopWatchdog();
      return;
    }
    if (Date.now() - lastMsgAt > 45_000) {
      useLiveData.getState().setMqttState('reconnecting');
    } else {
      useLiveData.getState().setMqttState('connected');
    }
  }, 10_000);
};

const stopWatchdog = () => {
  if (watchdog) {
    clearInterval(watchdog);
    watchdog = null;
  }
};
