import { handleMqttMessage } from './mqtt';
import { useLiveData } from '../store/rover';
import { useAdmin } from '../store/settings';
import type { Incident, Severity } from '../types';

let timers: ReturnType<typeof setInterval>[] = [];
let running = false;
let demoIncidentId = 9000;
let scenarioStep = 0;
let threatBase = 4;

const startTimer = (fn: () => void, ms: number) => {
  timers.push(setInterval(fn, ms));
};

export const stopDemoEngine = () => {
  for (const t of timers) clearInterval(t);
  timers = [];
  running = false;
};

export const isDemoRunning = () => running;

export const startDemoEngine = () => {
  if (running) return;
  running = true;
  const L = useLiveData.getState();

  // Seed a few historical incidents so the timeline is populated immediately
  const seedRows: [Severity, string, string, number, number][] = [
    ['medium', 'Zone B', 'Motion detected during off-hours', 34, 1000 * 60 * 60 * 5],
    ['low', 'Zone A', 'Door opened with valid RFID auth', 18, 1000 * 60 * 60 * 26],
  ];
  for (const [sev, zn, sum, score, ago] of seedRows) {
    const ts = Date.now() - ago;
    L.setIncidents([
      ...L.incidents,
      {
        id: ++demoIncidentId,
        severity: sev,
        zone: zn,
        summary: sum,
        ts,
        status: 'resolved',
        events: [
          { ts: ts - 2000, label: 'Event detected' },
          { ts, label: 'Incident created — score ' + score },
        ],
        sensorSnapshot: [],
        score,
        contributions: [],
        photoUrl: null,
        resolutionNotes: 'Auto-resolved: readings returned to baseline.',
        resolvedBy: 'system',
        resolvedAt: ts + 60000,
      },
    ]);
  }

  // --- rover status + battery drain ---
  let battery = 78;
  let stateCycle: 'patrolling' | 'idle' = 'patrolling';
  startTimer(() => {
    battery = Math.max(12, battery - 0.02);
    handleMqttMessage('rover/status', JSON.stringify({ state: stateCycle, battery: Math.round(battery), zone: `Zone ${['A', 'B', 'C'][Math.floor((Date.now() / 60000) % 3)]}` }));
  }, 2000);

  // --- telemetry ---
  let t = 0;
  startTimer(() => {
    t += 0.5;
    handleMqttMessage('rover/telemetry', JSON.stringify({
      ultrasonic_cm: Math.round(45 + 20 * Math.sin(t)),
      speed_l: stateCycle === 'patrolling' ? 60 : 0,
      speed_r: stateCycle === 'patrolling' ? 60 : 0,
      heading: Math.round((t * 12) % 360),
    }));
  }, 300);

  // --- environment sensors (steady) ---
  startTimer(() => {
    handleMqttMessage('sensor/env', JSON.stringify({ temp: +(27.5 + Math.random()).toFixed(1), humidity: Math.round(58 + Math.random() * 8) }));
    handleMqttMessage('sensor/gas', JSON.stringify({ ppm: Math.round(300 + Math.random() * 40), alarm: false }));
    handleMqttMessage('sensor/door', JSON.stringify({ open: false }));
    handleMqttMessage('sensor/pir', JSON.stringify({ motion: false }));
    handleMqttMessage('camera/detections', JSON.stringify({ persons: [] }));
  }, 2500);

  // --- device health ---
  startTimer(() => {
    handleMqttMessage('device/health', JSON.stringify({
      esp32_door: 'online', pir_node: 'online', gas_node: 'online', rover: 'online', camera: 'online',
      pi: { cpu: Math.round(30 + Math.random() * 20), ram: 46, temp: 52, uptime: 86400 * 3 },
    }));
  }, 5000);

  // --- PRD §11 demo scenario: escalating intrusion, loops every 3 min ---
  startTimer(() => {
    scenarioStep = (scenarioStep + 1) % 18;
    const S = scenarioStep;
    if (S === 2) {
      handleMqttMessage('sensor/door', JSON.stringify({ open: true }));
    } else if (S === 4) {
      handleMqttMessage('sensor/pir', JSON.stringify({ motion: true }));
    } else if (S === 5) {
      // door open + no RFID + motion => threat climbs past 76
      handleMqttMessage('threat/level', JSON.stringify({ level: 'critical', score: 82, triggers: ['motion', 'door_open', 'no_rfid', 'person'] }));
      handleMqttMessage('camera/detections', JSON.stringify({ persons: [{ x: 340, y: 120, w: 90, h: 210 }] }));
      createDemoIncident('critical', 'Zone A', 'Intrusion pattern: door open, no RFID, motion + person detected', 82, ['motion', 'door_open', 'no_rfid', 'person']);
    } else if (S === 9) {
      handleMqttMessage('sensor/door', JSON.stringify({ open: false }));
      handleMqttMessage('sensor/pir', JSON.stringify({ motion: false }));
      handleMqttMessage('threat/level', JSON.stringify({ level: 'low', score: 6, triggers: [] }));
      handleMqttMessage('camera/detections', JSON.stringify({ persons: [] }));
      resolveDemoIncident();
    }
  }, 10_000);

  // --- ambient threat baseline ---
  startTimer(() => {
    if (scenarioStep > 5 && scenarioStep < 9) return; // critical window drives score
    threatBase = 2 + Math.round(Math.random() * 8);
    handleMqttMessage('threat/level', JSON.stringify({ level: 'low', score: threatBase, triggers: threatBase > 15 ? ['motion'] : [] }));
  }, 6000);

  void L;
};

let pendingIncident: Incident | null = null;

export const createDemoIncident = (
  severity: Severity, zone: string, summary: string, score: number, triggers: string[],
) => {
  const now = Date.now();
  const id = ++demoIncidentId;
  const incident: Incident = {
    id,
    severity,
    zone,
    summary,
    ts: now,
    status: 'open',
    events: [
      { ts: now - 6000, label: 'Door opened (reed switch)' },
      { ts: now - 5000, label: 'No RFID auth within 60 s window' },
      { ts: now - 4000, label: 'PIR motion detected' },
      { ts: now - 3000, label: 'Person detected via camera (OpenCV)' },
      { ts: now - 2000, label: 'Rover dispatched to zone' },
      { ts: now, label: `Incident created — score ${score}` },
    ],
    sensorSnapshot: Object.values(useLiveData.getState().sensors),
    score,
    contributions: triggers.map((trg) => {
      const pts: Record<string, number> = { motion: 20, door_open: 20, no_rfid: 30, person: 20, gas: 25, night: 10, vibration: 15, fire: 30 };
      return { factor: trg, label: trg.replace('_', ' '), points: pts[trg] ?? 10 };
    }),
    photoUrl: null,
    resolutionNotes: null,
    resolvedBy: null,
    resolvedAt: null,
  };
  pendingIncident = incident;
  const L = useLiveData.getState();
  L.setIncidents([incident, ...L.incidents].slice(0, 50));
  handleMqttMessage('incident/new', JSON.stringify({ id, severity, zone }));
};

export const resolveDemoIncident = () => {
  const L = useLiveData.getState();
  const open = L.incidents.find((i) => i.status === 'open');
  if (open) {
    L.updateIncident(open.id, {
      status: 'resolved',
      resolvedAt: Date.now(),
      resolvedBy: useAdmin.getState().session?.uid ?? 'auto-resolve (demo)',
      resolutionNotes: 'Pattern cleared; sensors returned to baseline.',
    });
  }
  pendingIncident = null;
};

export const triggerDemoAlarm = () => {
  createDemoIncident('critical', 'Zone A', 'Alarm manually triggered by admin', 100, ['person', 'no_rfid']);
};

export const demoRfidScan = (granted: boolean) => {
  handleMqttMessage(
    granted ? 'rfid/auth' : 'rfid/denied',
    JSON.stringify(granted ? { status: 'granted', uid: 'A1B2C3', admin: true } : { status: 'denied', uid: 'XX9900' }),
  );
};
