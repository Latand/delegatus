#!/usr/bin/env bash
# Register the Viewer MCP server ("viewer") everywhere agents run on this
# machine: the operator's Claude Code user config, the operator's Codex
# config, and every Viewer-managed account (CLAUDE_CONFIG_DIR /
# CODEX_HOME under the app dir's accounts/, see bin/appDir.mjs). Idempotent —
# safe to re-run after adding accounts. An existing "viewer" entry is left
# alone, except one whose command runs the old agent-log-viewer package: that
# one is repointed at this launcher, since the package it names is renamed.
#
# The server name must stay "viewer" (or an isViewerMcpServer() match in
# src/lib/mcp/presentation.ts) so transcript calls render as Viewer cards.
set -euo pipefail

# DELEGATUS_X is the documented spelling of LLV_X and wins when both are set
# (docs/design/rename-delegatus.md §5).
LLV_MCP_RUNTIME_ROOT="${DELEGATUS_MCP_RUNTIME_ROOT:-${LLV_MCP_RUNTIME_ROOT:-}}"
LLV_MCP_BIN="${DELEGATUS_MCP_BIN:-${LLV_MCP_BIN:-}}"
LLV_CONFIG_ROOT="${DELEGATUS_CONFIG_ROOT:-${LLV_CONFIG_ROOT:-}}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STABLE_MCP_BIN="${LLV_MCP_RUNTIME_ROOT:-$HOME/.agents/tools/llv-mcp-runtime}/bin/mcp-server.mjs"
if [ -n "${LLV_MCP_BIN:-}" ]; then
  MCP_BIN="$LLV_MCP_BIN"
elif [ -f "$STABLE_MCP_BIN" ]; then
  MCP_BIN="$STABLE_MCP_BIN"
else
  MCP_BIN="$REPO_ROOT/bin/mcp-server.mjs"
fi
if [ -z "$LLV_CONFIG_ROOT" ]; then
  # The same answer every other entry point reads: ~/.config/delegatus on a new
  # install, the agent-log-viewer spelling on an existing one.
  LLV_CONFIG_ROOT="$(bun -e 'const [file, root] = process.argv.slice(-2); const { appDirIn } = await import(file); console.log(appDirIn(root));' "$REPO_ROOT/bin/appDir.mjs" "$HOME/.config")"
fi
ACCOUNTS_ROOT="$LLV_CONFIG_ROOT/accounts"

# A registration made by an install of the package before the rename runs a
# launcher inside that package; it stops existing once the package is gone.
legacy_package_command() { # $1 = text that holds the registered command
  case "$1" in
    */node_modules/agent-log-viewer/*|*/agent-log-viewer@*) return 0 ;;
    *) return 1 ;;
  esac
}

if [ ! -f "$MCP_BIN" ]; then
  echo "error: MCP launcher not found at $MCP_BIN (set LLV_MCP_BIN to override)" >&2
  exit 1
fi

add_claude() { # $1 = label, $2 = CLAUDE_CONFIG_DIR or "" for the user default
  local label="$1" dir="$2"
  local existing
  claude_in() { if [ -n "$dir" ]; then CLAUDE_CONFIG_DIR="$dir" claude "$@"; else claude "$@"; fi; }
  if existing="$(claude_in mcp get viewer 2>/dev/null)"; then
    if legacy_package_command "$existing"; then
      claude_in mcp remove viewer -s user >/dev/null
      claude_in mcp add viewer -s user -- bun "$MCP_BIN" >/dev/null
      echo "claude[$label]: viewer repointed from the agent-log-viewer package"
    else
      echo "claude[$label]: viewer already registered"
    fi
  else
    claude_in mcp add viewer -s user -- bun "$MCP_BIN" >/dev/null
    echo "claude[$label]: viewer added"
  fi
}

add_codex_toml() { # $1 = label, $2 = config.toml path
  local label="$1" toml="$2"
  if [ ! -f "$toml" ]; then
    echo "codex[$label]: no config.toml, skipped"
    return
  fi
  if grep -q '^\[mcp_servers\.viewer\]' "$toml"; then
    local section
    section="$(awk '/^\[/{inside=($0=="[mcp_servers.viewer]")} inside' "$toml")"
    if legacy_package_command "$section"; then
      local rewritten="$toml.install-mcp.$$"
      awk -v bin="$MCP_BIN" '
        /^\[/ { inside = ($0 == "[mcp_servers.viewer]") }
        inside && /^[[:space:]]*args[[:space:]]*=/ { print "args = [\"" bin "\"]"; next }
        { print }
      ' "$toml" > "$rewritten" && mv "$rewritten" "$toml"
      echo "codex[$label]: viewer repointed from the agent-log-viewer package"
    else
      echo "codex[$label]: viewer already registered"
    fi
    return
  fi
  printf '\n[mcp_servers.viewer]\ncommand = "bun"\nargs = ["%s"]\n' "$MCP_BIN" >> "$toml"
  echo "codex[$label]: viewer added"
}

command -v claude >/dev/null 2>&1 && add_claude user "" || echo "claude: CLI not found, skipped user config"
add_codex_toml user "$HOME/.codex/config.toml"

for dir in "$ACCOUNTS_ROOT"/claude/*/; do
  [ -d "$dir" ] || continue
  case "$dir" in *.lock/) continue ;; esac
  add_claude "$(basename "$dir")" "$dir"
done

for dir in "$ACCOUNTS_ROOT"/codex/*/; do
  [ -d "$dir" ] || continue
  case "$dir" in *.lock/) continue ;; esac
  add_codex_toml "$(basename "$dir")" "${dir}config.toml"
done

echo "done. New agent sessions pick the server up at startup; running sessions need a restart."
