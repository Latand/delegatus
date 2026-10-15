/** A real Viewer process boundary for controller job recovery tests. */
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
for (let round = 0; round < 4; round++) {
  await tickPipelinesController([], ports);
  await settlePipelineControllerJobs();
}
