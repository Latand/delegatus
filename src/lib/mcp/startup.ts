import type { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import { stateDir } from "@/lib/configDir";
import { deadlineSignal } from "@/lib/deadline";
import { viewerControlOrigin, viewerControlToken } from "./controlEndpoint";

/** The Viewer authenticates the launch capability, including successor
 * generations. No registry import, tool execution or local identity cache. */
async function checkCapability(): Promise<void> {
  const capability = process.env.LLV_SPAWN_CAPABILITY;
  // Interactive clients without a launch capability retain native attribution.
  if (capability === undefined) return;
  if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) throw new Error("spawn capability is malformed");
  const origin = viewerControlOrigin();
  const endpoint = new URL("/api/mcp", origin);
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) {
    throw new Error("spawn capability requires a loopback Viewer control endpoint");
  }
  const headers = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream",
    origin: endpoint.origin, "sec-fetch-site": "same-origin", [VIEWER_SPAWN_CAPABILITY_HEADER]: capability });
  const token = viewerControlToken(process.env, origin);
  if (token) headers.set("authorization", `Bearer ${token}`);
  const deadline = deadlineSignal(10_000);
  try {
    const response = await fetch(endpoint, { method: "POST", redirect: "error", headers, signal: deadline.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: "viewer-mcp-startup", method: "initialize",
        params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "delegatus-stdio", version: "1" } } }) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`spawn capability could not be resolved by the Viewer (HTTP ${response.status})`);
    }
    const result = await response.json() as { result?: { capabilities?: { tools?: unknown } } };
    if (!result.result?.capabilities?.tools) throw new Error("Viewer initialization is missing the tool capability");
  } catch (error) {
    // Do not retain a response body or credentials from a failed endpoint.
    throw new Error(`spawn capability verification failed: ${error instanceof Error ? error.message : "Viewer control is unavailable"}`);
  } finally { deadline.release(); }
}

/** Preserve the SDK's initialize handler and tool schemas. Refuse discovery
 * before it reaches that handler when the launch cannot identify itself. Each
 * discovery rechecks authority, so rotation also invalidates a connected pipe. */
export function guardViewerMcpStartup(transport: StdioServerTransport): void {
  const start = transport.start.bind(transport);
  transport.start = async () => {
    const receive = transport.onmessage;
    transport.onmessage = message => {
      if (!("method" in message) || !["initialize", "tools/list"].includes(message.method) || !("id" in message)) {
        receive?.(message);
        return;
      }
      void checkCapability().then(() => receive?.(message), error => transport.send({ jsonrpc: "2.0", id: message.id,
        error: { code: -32002, message: `Viewer MCP: ${error instanceof Error ? error.message : "startup failed"}; state directory ${stateDir()}` } }))
        .catch(error => transport.onerror?.(error instanceof Error ? error : new Error("MCP startup reply failed")));
    };
    await start();
  };
}
