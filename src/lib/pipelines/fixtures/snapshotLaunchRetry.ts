/** A fresh Viewer process reading the retry checkpoint from the same database. */
import { defaultPipelinePorts, tickPipelines } from "../engine";
import { loadPipelines } from "../store";
import { registerPipelineTick } from "../controllerSignal";
import { StateSnapshotChangedError } from "@/lib/state/sqliteStateStore";

if (!process.env.LLV_STATE_DIR || process.env.LLV_VIEWER_CONTROL_URL !== "http://127.0.0.1:1") {
  throw new Error("snapshot retry fixture requires isolated state and a closed control URL");
}
registerPipelineTick(async () => {});
const ports = defaultPipelinePorts();
const mode = process.argv[2];
let refused = false, dispatches = 0;
ports.now = () => {
  if (mode === "refuse" && !refused && loadPipelines()[0]?.cursor?.state === "spawning") {
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
ports.spawnAgent = async (_input, onReserved) => {
  dispatches++;
  await onReserved({ launchId: "restart-launch", conversationId: "conversation_restart" });
  return { launchId: "restart-launch", conversationId: "conversation_restart", sessionId: "restart-session",
    "transcript": "/fixture/retry.jsonl", paneId: null };
};
ports.spawnReceipt = () => null;
ports.runtimeHostEpoch = async () => null;
await tickPipelines([], ports);
const lane = loadPipelines()[0]!;
console.log(JSON.stringify({ dispatches, refused, state: lane.state, detail: lane.stateDetail,
  attempt: lane.runs[0]!.attempts[0] }));
