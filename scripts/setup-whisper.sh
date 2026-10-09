#!/usr/bin/env bash
# Creates the local faster-whisper venv the viewer's dictation uses and
# verifies transcription and pre-downloads the model for the first dictation.
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
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
"$VENV/bin/python" -m pip install --quiet -r "$SCRIPT_DIR/whisper-requirements.txt"

COMPUTE=int8
[ "$DEVICE" = "cuda" ] && COMPUTE=int8_float16
"$VENV/bin/python" - "$MODEL" "$DEVICE" "$COMPUTE" <<'PY'
import sys
import tempfile
import wave
from pathlib import Path
from faster_whisper import WhisperModel
model = WhisperModel(sys.argv[1], device=sys.argv[2], compute_type=sys.argv[3])
with tempfile.TemporaryDirectory(prefix="whisper-smoke-") as directory:
    audio = Path(directory) / "silence.wav"
    with wave.open(str(audio), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(b"\x00\x00" * 16000)
    # Consume the lazy iterator so inference errors also fail setup. Silence
    # can yield an empty transcript; decoding and inference must still finish.
    segments, _ = model.transcribe(str(audio), language="en", vad_filter=False)
    list(segments)
print("transcription smoke passed:", sys.argv[1], sys.argv[2])
PY

echo "whisper venv ready at $VENV"
