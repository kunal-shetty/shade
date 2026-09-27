#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# diagnose-control.sh — find out WHY the app cannot drive the rover.
#
# pi/test-motors.sh proves the BOTTOM half of the control path (sketch ->
# H-bridge -> motors -> USB serial). This script proves the TOP half
# (gateway -> serial port inside the service -> WebSocket -> LAN -> phone),
# one hop at a time, so the failing hop names itself instead of the whole
# thing being reported as "the app doesn't work".
#
#   test-motors.sh works, this script fails   -> the fault is on the Pi
#                                                (gateway process, its serial
#                                                permission, or its ports)
#   both work                                 -> the fault is on the phone
#                                                (host/port in Settings,
#                                                wrong WiFi, cleartext blocked)
#
# Usage:
#   sudo bash pi/diagnose-control.sh              # safe: no wheel movement
#   sudo bash pi/diagnose-control.sh --drive      # also spins the wheels ~1s
#   sudo bash pi/diagnose-control.sh 192.168.0.115 [--drive]
#
# The gateway is left running exactly as it was found, and STOP is sent before
# exiting. LIFT THE ROVER OFF THE GROUND if you pass --drive.
# ---------------------------------------------------------------------------

set -uo pipefail

SERVICE="cybersentinel-gateway"
ENV_FILE="/opt/cybersentinel/gateway.env"
VENV_PY="/opt/cybersentinel/venv/bin/python"

DRIVE=0
HOST=""
for arg in "$@"; do
  case "$arg" in
    --drive) DRIVE=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) HOST="$arg" ;;
  esac
done

# --- output helpers --------------------------------------------------------
if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_BAD=$'\033[31m'; C_WARN=$'\033[33m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_OK=''; C_BAD=''; C_WARN=''; C_DIM=''; C_OFF=''
fi

FAILED=0
ok()   { printf '    %s[ok]%s   %s\n'   "$C_OK"   "$C_OFF" "$1"; }
bad()  { printf '    %s[!!]%s   %s\n'   "$C_BAD"  "$C_OFF" "$1"; FAILED=1; }
warn() { printf '    %s[??]%s   %s\n'   "$C_WARN" "$C_OFF" "$1"; }
note() { printf '    %s%s%s\n'           "$C_DIM"  "$1" "$C_OFF"; }
hop()  { printf '\n==> %s\n' "$1"; }

# --- ports, as the gateway itself sees them --------------------------------
read_env() {   # $1 = key, $2 = default
  local value=""
  if [ -r "$ENV_FILE" ]; then
    value="$(grep -E "^[[:space:]]*$1=" "$ENV_FILE" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d "\"' ")"
  fi
  printf '%s' "${value:-$2}"
}

API_PORT="$(read_env CS_API_PORT 8000)"
WS_PORT="$(read_env CS_WS_PORT 8765)"
CAM_PORT="$(read_env CS_CAMERA_PORT 8080)"
MQTT_PORT="$(read_env CS_MQTT_PORT 1883)"

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
MDNS_NAME="$(read_env CS_HOSTNAME cybersentinel).local"
[ -n "$HOST" ] && LAN_IP_TEST="$HOST" || LAN_IP_TEST="$LAN_IP"

PY="$(command -v python3 || true)"

echo "CyberSentinel control-path diagnosis"
echo "  api=${API_PORT}  ws=${WS_PORT}  mqtt=${MQTT_PORT}  camera=${CAM_PORT}"
echo "  this host: ${LAN_IP:-unknown}   mdns name: ${MDNS_NAME}"

# ---------------------------------------------------------------------------
hop "1. Is the gateway service actually running?"
# ---------------------------------------------------------------------------
# Restart=always hides a crash loop: `systemctl status` says "activating" or
# even "running" while the process dies every few seconds and nothing is
# listening. Only the ports (hop 4) and the API (hop 2) show the truth.
if systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
  UPTIME_S="$(systemctl show -p ActiveEnterTimestampMonotonic --value "$SERVICE" 2>/dev/null || true)"
  ok "$SERVICE is active (main pid $(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null))"
  if [ -n "${UPTIME_S:-}" ] && [ "$UPTIME_S" -lt 15000000 ] 2>/dev/null; then
    warn "it started less than ~15s ago — that smells like a crash loop, check hop 2"
  fi
else
  bad "$SERVICE is NOT active"
  note "sudo systemctl status $SERVICE --no-pager -n 30"
fi

# ---------------------------------------------------------------------------
hop "2. Does the gateway answer its own REST API?"
# ---------------------------------------------------------------------------
# /health reports serial.connected straight from the live MotorBus, so this
# single response tells us whether the service can see the Arduino.
HEALTH="$(curl -fsS --max-time 5 "http://127.0.0.1:${API_PORT}/health" 2>/dev/null || true)"
SERIAL_CONNECTED=""
SERIAL_ERROR=""
SERIAL_PORT=""
if [ -n "$HEALTH" ]; then
  ok "GET /health answered on :${API_PORT}"
  # Parsed by python rather than grep: the JSON is nested, and this is the one
  # field (serial.connected) the whole diagnosis hinges on.
  if [ -n "$PY" ]; then
    REPORT="$(printf '%s' "$HEALTH" | "$PY" -c '
import json, sys

d = json.load(sys.stdin)
s = d.get("serial") or {}
print("         version={}  arduino={}  camera={}".format(
    d.get("version"), d.get("arduino"), d.get("camera")))
print("         speaker={}".format(d.get("speaker")))
print("         reply  ={}".format(d.get("reply")))
print("         serial ={} connected={} error={}".format(
    s.get("port"), s.get("connected"), s.get("error")))
print("__SERIAL__={}".format(1 if s.get("connected") else 0))
' 2>/dev/null || true)"
    printf '%s\n' "$REPORT" | grep -v '^__SERIAL__=' || true
    SERIAL_CONNECTED="$(printf '%s\n' "$REPORT" | sed -n 's/^__SERIAL__=//p' | head -n 1)"
  else
    printf '%s\n' "$HEALTH" | sed 's/^/    /'
  fi
  if [ "${SERIAL_CONNECTED:-0}" = "1" ]; then
    ok "the gateway holds the Arduino open on ${SERIAL_PORT:-?}"
  else
    bad "the gateway does NOT have the serial link (port=${SERIAL_PORT:-none}, error=${SERIAL_ERROR:-none})"
    note "this is the classic 'app does nothing' cause: every MOVE becomes"
    note "'{\"type\":\"error\",\"message\":\"serial link is down\"}' and the app"
    note "ignores error acks, so the screen just sits there. See hops 3 and 4."
  fi
else
  bad "no answer on http://127.0.0.1:${API_PORT}/health"
  note "the service is up but not serving, or it is not up at all. Read its log:"
  note "sudo journalctl -u $SERVICE -n 60 --no-pager"
fi

# ---------------------------------------------------------------------------
hop "3. Can the SERVICE (not you, not sudo) open the serial port?"
# ---------------------------------------------------------------------------
# /dev/ttyACM0 is root:dialout 0660. A process started before `usermod -aG
# dialout` keeps its old group list until it is restarted, which is why this
# works under sudo and fails inside the service.
MAIN_PID="$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null || true)"
DIALOUT_GID="$(getent group dialout | cut -d: -f3 || true)"

SERIAL_NODES="$(ls -1 /dev/ttyACM* /dev/ttyUSB* 2>/dev/null || true)"
if [ -n "$SERIAL_NODES" ]; then
  ok "Arduino node present: $(echo "$SERIAL_NODES" | tr '\n' ' ')"
  for node in $SERIAL_NODES; do
    stat -c '         %n  %A  %U:%G' "$node" 2>/dev/null || true
  done
else
  bad "no /dev/ttyACM* or /dev/ttyUSB* — the Uno is not enumerated"
  note "use a data cable, or re-plug it: lsusb | grep -i arduino"
fi

if [ -n "${MAIN_PID:-}" ] && [ "$MAIN_PID" != "0" ] && [ -r "/proc/$MAIN_PID/status" ]; then
  SERVICE_GROUPS="$(awk '/^Groups:/{ $1=""; print; exit }' "/proc/$MAIN_PID/status" 2>/dev/null || true)"
  if [ -n "${DIALOUT_GID:-}" ] && printf ' %s ' "$SERVICE_GROUPS" | grep -q " ${DIALOUT_GID} "; then
    ok "gateway pid $MAIN_PID holds the dialout group (gid ${DIALOUT_GID})"
  else
    bad "gateway pid $MAIN_PID does NOT hold the dialout group (gid ${DIALOUT_GID:-?})"
    note "fix for good:  sudo usermod -aG dialout \$USER && sudo reboot"
    note "fix right now: sudo systemctl restart $SERVICE   (systemd re-reads groups)"
  fi
  SERVICE_USER="$(ps -o user= -p "$MAIN_PID" 2>/dev/null | tr -d ' ')"
  printf '         service runs as: %s\n' "${SERVICE_USER:-unknown}"
else
  warn "could not read the running gateway's group list (it is not running?)"
fi

# ---------------------------------------------------------------------------
hop "4. Is anything listening, and is it bound to the LAN?"
# ---------------------------------------------------------------------------
LISTEN="$(ss -ltnp 2>/dev/null | grep -E ":(${API_PORT}|${WS_PORT}|${CAM_PORT}|${MQTT_PORT}|9001)[[:space:]]" || true)"
if [ -n "$LISTEN" ]; then
  printf '%s\n' "$LISTEN" | sed 's/^/         /'
else
  bad "no listener on ${API_PORT}/${WS_PORT}/${CAM_PORT}/${MQTT_PORT}/9001"
  note "the gateway never got as far as binding. See hop 1's journalctl."
fi

for spec in "api:${API_PORT}" "ws:${WS_PORT}" "camera:${CAM_PORT}" "mqtt-ws:9001"; do
  label="${spec%%:*}"; port="${spec##*:}"
  if printf '%s\n' "$LISTEN" | grep -q ":${port}[[:space:]]"; then
    ok "${label} port ${port} is listening"
  else
    bad "${label} port ${port} is NOT listening"
  fi
done

# ---------------------------------------------------------------------------
hop "5. Can a client reach the control port over the network?"
# ---------------------------------------------------------------------------
# Connecting to the machine's own LAN IP still traverses the INPUT chain, so a
# firewall that blocks the phone is caught here too.
tcp_check() {   # $1 = host, $2 = port
  (exec 3<>"/dev/tcp/$1/$2") 2>/dev/null || return 1
  exec 3<&- 2>/dev/null || true
  exec 3>&- 2>/dev/null || true
  return 0
}

if tcp_check 127.0.0.1 "$WS_PORT"; then
  ok "TCP 127.0.0.1:${WS_PORT} accepts connections"
else
  bad "TCP 127.0.0.1:${WS_PORT} refused"
fi

if [ -n "${LAN_IP_TEST:-}" ]; then
  if tcp_check "$LAN_IP_TEST" "$WS_PORT"; then
    ok "TCP ${LAN_IP_TEST}:${WS_PORT} accepts connections (binding + firewall are fine)"
  else
    bad "TCP ${LAN_IP_TEST}:${WS_PORT} refused — bound to localhost only, or blocked"
    note "sudo ufw status ; sudo ufw allow ${WS_PORT}/tcp"
  fi
fi

if tcp_check "127.0.0.1" "$API_PORT"; then
  ok "TCP :${API_PORT} (REST) accepts connections"
else
  bad "TCP :${API_PORT} (REST) refused"
fi

# The app's default host is the mDNS name; if nss-mdns is missing it fails on
# the Pi too, and the app's subnet-scan discovery has to rescue it.
if [ "$MDNS_NAME" != ".local" ] && tcp_check "$MDNS_NAME" "$API_PORT"; then
  ok "${MDNS_NAME} resolves and reaches :${API_PORT}"
elif [ -n "$PY" ]; then
  if "$PY" -c 'import socket,sys; socket.getaddrinfo(sys.argv[1], None)' "$MDNS_NAME" >/dev/null 2>&1; then
    ok "${MDNS_NAME} resolves"
  else
    warn "${MDNS_NAME} does not resolve here — set the app's host to the IP instead"
    note "sudo apt-get install -y libnss-mdns avahi-daemon && sudo systemctl restart avahi-daemon"
  fi
fi

if command -v ufw >/dev/null 2>&1; then
  UFW="$(ufw status 2>/dev/null | head -n 1 || true)"
  case "$UFW" in
    *inactive*) ok "ufw is inactive (nothing is firewalled)" ;;
    "") warn "could not read ufw status (run with sudo to be sure)" ;;
    *) warn "ufw: ${UFW}"; note "sudo ufw allow from any to any port ${WS_PORT} proto tcp" ;;
  esac
fi

# ---------------------------------------------------------------------------
hop "6. End-to-end: speak the app's own protocol to the gateway"
# ---------------------------------------------------------------------------
# This is exactly what the phone sends — connect, PING, SET_SPEED, (MOVE), STOP
# — so its answer is the answer: if this passes, the Pi is innocent and the
# phone is the problem.
if [ -z "$HOST" ] && [ -n "${LAN_IP:-}" ]; then
  WS_TARGET="$LAN_IP"      # prefer the address the phone should use
else
  WS_TARGET="${HOST:-127.0.0.1}"
fi

if [ ! -x "$VENV_PY" ]; then
  warn "no venv python at ${VENV_PY} — skipping the live WebSocket test"
else
  printf '    %s-> ws://%s:%s (drive=%s)%s\n' "$C_DIM" "$WS_TARGET" "$WS_PORT" "$DRIVE" "$C_OFF"
  WS_HOST="$WS_TARGET" WS_PORT="$WS_PORT" WS_DRIVE="$DRIVE" "$VENV_PY" - <<'PY'
import asyncio, json, os, sys

try:
    import websockets
except Exception as exc:                      # noqa: BLE001
    print(f"[skip] websockets unavailable: {exc}")
    sys.exit(3)

HOST = os.environ["WS_HOST"]
PORT = int(os.environ["WS_PORT"])
DRIVE = os.environ.get("WS_DRIVE") == "1"
BROKEN = False


def ok(msg):   print(f"    [ok]   {msg}")
def bad(msg):  print(f"    [!!]   {msg}")


async def main() -> int:
    uri = f"ws://{HOST}:{PORT}"
    try:
        ws = await asyncio.wait_for(websockets.connect(uri), timeout=6)
    except Exception as exc:                  # noqa: BLE001
        print(f"    [!!]   cannot open {uri}: {type(exc).__name__}: {exc}")
        return 1
    try:
        ok(f"websocket opened: {uri}")

        async def ask(payload, label):
            await ws.send(json.dumps(payload))
            raw = await asyncio.wait_for(ws.recv(), timeout=8)
            print(f"           {label:<26} -> {raw}")
            try:
                return json.loads(raw)
            except Exception:                 # noqa: BLE001
                return {}

        await ask({"cmd": "PING"}, "PING")
        await ask({"cmd": "SET_SPEED", "value": 60}, "SET_SPEED 60")

        if DRIVE:
            ack = await ask({"cmd": "MOVE", "angle": 0, "speed": 60}, "MOVE angle=0 speed=60")
            await asyncio.sleep(1.0)
            await ask({"cmd": "STOP"}, "STOP")
            if ack.get("type") == "error":
                bad(f"the gateway refused the MOVE: {ack.get('message')}")
                return 1
            if ack.get("direction") != "FORWARD":
                bad(f"unexpected direction {ack.get('direction')!r} for angle 0")
                return 1
            ok("the gateway accepted the MOVE and wrote FORWARD to the Arduino")
        else:
            await ask({"cmd": "STOP"}, "STOP")
            ok("control protocol answered (re-run with --drive to prove the wheels)")
        return 0
    finally:
        try:
            await ws.close()
        except Exception:                     # noqa: BLE001
            pass


sys.exit(asyncio.run(main()))
PY
  WS_RC=$?
  case "$WS_RC" in
    0) ok "the app's protocol works from this machine on ${WS_TARGET}" ;;
    1) bad "the WebSocket path is broken — see the refusal above" ;;
    3) warn "test skipped (websockets module missing from the venv)" ;;
    *) bad "the WebSocket test fell over (exit ${WS_RC})" ;;
  esac
fi

# ---------------------------------------------------------------------------
hop "What you should put in the app (Settings -> Connection)"
# ---------------------------------------------------------------------------
printf '    host          %s   (enter this IP; Android does NOT resolve the mDNS name %s)\n' "${LAN_IP:-<pi-ip>}" "$MDNS_NAME"
printf '    ws port       %s    (rover control)\n' "$WS_PORT"
printf '    api port      %s    (REST / discovery probe)\n' "$API_PORT"
printf '    mqtt port     %s    (telemetry over WebSocket)\n' "9001"
printf '    stream port   %s    (/stream.mjpg)\n' "$CAM_PORT"
printf '    demo mode     must be OFF, or the app only drives its own fake rover\n'

WIFI="$(iwgetid -r 2>/dev/null || true)"
[ -n "$WIFI" ] && printf '    this WiFi     %s   (the phone must be on the same one)\n' "$WIFI"

# ---------------------------------------------------------------------------
echo
if [ "$FAILED" = 0 ]; then
  echo "==> Result: every hop on the Pi passed."
  echo "    The gateway can drive the motors, so the fault is on the phone side:"
  echo "      * Settings -> Connection: host/ports as printed above, demo mode OFF"
  echo "      * the phone is on the same WiFi as the Pi (not mobile data)"
  echo "      * the rover-control header shows READY + a latency in ms; if it"
  echo "        shows DOWN the socket never opened — fix the address first"
  echo "      * a RELEASE apk can silently block plain ws:// and http:// traffic"
  echo "        (Android cleartext policy). If the camera feed is also black,"
  echo "        that is almost certainly it: rebuild with"
  echo "        expo-build-properties android.usesCleartextTraffic = true"
else
  echo "==> Result: the Pi side is broken. Fix the [!!] lines above, top down:"
  echo "    hop 1/4  service not up      -> journalctl -u cybersentinel-gateway -n 60 --no-pager"
  echo "    hop 3    no /dev/ttyACM* / /dev/ttyUSB* -> re-seat or swap the USB cable,"
  echo "             check the Uno's power LED, then: lsusb | grep -i arduino"
  echo "             (only if a node exists but lacks access: usermod -aG dialout \$USER)"
  echo "    hop 5    port refused         -> binding or firewall"
  echo "    then re-run this script; it should end with 'every hop passed'."
fi
echo
echo "Compare against: sudo bash pi/test-motors.sh   (proves firmware + wiring)"
