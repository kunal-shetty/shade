#!/usr/bin/env bash
# CyberSentinel boot greeting — the Pi itself says hello on its own speaker,
# straight from systemd, no app or browser involved.
#
# Tunables (optional lines in /opt/cybersentinel/gateway.env):
#   CS_BOOT_GREETING="Good morning Mohini maam"   # the line to say
#   CS_BOOT_GREET_DELAY=8                          # seconds to wait for audio stack
#   CS_TTS_VOICE / CS_TTS_PITCH / CS_TTS_RATE      # same voice values the gateway uses
# ---------------------------------------------------------------------------
set -u

# The systemd unit also passes gateway.env via EnvironmentFile; sourcing here
# covers manual runs (`sudo /usr/local/bin/cybersentinel-greet.sh`).
ENV_FILE="/opt/cybersentinel/gateway.env"
[ -r "$ENV_FILE" ] && . "$ENV_FILE"

TEXT="${CS_BOOT_GREETING:-Good morning Mohini maam}"
DELAY="${CS_BOOT_GREET_DELAY:-8}"
VOICE="${CS_TTS_VOICE:-en-us+f3}"
PITCH="${CS_TTS_PITCH:-65}"
RATE="${CS_TTS_RATE:-135}"
AMPLITUDE="${CS_TTS_AMPLITUDE:-150}"

# HDMI/headphone audio routing and ALSA need a moment after boot.
sleep "$DELAY"

ENGINE=""
for candidate in espeak-ng espeak; do
  if command -v "$candidate" >/dev/null 2>&1; then ENGINE="$candidate"; break; fi
done
if [ -z "$ENGINE" ]; then
  echo "[greet] no TTS engine installed — staying silent"
  exit 0
fi

# espeak exits non-zero for a voice it does not know; drop to the base language.
if ! "$ENGINE" -v "$VOICE" -q ok >/dev/null 2>&1; then
  VOICE="${VOICE%%+*}"
  [ "$VOICE" = "en" ] || VOICE="en"
fi

echo "[greet] saying: $TEXT"
exec "$ENGINE" -v "$VOICE" -p "$PITCH" -s "$RATE" -a "$AMPLITUDE" "$TEXT" >/dev/null 2>&1
