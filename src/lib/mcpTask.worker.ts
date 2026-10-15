// This entry receives an explicit state directory from its Viewer. It never
// imports or migrates the operator's state on its own authority.
import { createInterface } from "node:readline";
import { once } from "node:events";
import { AsyncLocalStorage } from "node:async_hooks";
import type { TaskExecutorRequest } from "./mcp/taskExecutor";

if (!process.env.LLV_STATE_DIR) throw new Error("task executor needs an explicit state directory");
// App Router modules capture this global when they load. A standalone executor
// has no Next server bootstrap to install it before the compiled binding graph.
(globalThis as typeof globalThis & { AsyncLocalStorage?: typeof AsyncLocalStorage }).AsyncLocalStorage ??= AsyncLocalStorage;
const { runAsMcpHttpCaller } = await import("./mcp/callerContext");
const { TASK_EXECUTOR_FRAME_BYTES, TASK_EXECUTOR_HTTP_FRAME_BYTES, TASK_EXECUTOR_TOOLS } = await import("./mcp/taskExecutor");
const { createProductionViewerMcpService, createViewerMcpServer, MCP_HTTP_CLIENT_ID } = await import("./mcp/server");
const { WebStandardStreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");
const { agentRegistry } = await import("./agent/registry");
const { capabilityConversationResolver } = await import("./mcp/bindings");
const service = await createProductionViewerMcpService(false, false, true);
const calls = new Map<number, AbortController>();
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let writing = Promise.resolve();
const write = (frame: () => string, limit: number) => {
  writing = writing.then(async () => {
    const value = frame();
    if (Buffer.byteLength(value) > limit) throw new Error("task executor reply exceeds frame bound");
    if (!process.stdout.write(value)) await once(process.stdout, "drain");
  });
  void writing.catch(() => process.exit(1));
};
const send = (message: unknown) => write(() => JSON.stringify(message) + "\n", TASK_EXECUTOR_FRAME_BYTES);

async function httpTaskCall(request: TaskExecutorRequest, signal: AbortSignal): Promise<void> {
  const { toolName, body, url, headers } = request.args as { toolName: string; body: unknown; url: string; headers: [string, string][] };
  if (!TASK_EXECUTOR_TOOLS.has(toolName)) throw new Error("unsupported task HTTP tool");
  const server = createViewerMcpServer(service, [toolName as import("./mcp/server").McpToolName]);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(new Request(url, { method: "POST", headers, signal }), {
      parsedBody: body,
      authInfo: { token: request.caller.capability ?? "local-peer", clientId: MCP_HTTP_CLIENT_ID, scopes: [],
        extra: { nativePeer: request.caller.nativePeer, unidentified: !request.caller.capability && !request.caller.nativePeer, cancelSignal: () => signal } },
    });
    const responseBody = await response.text();
    // JSON response mode emits one line. Transfer it verbatim so the Viewer
    // parses only this small header and never decodes or re-encodes tool rows.
    if (responseBody.includes("\n") || responseBody.includes("\t")) throw new Error("invalid task HTTP response frame");
    write(() => JSON.stringify({ id: request.id, http: { status: response.status, headers: [...response.headers] } }) + "\t" + responseBody + "\n", TASK_EXECUTOR_HTTP_FRAME_BYTES);
  } finally { await server.close().catch(() => undefined); }
}
input.on("line", (line: string) => {
  if (Buffer.byteLength(line) > TASK_EXECUTOR_FRAME_BYTES) process.exit(1);
  const request = JSON.parse(line) as TaskExecutorRequest & { cancel?: number };
  if (request.cancel !== undefined) { calls.get(request.cancel)?.abort(); return; }
  if (request.name === "identifyCapability") {
    try {
      const conversationId = capabilityConversationResolver(request.caller.capability,
        digest => agentRegistry().conversationIdForSpawnCapabilityDigest(digest))();
      send({ id: request.id, result: { conversationId } });
    } catch { send({ id: request.id, error: "task executor could not identify the caller" }); }
    return;
  }
  if ((!TASK_EXECUTOR_TOOLS.has(request.name) && request.name !== "httpTaskCall") || !request.caller || calls.size >= 64) process.exit(1);
  const controller = new AbortController(); calls.set(request.id, controller);
  const timer = setTimeout(() => controller.abort(), Math.max(0, request.deadlineAt - Date.now()));
  const operation = request.name === "httpTaskCall" ? httpTaskCall(request, controller.signal) : runAsMcpHttpCaller(request.caller, () => service.callTool(request.name, request.args, {
    signal: controller.signal, deadlineAt: request.deadlineAt, nativeWork: request.nativeWork,
  })).then(result => send({ id: request.id, result }));
  void operation.catch(() => send({ id: request.id, error: "task executor call failed; look up the original request key" }))
    .finally(() => { clearTimeout(timer); calls.delete(request.id); });
});
input.once("close", () => process.exit(0));
