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
            # exclusive=True keeps the gateway (if it is also running) from
            # opening the same port: two writers interleave bytes and the Uno
            # receives garbled half-commands — the "rover suddenly froze" bug.
            try:
                ser = serial.Serial(path, BAUD, timeout=1, exclusive=True)
            except TypeError:          # very old pyserial without the kwarg
                ser = serial.Serial(path, BAUD, timeout=1)
                try:
                    import fcntl, termios
                    fcntl.ioctl(ser.fileno(), termios.TIOCEXCL)
                except Exception:
                    pass
            log(f"serial link on {path} (exclusive)")
            # Opening the port resets the Uno (~2 s bootloader); let it settle,
            # then park the motors before anything moves.
            time.sleep(2.5)
            ser.write(b"STOP\n")
            ser.flush()
            return ser
        except Exception as exc:
            log(f"{path}: {exc} — retrying in {PORT_RETRY_S}s")
            time.sleep(PORT_RETRY_S)


def render_wav(text: str, wav: str) -> bool:
    """Synthesize `text` to a WAV with the hardcoded espeak-ng flags."""
    try:
        r = subprocess.run(
            ["espeak-ng", "-v", "en-us+f3", "-s", "135", "-p", "65",
             "-a", "150", "-w", wav, text],
            capture_output=True, timeout=30,
        )
    except FileNotFoundError:
        log("espeak-ng not found")
        return False
    except Exception as exc:
        log(f"espeak-ng render blew up: {exc}")
        return False
    if r.returncode == 0 and os.path.isfile(wav) and os.path.getsize(wav) > 1000:
        return True
    log("espeak-ng render failed: " + r.stderr.decode(errors='replace').strip()[:150])
    return False


def play(argv) -> bool:
    """Run one player command; True only on a clean exit."""
    if shutil.which(argv[0]) is None:
        return False
    log("playing via " + " ".join(argv[:4]))
    try:
        r = subprocess.run(argv, capture_output=True, timeout=30)
    except Exception as exc:
        log(f"{argv[0]} blew up: {exc}")
        return False
    if r.returncode == 0:
        return True
    err = r.stderr.decode(errors="replace").strip().splitlines()
    log(f"{argv[0]} silent ({err[-1][:120] if err else 'exit ' + str(r.returncode)})")
    return False


def speak(text: str) -> None:
    """Say `text` on the Pi speaker.

    ORDER MATTERS on this Pi: aplay -l shows ONLY two HDMI cards (the TV!) and
    the 3.5mm jack — the default route lands on HDMI, which is why the greeting
    was heard on the TV. So:
      0. CS_AUDIO_DEVICE (gateway.env, e.g. plughw:2,0 for the jack) WINS —
         render a WAV and play it on exactly that card.
      1. the hardcoded direct command (goes to the system default route),
      2. a walk over every remaining player/device as a last resort.
    """
    wav = "/tmp/cs_greet.wav"

    # --- 0. pinned device beats the (HDMI-leaning) default route ----------
    if AUDIO_DEVICE:
        if render_wav(text, wav) and play(["aplay", "-q", "-D", AUDIO_DEVICE, wav]):
            return
        log(f"pinned device {AUDIO_DEVICE} failed — falling back")

    # --- 1. the hardcoded, known-good direct invocation -------------------
    log("saying (direct espeak): " + text)
    try:
        r = subprocess.run(
            ["espeak-ng", "-v", "en-us+f3", "-s", "135", "-p", "65",
             "-a", "150", text],
            capture_output=True, timeout=30,
        )
        if r.returncode == 0:
            return
        log("direct espeak-ng failed: "
            + r.stderr.decode(errors='replace').strip()[:150])
    except FileNotFoundError:
        log("espeak-ng not found")
    except Exception as exc:
        log(f"direct espeak-ng blew up: {exc}")

    # --- 2. fallback: WAV + walk every player/device ----------------------
    if not render_wav(text, wav):
        log("could not render speech — greeting skipped")
        return

    # Walk every remaining player/device. The jack (card 2 = bcm2835
    # Headphones) is tried BEFORE the HDMI cards so a circular-plug speaker
    # wins over the TV.
    for argv in (
        ["paplay", wav],
        ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", wav],
        ["aplay", "-q", "-D", "plughw:2,0", wav],
        ["aplay", "-q", "-D", "plughw:0,0", wav],
        ["aplay", "-q", "-D", "plughw:1,0", wav],
        ["aplay", "-q", wav],
    ):
        if play(argv):
            return
    log("no audio path worked — on the Pi run: aplay -l ; sudo raspi-config (Audio)")


def main() -> int:
    speak(GREETING)              # wheels are safe and parked; now talk

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
