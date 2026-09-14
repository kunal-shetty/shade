// ---- Rover / telemetry ----

export type RoverState = 'idle' | 'patrolling' | 'manual' | 'returning' | 'offline';

export interface RoverStatus {
  state: RoverState;
  battery: number; // 0-100
  zone: string;
}

export interface RoverTelemetry {
  ultrasonic_cm: number;
  speed_l: number; // -100..100
  speed_r: number;
  heading?: number; // degrees
}

// ---- Threat ----

export type ThreatLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ThreatState {
  level: ThreatLevel;
  score: number; // 0-100
  triggers: string[];
}

export const THREAT_FACTORS: { id: string; label: string; max: number }[] = [
  { id: 'motion', label: 'Motion Detected', max: 20 },
  { id: 'door_open', label: 'Door Opened', max: 20 },
  { id: 'no_rfid', label: 'No RFID Auth', max: 30 },
  { id: 'person', label: 'Person Detected', max: 20 },
  { id: 'gas', label: 'Gas / Smoke', max: 25 },
  { id: 'night', label: 'Night Time', max: 10 },
  { id: 'vibration', label: 'Vibration', max: 15 },
  { id: 'fire', label: 'Fire Detected', max: 30 },
];

export const threatLevelForScore = (score: number): ThreatLevel =>
  score > 75 ? 'critical' : score > 50 ? 'high' : score > 25 ? 'medium' : 'low';

// ---- Sensors ----

export interface SensorReading {
  id: string;
  label: string;
  value: string;
  status: 'online' | 'offline' | 'alert';
  lastSeen: number; // epoch ms
}

export interface DeviceHealth {
  id: string;
  label: string;
  detail: string;
  online: boolean;
  lastSeen: number;
}

// ---- Incidents ----

export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type IncidentStatus = 'open' | 'resolved';

export interface IncidentEvent {
  ts: number;
  label: string;
}

export interface Incident {
  id: number;
  severity: Severity;
  zone: string;
  summary: string;
  ts: number;
  status: IncidentStatus;
  events: IncidentEvent[];
  sensorSnapshot: SensorReading[];
  score: number;
  contributions: { factor: string; label: string; points: number }[];
  photoUrl?: string | null;
  resolutionNotes?: string | null;
  resolvedBy?: string | null;
  resolvedAt?: number | null;
}

// ---- Camera ----

export interface DetectionBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CameraDetections {
  persons: DetectionBox[];
}

// ---- RFID ----

export interface RfidAuthEvent {
  status: 'granted' | 'denied';
  uid: string;
  admin?: boolean;
}

// ---- MQTT payload shapes (PRD §9.2) ----

export interface MqttRoverStatus {
  state: string;
  battery: number;
  zone: string;
}

export interface MqttThreat {
  level: ThreatLevel;
  score: number;
  triggers: string[];
}

export interface MqttDeviceHealth {
  esp32_door: 'online' | 'offline';
  pir_node: 'online' | 'offline';
  gas_node: 'online' | 'offline';
  rover: 'online' | 'offline';
  camera: 'online' | 'offline';
  pi?: { cpu: number; ram: number; temp: number; uptime: number };
}

// ---- WebSocket commands (PRD §6.2.2) ----

export type RoverCommand =
  | { cmd: 'STOP' }
  | { cmd: 'MOVE'; angle: number; speed: number }
  | { cmd: 'SET_SPEED'; value: number }
  | { cmd: 'PATROL_START' }
  | { cmd: 'PATROL_STOP' }
  | { cmd: 'RETURN_HOME' }
  | { cmd: 'BUZZER'; duration: number };
