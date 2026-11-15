/** A fresh Viewer process reading the retry checkpoint from the same database. */
import { defaultPipelinePorts, tickPipelines } from "../engine";
import { loadPipelines, withPipelineMutation } from "../store";
import { agentRegistry } from "@/lib/agent/registry";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { registerPipelineTick } from "../controllerSignal";
import { StateSnapshotChangedError } from "@/lib/state/sqliteStateStore";

if (!process.env.LLV_STATE_DIR || process.env.LLV_VIEWER_CONTROL_URL !== "http://127.0.0.1:1") {
  throw new Error("snapshot retry fixture requires isolated state and a closed control URL");
}
registerPipelineTick(async () => {});
const ports = defaultPipelinePorts();
const mode = process.argv[2];
let refused = false, dispatches = 0;
if (mode === "legacy-read") await withPipelineMutation(async (rows, persist) => {
  for (const lane of rows) for (const run of lane.runs) for (const attempt of run.attempts) Reflect.deleteProperty(attempt, "snapshotLaunchRetry");
  await persist(rows);
});
ports.now = () => {
  if (mode === "refuse" && !refused && loadPipelines()[0]?.cursor?.state === "spawning"
    && !loadPipelines()[0]?.runs[0]?.attempts[0]?.snapshotLaunchRetry?.receiptPending) {
    refused = true;
    throw new StateSnapshotChangedError();
  }
  return "2026-11-01T00:00:00.000Z";
};
ports.scheduleTick = () => {};
ports.drainHold = () => null;
ports.cpuPressureHold = () => null;
ports.cpuAdmissionReconcile = async () => {};
ports.structuredDeliveryPublication = () => "ready";
ports.engineReadiness = () => "connected";
ports.worktreePresent = () => true;
ports.roleLookup = () => null;
ports.exec = async (_command, args) => ({ code: 0, stderr: "", stdout: args[0] === "rev-parse" ? `${"a".repeat(40)}\n` : "" });
ports.spawnAgent = async (input, onReserved) => {
  dispatches++;
  if (mode === "legacy-read") {
    const begun = beginLegacySpawnFixture(agentRegistry(), { engine: input.role.engine, cwd: input.cwd,
      transport: "structured", clientAttemptId: input.clientAttemptId, memberships: [input.membership] });
    await onReserved({ launchId: begun.receipt.launchId, conversationId: begun.receipt.conversationId });
    return { launchId: begun.receipt.launchId, conversationId: begun.receipt.conversationId,
      sessionId: "legacy-session", "transcript": "/fixture/legacy.jsonl", paneId: null };
  }
  await onReserved({ launchId: "restart-launch", conversationId: "conversation_restart" });
  return { launchId: "restart-launch", conversationId: "conversation_restart", sessionId: "restart-session",
    "transcript": "/fixture/retry.jsonl", paneId: null };
};
ports.spawnReceipt = () => null;
ports.runtimeHostEpoch = async () => null;
await tickPipelines([], ports);
const lane = loadPipelines()[0]!;
await (await import("@/lib/links/taskPageWorker")).shutdownTaskPageWorker();
const launchCount = mode === "legacy-read" ? agentRegistry().pipelineSpawnHistory(process.argv[3]!).length : null;
console.log(JSON.stringify({ dispatches, refused, launchCount, state: lane.state, detail: lane.stateDetail,
  attempt: lane.runs[0]!.attempts[0] }));
