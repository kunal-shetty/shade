# CyberSentinel CPS Rover — Mobile Command & Control

React Native (Expo) companion app for the CyberSentinel autonomous security rover (Raspberry Pi 4).
Implements the full v1.0 PRD: live dashboard, joystick rover control, MJPEG camera feed with
detection overlays, incident timeline, zone map, threat center, RFID-gated admin mode, and
**hands-free voice control** that classifies spoken commands with
[JEV](https://typesafe.ai), TypeSafe AI's System One decision model.

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
               FCM notifications, demo-mode engine, JEV client, voice pipeline,
               WiFi auto-discovery, secure key storage
  components/  ThreatBadge, SensorCard, IncidentRow, JoystickPad, StreamView,
               AdminLock, gauges, RFID modal, connection banner, VoiceControl
  screens/     Dashboard, Control, Camera, Incidents, IncidentDetail,
               ZoneMap, ThreatCenter, Settings
  navigation/  Bottom tabs + native stack (React Navigation v7)
```

## Connecting to the rover (live mode)

| Link | Default | Notes |
|------|---------|-------|
| Rover commands + speaker | `ws://<pi>:8765` | MOVE at 100 ms pacing, STOP, patrol, buzzer, `SPEAK` |
| Sensor events | `ws://<pi>:9001` (MQTT) | Subscribes to all `rover/* sensor/* threat/* camera/* rfid/* incident/* device/health` topics |
| Camera stream | `http://<pi>:8080/stream.mjpg` | MJPEG, rendered in-app |
| REST API | `http://<pi>:8000` | Incidents, alarm, camera, health, speak, FCM registration |

All values are configurable in Settings and persisted via AsyncStorage.

## Zero-config on WiFi

The only requirement is that the phone and the Pi are on the same WiFi. On
launch (and whenever the network changes) the app resolves the Pi in order:

1. the address saved from last time,
2. `cybersentinel.local` via mDNS (Avahi on the Pi),
3. a bounded parallel scan of the phone's own `/24` subnet for a gateway
   answering `GET /health` on port 8000.

The address is then saved and the MQTT/WebSocket links connect automatically.
Toggle this in **Settings → Auto-discover on WiFi** or force it with
**Find Pi on this WiFi**.

## Voice control (mic → JEV → rover)

1. Tap the mic and speak a command (“patrol the front yard”, “back up slowly”,
   “what's the status?”).
2. On-device speech recognition (`expo-speech-recognition`) produces the
   transcript.
3. The transcript plus a small rover-state snapshot is sent to JEV, which
   returns a **typed** decision — `choice` (which action), `noul` (is it a
   command? is it safety-critical?) and `score` (how fast) — each with calibrated
   confidence in ~100 ms. JEV never writes prose.
4. The app applies thresholds: below `Minimum confidence` it asks you to repeat;
   safety-critical actions need ≥ 0.9 or a spoken “confirm”.
5. The action is sent over the WebSocket link and a deterministic reply is
   spoken on the **Raspberry Pi's speaker** (`SPEAK` command), with the phone's
   speaker as a fallback.

Add your TypeSafe API key in **Settings → Voice Control** (stored in the device
keychain; `EXPO_PUBLIC_TYPESAFE_API_KEY` works as a build-time fallback).

> Speech recognition requires a **development build** (`npx expo run:android` /
> `run:ios`) because it uses native iOS/Android recognizers — it is not
> available inside Expo Go. Everything else runs in Expo Go.

See [`pi/README.md`](pi/README.md) for the hardware setup (speaker, MQTT
websockets listener, mDNS, MJPEG camera).

## RFID admin flow

Tap any admin-gated control (or *Admin Login* in Settings) → the app shows the
"scan RFID at rover" modal → the Pi publishes `rfid/auth` / `rfid/denied` → the session
unlocks for 15/30/60 min (configurable). Card UIDs are never stored on the device.
