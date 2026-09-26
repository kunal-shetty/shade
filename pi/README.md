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

## 4. Camera (optional)

The app expects an MJPEG stream on port 8080. A minimal ffmpeg server:

```bash
# /etc/systemd/system/cybersentinel-camera.service
[Unit]
Description=CyberSentinel MJPEG stream
After=network-online.target

[Service]
ExecStart=/usr/bin/ffmpeg -nostdin -f v4l2 -framerate 20 -video_size 640x480 \
  -i /dev/video0 -f mpjpeg -listen 1 -headers "Access-Control-Allow-Origin: *" \
  http://0.0.0.0:8080/stream.mjpg
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now cybersentinel-camera
```

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
| 8080 | HTTP | MJPEG camera stream |

> Anonymous Mosquitto access is enabled for the isolated rover network. Add
> authentication before putting the broker on a shared network.
