import { randomUUID } from "node:crypto";
import { controlFetch } from "./controlTransport";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import { existingInternalServiceHeaders } from "@/lib/agent/callerClaims";
import { deadlineSignal } from "@/lib/deadline";
import { isInboundImage, MAX_INPUT_MEDIA_REFS, MAX_IMAGE_PREVIEW_BYTES } from "@/lib/externalRelay/mediaInputValidation";
import { withRelayImages, MAX_RELAY_IMAGE_CONTENT_BYTES, RELAY_IMAGE_LIMIT_NOTE, type RelayImageContent } from "@/lib/externalRelay/ownerToolContent";
import { viewerControlOrigin, viewerControlToken } from "./controlEndpoint";
import { callTaskChannel, decodeTaskChannel, TASK_CHANNEL_HEADER, TASK_CHANNEL_REQUEST_HEADER, TASK_CHANNEL_TOOLS, type TaskChannel } from "./taskChannel";
import type { McpToolArgs, McpToolCallContext, McpToolName, McpToolResult } from "./server";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const CHANNEL_KEY = Symbol.for("llv.mcp.adapterTaskChannel");
type ChannelCache = { key: string; channel: TaskChannel };
const channels = globalThis as typeof globalThis & { [CHANNEL_KEY]?: ChannelCache };

/** Bound the HTTP envelope before parsing private image data. The extra KiB
 * covers JSON-RPC framing outside the serializer's content budget. */
async function relayEnvelope(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("malformed relay media response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RELAY_IMAGE_CONTENT_BYTES + 1024) {
        await reader.cancel(); throw new Error("relay media response exceeds answer_size_limit");
      }
      chunks.push(next.value);
    }
    return record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch { throw new Error("malformed or oversized relay media response"); }
  finally { reader.releaseLock(); }
}

function relayResult(payload: Record<string, unknown> | null) {
  const content = Array.isArray(payload?.content) ? payload.content : [];
  if (Buffer.byteLength(JSON.stringify({ content })) > MAX_RELAY_IMAGE_CONTENT_BYTES) throw new Error("oversized relay image content");
  const first = record(content[0]);
  let metadata = record(payload?.structuredContent);
  if (!metadata && first?.type === "text" && typeof first.text === "string") {
    try { metadata = record(JSON.parse(first.text)); } catch { /* fixed refusal below */ }
  }
  const images: RelayImageContent[] = [];
  let note: string | undefined;
  // Only transport shape is checked here; the common collector has already
  // downloaded, decoded and validated every image. Never download it again.
  for (const block of content.slice(1)) {
    const item = record(block);
    if (item?.type === "text" && item.text === RELAY_IMAGE_LIMIT_NOTE && !note) { note = item.text; continue; }
    if (item?.type !== "image" || typeof item.mimeType !== "string" || !isInboundImage(item.mimeType)
      || typeof item.data !== "string" || item.data.length > 4 * Math.ceil(MAX_IMAGE_PREVIEW_BYTES / 3)
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data)
      || !item.data.length || images.length >= MAX_INPUT_MEDIA_REFS) throw new Error("malformed relay image content");
    const bytes = Buffer.from(item.data, "base64");
    if (bytes.length > MAX_IMAGE_PREVIEW_BYTES || bytes.toString("base64") !== item.data) throw new Error("malformed relay image content");
    images.push({ type: "image", mimeType: item.mimeType, data: item.data });
  }
  return metadata ? withRelayImages(metadata, images, undefined, note) : null;
}

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
      response = await controlFetch(endpoint, {
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
    const media = toolName === "relay_service_tools";
    const envelope = media ? await relayEnvelope(response) : record(await response.json());
    const rpcError = record(envelope?.error);
    if (envelope?.id === id && envelope?.jsonrpc === "2.0" && envelope.result === undefined
      && typeof rpcError?.code === "number" && Number.isInteger(rpcError.code)
      && typeof rpcError.message === "string") {
      throw new Error(media ? "Viewer MCP relay request refused" : `Viewer MCP JSON-RPC error ${rpcError.code}: ${rpcError.message}`);
    }
    const payload = record(envelope?.result);
    const result = media ? relayResult(payload) : record(payload?.structuredContent);
    if (envelope?.id !== id || envelope?.jsonrpc !== "2.0" || !result
      || typeof result.ok !== "boolean" || result.toolName !== toolName) {
      throw new Error("Viewer MCP request returned a malformed response");
    }
    return result as McpToolResult;
  } catch (error) {
    if (toolName === "relay_service_tools") throw new Error("Viewer MCP relay request failed; response unavailable");
    throw new Error(`Viewer MCP request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally { native?.close(); deadline.release(); }
}
