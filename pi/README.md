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

This installs Mosquitto (with a websockets listener), Avahi (mDNS), espeak-ng,
ffmpeg, and runs the gateway as `cybersentinel-gateway`.

Check it:

```bash
curl http://cybersentinel.local:8000/health
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

For a much more natural voice, install [piper](https://github.com/rhasspy/piper)
and point `CS_PIPER_MODEL` at a `.onnx` voice model.

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
ls /dev/ttyUSB* /dev/ttyACM*          # find the port
# set CS_SERIAL_PORT in /opt/cybersentinel/gateway.env if it is not /dev/ttyUSB0
```

The Arduino drives the motors from `FORWARD` / `BACKWARD` / `LEFT` / `RIGHT` /
`STOP` / `BUZZER` lines and reports the reed switch on `sensor/door`.

## 4. Camera

The MJPEG stream on port 8080 is **served by the gateway itself** — there is no
separate service to install. It supervises `ffmpeg` and restarts it if the
camera is unplugged or the stream dies.

```bash
curl -s http://cybersentinel.local:8000/camera/status
# {"online":true,"device":"/dev/video0","stream_url":"...",...}

# Open the stream yourself
ffplay http://cybersentinel.local:8080/stream.mjpg
```

Configuration (in `/opt/cybersentinel/gateway.env`, then
`sudo systemctl restart cybersentinel-gateway`):

| Variable | Default | Purpose |
|----------|---------|---------|
| `CS_CAMERA_ENABLE` | `1` | Serve the stream at all |
| `CS_CAMERA_DEVICE` | `/dev/video0` | Capture device |
| `CS_CAMERA_SIZE` / `CS_CAMERA_FPS` | `640x480` / `20` | Capture resolution and rate |
| `CS_CAMERA_ROTATE` | `0` | `90`/`180`/`270` for upside-down mounts |
| `CS_CAMERA_NIGHT_CTRL` | _(unset)_ | v4l2 control for hardware night mode, e.g. `exposure_auto=1` |
| `CS_RECORD_DIR` | `/opt/cybersentinel/recordings` | Where 15 s clips are saved |

App controls:

* **Record 15 s** → `POST /camera/record` writes an `.mkv` into `CS_RECORD_DIR`.
  It records by reading the live MJPEG stream back over HTTP, so it never
  fights the capture device for `/dev/video0`.
* **Night mode** → `POST /camera/nightmode` applies `CS_CAMERA_NIGHT_CTRL` (if
  set) and/or restarts the stream with a low-light `eq` filter.
* **Screenshot** / **Zoom** are client-side.

If you have no camera module, set `CS_CAMERA_ENABLE=0`; the app then shows
"Camera offline" instead of a broken feed.

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
