#!/usr/bin/env bash
# CyberSentinel Rover — Raspberry Pi provisioning
#
# Turns a fresh Raspberry Pi OS (Bookworm, 64-bit) into the rover gateway:
#   * mDNS so the phone finds it as cybersentinel.local
#   * Mosquitto MQTT with a websockets listener for the app
#   * a text-to-speech engine driving the speaker
#   * the FastAPI gateway as a systemd service
#
# Usage (on the Pi, from the repo root):  sudo bash pi/setup.sh
#
# Safe to re-run. A Mosquitto problem is reported but does NOT stop the rest of
# the provisioning, so you can fix the broker afterwards.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="/opt/cybersentinel"
RUN_USER="${SUDO_USER:-pi}"
HOSTNAME_TARGET="cybersentinel"
MOSQ_WS_CHECK_PORT=19001
CAMERA_NEEDS_REBOOT=0
CAMERA_PKG_MISSING=0

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

if [[ "$(id -u)" -ne 0 ]]; then
  die "Run this with sudo:  sudo bash pi/setup.sh"
fi
[[ -f "${REPO_DIR}/gateway.py" && -f "${REPO_DIR}/pi/mosquitto.conf" ]] \
  || die "Cannot find the repo files next to this script (looked in ${REPO_DIR}). Run it from inside the cloned repo."

# ---------------------------------------------------------------------------
# System packages
# ---------------------------------------------------------------------------
log "Installing system packages"
apt-get update || die "apt-get update failed (no network?)"
apt-get install -y python3-venv python3-pip \
  mosquitto mosquitto-clients \
  avahi-daemon libnss-mdns \
  espeak-ng alsa-utils \
  ffmpeg v4l-utils || die "apt-get install failed (core packages)"

# ---------------------------------------------------------------------------
# CSI camera stack (Picamera2)
#
# Deliberately NOT in the block above. python3-picamera2 is tied to a matching
# libcamera build, so on an older or a newer Raspberry Pi OS release it can be
# missing or held back by a dependency. Letting that one package abort the run
# used to leave a Pi with no broker, no gateway and no motors — a far worse
# outcome than a camera that needs a second look. So: core packages are fatal,
# the camera package is loud but survivable.
# ---------------------------------------------------------------------------
log "Installing the CSI camera stack (python3-picamera2)"
if dpkg -s python3-picamera2 >/dev/null 2>&1; then
  log "python3-picamera2 is already installed"
elif apt-get install -y python3-picamera2; then
  log "python3-picamera2 installed"
else
  CAMERA_PKG_MISSING=1
  warn "Could not install python3-picamera2 — the CSI camera cannot stream without it."
  warn "  It ships with Raspberry Pi OS Bookworm (64-bit); check availability with:"
  warn "    apt-cache policy python3-picamera2"
  warn "  Fix the apt source or the OS release, then re-run:  sudo bash pi/setup.sh"
fi

# Optional: the libcamera CLI, for eyeballing the CSI camera outside our code.
# It is the only way to test the ribbon camera without the gateway.
apt-get install -y rpicam-apps >/dev/null 2>&1 \
  || apt-get install -y libcamera-apps >/dev/null 2>&1 \
  || warn "No libcamera CLI installed (optional)"

# ---------------------------------------------------------------------------
# CSI camera (ribbon cable → Picamera2)
#
# The Camera Module is driven by Picamera2, which is an apt package
# (python3-picamera2) and not a pip one. The venv below is created with
# --system-site-packages for exactly this reason.
#
# The usual reason a perfectly good module is invisible is that auto-detection
# is switched off in the boot config. No amount of Python can work around that,
# so it is checked and repaired here.
# ---------------------------------------------------------------------------
log "Checking CSI camera boot configuration"
CONFIG_TXT=""
for candidate in /boot/firmware/config.txt /boot/config.txt; do
  if [[ -f "${candidate}" ]]; then
    CONFIG_TXT="${candidate}"
    break
  fi
done

if [[ -z "${CONFIG_TXT}" ]]; then
  warn "No /boot/firmware/config.txt or /boot/config.txt - cannot check camera settings."
else
  if grep -qE '^[[:space:]]*camera_auto_detect=0' "${CONFIG_TXT}"; then
    warn "camera_auto_detect=0 in ${CONFIG_TXT} — the CSI camera will never appear."
    warn "Change it to 1 (or delete the line) and reboot."
  elif grep -qE '^[[:space:]]*camera_auto_detect=' "${CONFIG_TXT}"; then
    log "camera_auto_detect already enabled in ${CONFIG_TXT}"
  else
    log "Adding camera_auto_detect=1 to ${CONFIG_TXT}"
    printf '\n# CyberSentinel: let the firmware detect the attached CSI camera.\ncamera_auto_detect=1\n' >> "${CONFIG_TXT}"
    CAMERA_NEEDS_REBOOT=1
  fi

  # A hard-coded overlay for a *different* sensor is a classic silent failure.
  if grep -qE '^[[:space:]]*dtoverlay=(ov5647|imx219|imx477|imx708|imx290|imx519)' "${CONFIG_TXT}"; then
    log "A fixed dtoverlay is set in ${CONFIG_TXT}; if your sensor is a different model, remove it."
  fi
fi

# Ask the firmware what it can actually see, so a loose ribbon is caught now.
CAM_BIN="$(command -v rpicam-hello || command -v libcamera-hello || true)"
if [[ -n "${CAM_BIN}" ]]; then
  CAM_LIST="$("${CAM_BIN}" --list-cameras 2>/dev/null || true)"
  if [[ -n "${CAM_LIST}" ]] && grep -qi 'available cameras' <<<"${CAM_LIST}"; then
    log "CSI camera reported by the firmware:"
    grep -iA2 'available cameras' <<<"${CAM_LIST}" | sed 's/^/      /'
  else
    warn "The firmware lists no CSI camera."
    warn "  * ribbon fully seated in CAM/DISP 0, metal contacts facing the board"
    warn "  * reboot if camera_auto_detect was just changed"
  fi
else
  warn "No rpicam-hello/libcamera-hello available — cannot probe the sensor."
fi

# ---------------------------------------------------------------------------
# mDNS hostname
# ---------------------------------------------------------------------------
log "Setting hostname to ${HOSTNAME_TARGET} (mDNS)"
hostnamectl set-hostname "${HOSTNAME_TARGET}"
if grep -q '^127\.0\.1\.1' /etc/hosts; then
  sed -i "s/^127\.0\.1\.1.*/127.0.1.1\t${HOSTNAME_TARGET}/" /etc/hosts
else
  printf '127.0.1.1\t%s\n' "${HOSTNAME_TARGET}" >> /etc/hosts
fi
systemctl enable --now avahi-daemon || warn "avahi-daemon did not start"

# ---------------------------------------------------------------------------
# Serial access (the Arduino)
#
# The gateway runs as ${RUN_USER} and opens /dev/ttyACM0 (a genuine Uno R3,
# CDC-ACM) or /dev/ttyUSB0 (CH340/CP2102 clones). Both nodes are root:dialout
# 0660, so the service user MUST be in the dialout group — otherwise every
# open fails with "Permission denied" and the app shows the Arduino as offline
# no matter how solidly the USB cable is plugged in.
# ---------------------------------------------------------------------------
log "Granting ${RUN_USER} access to the Arduino serial ports (dialout group)"
if id -nG "${RUN_USER}" 2>/dev/null | tr ' ' '\n' | grep -qx dialout; then
  log "${RUN_USER} is already in the dialout group"
else
  usermod -aG dialout "${RUN_USER}" \
    && log "Added ${RUN_USER} to dialout (reboot for it to apply)" \
    || warn "Could not add ${RUN_USER} to dialout"
fi

SERIAL_FOUND="$(ls /dev/ttyACM* /dev/ttyUSB* 2>/dev/null | head -1 || true)"
if [[ -n "${SERIAL_FOUND}" ]]; then
  log "Arduino serial port detected: ${SERIAL_FOUND}"
else
  warn "No /dev/ttyACM* or /dev/ttyUSB* device found right now."
  warn "Plug the Arduino into the Pi, then re-run: sudo bash pi/setup.sh"
fi

# ---------------------------------------------------------------------------
# Mosquitto
#
# Two things routinely break this on Raspberry Pi OS:
#   1. The distro build of Mosquitto is compiled WITHOUT WebSocket support, so
#      `protocol websockets` makes it exit immediately (the classic "control
#      process exited with error code" message).
#   2. A broken/duplicate directive in conf.d.
# We probe for (1) and validate the config before restarting, then report the
# real log lines if it still refuses to start.
# ---------------------------------------------------------------------------
MOSQ_BIN="$(command -v mosquitto || true)"
[[ -z "${MOSQ_BIN}" && -x /usr/sbin/mosquitto ]] && MOSQ_BIN=/usr/sbin/mosquitto

# `timeout` returns 124 when the broker kept running, which means the config
# was accepted. Any other non-zero code means Mosquitto rejected it.
run_mosquitto_check() {
  local conf="$1" out
  out="$(mktemp)"
  timeout 2 "${MOSQ_BIN}" -c "${conf}" >"${out}" 2>&1
  local code=$?
  if [[ ${code} -ne 0 && ${code} -ne 124 ]]; then
    cat "${out}" >&2
    rm -f "${out}"
    return 1
  fi
  rm -f "${out}"
  return 0
}

websockets_supported() {
  local probe
  probe="$(mktemp)"
  printf 'listener %s\nprotocol websockets\n' "${MOSQ_WS_CHECK_PORT}" > "${probe}"
  local result=0
  run_mosquitto_check "${probe}" || result=1
  rm -f "${probe}"
  return "${result}"
}

configure_mosquitto() {
  [[ -n "${MOSQ_BIN}" ]] || die "mosquitto binary not found after install"

  install -d /etc/mosquitto/conf.d
  local target=/etc/mosquitto/conf.d/cybersentinel.conf

  if websockets_supported; then
    log "Mosquitto supports WebSockets — installing 1883 TCP + 9001 WebSocket listeners"
    install -m 644 "${REPO_DIR}/pi/mosquitto.conf" "${target}"
  else
    warn "This Mosquitto was built WITHOUT WebSocket support."
    warn "The broker will run on 1883 only; the phone's live telemetry needs WebSockets."
    warn "Fix it later with a WebSocket-enabled build:"
    warn "  curl -fsSL https://repo.mosquitto.org/debian/mosquitto-repo.gpg.key | gpg --dearmor -o /usr/share/keyrings/mosquitto.gpg"
    warn "  echo 'deb [signed-by=/usr/share/keyrings/mosquitto.gpg] https://repo.mosquitto.org/debian bookworm main' > /etc/apt/sources.list.d/mosquitto.list"
    warn "  apt-get update && apt-get install --reinstall -y mosquitto mosquitto-clients"
    warn "  systemctl restart mosquitto && sudo bash pi/setup.sh"
    # Strip everything from the websockets marker onwards, keeping plain MQTT.
    sed '/^# --- websockets ---$/,$d' "${REPO_DIR}/pi/mosquitto.conf" > "${target}"
  fi

  log "Validating the merged Mosquitto configuration"
  if ! run_mosquitto_check /etc/mosquitto/mosquitto.conf; then
    warn "Mosquitto rejected /etc/mosquitto/mosquitto.conf (output above)."
    warn "Running with a standalone config so the broker still starts..."
    install -m 644 "${target}" /etc/mosquitto/conf.d/cybersentinel.conf
    return 1
  fi

  systemctl enable mosquitto >/dev/null 2>&1 || true
  if systemctl restart mosquitto; then
    log "Mosquitto is running"
    return 0
  fi

  warn "mosquitto.service failed to start. Last log lines:"
  journalctl -u mosquitto -n 25 --no-pager >&2 || true
  return 1
}

if ! configure_mosquitto; then
  warn "Continuing without a working broker — fix Mosquitto with the commands above, then re-run this script."
fi

# ---------------------------------------------------------------------------
# Gateway
# ---------------------------------------------------------------------------
log "Creating ${INSTALL_DIR}"
mkdir -p "${INSTALL_DIR}"
install -m 644 "${REPO_DIR}/gateway.py" "${INSTALL_DIR}/gateway.py"
[[ -f "${INSTALL_DIR}/gateway.env" ]] || install -m 644 "${REPO_DIR}/pi/gateway.env.example" "${INSTALL_DIR}/gateway.env"

# Make it obvious which build landed on disk — a stale clone deploys a stale gateway.
DEPLOYED_VERSION="$(grep -oE 'GATEWAY_VERSION = "[^"]+"' "${INSTALL_DIR}/gateway.py" | head -1 | cut -d'"' -f2)"
if [[ -z "${DEPLOYED_VERSION}" ]]; then
  warn "The gateway.py in this clone has no GATEWAY_VERSION — it is out of date."
  warn "Run 'git pull' in ${REPO_DIR} and re-run this script."
else
  log "Deployed gateway.py: v${DEPLOYED_VERSION}"
fi

log "Creating Python virtualenv"
# picamera2 and libcamera are apt packages living in the system dist-packages.
# A venv without --system-site-packages cannot import them, which silently
# disables the CSI camera, so recreate the venv if it was built the old way.
if [[ -f "${INSTALL_DIR}/venv/pyvenv.cfg" ]] \
   && grep -q '^include-system-site-packages = false' "${INSTALL_DIR}/venv/pyvenv.cfg"; then
  warn "Existing venv cannot see system packages — recreating it with --system-site-packages"
  rm -rf "${INSTALL_DIR}/venv"
fi
python3 -m venv --system-site-packages "${INSTALL_DIR}/venv" \
  || die "Could not create the virtualenv"
"${INSTALL_DIR}/venv/bin/pip" install --upgrade pip || warn "pip upgrade failed"
"${INSTALL_DIR}/venv/bin/pip" install -r "${REPO_DIR}/pi/requirements.txt" || die "pip install failed"

# Fail loudly rather than silently losing the camera backend. The distinction
# matters: an import that works but finds zero sensors is a wiring problem, not
# a Python one, and the two need completely different fixes.
if PICAM_COUNT="$("${INSTALL_DIR}/venv/bin/python" \
      -c 'from picamera2 import Picamera2 as P; print(len(P.global_camera_info()))' 2>&1)"; then
  if [[ "${PICAM_COUNT}" == "0" ]]; then
    warn "picamera2 imports from the venv but sees 0 CSI cameras."
    warn "  Check the ribbon (CAM/DISP 0, contacts facing the board) and reboot."
  else
    log "picamera2 sees ${PICAM_COUNT} CSI camera(s) from the venv"
  fi
else
  warn "picamera2 is not importable from the venv: ${PICAM_COUNT}"
  warn "  apt-get install -y python3-picamera2   (then re-run this script)"
fi

chown -R "${RUN_USER}:${RUN_USER}" "${INSTALL_DIR}"

log "Installing systemd service"
sed "s/^User=pi$/User=${RUN_USER}/" "${REPO_DIR}/pi/cybersentinel-gateway.service" \
  > /etc/systemd/system/cybersentinel-gateway.service
systemctl daemon-reload
if systemctl enable --now cybersentinel-gateway; then
  log "cybersentinel-gateway is running"
else
  warn "cybersentinel-gateway failed to start:"
  journalctl -u cybersentinel-gateway -n 25 --no-pager >&2 || true
fi

# ---------------------------------------------------------------------------
# Boot persistence — every service must come back after a power cycle
# ---------------------------------------------------------------------------
log "Ensuring services start on boot"
BOOT_FAILURES=0
for svc in avahi-daemon mosquitto cybersentinel-gateway; do
  systemctl enable "${svc}" >/dev/null 2>&1 || true
  if systemctl is-enabled "${svc}" >/dev/null 2>&1; then
    printf '    \033[1;32m✓\033[0m %s (enabled)\n' "${svc}"
  else
    printf '    \033[1;31m✗\033[0m %s (NOT enabled)\n' "${svc}"
    BOOT_FAILURES=$((BOOT_FAILURES + 1))
  fi
done
[[ ${BOOT_FAILURES} -eq 0 ]] || warn "Some services will not start on boot — see above."

# ---------------------------------------------------------------------------
# Verification — prove the running gateway is the build we just installed
# ---------------------------------------------------------------------------
API_PORT="$(grep -E '^CS_API_PORT=' "${INSTALL_DIR}/gateway.env" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')"
API_PORT="${API_PORT:-8000}"

log "Verifying the gateway on port ${API_PORT}"
sleep 2
HEALTH="$(curl -fsS --max-time 6 "http://127.0.0.1:${API_PORT}/health" 2>/dev/null || true)"
if [[ -z "${HEALTH}" ]]; then
  warn "No answer from http://127.0.0.1:${API_PORT}/health"
  warn "Port ${API_PORT} owner:"
  ss -ltnp 2>/dev/null | grep ":${API_PORT}" >&2 || warn "  (nothing is listening on that port)"
  warn "Inspect: journalctl -u cybersentinel-gateway -n 40 --no-pager"
else
  # The most common cause of a "stale" reading is an older gateway that was
  # started by hand (not by systemd) still holding the port, so the service's
  # restart could never bind and the old code kept answering forever. That
  # process is invisible to `systemctl status`, which reports the new service
  # as happily enabled, so the port owner has to be named explicitly.
  if [[ "${HEALTH}" != *'"version"'* ]]; then
    warn "The gateway answering on :${API_PORT} has no version field — it is an older build."
    warn "  See the port owner diagnostic below."
  elif [[ -n "${DEPLOYED_VERSION}" && "${HEALTH}" != *"\"${DEPLOYED_VERSION}\""* ]]; then
    warn "The gateway on :${API_PORT} is NOT the build just deployed."
    warn "  on disk : v${DEPLOYED_VERSION}"
    warn "  answering: $(sed -n 's/.*"version": *"\([^"]*\)".*/v\1/p' <<<"${HEALTH}")"
  fi

  # Only run the ownership check when something actually looks wrong.
  if [[ "${HEALTH}" != *"\"${DEPLOYED_VERSION}\""* ]]; then
    PORT_PID="$(ss -ltnp 2>/dev/null | grep ":${API_PORT}" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)"
    warn "Port ${API_PORT} owner:"
    ss -ltnp 2>/dev/null | grep ":${API_PORT}" >&2 || warn "  (nothing is listening there)"
    if [[ -n "${PORT_PID}" ]]; then
      PORT_CMD="$(tr '\0' ' ' < "/proc/${PORT_PID}/cmdline" 2>/dev/null || true)"
      PORT_DIR="$(readlink -f "/proc/${PORT_PID}/cwd" 2>/dev/null || true)"
      SERVICE_PID="$(systemctl show -p MainPID --value cybersentinel-gateway 2>/dev/null || true)"
      warn "  pid ${PORT_PID}: ${PORT_CMD:-unknown command}"
      warn "  running from: ${PORT_DIR:-unknown}"
      if [[ "${PORT_PID}" != "${SERVICE_PID}" ]]; then
        warn "  ^ this is NOT the systemd service (whose MainPID is ${SERVICE_PID:-none})."
        warn "  It is a leftover hand-started gateway squatting on the port, which is why"
        warn "  the service could never bind and your changes never took effect. Kill it:"
        warn "    sudo kill ${PORT_PID} && sudo systemctl restart cybersentinel-gateway"
      else
        warn "  The service owns the port but is serving old code — it did not pick up the"
        warn "  new gateway.py. Restart it:  sudo systemctl restart cybersentinel-gateway"
      fi
    fi
  fi
  # ASCII only: a C/POSIX locale makes Python's stdout non-UTF-8, and printing
  # box-drawing or check characters there raises UnicodeEncodeError.
  HEALTH="${HEALTH}" EXPECTED="${DEPLOYED_VERSION}" PYTHONIOENCODING=utf-8 python3 - <<'PY'
import json, os

data = json.loads(os.environ["HEALTH"])
running = data.get("version")
expected = os.environ.get("EXPECTED") or ""
if running and expected and running != expected:
    print(f"    [!!] version : {running} - but v{expected} is deployed; the running process is old")
elif running:
    print(f"    [ok] version : {running}")
else:
    print("    [!!] version : MISSING - the deployed gateway.py is stale")
print(f"    {'[ok]' if data.get('speaker') else '[!!]'} speaker : {data.get('speaker') or 'no TTS engine found'}")
cam = data.get("camera_info")
if cam is None:
    print("    [!!] camera  : no camera_info - the deployed gateway.py is stale")
else:
    mark = "[ok]" if cam.get("online") else "[--]"
    print(f"    {mark} camera  : {'online' if cam.get('online') else 'offline'} "
          f"[{cam.get('source', '?')}] - {cam.get('detail')}")
serial = data.get("serial")
if serial is None:
    print("    [!!] arduino : no serial block - the deployed gateway.py is stale")
else:
    mark = "[ok]" if data.get("arduino") == "online" else "[--]"
    detail = serial.get("error") or f"connected on {serial.get('port')}"
    print(f"    {mark} arduino : {data.get('arduino')} - {detail}")
PY
fi

# ---------------------------------------------------------------------------
# Camera stream — the app needs frames, not just a configured camera
#
# The gateway serves the MJPEG stream itself on CS_CAMERA_PORT (8080), which is
# the port and path the phone already asks for, so the capture backend can
# change without touching the app. "The camera is configured" and "the camera is
# streaming" are different states and only the second one is useful, so a real
# JPEG is fetched here rather than assumed. The supervisor retries every few
# seconds, so this waits rather than failing on a slow first start.
# ---------------------------------------------------------------------------
CAM_PORT="$(grep -E '^CS_CAMERA_PORT=' "${INSTALL_DIR}/gateway.env" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')"
CAM_PORT="${CAM_PORT:-8080}"

log "Checking the camera stream on :${CAM_PORT}"
CAM_STATUS="$(curl -fsS --max-time 6 "http://127.0.0.1:${API_PORT}/camera/status" 2>/dev/null || true)"
if [[ -z "${CAM_STATUS}" ]]; then
  warn "No answer from /camera/status — the gateway may still be starting up."
else
  CAM_FIELDS="$(python3 -c '
import json, sys
d = json.loads(sys.argv[1])
print("online" if d.get("online") else "offline")
print(d.get("source") or "?")
print(d.get("detail") or "")
' "${CAM_STATUS}" 2>/dev/null || true)"
  CAM_ONLINE="$(sed -n 1p <<<"${CAM_FIELDS}")"
  CAM_SOURCE="$(sed -n 2p <<<"${CAM_FIELDS}")"
  CAM_DETAIL="$(sed -n 3p <<<"${CAM_FIELDS}")"
  CAM_MARK="[--]"
  if [[ "${CAM_ONLINE}" == "online" ]]; then CAM_MARK="[ok]"; fi
  printf '    %s camera  : %s [%s] - %s\n' \
    "${CAM_MARK}" "${CAM_ONLINE:-unknown}" "${CAM_SOURCE:-?}" "${CAM_DETAIL:-no detail}"
fi

FRAME_TMP="$(mktemp)"
CAM_FRAME_OK=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 5 "http://127.0.0.1:${CAM_PORT}/snapshot.jpg" \
       -o "${FRAME_TMP}" 2>/dev/null && [[ -s "${FRAME_TMP}" ]]; then
    CAM_FRAME_OK=1
    break
  fi
  sleep 1
done
if [[ "${CAM_FRAME_OK}" -eq 1 ]]; then
  log "Camera is serving frames (:${CAM_PORT}, $(wc -c <"${FRAME_TMP}" | tr -d ' ') byte JPEG)"
else
  warn "No frame from http://127.0.0.1:${CAM_PORT}/snapshot.jpg after 10 seconds."
  warn "  What does the gateway think?"
  warn "    curl -s http://127.0.0.1:${API_PORT}/camera/status | python3 -m json.tool"
  warn "  Does the sensor work below our code?"
  warn "    ${CAM_BIN:-rpicam-hello} --list-cameras"
  warn "  Ribbon seated in CAM/DISP 0 with the metal contacts facing the board, and"
  warn "  reboot if camera_auto_detect was only just enabled."
fi
rm -f "${FRAME_TMP}"

# ---------------------------------------------------------------------------
# Control channel — the exact socket the app's joystick and buttons use
#
# Motor control does NOT go over MQTT: the app opens ws://<pi>:<CS_WS_PORT> and
# sends {cmd:MOVE,angle,speed} / STOP / BUZZER, and the gateway turns that into
# the FORWARD / BACKWARD / LEFT / RIGHT / STOP line the Arduino understands.
# Checking that socket here catches the two silent killers — a gateway that never
# bound the port, and a service user that cannot open the serial port — before
# they surface as an app that connects fine but never moves the rover.
# ---------------------------------------------------------------------------
WS_PORT="$(grep -E '^CS_WS_PORT=' "${INSTALL_DIR}/gateway.env" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')"
WS_PORT="${WS_PORT:-8765}"

log "Checking the control socket on :${WS_PORT}"
if ! ss -ltn 2>/dev/null | grep -qE "[:.]${WS_PORT}[[:space:]]"; then
  warn "Nothing is listening on :${WS_PORT} — the app will not be able to drive the rover."
  warn "  journalctl -u cybersentinel-gateway -n 40 --no-pager | grep '\\[ws'"
else
  "${INSTALL_DIR}/venv/bin/python" - "${WS_PORT}" <<'PY'
import asyncio, json, sys

try:
    import websockets
except ImportError as exc:
    print(f"    [!!] control socket: websockets missing from the venv ({exc})")
    sys.exit(0)


async def check(port: int) -> None:
    async with websockets.connect(f"ws://127.0.0.1:{port}", open_timeout=5) as ws:
        await ws.send(json.dumps({"cmd": "PING"}))
        pong = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
        print(f"    [ok] control socket / PING -> {pong.get('type')}")

        # STOP is the one command that is safe to send unattended: it moves
        # nothing, but it does travel the whole gateway -> serial -> Arduino
        # path that the app's joystick uses.
        await ws.send(json.dumps({"cmd": "STOP"}))
        ack = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
        print(f"    [ok] control socket / STOP -> {ack.get('type')}")


try:
    asyncio.run(check(int(sys.argv[1])))
except Exception as exc:
    print(f"    [!!] control socket did not answer: {exc}")
PY
fi

# dialout is what lets the gateway open /dev/ttyACM0 at all. A user added to it
# keeps the OLD group list in any process that started before the change, so this
# inspects the running service rather than trusting /etc/group.
SVC_PID="$(systemctl show -p MainPID --value cybersentinel-gateway 2>/dev/null || true)"
if [[ -n "${SVC_PID}" && "${SVC_PID}" != "0" ]]; then
  DIALOUT_GID="$(getent group dialout | cut -d: -f3 || true)"
  if [[ -n "${DIALOUT_GID}" ]] \
     && awk -v gid="${DIALOUT_GID}" '$1 == "Groups:" { for (i = 2; i <= NF; i++) if ($i == gid) found = 1 } END { exit !found }' \
          "/proc/${SVC_PID}/status" 2>/dev/null; then
    log "The gateway process can reach the Arduino (dialout ${DIALOUT_GID} present)"
  else
    warn "The running gateway does NOT hold the dialout group, so it cannot open the"
    warn "Arduino's serial port and the rover will not move. Apply it with:"
    warn "  sudo systemctl restart cybersentinel-gateway    (or reboot, which is the"
    warn "  only way to refresh the group list of a login session)"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
IP="$(hostname -I | awk '{print $1}')"
cat <<EOF

  Gateway:   http://${HOSTNAME_TARGET}.local:${API_PORT}/health   (IP ${IP})
  Camera:    http://${HOSTNAME_TARGET}.local:${CAM_PORT}/stream.mjpg
  Controls:  ws://${HOSTNAME_TARGET}.local:${WS_PORT}   (the app's joystick + buttons)
  MQTT/WS:   ws://${HOSTNAME_TARGET}.local:9001   (live telemetry)
  Logs:      journalctl -u cybersentinel-gateway -f
             journalctl -u mosquitto -f

  All services are enabled, so a power cycle brings everything back up.

  Speaker check:
    speaker-test -t sine -f 440 -l 1
    espeak-ng "CyberSentinel online"

  Camera check:
    curl -s "http://127.0.0.1:${CAM_PORT}/snapshot.jpg" -o shot.jpg && ls -lh shot.jpg
    ${INSTALL_DIR}/venv/bin/python -c 'from picamera2 import Picamera2; print(Picamera2.global_camera_info())'

  Motor check:
    This script has already sent PING and STOP through the control socket above,
    which is the same path the app's joystick and direction buttons take, and has
    confirmed the gateway process holds the dialout group. If the app connects but
    the rover still will not move, the fault is past the gateway: check the
    Arduino's USB cable and motor driver, and watch the sketch's own log:
      journalctl -u cybersentinel-gateway -f | grep '\[arduino'
    The app's Horn button is an audible end-to-end test (gateway -> serial ->
    Arduino buzzer) that needs no tools at all.

  Arduino check:
    curl -s http://127.0.0.1:${API_PORT}/health | grep -o '"serial":[^}]*}'
    journalctl -u cybersentinel-gateway -f | grep '\[arduino'
EOF

if [[ "${CAMERA_PKG_MISSING}" -eq 1 ]]; then
  warn "The CSI camera stack is NOT installed, so the app's camera view will stay blank."
  warn "  apt-cache policy python3-picamera2"
  warn "  sudo apt-get update && sudo apt-get install -y python3-picamera2"
  warn "  sudo bash pi/setup.sh"
fi

if [[ "${CAMERA_NEEDS_REBOOT}" -eq 1 ]]; then
  warn "camera_auto_detect was just enabled — reboot before the CSI camera will appear:"
  warn "  sudo reboot"
fi
