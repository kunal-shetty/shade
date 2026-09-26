#!/usr/bin/env bash
# CyberSentinel Rover — Raspberry Pi provisioning
#
# Turns a fresh Raspberry Pi OS (Bookworm, 64-bit) into the rover gateway:
#   * mDNS so the phone finds it as cybersentinel.local
#   * Mosquitto MQTT with a websockets listener for the app
#   * a text-to-speech engine driving the speaker
#   * the FastAPI gateway as a systemd service
#
# Usage (on the Pi):  sudo bash pi/setup.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="/opt/cybersentinel"
RUN_USER="${SUDO_USER:-pi}"
HOSTNAME_TARGET="cybersentinel"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this with sudo." >&2
  exit 1
fi

log "Installing system packages"
apt-get update
apt-get install -y python3-venv python3-pip \
  mosquitto mosquitto-clients \
  avahi-daemon libnss-mdns \
  espeak-ng alsa-utils \
  ffmpeg

log "Setting hostname to ${HOSTNAME_TARGET} (mDNS)"
hostnamectl set-hostname "${HOSTNAME_TARGET}"
# Keep the /etc/hosts 127.0.1.1 line in sync with the new name.
if grep -q '^127\.0\.1\.1' /etc/hosts; then
  sed -i "s/^127\.0\.1\.1.*/127.0.1.1\t${HOSTNAME_TARGET}/" /etc/hosts
else
  echo -e "127.0.1.1\t${HOSTNAME_TARGET}" >> /etc/hosts
fi
systemctl enable --now avahi-daemon

log "Configuring Mosquitto (1883 TCP + 9001 websockets)"
cp "${REPO_DIR}/pi/mosquitto.conf" /etc/mosquitto/conf.d/cybersentinel.conf
systemctl enable mosquitto
systemctl restart mosquitto

log "Creating ${INSTALL_DIR}"
mkdir -p "${INSTALL_DIR}"
cp "${REPO_DIR}/gateway.py" "${INSTALL_DIR}/gateway.py"
[[ -f "${INSTALL_DIR}/gateway.env" ]] || cp "${REPO_DIR}/pi/gateway.env.example" "${INSTALL_DIR}/gateway.env"

log "Creating Python virtualenv"
python3 -m venv "${INSTALL_DIR}/venv"
"${INSTALL_DIR}/venv/bin/pip" install --upgrade pip
"${INSTALL_DIR}/venv/bin/pip" install -r "${REPO_DIR}/pi/requirements.txt"

chown -R "${RUN_USER}:${RUN_USER}" "${INSTALL_DIR}"
chmod +x "${INSTALL_DIR}/gateway.py"

log "Installing systemd service"
sed "s/^User=pi$/User=${RUN_USER}/" "${REPO_DIR}/pi/cybersentinel-gateway.service" \
  > /etc/systemd/system/cybersentinel-gateway.service
systemctl daemon-reload
systemctl enable --now cybersentinel-gateway

log "Done."
IP="$(hostname -I | awk '{print $1}')"
cat <<EOF

  Gateway:   http://${HOSTNAME_TARGET}.local:8000/health   (IP ${IP})
  WebSocket: ws://${HOSTNAME_TARGET}.local:8765
  MQTT/WS:   ws://${HOSTNAME_TARGET}.local:9001
  Logs:      journalctl -u cybersentinel-gateway -f

  Make sure the speaker is on the default ALSA output:
    speaker-test -t sine -f 440 -l 1
    espeak-ng "CyberSentinel online"
EOF
