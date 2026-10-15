/** A real Viewer process boundary for controller job recovery tests. */
import fs from "node:fs";
import { defaultPipelinePorts } from "../engine";
import { tickPipelinesController } from "../controllerPass";
import { settlePipelineControllerJobs } from "../controllerJobs";
import { registerPipelineTick } from "../controllerSignal";

if (!process.env.LLV_STATE_DIR || process.env.LLV_VIEWER_CONTROL_URL !== "http://127.0.0.1:1") {
  throw new Error("controller job fixture requires isolated state and a closed control URL");
}
registerPipelineTick(async () => {});
const ports = defaultPipelinePorts();
ports.scheduleTick = () => {};
ports.drainHold = () => null;
ports.cpuAdmissionReconcile = async () => {};
ports.conversationAgentActive = async () => null;
ports.sourcePathAllowed = () => false;
ports.stageHostResident = async () => false;
ports.stopStageAgent = async () => { throw new Error("recovery fixture cannot signal hosts"); };
ports.stopStagePane = async () => { throw new Error("recovery fixture cannot signal panes"); };
ports.spawnAgent = async () => { throw new Error("recovery fixture cannot spawn an agent"); };
ports.structuredDeliveryPublication = () => "unbound";
const closeLog = process.env.LLV_CONTROLLER_CLOSE_LOG;
const reapLog = process.env.LLV_CONTROLLER_REAP_LOG;
if (reapLog) {
  if (!reapLog.startsWith(`${process.env.LLV_STATE_DIR}/`)) throw new Error("reap fixture log must stay in isolated state");
  ports.stageHostResident = async () => true;
  ports.conversationAgentActive = async () => false;
  ports.stopStageAgent = async target => {
    fs.appendFileSync(reapLog, `${target.attempt}\n`);
    return { outcome: "failed", error: "temporary stop failure" };
  };
}
if (closeLog) {
  if (!closeLog.startsWith(`${process.env.LLV_STATE_DIR}/`)) throw new Error("close fixture log must stay in isolated state");
  ports.invalidateProviderContinuation = async id => {
    fs.appendFileSync(closeLog, `cancel:${id}\n`);
    if (id !== "close-16") throw new Error("temporary refusal");
  };
  ports.stopStageAgent = async target => { fs.appendFileSync(closeLog, `stop:${target.conversationId}\n`); return { outcome: "stopped" }; };
}
for (let round = 0; round < (closeLog ? 1 : 4); round++) {
  await tickPipelinesController([], ports);
  await settlePipelineControllerJobs();
}
