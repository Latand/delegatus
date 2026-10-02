import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeAuto, initialAuto } from "./selfUpdate/auto";
import { writeDrain } from "./selfUpdate/drain";
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
  expect(started).toEqual(["auto", "pipeline", "boards"]);
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

test("required durable drain recovery failure refuses autonomous startup", async () => {
  const previous = process.env.LLV_STATE_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drain-boot-failure-"));
  process.env.LLV_STATE_DIR = dir;
  const autoDir = path.join(dir, "self-update");
  const target = "a".repeat(40);
  const at = new Date().toISOString();
  const drain = { id: "required-drain", target: { sha: target, short: target.slice(0, 7), version: "1", date: "" }, since: at, overranAt: null, blockers: null };
  writeAuto(path.join(autoDir, "auto.json"), { ...initialAuto(), enabled: true, drain });
  writeDrain(path.join(autoDir, "auto-drain.json"), { id: drain.id, target, since: at, until: Date.now() - 1 });
  const started: string[] = [];
  try {
    await expect(startCurrentReleaseControllers({ LLV_ACCOUNT_CONTROLLER_DISABLED: "1" }, {
      loadSelfUpdateAuto: async () => { throw new Error("required updater could not start"); },
      loadFlowPipelineController: async () => ({ startFlowPipelineController: () => { started.push("pipeline"); } }),
      loadSeatTick: async () => ({ startSeatTick: () => { started.push("seat"); return true; } }),
      loadAccountMigrationController: async () => ({ startAccountMigrationController: async () => {} }),
    })).rejects.toThrow("required updater could not start");
    expect(started).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
