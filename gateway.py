"""
CyberSentinel rover gateway — runs on the Raspberry Pi 4.

Bridges the phone app to the hardware:
  * WebSocket  :8765  rover commands (STOP / MOVE / PATROL / BUZZER / SPEAK …)
  * HTTP       :8000  REST API (health, sensors, incidents, alarm, camera)
  * MQTT       :1883  telemetry fan-out (Mosquitto, websockets listener enabled)
  * Serial     USB    Arduino motor + buzzer node
  * Speaker    GPIO/USB text-to-speech (espeak-ng / piper)

Everything is zero-config: the phone discovers this Pi on the shared WiFi via
mDNS (`cybersentinel.local`) or a subnet scan of the gateway's HTTP health
endpoint, so both devices only need to be on the same network.

Run:  python3 gateway.py
Env:  see CONFIG below (all optional).
"""

from __future__ import annotations

import asyncio
import glob
import io
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.request
from contextlib import asynccontextmanager
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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
    # "auto" (the default) sniffs /dev/ttyACM* then /dev/ttyUSB*, so a genuine
    # Uno R3 (CDC-ACM → ttyACM0) works without any configuration.
    serial_port: str = os.getenv("CS_SERIAL_PORT", "auto")
    serial_baud: int = int(os.getenv("CS_SERIAL_BAUD", "115200"))
    tts_engine: str = os.getenv("CS_TTS_ENGINE", "auto")  # auto | espeak-ng | espeak | spd-say | none
    # espeak takes a base language plus an optional voice *variant*: "en+f3" is
    # a light, friendly female voice. An unknown variant falls back to the base
    # language automatically, so this is always safe to set.
    tts_voice: str = os.getenv("CS_TTS_VOICE", "en+f3")  # +f* variants are female
    tts_rate: int = int(os.getenv("CS_TTS_RATE", "165"))
    tts_pitch: int = int(os.getenv("CS_TTS_PITCH", "70"))  # 0-99, higher = chirpier
    piper_model: str = os.getenv("CS_PIPER_MODEL", "")  # e.g. /opt/piper/en_US-lessac-medium.onnx
    hostname: str = os.getenv("CS_HOSTNAME", "cybersentinel")
    enable_mdns: bool = os.getenv("CS_ENABLE_MDNS", "1") != "0"
    incident_store: Path = Path(os.getenv("CS_INCIDENT_STORE", "incidents.json"))
    # Camera / MJPEG stream
    camera_enable: bool = os.getenv("CS_CAMERA_ENABLE", "1") != "0"
    # auto | picamera | usb | external | off
    camera_source: str = os.getenv("CS_CAMERA_SOURCE", "auto")
    # Used when camera_source=external: an MJPEG URL you already serve yourself.
    camera_external_url: str = os.getenv("CS_CAMERA_EXTERNAL_URL", "")
    camera_stream_path: str = os.getenv("CS_CAMERA_STREAM_PATH", "/stream.mjpg")
    camera_snapshot_path: str = os.getenv("CS_CAMERA_SNAPSHOT_PATH", "/snapshot.jpg")
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
GATEWAY_VERSION = "1.6.0"


# ---------------------------------------------------------------------------
# SPEAKER — text-to-speech on the Pi's speaker
# ---------------------------------------------------------------------------

# espeak's bare language codes ("en") select its male voice; the "+f*" variants
# are the female ones, in roughly descending order of how natural they sound.
# Tried in order so an unsupported variant does not silently turn the speaker
# male.
FEMALE_VOICE_FALLBACKS = ("en+f3", "en+f4", "en+f2", "en-us+f3", "en+f1")


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
        self.voice = self._resolve_voice()
        self._thread = threading.Thread(target=self._worker, name="tts", daemon=True)
        self._thread.start()
        print(f"[tts] engine = {self.engine or 'none (text will only be logged)'}"
              + (f", voice = {self.voice}" if self.engine in ("espeak-ng", "espeak") else ""))

    def describe(self) -> str:
        """Human-readable summary for /health."""
        if not self.engine:
            return "none"
        if self.engine in ("espeak-ng", "espeak"):
            return f"{self.engine} ({self.voice}, pitch {self.cfg.tts_pitch})"
        return self.engine

    def _voice_supported(self, voice: str) -> bool:
        """espeak exits non-zero for a voice it does not know."""
        probe = subprocess.run(
            [self.engine, "-v", voice, "-q", "ok"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5,
        )
        return probe.returncode == 0

    def _resolve_voice(self) -> str:
        """Pick a voice we can actually run, preferring a female one.

        A bare language such as "en" is espeak's *male* default, so falling
        straight back to it would quietly swap the speaker's voice. Instead we
        walk a list of known female variants and only drop to the base language
        as a last resort, where speaking at all still beats staying silent.
        """
        want = (self.cfg.tts_voice or "en").strip()
        if self.engine not in ("espeak-ng", "espeak"):
            return want

        candidates = [want] + [v for v in FEMALE_VOICE_FALLBACKS if v != want]
        try:
            for voice in candidates:
                if self._voice_supported(voice):
                    if voice != want:
                        print(f"[tts] voice '{want}' is unavailable; using the female "
                              f"voice '{voice}' instead")
                    return voice
        except Exception:
            pass

        base = want.split("+", 1)[0] or "en"
        print(f"[tts] no female voice available for '{want}'; "
              f"falling back to '{base}' (may sound male)")
        return base

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
                [self.engine, "-v", self.voice, "-s", str(self.cfg.tts_rate),
                 "-p", str(self.cfg.tts_pitch), text],
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

# A real Arduino Uno R3 uses the CDC-ACM driver and appears as /dev/ttyACM0.
# Clones built around CH340/CP2102 chips appear as /dev/ttyUSB0. Probing both
# keeps the rover plug-and-play instead of demanding a hand-edited config.
SERIAL_PORT_PATTERNS = ("/dev/ttyACM*", "/dev/ttyUSB*")


def discover_serial_port(configured: str = "") -> str | None:
    """Return a serial port path that actually exists on this machine.

    An explicit path is honoured while it is present. Otherwise, and whenever
    that path has gone stale, the usual Arduino device globs are probed — ACM
    first, because that is what a genuine Uno R3 enumerates as.
    """
    configured = (configured or "").strip()
    if configured and configured.lower() != "auto" and os.path.exists(configured):
        return configured
    for pattern in SERIAL_PORT_PATTERNS:
        matches = sorted(glob.glob(pattern))
        if matches:
            return matches[0]
    return None


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
        self.port: str | None = None
        self.last_error: str | None = None

    @property
    def serial(self):
        if serial is None:
            self.last_error = "pyserial is not installed"
            return None
        with self._lock:
            if self._ser is not None:
                return self._ser
            port = discover_serial_port(self.cfg.serial_port)
            if port is None:
                self.last_error = "no Arduino on /dev/ttyACM* or /dev/ttyUSB*"
                print(f"[serial] {self.last_error}")
                return None
            try:
                self._ser = serial.Serial(port, self.cfg.serial_baud, timeout=1)
                self.connected = True
                self.port = port
                self.last_error = None
                print(f"[serial] connected on {port}")
            except Exception as exc:
                self.port = port
                self.last_error = str(exc)
                print(f"[serial] not available on {port}: {exc}")
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
# CAMERA — one HTTP endpoint for the app, whatever the capture backend
#
# Sources (CS_CAMERA_SOURCE):
#   auto      pick the best available at runtime (picamera -> external -> usb)
#   picamera  CSI Camera Module through Picamera2 (Raspberry Pi OS default)
#   usb       USB webcam through ffmpeg on /dev/videoN
#   external  proxy an MJPEG URL you already serve yourself
#   off       disable
#
# The app always consumes http://<pi>:<port><camera_stream_path>, so changing
# hardware never requires an app change.
# ---------------------------------------------------------------------------

JPEG_SOI = b"\xff\xd8"
JPEG_EOI = b"\xff\xd9"


def iter_jpegs(stream, chunk_size: int = 65536):
    """Yield complete JPEG frames from a continuous byte stream.

    Works for an ffmpeg stdout pipe, an MJPEG HTTP response, or any source that
    keeps producing concatenated JPEGs. `read1` is preferred so a partially
    filled chunk is returned immediately instead of blocking for `chunk_size`.
    """
    read = getattr(stream, "read1", None) or stream.read
    buf = b""
    while True:
        chunk = read(chunk_size)
        if not chunk:
            return
        buf += chunk
        while True:
            start = buf.find(JPEG_SOI)
            if start < 0:
                buf = buf[-1:]
                break
            end = buf.find(JPEG_EOI, start + 2)
            if end < 0:
                buf = buf[start:]
                break
            yield buf[start:end + 2]
            buf = buf[end + 2:]


class _MjpegRequestHandler(BaseHTTPRequestHandler):
    """Serves the live stream, a JPEG snapshot and a browser preview page."""

    protocol_version = "HTTP/1.0"
    manager = None  # bound per server instance

    def log_message(self, *_args) -> None:  # keep the journal readable
        return

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        cfg = self.manager.cfg

        if path in ("/", "/index.html"):
            body = (
                "<!DOCTYPE html><html><head><title>CyberSentinel Camera</title></head>"
                "<body style='margin:0;background:#0b1220;color:#e2e8f0;font-family:sans-serif'>"
                f"<h4 style='padding:8px'>CyberSentinel camera</h4>"
                f"<img src='{cfg.camera_stream_path}' width='640'>"
                "</body></html>"
            ).encode()
            self._send(200, "text/html", body)
            return

        if path == cfg.camera_snapshot_path:
            frame = self.manager.snapshot()
            if frame is None:
                self.send_error(503, "no frame yet")
                return
            self._send(200, "image/jpeg", frame)
            return

        if path == cfg.camera_stream_path:
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            try:
                for frame in self.manager.frames():
                    self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\n")
                    self.wfile.write(b"Content-Length: " + str(len(frame)).encode() + b"\r\n\r\n")
                    self.wfile.write(frame + b"\r\n")
            except (BrokenPipeError, ConnectionResetError, OSError) as exc:
                # Expected whenever a viewer closes the stream.
                print(f"[camera] stream viewer disconnected: {exc}")
            return

        print(f"[camera] 404 for {path!r} (stream is {cfg.camera_stream_path})")
        self.send_error(404)

    def _send(self, code: int, content_type: str, body: bytes) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            self.wfile.write(body)
        except OSError as exc:
            # Normal when a browser tab navigates away mid-response.
            print(f"[camera] client went away during a {code} response: {exc}")


class _MjpegServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class CameraManager:
    """Owns the MJPEG endpoint the app renders.

    Whichever backend is active, the gateway serves the stream itself, so there
    is no separate camera service to enable and the app URL never changes.
    Recording reads the live stream back over HTTP, which means it never fights
    the capture device for exclusive access.
    """

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.source = "none"
        self.reason = "disabled" if not cfg.camera_enable else "starting"
        self._last_reason = ""
        self.night = False
        self._stop = threading.Event()
        self._frame: bytes | None = None
        self._frame_seq = 0
        self._frame_at = 0.0
        self._frame_cond = threading.Condition()
        self._server: _MjpegServer | None = None
        self._ffmpeg: subprocess.Popen | None = None
        self._picam = None
        self._log_path = Path(tempfile.gettempdir()) / "cybersentinel-camera.log"
        try:
            self.cfg.record_dir.mkdir(parents=True, exist_ok=True)
        except Exception as exc:
            # Recording is about to fail for a reason nobody would guess.
            print(f"[camera] cannot use record dir {self.cfg.record_dir}: {exc}")
        threading.Thread(target=self._supervise, name="camera", daemon=True).start()

    def _note(self, reason: str) -> None:
        """Record why the stream is down, printing only when it changes.

        The supervisor retries every few seconds; without this the journal
        would repeat the same line forever and bury the real errors.
        """
        self.reason = reason
        if reason != self._last_reason:
            self._last_reason = reason
            print(f"[camera] {reason}")

    # ---- shared frame buffer -------------------------------------------

    @property
    def online(self) -> bool:
        if self.source == "none" or self._frame_at == 0.0:
            return False
        return (time.time() - self._frame_at) < 6

    @property
    def device_present(self) -> bool:
        if self.source == "picamera":
            return True
        if self.source == "external":
            return bool(self.cfg.camera_external_url)
        return Path(self.cfg.camera_device).exists()

    def snapshot(self) -> bytes | None:
        with self._frame_cond:
            return self._frame

    def frames(self):
        seen = -1
        while not self._stop.is_set():
            with self._frame_cond:
                if self._frame_seq == seen:
                    self._frame_cond.wait(timeout=1.0)
                seq, frame = self._frame_seq, self._frame
            if frame is None or seq == seen:
                continue
            seen = seq
            yield frame

    def _on_frame(self, jpeg: bytes) -> None:
        with self._frame_cond:
            self._frame = jpeg
            self._frame_seq += 1
            self._frame_at = time.time()
            self._frame_cond.notify_all()

    # ---- backend selection --------------------------------------------

    @staticmethod
    def picamera_available() -> bool:
        """True when Picamera2 can see a CSI camera on this board."""
        try:
            from picamera2 import Picamera2
            return len(Picamera2.global_camera_info()) > 0
        except Exception:
            return False

    def _resolve_source(self) -> str:
        want = (self.cfg.camera_source or "auto").lower()
        if want == "off":
            return "none"
        if want != "auto":
            return want
        if self.picamera_available():
            return "picamera"
        if self.cfg.camera_external_url:
            return "external"
        if Path(self.cfg.camera_device).exists():
            return "usb"
        return "none"

    def _usb_filters(self) -> list[str]:
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
        return filters

    # ---- supervision ---------------------------------------------------

    def _serve(self) -> bool:
        """Start the MJPEG HTTP server once. False when the port is unusable."""
        if self._server is not None:
            return True
        handler = type("_BoundMjpegHandler", (_MjpegRequestHandler,), {"manager": self})
        try:
            self._server = _MjpegServer(("0.0.0.0", self.cfg.camera_port), handler)
        except OSError as exc:
            self.reason = f"port {self.cfg.camera_port} unavailable: {exc}"
            print(f"[camera] {self.reason}")
            return False
        threading.Thread(target=self._server.serve_forever, name="camera-http", daemon=True).start()
        print(f"[camera] MJPEG server on :{self.cfg.camera_port}{self.cfg.camera_stream_path}")
        return True

    def _supervise(self) -> None:
        if not self.cfg.camera_enable:
            self.reason = "disabled"
            return
        while not self._stop.is_set():
            self.source = self._resolve_source()
            if self.source == "none":
                self._note(
                    "no camera found - install python3-picamera2 for the CSI camera "
                    f"or attach a USB camera at {self.cfg.camera_device}"
                )
                self._stop.wait(10)
                continue
            if self.source == "external" and not self.cfg.camera_external_url:
                self._note("CS_CAMERA_SOURCE=external needs CS_CAMERA_EXTERNAL_URL")
                self._stop.wait(10)
                continue
            if not self._serve():
                self._stop.wait(10)
                continue

            if self.source == "picamera":
                self._run_picamera()
            elif self.source == "external":
                self._run_external()
            else:
                self._run_usb()
            self._stop.wait(3)

    def _run_picamera(self) -> None:
        """CSI Camera Module via Picamera2 (the standard Raspberry Pi stack).

        Uses Picamera2's own JPEG encoder rather than OpenCV, so this needs no
        extra Python packages beyond python3-picamera2.
        """
        try:
            from picamera2 import Picamera2
            from picamera2.encoders import MJPEGEncoder
            from picamera2.outputs import FileOutput
        except Exception as exc:
            self.reason = (
                f"picamera2 not importable ({exc}) - install python3-picamera2 and "
                "recreate the venv with --system-site-packages"
            )
            print(f"[camera] {self.reason}")
            return

        class _Sink(io.BufferedIOBase):
            def __init__(self, sink):
                self._sink = sink

            def write(self, buf):
                self._sink(bytes(buf))
                return len(buf)

        cam = None
        try:
            width, height = (int(v) for v in self.cfg.camera_size.lower().split("x"))
            cam = Picamera2()
            cam.configure(cam.create_video_configuration(main={"size": (width, height)}))
            cam.start_recording(MJPEGEncoder(), FileOutput(_Sink(self._on_frame)))
            cam.start()
            self._picam = cam
            if self.night:
                self._apply_picamera_night(cam, True)
            self.reason = "streaming (picamera)"
            print(f"[camera] picamera streaming {self.cfg.camera_size}@{self.cfg.camera_fps}")

            # Wait for the first frame, then treat a stalled encoder as a failure
            # so the supervisor rebuilds the pipeline.
            deadline = time.time() + 10
            while not self._stop.is_set() and self._frame_at == 0.0 and time.time() < deadline:
                time.sleep(0.2)
            if self._frame_at == 0.0:
                self._note("picamera started but produced no frames")
                return
            while not self._stop.is_set():
                if (time.time() - self._frame_at) > 6:
                    self._note("picamera stream stalled")
                    return
                time.sleep(0.5)
        except Exception as exc:
            self.reason = f"picamera failed: {exc}"
            print(f"[camera] {self.reason}")
        finally:
            self._picam = None
            if cam is not None:
                try:
                    cam.stop()
                    cam.close()
                except Exception:
                    pass

    def _run_usb(self) -> None:
        """USB webcam through ffmpeg, piped to stdout and re-served by us."""
        if not shutil.which("ffmpeg"):
            self._note("ffmpeg not installed (apt-get install ffmpeg)")
            return
        if not Path(self.cfg.camera_device).exists():
            self._note(f"{self.cfg.camera_device} not present")
            return

        cmd = [
            "ffmpeg", "-nostdin", "-loglevel", "warning",
            "-f", "v4l2", "-framerate", str(self.cfg.camera_fps),
            "-video_size", self.cfg.camera_size, "-i", self.cfg.camera_device,
        ]
        filters = self._usb_filters()
        if filters:
            cmd += ["-vf", ",".join(filters)]
        cmd += ["-f", "mjpeg", "-"]

        try:
            with open(self._log_path, "wb") as logf:
                proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=logf)
                self._ffmpeg = proc
                self.reason = "streaming (usb)"
                print(f"[camera] ffmpeg v4l2 {self.cfg.camera_device} -> "
                      f":{self.cfg.camera_port}{self.cfg.camera_stream_path}")
                stdout = proc.stdout
                if stdout is None:
                    self._note("ffmpeg produced no output pipe")
                    return
                for frame in iter_jpegs(stdout):
                    if self._stop.is_set():
                        return
                    self._on_frame(frame)
        except Exception as exc:
            self._note(f"ffmpeg failed: {exc}")
        finally:
            self._kill_ffmpeg()
            if not self._stop.is_set() and not self.reason.startswith("ffmpeg failed"):
                self._note(read_tail(self._log_path) or "ffmpeg exited")

    def _run_external(self) -> None:
        """Proxy an MJPEG stream you already run (e.g. your own Flask app)."""
        url = self.cfg.camera_external_url
        try:
            with urllib.request.urlopen(url, timeout=6) as response:
                self.reason = f"proxying {url}"
                print(f"[camera] proxying {url}")
                for frame in iter_jpegs(response):
                    if self._stop.is_set():
                        return
                    self._on_frame(frame)
        except Exception as exc:
            self.reason = f"upstream unavailable: {exc}"
            print(f"[camera] {self.reason}")

    def _kill_ffmpeg(self) -> None:
        proc, self._ffmpeg = self._ffmpeg, None
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=3)
            except Exception as exc:
                print(f"[camera] ffmpeg did not stop cleanly ({exc}); killing it")
                try:
                    proc.kill()
                except Exception as kill_exc:
                    print(f"[camera] could not kill ffmpeg: {kill_exc}")

    @staticmethod
    def _apply_picamera_night(cam, on: bool) -> None:
        cam.set_controls(
            {"Brightness": 0.25, "Contrast": 1.4, "Saturation": 0.5}
            if on
            else {"Brightness": 0.0, "Contrast": 1.0, "Saturation": 1.0}
        )

    def set_night_mode(self, on: bool) -> dict:
        want = bool(on)
        hardware = None
        if (self.cfg.camera_night_ctrl and shutil.which("v4l2-ctl")
                and Path(self.cfg.camera_device).exists()):
            try:
                subprocess.run(
                    ["v4l2-ctl", "-d", self.cfg.camera_device, "--set-ctrl", self.cfg.camera_night_ctrl],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
                )
                hardware = self.cfg.camera_night_ctrl
            except Exception as exc:
                # The software filter below still applies, so this is a warning.
                print(f"[camera] hardware night control '{self.cfg.camera_night_ctrl}' failed: {exc}")
                hardware = None
        if want != self.night:
            self.night = want
            if self.source == "picamera" and self._picam is not None:
                try:
                    self._apply_picamera_night(self._picam, want)
                except Exception as exc:
                    print(f"[camera] night mode failed: {exc}")
            elif self.source == "usb":
                # Respawn ffmpeg so the new video filters take effect.
                self._kill_ffmpeg()
        return {
            "ok": True,
            "night_mode": self.night,
            "source": self.source,
            "supported": self.source in ("picamera", "usb"),
            "hardware_control": hardware,
        }

    def record(self, seconds: int = 15) -> dict:
        if not self.online:
            return {"ok": False, "detail": self.reason or "camera stream is not running"}
        seconds = max(1, min(120, int(seconds)))
        path = self.cfg.record_dir / f"clip-{time.strftime('%Y%m%d-%H%M%S')}.mkv"
        url = f"http://127.0.0.1:{self.cfg.camera_port}{self.cfg.camera_stream_path}"
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
        base = f"http://{self.cfg.hostname}.local:{self.cfg.camera_port}"
        return {
            "online": self.online,
            "source": self.source,
            "device": self.cfg.camera_device,
            "device_present": self.device_present,
            "port": self.cfg.camera_port,
            "stream_url": f"{base}{self.cfg.camera_stream_path}",
            "snapshot_url": f"{base}{self.cfg.camera_snapshot_path}",
            "night_mode": self.night,
            "recording": STATE.recording,
            "detail": self.reason,
        }

    def stop(self) -> None:
        self._stop.set()
        self._kill_ffmpeg()
        if self._server is not None:
            try:
                self._server.shutdown()
            except Exception:
                pass
            self._server = None
        cam, self._picam = self._picam, None
        if cam is not None:
            try:
                cam.stop()
                cam.close()
            except Exception:
                pass


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
    device_health={"arduino": "offline", "pir_node": "offline", "gas_node": "offline",
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
    except Exception as exc:
        # Telemetry loss is easy to miss, so say which topic was dropped.
        print(f"[mqtt] publish to '{topic}' failed: {exc}")


def start_mqtt() -> None:
    global MQTT
    if mqtt_client is None:
        print("[mqtt] paho-mqtt not installed — telemetry fan-out disabled")
        return

    def on_connect(_client, _userdata, _flags, reason, _props=None):
        print(f"[mqtt] connected ({reason}); subscribing")
        for topic in MQTT_TOPICS:
            try:
                _client.subscribe(topic)
            except Exception as exc:
                print(f"[mqtt] subscribe to '{topic}' failed: {exc}")

    def on_disconnect(_client, _userdata, _flags=None, reason=None, _props=None):
        print(f"[mqtt] disconnected ({reason}); paho will retry in the background")

    def on_message(_client, _userdata, msg):
        try:
            payload = json.loads(msg.payload.decode())
        except Exception as exc:
            print(f"[mqtt] ignoring malformed payload on '{msg.topic}': {exc}")
            return
        try:
            if msg.topic == "device/health":
                STATE.device_health.update(payload)
            elif msg.topic == "rover/status":
                STATE.rover_status = payload
            else:
                STATE.latest_sensors[msg.topic] = payload
        except Exception as exc:
            print(f"[mqtt] could not apply '{msg.topic}': {exc}")

    try:
        client = mqtt_client.Client(mqtt_client.CallbackAPIVersion.VERSION2, client_id="cybersentinel-gateway")
        client.on_connect = on_connect
        client.on_disconnect = on_disconnect
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
    """Forward JSON lines from the Arduino into MQTT + local state.

    The firmware emits a `device/log` topic for anything it considers worth
    reporting (missing OLED, unknown command, bad telemetry), and those lines
    are printed here so `journalctl -u cybersentinel-gateway` shows the board's
    own view of what went wrong.
    """
    while True:
        s = MOTORS.serial
        if s is None:
            await asyncio.sleep(3)
            continue
        try:
            line = await asyncio.to_thread(s.readline)
            line = line.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                print(f"[arduino] unparseable line: {line[:120]}")
                mqtt_publish("arduino/raw", {"line": line})
                continue
            topic = data.get("topic")
            value = data.get("value")
            if not topic or value is None:
                print(f"[arduino] line is missing topic/value: {line[:120]}")
                continue
            if topic == "device/log":
                level = str(value.get("level", "info")) if isinstance(value, dict) else "info"
                msg = str(value.get("msg", value)) if isinstance(value, dict) else str(value)
                print(f"[arduino/{level}] {msg}")
                mqtt_publish(topic, value)
                continue
            mqtt_publish(topic, value)
            STATE.latest_sensors[topic] = value
            if topic == "device/health":
                # The board's own claim about itself; the live serial link is
                # what /health trusts, so this only fills in other keys.
                for key, val in value.items():
                    if key != "arduino":
                        STATE.device_health[key] = val
        except Exception as exc:
            # Port disappeared — drop it and retry the reconnect path.
            print(f"[serial] read failed ({type(exc).__name__}: {exc}); reconnecting")
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
        # A malformed angle/speed must not take the whole control socket down.
        try:
            angle = float(data.get("angle", 0))
            speed = int(data.get("speed", 0))
        except (TypeError, ValueError) as exc:
            print(f"[ws] bad MOVE payload {data!r}: {exc}")
            return {"type": "error", "message": f"invalid angle/speed: {exc}"}
        if speed <= 0:
            MOTORS.stop()
            return {"type": "ack", "cmd": cmd, "direction": "STOP"}
        direction = MOTORS.direction_for_angle(angle)
        if not MOTORS.write(direction):
            # The app should know the wheels never got the command.
            return {"type": "error", "cmd": cmd, "message": "serial link is down; command not sent"}
        STATE.rover_status = {**STATE.rover_status, "state": "manual"}
        return {"type": "ack", "cmd": cmd, "direction": direction, "angle": angle}

    if cmd == "SET_SPEED":
        try:
            STATE.speed_limit = int(data.get("value", STATE.speed_limit))
        except (TypeError, ValueError) as exc:
            print(f"[ws] bad SET_SPEED payload {data!r}: {exc}")
            return {"type": "error", "message": f"invalid speed: {exc}"}
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
        if not MOTORS.write("BUZZER"):
            return {"type": "error", "cmd": cmd, "message": "serial link is down; buzzer not sent"}
        return {"type": "ack", "cmd": cmd}

    if cmd == "SPEAK":
        text = str(data.get("text", ""))[:500]
        if not SPEAKER.engine:
            print(f"[ws] SPEAK ignored — no TTS engine available (text: {text[:60]!r})")
        SPEAKER.say(text)
        return {"type": "ack", "cmd": cmd, "speaking": text}

    if cmd == "TTS_STOP":
        SPEAKER.stop()
        return {"type": "ack", "cmd": cmd}

    print(f"[ws] unknown command from app: {data!r}")
    return {"type": "error", "message": f"unknown command: {cmd}"}


async def control_handler(websocket) -> None:
    peer = getattr(websocket, "remote_address", None)
    print(f"[ws] app connected {peer}")
    try:
        async for message in websocket:
            try:
                data = json.loads(message)
            except json.JSONDecodeError as exc:
                print(f"[ws] ignoring malformed frame from {peer}: {exc}")
                continue
            try:
                reply = await handle_command(data)
            except Exception as exc:
                # Never drop a client because one command misbehaved.
                print(f"[ws] command raised {type(exc).__name__}: {exc}")
                reply = {"type": "error", "message": "internal error handling command"}
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
    if not CFG.enable_mdns:
        print("[mdns] disabled by CS_ENABLE_MDNS")
        return
    if Zeroconf is None:
        print("[mdns] zeroconf not installed — the app must discover the Pi by scan")
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
    except Exception as exc:
        # This silently breaks discovery, so it must not stay quiet.
        print(f"[net] could not determine the LAN IP ({exc}); mDNS will advertise 127.0.0.1")
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
    warned_serial = False
    warned_camera = False
    while True:
        # Only the live serial link decides the Arduino's state. Trusting the
        # board's own "online" claim would keep reporting a healthy Arduino
        # after its cable is pulled.
        arduino_online = MOTORS.connected
        camera_online = CAMERA.online
        payload = {
            **STATE.device_health,
            "arduino": "online" if arduino_online else "offline",
            "rover": "online",
            "camera": "online" if camera_online else "offline",
            "pi": pi_stats() or {},
        }
        mqtt_publish("device/health", payload)

        # Warn once per transition instead of once per 10 s.
        if not arduino_online and not warned_serial:
            warned_serial = True
            print(f"[serial] Arduino is offline: {MOTORS.last_error or 'not connected'}")
        elif arduino_online:
            warned_serial = False
        if not camera_online and not warned_camera:
            warned_camera = True
            print(f"[camera] stream is offline: {CAMERA.reason}")
        elif camera_online:
            warned_camera = False

        await asyncio.sleep(10)


def _spawn(name: str, coro) -> asyncio.Task:
    """Start a background task that reports its own failure.

    A task that raises before it starts listening dies silently: the gateway
    keeps serving REST while the control socket is simply absent and the log says
    nothing about it. That is exactly the state where the app reaches the API but
    can never drive the rover, so every task gets a done-callback that prints its
    traceback.
    """
    task = asyncio.create_task(coro, name=name)

    def _report(t: asyncio.Task) -> None:
        if t.cancelled():
            return
        exc = t.exception()
        if exc is not None:
            print(f"[boot] {name} FAILED: {type(exc).__name__}: {exc}")
            traceback.print_exception(type(exc), exc, exc.__traceback__)

    task.add_done_callback(_report)
    return task


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Breadcrumbs. The journal is the only view of this, and a gateway that dies
    # here binds nothing at all - no REST, no control socket, no camera - which is
    # impossible to diagnose from "nothing is listening" on its own.
    print("[boot] loading the incident store")
    load_incidents()
    print("[boot] starting the MQTT client")
    start_mqtt()
    print("[boot] advertising over mDNS")
    start_mdns()
    tasks = [
        _spawn("ws-server", start_ws_server()),
        _spawn("arduino-serial", read_arduino_serial()),
        _spawn("health-publisher", publish_health_loop()),
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
            else:
                print("[pi] no temperature sensors reported (temp shown as 0)")
        except Exception as exc:
            print(f"[pi] could not read the temperature sensor: {exc}")
            temp = None
        return {"cpu": round(load), "ram": round(ram), "temp": temp or 0,
                "uptime": int(time.time() - psutil.boot_time())}
    except Exception as exc:
        print(f"[pi] stats unavailable: {exc}")
        return None


@app.get("/health")
async def health():
    # arduino reflects the live serial link, never the board's own claim:
    # otherwise a pulled cable still reports "online" from a stale heartbeat.
    devices = {
        **STATE.device_health,
        "arduino": "online" if MOTORS.connected else "offline",
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
        "serial": {"port": MOTORS.port, "error": MOTORS.last_error, "connected": MOTORS.connected},
        "camera_info": CAMERA.status(),
        "pi": pi_stats(),
        "speaker": SPEAKER.describe(),
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
    return {
        "tts_engine": SPEAKER.engine,
        "tts_voice": SPEAKER.voice,
        "tts_pitch": CFG.tts_pitch,
        "pi": pi_stats(),
    }


def check_startup() -> int:
    """Report what the gateway can build, without binding any port.

    The fragile work happens at import time: the speaker probe, the camera
    manager, serial discovery. If any of it raises, uvicorn never binds and
    systemd records nothing but an exit code, so this surfaces the real error on
    stdout where setup.sh can show it. Pair it with CS_CAMERA_ENABLE=0 so it is
    guaranteed not to touch the capture device.
    """
    print(f"[check] gateway v{GATEWAY_VERSION} imported cleanly")
    print(f"[check] speaker : {SPEAKER.describe()}")
    print(f"[check] camera  : {CAMERA.status().get('detail')} (source={CAMERA.source})")
    print(f"[check] arduino : {discover_serial_port(CFG.serial_port) or 'no /dev/ttyACM* or /dev/ttyUSB*'}")
    print(f"[check] mqtt    : {CFG.mqtt_broker}:{CFG.mqtt_port}"
          + ("" if mqtt_client is not None else "  (paho-mqtt not installed)"))
    print(f"[check] ports   : api={CFG.api_port} ws={CFG.ws_port} camera={CFG.camera_port}")
    print("[check] OK - the import path is sound; any remaining fault is after startup")
    return 0


if __name__ == "__main__":
    # `--check` builds every subsystem and exits, so a startup failure can be read
    # straight off the console instead of being inferred from a systemd exit code.
    if "--check" in sys.argv[1:]:
        sys.exit(check_startup())
    uvicorn.run(app, host="0.0.0.0", port=CFG.api_port)