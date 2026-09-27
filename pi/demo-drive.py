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
import signal
import subprocess
import sys
import time

BAUD = 115200
WIFI_WAIT_S = 120          # max seconds to wait for a default route
PORT_RETRY_S = 10          # seconds between serial-port attempts
STEP_SECONDS = float(os.getenv("CS_DEMO_STEP", "4"))
GREETING = os.getenv("CS_BOOT_GREETING", "Good morning Mohini maam")
VOICE = os.getenv("CS_TTS_VOICE", "en+f3")
PITCH = os.getenv("CS_TTS_PITCH", "70")
RATE = os.getenv("CS_TTS_RATE", "150")
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


def speak(text: str) -> None:
    for engine in ("espeak-ng", "espeak"):
        if subprocess.run(["which", engine], capture_output=True).returncode == 0:
            log(f"saying: {text}")
            subprocess.run(
                [engine, "-v", VOICE, "-p", PITCH, "-s", RATE, text],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            return
    log("no TTS engine installed — greeting skipped")


def open_serial():
    import serial  # pyserial, guaranteed present in the gateway venv
    while True:
        for path in sorted(glob.glob("/dev/ttyACM*") + glob.glob("/dev/ttyUSB*")):
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
                log(f"{path}: {exc}")
        log(f"no Arduino yet — retrying in {PORT_RETRY_S}s (unplug = safe state)")
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
