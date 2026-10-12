#!/usr/bin/env bash
# Renders the phone voice prototype through the existing phone driver, in an export of the repository.
#
#   harness/run.sh <worktree> <scratch> <evidence root> [MVF_ONLY regex]
#
# <scratch> holds the export (<scratch>/exp, made by `git archive HEAD | tar -x` plus
# `bun install --frozen-lockfile`) and everything the run writes besides the frames. Home, state and
# temp are private to the run, the control URL points at a closed port, and Chromium alone gets a
# short TMPDIR through a wrapper: its socket path under a stage's scratch passes the 107-byte limit.
set -euo pipefail
worktree=$(realpath "$1"); scratch=$(realpath "$2"); evidence=$3; only=${4:-}
export_dir="$scratch/exp"
root="$scratch/run"
mkdir -p "$root"/{home,config,cache,data,state,tmp,ct} "$evidence"
short="/run/user/$(id -u)/mvf-$$"
ln -sfn "$root/ct" "$short"
trap 'rm -f "$short"' EXIT
chrome=$(ls -d "${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"/chromium-*/chrome-linux64/chrome | sort -V | tail -1)
cat > "$root/chrome.sh" <<EOF
#!/usr/bin/env bash
export TMPDIR=$short
exec $chrome "\$@"
EOF
chmod +x "$root/chrome.sh"
bun "$worktree/docs/design/mobile-voice-floating/harness/apply.mjs" "$worktree" "$export_dir"
cd "$export_dir"
unset LLV_STATE_OWNER LLV_INBOX_DIR LLV_SPAWN_CAPABILITY LLV_STRUCTURED_HOST LLV_VIEWER_CONTROL_TOKEN LLV_VIEWER_DEPLOY_TARGET LLV_VIEWER_PORT
env HOME="$root/home" XDG_CONFIG_HOME="$root/config" XDG_CACHE_HOME="$root/cache" XDG_DATA_HOME="$root/data" \
  LLV_STATE_DIR="$root/state" TMPDIR="$root/tmp" CLAUDE_CODE_TMPDIR="$root/tmp" CODEX_HOME="$root/home/codex" CLAUDE_CONFIG_DIR="$root/home/claude" \
  LLV_VIEWER_CONTROL_URL=http://127.0.0.1:9 NODE_ENV=test DELEGATUS_TELEMETRY=0 DO_NOT_TRACK=1 \
  PLAYWRIGHT_BROWSERS_PATH="$(dirname "$(dirname "$(dirname "$chrome")")")" \
  LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN="$root/chrome.sh" MVF_OUT="$evidence" MVF_ONLY="$only" MVF_PROBE="${MVF_PROBE:-}" MVF_RUN_MARK="mvf-$$" \
  bash scripts/gate-slot.sh bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "phone voice head prototype" --timeout 2400000
