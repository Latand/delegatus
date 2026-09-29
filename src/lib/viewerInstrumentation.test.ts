import { expect, test } from "bun:test";
import { startCurrentReleaseControllers } from "./viewerInstrumentation";

test("the release owner starts auto-update with the other controllers", async () => {
  const started: string[] = [];
  await startCurrentReleaseControllers({ LLV_ACCOUNT_CONTROLLER_DISABLED: "1" }, {
    loadFlowPipelineController: async () => ({ startFlowPipelineController: () => { started.push("pipeline"); } }),
    loadAccountMigrationController: async () => ({ startAccountMigrationController: async () => {} }),
    loadSelfUpdateAuto: async () => ({ startSelfUpdateAuto: () => { started.push("auto"); } }),
    loadLinkedBoardSync: async () => ({ startLinkedBoardSync: () => { started.push("boards"); } }),
  });
  expect(started).toEqual(["pipeline", "boards", "auto"]);
});

test("an auto-update loader failure leaves the other controllers running", async () => {
  const started: string[] = [];
  await startCurrentReleaseControllers({ LLV_ACCOUNT_CONTROLLER_DISABLED: "1" }, {
    loadFlowPipelineController: async () => ({ startFlowPipelineController: () => { started.push("pipeline"); } }),
    loadAccountMigrationController: async () => ({ startAccountMigrationController: async () => {} }),
    loadSelfUpdateAuto: async () => { throw new Error("loader failed"); },
  });
  expect(started).toEqual(["pipeline"]);
});
