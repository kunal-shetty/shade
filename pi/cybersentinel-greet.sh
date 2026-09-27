#!/usr/bin/env bash
# CyberSentinel boot greeting — the Pi itself says hello on its own speaker,
# straight from systemd, no app or browser involved.
#
# Tunables (optional lines in /opt/cybersentinel/gateway.env):
#   CS_BOOT_GREETING="Good morning Mohini maam"   # the line to say
#   CS_BOOT_GREET_DELAY=8                          # seconds to wait for audio stack
#   CS_TTS_VOICE / CS_TTS_RATE / CS_TTS_PITCH / CS_TTS_AMPLITUDE
#   CS_AUDIO_DEVICE=plughw:1,0   # pin the speaker card (see aplay -l)
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
AUDIO_DEVICE="${CS_AUDIO_DEVICE:-}"

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

# Render the voice to a temp WAV (no audio file is shipped — this is synthesized
# from text every time), then try players until the speaker is audible. Plain
# espeak output dies silently under sudo / before PipeWire, so the players do
# the real work: session first (paplay/ffplay), then raw ALSA devices.
echo "[greet] saying: $TEXT"
WAV="/tmp/cs_greet.wav"
"$ENGINE" -v "$VOICE" -p "$PITCH" -s "$RATE" -a "$AMPLITUDE" -w "$WAV" "$TEXT" >/dev/null 2>&1 \
  || { echo "[greet] render failed"; exit 0; }

for cmd in \
  ${AUDIO_DEVICE:+aplay -q -D $AUDIO_DEVICE} \
  paplay \
  "ffplay -nodisp -autoexit -loglevel quiet" \
  "aplay -q" \
  "aplay -q -D plughw:0,0" \
  "aplay -q -D plughw:1,0" \
  "aplay -q -D plughw:2,0"; do
  case "$cmd" in
    paplay)  command -v paplay >/dev/null 2>&1 && { paplay "$WAV" >/dev/null 2>&1 && exit 0; } ;;
    ffplay*) command -v ffplay  >/dev/null 2>&1 && { $cmd      "$WAV" >/dev/null 2>&1 && exit 0; } ;;
    aplay*)  command -v aplay   >/dev/null 2>&1 && { $cmd      "$WAV" >/dev/null 2>&1 && exit 0; } ;;
  esac
done
echo "[greet] no player was audible — check: aplay -l ; sudo raspi-config (Audio)"
exit 0
