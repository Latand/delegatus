// A fresh process owns each journal window and scan episode. Natural exit
// exercises the partial-window flush without a test-only flush call.
import { StateLockDeferredError, stateLockAttempt } from "./state/lockWait";
import { FlowPipelineController } from "./pipelines/controller";

for (let attempt = 0; attempt < 5; attempt++) {
  try { stateLockAttempt("probe.zero", () => { throw new StateLockDeferredError("probe.zero"); }); }
  catch (error) { if (!(error instanceof StateLockDeferredError)) throw error; }
}
let now = 0, complete = false;
const controller = new FlowPipelineController({
  now: () => now,
  scan: async () => ({ files: [], complete }),
  tickPipelines: async () => ({ changed: false }),
}, { maxPasses: 1 });
for (let tick = 0; tick < 5; tick++) { await controller.tick(); now += 5_000; }
complete = true;
await controller.tick();
await controller.tick();
if (process.argv[2] === "exit") process.exit(0);
