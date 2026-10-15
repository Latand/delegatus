// This entry receives an explicit state directory from its Viewer. It never
// imports or migrates the operator's state on its own authority.
import { createInterface } from "node:readline";
import { once } from "node:events";
import type { TaskExecutorRequest } from "./mcp/taskExecutor";

if (!process.env.LLV_STATE_DIR) throw new Error("task executor needs an explicit state directory");
const { runAsMcpHttpCaller } = await import("./mcp/callerContext");
const { TASK_EXECUTOR_FRAME_BYTES, TASK_EXECUTOR_TOOLS } = await import("./mcp/taskExecutor");
const { createProductionViewerMcpService } = await import("./mcp/server");
const { agentRegistry } = await import("./agent/registry");
const { capabilityConversationResolver } = await import("./mcp/bindings");
const service = await createProductionViewerMcpService(false, false, true);
const calls = new Map<number, AbortController>();
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let writing = Promise.resolve();
const send = (message: unknown) => {
  writing = writing.then(async () => {
    const frame = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(frame) > TASK_EXECUTOR_FRAME_BYTES) throw new Error("task executor reply exceeds frame bound");
    if (!process.stdout.write(frame)) await once(process.stdout, "drain");
  });
  void writing.catch(() => process.exit(1));
};
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
  if (!TASK_EXECUTOR_TOOLS.has(request.name) || !request.caller || calls.size >= 64) process.exit(1);
  const controller = new AbortController(); calls.set(request.id, controller);
  const timer = setTimeout(() => controller.abort(), Math.max(0, request.deadlineAt - Date.now()));
  void runAsMcpHttpCaller(request.caller, () => service.callTool(request.name, request.args, {
    signal: controller.signal, deadlineAt: request.deadlineAt, nativeWork: request.nativeWork,
  })).then(result => send({ id: request.id, result }), () => send({ id: request.id, error: "task executor call failed; look up the original request key" }))
    .finally(() => { clearTimeout(timer); calls.delete(request.id); });
});
input.once("close", () => process.exit(0));
