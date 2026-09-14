import { create } from 'zustand';
import type {
  CameraDetections,
  DeviceHealth,
  Incident,
  MqttDeviceHealth,
  MqttRoverStatus,
  MqttThreat,
  RoverStatus,
  RoverTelemetry,
  SensorReading,
  ThreatState,
} from '../types';

export type LinkState = 'connected' | 'reconnecting' | 'offline' | 'demo';

export interface LiveDataState {
  // rover
  roverStatus: RoverStatus | null;
  telemetry: RoverTelemetry | null;
  battery: number | null;
  zone: string | null;
  // threat & sensors
  threat: ThreatState | null;
  sensors: Record<string, SensorReading>;
  deviceHealth: Record<string, DeviceHealth>;
  // camera
  detections: CameraDetections | null;
  motionActive: boolean;
  cameraOnline: boolean;
  // incidents
  incidents: Incident[];
  incidentsLoading: boolean;
  lastIncidentId: number | null;
  // connection
  mqttState: LinkState;
  wsState: LinkState;
  wsLatencyMs: number | null;
  lastUpdated: number | null;

  setRoverStatus: (p: MqttRoverStatus) => void;
  setTelemetry: (t: RoverTelemetry) => void;
  setThreat: (t: MqttThreat) => void;
  upsertSensor: (id: string, patch: Partial<SensorReading>) => void;
  setDeviceHealth: (h: MqttDeviceHealth) => void;
  setDetections: (d: CameraDetections) => void;
  setMotionActive: (v: boolean) => void;
  setCameraOnline: (v: boolean) => void;
  setIncidents: (list: Incident[], loading?: boolean) => void;
  updateIncident: (id: number, patch: Partial<Incident>) => void;
  markSeen: () => void;
  setMqttState: (s: LinkState) => void;
  setWsState: (s: LinkState) => void;
  setWsLatency: (ms: number | null) => void;
}

const touch = () => ({ lastUpdated: Date.now() });

export const useLiveData = create<LiveDataState>((set) => ({
  roverStatus: null,
  telemetry: null,
  battery: null,
  zone: null,
  threat: null,
  sensors: {},
  deviceHealth: {},
  detections: null,
  motionActive: false,
  cameraOnline: false,
  incidents: [],
  incidentsLoading: false,
  lastIncidentId: null,
  mqttState: 'offline',
  wsState: 'offline',
  wsLatencyMs: null,
  lastUpdated: null,

  setRoverStatus: (p) =>
    set((s) => ({
      roverStatus: { state: p.state as RoverStatus['state'], battery: p.battery, zone: p.zone },
      battery: p.battery,
      zone: p.zone,
      ...touch(),
    })),
  setTelemetry: (t) => set((s) => ({ telemetry: t, ...touch() })),
  setThreat: (t) => set((s) => ({ threat: t, ...touch() })),
  upsertSensor: (id, patch) =>
    set((s) => {
      const prev = s.sensors[id];
      const next: SensorReading = {
        id,
        label: patch.label ?? prev?.label ?? id,
        value: patch.value ?? prev?.value ?? '—',
        status: patch.status ?? prev?.status ?? 'online',
        lastSeen: patch.lastSeen ?? Date.now(),
      };
      return { sensors: { ...s.sensors, [id]: next }, ...touch() };
    }),
  setDeviceHealth: (h) =>
    set(() => {
      const now = Date.now();
      const mk = (id: string, label: string, detail: string, online: boolean): DeviceHealth => ({
        id,
        label,
        detail,
        online,
        lastSeen: now,
      });
      return {
        deviceHealth: {
          raspberry_pi: mk(
            'raspberry_pi',
            'Raspberry Pi',
            h.pi ? `CPU ${h.pi.cpu}% · RAM ${h.pi.ram}% · ${h.pi.temp}°C` : 'Health packet received',
            true,
          ),
          esp32_door: mk('esp32_door', 'ESP32 Door Node', 'Door/reed + RFID reader', h.esp32_door === 'online'),
          pir_node: mk('pir_node', 'PIR Node', 'Motion detector', h.pir_node === 'online'),
          gas_node: mk('gas_node', 'Gas Sensor Node', 'MQ-2 smoke/gas', h.gas_node === 'online'),
          rover: mk('rover', 'Rover', 'Drive + ultrasonic', h.rover === 'online'),
          camera: mk('camera', 'Camera', 'MJPEG endpoint', h.camera === 'online'),
        },
        ...touch(),
      };
    }),
  setDetections: (d) => set({ detections: d }),
  setMotionActive: (v) => set({ motionActive: v }),
  setCameraOnline: (v) => set({ cameraOnline: v }),
  setIncidents: (list, loading = false) =>
    set({
      incidents: list,
      incidentsLoading: loading,
      lastIncidentId: list.length > 0 ? Math.max(...list.map((i) => i.id)) : null,
    }),
  updateIncident: (id, patch) =>
    set((s) => ({
      incidents: s.incidents.map((i) => (i.id === id ? { ...i, ...patch } : i)),
    })),
  markSeen: () => set({ lastIncidentId: null }),
  setMqttState: (mqttState) => set({ mqttState }),
  setWsState: (wsState) => set({ wsState, ...(wsState === 'offline' ? { wsLatencyMs: null } : {}) }),
  setWsLatency: (ms) => set({ wsLatencyMs: ms }),
}));
