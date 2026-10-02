#!/usr/bin/env bash
# Shared machine slots; LLV_GATE_LOCK_DIR=/var/tmp joins the legacy gate slots.
set -euo pipefail
slots=${LLV_GATE_SLOTS:-6}
if [[ ! "$slots" =~ ^[1-9][0-9]*$ ]]; then
  echo "LLV_GATE_SLOTS must be a positive integer" >&2
  exit 2
fi
if [[ $# -eq 0 ]]; then echo "usage: gate-slot.sh command [args...]" >&2; exit 2; fi
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=6144}"
run() {
  if command -v systemd-run >/dev/null && command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
    exec systemd-run --user --scope -q -p "MemoryMax=${LLV_GATE_MEM:-8G}" -- "$@"
  fi
  exec "$@"
}
# macOS has neither flock nor a systemd user manager.
if ! command -v flock >/dev/null; then run "$@"; fi
lock_dir=${LLV_GATE_LOCK_DIR:-${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/delegatus-gate}
mkdir -p "$lock_dir"
while :; do
  for ((i=1; i<=slots; i++)); do
    exec {fd}>"$lock_dir/llv-heavy-gate.slot$i.lock"
    if flock -n "$fd"; then run "$@"; fi
    exec {fd}>&-
  done
  sleep 2
done
