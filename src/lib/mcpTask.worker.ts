// This entry receives an explicit state directory from its Viewer. It never
// imports or migrates the operator's state on its own authority.
import { createInterface } from "node:readline";
import { once } from "node:events";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import type { TaskExecutorRequest } from "./mcp/taskExecutor";
import type { TaskChannelResponse } from "./mcp/taskChannel";
import type { TaskChannelAdmission } from "./mcp/taskChannelServer";

if (!process.env.LLV_STATE_DIR) throw new Error("task executor needs an explicit state directory");
// App Router modules capture this global when they load. A standalone executor
// has no Next server bootstrap to install it before the compiled binding graph.
(globalThis as typeof globalThis & { AsyncLocalStorage?: typeof AsyncLocalStorage }).AsyncLocalStorage ??= AsyncLocalStorage;
const { runAsMcpHttpCaller } = await import("./mcp/callerContext");
const { TASK_EXECUTOR_FRAME_BYTES, TASK_EXECUTOR_HTTP_FRAME_BYTES, TASK_EXECUTOR_TOOLS } = await import("./mcp/taskExecutor");
const { createProductionViewerMcpService, createViewerMcpServer, mcpTextResultClient, MCP_HTTP_CLIENT_ID } = await import("./mcp/server");
const { WebStandardStreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");
const { agentRegistry } = await import("./agent/registry");
const { capabilityConversationResolver } = await import("./mcp/bindings");
const { mcpHttpRefusal } = await import("./mcp/httpResponse");
const { startTaskChannel } = await import("./mcp/taskChannelServer");
const { TASK_CHANNEL_CALLS, TASK_CHANNEL_INPUT_BYTES, encodeTaskChannel } = await import("./mcp/taskChannel");
const service = await createProductionViewerMcpService(false, false, true);
const calls = new Map<number, AbortController>();
let pendingBytes = 0, outputs = 0, nextPrivateId = 0;
let retiring = false;
let idle: ReturnType<typeof setTimeout> | undefined;
const configuredIdle = Number(process.env.LLV_MCP_TASK_IDLE_MS);
const idleMs = Number.isFinite(configuredIdle) && configuredIdle >= 1 ? Math.min(60_000, configuredIdle) : 60_000;
let privateChannel: Awaited<ReturnType<typeof startTaskChannel>> = null;
const awake = () => { clearTimeout(idle); idle = undefined; };
const maybeIdle = () => {
  if (retiring || calls.size || outputs || idle) return;
  idle = setTimeout(() => {
    retiring = true; privateChannel?.close();
    write(() => '{"id":0,"control":{"retiring":true}}\n', 4096, false);
    // The parent closes its guardian before admitting a successor. Remain
    // present until that signal arrives, with a bounded fallback on lost IPC.
    void writing.finally(() => { setTimeout(() => process.exit(0), 1_000); });
  }, idleMs);
};
function admit(id: number, bytes: number, deadlineAt: number): TaskChannelAdmission | null {
  if (retiring || calls.has(id) || calls.size >= TASK_CHANNEL_CALLS || pendingBytes + bytes > TASK_CHANNEL_INPUT_BYTES
    || !Number.isFinite(deadlineAt) || deadlineAt <= Date.now()) return null;
  awake();
  const controller = new AbortController(); calls.set(id, controller); pendingBytes += bytes;
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(30_000, deadlineAt - Date.now())));
  let closed = false;
  return { signal: controller.signal, cancel: () => controller.abort(), close: () => {
    if (closed) return;
    closed = true; clearTimeout(timer); calls.delete(id); pendingBytes -= bytes; maybeIdle();
  } };
}
let writing = Promise.resolve();
const write = (frame: () => string, limit: number, activity = true) => {
  if (activity) { outputs++; awake(); }
  writing = writing.then(async () => {
    const value = frame();
    if (Buffer.byteLength(value) > limit) throw new Error("task executor reply exceeds frame bound");
    if (!process.stdout.write(value)) await once(process.stdout, "drain");
  }).finally(() => { if (activity) { outputs--; maybeIdle(); } });
  void writing.catch(() => process.exit(1));
};
const send = (message: unknown) => write(() => JSON.stringify(message) + "\n", TASK_EXECUTOR_FRAME_BYTES);

const identifyCapability = (capability: string | undefined) => capabilityConversationResolver(capability,
  digest => agentRegistry().conversationIdForSpawnCapabilityDigest(digest))();

function acceptsPrivateCalls(): boolean {
  const port = process.env.LLV_MCP_TASK_VIEWER_PORT;
  if (!port) return true;
  try {
    const target = JSON.parse(fs.readFileSync(path.join(process.env.LLV_STATE_DIR!, "viewer-release.json"), "utf8")) as { endpoint?: unknown };
    return typeof target.endpoint === "string" && new URL(target.endpoint).port === port;
  } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}

function sendHttpReply(id: number, response: TaskChannelResponse): void {
  write(() => JSON.stringify({ id, http: { status: response.status, headers: response.headers } }) + "\t" + response.body + "\n", TASK_EXECUTOR_HTTP_FRAME_BYTES);
}

async function serialized(response: Response): Promise<TaskChannelResponse> {
  const body = await response.text();
  if (Buffer.byteLength(body) > TASK_EXECUTOR_HTTP_FRAME_BYTES || body.includes("\n") || body.includes("\t")) throw new Error("invalid task HTTP response frame");
  return { status: response.status, headers: [...response.headers], body };
}

async function httpTaskCall(request: TaskExecutorRequest, signal: AbortSignal): Promise<TaskChannelResponse> {
  const { toolName, body, url, headers } = request.args as { toolName: string; body: unknown; url: string; headers: [string, string][] };
  if (!TASK_EXECUTOR_TOOLS.has(toolName)) throw new Error("unsupported task HTTP tool");
  if (request.caller.capability !== undefined) {
    let conversationId: string | null;
    try { conversationId = identifyCapability(request.caller.capability); }
    catch { return serialized(mcpHttpRefusal(503, -32002, "The Viewer could not read its agent registry to identify this caller; retry the call.")); }
    if (!conversationId) return serialized(mcpHttpRefusal(403, -32001, "This launch capability names no current agent: it is unknown or was rotated by a later launch."));
  }
  const server = createViewerMcpServer(service, [toolName as import("./mcp/server").McpToolName],
    mcpTextResultClient(new Headers(headers).get("user-agent")?.split("/", 1)[0]));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(new Request(url, { method: "POST", headers, signal }), {
      parsedBody: body,
      authInfo: { token: request.caller.capability ?? "local-peer", clientId: MCP_HTTP_CLIENT_ID, scopes: [],
        extra: { nativePeer: request.caller.nativePeer, unidentified: !request.caller.capability && !request.caller.nativePeer,
          paginationIdentity: request.caller.paginationIdentity, cancelSignal: () => signal } },
    });
    return await serialized(response);
  } finally { await server.close().catch(() => undefined); }
}

// The Viewer retires this generation before acknowledging an access-key
// change. New grants then pass through the new HTTP perimeter.
privateChannel = await startTaskChannel({
  identify: capability => acceptsPrivateCalls() ? identifyCapability(capability) : null,
  admit: (bytes, deadlineAt) => admit(--nextPrivateId, bytes, deadlineAt),
  unavailable: () => {
    privateChannel = null;
    write(() => '{"id":0,"control":{"ready":null}}\n', 4096, false);
  },
  dispatch: async (body, capability, headers, signal) => {
    const message = body as { method?: unknown; params?: { name?: unknown } } | null;
    const toolName = message?.method === "tools/call" ? message.params?.name : undefined;
    if (typeof toolName !== "string" || !TASK_EXECUTOR_TOOLS.has(toolName)) return serialized(mcpHttpRefusal(403, -32001, "The task channel accepts task calls only."));
    return httpTaskCall({ id: 0, name: "httpTaskCall", args: { toolName, body, url: "http://127.0.0.1/api/mcp", headers },
      caller: { capability }, deadlineAt: Date.now() + 30_000 }, signal);
  },
});
write(() => JSON.stringify({ id: 0, control: { ready: privateChannel ? encodeTaskChannel(privateChannel.channel) : null } }) + "\n", 4096, false);
// Independent parent watchdog bounds a worker whose loop stops servicing its
// own deadlines. Heartbeats never extend the worker's idle lifetime.
setInterval(() => write(() => '{"id":0,"control":{"heartbeat":true}}\n', 4096, false), 10_000).unref();
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line: string) => {
  if (Buffer.byteLength(line) > TASK_EXECUTOR_FRAME_BYTES) process.exit(1);
  const request = JSON.parse(line) as TaskExecutorRequest & { cancel?: number };
  if (request.cancel !== undefined) { calls.get(request.cancel)?.abort(); return; }
  const admission = admit(request.id, Buffer.byteLength(line) + 1, request.deadlineAt);
  if (!admission) { send({ id: request.id, error: "task executor admission is full or its request expired; retry the original key" }); return; }
  if (request.name === "identifyCapability") {
    try {
      const conversationId = identifyCapability(request.caller.capability);
      send({ id: request.id, result: { conversationId } });
    } catch { send({ id: request.id, error: "task executor could not identify the caller" }); }
    admission.close(); return;
  }
  if ((!TASK_EXECUTOR_TOOLS.has(request.name) && request.name !== "httpTaskCall") || !request.caller) process.exit(1);
  const operation = request.name === "httpTaskCall" ? httpTaskCall(request, admission.signal).then(response => sendHttpReply(request.id, response)) : runAsMcpHttpCaller(request.caller, () => service.callTool(request.name, request.args, {
    signal: admission.signal, deadlineAt: request.deadlineAt, nativeWork: request.nativeWork,
  })).then(result => send({ id: request.id, result }));
  void operation.catch(() => send({ id: request.id, error: "task executor call failed; look up the original request key" }))
    .finally(() => admission.close());
});
input.once("close", () => process.exit(0));
maybeIdle();
