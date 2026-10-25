import { randomUUID } from "node:crypto";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import { existingInternalServiceHeaders } from "@/lib/agent/callerClaims";
import { deadlineSignal } from "@/lib/deadline";
import { viewerControlOrigin, viewerControlToken } from "./controlEndpoint";
import { callTaskChannel, decodeTaskChannel, TASK_CHANNEL_HEADER, TASK_CHANNEL_REQUEST_HEADER, TASK_CHANNEL_TOOLS, type TaskChannel } from "./taskChannel";
import type { McpToolArgs, McpToolCallContext, McpToolName, McpToolResult } from "./server";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const CHANNEL_KEY = Symbol.for("llv.mcp.adapterTaskChannel");
type ChannelCache = { key: string; channel: TaskChannel };
const channels = globalThis as typeof globalThis & { [CHANNEL_KEY]?: ChannelCache };

/** One stateless call, with no response cache or agent-local receipt claim. */
export async function callViewerMcp(toolName: McpToolName, args: McpToolArgs, context: McpToolCallContext): Promise<McpToolResult> {
  const origin = viewerControlOrigin();
  const endpoint = new URL("/api/mcp", origin);
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) {
    throw new Error("MCP calls require the loopback Viewer control endpoint");
  }
  const headers = new Headers({
    "content-type": "application/json", accept: "application/json, text/event-stream",
    "mcp-protocol-version": LATEST_PROTOCOL_VERSION,
    ...(process.env.LLV_SPAWN_CAPABILITY !== undefined ? { [VIEWER_SPAWN_CAPABILITY_HEADER]: process.env.LLV_SPAWN_CAPABILITY } : {}),
    origin: endpoint.origin, "sec-fetch-site": "same-origin",
    ...existingInternalServiceHeaders("mcp"),
  });
  const token = viewerControlToken(process.env, origin);
  if (token) headers.set("authorization", `Bearer ${token}`);
  const id = randomUUID();
  const work = context.nativeWork;
  const deadlineAt = Math.min(context.deadlineAt ?? Date.now() + 30_000, Date.now() + 30_000);
  const deadline = deadlineSignal(Math.max(1, deadlineAt - Date.now()), {
    signal: context.signal, reason: "Viewer MCP request deadline exceeded",
  });
  const body = JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: {
    name: toolName, arguments: args,
    _meta: {
      "delegatus/deadlineAt": context.deadlineAt ?? Date.now() + 30_000,
      ...(work ? {
        threadId: work.threadId, callId: work.callId, itemId: work.itemId,
        "x-codex-turn-metadata": { thread_id: work.threadId, turn_id: work.turnId, turn_trigger: work.turnTrigger },
      } : {}),
    },
  } });
  let native: Awaited<ReturnType<typeof import("./nativePeer").nativePeerProof>> | null = null;
  try {
    const capability = headers.get(VIEWER_SPAWN_CAPABILITY_HEADER)?.trim() ?? "";
    const taskChannel = process.platform === "linux" && /^[A-Za-z0-9_-]{43}$/.test(capability) && TASK_CHANNEL_TOOLS.has(toolName);
    const channelKey = JSON.stringify([endpoint.href, capability, token]);
    if (taskChannel) headers.set(TASK_CHANNEL_REQUEST_HEADER, "1");
    if (process.env.LLV_SPAWN_CAPABILITY === undefined) {
      if (process.platform === "linux") {
        native = await (await import("./nativePeer")).nativePeerProof(body);
        headers.set("x-delegatus-mcp-peer", native.header);
      } else {
        // Native process evidence is supported on Linux. The other platforms
        // preserve their unidentified caller through the authenticated MCP
        // service marker, with no conversation claim or local database.
        headers.set("x-delegatus-mcp-unattributed", "1");
      }
    }
    let response: Response | undefined;
    if (taskChannel && channels[CHANNEL_KEY]?.key === channelKey) {
      try {
        response = await callTaskChannel(channels[CHANNEL_KEY]!.channel, body, capability, headers, deadlineAt, deadline.signal);
        if (!response.ok) { await response.body?.cancel(); response = undefined; }
      } catch (error) { if (deadline.signal.aborted) throw error; }
      if (!response) delete channels[CHANNEL_KEY];
    }
    if (!response) {
      // A stale channel retries only through the Viewer, under the same body,
      // logical request key and remaining deadline. It never executes locally.
      response = await fetch(endpoint, {
        method: "POST", redirect: "error", headers, signal: deadline.signal, body,
      });
      if (taskChannel && response.ok) {
        const channel = decodeTaskChannel(response.headers.get(TASK_CHANNEL_HEADER));
        if (channel) channels[CHANNEL_KEY] = { key: channelKey, channel };
      }
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Viewer MCP request refused with status ${response.status}`);
    }
    const envelope = record(await response.json());
    const rpcError = record(envelope?.error);
    if (envelope?.id === id && envelope?.jsonrpc === "2.0" && envelope.result === undefined
      && typeof rpcError?.code === "number" && Number.isInteger(rpcError.code)
      && typeof rpcError.message === "string") {
      throw new Error(`Viewer MCP JSON-RPC error ${rpcError.code}: ${rpcError.message}`);
    }
    const result = record(record(envelope?.result)?.structuredContent);
    if (envelope?.id !== id || envelope?.jsonrpc !== "2.0" || !result
      || typeof result.ok !== "boolean" || result.toolName !== toolName) {
      throw new Error("Viewer MCP request returned a malformed response");
    }
    return result as McpToolResult;
  } catch (error) {
    throw new Error(`Viewer MCP request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally { native?.close(); deadline.release(); }
}
