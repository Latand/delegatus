import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { readRequestBody, requestBodyTooLargeMessage } from "@modelcontextprotocol/sdk/server/requestBody.js";
import crypto from "node:crypto";
import type { NextRequest } from "next/server";

import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { TASK_EXECUTOR_TOOLS, viewerTaskExecutor } from "./taskExecutor";
import { mcpHttpRefusal as refusal } from "./httpResponse";
import { MCP_MAX_REQUEST_BODY_BYTES } from "./inputLimits";
import { logCallerIdentificationError } from "./callerIdentification";

import {
  createProductionViewerMcpService,
  createViewerMcpServer,
  mcpTextResultClient,
  mcpToolResponse,
  MCP_HTTP_CLIENT_ID,
  MCP_TOOL_NAMES,
  taskExecutorFailure,
  type McpToolName,
  type McpToolService,
} from "./server";

/**
 * The Viewer MCP tool surface over Streamable HTTP, served from the Viewer's
 * own process at `/api/mcp`.
 *
 * Every agent used to start its own `bin/mcp-server.mjs` over stdio, one Bun
 * process each. This endpoint serves the same tools, schemas, per-call policy
 * and receipts from one place. It is stateless: each POST builds a server and
 * a transport for that request alone, with no stored sessions. Initialization
 * returns an opaque Mcp-Session-Id that clients echo on calls and cancels; it
 * namespaces cancellation across connections and needs no session lookup after
 * a Viewer restart. Idempotency lives where it always has, in the
 * shared receipt store keyed by clientRequestId.
 *
 * Identity is the caller's spawn capability, presented in the
 * `x-llv-spawn-capability` header (never in Authorization, which the stable
 * listener rewrites when it vouches for loopback). The capability is the same
 * per-launch secret the stdio server reads from its inherited environment: the
 * registry holds only its digest, a relaunch rotates it and clears the old one,
 * and it resolves to exactly one conversation. A migration also keeps a pending
 * successor digest valid beside the predecessor's until commit. A presented
 * capability that is malformed, unknown or rotated away is refused before
 * dispatch. Without one, Linux adapters prove their kernel peer and exact
 * request body; compatibility adapters authenticate as the MCP service and
 * retain unidentified authority. The tool policy still resolves native proof
 * and operator approval before permitting an operation.
 *
 * The capability identifies; it does not admit. Reaching the route at all
 * takes whatever every other Viewer route takes — LLV_TOKEN when one is
 * configured — so exposure is exactly the Viewer's own.
 */

const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CONNECTION_HEADER = "mcp-session-id";
const CONNECTION_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

class McpBodyTooLargeError extends Error {}

// All three ingress paths parse locally for identity, cancellation and task
// routing. The transport's maxRequestBodySize is bypassed by parsedBody, so
// use its bounded reader before any local JSON.parse or native peer proof.
async function boundedBodyText(request: Request): Promise<string> {
  const body = await readRequestBody(request, MCP_MAX_REQUEST_BODY_BYTES);
  if (body.tooLarge) throw new McpBodyTooLargeError();
  return body.text;
}

function bodyTooLarge(): Response {
  return refusal(413, -32000, requestBodyTooLargeMessage(MCP_MAX_REQUEST_BODY_BYTES));
}

export interface McpHttpDependencies {
  service: () => Promise<McpToolService>;
  /** The conversation a capability belongs to, or null when none does. */
  conversationForCapability: (capability: string) => string | null;
}

const SERVICE_KEY = Symbol.for("llv.mcp.httpService");

/** One tool service per Viewer process, shared by every request. Held on
    `globalThis` so every bundle that serves the route shares it. */
function productionService(): Promise<McpToolService> {
  const holder = globalThis as typeof globalThis & { [SERVICE_KEY]?: Promise<McpToolService> };
  const existing = holder[SERVICE_KEY];
  if (existing) return existing;
  const created = createProductionViewerMcpService(false);
  holder[SERVICE_KEY] = created;
  /* A service that failed to build is not cached: the next request tries again. */
  created.catch(() => {
    if (holder[SERVICE_KEY] === created) delete holder[SERVICE_KEY];
  });
  return created;
}

async function productionConversationForCapability(capability: string): Promise<string | null> {
  return viewerTaskExecutor().identifyCapability(capability);
}

const INFLIGHT_KEY = Symbol.for("llv.mcp.httpInflight");

/**
 * The calls in progress over this endpoint, by caller, connection and JSON-RPC id, so a
 * client's `notifications/cancelled` can reach the call it names. Over stdio
 * the cancel and the call share one server; here each POST gets its own, and
 * the cancel always arrives on a later POST than the call. Keyed by the
 * capability too, so an agent can only ever cancel its own calls. Codex's
 * sibling threads share a capability and reuse ids; their cancel notifications
 * omit _meta, but carry the connection header negotiated at initialization.
 */
function inflightCalls(): Map<string, AbortController> {
  const holder = globalThis as typeof globalThis & { [INFLIGHT_KEY]?: Map<string, AbortController> };
  holder[INFLIGHT_KEY] ??= new Map();
  return holder[INFLIGHT_KEY];
}

function inflightKey(capability: string, connectionId: string, requestId: unknown): string {
  return JSON.stringify([capability, connectionId, requestId]);
}

function jsonRpcMessages(body: unknown): Record<string, unknown>[] {
  const messages = Array.isArray(body) ? body : [body];
  return messages.filter((message): message is Record<string, unknown> => Boolean(message) && typeof message === "object");
}

let testDependencies: McpHttpDependencies | null = null;

/** Test seam: a Next route takes no dependency argument. */
export function setMcpHttpDependenciesForTests(dependencies: McpHttpDependencies | null): void {
  testDependencies = dependencies;
}

/** GET (a standalone server-to-client stream) and DELETE (ending a session)
    have nothing to act on in a stateless server; the transport spec answers
    both with 405. */
export function mcpHttpMethodNotAllowed(): Response {
  return refusal(405, -32000, "Method not allowed: this endpoint is stateless and accepts POST only.", { allow: "POST" });
}

export async function handleMcpHttpRequest(request: NextRequest): Promise<Response> {
  /* Access is the Viewer's, unchanged: the proxy applies LLV_TOKEN here as on
     every other path (the stable local entry supplies it for loopback callers
     when trusted), and this gate refuses a browser's cross-site request. The
     capability below is identity on top of that, never a way past it. */
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) return crossOrigin;

  let body: unknown;
  let nativePeer: import("@/lib/processIdentity").ProcessIdentity | undefined;
  let unidentified = false;
  const nativeHeader = request.headers.get("x-delegatus-mcp-peer");
  let capability = request.headers.get(VIEWER_SPAWN_CAPABILITY_HEADER)?.trim() ?? "";
  if (nativeHeader && !request.headers.has(VIEWER_SPAWN_CAPABILITY_HEADER)) {
    try {
      const raw = await boundedBodyText(request);
      const { verifyNativePeer } = await import("./nativePeer");
      nativePeer = await verifyNativePeer(nativeHeader, raw);
      body = JSON.parse(raw);
      capability = `native:${nativePeer.pid}:${nativePeer.startIdentity}:${nativePeer.bootEpoch}`;
    } catch (error) {
      if (error instanceof McpBodyTooLargeError) return bodyTooLarge();
      return refusal(403, -32001, "The native MCP peer could not be authenticated.");
    }
  }
  if (!nativeHeader && !request.headers.has(VIEWER_SPAWN_CAPABILITY_HEADER) && request.headers.get("x-delegatus-mcp-unattributed") === "1") {
    const { internalServiceClaim } = await import("@/lib/agent/callerClaims");
    const claim = internalServiceClaim(request, { readOnly: true });
    unidentified = claim.claim === "valid" && claim.service === "mcp";
    if (unidentified) capability = "unidentified-local-mcp";
  }
  if (!nativePeer && !unidentified && !CAPABILITY_PATTERN.test(capability)) {
    return refusal(403, -32001, `The Viewer MCP endpoint requires the ${VIEWER_SPAWN_CAPABILITY_HEADER} header carrying this agent's launch capability.`);
  }
  // Small framed bodies can combine authentication and task dispatch in one
  // executor request. Larger or unframed bodies keep authentication first.
  const length = request.headers.get("content-length");
  let bodyRead = !!nativePeer;
  let parseFailed = false;
  if (!bodyRead && !testDependencies && length !== null && /^\d{1,5}$/.test(length) && Number(length) <= 16_384) {
    bodyRead = true;
    try { body = JSON.parse(await boundedBodyText(request)); }
    catch (error) {
      if (error instanceof McpBodyTooLargeError) return bodyTooLarge();
      parseFailed = true;
    }
  }
  const earlyMessages = bodyRead && !parseFailed ? jsonRpcMessages(body) : [];
  const earlyTool = earlyMessages.length === 1 && earlyMessages[0]?.method === "tools/call"
    ? (earlyMessages[0].params as { name?: unknown } | undefined)?.name : undefined;
  const executorAuthenticates = !testDependencies && typeof earlyTool === "string" && TASK_EXECUTOR_TOOLS.has(earlyTool);
  let conversationId: string | null;
  try {
    // Native identity and approval are resolved by the full tool policy using
    // this authenticated peer's ancestry. A PID alone grants no tool access.
    conversationId = executorAuthenticates ? null : nativePeer || unidentified ? "local-peer" : testDependencies
      ? testDependencies.conversationForCapability(capability)
      : await productionConversationForCapability(capability);
  } catch (error) {
    logCallerIdentificationError(error, capability);
    return refusal(503, -32002, "The Viewer could not read its agent registry to identify this caller; retry the call.", { "retry-after": "1" });
  }
  if (!executorAuthenticates && !conversationId) {
    return refusal(403, -32001, "This launch capability names no current agent: it is unknown or was rotated by a later launch.");
  }

  let service: McpToolService;
  try {
    service = await (testDependencies ? testDependencies.service() : productionService());
  } catch {
    return refusal(503, -32002, "The Viewer MCP tool service is not available yet; retry the call.");
  }

  try {
    if (parseFailed) throw new Error("invalid JSON");
    if (!bodyRead) body = JSON.parse(await boundedBodyText(request));
  } catch (error) {
    if (error instanceof McpBodyTooLargeError) return bodyTooLarge();
    return refusal(400, -32700, "Parse error: the request body is not JSON.");
  }
  const messages = jsonRpcMessages(body);
  const connectionId = request.headers.get(CONNECTION_HEADER) ?? "";
  if (connectionId && !CONNECTION_PATTERN.test(connectionId)) {
    return refusal(400, -32600, "The MCP connection identifier is malformed.");
  }
  // Both shipped native HTTP clients send their MCP client name here. This
  // selects presentation only, including for connections opened before deploy.
  const textOnly = mcpTextResultClient(request.headers.get("user-agent")?.split("/", 1)[0]);
  const inflight = inflightCalls();
  /* Reserve each id only once. This also protects clients that connected
     before connection headers were negotiated and still share the legacy
     namespace. Never overwrite the controller of work already admitted. */
  const registered = new Map<string, AbortController>();
  for (const message of messages) {
    /* Initialization cannot be cancelled and has not negotiated a connection
       yet. Sibling clients may initialize concurrently with the same id. */
    if (typeof message.method !== "string" || message.method === "initialize" || message.id === undefined || message.id === null) continue;
    const key = inflightKey(capability, connectionId, message.id);
    if (inflight.has(key) || registered.has(key)) {
      return refusal(409, -32600, "A request with this id is already in progress on this connection; use a distinct id.");
    }
    registered.set(key, new AbortController());
  }
  for (const [key, controller] of registered) inflight.set(key, controller);
  for (const message of messages) {
    if (message.method !== "notifications/cancelled") continue;
    const requestId = (message.params as { requestId?: unknown } | undefined)?.requestId;
    if (requestId !== undefined) inflight.get(inflightKey(capability, connectionId, requestId))?.abort(new Error("cancelled by the client"));
  }
  /* Each call in this POST can be ended by the client's later cancel, and all
     of them by the client walking away from this request. */
  const abandon = () => { for (const controller of registered.values()) controller.abort(new Error("the client closed the request")); };
  request.signal.addEventListener("abort", abandon, { once: true });
  if (request.signal.aborted) abandon();

  // A stateless single-tool POST cannot observe registrations for other tools.
  // Discovery, batches, unknown names and other protocol methods keep the full
  // catalog and the SDK's existing error behavior.
  const requested = messages.length === 1 && messages[0]?.method === "tools/call"
    ? (messages[0].params as { name?: unknown } | undefined)?.name : undefined;
  const tools = typeof requested === "string" && (MCP_TOOL_NAMES as readonly string[]).includes(requested)
    ? [requested as McpToolName] : undefined;
  let server: ReturnType<typeof createViewerMcpServer> | undefined;
  try {
    if (!testDependencies && typeof requested === "string" && TASK_EXECUTOR_TOOLS.has(requested)) {
      try {
        // Keep ingress parsing and executor admission on separate loop turns.
        await new Promise<void>(resolve => setImmediate(resolve));
        return await viewerTaskExecutor().callHttpTool(requested, body, request,
          nativePeer ? { nativePeer } : unidentified ? { paginationIdentity: connectionId || crypto.randomUUID() } : { capability }, {
            signal: registered.get(inflightKey(capability, connectionId, messages[0]?.id))?.signal ?? request.signal,
          });
      } catch (error) {
        const args = (messages[0]?.params as { arguments?: unknown } | undefined)?.arguments;
        const result = taskExecutorFailure(requested, args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {}, error);
        return Response.json({ jsonrpc: "2.0", id: messages[0]?.id, result: mcpToolResponse(result, textOnly) });
      }
    }
    server = createViewerMcpServer(service, tools, textOnly);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true,
      maxRequestBodySize: MCP_MAX_REQUEST_BODY_BYTES });
    await server.connect(transport);
    const response = await transport.handleRequest(request, {
      parsedBody: body,
      authInfo: {
        token: capability,
        clientId: MCP_HTTP_CLIENT_ID,
        scopes: [],
        extra: { nativePeer, unidentified, paginationIdentity: unidentified ? connectionId || crypto.randomUUID() : undefined,
          cancelSignal: (requestId: unknown) => registered.get(inflightKey(capability, connectionId, requestId))?.signal ?? null },
      },
    });
    if (response.ok && messages.length === 1 && messages[0]?.method === "initialize") {
      response.headers.set(CONNECTION_HEADER, crypto.randomUUID());
    }
    return response;
  } finally {
    request.signal.removeEventListener("abort", abandon);
    for (const [key, controller] of registered) {
      if (inflight.get(key) === controller) inflight.delete(key);
    }
    /* JSON-response mode answers only once every response is ready, so the
       request is complete here and nothing is left to stream. */
    await server?.close().catch(() => undefined);
  }
}
