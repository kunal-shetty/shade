#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# test-motors.sh — drive the rover's motors DIRECTLY over the Arduino's USB
# serial link, without going through the gateway.
#
# Why bypass the gateway? It splits the control path in half so a failure
# tells you *which* half is broken:
#
#   * wheels move here  -> the firmware, the wiring and the serial link are
#                          all fine, so a "motors don't work" symptom in the
#                          app is a gateway problem;
#   * nothing moves     -> the problem is below the Pi's software (power,
#                          wiring, H-bridge, or the sketch itself).
#
# Usage:
#   sudo bash pi/test-motors.sh                  # auto-detect the port
#   sudo bash pi/test-motors.sh /dev/ttyACM0     # name the port yourself
#   CS_KEEP_GATEWAY=1 sudo -E bash pi/test-motors.sh   # leave the service alone
#
# LIFT THE ROVER OFF THE GROUND BEFORE RUNNING THIS — the wheels spin.
# ---------------------------------------------------------------------------

set -uo pipefail

SERVICE="cybersentinel-gateway"
BAUD=115200
HOLD=1.5   # seconds each direction is held

PORT="${1:-}"

# ---------------------------------------------------------------------------
# 1. Find the Arduino
# ---------------------------------------------------------------------------
if [ -z "$PORT" ]; then
  for pattern in /dev/ttyACM* /dev/ttyUSB*; do
    if [ -e "$pattern" ]; then PORT="$pattern"; break; fi
  done
fi

if [ -z "$PORT" ] || [ ! -e "$PORT" ]; then
  echo "!! No Arduino serial port found."
  echo "   Is the Uno plugged into the Pi with a USB *data* cable?"
  echo "   Check with:  ls /dev/ttyACM* /dev/ttyUSB*"
  exit 1
fi

echo "==> Using serial port: $PORT @ ${BAUD} baud"
if [ ! -w "$PORT" ]; then
  echo "!! $PORT is not writable by $(id -un)."
  echo "   Either run this with sudo, or add your user to the dialout group:"
  echo "     sudo usermod -aG dialout $USER   # then log out and back in"
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. Release the port from the gateway
#
# The running service holds /dev/ttyACM0 open, and a write against a held port
# can silently go nowhere. Stop it for the duration and always start it again.
# ---------------------------------------------------------------------------
STOPPED=0
if [ "${CS_KEEP_GATEWAY:-0}" != "1" ] && systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
  echo "==> Stopping $SERVICE so it lets go of $PORT"
  systemctl stop "$SERVICE"
  STOPPED=1
  sleep 1
fi

READ_LOG="$(mktemp)"
: > "$READ_LOG"

# Always leave the rover stopped, and always put the service back.
cleanup() {
  [ -n "${READER_PID:-}" ] && kill "$READER_PID" 2>/dev/null
  printf 'STOP\n' > "$PORT" 2>/dev/null
  if [ "$STOPPED" = 1 ]; then
    echo "==> Restarting $SERVICE"
    systemctl start "$SERVICE"
  fi
  [ -n "${READ_LOG:-}" ] && rm -f "$READ_LOG"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 3. Open the line and start listening to the Arduino
#
# The sketch prints one JSON object per line: a heartbeat every 2 s, and log
# lines for anything it dislikes. Reading it back proves the link is two-way,
# not just that we can shout into it.
# ---------------------------------------------------------------------------
stty -F "$PORT" "$BAUD" raw -echo 2>/dev/null || true
( timeout 90 cat "$PORT" >> "$READ_LOG" 2>/dev/null ) &
READER_PID=$!
sleep 0.5

drive() {             # $1 = firmware command, $2 = what you should see
  printf '  -> %-8s (%.1fs)  expect: %s\n' "$1" "$HOLD" "$2"
  printf '%s\n' "$1" > "$PORT"
  sleep "$HOLD"
  printf 'STOP\n' > "$PORT"
  sleep 0.4
}

# ---------------------------------------------------------------------------
# 4. Run the sequence
# ---------------------------------------------------------------------------
echo
echo "==> Watch the wheels. If they are on the ground, watch which way it goes."
echo

drive FORWARD  "both wheels spin FORWARD"
drive BACKWARD "both wheels spin BACKWARD"
drive LEFT     "wheels oppose: left back, right forward (turns left)"
drive RIGHT    "wheels oppose: left forward, right back (turns right)"

printf '  -> %-8s (0.5s)  expect: the buzzer sounds\n' "BUZZER"
printf 'BUZZER\n' > "$PORT"
sleep 0.5
printf 'STOP\n' > "$PORT"

# ---------------------------------------------------------------------------
# 5. Read back what the Arduino had to say
# ---------------------------------------------------------------------------
sleep 0.5
echo
echo "==> The Arduino replied:"
if [ -s "$READ_LOG" ]; then
  tail -n 20 "$READ_LOG" | sed 's/^/    /'
else
  echo "    (nothing) — the Pi can write but not read the link."
fi

echo
echo "==> How to read the result"
if grep -q 'arduino.*online' "$READ_LOG" 2>/dev/null; then
  echo "    [ok]   The Uno is talking back (heartbeat received)."
else
  echo "    [--]   No heartbeat. Check the USB cable, and that the sketch"
  echo "           was actually flashed:  ls /dev/ttyACM*  then reflash."
fi
echo "    Wheels turned but buzzer silent  -> check the buzzer on D12."
echo "    One side dead                    -> that H-bridge channel / motor."
echo "    All four IN pins move nothing    -> H-bridge VCC(motor) supply."
echo "    Wrong direction for LEFT/RIGHT   -> swap that motor's two output wires."
echo "    Nothing at all, but heartbeat ok -> the sketch's motors never ran;"
echo "                                        re-run: sudo bash pi/flash-arduino.sh"
echo
echo "    Wheels moving here means the gateway is the only thing left to fix."
