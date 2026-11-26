import { expect, test, harness, tickPipelines, loadPipelines, savePipelines, create, BUILD_ONLY, realExec, fs, path, engineModule, publishHarness } from "./engine.fixture";

import { tickPipelinesController } from "./controllerPass";
import { pipelineControllerJobLanes, settlePipelineControllerJobs, startPipelineControllerJob, waitForPipelineControllerJob } from "./controllerJobs";

import { spyOn } from "bun:test";
import { restartedTick } from "./engine.mechanicalRecovery.fixture";

if (process.env.MECHANICAL_STATE) test("restart observation", async () => {
  const fixtureState = process.env.LLV_STATE_DIR;
  let restoreAuthority: (() => void) | undefined;
  process.env.LLV_STATE_DIR = process.env.MECHANICAL_STATE;
  try {
    const h = harness();
    h.ports.now = () => process.env.MECHANICAL_NOW!;
    const mode = process.env.MECHANICAL_MODE!;
    let publicationOrder: string[] | undefined;
    const authority = mode.startsWith("commit-authority-");
    if (authority) {
      const ownership = await import("./stageBranch");
      const buildReader = ownership.stageBranchOwnershipReader;
      let rejectNext = false, armed = false, rejected = 0, cancelled = 0;
      let proofUnavailable = false, noteRefusals = 0;
      const ownerId = process.env.MECHANICAL_PIPELINE_ID!;
      const readerSpy = spyOn(ownership, "stageBranchOwnershipReader").mockImplementation(id => {
        const reader = buildReader(id), read = reader.read;
        reader.read = async () => {
          if (id === ownerId && rejectNext) { rejectNext = false; rejected++; throw new Error("authority read interrupted"); }
          if (id === ownerId && proofUnavailable) throw new Error("authority proof unavailable");
          return read();
        };
        return reader;
      });
      const root = path.join(process.env.MECHANICAL_REPO!, ".git");
      let restoreNote: (() => void) | undefined;
      const watcher = fs.watch(root, (_event, name) => {
        if (!armed && String(name) === "mechanical-hook-ready") { armed = true; rejectNext = true; }
      });
      restoreAuthority = () => {
        watcher.close(); readerSpy.mockRestore(); restoreNote?.();
        fs.rmSync(path.join(root, "mechanical-hook-ready"), { force: true });
      };
      if (mode === "commit-authority-note") {
        const notes = await import("./taskStatusNote");
        const noteSpy = spyOn(notes, "writeParkedTaskNote").mockImplementation(async () => {
          noteRefusals++; throw new Error("fixture task note unavailable");
        });
        restoreNote = () => noteSpy.mockRestore();
      }
      h.ports.exec = async (command, args, cwd, env, options) => {
        const result = await realExec(command, args, cwd, env, options);
        if (args[0] === "commit" && result.stderr === "command cancelled") {
          expect(options?.signal?.aborted).toBe(true); cancelled++;
          if (mode === "commit-authority-pause") {
            expect((await engineModule.patchPipeline(ownerId, { action: "pause" }, h.ports)).error).toBeUndefined();
          }
          if (mode === "commit-authority-unreadable") proofUnavailable = true;
          if (mode === "commit-authority-peer") {
            const script = `const { buildPipeline, findPipelineRecord, withPipelineMutation } = await import(${JSON.stringify(path.join(import.meta.dir, "store.ts"))});
              const owner = findPipelineRecord(${JSON.stringify(ownerId)});
              const peer = buildPipeline({ id: "mechanical-authority-peer", task: "peer authority", project: owner.project,
                repoDir: owner.repoDir, stages: owner.stages, srcPath: null, srcConversationId: null,
                now: ${JSON.stringify(h.ports.now())}, state: "draft" });
              await withPipelineMutation(async (rows, persist) => { rows.push(peer); await persist([peer]); });`;
            const written = await realExec(process.execPath, ["-e", script], process.cwd(), { ...process.env }, { timeoutMs: 30_000 });
            expect(written.code, written.stderr).toBe(0);
          }
        }
        return result;
      };
      await tickPipelinesController([], h.ports); await settlePipelineControllerJobs();
      expect(rejected).toBe(1); expect(cancelled).toBe(1);
      expect(pipelineControllerJobLanes()).toHaveLength(0);
      if (mode === "commit-authority-note") expect(noteRefusals).toBe(1);
    } else if (mode.startsWith("commit")) {
      h.ports.exec = async (command, args, cwd, env, options) => {
        if (args[0] !== "commit" || mode !== "commit-cancel") return realExec(command, args, cwd, env, options);
        const root = path.join(process.env.MECHANICAL_REPO!, ".git");
        const cancel = new AbortController();
        const watcher = fs.watch(root, (_event, name) => { if (String(name) === "mechanical-hook-ready") cancel.abort(); });
        try {
          return await realExec(command, args, cwd, env, { ...options,
            signal: options?.signal ? AbortSignal.any([cancel.signal, options.signal]) : cancel.signal });
        } finally { watcher.close(); fs.rmSync(path.join(root, "mechanical-hook-ready"), { force: true }); }
      };
    }
    if (mode === "publication-block" || mode === "publication-free") {
      const lane = loadPipelines().find(row => row.id === process.env.MECHANICAL_PIPELINE_ID)!;
      const publisher = publishHarness(h);
      publisher.setLocalHead(lane.lastPassedCommit); publisher.setDirty(false);
      publicationOrder = publisher.order;
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      try {
        if (mode === "publication-block") for (let n = 0; n < 4; n++) {
          expect(startPipelineControllerJob(`restart-publication-${n}`, () => held, async () => "unchanged", "publication")).toBe(true);
        }
        await tickPipelinesController([], h.ports);
        await waitForPipelineControllerJob(lane.id, "settlement");
      } finally { release(); await settlePipelineControllerJobs(); }
      if (mode === "publication-free") for (let n = 0; n < 3; n++) {
        await tickPipelinesController([], h.ports); await settlePipelineControllerJobs();
      }
    } else if (mode === "publication-startup") {
      const publisher = publishHarness(h);
      const store = await import("./store");
      const readVersion = store.controllerPipelineVersion;
      let rejected = 0;
      let resumedReservation: string | undefined;
      let retrying = false;
      const versionSpy = spyOn(store, "controllerPipelineVersion").mockImplementation(async id => {
        const lane = loadPipelines().find(row => row.id === id);
        if (!rejected && lane?.lastPassedCommit === publisher.passedSha && lane.delivery?.operation?.state === "pending") {
          rejected++;
          throw new Error("publication startup version unavailable");
        }
        if (retrying && lane?.delivery?.operation?.state === "pending") resumedReservation ??= lane.delivery.operation.id;
        return readVersion(id);
      });
      try {
        await tickPipelinesController([], h.ports);
        await settlePipelineControllerJobs();
        expect(rejected).toBe(1);
        expect(pipelineControllerJobLanes()).toHaveLength(0);
        expect(publisher.order.some(value => value.startsWith("push:"))).toBe(false);
        const reservation = loadPipelines()[0]!.delivery!.operation!;
        retrying = true;
        for (let n = 0; n < 3; n++) {
          await tickPipelinesController([], h.ports);
          await settlePipelineControllerJobs();
        }
        const lane = loadPipelines()[0]!;
        expect(resumedReservation).toBe(reservation.id);
        expect(lane.delivery!.operation!.sha).toBe(reservation.sha);
        expect(lane.delivery!.operation!.requestKey).toBe(reservation.requestKey);
        expect(lane.delivery!.operation!.result?.ok).toBe(true);
        expect(publisher.order.filter(value => value === "commit")).toHaveLength(1);
        expect(publisher.order.filter(value => value.startsWith("push:"))).toHaveLength(1);
      } finally { versionSpy.mockRestore(); }
    } else if (mode.startsWith("settlement")) {
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      try {
        if (mode === "settlement-block") for (let n = 0; n < 4; n++) {
          expect(startPipelineControllerJob(`blocked-settlement-${n}`, () => held, async () => "unchanged")).toBe(true);
        }
        await tickPipelinesController([], h.ports);
      } finally { release(); await settlePipelineControllerJobs(); }
    } else if (mode === "commit-manual") {
      for (let n = 0; n < 3; n++) {
        await tickPipelinesController([], h.ports); await settlePipelineControllerJobs();
      }
    } else if (!authority) await tickPipelines([], h.ports);
    const lane = loadPipelines().find(row => row.id === process.env.MECHANICAL_PIPELINE_ID) ?? loadPipelines()[0];
    console.log(JSON.stringify({ lane, spawns: h.spawnInputs, publicationOrder }));
  } finally { restoreAuthority?.(); process.env.LLV_STATE_DIR = fixtureState; }
});

test("a publication startup read failure releases settlement custody before retrying its reservation", async () => {
  const h = harness();
  await create(h.ports, BUILD_ONLY as never, { publication: "remote-branch" });
  await tickPipelines([], h.ports); await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  lane.cursor!.state = "committing";
  Object.assign(lane.runs[0]!.attempts[0]!, { state: "committing", verdict: { status: "pass" } });
  savePipelines([lane]);
  const recovered = await restartedTick("2026-10-29T08:48:00.000Z", "publication-startup");
  expect(recovered.lane.state).toBe("completed");
  expect(recovered.lane.runs[0]!.attempts).toHaveLength(1);
  expect(recovered.spawns).toHaveLength(0);
}, 120_000);

test.each(["retry-stage", "publish", "publish-head", "custody", "custody-head"] as const)("explicit publication recovery renews admission across immediate polls and restart: %s", async action => {
  const h = harness();
  const publisher = publishHarness(h);
  h.ports.now = () => "2026-10-29T08:00:00.000Z";
  await create(h.ports, BUILD_ONLY as never, { publication: "remote-branch" });
  await tickPipelines([], h.ports); await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!, attempt = lane.runs[0]!.attempts[0]!;
  expect((await engineModule.reportStageCompletion({ verdict: "pass", summary: "Preserved pass" },
    { kind: "agent", role: "builder", conversationId: attempt.conversationId }, h.ports)).error).toBeUndefined();
  const reported = loadPipelines()[0]!;
  reported.cursor!.state = "committing";
  Object.assign(reported.runs[0]!.attempts[0]!, { state: "committing", verdict: { status: "pass" } });
  savePipelines([reported]);
  let now = Date.parse("2026-10-29T12:00:00.000Z");
  const first = await restartedTick(new Date(now).toISOString(), "publication-block", undefined, lane.id);
  expect(first.lane.state).toBe("running");
  expect(first.lane.runs[0]!.attempts[0]!.settlementAdmissionRetry).toEqual({ failures: 0, retryAt: new Date(now).toISOString() });
  for (const delay of [0, 60_000, 5 * 60_000, 15 * 60_000]) {
    now += 15 * 60_000 + delay;
    await restartedTick(new Date(now).toISOString(), "publication-block", undefined, lane.id);
  }
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  if (action.startsWith("custody")) {
    parked.stateDetail = "settling the stage push: stage custody requires reconciliation";
    parked.runs[0]!.attempts[0]!.state = "needs_decision";
    savePipelines([parked]);
  }
  const oldOperation = parked.delivery!.operation!;
  const oldReport = parked.runs[0]!.attempts[0]!.report;
  publisher.setLocalHead(parked.lastPassedCommit); publisher.setDirty(false);
  const manualAt = new Date(now + 24 * 60 * 60_000).toISOString();
  h.ports.now = () => manualAt;
  const request = action === "retry-stage" ? { action: "retry-stage" as const }
    : { action: "publish" as const, ...(action.endsWith("head") ? { acceptedSha: parked.lastPassedCommit } : {}) };
  expect((await engineModule.patchPipeline(lane.id, request, h.ports)).error).toBeUndefined();
  let reservation: string | undefined;
  for (let poll = 0; poll < 2; poll++) {
    const waiting = await restartedTick(manualAt, "publication-block", undefined, lane.id);
    expect(waiting.lane.state, waiting.lane.stateDetail ?? undefined).toBe("running");
    expect(waiting.lane.runs[0]!.attempts[0]!.settlementAdmissionRetry).toEqual({ failures: 0, retryAt: manualAt });
    reservation ??= waiting.lane.delivery!.operation!.id;
    expect(reservation).not.toBe(oldOperation.id);
    expect(waiting.lane.delivery!.operation!.id).toBe(reservation);
    expect(waiting.lane.delivery!.epoch).toBe(parked.delivery!.epoch);
    expect(waiting.lane.lastPassedCommit).toBe(parked.lastPassedCommit);
    expect(waiting.lane.runs[0]!.attempts[0]!.report).toEqual(oldReport);
    expect(waiting.lane.runs[0]!.attempts).toHaveLength(1);
    expect(waiting.spawns).toHaveLength(0);
    expect(waiting.publicationOrder).toHaveLength(0);
  }
  const settled = await restartedTick(manualAt, "publication-free", undefined, lane.id);
  expect(settled.lane.state).toBe("completed");
  expect(settled.lane.lastPassedCommit).toBe(parked.lastPassedCommit);
  expect(settled.lane.delivery!.operation!.reservationId).toBe(reservation!);
  expect(settled.lane.delivery!.operation!.sha).toBe(parked.lastPassedCommit);
  expect(settled.lane.delivery!.operation!.requestKey).toBe(oldOperation.requestKey);
  expect(settled.lane.runs[0]!.attempts).toHaveLength(1);
  expect(settled.lane.runs[0]!.attempts[0]!.report).toEqual(oldReport);
  expect(settled.spawns).toHaveLength(0);
  expect(settled.publicationOrder?.filter(item => item.startsWith("push:"))).toHaveLength(1);
  const after = await restartedTick(manualAt, "publication-free", undefined, lane.id);
  expect(after.publicationOrder).toHaveLength(0);
}, 240_000);

test.each(["settles", "exhausts"] as const)("settlement admission survives process restarts: %s", async outcome => {
  const exhausted = outcome === "exhausts";
  const h = harness();
  await create(h.ports, BUILD_ONLY as never);
  await tickPipelines([], h.ports); await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  lane.cursor!.state = "committing";
  Object.assign(lane.runs[0]!.attempts[0]!, { state: "committing", verdict: { status: "pass" } });
  savePipelines([lane]);
  let now = Date.parse("2026-10-29T08:48:00.000Z");
  await restartedTick(new Date(now).toISOString(), "settlement-block");
  for (const delay of [0, 60_000, 5 * 60_000]) {
    now += 15 * 60_000 + delay;
    const retry = await restartedTick(new Date(now).toISOString(), "settlement-block");
    expect(retry.lane.state).toBe("running");
    expect(retry.lane.lastPassedCommit).toBe(lane.lastPassedCommit);
    expect(retry.spawns).toHaveLength(0);
  }
  now += exhausted ? 30 * 60_000 : 15 * 60_000;
  const final = await restartedTick(new Date(now).toISOString(), exhausted ? "settlement-block" : "settlement-free");
  expect(final.lane.state).toBe(exhausted ? "needs_decision" : "completed");
  if (exhausted) expect(final.lane.stateDetail).toContain("after 3 automatic retries");
  expect(final.spawns).toHaveLength(0);
  expect(final.lane.runs[0]!.attempts).toHaveLength(1);
  const after = await restartedTick(new Date(now + 24 * 60 * 60_000).toISOString(), "settlement-free");
  expect(after.lane.state).toBe(exhausted ? "needs_decision" : "completed");
  expect(after.spawns).toHaveLength(0);
  if (exhausted) {
    const manualAt = new Date(now + 24 * 60 * 60_000).toISOString();
    const ports = { ...h.ports, now: () => manualAt };
    expect((await engineModule.patchPipeline(lane.id, { action: "retry-stage" }, ports)).error).toBeUndefined();
    for (let poll = 0; poll < 2; poll++) {
      const waiting = await restartedTick(manualAt, "settlement-block");
      expect(waiting.lane.state).toBe("running");
      expect(waiting.lane.runs[0]!.attempts[0]!.settlementAdmissionRetry).toEqual({ failures: 0, retryAt: manualAt });
      expect(waiting.lane.lastPassedCommit).toBe(lane.lastPassedCommit);
      expect(waiting.lane.runs[0]!.attempts).toHaveLength(1);
      expect(waiting.spawns).toHaveLength(0);
    }
    const resumed = await restartedTick(manualAt, "settlement-free");
    expect(resumed.lane.state).toBe("completed");
    expect(resumed.lane.runs[0]!.attempts).toHaveLength(1);
    expect(resumed.spawns).toHaveLength(0);
  }
}, 240_000);
