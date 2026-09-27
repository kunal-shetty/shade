#!/usr/bin/env python3
"""CyberSentinel boot demo — the rover greets and drives itself.

No gateway, no app, no server: this standalone script
  1. waits briefly for the Arduino's USB serial port (the ONE hard requirement)
  2. says the greeting on the Pi speaker (espeak-ng -> WAV -> best player)
  3. loops forever: FORWARD -> LEFT -> RIGHT -> BACKWARD (CS_DEMO_STEP s each)

Safety: SIGTERM/SIGINT/exceptions always write STOP before exiting.

Tunables via gateway.env (or the process environment):
  CS_BOOT_GREETING   the line spoken at start   (default "Good morning Mohini maam")
  CS_DEMO_STEP       seconds per movement       (default 4)
  CS_TTS_VOICE / CS_TTS_RATE / CS_TTS_PITCH / CS_TTS_AMPLITUDE  espeak shaping
  CS_AUDIO_DEVICE    force an ALSA device (e.g. plughw:1,0); auto-walks if unset
"""

import glob
import os
import shutil
import signal
import subprocess
import sys
import time

BAUD = 115200
PORT_WAIT_S = 60           # seconds to wait for the Uno to enumerate
PORT_RETRY_S = 5           # between attempts afterwards
STEP_SECONDS = float(os.getenv("CS_DEMO_STEP", "4"))
GREETING = os.getenv("CS_BOOT_GREETING", "Good morning Mohini maam")
VOICE = os.getenv("CS_TTS_VOICE", "en-us+f3")
PITCH = os.getenv("CS_TTS_PITCH", "65")
RATE = os.getenv("CS_TTS_RATE", "135")
AMPLITUDE = os.getenv("CS_TTS_AMPLITUDE", "150")
AUDIO_DEVICE = os.getenv("CS_AUDIO_DEVICE", "")   # e.g. plughw:1,0
SEQUENCE = ["FORWARD", "LEFT", "RIGHT", "BACKWARD"]

log = lambda m: print(f"[demo] {time.strftime('%H:%M:%S')} {m}", flush=True)


def wait_for_serial_path() -> str:
    deadline = time.time() + PORT_WAIT_S
    while True:
        nodes = sorted(glob.glob("/dev/ttyACM*") + glob.glob("/dev/ttyUSB*"))
        if nodes:
            return nodes[0]
        if time.time() > deadline:
            log(f"no Arduino after {PORT_WAIT_S}s — will keep retrying in the background")
            return ""
        log("waiting for the Arduino USB port …")
        time.sleep(2)


def open_serial():
    import serial  # pyserial, installed system-wide by setup.sh
    while True:
        path = wait_for_serial_path()
        if not path:
            time.sleep(PORT_RETRY_S)
            continue
        try:
            ser = serial.Serial(path, BAUD, timeout=1)
            log(f"serial link on {path}")
            # Opening the port resets the Uno (~2 s bootloader); let it settle,
            # then park the motors before anything moves.
            time.sleep(2.5)
            ser.write(b"STOP\n")
            ser.flush()
            return ser
        except Exception as exc:
            log(f"{path}: {exc} — retrying in {PORT_RETRY_S}s")
            time.sleep(PORT_RETRY_S)


def speak(text: str) -> None:
    """Text-to-speech on the Pi speaker: espeak-ng renders a WAV, then every
    player/device is tried until one is audible. No audio file is shipped —
    the voice is synthesized from the text every time."""
    wav = "/tmp/cs_greet.wav"
    engines = [e for e in ("espeak-ng", "espeak")
               if shutil.which(e)]
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

    # Forced device first (CS_AUDIO_DEVICE), then the session players, then
    # raw ALSA devices that work under sudo / before PipeWire is up.
    players = []
    if AUDIO_DEVICE:
        players.append(["aplay", "-q", "-D", AUDIO_DEVICE, wav])
    players += [
        ["paplay", wav],
        ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", wav],
        ["aplay", "-q", wav],
        ["aplay", "-q", "-D", "plughw:0,0", wav],
        ["aplay", "-q", "-D", "plughw:1,0", wav],
        ["aplay", "-q", "-D", "plughw:2,0", wav],
    ]
    for cmd in players:
        if shutil.which(cmd[0]) is None:
            continue
        log("playing via " + " ".join(cmd[:2] + (cmd[3:4] if len(cmd) > 3 else [])))
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=30)
        except Exception as exc:
            log(f"{cmd[0]} blew up: {exc}")
            continue
        if r.returncode == 0:
            return
        err = r.stderr.decode(errors="replace").strip().splitlines()
        log(f"{cmd[0]} silent ({err[-1][:120] if err else 'exit ' + str(r.returncode)})")
    log("no audio path worked — on the Pi run: aplay -l ; sudo raspi-config (Audio)")


def main() -> int:
    ser = open_serial()          # the only hard dependency — motors first

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

    speak(GREETING)              # wheels are safe and parked; now talk

    log(f"demo loop started: {' -> '.join(SEQUENCE)}, {STEP_SECONDS:.0f}s each, forever")
    try:
        while True:
            for step in SEQUENCE:
                ser.write(f"{step}\n".encode())
                ser.flush()
                log(step)
                time.sleep(STEP_SECONDS)
                stop_motors()
                time.sleep(0.5)  # a beat between moves so turns don't smear
            log("loop — again")
    except Exception as exc:
        log(f"fault: {exc} — stopping the motors")
        stop_motors()
        return 1
    finally:
        stop_motors()


if __name__ == "__main__":
    sys.exit(main())
