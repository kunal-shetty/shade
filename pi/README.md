# Raspberry Pi setup

Everything the rover needs to work with the phone app. The only requirement at
runtime is that **the Pi and the phone are on the same WiFi** — the app finds
the Pi automatically.

## 1. Provision

On a fresh Raspberry Pi OS (Bookworm, 64-bit):

```bash
git clone <your-repo> cybersentinel && cd cybersentinel
sudo bash pi/setup.sh
```

`setup.sh` is idempotent — re-run it any time (e.g. after `git pull`) and it will
redeploy and restart everything. It installs and configures:

| Component | Purpose |
|-----------|---------|
| Python venv + gateway deps | the FastAPI gateway |
| `mosquitto` (+ websockets listener) | MQTT for the app |
| `avahi-daemon` / `libnss-mdns` | `cybersentinel.local` |
| `espeak-ng` + `alsa-utils` | the speaker |
| `ffmpeg` + `v4l-utils` | the camera stream (supervised by the gateway) |
| `cybersentinel-gateway` systemd unit | runs the gateway |

### Boot behaviour

All three services are `systemctl enable`d, so a power cycle brings everything
back with no login and no manual start:

| Service | Starts on boot |
|---------|----------------|
| `cybersentinel-gateway` | yes — cameras, MQTT client, WebSocket, REST, speaker |
| `mosquitto` | yes |
| `avahi-daemon` | yes |

The camera has **no service of its own**: the gateway spawns and supervises the
`ffmpeg` MJPEG server, and restarts it whenever the stream dies or the camera is
replugged. One service to enable, one thing to debug.

### Verifying a deploy

`setup.sh` finishes with a self-check. It prints the version of the
`gateway.py` it deployed and the live state reported by `/health`:

```
==> Verifying the gateway on port 8000
    [ok] version : 1.1.0
    [ok] speaker : espeak-ng
    [--] camera  : offline - /dev/video0 not present
    [--] arduino : offline
```

A stale clone is called out explicitly (`MISSING - the deployed gateway.py is
stale`), which is the usual reason a fix "didn't work" after re-running setup:
`git pull` first, then re-run.

Check it by hand:

```bash
curl http://cybersentinel.local:8000/health
curl http://cybersentinel.local:8000/camera/status
systemctl is-enabled cybersentinel-gateway mosquitto avahi-daemon
journalctl -u cybersentinel-gateway -f
```

## 2. Speaker

Any USB or 3.5 mm speaker on the Pi's default ALSA output works.

```bash
speaker-test -t sine -f 440 -l 1     # confirm audio out
espeak-ng "CyberSentinel online"     # confirm TTS
```

The gateway auto-detects `piper` → `espeak-ng` → `espeak` → `spd-say`. Force one
with `CS_TTS_ENGINE` in `/opt/cybersentinel/gateway.env`, then
`sudo systemctl restart cybersentinel-gateway`.

### Making it sound friendlier

The default voice is deliberately light, cheerful and **female** — espeak's bare
language codes (`en`) select its male voice, so the `+f*` variant matters:

```bash
CS_TTS_VOICE=en+f3    # base language + espeak variant; f1..f5 = female, m1..m7 = male
CS_TTS_PITCH=70       # 0-99: ~50 neutral, ~70 cheerful, ~85 cartoonish
CS_TTS_RATE=165       # words per minute
```

If your espeak build does not have the variant you asked for, the gateway tries
`en+f3`, `en+f4`, `en+f2`, `en-us+f3` and `en+f1` in turn, and only then drops to
the base language (logging that it may sound male). Speaking at all still beats
going silent. Check what it settled on:

```bash
curl -s http://cybersentinel.local:8000/health | grep -o '"speaker":[^,]*'
curl -s http://cybersentinel.local:8000/voice/status
```

The on-screen wording is cheerful too, and replies rotate between a few
phrasings so repeated commands don't sound identical.

For a much more natural voice, install [piper](https://github.com/rhasspy/piper)
and point `CS_PIPER_MODEL` at a `.onnx` voice model. Piper's neural voices are
far less robotic than espeak, and it takes precedence over espeak when both are
present. Female models worth trying: `en_US-lessac-medium`,
`en_US-amy-medium`, `en_GB-jenny_dioco-medium`.

The app sends replies over the existing WebSocket as `{ "cmd": "SPEAK", "text": "…" }`,
so no extra ports are needed. You can also test it directly:

```bash
curl -X POST http://cybersentinel.local:8000/speak \
  -H 'Content-Type: application/json' -d '{"text":"Speaker check"}'
```

## 3. Arduino

Flash `arduino.cpp` (install the `ArduinoJson` library), then connect it over
USB. The gateway reconnects to the serial port automatically, so replugging the
Arduino does not require a restart.

```bash
ls /dev/ttyUSB* /dev/ttyACM*          # see what is attached
```

`CS_SERIAL_PORT` defaults to `auto`, which probes `/dev/ttyACM*` first (a
genuine Uno R3 uses the CDC-ACM driver and shows up as `/dev/ttyACM0`) and then
`/dev/ttyUSB*` (CH340/CP2102 clones). You only need to set it if you want to
pin one specific device:

```bash
# CS_SERIAL_PORT=/dev/ttyACM0   # in /opt/cybersentinel/gateway.env
```

The service user must be in the `dialout` group to open either node — `setup.sh`
adds the login user automatically. If the app still shows the Arduino offline,
check `GET /health`: its `serial` block names the port the gateway tried and the
exact error (`permission denied`, `device busy`, …).

```bash
curl -s http://127.0.0.1:8000/health | python3 -m json.tool | grep -A3 '"serial"'
```

The Arduino drives the motors from `FORWARD` / `BACKWARD` / `LEFT` / `RIGHT` /
`STOP` / `BUZZER` lines and reports the reed switch on `sensor/door`.

### OLED status displays

Three SSD1306 panels are driven directly from the Uno:

| Display | Power | Wiring | Bus |
|---------|-------|--------|-----|
| OLED 1 | 3.3 V | `A4` = SDA, `A5` = SCL | hardware I2C |
| OLED 2 | 5 V | `D4` = SDA, `D5` = SCL | software I2C |
| OLED 3 | 5 V | `D6` = SDA, `D7` = SCL | software I2C |

Install the **U8g2** library (Library Manager → "U8g2" by Oliver Kraus) as well
as **ArduinoJson**. Both are required — the sketch will not compile without them.

What each panel shows:

* **OLED 1** — rover state (`IDLE` / `FORWARD` / …), command count, uptime, error count
* **OLED 2** — door open/closed, the raw reed reading, and whether OLED 2/3 initialised
* **OLED 3** — last command, error count, and the last error text

The sketch uses U8g2's *page-buffered* drivers (`..._128X64_NONAME_1_...`). A
full-frame buffer is 1 KB and three of them would overflow the Uno's 2 KB of
SRAM, so do not switch these to the `_F_` variants. If your panels are 128x32,
change `128X64` to `128X32` in the three constructor lines.

> **OLED 1 on 3.3 V:** the Uno's `A4`/`A5` lines idle at 5 V, so the panel sees
> 5 V logic even when powered from 3.3 V. Most breakouts tolerate that. If OLED 1
> stays blank while 2 and 3 work, power it from 5 V too or add a level shifter.

### Reading the Arduino's own errors

The sketch reports problems it can see — a display that did not answer, an
unknown command, telemetry that did not fit its JSON buffer — as
`device/log` lines. The gateway prints them into the service journal:

```bash
journalctl -u cybersentinel-gateway -f | grep '\[arduino'
# [arduino/error] OLED2 (D4/D5) not detected
# [arduino/info] arduino ready, oleds 1-3
```

At boot the sketch also scans the hardware I2C bus and logs every address that
answered, which separates "wrong wiring" from "wrong I2C address".

### Known gaps

The Arduino firmware only publishes `sensor/door`, `device/health` and
`device/log`. The `pir_node` and `gas_node` tiles have no publisher, so they stay
online only if something else emits `sensor/pir` and `sensor/gas`.

## 4. Camera

The gateway **serves the MJPEG stream itself** on port 8080 — there is no
separate camera service to enable, and it survives a camera being unplugged or
replugged. Whatever hardware you have, the app always consumes the same URL:

```
http://cybersentinel.local:8080/stream.mjpg
```

### Pick a source

Set `CS_CAMERA_SOURCE` in `/opt/cybersentinel/gateway.env`, then
`sudo systemctl restart cybersentinel-gateway`.

| Value | Use when | Needs |
|-------|----------|-------|
| `auto` (default) | you don't care — it probes | — |
| `picamera` | **CSI Camera Module** (the ribbon cable) | `python3-picamera2` |
| `usb` | USB webcam | `ffmpeg`, `/dev/video0` |
| `external` | you already run your own MJPEG server | `CS_CAMERA_EXTERNAL_URL` |
| `off` | no camera | — |

`auto` resolves in this order: **picamera → external → usb**.

#### CSI Camera Module (Picamera2)

This is the usual Raspberry Pi setup, with the module on the **ribbon cable**.
`setup.sh` installs `python3-picamera2`, enables `camera_auto_detect`, and builds
the venv with `--system-site-packages` (picamera2 is an apt package, so a normal
venv cannot import it). The gateway drives it through Picamera2's own MJPEG
encoder — no OpenCV needed.

```bash
# 1. Does the sensor work at all, below our code? Must list a camera.
rpicam-hello --list-cameras
rpicam-hello -t 2000

# 2. Does the venv see it? Must print a non-zero count.
/opt/cybersentinel/venv/bin/python -c \
  'from picamera2 import Picamera2; print(Picamera2.global_camera_info())'

# 3. What does the gateway think?
curl -s http://cybersentinel.local:8000/camera/status | python3 -m json.tool
```

If step 1 finds nothing, it is not a gateway problem — check that
`camera_auto_detect=1` is set in `/boot/firmware/config.txt` (older Raspberry Pi
OS: `/boot/config.txt`), that the ribbon is seated in the `CAM/DISP 0` port with
the metal contacts facing the board, and then reboot.

`GET /health` carries a `camera_info` block with the resolved source, port and a
plain-English `detail` string, so you can tell "no sensor" from "port already in
use" without guessing.

#### Already running your own camera server

If you keep a Flask/Picamera2 script like this:

```python
# ... camera.capture_array() ... cv2.imencode(".jpg", frame) ...
app.run(host="0.0.0.0", port=5000, threaded=True)
```

you don't have to remove it. Point the gateway at it and the app keeps using
port 8080, so nothing in the app changes:

```bash
CS_CAMERA_SOURCE=external
CS_CAMERA_EXTERNAL_URL=http://127.0.0.1:5000/video
```

The gateway proxies those frames, adds `/snapshot.jpg`, and reports online/
offline for you. Do **not** point `external` at the gateway's own 8080 — that
would loop back on itself.

### Endpoints

```bash
curl -s http://cybersentinel.local:8000/camera/status     # online, source, detail
curl -s http://cybersentinel.local:8080/stream.mjpg       # the live stream
curl -s http://cybersentinel.local:8080/snapshot.jpg -o shot.jpg
ffplay  http://cybersentinel.local:8080/stream.mjpg       # view in a player
```

A plain browser visit to `http://cybersentinel.local:8080/` shows a preview page.

### Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `CS_CAMERA_ENABLE` | `1` | Serve the stream at all |
| `CS_CAMERA_SOURCE` | `auto` | Backend selection (above) |
| `CS_CAMERA_EXTERNAL_URL` | _(unset)_ | Upstream MJPEG URL for `external` |
| `CS_CAMERA_DEVICE` | `/dev/video0` | Capture device for `usb` |
| `CS_CAMERA_SIZE` / `CS_CAMERA_FPS` | `640x480` / `20` | Resolution and rate |
| `CS_CAMERA_ROTATE` | `0` | `90`/`180`/`270` for upside-down mounts (`usb` only) |
| `CS_CAMERA_NIGHT_CTRL` | _(unset)_ | v4l2 control for hardware night mode (`usb` only) |
| `CS_RECORD_DIR` | `/opt/cybersentinel/recordings` | Where 15 s clips are saved |

### App controls

* **Record 15 s** → `POST /camera/record` writes an `.mkv` into `CS_RECORD_DIR`.
  It records by reading the live stream back over HTTP, so it never fights the
  capture device for exclusive access.
* **Night mode** → `POST /camera/nightmode`. For `picamera` it adjusts
  Brightness/Contrast/Saturation live; for `usb` it applies the low-light `eq`
  filter (and `CS_CAMERA_NIGHT_CTRL` if set). The response says whether the
  active source supports it.
* **Screenshot** / **Zoom** are client-side.

If there is no camera, `/camera/status` explains why in `detail` and the app
shows a "Camera offline" overlay instead of a broken feed.

## 5. How the phone finds the Pi

1. The app probes the address in Settings.
2. It then tries `cybersentinel.local` (Avahi).
3. Finally it scans its own `/24` subnet for a gateway answering
   `GET /health` on port 8000.

Once found, the address is saved and re-resolved whenever the WiFi network
changes. No IP address entry is required as long as the hostname is
`cybersentinel` (set by `setup.sh`).

## Ports

| Port | Protocol | Purpose |
|------|----------|---------|
| 8000 | HTTP | REST API + discovery health check |
| 8765 | WebSocket | Rover commands **and `SPEAK` for the speaker** |
| 1883 | MQTT/TCP | Broker (CLI tools, gateway) |
| 9001 | MQTT/WebSocket | Broker endpoint used by the app |
| 8080 | HTTP | MJPEG camera stream (served by the gateway) |

> Anonymous Mosquitto access is enabled for the isolated rover network. Add
> authentication before putting the broker on a shared network.
