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
AUDIO_DEVICE="${CS_AUDIO_DEVICE:-plughw:2,0}"   # 3.5mm jack (card 2) — confirmed audible

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

# 1. THE HARDCODED COMMAND — tested audible on this Pi's USB speaker:
#      espeak-ng -v en-us+f3 -s 135 -p 65 -a 150 "Good morning Mohini ma'am"
#    Try it verbatim (with the configured text) before anything fancy.
echo "[greet] saying (direct espeak): $TEXT"
if espeak-ng -v en-us+f3 -s 135 -p 65 -a 150 "$TEXT" >/dev/null 2>&1; then
  exit 0
fi

# 2. Fallback: render to a temp WAV (synthesized from text, nothing shipped),
#    then try players until the speaker is audible: session players first
#    (paplay/ffplay), then raw ALSA devices that work under sudo / before
#    PipeWire is up.
echo "[greet] direct path failed — trying the player walk"
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
