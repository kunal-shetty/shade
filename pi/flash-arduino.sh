#!/usr/bin/env bash
# CyberSentinel Rover — flash arduino.cpp onto the Arduino, from the Pi itself.
#
# The Pi and the Arduino already share a USB cable, so there is no need for a
# second computer running the Arduino IDE. This script:
#
#   1. installs arduino-cli (apt, falling back to Arduino's installer)
#   2. installs the AVR core and the two libraries the sketch needs
#   3. stops the gateway, because it holds /dev/ttyACM0 open and the upload
#      would otherwise fail with "resource busy"
#   4. compiles and uploads the sketch
#   5. starts the gateway again and checks that the new firmware answered
#
# Usage (on the Pi, from the repo root):  sudo bash pi/flash-arduino.sh
# Override the port if auto-detection picks the wrong device:
#   sudo bash pi/flash-arduino.sh /dev/ttyACM0
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKETCH_NAME="cybersentinel"
WORK_DIR="${REPO_DIR}/.arduino-build"
FQBN="arduino:avr:uno"
SERVICE="cybersentinel-gateway"
INSTALL_DIR="/opt/cybersentinel"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

if [[ "$(id -u)" -ne 0 ]]; then
  die "Run this with sudo — it has to stop the gateway:  sudo bash pi/flash-arduino.sh"
fi
[[ -f "${REPO_DIR}/arduino.cpp" ]] \
  || die "Cannot find arduino.cpp next to this script (looked in ${REPO_DIR})."

# arduino-cli keeps its cores and libraries in the invoking user's home, so it
# is run as that user rather than as root — otherwise every flash would
# re-download the toolchain and the libraries would be invisible next time.
RUN_USER="${SUDO_USER:-root}"
run_as_user() {
  if [[ "${RUN_USER}" == "root" || "${RUN_USER}" == "" ]]; then
    "$@"
  else
    sudo -u "${RUN_USER}" -- "$@"
  fi
}

# ---------------------------------------------------------------------------
# Serial port (same probing rules as the gateway)
# ---------------------------------------------------------------------------
REQUESTED_PORT="${1:-}"

detect_port() {
  if [[ -n "${REQUESTED_PORT}" ]]; then
    [[ -e "${REQUESTED_PORT}" ]] || die "The port you gave does not exist: ${REQUESTED_PORT}"
    printf '%s' "${REQUESTED_PORT}"
    return
  fi
  # ttyACM first: that is what a genuine Uno R3 (CDC-ACM) enumerates as.
  ls /dev/ttyACM* /dev/ttyUSB* 2>/dev/null | head -1
}

PORT="$(detect_port)"
[[ -n "${PORT}" ]] || die "No /dev/ttyACM* or /dev/ttyUSB* found. Is the Arduino plugged into the Pi?"
log "Arduino on ${PORT}"

# ---------------------------------------------------------------------------
# arduino-cli
# ---------------------------------------------------------------------------
if command -v arduino-cli >/dev/null 2>&1; then
  log "arduino-cli already installed ($(arduino-cli version 2>/dev/null | head -1))"
else
  log "Installing arduino-cli"
  if apt-get install -y arduino-cli >/dev/null 2>&1 && command -v arduino-cli >/dev/null 2>&1; then
    log "arduino-cli installed from apt"
  else
    warn "Not available from apt — using Arduino's official installer."
    if curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh \
        | BINDIR=/usr/local/bin sh >/dev/null 2>&1 && command -v arduino-cli >/dev/null 2>&1; then
      log "arduino-cli installed to /usr/local/bin"
    else
      die "Could not install arduino-cli. Check the Pi's network, then re-run this script."
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Core + libraries
# ---------------------------------------------------------------------------
log "Updating the board index"
run_as_user arduino-cli core update-index >/dev/null 2>&1 \
  || warn "core update-index failed; continuing with whatever is cached"

if run_as_user arduino-cli core list 2>/dev/null | grep -q '^arduino:avr'; then
  log "AVR core already present"
else
  log "Installing the AVR core (arduino:avr)"
  run_as_user arduino-cli core install arduino:avr >/dev/null 2>&1 \
    || die "Could not install arduino:avr — the Pi needs network access for this first run."
  log "AVR core installed"
fi

log "Installing the sketch's libraries (U8g2, ArduinoJson)"
run_as_user arduino-cli lib install "U8g2" >/dev/null 2>&1 \
  || warn "U8g2 install failed — compilation will fail until it is present."

# ArduinoJson 7 removed StaticJsonDocument, which the sketch uses, so pin 6.x.
if run_as_user arduino-cli lib install "ArduinoJson@6.21.5" >/dev/null 2>&1; then
  log "ArduinoJson 6.21.5 installed"
else
  warn "Could not pin ArduinoJson 6.21.5; installing the latest instead."
  run_as_user arduino-cli lib install "ArduinoJson" >/dev/null 2>&1 \
    || warn "ArduinoJson install failed."
  # `lib list` columns are: Name Installed Available Location Description.
  ARDUINOJSON_VERSION="$(run_as_user arduino-cli lib list 2>/dev/null \
    | awk '$1 ~ /^ArduinoJson/ {print $2}' | head -1)"
  if [[ "${ARDUINOJSON_VERSION}" == 7* ]]; then
    warn "ArduinoJson ${ARDUINOJSON_VERSION} is installed, but arduino.cpp needs 6.x"
    warn "(v7 removed StaticJsonDocument). Install it by hand if compilation fails."
  fi
fi

# ---------------------------------------------------------------------------
# Stage the sketch
#
# arduino-cli insists that the .ino file share its directory's name, so
# arduino.cpp is copied into a build folder rather than compiled in place.
# ---------------------------------------------------------------------------
log "Staging the sketch"
rm -rf "${WORK_DIR}"
mkdir -p "${WORK_DIR}/${SKETCH_NAME}"
cp "${REPO_DIR}/arduino.cpp" "${WORK_DIR}/${SKETCH_NAME}/${SKETCH_NAME}.ino" \
  || die "Could not copy arduino.cpp into ${WORK_DIR}"

log "Compiling for ${FQBN}"
if ! COMPILE_OUT="$(run_as_user arduino-cli compile --fqbn "${FQBN}" \
      "${WORK_DIR}/${SKETCH_NAME}" 2>&1)"; then
  warn "Compilation failed:"
  printf '%s\n' "${COMPILE_OUT}" >&2
  warn "Most common cause: a missing library. Install U8g2 and ArduinoJson 6.x."
  exit 1
fi
log "Compiled cleanly"
# The Uno only has 2 KB of SRAM, so the memory report is worth showing: the
# three OLEDs use page buffers precisely to stay inside this budget.
printf '%s\n' "${COMPILE_OUT}" \
  | grep -iE 'Sketch uses|Global variables' | sed 's/^/      /' || true

# ---------------------------------------------------------------------------
# Free the serial port, upload, then put the gateway back
# ---------------------------------------------------------------------------
WAS_RUNNING=0
if systemctl is-active --quiet "${SERVICE}"; then
  WAS_RUNNING=1
fi

restore_gateway() {
  if [[ "${WAS_RUNNING}" -eq 1 ]]; then
    log "Starting ${SERVICE} again"
    # The Uno reboots as it leaves the bootloader; give it a moment to settle.
    sleep 2
    systemctl start "${SERVICE}" || warn "Could not start ${SERVICE} — start it by hand."
  fi
}
trap restore_gateway EXIT

if [[ "${WAS_RUNNING}" -eq 1 ]]; then
  log "Stopping ${SERVICE} to release ${PORT}"
  systemctl stop "${SERVICE}" || warn "Could not stop ${SERVICE}; the upload may fail."
  sleep 1
fi

# Anything else holding the port will make the upload fail, so name it now.
if command -v fuser >/dev/null 2>&1; then
  HOLDERS="$(fuser "${PORT}" 2>/dev/null || true)"
  if [[ -n "${HOLDERS}" ]]; then
    warn "Another process still holds ${PORT}: ${HOLDERS}"
    warn "Close the Arduino IDE's Serial Monitor or any script reading the port."
  fi
fi

log "Uploading to ${PORT}"
if ! UPLOAD_OUT="$(run_as_user arduino-cli upload -p "${PORT}" --fqbn "${FQBN}" \
      "${WORK_DIR}/${SKETCH_NAME}" 2>&1)"; then
  warn "Upload failed:"
  printf '%s\n' "${UPLOAD_OUT}" >&2
  if grep -qi 'resource busy\|permission denied' <<<"${UPLOAD_OUT}"; then
    warn "The port was in use or not permitted. Check for another program holding it,"
    warn "and that your user is in the dialout group (setup.sh adds this)."
  fi
  exit 1
fi
log "Uploaded — the Uno is rebooting"

# ---------------------------------------------------------------------------
# Prove the new firmware is actually running
# ---------------------------------------------------------------------------
API_PORT="$(grep -E '^CS_API_PORT=' "${INSTALL_DIR}/gateway.env" 2>/dev/null \
  | cut -d= -f2 | tr -d '[:space:]')"
API_PORT="${API_PORT:-8000}"

restore_gateway
trap - EXIT

log "Checking the gateway picked the Arduino back up"
sleep 4
HEALTH="$(curl -fsS --max-time 6 "http://127.0.0.1:${API_PORT}/health" 2>/dev/null || true)"
if [[ -z "${HEALTH}" ]]; then
  warn "No answer from http://127.0.0.1:${API_PORT}/health — check the service."
else
  SERIAL_BLOCK="$(grep -oE '"serial":[^}]*}' <<<"${HEALTH}" || true)"
  if [[ -n "${SERIAL_BLOCK}" ]]; then
    printf '      %s\n' "${SERIAL_BLOCK}"
  else
    warn "The gateway answering on :${API_PORT} is an older build (no serial block)."
  fi
fi

# The sketch announces itself at boot; seeing that line proves the flash took.
if journalctl -u "${SERVICE}" -n 40 --no-pager 2>/dev/null | grep -q '\[arduino/info\] arduino ready'; then
  log "The new firmware reported in:"
  journalctl -u "${SERVICE}" -n 40 --no-pager 2>/dev/null | grep '\[arduino' | tail -5 | sed 's/^/      /'
else
  warn "No 'arduino ready' line in the journal yet."
  warn "Watch it live:  journalctl -u ${SERVICE} -f | grep '\\[arduino'"
fi

cat <<EOF

  If the OLEDs are dark but the journal shows "oled not detected", it is wiring.
  The sketch also scans the hardware I2C bus at boot and logs every address it
  finds, which separates a bad connection from a wrong I2C address.

EOF
