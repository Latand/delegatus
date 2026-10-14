import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeAuto, initialAuto } from "./selfUpdate/auto";
import { writeDrain } from "./selfUpdate/drain";
import { expect, test, spyOn } from "bun:test";
import { loopProgressProbe } from "./agent/registryLockHolderFixture";
import { checkStateDatabasesBeforeStores, createViewerStartupBarrier, startCurrentReleaseControllers } from "./viewerInstrumentation";

test("retirement cannot checkpoint ahead of the real activation worker or accept its late result", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "activation-retirement-"));
  const go = path.join(directory, "go");
  const workerPath = path.join(directory, "held-worker.ts");
  fs.writeFileSync(workerPath, `import fs from "node:fs";
    while (!fs.existsSync(${JSON.stringify(go)})) await Bun.sleep(1);
    await import(${JSON.stringify(path.resolve("src/lib/stateBackup.worker.ts"))});
  `);
  const helper = await import("./helperLease");
  const spawn = helper.spawnLeasedHelper;
  const launch = spyOn(helper, "spawnLeasedHelper").mockImplementation((name, spec, ...rest) =>
    spawn(name, { ...spec, command: process.execPath, args: [workerPath] }, ...rest));
  const barrier = createViewerStartupBarrier(new AbortController());
  const progress = loopProgressProbe();
  let retired = false;
  let retirement: Promise<void> | undefined;
  progress.arm(async () => {
    retirement = barrier.quiesce(new Error("retired")).then(() => { retired = true; });
    try { await Bun.sleep(10); expect(retired).toBe(false); }
    finally { fs.writeFileSync(go, "release"); }
  });
  try {
    await expect(progress.run(() => barrier.run(() => checkStateDatabasesBeforeStores(directory)))).rejects.toThrow("retired");
    await retirement;
    expect(retired).toBe(true);
  } finally { launch.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }); }
}, 60_000);

test("retirement awaits an admitted startup mutation and refuses its late activation result", async () => {
  const controller = new AbortController();
  const barrier = createViewerStartupBarrier(controller);
  let release!: () => void;
  let activated = false;
  const work = barrier.run(() => new Promise<void>(resolve => { release = resolve; })).then(() => { activated = true; });
  const outcome = work.then(() => null, error => error as Error);
  let retired = false;
  const retirement = barrier.quiesce(new Error("retired")).then(() => { retired = true; });
  await Bun.sleep(5);
  expect(retired).toBe(false);
  expect(activated).toBe(false);
  release();
  const [error] = await Promise.all([outcome, retirement]);
  expect(error?.message).toBe("retired");
  expect(retired).toBe(true);
  expect(activated).toBe(false);
  let started = false;
  await expect(barrier.run(async () => { started = true; })).rejects.toThrow("retired");
  expect(started).toBe(false);
});

test("startup retirement waits for every pending mutation, including a failed one", async () => {
  const barrier = createViewerStartupBarrier(new AbortController());
  let release!: () => void, fail!: (error: Error) => void;
  const first = barrier.run(() => new Promise<void>(resolve => { release = resolve; }));
  const second = barrier.run(() => new Promise<void>((_, reject) => { fail = reject; }));
  const results = Promise.allSettled([first, second]);
  let retired = false;
  const retirement = barrier.quiesce(new Error("retired")).then(() => { retired = true; });
  release();
  await Bun.sleep(5);
  expect(retired).toBe(false);
  fail(new Error("worker failed"));
  await retirement;
  expect((await results).map(result => result.status)).toEqual(["rejected", "rejected"]);
});

test("the release owner starts auto-update and the «Готово» sweep with the other controllers", async () => {
  const started: string[] = [];
  await startCurrentReleaseControllers({ LLV_ACCOUNT_CONTROLLER_DISABLED: "1" }, {
    loadFlowPipelineController: async () => ({ startFlowPipelineController: () => { started.push("pipeline"); } }),
    loadAccountMigrationController: async () => ({ startAccountMigrationController: async () => {} }),
    loadSelfUpdateAuto: async () => ({ startSelfUpdateAuto: () => { started.push("auto"); } }),
    loadLinkedBoardSync: async () => ({ startLinkedBoardSync: () => { started.push("boards"); } }),
    loadDoneSweep: async () => ({ startDoneSweep: () => { started.push("done"); } }),
  });
  expect(started).toEqual(["auto", "pipeline", "boards", "done"]);
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

test.each([true, false])("required durable drain recovery failure refuses autonomous startup with enabled=%s", async (enabled) => {
  const previous = process.env.LLV_STATE_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drain-boot-failure-"));
  process.env.LLV_STATE_DIR = dir;
  const autoDir = path.join(dir, "self-update");
  const target = "a".repeat(40);
  const at = new Date().toISOString();
  const drain = { id: "required-drain", target: { sha: target, short: target.slice(0, 7), version: "1", date: "" }, since: at, overranAt: null, blockers: null };
  writeAuto(path.join(autoDir, "auto.json"), { ...initialAuto(), enabled, drain: { ...drain, admitted: !enabled } });
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
