#!/usr/bin/env bash
# Register the Viewer MCP server ("viewer") everywhere agents run on this
# machine: the operator's Claude Code user config, the operator's Codex
# config, and every Viewer-managed account (CLAUDE_CONFIG_DIR /
# CODEX_HOME under ~/.config/agent-log-viewer/accounts). Idempotent —
# safe to re-run after adding accounts.
#
# The server name must stay "viewer" (or an isViewerMcpServer() match in
# src/lib/mcp/presentation.ts) so transcript calls render as Viewer cards.
#
# LLV_MCP_TRANSPORT=http REMOVES the viewer registration from the
# Viewer-managed Codex accounts. Codex layers a thread's config over
# config.toml key by key, so whatever an account registers wins over the
# per-launch choice: a stdio `command` cannot take a `url`, and a `url` cannot
# be switched back. With nothing registered, the Viewer writes the whole viewer
# table into each thread itself, over HTTP when that launch carries a
# capability and can pass LLV_TOKEN, and over stdio otherwise.
# LLV_MCP_TRANSPORT=stdio (or no flag) registers the stdio launcher again and
# rewrites a leftover `url` registration back to it. Claude spawns need no
# registration change: the Viewer writes their whole MCP config itself. The
# operator's own configs stay stdio, since only a Viewer-launched agent carries
# the capability the endpoint requires.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STABLE_MCP_BIN="${LLV_MCP_RUNTIME_ROOT:-$HOME/.agents/tools/llv-mcp-runtime}/bin/mcp-server.mjs"
if [ -n "${LLV_MCP_BIN:-}" ]; then
  MCP_BIN="$LLV_MCP_BIN"
elif [ -f "$STABLE_MCP_BIN" ]; then
  MCP_BIN="$STABLE_MCP_BIN"
else
  MCP_BIN="$REPO_ROOT/bin/mcp-server.mjs"
fi
ACCOUNTS_ROOT="${LLV_CONFIG_ROOT:-$HOME/.config/agent-log-viewer}/accounts"

if [ ! -f "$MCP_BIN" ]; then
  echo "error: MCP launcher not found at $MCP_BIN (set LLV_MCP_BIN to override)" >&2
  exit 1
fi

add_claude() { # $1 = label, $2 = CLAUDE_CONFIG_DIR or "" for the user default
  local label="$1" dir="$2"
  if [ -n "$dir" ]; then
    if CLAUDE_CONFIG_DIR="$dir" claude mcp get viewer >/dev/null 2>&1; then
      echo "claude[$label]: viewer already registered"
    else
      CLAUDE_CONFIG_DIR="$dir" claude mcp add viewer -s user -- bun "$MCP_BIN" >/dev/null
      echo "claude[$label]: viewer added"
    fi
  else
    if claude mcp get viewer >/dev/null 2>&1; then
      echo "claude[$label]: viewer already registered"
    else
      claude mcp add viewer -s user -- bun "$MCP_BIN" >/dev/null
      echo "claude[$label]: viewer added"
    fi
  fi
}

TRANSPORT="${LLV_MCP_TRANSPORT:-}"

codex_stdio_block() {
  printf '\n[mcp_servers.viewer]\ncommand = "bun"\nargs = ["%s"]\n' "$MCP_BIN"
}

# The [mcp_servers.viewer] table and its sub-tables, as registered now.
codex_viewer_table() {
  awk '/^\[/ { keep = ($0 ~ /^\[mcp_servers\.viewer(\.[^]]*)?\][[:space:]]*$/) } keep' "$1"
}

# Replace the viewer table (and its sub-tables) with $2, or drop it when $2 is
# empty, keeping the file mode.
rewrite_codex_viewer() { # $1 = config.toml path, $2 = block
  local toml="$1" tmp
  tmp="$(mktemp "${toml}.XXXXXX")"
  awk '/^\[/ { skip = ($0 ~ /^\[mcp_servers\.viewer(\.[^]]*)?\][[:space:]]*$/) } !skip' "$toml" > "$tmp"
  [ -n "$2" ] && printf '%s\n' "$2" >> "$tmp"
  chmod --reference="$toml" "$tmp"
  mv "$tmp" "$toml"
}

add_codex_toml() { # $1 = label, $2 = config.toml path, $3 = "account" to honour LLV_MCP_TRANSPORT
  local label="$1" toml="$2" scope="${3:-}"
  if [ ! -f "$toml" ]; then
    echo "codex[$label]: no config.toml, skipped"
    return
  fi
  local want=""
  [ "$scope" = "account" ] && want="$TRANSPORT"
  if [ "$want" = "http" ]; then
    if grep -q '^\[mcp_servers\.viewer\]' "$toml"; then
      rewrite_codex_viewer "$toml" ""
      echo "codex[$label]: viewer registration removed; each Viewer launch now writes its own"
    else
      echo "codex[$label]: viewer not registered; each Viewer launch writes its own"
    fi
    return
  fi
  if grep -q '^\[mcp_servers\.viewer\]' "$toml"; then
    if [ "$scope" = "account" ] && ! codex_viewer_table "$toml" | grep -q '^command[[:space:]]*='; then
      rewrite_codex_viewer "$toml" "$(codex_stdio_block)"
      echo "codex[$label]: viewer switched to stdio"
    else
      echo "codex[$label]: viewer already registered"
    fi
    return
  fi
  codex_stdio_block >> "$toml"
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
  add_codex_toml "$(basename "$dir")" "${dir}config.toml" account
done

echo "done. New agent sessions pick the server up at startup; running sessions need a restart."
