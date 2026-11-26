import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeAuto, initialAuto } from "./selfUpdate/auto";
import { writeDrain } from "./selfUpdate/drain";
import { expect, test, spyOn } from "bun:test";
import { normalizeRegistry } from "./agent/registry";
import { loopProgressProbe } from "./agent/registryLockHolderFixture";
import { activateViewerRuntimeWhenCurrent, checkStateDatabasesBeforeStores, completeViewerRuntimeActivation, createViewerStartupBarrier, createViewerWorktreeRecovery, prepareRegistryForNativeCallers, registerViewerRuntime, retryWorktreeRecoveryUntilCommitted, settleInterruptedTransfers, startCurrentReleaseControllers } from "./viewerInstrumentation";
import { acknowledgeHotStateFence, publishHotStateAuthority, readHotStateAuthority, restoreHotStateAuthority } from "./state/hotStateAuthority";

test("legacy worktree catalog refinement cannot delay controller activation or release readiness", async () => {
  const order: string[] = [];
  let refinementStarted = false;
  let finishRefinement!: () => void;
  const refinement = new Promise<void>(resolve => { finishRefinement = resolve; });
  await completeViewerRuntimeActivation({
    initializeOperatorCapability: async () => { order.push("capability"); },
    runIdentityMigration: async () => { order.push("identity"); },
    publishHotStateActivation: () => { order.push("hot-state"); },
    runClaudeLoginRecovery: async () => { order.push("login-recovery"); },
    startStructuredHosts: null,
    startControllers: async () => { order.push("controllers"); },
    publishViewerReleaseReady: () => { order.push("release-ready"); },
    refineBoard: async () => { refinementStarted = true; await refinement; order.push("catalog-and-board-refinement"); },
  });
  expect(order).toEqual([
    "capability", "identity", "hot-state", "login-recovery", "controllers", "release-ready",
  ]);
  expect(refinementStarted).toBeTrue();
  finishRefinement();
  await refinement;
});

test("seat tick actions wait for committed worktree recovery without blocking controller activation", async () => {
  let finishRecovery!: () => void;
  const recovery = new Promise<void>(resolve => { finishRecovery = resolve; });
  let tickStarted = false;
  await startCurrentReleaseControllers({}, {
    loadFlowPipelineController: async () => ({ startFlowPipelineController: () => {} }),
    loadAccountMigrationController: async () => ({ startAccountMigrationController: async () => {} }),
    loadSeatTick: async () => ({ startSeatTick: () => { tickStarted = true; return true; } }),
  }, { beforeSeatTick: recovery });
  expect(tickStarted).toBeFalse();
  finishRecovery();
  await recovery;
  await Promise.resolve();
  expect(tickStarted).toBeTrue();
});

test("a failed recovery keeps the seat tick fenced until a same-generation retry commits", async () => {
  const controller = new AbortController();
  let attempts = 0;
  let tickStarted = false;
  const recovery = retryWorktreeRecoveryUntilCommitted(async () => {
    attempts++;
    if (attempts === 1) throw new Error("transaction held");
    return { folded: 1, leftAlone: 0 };
  }, controller.signal, () => {}, 0);
  await startCurrentReleaseControllers({}, {
    loadFlowPipelineController: async () => ({ startFlowPipelineController: () => {} }),
    loadAccountMigrationController: async () => ({ startAccountMigrationController: async () => {} }),
    loadSeatTick: async () => ({ startSeatTick: () => { tickStarted = true; return true; } }),
  }, { beforeSeatTick: recovery });
  await Promise.resolve();
  expect(tickStarted).toBeFalse();
  await recovery;
  await Promise.resolve();
  expect(attempts).toBe(2);
  expect(tickStarted).toBeTrue();
});

test.each(["before", "after"] as const)("withdrawing a fence %s acknowledgement starts seat tick once the incumbent's recovery receipt arrives", async withdrawal => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "seat-withdrawal-"));
  const revision = "a".repeat(40);
  const scheduled: Array<() => void> = [];
  const initial = publishHotStateAuthority(directory, "sqlite", revision);
  const firstReceipt = Promise.withResolvers<{ folded: number; leftAlone: number }>();
  const resumedReceipt = Promise.withResolvers<{ folded: number; leftAlone: number }>();
  const resumed = Promise.withResolvers<void>();
  const log: string[] = [];
  const poll = async () => {
    scheduled.shift()!();
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  let ticks = 0;
  const signals: AbortSignal[] = [];
  const recovery = createViewerWorktreeRecovery(signal => {
    signals.push(signal);
    return signals.length === 1 ? firstReceipt.promise : resumedReceipt.promise;
  }, () => readHotStateAuthority(directory)?.mode === "sqlite");
  try {
    await activateViewerRuntimeWhenCurrent(async () => {
      await startCurrentReleaseControllers({}, {
        loadFlowPipelineController: async () => ({ startFlowPipelineController: () => {} }),
        loadAccountMigrationController: async () => ({ startAccountMigrationController: async () => {} }),
        loadSeatTick: async () => ({ startSeatTick: () => { ticks++; return true; } }),
      }, { beforeSeatTick: recovery.committed });
      void recovery.start().catch(() => {});
    }, () => true, {
      schedule: callback => { scheduled.push(callback); return {}; },
      log: message => { log.push(String(message)); },
      fenceRequest: () => readHotStateAuthority(directory),
      onFenceRequested: async fence => {
        await recovery.quiesce(new Error("fenced"));
        acknowledgeHotStateFence(directory, fence, {
          flows: 0, pipelines: 0, pipelinesArchive: 0, workflows: 0,
        });
      },
      resumeWorktreeRecovery: async () => {
        await recovery.start();
        resumed.resolve();
      },
    });
    const request = publishHotStateAuthority(directory, "fencing", revision);
    await poll();
    expect(signals[0]?.aborted).toBe(true);
    expect(readHotStateAuthority(directory)?.checkpoint).toBeUndefined();
    if (withdrawal === "before") expect(restoreHotStateAuthority(directory, initial, request))
      .toMatchObject({ mode: "sqlite", releaseRevision: revision });
    firstReceipt.resolve({ folded: 1, leftAlone: 0 });
    await poll();
    expect(ticks).toBe(0);
    if (withdrawal === "after") {
      const fence = readHotStateAuthority(directory)!;
      expect(fence.checkpoint).toBeDefined();
      expect(restoreHotStateAuthority(directory, initial, fence)).toMatchObject({ mode: "sqlite", releaseRevision: revision });
    }
    await poll();
    expect(log).toEqual(withdrawal === "before" ? ["[viewer release] hot-state fence checkpoint failed"] : []);
    expect(signals).toHaveLength(2);
    expect(signals[1]?.aborted).toBe(false);
    expect(ticks).toBe(0);
    resumedReceipt.resolve({ folded: 0, leftAlone: 0 });
    await resumed.promise;
    await poll();
    expect(ticks).toBe(1);
    expect(signals).toHaveLength(2);
  } finally {
    firstReceipt.resolve({ folded: 0, leftAlone: 0 });
    resumedReceipt.resolve({ folded: 0, leftAlone: 0 });
    await recovery.quiesce(new Error("test cleanup"));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("native caller readiness waits through every artifact batch before controllers start", async () => {
  const order: string[] = [];
  let finishSecondBatch!: () => void;
  const secondBatch = new Promise<void>(resolve => { finishSecondBatch = resolve; });
  let batches = 0;
  const controller = new AbortController();
  const registry = {
    prepareReadOnlySnapshot: async () => {
      order.push("snapshot");
      return normalizeRegistry({ version: 2, entries: {}, receipts: {} });
    },
    prepareNativeCallerArtifacts: async () => {
      while (batches < 2) {
        batches += 1;
        order.push(`native-batch-${batches}`);
        if (batches === 2) await secondBatch;
      }
      order.push("native-ready");
    },
  };
  const startup = async () => {
    await prepareRegistryForNativeCallers(registry, controller.signal);
    order.push("registry-ready");
    await completeViewerRuntimeActivation({
      initializeOperatorCapability: async () => {},
      publishHotStateActivation: () => {},
      startStructuredHosts: null,
      startControllers: async () => { order.push("controllers"); },
      publishViewerReleaseReady: () => { order.push("release-ready"); },
    });
  };
  const activation = startup();
  await Promise.resolve();
  await Promise.resolve();
  expect(order).toEqual(["snapshot", "native-batch-1", "native-batch-2"]);
  // Reaching the batched store API here represents its full drain; hold the
  // second slice to prove the first authorized request cannot race readiness.
  finishSecondBatch();
  await activation;
  expect(order).toEqual(["snapshot", "native-batch-1", "native-batch-2", "native-ready", "registry-ready", "controllers", "release-ready"]);
});

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
    loadCloudEnvironmentController: async () => ({ startCloudEnvironmentController: () => { started.push("cloud"); } }),
    loadLinkedBoardSync: async () => ({ startLinkedBoardSync: () => { started.push("boards"); } }),
    loadDoneSweep: async () => ({ startDoneSweep: () => { started.push("done"); } }),
    loadMemberRevocations: async () => ({ startMemberRevocationWorker: () => { started.push("revocations"); } }),
    loadAppConnect: async () => ({ startAppConnectPoller: () => { started.push("app-connect"); } }),
  });
  expect(started).toEqual(["auto", "pipeline", "cloud", "boards", "done", "revocations", "app-connect"]);
});

test.each([true, false])("pressure observation starts independently of cleanup with cleanup loader succeeds=%s", async succeeds => {
  const started: string[] = [];
  await startCurrentReleaseControllers({ LLV_ACCOUNT_CONTROLLER_DISABLED: "1" }, {
    loadFlowPipelineController: async () => ({ startFlowPipelineController: () => {} }),
    loadAccountMigrationController: async () => ({ startAccountMigrationController: async () => {} }),
    loadDiskPressureWatch: async () => ({ startDiskPressureWatch: () => { started.push("pressure"); } }),
    loadTempSweep: async () => { if (!succeeds) throw new Error("cleanup unavailable"); return { startTempSweep: () => { started.push("temp"); } }; },
  });
  expect(started).toEqual(succeeds ? ["pressure", "temp"] : ["pressure"]);
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

test("a seat-channel startup failure leaves saved-answer delivery running", async () => {
  const started: string[] = [];
  await startCurrentReleaseControllers({ LLV_ACCOUNT_CONTROLLER_DISABLED: "1" }, {
    loadFlowPipelineController: async () => ({ startFlowPipelineController: () => { started.push("pipeline"); } }),
    loadAccountMigrationController: async () => ({ startAccountMigrationController: async () => {} }),
    loadSeatChannel: async () => ({ startSeatChannel: () => { throw new Error("channel read refused"); } }),
    loadPrototypeDelivery: async () => ({ startPrototypeDeliveryWorker: () => { started.push("answers"); } }),
  });
  expect(started).toEqual(["pipeline", "answers"]);
});

test("voice timers start at boot, and their failure stops no other controller", async () => {
  const started: string[] = [];
  const controllers = { loadFlowPipelineController: async () => ({ startFlowPipelineController: () => { started.push("pipeline"); } }),
    loadAccountMigrationController: async () => ({ startAccountMigrationController: async () => {} }) };
  await startCurrentReleaseControllers({ LLV_ACCOUNT_CONTROLLER_DISABLED: "1" }, { ...controllers,
    loadVoiceTimers: async () => ({ startVoiceTimers: () => { started.push("timers"); } }) });
  expect(started).toEqual(["pipeline", "timers"]);
  started.length = 0;
  await startCurrentReleaseControllers({}, { ...controllers,
    loadVoiceTimers: async () => { throw new Error("timer store refused"); },
    loadAccountMigrationController: async () => { started.push("accounts"); return { startAccountMigrationController: async () => {} }; } });
  expect(started).toEqual(["pipeline", "accounts"]);
});

test("an install transfer that cannot be settled refuses activation before any launch or host is admitted", async () => {
  await expect(settleInterruptedTransfers(async () => { throw new Error("the checkpoint copy is missing"); }))
    .rejects.toThrow("activation refused: an interrupted install transfer could not be settled (the checkpoint copy is missing)");
  await settleInterruptedTransfers(async () => []);
  /* Awaited, and never caught, ahead of the registry, the operator capability,
     the structured hosts and every controller that admits work. */
  const source = registerViewerRuntime.toString();
  const step = source.indexOf("settleInterruptedTransfers()");
  expect(step).toBeGreaterThan(-1);
  for (const later of ["prepareRegistryForNativeCallers(", "completeViewerRuntimeActivation(", "startCurrentReleaseControllers"]) {
    const at = source.indexOf(later);
    expect(at).toBeGreaterThan(step);
  }
  expect(source.slice(Math.max(0, step - 200), step + 80)).not.toMatch(/catch/);
});
