# CyberSentinel — An IoT-Enabled Autonomous Security Rover

**A mobile-app controlled cyber-physical security rover built on a Raspberry Pi 4, an Arduino Uno R3 and an Android (Expo) application.**

---

## 1. Aim

To design and build a low-cost, remotely operated **security rover** that a user can drive, watch and talk to from a mobile phone over ordinary Wi-Fi, and that presents a friendly, animated robot face on the rover itself.

The rover combines three subsystems that normally live apart:

* a **motion subsystem** (motors, driver, buzzer) on an 8-bit microcontroller,
* a **perception and intelligence subsystem** (camera, MQTT telemetry, REST/WebSocket gateway, text-to-speech) on a Linux single-board computer, and
* a **human interface subsystem** (a React Native mobile application with live video, a joystick, voice control and an incident timeline).

The aim is to show that a useful surveillance platform can be assembled from hobbyist parts, and that a single gateway can unify real-time control, messaging and media streaming behind one hostname.

---

## 2. Objective

The specific objectives of the project are:

1. **Drive the rover wirelessly.** A phone on the same Wi-Fi network shall move the rover forward, backward, left and right, stop it, start/stop a patrol behaviour and return it home.
2. **Stream live video.** The rover's camera feed shall be viewable in the mobile app as an MJPEG stream without a second server process.
3. **Present an expressive face.** Three OLED panels on the rover shall render two animated eyes and a mouth whose expression changes with the rover's state, giving the device a personality instead of an anonymous box.
4. **Raise an audible alarm.** A buzzer shall be triggerable from the app on demand.
5. **Speak.** The rover shall announce its actions in natural-sounding speech, generated from the reply text the app sends.
6. **Report telemetry.** Battery, sensor, threat and health data shall flow to the app over MQTT so the dashboard is always live.
7. **Require zero configuration on the network.** The app shall find the rover automatically by hostname (`cybersentinel.local`) or by a local subnet scan — the user should never have to type an IP address.
8. **Provision in one command.** A single idempotent setup script shall install, configure and verify every dependency on a fresh Raspberry Pi OS image.

---

## 3. Hardware Requirement

### 3.1 Rover side

| # | Component | Specification | Purpose |
|---|-----------|---------------|---------|
| 1 | Raspberry Pi 4 Model B | 4 GB RAM, Raspberry Pi OS Bookworm 64-bit | Gateway: camera, MQTT, REST/WebSocket server, TTS |
| 2 | Arduino Uno R3 | ATmega328P, 16 MHz, 2 KB SRAM, 32 KB flash | Real-time motor, buzzer and display control |
| 3 | Camera Module | OV5647 CSI camera on ribbon cable (`CAM/DISP 0`) | Live video stream |
| 4 | OLED displays × 3 | SH1106 / SSD1306 128×64, monochrome, I²C address `0x3C` | Two eyes + one mouth (robot face) |
| 5 | Motor driver | L298N-type dual H-bridge (IN1–IN4 logic inputs) | Bidirectional drive for the two motors |
| 6 | DC gear motors × 2 | 3–6 V geared motors with wheels | Differential drive (skid steering) |
| 7 | Buzzer | 5 V active/passive piezoelectric buzzer | Audible alarm |
| 8 | Chassis | 2-wheel + caster robot chassis | Mechanical platform |
| 9 | Speaker | USB or 3.5 mm speaker | Text-to-speech output |
| 10 | Power | 5 V/3 A supply for the Pi, separate batteries for motors | Isolated logic and motor rails |
| 11 | microSD card | 16 GB+ Class 10 | Raspberry Pi OS and application |
| 12 | Jumper wires, breadboard/PCB | Male–female and female–female | Interconnections |

### 3.2 Client side

| # | Component | Specification |
|---|-----------|---------------|
| 1 | Android smartphone | Android 10+ with Wi-Fi, microphone and speaker |
| 2 | (Optional) iOS device | iOS 14+ |
| 3 | Wi-Fi network | 2.4 GHz router; rover and phone on the same subnet |

### 3.3 Software requirement

| Layer | Software |
|-------|----------|
| Arduino | Arduino IDE / `arduino-cli`, **U8g2** library (Oliver Kraus) |
| Raspberry Pi OS | Python 3 venv, FastAPI + Uvicorn, `paho-mqtt`, `websockets`, `picamera2`, Mosquitto, Avahi, `espeak-ng`, `alsa-utils`, `ffmpeg`, `v4l-utils` |
| Mobile app | Node.js, Expo / React Native, React Navigation, Zustand, AsyncStorage |
| Cloud (optional) | Groq API (natural-language reply rewriting), TypeSafe JEV (voice classification) |
| Utilities | Git, SSH, `systemd` |

---

## 4. Theory

### 4.1 Cyber-physical system architecture

CyberSentinel is a **cyber-physical system (CPS)**: a physical platform (motors, display, buzzer, optics) tightly coupled to a computational and communication core. It is layered deliberately so that a failure in one layer does not cascade:

```
  ┌───────────────────────┐        ┌──────────────────────────────┐
  │  Android app (Expo)   │        │                                │
  │  Dashboard · Joystick │        │   Raspberry Pi 4  (gateway)    │
  │  Camera · Voice       │◄──Wi-Fi┤                                │
  │  Incidents · Zones    │        │  FastAPI REST      :8000       │
  └───────────┬───────────┘        │  WebSocket control :8765       │
              │                    │  MJPEG stream      :8080       │
              │                    │  MQTT broker       :1883/9001  │
              │                    └───────┬──────────────┬─────────┘
              │                            │ USB serial    │ CSI ribbon
              │                            │ 115200 baud   │
              │                    ┌───────▼──────┐  ┌────▼─────┐
              │                    │ Arduino Uno  │  │ OV5647   │
              │                    │ R3           │  │ camera   │
              │                    └───┬────┬─────┘  └──────────┘
              │                        │    │
              │              H-bridge (D8–D11)  I²C OLEDs + buzzer (D12)
              │                        │
              │                  2 × DC gear motors
              │
        MQTT over WebSocket (ws://<pi>:9001) ── telemetry to app
```

The **Arduino never talks to the network**. It has one job: react to short text commands on the serial line within microseconds and drive pins. The **Pi never touches a motor wire**: it translates high-level intents into those commands. The **app never assumes an IP address**: it resolves the Pi by name.

### 4.2 MQTT — publish/subscribe telemetry

MQTT is a lightweight, broker-mediated messaging protocol built for constrained networks. A client **publishes** a payload to a *topic* and any number of clients **subscribed** to that topic receive it; neither side needs to know the other exists.

* Broker: **Mosquitto** on the Pi.
* Transport to the mobile app: **MQTT over WebSocket** on port 9001 (mobile clients cannot open raw TCP 1883 reliably, and the app already speaks HTTP/WS).
* Topics consumed by the app include `rover/#`, `sensor/#`, `device/health`, `camera/detections`, `rfid/#`, `threat/#` and `incident/#`.

MQTT is used for **state and events** (telemetry, sensor triggers, RFID authorisation). It is deliberately *not* used for motor control: actuator commands need an acknowledged, ordered, low-latency channel, which MQTT's at-most-once delivery does not guarantee.

### 4.3 WebSocket — the control channel

A WebSocket is a single TCP connection upgraded from HTTP that stays open in both directions, so either endpoint may send a message at any instant with no polling. The gateway exposes `ws://cybersentinel.local:8765`.

Each message is a small JSON object with a `cmd` field:

| Command | Payload | Effect |
|---------|---------|--------|
| `MOVE` | `angle` (0–359°), `speed` (0–100) | Direction + speed |
| `STOP` | — | Both motors off |
| `PATROL_START` / `PATROL_STOP` | — | Begin/end autonomous patrol route |
| `RETURN_HOME` | — | Drive back to the start position |
| `BUZZER` | — | Sound the horn |
| `SPEAK` | `text` | Speak a sentence on the Pi's speaker |
| `TTS_STOP` | — | Cancel speech |
| `SET_SPEED` | `speed` | Limit top speed |
| `PING` | — | Liveness check |

The gateway maps a joystick **angle** to a direction with a simple quantiser:

```
angle 0      → FORWARD        angle 180       → BACKWARD
angle 90     → RIGHT          angle 270 / -90 → LEFT
```

and writes `FORWARD`, `BACKWARD`, `LEFT`, `RIGHT`, `STOP` or `BUZZER` as a single newline-terminated line to the Arduino over USB serial at 115200 baud. The app paces joystick frames at 100 ms so the serial line is never flooded.

### 4.4 I²C and why three displays need care

The **Inter-Integrated Circuit (I²C)** bus uses two open-drain lines — SDA (data) and SCL (clock) — plus pull-up resistors, with each device addressed by a 7-bit number. The SH1106/SD1306 OLED breakouts here answer at address `0x3C`.

The Uno has only **one hardware I²C peripheral**, fixed to pins `A4` (SDA) and `A5` (SCL). Driving three panels on one address would be impossible on a single bus, so the design uses:

* the **hardware** I²C bus for the mouth (fastest), and
* **two independent software ("bit-banged") I²C buses** for the eyes, on `D4/D5` and `D6/D7`.

Software I²C simply toggles GPIO lines in the correct sequence, so it costs no peripheral but does consume CPU time and, importantly, **RAM**.

> **Critical implementation detail.** U8g2's software-I²C constructor takes its arguments in the order `(rotation, clock/SCL, data/SDA, reset)` — *clock before data*. Wiring them in the intuitive `SDA, SCL` order produces panels that initialise but show nothing (the "black screen" fault).

> **Critical memory detail.** A full 128×64 monochrome frame buffer is 1 KB; the Uno has only 2 KB of SRAM in total, so three full-buffer (`_F_`) U8g2 objects cannot fit (the compiler reports *"Global variables use 2209 bytes (107%)"*). The firmware therefore uses **page-mode** drivers (`_1_`), which need only a 128-byte page buffer, and U8g2 reuses that single buffer across all page-mode displays. Three separate `u8g2_t` structures still cost roughly 490 bytes each, which is why the two eyes own separate objects only because they must sit on different pin pairs.

### 4.5 H-bridge motor drive

A DC motor reverses when the polarity of its supply is swapped, which a microcontroller pin cannot do directly. An **H-bridge** (four switches around the motor, here inside an L298N-type driver) allows polarity control from logic inputs. Each side of the rover has one channel:

* `IN1`,`IN2` control the left motor, `IN3`,`IN4` the right motor.
* `HIGH/LOW` drives one way, `LOW/HIGH` the other, `LOW/LOW` coasts to a stop.
* **Differential (skid) steering:** running the left side forward and the right side backward rotates the rover on the spot — this is how turning is implemented without a steering servo.

### 4.6 MJPEG streaming

**Motion JPEG** is a sequence of complete JPEG images delivered over one long-lived HTTP response with the `multipart/x-mixed-replace` content type. Each frame is a self-contained image, so a browser or player simply replaces the picture as frames arrive. It is heavier than H.264 but needs no decoder negotiation, which makes it ideal for a hobby rover.

The gateway captures frames with **Picamera2** (the modern libcamera-based Python API for the Pi's CSI camera) and re-serves them itself on port 8080, along with a `/snapshot.jpg` still and a small HTML preview page. Because the gateway owns the stream, there is no second camera service to start, supervise or lose.

### 4.7 Service discovery

Requiring the user to type an IP address is fragile: DHCP changes it. Instead:

1. the app probes the last known address,
2. then resolves **`cybersentinel.local`** via **mDNS** (multicast DNS, served by Avahi on the Pi), and
3. finally scans the phone's own `/24` subnet for any host answering `GET /health` on port 8000.

The address is persisted and re-resolved whenever the Wi-Fi network changes.

### 4.8 Speech and natural-language replies

The voice pipeline has three stages:

1. **Speech-to-text** happens on the phone (native Android/iOS recognisers via `expo-speech-recognition`).
2. **Intent classification** is done by **JEV** (TypeSafe's System One decision model), which returns a *typed* decision — which action, whether it is a command, whether it is safety-critical, and how fast — with calibrated confidence. JEV is a decision model, **not** a language model: it cannot write prose, so the app builds the spoken reply from deterministic templates (e.g. *"Rolling forward at 60 percent."*).
3. **Wording** is optionally rewritten by a large language model hosted on **Groq** (OpenAI-compatible chat-completions API, reached with the Python standard library, no extra dependency). The model is constrained by a system prompt to produce **one sentence of at most 22 words, changing only the wording and never adding, removing or altering a fact**, so it can sound human but cannot invent a battery reading. Every error path — no key, no network, timeout, oversized or malformed output — falls back to speaking the template verbatim, and the call runs in a worker thread so it can never stall the gateway's event loop. The reply's `source` field reports `groq` or `template`.

The finished sentence travels back over the control WebSocket as a `SPEAK` command; the app only falls back to its own speaker if the Pi is unreachable.

### 4.9 Reliability: supervision and self-check

Two lessons shaped the runtime design:

* **Background tasks must not die silently.** Each long-lived asyncio task (WebSocket server, serial reader, health publisher) is started through a helper that attaches a done-callback printing `[boot] <name> FAILED: …` plus a traceback. Previously a task could raise on startup and vanish while the REST server kept answering — which looks exactly like "the rover is up but nothing works".
* **Config must be validated against reality.** The provisioning script starts and restarts services, but "systemd says running" only proves the process launched. A gateway `--check` mode therefore prints the version, speaker engine, resolved camera source, serial port, MQTT status and listening ports and exits without binding anything — a fast, side-effect-free diagnostic.

---

## 5. Connections

### 5.1 Arduino Uno R3

| From (Uno) | To (device) | Notes |
|------------|-------------|-------|
| `D8` | H-bridge `IN1` | Left motor, forward |
| `D9` | H-bridge `IN2` | Left motor, reverse |
| `D10` | H-bridge `IN3` | Right motor, forward |
| `D11` | H-bridge `IN4` | Right motor, reverse |
| `D12` | Buzzer `+` (buzzer `−` → GND) | `tone()` at 1200 Hz |
| `A4` (SDA) | **Mouth** OLED `SDA` | Hardware I²C |
| `A5` (SCL) | **Mouth** OLED `SCL` | Hardware I²C |
| `D4` | **Left eye** OLED `SDA` | Software I²C |
| `D5` | **Left eye** OLED `SCL` | Software I²C |
| `D6` | **Right eye** OLED `SDA` | Software I²C |
| `D7` | **Right eye** OLED `SCL` | Software I²C |
| `5V` / `GND` | OLED `VCC` / `GND`, H-bridge logic `VCC` | Common ground is mandatory |
| USB `B` | Raspberry Pi USB `A` | Serial @ 115200 baud, powers the Uno |
| H-bridge `OUT1/OUT2` | Left motor terminals | — |
| H-bridge `OUT3/OUT4` | Right motor terminals | — |
| H-bridge `VCC(motor)` | Motor battery + | Separate motor supply |

> All three OLEDs use I²C address `0x3C` — they can share one bus only because each eye is on its *own* bus. Each panel needs its own 3.3–5 V supply and ground; the firmware sets the bus clock to 100 kHz for all three.

### 5.2 Raspberry Pi 4

| Pi | Connects to | Notes |
|----|-------------|-------|
| CSI camera port | OV5647 ribbon cable | `CAM/DISP 0`; `camera_auto_detect=1` in `/boot/firmware/config.txt` |
| USB-A | Arduino Uno | Appears as `/dev/ttyACM0`; user in the `dialout` group |
| 3.5 mm / USB | Speaker | ALSA default output |
| Wi-Fi (wlan0) | Router | Phone on the same subnet |
| microSD | Raspberry Pi OS | Bookworm 64-bit |

Network ports exposed by the Pi:

| Port | Protocol | Purpose |
|------|----------|---------|
| 8000 | HTTP | REST API + discovery `/health` |
| 8765 | WebSocket | Rover commands and `SPEAK` |
| 1883 | MQTT/TCP | Broker (local tools, gateway) |
| 9001 | MQTT/WebSocket | Broker endpoint used by the app |
| 8080 | HTTP | MJPEG camera stream, snapshot, preview page |

Serial link detail: the gateway opens the serial port at **115200 baud, 8N1** and writes one command per line (`FORWARD\n`); the Arduino replies with one JSON object per line (`{"topic":"device/health","value":{"arduino":"online"}}`).

---

## 6. Code

The project is organised as four cooperating programs.

### 6.1 `arduino.cpp` — the rover's reflex layer

* Declares three U8g2 page-mode display objects: two `SW_I2C` (eyes) and one `HW_I2C` (mouth), all at address `0x3C*2`, 100 kHz.
* `scanHardwareI2C()` walks addresses `0x01–0x7E` at boot and logs every device that answers, separating *wrong wiring* from *wrong address*.
* `drawEye()` renders one eye: an inward- or outward-pointing chevron (`<` for the left eye, `>` for the right, controlled by a `pointsRight` flag), a moving pupil, and a blink state drawn as three stacked lines. `drawMouth()` renders five expressions (Happy, Normal, Surprised, Sleepy, Sad) plus a talking animation.
* `updateFace()` is called every **250 ms** from `loop()`; it cycles the expression every 4 s, shifts the pupils every 900 ms and blinks every 3 s.
* Motor functions are one-liners over `setMotor()`:
  ```cpp
  void moveForward()  { setMotor(HIGH, LOW,  HIGH, LOW ); roverState = "FORWARD";  }
  void moveBackward() { setMotor(LOW,  HIGH, LOW,  HIGH); roverState = "BACKWARD"; }
  void moveLeft()     { setMotor(LOW,  HIGH, HIGH, LOW ); roverState = "LEFT";     }
  void moveRight()    { setMotor(HIGH, LOW,  LOW,  HIGH); roverState = "RIGHT";    }
  void stopMotors()   { setMotor(LOW,  LOW,  LOW,  LOW ); roverState = "IDLE";     }
  ```
* `pollSerial()` is a non-blocking, fixed-size reader (a 16-byte `char` buffer, no Arduino `String`) that splits input on `\r`/`\n` and dispatches through `handleCommand()`, which compares against flash-resident literals with `strcmp_P(command, PSTR("FORWARD"))`.
* The buzzer is **non-blocking**: `tone(BUZZER_PIN, 1200)` sets a deadline, and `loop()` calls `noTone()` when the deadline passes, so the face keeps animating while the horn sounds.
* Telemetry is hand-written JSON via `Serial.print` (ArduinoJson would cost RAM the sketch does not have) and a heartbeat is emitted every 2 s.

### 6.2 `gateway.py` — the Raspberry Pi brain

A single FastAPI process (v1.7.0) that owns every Pi-side service:

* **`Config`** reads all settings from the environment (`CS_*` variables) with sane defaults: ports, serial baud, camera source, TTS engine/voice, Groq key/model/timeout, mDNS toggle.
* **`MotorBus`** discovers the serial port (`auto` probes `/dev/ttyACM*` first, then `/dev/ttyUSB*`), reconnects automatically after a replug, and `direction_for_angle()` quantises a joystick angle into a direction word.
* **`CameraManager`** resolves `auto` → picamera → external → usb, drives Picamera2's MJPEG encoder, and serves `/stream.mjpg`, `/snapshot.jpg` and `/` from its own threaded HTTP server on 8080. It supervises and restarts the capture whenever the stream dies.
* **`Speaker`** auto-detects `piper` → `espeak-ng` → `espeak` → `spd-say`, resolves a female espeak variant (`en+f3`, falling back through several options), and drains its output queue in a worker thread.
* **`ReplyWriter`** implements the Groq stage described in §4.8: `_request()` POSTs to `https://api.groq.com/openai/v1/chat/completions` via `urllib.request`, `natural()` runs it with `asyncio.to_thread`, and `_clean()` strips quotes and rejects over-long output.
* **`handle_command()`** implements the WebSocket control protocol, and the FastAPI routes expose `/health`, `/camera/status`, `/camera/record`, `/camera/nightmode`, `/speak`, `/voice/status`, `/sensors/latest`, `/rover/status` and `/devices/health`.
* A background `read_arduino_serial()` task parses the Uno's JSON lines and republishes them as MQTT `device/health` / `device/log` messages; `publish_health_loop()` emits periodic status.
* **`--check`** mode and the `_spawn()` startup breadcrumbs (see §4.9) make failures visible instead of silent.

### 6.3 `pi/setup.sh` — one-command provisioning

An idempotent Bash script that installs core packages (venv, Mosquitto, Avahi, espeak-ng, ALSA, ffmpeg, v4l-utils), installs `python3-picamera2` **separately and non-fatally** (so a camera-less Pi still provisions), configures a Mosquitto WebSocket listener on 9001, deploys the gateway and its systemd unit to `/opt/cybersentinel`, and then **verifies**: version match, `/health`, camera stream byte count, a real `PING`/`STOP` round-trip on the control socket, the `dialout` group membership of the running process, and the presence of the Groq key. It frees stale gateway processes from ports 8000/8765/8080 without ever killing an unrelated port holder, and wraps camera probes in `timeout` so a wedged `rpicam-hello` cannot hang the install.

### 6.4 The mobile application (`src/`)

| Module | Responsibility |
|--------|----------------|
| `services/roverLink.ts` | Control WebSocket; `sendRoverCommand()`, `createJoystickSender()` (100 ms pacing) |
| `services/mqtt.ts` | MQTT over WebSocket; subscribes to all rover/sensor/threat topics |
| `services/api.ts` | FastAPI REST client |
| `services/voice.ts` | STT → JEV classification → action dispatch → `speakReply()` |
| `services/demoEngine.ts` | Simulates the full rover stream so the UI runs with no hardware |
| `store/settings.ts`, `store/rover.ts` | Persisted settings (incl. `streamPort` = 8080) and live state |
| `screens/` | Dashboard, Control, Camera, Incidents, Zone Map, Threat Center, Settings |
| `components/` | Joystick pad, stream view, gauges, incident rows, RFID modal, voice control |

The app ships with **Demo Mode on by default**, so the entire interface — including the PRD's threat-escalation script — can be evaluated before any hardware exists.

---

## 7. Execution Steps

### Step 1 — Flash and wire the Arduino

1. Install the **U8g2** library (Library Manager → "U8g2" by Oliver Kraus).
2. Flash `arduino.cpp` to the Uno (Arduino IDE, or `sudo bash pi/flash-arduino.sh` from the Pi).
3. Wire per §5.1: motors → H-bridge → `D8–D11`, buzzer → `D12`, mouth → `A4/A5`, left eye → `D4/D5`, right eye → `D6/D7`.
4. Connect the Uno to the Pi with a USB cable.

### Step 2 — Prepare the Raspberry Pi

1. Flash Raspberry Pi OS (Bookworm, 64-bit) to the microSD card and boot.
2. Ensure `camera_auto_detect=1` is present in `/boot/firmware/config.txt` and the CSI ribbon is seated in `CAM/DISP 0` with the contacts facing the board.
3. Connect the speaker and power the Pi.

### Step 3 — Provision

```bash
git clone <repo> cybersentinel && cd cybersentinel
sudo bash pi/setup.sh
```

The script installs and configures everything, enables the `cybersentinel-gateway`, `mosquitto` and `avahi-daemon` services for boot, and ends with a self-check. Re-run it any time after a `git pull` — it is idempotent.

### Step 4 — Configure (optional)

```bash
sudo nano /opt/cybersentinel/gateway.env     # CS_TTS_*, CS_CAMERA_*, CS_GROQ_*
sudo systemctl restart cybersentinel-gateway
```

### Step 5 — Verify the rover

```bash
curl -s http://cybersentinel.local:8000/health          # version, speaker, camera, serial
/opt/cybersentinel/venv/bin/python gateway.py --check   # side-effect-free diagnostic
curl -s http://cybersentinel.local:8000/camera/status
ffplay http://cybersentinel.local:8080/stream.mjpg      # live video
espeak-ng "CyberSentinel online"                        # speaker
```

### Step 6 — Run the mobile app

```bash
cd <repo>
npm install
npx expo start          # scan the QR code with Expo Go (Android 10+)
```

> Voice control needs a **development build** (`npx expo run:android`) because it uses native speech recognisers; everything else runs in Expo Go.

### Step 7 — Operate

1. Put the phone on the same Wi-Fi as the rover. Turn **Demo Mode off** in Settings; the app finds the Pi automatically (`cybersentinel.local` or a subnet scan).
2. **Dashboard** — live telemetry, sensor tiles, incident feed.
3. **Control** — drive with the joystick, stop, patrol, return home, sound the buzzer.
4. **Camera** — live MJPEG with detection overlays; reload, rotate, zoom, 15 s record, night mode.
5. **Voice** — tap the mic and say *"patrol the front yard"*, *"back up slowly"*, or *"what's the status?"*. JEV classifies it, the rover obeys, and the Pi speaks the reply.
6. **Admin** — tapping an admin-gated control raises the RFID modal; scan the card at the rover to unlock an admin session for 15/30/60 minutes.

### Step 8 — Cold-boot check

Power-cycle everything. All services are enabled at boot, so the rover should come back with no login and no manual start: face animated, camera streaming, control socket accepting commands.

---

## 8. Conclusion

CyberSentinel demonstrates that a genuinely capable security rover — one that drives, sees, senses, alarms, speaks and even has a face — can be built from an Arduino Uno, a Raspberry Pi 4, three small OLED panels and a phone, with no custom PCB and no cloud dependency for its core function.

The project's most valuable lessons were not about any single component but about **interfaces and failure modes**:

* **Layer separation pays off.** Because the Arduino only ever sees six text commands on a serial line, the entire face and memory redesign — swapping display drivers, moving panels between hardware and software I²C, changing the eye design — never touched motor control. Because the app only ever sees one WebSocket URL, it did not have to change when the camera backend moved from `ffmpeg` to Picamera2.
* **Constrained hardware forces good engineering.** Fitting three displays and a hand-written serial protocol into the Uno's 2 KB of SRAM required page-buffered drivers and flash-resident string literals. A design that "compiled" at 107 % of RAM would never have shipped; the budget *is* the design.
* **Silent failure is the real enemy.** A background asyncio task dying quietly, a camera probe printed to the wrong stream, a duplicate Mosquitto config file, a service the init system reports as "running" while it crash-loops — each cost more debugging time than any algorithm. The response — startup breadcrumbs with tracebacks, a side-effect-free `--check` mode, and a provisioning script that verifies each link (stream bytes, a real socket round-trip, group membership) rather than assuming success — is arguably the most reusable part of the project.
* **AI belongs where it is reliable.** Using a decision model (JEV) on the phone for classification, and an LLM (Groq) only to *reword* an already-correct sentence, keeps correctness deterministic while still producing speech that sounds human. The language model is instructed never to alter a fact and is given no sensor data to hallucinate about; if it fails, the template is spoken verbatim.

**Scope for improvement:** add real PIR and gas sensors so those dashboard tiles are genuinely live; integrate RFID hardware so the admin flow is physical rather than simulated; replace the buzzer with a two-way audio link; add odometry or IMU feedback for closed-loop patrol and return-home; and enable Mosquitto authentication before the broker is ever exposed beyond an isolated rover network.

In short, the aim — a phone-controlled, self-contained, expressive security rover on a hobbyist budget — was met, and the architecture that delivered it is simple enough to explain in one diagram and robust enough to survive a power cycle.
