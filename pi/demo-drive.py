#!/usr/bin/env python3
"""CyberSentinel boot demo — the rover drives itself, no app or server involved.

Sequence on every power-up:
  1. wait for WiFi (bounded, then proceeds offline anyway)
  2. say the greeting on the Pi speaker (espeak-ng)
  3. loop forever with a fixed rhythm, writing direction words straight to the
     Arduino over USB serial — the same words gateway.py writes:
         FORWARD -> LEFT -> RIGHT -> BACKWARD -> (STOP) -> repeat
     each step lasts CS_DEMO_STEP seconds (default 4).

Safety: SIGTERM/SIGINT (systemd stop, reboot) and any exception always STOP the
motors before exiting. Tunables come from gateway.env:
  CS_BOOT_GREETING  line spoken at start   (default "Good morning Mohini maam")
  CS_DEMO_STEP      seconds per movement   (default 4)
  CS_TTS_VOICE / CS_TTS_PITCH / CS_TTS_RATE  espeak voice shaping
"""

import glob
import os
import shutil
import signal
import subprocess
import sys
import time

BAUD = 115200
WIFI_WAIT_S = 120          # max seconds to wait for a default route
PORT_RETRY_S = 10          # seconds between serial-port attempts
STEP_SECONDS = float(os.getenv("CS_DEMO_STEP", "4"))
GREETING = os.getenv("CS_BOOT_GREETING", "Good morning Mohini maam")
VOICE = os.getenv("CS_TTS_VOICE", "en-us+f3")
PITCH = os.getenv("CS_TTS_PITCH", "65")
RATE = os.getenv("CS_TTS_RATE", "135")
AMPLITUDE = os.getenv("CS_TTS_AMPLITUDE", "150")
SEQUENCE = ["FORWARD", "LEFT", "RIGHT", "BACKWARD"]

log = lambda m: print(f"[demo] {m}", flush=True)


def wait_for_wifi() -> None:
    waited = 0
    while waited < WIFI_WAIT_S:
        route = subprocess.run(
            ["ip", "route", "show", "default"],
            capture_output=True, text=True,
        ).stdout.strip()
        if route:
            log(f"network is up after {waited}s: {route.split()[2] if len(route.split()) > 2 else route}")
            time.sleep(2)          # let DHCP/DNS fully settle
            return
        time.sleep(2)
        waited += 2
    log(f"no network after {WIFI_WAIT_S}s — starting anyway")


def wait_for_usb_serial() -> str:
    """Block until the Uno enumerates, so the demo never speaks then stalls."""
    while True:
        nodes = sorted(glob.glob("/dev/ttyACM*") + glob.glob("/dev/ttyUSB*"))
        if nodes:
            return nodes[0]
        log("waiting for the Arduino USB port …")
        time.sleep(2)


def speak(text: str) -> None:
    """Say `text` on the Pi speaker, surviving Bookworm's audio stack.

    espeak-ng renders to a WAV first (it has no audio-device options of its
    own), then every player/device is tried until one actually plays:
      paplay (PipeWire session — the normal desktop path)
      ffplay (setup.sh installs ffmpeg)
      aplay on the default device, then plughw:0,0 and plughw:1,0 — these talk
      to ALSA directly, so they work even under sudo or before PipeWire is up,
      and they hit whichever card is the real one (jack vs HDMI).
    """
    wav = "/tmp/cs_greet.wav"
    engines = [e for e in ("espeak-ng", "espeak")
               if subprocess.run(["which", e], capture_output=True).returncode == 0]
    if not engines:
        log("no TTS engine installed — greeting skipped")
        return

    rendered = False
    for engine in engines:
        try:
            r = subprocess.run(
                [engine, "-v", VOICE, "-p", PITCH, "-s", RATE, "-a", AMPLITUDE,
                 "-w", wav, text],
                capture_output=True, timeout=30,
            )
        except Exception as exc:
            log(f"{engine} render blew up: {exc}")
            continue
        if r.returncode == 0 and os.path.isfile(wav) and os.path.getsize(wav) > 1000:
            rendered = True
            break
        log(f"{engine} render failed: {r.stderr.decode(errors='replace').strip()[:120]}")
    if not rendered:
        log("could not render speech — greeting skipped")
        return

    players = (
        ["paplay", wav],
        ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", wav],
        ["aplay", "-q", wav],
        ["aplay", "-q", "-D", "plughw:0,0", wav],
        ["aplay", "-q", "-D", "plughw:1,0", wav],
    )
    for cmd in players:
        if shutil.which(cmd[0]) is None:
            continue
        log("playing via " + " ".join(cmd))
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=30)
        except Exception as exc:
            log(f"{cmd[0]} blew up: {exc}")
            continue
        if r.returncode == 0:
            return
        err = r.stderr.decode(errors='replace').strip().splitlines()
        log(f"{cmd[0]} silent ({err[-1][:120] if err else 'exit ' + str(r.returncode)})")
    log("no audio path worked — on the Pi run: aplay -l ; pactl info")


def open_serial():
    import serial  # pyserial, guaranteed present in the gateway venv
    path = wait_for_usb_serial()
    while True:
        try:
            ser = serial.Serial(path, BAUD, timeout=1)
            log(f"serial link on {path}")
            # A fresh open resets the Uno (~2 s bootloader); give it air,
            # then park the motors before the choreography starts.
            time.sleep(2.5)
            ser.write(b"STOP\n")
            ser.flush()
            return ser
        except Exception as exc:
            log(f"{path}: {exc} — retrying in {PORT_RETRY_S}s")
            time.sleep(PORT_RETRY_S)


def main() -> int:
    wait_for_wifi()
    speak(GREETING)

    ser = open_serial()

    def stop_motors() -> None:
        try:
            ser.write(b"STOP\n")
            ser.flush()
        except Exception:
            pass

    def on_signal(signum, _frame):
        log(f"signal {signum} — stopping the motors and exiting")
        stop_motors()
        sys.exit(0)

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    log(f"demo loop started: {' -> '.join(SEQUENCE)}, {STEP_SECONDS:.0f}s each, forever")
    try:
        while True:
            for step in SEQUENCE:
                ser.write(f"{step}\n".encode())
                ser.flush()
                log(step)
                time.sleep(STEP_SECONDS)
                stop_motors()
                time.sleep(0.5)    # a beat between moves so turns don't smear
            log("loop — again")
    except Exception as exc:
        log(f"fault: {exc} — stopping the motors")
        stop_motors()
        return 1
    finally:
        stop_motors()


if __name__ == "__main__":
    sys.exit(main())
