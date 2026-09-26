"""
CyberSentinel rover gateway — runs on the Raspberry Pi 4.

Bridges the phone app to the hardware:
  * WebSocket  :8765  rover commands (STOP / MOVE / PATROL / BUZZER / SPEAK …)
  * HTTP       :8000  REST API (health, sensors, incidents, alarm, camera)
  * MQTT       :1883  telemetry fan-out (Mosquitto, websockets listener enabled)
  * Serial     USB    Arduino motor + reed switch node
  * Speaker    GPIO/USB text-to-speech (espeak-ng / piper)

Everything is zero-config: the phone discovers this Pi on the shared WiFi via
mDNS (`cybersentinel.local`) or a subnet scan of the gateway's HTTP health
endpoint, so both devices only need to be on the same network.

Run:  python3 gateway.py
Env:  see CONFIG below (all optional).
"""

from __future__ import annotations

import asyncio
import json
import os
import queue
import shutil
import subprocess
import tempfile
import threading
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

try:
    import serial  # pyserial
except ImportError:  # pragma: no cover - optional at import time
    serial = None

try:
    import psutil
except ImportError:  # pragma: no cover
    psutil = None

try:
    import websockets
except ImportError:  # pragma: no cover
    websockets = None

try:
    from paho.mqtt import client as mqtt_client
except ImportError:  # pragma: no cover
    mqtt_client = None

try:
    from zeroconf import ServiceInfo, Zeroconf
except ImportError:  # pragma: no cover
    Zeroconf = None


# ---------------------------------------------------------------------------
# CONFIG
# ---------------------------------------------------------------------------

@dataclass
class Config:
    mqtt_broker: str = os.getenv("CS_MQTT_BROKER", "localhost")
    mqtt_port: int = int(os.getenv("CS_MQTT_PORT", "1883"))
    ws_port: int = int(os.getenv("CS_WS_PORT", "8765"))
    api_port: int = int(os.getenv("CS_API_PORT", "8000"))
    serial_port: str = os.getenv("CS_SERIAL_PORT", "/dev/ttyUSB0")
    serial_baud: int = int(os.getenv("CS_SERIAL_BAUD", "115200"))
    tts_engine: str = os.getenv("CS_TTS_ENGINE", "auto")  # auto | espeak-ng | espeak | spd-say | none
    tts_voice: str = os.getenv("CS_TTS_VOICE", "en")
    tts_rate: int = int(os.getenv("CS_TTS_RATE", "165"))
    piper_model: str = os.getenv("CS_PIPER_MODEL", "")  # e.g. /opt/piper/en_US-lessac-medium.onnx
    hostname: str = os.getenv("CS_HOSTNAME", "cybersentinel")
    enable_mdns: bool = os.getenv("CS_ENABLE_MDNS", "1") != "0"
    incident_store: Path = Path(os.getenv("CS_INCIDENT_STORE", "incidents.json"))
    # Camera / MJPEG stream
    camera_enable: bool = os.getenv("CS_CAMERA_ENABLE", "1") != "0"
    camera_device: str = os.getenv("CS_CAMERA_DEVICE", "/dev/video0")
    camera_port: int = int(os.getenv("CS_CAMERA_PORT", "8080"))
    camera_size: str = os.getenv("CS_CAMERA_SIZE", "640x480")
    camera_fps: int = int(os.getenv("CS_CAMERA_FPS", "20"))
    camera_rotate: str = os.getenv("CS_CAMERA_ROTATE", "0")  # 0 | 90 | 180 | 270
    # Optional v4l2 control applied for night mode, e.g. "exposure_auto=1"
    camera_night_ctrl: str = os.getenv("CS_CAMERA_NIGHT_CTRL", "")
    record_dir: Path = Path(os.getenv("CS_RECORD_DIR", "recordings"))


CFG = Config()

# Bumped whenever the deployed behaviour changes, so `/health` and setup.sh can
# prove which gateway build is actually running on the Pi.
GATEWAY_VERSION = "1.1.0"


# ---------------------------------------------------------------------------
# SPEAKER — text-to-speech on the Pi's speaker
# ---------------------------------------------------------------------------

class Speaker:
    """Serialised TTS worker.

    Picks the best available engine (piper > espeak-ng > espeak > spd-say).
    Speech runs in a background thread so it never blocks the event loop.
    """

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self._q: queue.Queue[str | None] = queue.Queue()
        self._current: subprocess.Popen | None = None
        self._lock = threading.Lock()
        self.engine = self._detect_engine()
        self._thread = threading.Thread(target=self._worker, name="tts", daemon=True)
        self._thread.start()
        print(f"[tts] engine = {self.engine or 'none (text will only be logged)'}")

    def _detect_engine(self) -> str | None:
        if self.cfg.tts_engine == "none":
            return None
        if self.cfg.tts_engine != "auto":
            return self.cfg.tts_engine if shutil.which(self.cfg.tts_engine) else None
        if self.cfg.piper_model and shutil.which("piper") and shutil.which("aplay"):
            return "piper"
        for candidate in ("espeak-ng", "espeak", "spd-say"):
            if shutil.which(candidate):
                return candidate
        return None

    def say(self, text: str) -> None:
        text = (text or "").strip()
        if not text:
            return
        # Speaking a new line supersedes whatever is queued.
        self._drain()
        self._q.put(text)

    def stop(self) -> None:
        self._drain()
        with self._lock:
            if self._current and self._current.poll() is None:
                self._current.terminate()

    def _drain(self) -> None:
        try:
            while True:
                self._q.get_nowait()
        except queue.Empty:
            pass

    def _spawn(self, text: str) -> subprocess.Popen | None:
        """Start the engine for one utterance. piper needs a shell pipeline."""
        if self.engine == "piper":
            cmd = f"piper --model {self.cfg.piper_model} --output_file - | aplay -q -"
            proc = subprocess.Popen(
                cmd, shell=True, stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            assert proc.stdin is not None
            proc.stdin.write(text.encode("utf-8"))
            proc.stdin.close()
            return proc
        if self.engine in ("espeak-ng", "espeak"):
            return subprocess.Popen(
                [self.engine, "-v", self.cfg.tts_voice, "-s", str(self.cfg.tts_rate), text],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        if self.engine == "spd-say":
            return subprocess.Popen(["spd-say", "-w", text])
        return None

    def _worker(self) -> None:
        while True:
            text = self._q.get()
            if text is None:
                return
            if not self.engine:
                print(f"[tts] (no engine) would say: {text}")
                continue
            try:
                with self._lock:
                    self._current = self._spawn(text)
                proc = self._current
                if proc is not None:
                    proc.wait()
            except Exception as exc:  # pragma: no cover
                print(f"[tts] error: {exc}")
            finally:
                with self._lock:
                    self._current = None


SPEAKER = Speaker(CFG)


# ---------------------------------------------------------------------------
# MOTOR / SERIAL
# ---------------------------------------------------------------------------

class MotorBus:
    """Reads Arduino sensor lines and writes movement commands.

    The serial link is re-opened on demand, so a replugged Arduino recovers
    without restarting the gateway.
    """

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self._ser = None
        self._lock = threading.Lock()
        self.connected = False

    @property
    def serial(self):
        if serial is None:
            return None
        with self._lock:
            if self._ser is not None:
                return self._ser
            try:
                self._ser = serial.Serial(self.cfg.serial_port, self.cfg.serial_baud, timeout=1)
                self.connected = True
                print(f"[serial] connected on {self.cfg.serial_port}")
            except Exception as exc:
                print(f"[serial] not available on {self.cfg.serial_port}: {exc}")
                self._ser = None
            return self._ser

    def write(self, command: str) -> bool:
        s = self.serial
        if s is None:
            print(f"[motor] (offline) {command}")
            return False
        try:
            s.write(f"{command}\n".encode("utf-8"))
            return True
        except Exception as exc:
            print(f"[serial] write failed: {exc}")
            with self._lock:
                self._ser = None
                self.connected = False
            return False

    @staticmethod
    def direction_for_angle(angle: float) -> str:
        """angle: 0 = forward, 90 = right, 180 = backward, -90/270 = left."""
        a = angle % 360
        if 45 <= a < 135:
            return "RIGHT"
        if 135 <= a < 225:
            return "BACKWARD"
        if 225 <= a < 315:
            return "LEFT"
        return "FORWARD"

    def stop(self) -> None:
        self.write("STOP")

    def close(self) -> None:
        with self._lock:
            if self._ser is not None:
                try:
                    self._ser.close()
                except Exception:
                    pass
                self._ser = None
        self.connected = False


MOTORS = MotorBus(CFG)


# ---------------------------------------------------------------------------
# CAMERA — supervised MJPEG stream for the app's live feed
# ---------------------------------------------------------------------------

class CameraManager:
    """Owns the MJPEG stream the app renders at `/stream.mjpg`.

    ffmpeg itself serves the HTTP endpoint (`-listen 1`), so provisionning needs
    no extra systemd unit: the gateway starts, restarts and stops it. Recording
    reads back off that same HTTP stream instead of `/dev/video0`, which avoids
    two processes fighting over the capture device.
    """

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self._proc: subprocess.Popen | None = None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self.night = False
        self.reason = "disabled" if not cfg.camera_enable else "starting"
        try:
            self.cfg.record_dir.mkdir(parents=True, exist_ok=True)
        except Exception:
            pass
        self._thread = threading.Thread(target=self._loop, name="camera", daemon=True)
        self._thread.start()

    @property
    def online(self) -> bool:
        with self._lock:
            return bool(self._proc and self._proc.poll() is None)

    @property
    def device_present(self) -> bool:
        return Path(self.cfg.camera_device).exists()

    def _stream_cmd(self) -> list[str]:
        filters: list[str] = []
        if self.cfg.camera_rotate == "180":
            filters.append("hflip,vflip")
        elif self.cfg.camera_rotate == "90":
            filters.append("transpose=1")
        elif self.cfg.camera_rotate == "270":
            filters.append("transpose=2")
        if self.night:
            # Software low-light boost; hardware IR is handled by camera_night_ctrl.
            filters.append("eq=brightness=0.18:contrast=1.35:saturation=0.6")

        cmd = [
            "ffmpeg", "-nostdin", "-loglevel", "warning",
            "-f", "v4l2", "-framerate", str(self.cfg.camera_fps),
            "-video_size", self.cfg.camera_size, "-i", self.cfg.camera_device,
        ]
        if filters:
            cmd += ["-vf", ",".join(filters)]
        cmd += [
            "-f", "mpjpeg", "-listen", "1",
            "-headers", "Access-Control-Allow-Origin: *\r\n",
            f"http://0.0.0.0:{self.cfg.camera_port}/stream.mjpg",
        ]
        return cmd

    def _loop(self) -> None:
        if not self.cfg.camera_enable:
            self.reason = "disabled"
            return
        if not shutil.which("ffmpeg"):
            self.reason = "ffmpeg not installed"
            print("[camera] ffmpeg is missing — install it with `apt-get install ffmpeg`")
            return

        log_path = Path(tempfile.gettempdir()) / "cybersentinel-camera.log"
        while not self._stop.is_set():
            if not self.device_present:
                self.reason = f"{self.cfg.camera_device} not present"
                self._stop.wait(5)
                continue
            try:
                with open(log_path, "wb") as logf:
                    with self._lock:
                        self._proc = subprocess.Popen(
                            self._stream_cmd(), stdout=subprocess.DEVNULL, stderr=logf
                        )
                        proc = self._proc
                self.reason = "streaming"
                print(f"[camera] MJPEG on :{self.cfg.camera_port}/stream.mjpg "
                      f"({self.cfg.camera_size}@{self.cfg.camera_fps}, night={self.night})")
                proc.wait()
                if not self._stop.is_set():
                    tail = read_tail(log_path)
                    self.reason = tail or f"ffmpeg exited with code {proc.returncode}"
                    print(f"[camera] ffmpeg exited: {self.reason}")
            except Exception as exc:
                self.reason = str(exc)
                print(f"[camera] error: {exc}")
            finally:
                with self._lock:
                    self._proc = None
            self._stop.wait(3)

    def _restart(self) -> None:
        """Kill the stream so the supervisor respawns it with the new filters."""
        with self._lock:
            if self._proc is not None and self._proc.poll() is None:
                self._proc.terminate()

    def set_night_mode(self, on: bool) -> dict:
        want = bool(on)
        hardware = None
        if self.cfg.camera_night_ctrl and shutil.which("v4l2-ctl"):
            try:
                subprocess.run(
                    ["v4l2-ctl", "-d", self.cfg.camera_device, "--set-ctrl", self.cfg.camera_night_ctrl],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
                )
                hardware = self.cfg.camera_night_ctrl
            except Exception:
                hardware = None
        if want != self.night:
            self.night = want
            self._restart()
        return {"ok": True, "night_mode": self.night, "hardware_control": hardware}

    def record(self, seconds: int = 15) -> dict:
        if not self.online:
            return {"ok": False, "detail": self.reason or "camera stream is not running"}
        seconds = max(1, min(120, int(seconds)))
        path = self.cfg.record_dir / f"clip-{time.strftime('%Y%m%d-%H%M%S')}.mkv"
        url = f"http://127.0.0.1:{self.cfg.camera_port}/stream.mjpg"
        cmd = [
            "ffmpeg", "-nostdin", "-loglevel", "error", "-y",
            "-f", "mpjpeg", "-i", url,
            "-t", str(seconds), "-c:v", "copy", str(path),
        ]

        def run() -> None:
            try:
                subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               timeout=seconds + 20, check=False)
                print(f"[camera] recorded {seconds}s -> {path}")
            except Exception as exc:
                print(f"[camera] recording failed: {exc}")
            finally:
                STATE.recording = False

        STATE.recording = True
        threading.Thread(target=run, name="camera-record", daemon=True).start()
        return {"ok": True, "path": str(path), "seconds": seconds}

    def status(self) -> dict:
        return {
            "online": self.online,
            "device": self.cfg.camera_device,
            "device_present": self.device_present,
            "port": self.cfg.camera_port,
            "stream_url": f"http://{self.cfg.hostname}.local:{self.cfg.camera_port}/stream.mjpg",
            "night_mode": self.night,
            "recording": STATE.recording,
            "detail": self.reason,
        }

    def stop(self) -> None:
        self._stop.set()
        self._restart()


def read_tail(path: Path, lines: int = 3) -> str:
    try:
        content = path.read_text(errors="replace").strip().splitlines()
        return " ".join(content[-lines:])[:200]
    except Exception:
        return ""


CAMERA = CameraManager(CFG)


# ---------------------------------------------------------------------------
# STATE
# ---------------------------------------------------------------------------

@dataclass
class GatewayState:
    latest_sensors: dict
    device_health: dict
    rover_status: dict
    incidents: list
    alarm: bool = False
    night_mode: bool = False
    recording: bool = False
    speed_limit: int = 60
    last_command_at: float = 0.0


STATE = GatewayState(
    latest_sensors={},
    device_health={"arduino_door": "offline", "pir_node": "offline", "gas_node": "offline",
                   "rover": "online", "camera": "offline"},
    rover_status={"state": "idle", "battery": 100, "zone": "Unknown"},
    incidents=[],
)


def load_incidents() -> None:
    try:
        if CFG.incident_store.exists():
            STATE.incidents = json.loads(CFG.incident_store.read_text())
            print(f"[incidents] loaded {len(STATE.incidents)} from {CFG.incident_store}")
    except Exception as exc:
        print(f"[incidents] could not load store: {exc}")


def save_incidents() -> None:
    try:
        CFG.incident_store.write_text(json.dumps(STATE.incidents[-200:], indent=2))
    except Exception as exc:
        print(f"[incidents] could not persist: {exc}")


def next_incident_id() -> int:
    return max([i.get("id", 0) for i in STATE.incidents] + [0]) + 1


def create_incident(severity: str, zone: str, summary: str, score: int, triggers: list[str],
                    contributions: list[dict] | None = None) -> dict:
    now = int(time.time() * 1000)
    incident = {
        "id": next_incident_id(),
        "severity": severity,
        "zone": zone,
        "summary": summary,
        "ts": now,
        "status": "open",
        "events": [{"ts": now, "label": summary}],
        "sensorSnapshot": list(STATE.latest_sensors.values()),
        "score": score,
        "contributions": contributions or [],
        "photoUrl": None,
        "resolutionNotes": None,
        "resolvedBy": None,
        "resolvedAt": None,
    }
    STATE.incidents.append(incident)
    save_incidents()
    mqtt_publish("incident/new", {"id": incident["id"], "severity": severity, "zone": zone})
    return incident


# ---------------------------------------------------------------------------
# MQTT (optional)
# ---------------------------------------------------------------------------

MQTT = None
MQTT_TOPICS = ["sensor/#", "device/health", "rover/#", "rfid/#", "threat/#"]


def mqtt_publish(topic: str, payload: dict) -> None:
    if MQTT is None:
        return
    try:
        MQTT.publish(topic, json.dumps(payload))
    except Exception:
        pass


def start_mqtt() -> None:
    global MQTT
    if mqtt_client is None:
        print("[mqtt] paho-mqtt not installed — telemetry fan-out disabled")
        return

    def on_connect(_client, _userdata, _flags, reason, _props=None):
        print(f"[mqtt] connected ({reason}); subscribing")
        for topic in MQTT_TOPICS:
            _client.subscribe(topic)

    def on_message(_client, _userdata, msg):
        try:
            payload = json.loads(msg.payload.decode())
        except Exception:
            return
        if msg.topic == "device/health":
            STATE.device_health.update(payload)
        elif msg.topic == "rover/status":
            STATE.rover_status = payload
        else:
            STATE.latest_sensors[msg.topic] = payload

    try:
        client = mqtt_client.Client(mqtt_client.CallbackAPIVersion.VERSION2, client_id="cybersentinel-gateway")
        client.on_connect = on_connect
        client.on_message = on_message
        client.connect(CFG.mqtt_broker, CFG.mqtt_port, keepalive=30)
        client.loop_start()
        MQTT = client
    except Exception as exc:
        print(f"[mqtt] broker unavailable ({exc}); continuing without it")
        MQTT = None


# ---------------------------------------------------------------------------
# Serial reader
# ---------------------------------------------------------------------------

async def read_arduino_serial() -> None:
    """Forward JSON lines from the Arduino into MQTT + local state."""
    while True:
        s = MOTORS.serial
        if s is None:
            await asyncio.sleep(3)
            continue
        try:
            line = await asyncio.to_thread(s.readline)
            line = line.decode("utf-8", errors="replace").strip()
            if line:
                try:
                    data = json.loads(line)
                    topic = data.get("topic")
                    value = data.get("value")
                    if topic and value is not None:
                        mqtt_publish(topic, value)
                        STATE.latest_sensors[topic] = value
                        if topic == "device/health":
                            STATE.device_health.update(value)
                except json.JSONDecodeError:
                    mqtt_publish("arduino/raw", {"line": line})
        except Exception:
            # Port disappeared — drop it and retry the reconnect path.
            MOTORS.close()
            await asyncio.sleep(2)


# ---------------------------------------------------------------------------
# WebSocket control server (the app's command protocol)
# ---------------------------------------------------------------------------

async def handle_command(data: dict) -> dict:
    cmd = str(data.get("cmd", "")).upper()
    STATE.last_command_at = time.time()

    if cmd == "PING":
        return {"type": "pong", "ts": int(time.time() * 1000)}

    if cmd == "STOP":
        MOTORS.stop()
        STATE.rover_status = {**STATE.rover_status, "state": "idle"}
        mqtt_publish("rover/status", STATE.rover_status)
        return {"type": "ack", "cmd": cmd}

    if cmd == "MOVE":
        angle = float(data.get("angle", 0))
        speed = int(data.get("speed", 0))
        if speed <= 0:
            MOTORS.stop()
            return {"type": "ack", "cmd": cmd, "direction": "STOP"}
        direction = MOTORS.direction_for_angle(angle)
        MOTORS.write(direction)
        STATE.rover_status = {**STATE.rover_status, "state": "manual"}
        return {"type": "ack", "cmd": cmd, "direction": direction, "angle": angle}

    if cmd == "SET_SPEED":
        STATE.speed_limit = int(data.get("value", STATE.speed_limit))
        return {"type": "ack", "cmd": cmd, "value": STATE.speed_limit}

    if cmd == "PATROL_START":
        STATE.rover_status = {**STATE.rover_status, "state": "patrolling"}
        mqtt_publish("rover/status", STATE.rover_status)
        return {"type": "ack", "cmd": cmd}

    if cmd == "PATROL_STOP":
        MOTORS.stop()
        STATE.rover_status = {**STATE.rover_status, "state": "idle"}
        mqtt_publish("rover/status", STATE.rover_status)
        return {"type": "ack", "cmd": cmd}

    if cmd == "RETURN_HOME":
        STATE.rover_status = {**STATE.rover_status, "state": "returning"}
        mqtt_publish("rover/status", STATE.rover_status)
        return {"type": "ack", "cmd": cmd}

    if cmd == "BUZZER":
        # Reuse the Arduino's buzzer if it exposes one; otherwise beep the Pi.
        MOTORS.write("BUZZER")
        return {"type": "ack", "cmd": cmd}

    if cmd == "SPEAK":
        text = str(data.get("text", ""))[:500]
        SPEAKER.say(text)
        return {"type": "ack", "cmd": cmd, "speaking": text}

    if cmd == "TTS_STOP":
        SPEAKER.stop()
        return {"type": "ack", "cmd": cmd}

    return {"type": "error", "message": f"unknown command: {cmd}"}


async def control_handler(websocket) -> None:
    peer = getattr(websocket, "remote_address", None)
    print(f"[ws] app connected {peer}")
    try:
        async for message in websocket:
            try:
                data = json.loads(message)
            except json.JSONDecodeError:
                continue
            reply = await handle_command(data)
            if reply:
                await websocket.send(json.dumps(reply))
    except Exception as exc:
        print(f"[ws] connection ended: {exc}")
    finally:
        MOTORS.stop()
        print(f"[ws] app disconnected {peer}")


async def start_ws_server() -> None:
    if websockets is None:
        print("[ws] websockets not installed — control server disabled")
        return
    print(f"[ws] control server on :{CFG.ws_port}")
    async with websockets.serve(control_handler, "0.0.0.0", CFG.ws_port, ping_interval=20):
        await asyncio.Future()


# ---------------------------------------------------------------------------
# mDNS advertisement
# ---------------------------------------------------------------------------

_ZC: Zeroconf | None = None


def start_mdns() -> None:
    global _ZC
    if not CFG.enable_mdns or Zeroconf is None:
        return
    try:
        _ZC = Zeroconf()
        info = ServiceInfo(
            "_cybersentinel._tcp.local.",
            f"CyberSentinel Rover._cybersentinel._tcp.local.",
            addresses=[__import__("socket").inet_aton(get_local_ip())],
            port=CFG.api_port,
            properties={"service": "cybersentinel", "ws": str(CFG.ws_port), "api": str(CFG.api_port)},
            server=f"{CFG.hostname}.local.",
        )
        _ZC.register_service(info)
        print(f"[mdns] advertised CyberSentinel as {CFG.hostname}.local")
    except Exception as exc:
        print(f"[mdns] advertisement failed: {exc}")


def get_local_ip() -> str:
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def stop_mdns() -> None:
    global _ZC
    if _ZC is not None:
        try:
            _ZC.close()
        except Exception:
            pass
        _ZC = None


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

async def publish_health_loop() -> None:
    """Publishes `device/health` so the app learns camera/Pi state over MQTT.

    The app also polls GET /health, so this keeps working even when the broker
    is unavailable.
    """
    while True:
        payload = {
            **STATE.device_health,
            "arduino_door": "online" if MOTORS.connected else STATE.device_health.get("arduino_door", "offline"),
            "rover": "online",
            "camera": "online" if CAMERA.online else "offline",
            "pi": pi_stats() or {},
        }
        mqtt_publish("device/health", payload)
        await asyncio.sleep(10)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    load_incidents()
    start_mqtt()
    start_mdns()
    tasks = [
        asyncio.create_task(start_ws_server()),
        asyncio.create_task(read_arduino_serial()),
        asyncio.create_task(publish_health_loop()),
    ]
    print(f"[api] CyberSentinel gateway v{GATEWAY_VERSION}")
    print(f"[api] REST on :{CFG.api_port}  •  discovery name: {CFG.hostname}.local")
    print(f"[api] camera: {CAMERA.status()['detail']}")
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        stop_mdns()
        CAMERA.stop()
        MOTORS.close()
        if MQTT is not None:
            MQTT.loop_stop()
        print("[api] shutdown complete")


app = FastAPI(title="CyberSentinel Gateway", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def pi_stats() -> dict | None:
    if psutil is None:
        return None
    try:
        load = psutil.cpu_percent(interval=None)
        ram = psutil.virtual_memory().percent
        temp = None
        try:
            temps = psutil.sensors_temperatures()
            if temps:
                temp = round(list(temps.values())[0][0].current, 1)
        except Exception:
            temp = None
        return {"cpu": round(load), "ram": round(ram), "temp": temp or 0,
                "uptime": int(time.time() - psutil.boot_time())}
    except Exception:
        return None


@app.get("/health")
async def health():
    devices = {
        **STATE.device_health,
        "arduino_door": "online" if MOTORS.connected else STATE.device_health.get("arduino_door", "offline"),
        "rover": "online",
        "camera": "online" if CAMERA.online else "offline",
    }
    # The flat keys feed the app's device-health store; `devices` is the grouped
    # view used by humans/curl. `status`/`service` are what discovery probes for.
    return {
        "status": "online",
        "service": "cybersentinel",
        "version": GATEWAY_VERSION,
        **devices,
        "devices": devices,
        "camera_info": CAMERA.status(),
        "pi": pi_stats(),
        "speaker": SPEAKER.engine,
        "uptime": int(time.time()),
    }


@app.get("/sensors/latest")
async def sensors():
    return STATE.latest_sensors


@app.get("/rover/status")
async def rover_status():
    return STATE.rover_status


@app.get("/devices/health")
async def devices_health():
    return await health()


@app.post("/alarm/trigger")
async def alarm_trigger():
    STATE.alarm = True
    MOTORS.write("BUZZER")
    incident = create_incident("critical", STATE.rover_status.get("zone", "Unknown"),
                               "Alarm manually triggered by app", 100, ["person", "no_rfid"])
    return {"ok": True, "incident": incident["id"]}


@app.post("/alarm/reset")
async def alarm_reset():
    STATE.alarm = False
    return {"ok": True}


@app.post("/camera/record")
async def camera_record(body: dict | None = None):
    seconds = int((body or {}).get("seconds", 15))
    result = CAMERA.record(seconds)
    if not result.get("ok"):
        raise HTTPException(status_code=503, detail=result.get("detail", "camera unavailable"))
    return result


@app.post("/camera/nightmode")
async def camera_nightmode(body: dict | None = None):
    # No body toggles; {"on": true|false} sets it explicitly.
    body = body or {}
    target = body.get("on")
    if target is None:
        target = not CAMERA.night
    result = CAMERA.set_night_mode(bool(target))
    STATE.night_mode = CAMERA.night
    return result


@app.get("/camera/status")
async def camera_status():
    return CAMERA.status()


@app.post("/speak")
async def speak(body: dict | None = None):
    text = str((body or {}).get("text", ""))[:500]
    if not text:
        raise HTTPException(status_code=422, detail="text is required")
    SPEAKER.say(text)
    return {"ok": True}


@app.post("/fcm/register")
async def fcm_register(_body: dict | None = None):
    # Push is best-effort; the in-app banner is the primary alert channel.
    return {"ok": True}


@app.get("/incidents")
async def list_incidents(limit: int = 50, offset: int = 0, severity: str | None = None,
                        resolved: bool | None = None):
    rows = sorted(STATE.incidents, key=lambda i: i["ts"], reverse=True)
    if severity:
        rows = [i for i in rows if i.get("severity") == severity]
    if resolved is not None:
        want = "resolved" if resolved else "open"
        rows = [i for i in rows if i.get("status") == want]
    return rows[offset: offset + limit]


@app.get("/incidents/{incident_id}")
async def get_incident(incident_id: int):
    for incident in STATE.incidents:
        if incident["id"] == incident_id:
            return incident
    raise HTTPException(status_code=404, detail="incident not found")


@app.patch("/incidents/{incident_id}")
async def patch_incident(incident_id: int, body: dict):
    for incident in STATE.incidents:
        if incident["id"] == incident_id:
            if "resolution_notes" in body:
                incident["resolutionNotes"] = body["resolution_notes"]
            if body.get("resolved"):
                incident["status"] = "resolved"
                incident["resolvedAt"] = int(time.time() * 1000)
                incident["resolvedBy"] = body.get("resolved_by", "app")
                incident.setdefault("events", []).append(
                    {"ts": int(time.time() * 1000), "label": "Resolved from the mobile app"}
                )
            save_incidents()
            return incident
    raise HTTPException(status_code=404, detail="incident not found")


@app.get("/voice/status")
async def voice_status():
    """Small helper so the app/Settings can confirm the speaker is ready."""
    return {"tts_engine": SPEAKER.engine, "pi": pi_stats()}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=CFG.api_port)