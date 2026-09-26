import {
  CODEX_VIEWER_SPAWN_FEATURES,
  viewerMcpHttpCodexEntry,
  viewerMcpServerEntry,
  viewerMcpServerEnv,
  type ViewerMcpTransport,
} from "@/lib/agent/spawnPolicy";
import { grantedMcpServers } from "@/lib/agent/mcpAllowlist";
import { grantedPlugins } from "@/lib/agent/pluginAllowlist";
import { operatorTelegramCodexEntry } from "@/lib/runtime/telegramConnectorEnv";

type JsonObject = Record<string, unknown>;
const MCP_APPROVAL_MODES = new Set(["auto", "prompt", "writes", "approve"]);

function record(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

/** `config/read` reports every optional field of a server, using null for the
    ones nobody set — `tool_timeout_sec: null` for a server that never declared
    one. Codex will not accept those nulls back as input: replaying the entry
    verbatim makes it reject the whole launch with "invalid type: string ``,
    expected f64" and no session starts at all (#1410). Only fields carrying a
    real value are replayed; an absent field stays absent, which is what the
    operator's configuration said in the first place. */
function withoutUnsetFields(server: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(server).filter(([, value]) => value !== null && value !== undefined));
}

/** Per-plugin thread table for a granted session: every plugin Codex knows
 *  about, with only the granted names enabled. Codex 0.145 accepts this table
 *  on `thread/start` but resolves plugins from the global config instead, so it
 *  is the declarative record of the grant — the realized surface is verified
 *  against the same allowlist once the thread exists (`codexAppServerHost`). */
function pluginTable(config: JsonObject, granted: readonly string[]): JsonObject {
  const installed = record(config.plugins) ?? {};
  const keys = new Set(Object.keys(installed));
  /* Plugin ids are `<name>@<marketplace>`; the grant names the plugin only. */
  for (const name of granted) {
    if (![...keys].some((key) => key.split("@")[0] === name)) keys.add(name);
  }
  return Object.fromEntries([...keys].map((key) => [key, { enabled: granted.includes(key.split("@")[0]) }]));
}

/**
 * Whether this thread reaches the Viewer over the shared HTTP endpoint.
 *
 * Codex layers a thread's `config` over `config.toml` key by key; it never
 * replaces a server's table. So once an account registers `viewer` as a stdio
 * launcher (`command`), adding a `url` on top is refused outright — codex-cli
 * 0.155.1 answers `thread/start` with "url is not supported for stdio" and no
 * session starts. The reverse holds too: a registered `url` cannot be turned
 * back into a stdio launcher for a launch that needs one. So the per-launch
 * choice works only where the account registers no `viewer` at all, which is
 * what `LLV_MCP_TRANSPORT=http scripts/install-mcp.sh` leaves behind: this
 * table then materializes the Viewer server for each thread, over HTTP or as
 * the stdio launcher. A stdio registration keeps every thread on stdio; a
 * leftover `url` registration is replayed as it stands (the script rewrites
 * one back to stdio).
 */
export function codexViewerOverHttp(configuredViewer: JsonObject | null, transport: ViewerMcpTransport): boolean {
  return transport === "http" && (configuredViewer === null || typeof configuredViewer.command !== "string");
}

/** Builds a fail-closed thread override from Codex's effective configuration. */
export function headlessCodexThreadConfig(
  configRead: unknown,
  allowSubagents = false,
  mcpServers: readonly string[] | undefined = undefined,
  plugins: readonly string[] | undefined = undefined,
  /** This launch's transport (`viewerMcpTransportForLaunch`); stdio unless the
      caller knows the thread's environment carries a capability. */
  viewerTransport: ViewerMcpTransport = "stdio",
): JsonObject {
  const config = record(record(configRead)?.config);
  const servers = record(config?.mcp_servers);
  if (!config || !servers) throw new Error(mcpServers?.includes("telegram")
    ? "telegram MCP effective config is unavailable"
    : "config/read returned no MCP server table");
  /* The grant bound is enforced again here (issue #739): the thread's enable
     table is materialized from the re-validated list, so a launch profile
     edited by hand cannot turn a server on for this thread. */
  const enabled = new Set(grantedMcpServers(mcpServers));
  const configuredViewer = record(servers.viewer);
  const viewerOverHttp = codexViewerOverHttp(configuredViewer, viewerTransport);
  const viewerMissing = configuredViewer === null;
  /* The environment pin belongs to a stdio launcher only; an account that
     registers the Viewer over HTTP keeps that shape whatever the flag says. */
  const viewerStdio = !viewerOverHttp && (viewerMissing || typeof configuredViewer.command === "string");
  const withViewer = viewerMissing && enabled.has("viewer")
    ? { ...servers, viewer: viewerOverHttp ? viewerMcpHttpCodexEntry() : viewerMcpServerEntry() }
    : servers;
  const configuredTelegram = record(servers.telegram);
  if (enabled.has("telegram") && configuredTelegram?.command) {
    throw new Error("telegram MCP account definition conflicts with operator connector");
  }
  const materializedServers = enabled.has("telegram")
    ? { ...withViewer, telegram: operatorTelegramCodexEntry() }
    : withViewer;
  /* The plugin subsystem is off for every session that holds no grant, which
     is the default. A grant turns it on for THIS thread only — never for the
     app-server, never in the operator's configuration. */
  const granted = grantedPlugins(plugins);
  return {
    mcp_servers: Object.fromEntries(Object.entries(materializedServers).map(([name, server]) => {
      const configuredApproval = record(server)?.default_tools_approval_mode;
      const approval = name === "viewer"
        ? "approve"
        : typeof configuredApproval === "string" && MCP_APPROVAL_MODES.has(configuredApproval)
          ? configuredApproval
          : null;
      return [name, {
        /* A replacement app-server must receive the launch definition again.
           Its predecessor owned the stdio child, so an enable flag alone
           leaves a resumed thread with no connector process to call (#1346). */
        ...(name === "viewer" || (name === "telegram" && enabled.has("telegram"))
          ? withoutUnsetFields(server as JsonObject) : {}),
        /* The thread runs under the agent's own config and state root
           (#1905); the Viewer server keeps the real ones, so the MCP link
           still finds this machine's release. A value already configured for
           the server wins. An HTTP server takes no `env` (Codex refuses it
           there); it takes the shared endpoint's URL and the header that
           carries this agent's capability instead. */
        ...(name === "viewer" && viewerStdio
          ? { env: { ...viewerMcpServerEnv(), ...record(record(server)?.env) } }
          : {}),
        ...(name === "viewer" && viewerOverHttp ? viewerMcpHttpCodexEntry() : {}),
        enabled: enabled.has(name),
        ...(approval ? { default_tools_approval_mode: approval } : {}),
      }];
    })),
    /* The per-thread features table replaces the app-server's global one, so
       the realtime flag the host passes via `--enable realtime_conversation`
       must be restated here or thread/realtime/start fails locally (#621). */
    features: {
      ...CODEX_VIEWER_SPAWN_FEATURES,
      plugins: granted.length > 0,
      multi_agent: allowSubagents,
      realtime_conversation: true,
    },
    ...(granted.length > 0 ? { plugins: pluginTable(config, granted) } : {}),
    include_apps_instructions: false,
  };
}
