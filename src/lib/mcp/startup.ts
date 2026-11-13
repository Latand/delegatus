import type { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setTimeout as pause } from "node:timers/promises";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import { stateDir } from "@/lib/configDir";
import { deadlineSignal } from "@/lib/deadline";
import { viewerControlOrigin, viewerControlToken } from "./controlEndpoint";
import { MCP_CHECK_HEADER, MCP_REFUSAL_HEADER, MCP_REFUSAL_LABELS } from "./httpResponse";

/** The Viewer authenticates the launch capability, including successor
 * generations. No registry import, tool execution or local identity cache. */
async function checkCapability(method: "initialize" | "tools/list", signal?: AbortSignal): Promise<void> {
  const capability = process.env.LLV_SPAWN_CAPABILITY;
  // Interactive clients without a launch capability retain native attribution.
  if (capability === undefined) return;
  if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) throw new Error("spawn capability is malformed");
  const origin = viewerControlOrigin();
  const endpoint = new URL("/api/mcp", origin);
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) {
    throw new Error("spawn capability requires a loopback Viewer control endpoint");
  }
  const check = crypto.randomUUID();
  const headers = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream", [MCP_CHECK_HEADER]: check,
    origin: endpoint.origin, "sec-fetch-site": "same-origin", [VIEWER_SPAWN_CAPABILITY_HEADER]: capability });
  const token = viewerControlToken(process.env, origin);
  if (token) headers.set("authorization", `Bearer ${token}`);
  const deadline = deadlineSignal(10_000, { signal });
  let failure = "Viewer control is unavailable";
  let retryable = true;
  try {
    const response = await fetch(endpoint, { method: "POST", redirect: "error", headers, signal: deadline.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: "viewer-mcp-startup", method: "initialize",
        params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "delegatus-stdio", version: "1" } } }) });
    if (!response.ok) {
      retryable = [502, 503, 504].includes(response.status);
      const supplied = response.headers.get(MCP_REFUSAL_HEADER);
      const label = supplied && MCP_REFUSAL_LABELS.includes(supplied) ? supplied : "unlabelled";
      failure = `spawn capability could not be resolved by the Viewer (HTTP ${response.status}, ${label})`;
      await response.body?.cancel();
      throw new Error(failure);
    }
    retryable = false;
    failure = "Viewer initialization could not be decoded";
    const result = await response.json() as { result?: { capabilities?: { tools?: unknown } } };
    failure = "Viewer initialization is missing the tool capability";
    if (!result.result?.capabilities?.tools) throw new Error(failure);
  } catch (error) {
    // A reset can also arrive after HTTP headers, while decoding the body.
    // Invalid JSON stays decisive; a failed stream or deadline is transient.
    if (failure === "Viewer initialization could not be decoded"
      && (error instanceof TypeError || deadline.signal.aborted)) retryable = true;
    // Do not retain a response body or credentials from a failed endpoint.
    throw Object.assign(new Error(`spawn capability verification failed: ${failure}; ${method} check ${check}`), { retryable });
  } finally { deadline.release(); }
}

/** Preserve the SDK's initialize handler and tool schemas. Refuse discovery
 * before it reaches that handler when the launch cannot identify itself. Each
 * discovery rechecks authority, so rotation also invalidates a connected pipe. */
export function guardViewerMcpStartup(transport: StdioServerTransport): void {
  let verified = false;
  const lifetime = new AbortController();
  const close = transport.close.bind(transport);
  transport.close = async () => { lifetime.abort(); await close(); };
  const check = async (method: "initialize" | "tools/list") => {
    // A running CLI rediscovers after a release change. A transient discovery
    // error can retire its MCP registration permanently. Keep that request
    // pending through the relaunch, below the SDK's 60-second request timeout.
    // Initial admission and authority refusals remain decisive. Calls still
    // reach the Viewer's per-call policy; no authority or result is cached.
    if (!verified) { await checkCapability(method, lifetime.signal); verified = true; return; }
    const recovery = deadlineSignal(55_000, { signal: lifetime.signal });
    try {
      let delay = 200;
      for (;;) {
        try { await checkCapability(method, recovery.signal); return; }
        catch (error) {
          if (recovery.signal.aborted || !(error instanceof Error) || !("retryable" in error) || !error.retryable) throw error;
          try { await pause(delay, undefined, { signal: recovery.signal }); }
          catch { throw error; } // Keep the safe failure class and check correlation on deadline/close.
          delay = Math.min(delay * 2, 1_000);
        }
      }
    } finally { recovery.release(); }
  };
  const start = transport.start.bind(transport);
  transport.start = async () => {
    const receive = transport.onmessage;
    transport.onmessage = message => {
      if (!("method" in message) || !["initialize", "tools/list"].includes(message.method) || !("id" in message)) {
        receive?.(message);
        return;
      }
      void check(message.method as "initialize" | "tools/list").then(() => receive?.(message), error => transport.send({ jsonrpc: "2.0", id: message.id,
        error: { code: -32002, message: `Viewer MCP: ${error instanceof Error ? error.message : "startup failed"}; state directory ${stateDir()}` } }))
        .catch(error => transport.onerror?.(error instanceof Error ? error : new Error("MCP startup reply failed")));
    };
    await start();
  };
}
