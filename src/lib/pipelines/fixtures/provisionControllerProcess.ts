import fs from "node:fs";
import { closeAgentRegistryForTests } from "@/lib/agent/registry";
import { FlowPipelineController } from "../controller";
import { settlePipelineControllerJobs } from "../controllerJobs";
import { tickPipelinesController } from "../controllerPass";
import { registerPipelineTick } from "../controllerSignal";
import { settlePipelineStopReadLanes } from "../controllerStopRead";
import { defaultPipelinePorts, patchPipeline } from "../engine";
import { realProvisionExec } from "../git";
import { findControllerPipeline } from "../store";

const input = JSON.parse(process.env.LLV_PROVISION_PROCESS_FIXTURE ?? "null") as {
  lane: string; state: string; launches: string; end: string;
  applyBarrier?: { entered: string; release: string };
  pauseAndClose?: true;
} | null;
if (!input || input.state !== process.env.LLV_STATE_DIR || process.env.NODE_ENV !== "test") {
  throw new Error("provisioning subprocess requires isolated fixture state");
}
const unregister = registerPipelineTick(async () => {});
const ports = defaultPipelinePorts();
ports.scheduleTick = () => {};
if (input.pauseAndClose) {
  const pause = await patchPipeline(input.lane, { action: "pause", reason: "Hold the fixture lane before close" }, ports);
  if (pause.pipeline?.state !== "paused") throw new Error("fixture pause refused");
  const close = await patchPipeline(input.lane, { action: "close" }, ports);
  if (close.pipeline?.state !== "closed") throw new Error("fixture close refused");
  unregister();
  closeAgentRegistryForTests();
  process.exit(0);
}
ports.drainHold = () => null;
ports.cpuPressureHold = () => null;
ports.cpuAdmissionReconcile = () => {};
ports.stageHostResident = async () => false;
ports.engineReadiness = () => "connected";
ports.structuredDeliveryPublication = () => "ready";
ports.resolveProjectSpawn = engine => ({ kind: "available", account: {
  engine, accountId: "fixture", kind: "managed", home: process.env.HOME!,
  transcriptRoot: process.env.TMPDIR!, env: { NODE_ENV: "test" },
} });
ports.allowedAccountIds = () => ["fixture"];
if (input.applyBarrier) {
  const { entered, release } = input.applyBarrier;
  ports.provisionExec = async (command, args, cwd, signal, options) => {
    const result = await realProvisionExec(command, args, cwd, signal, options);
    if (command === "git" && ["diff --quiet HEAD --", "rev-parse HEAD"].includes(args.join(" ")) && !fs.existsSync(entered)
      && (await findControllerPipeline(input.lane))?.provisioningJob?.status === "awaitingApply") {
      fs.writeFileSync(entered, "");
      const deadline = performance.now() + 5_000;
      while (!fs.existsSync(release) && performance.now() < deadline) await Bun.sleep(10);
      if (!fs.existsSync(release)) throw new Error("apply barrier did not release");
    }
    return result;
  };
}
ports.spawnAgent = async (request, reserve) => {
  const launchId = `fixture-${request.clientAttemptId}`;
  const conversationId = `conversation_${launchId}`;
  const accountId = "fixture";
  await reserve({ launchId, conversationId, accountId });
  const observer = Bun.spawn([process.execPath, "-e",
    'require("node:fs").appendFileSync(process.argv[1], process.cwd() + "\\n")', input.launches],
  { cwd: request.cwd, stdout: "ignore", stderr: "ignore" });
  if (await observer.exited !== 0) throw new Error("first-child observer failed");
  return { launchId, conversationId, sessionId: launchId, transcript: null, paneId: null, accountId };
};
const controller = new FlowPipelineController({
  tickPipelines: entries => tickPipelinesController(entries, ports),
  scan: async () => ({ files: [], complete: false }),
  scheduleTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>), log: () => {},
}, { phaseDeadlineMs: 15_000, maxPasses: 1 });
try {
  const deadline = performance.now() + 28_000;
  while (!fs.existsSync(input.end) && performance.now() < deadline) {
    await controller.tick();
    const lane = await findControllerPipeline(input.lane);
    if (lane?.runs[0]?.attempts[0]?.state === "running" && fs.existsSync(input.launches)
      && fs.readFileSync(input.launches, "utf8").split("\n").includes(lane.worktreeDir)) break;
    await Bun.sleep(25);
  }
  if (performance.now() >= deadline) throw new Error("subprocess controller reached its deadline");
} finally {
  unregister();
  await (await import("../provisioningJob").catch(() => null))?.settleProvisioningJobsForTests();
  await settlePipelineControllerJobs();
  await settlePipelineStopReadLanes();
  closeAgentRegistryForTests();
}
