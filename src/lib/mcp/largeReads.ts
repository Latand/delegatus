import { randomUUID } from "node:crypto";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import { existingInternalServiceHeaders } from "@/lib/agent/callerClaims";
import { deadlineSignal } from "@/lib/deadline";
import { viewerControlOrigin, viewerControlToken } from "./controlEndpoint";
import type { McpToolArgs, McpToolCallContext, McpToolName, McpToolResult } from "./server";

/** These reads otherwise materialize registry, scanner and resource caches in
 * every agent. The Viewer owns their projections and bounded durable receipts.
 * Activity and lifecycle reads journal observations; digest polls also advance
 * a cursor. Their original keys must reach the shared service. Even HTTP-backed
 * prototype/search bindings load the local domain unless delegation happens
 * before importing those bindings. */
export const VIEWER_LARGE_READS: ReadonlySet<McpToolName> = new Set([
  "agent_fleet", "conversation_messages", "resources", "operator_snapshot", "board_snapshot",
  "list_pipelines", "get_pipeline", "read_prototype_review", "agent_activity", "search_transcripts",
  "lifecycle_events",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** One stateless call, with no response cache or agent-local receipt claim. */
export async function readFromViewer(toolName: McpToolName, args: McpToolArgs, context: McpToolCallContext): Promise<McpToolResult> {
  const origin = viewerControlOrigin();
  const endpoint = new URL("/api/mcp", origin);
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) {
    throw new Error("MCP large reads require the loopback Viewer control endpoint");
  }
  const headers = new Headers({
    "content-type": "application/json", accept: "application/json, text/event-stream",
    "mcp-protocol-version": LATEST_PROTOCOL_VERSION,
    [VIEWER_SPAWN_CAPABILITY_HEADER]: process.env.LLV_SPAWN_CAPABILITY!,
    origin: endpoint.origin, "sec-fetch-site": "same-origin",
    ...existingInternalServiceHeaders("mcp"),
  });
  const token = viewerControlToken(process.env, origin);
  if (token) headers.set("authorization", `Bearer ${token}`);
  const id = randomUUID();
  const work = context.nativeWork;
  const deadline = deadlineSignal(Math.max(1, Math.min(30_000, (context.deadlineAt ?? Date.now() + 30_000) - Date.now())), {
    signal: context.signal, reason: "Viewer MCP read deadline exceeded",
  });
  try {
    const response = await fetch(endpoint, {
      method: "POST", redirect: "error", headers, signal: deadline.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: {
        name: toolName, arguments: args,
        ...(work ? { _meta: {
          threadId: work.threadId, callId: work.callId, itemId: work.itemId,
          "x-codex-turn-metadata": { thread_id: work.threadId, turn_id: work.turnId, turn_trigger: work.turnTrigger },
        } } : {}),
      } }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Viewer MCP read refused with status ${response.status}`);
    }
    const envelope = record(await response.json());
    const result = record(record(envelope?.result)?.structuredContent);
    if (envelope?.id !== id || envelope?.jsonrpc !== "2.0" || !result
      || typeof result.ok !== "boolean" || result.toolName !== toolName) {
      throw new Error("Viewer MCP read returned a malformed response");
    }
    return result as McpToolResult;
  } finally { deadline.release(); }
}
