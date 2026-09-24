#!/usr/bin/env bash
# Creates the local faster-whisper venv the viewer's dictation uses and
# pre-downloads the model so the first dictation is not the slow one.
set -euo pipefail

# DELEGATUS_X is the documented spelling of LLV_X and wins when both are set
# (docs/design/rename-delegatus.md §5).
LLV_WHISPER_VENV="${DELEGATUS_WHISPER_VENV:-${LLV_WHISPER_VENV:-}}"
LLV_WHISPER_MODEL="${DELEGATUS_WHISPER_MODEL:-${LLV_WHISPER_MODEL:-}}"
LLV_WHISPER_DEVICE="${DELEGATUS_WHISPER_DEVICE:-${LLV_WHISPER_DEVICE:-}}"

# The cache app dir follows bin/appDir.mjs: a real delegatus dir wins, an
# existing agent-log-viewer dir keeps its spelling, a new install gets
# delegatus. An existing live-log-viewer venv is reused so a re-run does not
# orphan it (mirrors the app's cache-dir fallback).
CACHE_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}"
if [ -d "$CACHE_ROOT/delegatus" ] && [ ! -L "$CACHE_ROOT/delegatus" ]; then
  APP_CACHE_DIR="$CACHE_ROOT/delegatus"
elif [ -d "$CACHE_ROOT/agent-log-viewer" ]; then
  APP_CACHE_DIR="$CACHE_ROOT/agent-log-viewer"
else
  APP_CACHE_DIR="$CACHE_ROOT/delegatus"
fi
NEW_VENV="$APP_CACHE_DIR/whisper-venv"
LEGACY_VENV="$CACHE_ROOT/live-log-viewer/whisper-venv"
if [ -n "${LLV_WHISPER_VENV:-}" ]; then
  VENV="$LLV_WHISPER_VENV"
elif [ ! -d "$NEW_VENV" ] && [ -d "$LEGACY_VENV" ]; then
  VENV="$LEGACY_VENV"
else
  VENV="$NEW_VENV"
fi
MODEL="${LLV_WHISPER_MODEL:-small}"
DEVICE="${LLV_WHISPER_DEVICE:-cpu}"

python3 -m venv "$VENV"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet faster-whisper

COMPUTE=int8
[ "$DEVICE" = "cuda" ] && COMPUTE=int8_float16
"$VENV/bin/python" - "$MODEL" "$DEVICE" "$COMPUTE" <<'PY'
import sys
from faster_whisper import WhisperModel
WhisperModel(sys.argv[1], device=sys.argv[2], compute_type=sys.argv[3])
print("model ready:", sys.argv[1], sys.argv[2])
PY

echo "whisper venv ready at $VENV"
