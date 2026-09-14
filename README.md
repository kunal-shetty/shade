# CyberSentinel CPS Rover — Mobile Command & Control

React Native (Expo) companion app for the CyberSentinel autonomous security rover (Raspberry Pi 4).
Implements the full v1.0 PRD: live dashboard, joystick rover control, MJPEG camera feed with
detection overlays, incident timeline, zone map, threat center, and RFID-gated admin mode.

## Run

```bash
npm install
npx expo start        # scan QR with Expo Go (Android 10+ / iOS 14+)
```

The app ships with **Demo Mode enabled by default** — it simulates the Pi's MQTT stream
(rover telemetry, threat escalation per the PRD §11 demo script, incident creation, RFID scans)
so the full UI can be evaluated without hardware. Disable it in **Settings → Demo Mode** and set
the Pi's IP address to go live.

## Architecture

```
src/
  theme/       Design system (PRD §10): palette, typography, light/dark contexts
  types/       Shared contract types (PRD §9)
  store/       Zustand stores: persisted settings + admin session, live data
  services/    MQTT (Mosquitto over WS), WebSocket rover link, FastAPI REST client,
               FCM notifications, demo-mode engine
  components/  ThreatBadge, SensorCard, IncidentRow, JoystickPad, StreamView,
               AdminLock, gauges, RFID modal, connection banner
  screens/     Dashboard, Control, Camera, Incidents, IncidentDetail,
               ZoneMap, ThreatCenter, Settings
  navigation/  Bottom tabs + native stack (React Navigation v7)
```

## Connecting to the rover (live mode)

| Link | Default | Notes |
|------|---------|-------|
| Rover commands | `ws://<pi>:8765` | Joystick MOVE at 100 ms pacing, STOP, patrol, buzzer |
| Sensor events | `ws://<pi>:9001` (MQTT) | Subscribes to all `rover/* sensor/* threat/* camera/* rfid/* incident/* device/health` topics |
| Camera stream | `http://<pi>:8080/stream.mjpg` | MJPEG, rendered in-app |
| REST API | `http://<pi>:8000` | Incidents, alarm, camera, health, FCM registration |

All values are configurable in Settings and persisted via AsyncStorage.

## RFID admin flow

Tap any admin-gated control (or *Admin Login* in Settings) → the app shows the
"scan RFID at rover" modal → the Pi publishes `rfid/auth` / `rfid/denied` → the session
unlocks for 15/30/60 min (configurable). Card UIDs are never stored on the device.
