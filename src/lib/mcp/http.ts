import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { NextRequest } from "next/server";

import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

import {
  createProductionViewerMcpService,
  createViewerMcpServer,
  MCP_HTTP_CLIENT_ID,
  type McpToolService,
} from "./server";

/**
 * The Viewer MCP tool surface over Streamable HTTP, served from the Viewer's
 * own process at `/api/mcp`.
 *
 * Every agent used to start its own `bin/mcp-server.mjs` over stdio, one Bun
 * process each. This endpoint serves the same tools, schemas, per-call policy
 * and receipts from one place. It is stateless: each POST builds a server and
 * a transport for that request alone, so nothing is held between calls and a
 * Viewer restart strands no session — the next call after the restart is
 * simply the next request. Idempotency lives where it always has, in the
 * shared receipt store keyed by clientRequestId.
 *
 * Identity is the caller's spawn capability, presented in the
 * `x-llv-spawn-capability` header (never in Authorization, which the stable
 * listener rewrites when it vouches for loopback). The capability is the same
 * per-launch secret the stdio server reads from its inherited environment: the
 * registry holds only its digest, a relaunch rotates it and clears the old one,
 * and it resolves to exactly one conversation. A request whose capability is
 * missing, malformed, unknown or rotated away is refused before any MCP
 * message is read.
 *
 * The capability identifies; it does not admit. Reaching the route at all
 * takes whatever every other Viewer route takes — LLV_TOKEN when one is
 * configured — so exposure is exactly the Viewer's own.
 */

const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

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
  const { capabilityConversationResolver } = await import("./bindings");
  const { agentRegistry } = await import("@/lib/agent/registry");
  return capabilityConversationResolver(
    capability,
    (digest) => agentRegistry().conversationIdForSpawnCapabilityDigest(digest),
  )();
}

const INFLIGHT_KEY = Symbol.for("llv.mcp.httpInflight");

/**
 * The calls in progress over this endpoint, by caller and JSON-RPC id, so a
 * client's `notifications/cancelled` can reach the call it names. Over stdio
 * the cancel and the call share one server; here each POST gets its own, and
 * the cancel always arrives on a later POST than the call. Keyed by the
 * capability too, so an agent can only ever cancel its own calls.
 */
function inflightCalls(): Map<string, AbortController> {
  const holder = globalThis as typeof globalThis & { [INFLIGHT_KEY]?: Map<string, AbortController> };
  holder[INFLIGHT_KEY] ??= new Map();
  return holder[INFLIGHT_KEY];
}

function inflightKey(capability: string, requestId: unknown): string {
  return `${capability}\u0000${JSON.stringify(requestId)}`;
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

/** A JSON-RPC error with no request id, which is what a refusal before any
    message was read can honestly carry. */
function refusal(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
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

  const capability = request.headers.get(VIEWER_SPAWN_CAPABILITY_HEADER)?.trim() ?? "";
  if (!CAPABILITY_PATTERN.test(capability)) {
    return refusal(403, -32001, `The Viewer MCP endpoint requires the ${VIEWER_SPAWN_CAPABILITY_HEADER} header carrying this agent's launch capability.`);
  }
  let conversationId: string | null;
  try {
    conversationId = testDependencies
      ? testDependencies.conversationForCapability(capability)
      : await productionConversationForCapability(capability);
  } catch {
    return refusal(503, -32002, "The Viewer could not read its agent registry to identify this caller; retry the call.");
  }
  if (!conversationId) {
    return refusal(403, -32001, "This launch capability names no current agent: it is unknown or was rotated by a later launch.");
  }

  let service: McpToolService;
  try {
    service = await (testDependencies ? testDependencies.service() : productionService());
  } catch {
    return refusal(503, -32002, "The Viewer MCP tool service is not available yet; retry the call.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return refusal(400, -32700, "Parse error: the request body is not JSON.");
  }
  const messages = jsonRpcMessages(body);
  const inflight = inflightCalls();
  for (const message of messages) {
    if (message.method !== "notifications/cancelled") continue;
    const requestId = (message.params as { requestId?: unknown } | undefined)?.requestId;
    if (requestId !== undefined) inflight.get(inflightKey(capability, requestId))?.abort(new Error("cancelled by the client"));
  }
  /* Each call in this POST can be ended by the client's later cancel, and all
     of them by the client walking away from this request. */
  const registered = new Map<string, AbortController>();
  for (const message of messages) {
    if (typeof message.method !== "string" || message.id === undefined || message.id === null) continue;
    const controller = new AbortController();
    const key = inflightKey(capability, message.id);
    registered.set(key, controller);
    inflight.set(key, controller);
  }
  const abandon = () => { for (const controller of registered.values()) controller.abort(new Error("the client closed the request")); };
  request.signal.addEventListener("abort", abandon, { once: true });

  const server = createViewerMcpServer(service);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request, {
      parsedBody: body,
      authInfo: {
        token: capability,
        clientId: MCP_HTTP_CLIENT_ID,
        scopes: [],
        extra: { cancelSignal: (requestId: unknown) => inflight.get(inflightKey(capability, requestId))?.signal ?? null },
      },
    });
  } finally {
    request.signal.removeEventListener("abort", abandon);
    for (const [key, controller] of registered) {
      if (inflight.get(key) === controller) inflight.delete(key);
    }
    /* JSON-response mode answers only once every response is ready, so the
       request is complete here and nothing is left to stream. */
    await server.close().catch(() => undefined);
  }
}
