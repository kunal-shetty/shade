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
  ffmpeg v4l-utils || die "apt-get install failed"

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
python3 -m venv "${INSTALL_DIR}/venv" || die "Could not create the virtualenv"
"${INSTALL_DIR}/venv/bin/pip" install --upgrade pip || warn "pip upgrade failed"
"${INSTALL_DIR}/venv/bin/pip" install -r "${REPO_DIR}/pi/requirements.txt" || die "pip install failed"

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
  # restart could never bind and the old code kept answering.
  if [[ "${HEALTH}" != *'"version"'* ]]; then
    warn "The gateway answering on :${API_PORT} has no version field — it is an older build."
    warn "Port ${API_PORT} owner:"
    ss -ltnp 2>/dev/null | grep ":${API_PORT}" >&2 || warn "  (unknown)"
    warn "If that process was started by hand (e.g. 'python3 gateway.py'), kill it and re-run:"
    warn "  sudo systemctl restart cybersentinel-gateway"
  fi
  # ASCII only: a C/POSIX locale makes Python's stdout non-UTF-8, and printing
  # box-drawing or check characters there raises UnicodeEncodeError.
  HEALTH="${HEALTH}" PYTHONIOENCODING=utf-8 python3 - <<'PY'
import json, os

data = json.loads(os.environ["HEALTH"])
running = data.get("version")
print(f"    {'[ok]' if running else '[!!]'} version : {running or 'MISSING - the deployed gateway.py is stale'}")
print(f"    {'[ok]' if data.get('speaker') else '[!!]'} speaker : {data.get('speaker') or 'no TTS engine found'}")
cam = data.get("camera_info")
if cam is None:
    print("    [!!] camera  : no camera_info - the deployed gateway.py is stale")
else:
    mark = "[ok]" if cam.get("online") else "[--]"
    print(f"    {mark} camera  : {'online' if cam.get('online') else 'offline'} - {cam.get('detail')}")
print(f"    [--] arduino : {data.get('arduino_door')}")
PY
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
IP="$(hostname -I | awk '{print $1}')"
cat <<EOF

  Gateway:   http://${HOSTNAME_TARGET}.local:${API_PORT}/health   (IP ${IP})
  WebSocket: ws://${HOSTNAME_TARGET}.local:8765
  MQTT/WS:   ws://${HOSTNAME_TARGET}.local:9001
  Logs:      journalctl -u cybersentinel-gateway -f
             journalctl -u mosquitto -f

  All services are enabled, so a power cycle brings everything back up.

  Speaker check:
    speaker-test -t sine -f 440 -l 1
    espeak-ng "CyberSentinel online"
EOF
