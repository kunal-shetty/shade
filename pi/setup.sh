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
  # The timeout is essential, not defensive padding. This probe talks to libcamera
  # on the real sensor, and on a busy, half-seated or misbehaving module it can
  # block indefinitely — which would wedge the whole provisioning run at a step
  # that is only advisory. Provisioning must never hang on an optional check.
  CAM_LIST="$(timeout 15 "${CAM_BIN}" --list-cameras 2>/dev/null)"
  CAM_RC=$?
  if [[ ${CAM_RC} -eq 124 ]]; then
    warn "${CAM_BIN} --list-cameras did not finish within 15s and was stopped."
    warn "  Most often the sensor is simply held by the gateway that is already"
    warn "  running, but a half-seated ribbon blocks it the same way. This probe is"
    warn "  optional — the gateway opens the sensor itself — so provisioning continues."
    warn "  Re-check later with nothing holding the camera:"
    warn "    sudo systemctl stop cybersentinel-gateway"
    warn "    timeout 15 ${CAM_BIN} --list-cameras"
  elif [[ -n "${CAM_LIST}" ]] && grep -qi 'available cameras' <<<"${CAM_LIST}"; then
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
# Exit code of the last run_mosquitto_check, so the caller can report it. The
# number separates "bad config" from "could not bind", which look identical when
# mosquitto's own logging is pointed at a file instead of stderr.
LAST_MOSQ_CODE=0

run_mosquitto_check() {
  local conf="$1" out
  out="$(mktemp)"
  timeout 2 "${MOSQ_BIN}" -c "${conf}" >"${out}" 2>&1
  local code=$?
  if [[ ${code} -ne 0 && ${code} -ne 124 ]]; then
    cat "${out}" >&2
    LAST_MOSQ_CODE=${code}
    rm -f "${out}"
    return 1
  fi
  LAST_MOSQ_CODE=0
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

  # Stop any running broker BEFORE validating. The validation starts a throwaway
  # mosquitto, and a already-running one holds 1883, so the bind fails and looks
  # exactly like a rejected config file. That made a re-run — which is the whole
  # point of an idempotent script — report a config error on a config that is
  # perfectly fine, then install the degraded fallback.
  if systemctl is-active --quiet mosquitto 2>/dev/null; then
    log "Stopping mosquitto so the config can be validated"
    systemctl stop mosquitto >/dev/null 2>&1 || true
    sleep 1
  fi

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
    # conf.d is merged wholesale, so a leftover file from an earlier attempt (this
    # repo used to write cyber.conf) can redeclare listener 9001 and invalidate
    # the whole config - the broker then never starts and the phone loses live
    # telemetry. Repair it here instead of making the user go hunting: move the
    # foreign files aside, validate again, and put them back if that was not it.
    local backup=/etc/mosquitto/conf.d.disabled moved=() file
    warn "Mosquitto rejected the merged config (exit ${LAST_MOSQ_CODE}, output above)."
    install -d "${backup}" 2>/dev/null || true
    for file in /etc/mosquitto/conf.d/*.conf; do
      [[ -e "${file}" ]] || continue
      [[ "${file}" == "${target}" ]] && continue
      if mv "${file}" "${backup}/" 2>/dev/null; then
        moved+=("$(basename "${file}")")
        warn "  moved aside: $(basename "${file}")"
      fi
    done

    if [[ "${#moved[@]}" -gt 0 ]] && run_mosquitto_check /etc/mosquitto/mosquitto.conf; then
      log "${moved[*]} redeclared our listeners — ${target} works on its own now."
      log "  Backed up in ${backup}/; remove when you are sure: sudo rm -rf ${backup}"
    else
      # Put them back: they were not the cause, so do not quietly change a
      # config the user may have added on purpose.
      for file in "${moved[@]:-}"; do
        [[ -n "${file}" ]] && mv "${backup}/${file}" /etc/mosquitto/conf.d/ 2>/dev/null || true
      done
      [[ "${#moved[@]}" -gt 0 ]] && warn "  put them back — they were not the cause"
      warn "Every file in /etc/mosquitto/conf.d/ is merged into that config, and a stale"
      warn "one from an earlier attempt can redeclare the same listeners. Check both:"
      ss -ltnp 2>/dev/null | grep -E ':(1883|9001)[[:space:]]' >&2 || warn "  (nothing listening on 1883/9001)"
      ls -l /etc/mosquitto/conf.d/ >&2 || true
      return 1
    fi
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

# (The Expo app is the only client now — no web console is served.)

# Every port below is read from the DEPLOYED env file, so the checks in this
# script can never drift from the numbers the gateway actually binds.
read_env_port() {
  local key="$1" fallback="$2" value
  value="$(grep -E "^${key}=" "${INSTALL_DIR}/gateway.env" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')"
  printf '%s' "${value:-${fallback}}"
}
API_PORT="$(read_env_port CS_API_PORT 8000)"
GW_WS_PORT="$(read_env_port CS_WS_PORT 8765)"
GW_CAM_PORT="$(read_env_port CS_CAMERA_PORT 8080)"
GW_PORTS=("${API_PORT}" "${GW_WS_PORT}" "${GW_CAM_PORT}")

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
#
# Started up with a timeout for the same reason as the probe above: importing
# picamera2 initialises libcamera, which touches the sensor and can block.
# stderr goes to its own file, NOT merged into stdout. libcamera logs several
# INFO lines while enumerating, and folding them into the value made the count
# unparsable — every comparison against "0" failed and the whole log blob was
# printed as the sensor count.
PICAM_LOG="$(mktemp)"
PICAM_INFO="$(timeout 20 "${INSTALL_DIR}/venv/bin/python" \
  -c 'from picamera2 import Picamera2 as P
info = P.global_camera_info()
print(len(info))
print(", ".join(str(c.get("Model") or c.get("model") or "?") for c in info))' \
  2>"${PICAM_LOG}")"
PICAM_RC=$?
PICAM_COUNT="$(sed -n 1p <<<"${PICAM_INFO}")"
PICAM_MODELS="$(sed -n 2p <<<"${PICAM_INFO}")"
if [[ ${PICAM_RC} -eq 124 ]]; then
  warn "picamera2 took longer than 20s to enumerate cameras and was stopped."
  warn "  The gateway will still try the sensor on its own; if the app shows no"
  warn "  camera, check:  ${CAM_BIN:-rpicam-hello} --list-cameras"
elif [[ ${PICAM_RC} -ne 0 ]]; then
  warn "picamera2 is not importable from the venv (exit ${PICAM_RC}):"
  sed 's/^/      /' "${PICAM_LOG}" >&2 || true
  warn "  apt-get install -y python3-picamera2   (then re-run this script)"
elif [[ "${PICAM_COUNT}" == "0" ]]; then
  warn "picamera2 imports from the venv but sees 0 CSI cameras."
  warn "  Check the ribbon (CAM/DISP 0, contacts facing the board) and reboot."
else
  log "picamera2 sees ${PICAM_COUNT} CSI camera(s) from the venv: ${PICAM_MODELS}"
fi
rm -f "${PICAM_LOG}"

chown -R "${RUN_USER}:${RUN_USER}" "${INSTALL_DIR}"

log "Installing systemd service"
sed "s/^User=pi$/User=${RUN_USER}/" "${REPO_DIR}/pi/cybersentinel-gateway.service" \
  > /etc/systemd/system/cybersentinel-gateway.service
systemctl daemon-reload

# ---------------------------------------------------------------------------
# Free the gateway's ports before the unit starts
#
# ${GW_PORTS[*]} belong to the gateway (REST, control WebSocket, MJPEG camera).
# If an earlier build is still running — classically a gateway started by hand
# during debugging and never stopped — systemd's restart cannot bind, and every
# check afterwards is answered by the OLD process. That failure is invisible in
# `systemctl status`, which cheerfully reports the new unit as enabled while the
# stale process keeps serving the old code forever.
#
# Only processes that are recognisably OURS are killed. 8000, 8080 and 8765 are
# all popular ports for unrelated software, and taking one of those down would be
# far worse than a port clash, so anything else is reported instead.
# ---------------------------------------------------------------------------
# True only for a process that is genuinely still running. `kill -0` also
# succeeds for a zombie waiting to be reaped, which would make this report a
# successfully killed gateway as "STILL alive".
proc_alive() {
  local pid="$1" state
  [[ -d "/proc/${pid}" ]] || return 1
  state="$(awk '/^State:/{print $2}' "/proc/${pid}/status" 2>/dev/null || true)"
  [[ -n "${state}" && "${state}" != "Z" ]]
}

port_owner_pids() {
  local port="$1"
  # `ss -ltnp` is the only listing that names the owning pid. It needs root,
  # which this script already is; without root the pid column is absent and this
  # correctly finds nothing.
  ss -ltnp 2>/dev/null \
    | grep -E "[:.]${port}[[:space:]]" \
    | grep -oE 'pid=[0-9]+' \
    | cut -d= -f2 \
    | sort -u
}

free_gateway_ports() {
  local port pid cmd cwd freed=0 blocked=0

  # Stop the unit first: Restart=always would otherwise race us and re-take the
  # ports while we are still trying to clear them.
  if systemctl is-active --quiet cybersentinel-gateway 2>/dev/null; then
    log "Stopping cybersentinel-gateway so it releases ${GW_PORTS[*]}"
    systemctl stop cybersentinel-gateway >/dev/null 2>&1 || true
    sleep 1
  fi

  for port in "${GW_PORTS[@]}"; do
    for pid in $(port_owner_pids "${port}"); do
      [[ -n "${pid}" ]] || continue
      cmd="$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || true)"
      cwd="$(readlink -f "/proc/${pid}/cwd" 2>/dev/null || true)"

      if [[ "${cmd}" == *gateway.py* || "${cmd}" == *cybersentinel* || "${cwd}" == *cybersentinel* ]]; then
        warn "Port ${port} was still held by a leftover gateway (pid ${pid}): ${cmd:-unknown}"
        kill "${pid}" 2>/dev/null || true
        # Give it a moment to exit on SIGTERM before escalating.
        for _ in 1 2 3 4 5; do
          proc_alive "${pid}" || break
          sleep 1
        done
        if proc_alive "${pid}"; then
          kill -9 "${pid}" 2>/dev/null || true
          warn "  pid ${pid} ignored SIGTERM and was killed with SIGKILL"
        fi
        if proc_alive "${pid}"; then
          warn "  pid ${pid} is STILL alive — free port ${port} yourself: sudo kill -9 ${pid}"
          blocked=$((blocked + 1))
        else
          log "Freed port ${port} (stale gateway pid ${pid})"
          freed=$((freed + 1))
        fi
      else
        warn "Port ${port} is held by pid ${pid}, which does NOT look like the rover gateway:"
        warn "    ${cmd:-unknown command}"
        if [[ -n "${cwd}" ]]; then
          warn "    running from: ${cwd}"
        fi
        warn "  Left alone on purpose. To hand the port to the gateway:  sudo kill ${pid}"
        blocked=$((blocked + 1))
      fi
    done
  done

  if [[ ${freed} -eq 0 && ${blocked} -eq 0 ]]; then
    log "Ports ${GW_PORTS[*]} are free"
  elif [[ ${blocked} -gt 0 ]]; then
    warn "${blocked} port(s) are still occupied — the gateway may not be able to bind them."
  fi
}

free_gateway_ports

# ---------------------------------------------------------------------------
# Boot greeting — the Pi says "Good morning Mohini maam" on its own speaker at
# every power-up, straight from systemd, before any app or browser is involved.
# A oneshot unit runs a tiny espeak script; the line and delay are tunable via
# CS_BOOT_GREETING / CS_BOOT_GREET_DELAY in gateway.env (optional, defaults).
# ---------------------------------------------------------------------------
log "Installing the boot greeting service"
install -m 755 "${REPO_DIR}/pi/cybersentinel-greet.sh" /usr/local/bin/cybersentinel-greet.sh
sed "s/^User=pi$/User=${RUN_USER}/" "${REPO_DIR}/pi/cybersentinel-greet.service" \
  > /etc/systemd/system/cybersentinel-greet.service
systemctl daemon-reload
# The autonomous demo (below) speaks the greeting itself, so this oneshot stays
# DISABLED when the demo is installed — otherwise the Pi says the line twice at
# every boot. It remains installed for standalone use:
#   sudo systemctl enable --now cybersentinel-greet.service
#   sudo /usr/local/bin/cybersentinel-greet.sh          # say it right now

# ---------------------------------------------------------------------------
# Autonomous boot demo — no app, no server: after boot the Pi greets on its
# speaker, then drives the rover in a fixed loop (FORWARD -> LEFT -> RIGHT ->
# BACKWARD, CS_DEMO_STEP seconds each) by writing straight to the Arduino's
# serial port. Always STOPs on shutdown/reboot/timeout.
# Tunables in gateway.env:  CS_BOOT_GREETING, CS_DEMO_STEP  (see the example).
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Autonomous boot demo — no app, no server: after boot the Pi greets on its
# speaker, then drives the rover in a fixed loop (FORWARD -> LEFT -> RIGHT ->
# BACKWARD, CS_DEMO_STEP seconds each) by writing straight to the Arduino's
# serial port. Always STOPs on shutdown/reboot. Enabled = automatic at boot.
# Tunables in gateway.env: CS_BOOT_GREETING, CS_DEMO_STEP, CS_AUDIO_DEVICE.
#
# The demo needs the Arduino ALONE: the gateway (and anything else) opening the
# same /dev/ttyACM* interleaves its bytes with the demo's and the Uno receives
# garbled half-commands — the rover freezes. So when the demo is installed the
# gateway service is stopped and disabled by default (re-enable it if the app
# is wanted again:
#   sudo systemctl disable --now cybersentinel-demo.service && \
#   sudo systemctl enable --now cybersentinel-gateway.service ).
# ---------------------------------------------------------------------------
DEMO_ENABLED=0
if [[ -f "${REPO_DIR}/pi/demo-drive.py" ]]; then
  log "Installing the autonomous boot demo"
  install -m 644 "${REPO_DIR}/pi/demo-drive.py" "${INSTALL_DIR}/demo-drive.py"
  sed "s/^User=minnie_1105$/User=${RUN_USER}/" "${REPO_DIR}/pi/cybersentinel-demo.service" \
    > /etc/systemd/system/cybersentinel-demo.service
  systemctl daemon-reload
  systemctl enable --now cybersentinel-demo.service \
    || warn "could not start cybersentinel-demo.service"
  DEMO_ENABLED=1
  # Keep the serial port exclusive to the demo. The gateway is NOT deleted —
  # it is just parked; one command brings the app back.
  systemctl disable --now cybersentinel-gateway.service >/dev/null 2>&1 \
    && log "gateway parked (serial belongs to the demo) — re-enable anytime"
  warn "THE ROVER WILL DRIVE ITSELF after every boot — lift the wheels or run:"
  warn "  sudo systemctl disable --now cybersentinel-demo.service"
else
  warn "pi/demo-drive.py missing — the boot demo is not installed"
  systemctl enable --now cybersentinel-greet.service >/dev/null 2>&1 || true
fi

# One audible proof, right now, from the exact code path the boot uses. When
# the demo is running it already spoke via demo-drive.py; saying it again here
# would be the double-greeting, so only the standalone greeter demos audibly.
if [[ ${DEMO_ENABLED} -eq 0 ]]; then
  /usr/local/bin/cybersentinel-greet.sh || true
fi

if systemctl enable --now cybersentinel-gateway; then
  log "cybersentinel-gateway is running"

  # `enable --now` only proves systemd LAUNCHED the unit. With Restart=always a
  # gateway that crashes on startup is still reported as started here and then
  # loops forever, so the bound port is the real evidence that it came up. The
  # journal is dumped on failure because that is where the traceback lives.
  GW_BOUND=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if ss -ltn 2>/dev/null | grep -qE "[:.]${API_PORT}[[:space:]]"; then
      GW_BOUND=1
      break
    fi
    sleep 1
  done
  if [[ ${GW_BOUND} -eq 1 ]]; then
    log "Gateway is listening on :${API_PORT}"
  else
    warn "The gateway did not bind :${API_PORT} within 10s — it is not coming up."
    # Import-time faults (the speaker probe, the camera manager, serial
    # discovery) kill the process before uvicorn can bind, and systemd then
    # records only an exit code. --check builds all of it and prints the real
    # error; CS_CAMERA_ENABLE=0 keeps the probe off the capture device.
    warn "Startup self-test (builds every subsystem, binds nothing):"
    CS_CAMERA_ENABLE=0 timeout 30 "${INSTALL_DIR}/venv/bin/python" \
      "${INSTALL_DIR}/gateway.py" --check 2>&1 | sed 's/^/      /' >&2 || true
    warn "Its own log lines:"
    journalctl -u cybersentinel-gateway -n 40 --no-pager >&2 || true
    warn "Or watch the same thing live, in the foreground:"
    warn "  sudo -u ${RUN_USER} /opt/cybersentinel/venv/bin/python /opt/cybersentinel/gateway.py"
  fi
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
reply = data.get("reply")
if reply is None:
    print("    [!!] reply   : no reply block - the deployed gateway.py is stale")
else:
    mark = "[ok]" if str(reply).startswith("groq") else "[--]"
    print(f"    {mark} reply   : {reply}")
PY
fi

# ---------------------------------------------------------------------------
# Groq key — without it the Pi speaks the app's plain template replies, which is
# valid but is not what "the Pi talks back naturally" needs.
# ---------------------------------------------------------------------------
if ! grep -qE '^CS_GROQ_API_KEY=.+' "${INSTALL_DIR}/gateway.env" 2>/dev/null; then
  warn "CS_GROQ_API_KEY is not set in ${INSTALL_DIR}/gateway.env."
  warn "  Spoken replies will use the app's template wording instead of Groq."
  warn "  To enable natural replies: add the line then restart the service"
  warn "    CS_GROQ_API_KEY=<your key from console.groq.com/keys>"
  warn "    sudo systemctl restart cybersentinel-gateway"
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
CAM_PORT="${GW_CAM_PORT}"

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
WS_PORT="${GW_WS_PORT}"

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

# The check above dials 127.0.0.1, which a socket bound to localhost - or a
# firewall - leaves green while every phone on the WiFi still gets "connection
# refused". Same hop, but over the address the app actually dials.
LAN_IP_CHECK="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [[ -n "${LAN_IP_CHECK}" ]]; then
  if (exec 3<>"/dev/tcp/${LAN_IP_CHECK}/${WS_PORT}") 2>/dev/null; then
    exec 3<&- 2>/dev/null || true
    log "The control socket answers on the LAN (${LAN_IP_CHECK}:${WS_PORT})"
  else
    warn "The control socket does NOT answer on ${LAN_IP_CHECK}:${WS_PORT}, so the app"
    warn "will get 'connection refused' even though localhost worked above."
    warn "  sudo ss -ltnp | grep ${WS_PORT}          (is it 0.0.0.0 or 127.0.0.1?)"
    warn "  sudo ufw status && sudo ufw allow ${WS_PORT}/tcp"
  fi

  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | head -n 1 | grep -qi active; then
    warn "ufw is active - the app needs ${WS_PORT}/tcp, ${API_PORT}/tcp, ${CAM_PORT}/tcp and 9001/tcp:"
    warn "  sudo ufw allow ${WS_PORT}/tcp && sudo ufw allow ${API_PORT}/tcp"
    warn "  sudo ufw allow ${CAM_PORT}/tcp && sudo ufw allow 9001/tcp"
  fi
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

  App connection  (Settings -> Connection -> "Pi IP Address"):
    host          ${IP}
    ws port       ${WS_PORT}     joystick + buttons (control socket)
    api port      ${API_PORT}    REST + discovery probe
    mqtt port     9001    live telemetry (MQTT over WebSocket)
    stream port   ${CAM_PORT}    camera (/stream.mjpg)
    demo mode     OFF

  Enter the IP, not the mDNS name: Android's resolver does not speak mDNS, so
  an app pointed at ${HOSTNAME_TARGET}.local fails with
  java.net.UnknownHostException instead of connecting. The name below is only
  usable from a computer (Linux/macOS/Windows) on the same WiFi:
    gateway  http://${HOSTNAME_TARGET}.local:${API_PORT}/health
    camera   http://${HOSTNAME_TARGET}.local:${CAM_PORT}/stream.mjpg
    control  ws://${HOSTNAME_TARGET}.local:${WS_PORT}
    mqtt     ws://${HOSTNAME_TARGET}.local:9001
  The app's "Find Pi on this WiFi" scans the subnet for ${IP}, so a DHCP lease
  change does not need to be typed in - but the phone and the Pi must be on the
  same network, with no client isolation (guest WiFi usually blocks it).

  Local checks (on the Pi itself, where mDNS resolves fine):
    curl -s http://127.0.0.1:${API_PORT}/health
    curl -s "http://127.0.0.1:${CAM_PORT}/snapshot.jpg" -o shot.jpg && ls -lh shot.jpg

  Logs:      journalctl -u cybersentinel-gateway -f
             journalctl -u mosquitto -f

  All services are enabled, so a power cycle brings everything back up. At every
  boot the Pi says "${CS_BOOT_GREETING:-Good morning Mohini maam}" on its speaker
  and then drives the rover in a loop (FORWARD/LEFT/RIGHT/BACKWARD,
  ${DEMO_STEP:-4}s each) until you stop it:
    sudo systemctl disable --now cybersentinel-demo.service   # stop the auto-drive
    sudo systemctl stop cybersentinel-demo.service             # stop right now
    journalctl -u cybersentinel-demo -f                        # watch it live

  Speaker check:
    speaker-test -t sine -f 440 -l 1
    espeak-ng "CyberSentinel online"
  Boot greeting (say it now / change the line):
    systemctl restart cybersentinel-greet.service
    # the line it says:  CS_BOOT_GREETING in ${INSTALL_DIR}/gateway.env

  Camera check:
    ${INSTALL_DIR}/venv/bin/python -c 'from picamera2 import Picamera2; print(Picamera2.global_camera_info())'

  Motor check:
    Control does not go over MQTT: the app opens the control socket above and
    sends MOVE / STOP / BUZZER. Two checks earlier in this run are what matter -
    whether that socket answered, and whether the gateway process holds the
    dialout group it needs to open the Arduino. Go by those results, not by this
    text. If both passed and the app still cannot move the rover, the fault is
    past the gateway: check the Arduino's USB cable and motor driver, and watch
    the sketch's own log:
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
