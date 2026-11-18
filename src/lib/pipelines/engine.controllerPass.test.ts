import { expect, test, harness, create, createPipelineFromRequest, BUILD_ONLY, loadPipelines, savePipelines, tickPipelines, pipelineIdentity, publishHarness, Database, path, fs, spawn, realWorktreeLane, stopFixtureProcess, defaultPipelinePorts, crypto, registerPipelineTick, reserveActivationOnly, engineModule } from "./engine.fixture";
import { FlowPipelineController, type FlowPipelineControllerHeartbeat } from "./controller";
import { requestPipelineTick } from "./controllerSignal";
import { tickPipelinesController } from "./controllerPass";
import { settlePipelineStopReadLanes } from "./controllerStopRead";
import { createServer } from "node:net";
import { ownedStageControl } from "./fixtures/ownedStageControl";
import { pipelineControllerJobLanes, settlePipelineControllerJobs, startPipelineControllerJob, takePipelineControllerJobChanges } from "./controllerJobs";
import { controllerAttemptWindow, controllerOtherTerminalHosts, controllerHostHasLiveWork, controllerFlowAttached, acknowledgePipelineControllerWork, archiveSettledPipelines, controllerPipelineVersion, findControllerPipeline, pipelineControllerReady, selectControllerPipelines, selectPipelineControllerWork, withPipelineMutation, withDeliveryMutationAsync, withPipelineControllerMutation, controllerUnclaimedPublications, PipelineStoreError } from "./store";
import { SqliteStateCollection, StateSnapshotChangedError, resetStateReadonlyConnectionCountForTests, stateReadonlyConnectionCountForTests } from "@/lib/state/sqliteStateStore";
import { setSystemTime, spyOn } from "bun:test";
import { performanceSpans, performanceSites } from "@/lib/performanceSpans";
import { instanceCpuAdmissionFile, instanceCpuAdmissionQueue } from "@/lib/runtime/cpuAdmissionScope";
import { stateDir } from "@/lib/configDir";
import { withControllerPipelineScope } from "./controllerScope";
import { CpuAdmissionQueue, CPU_QUEUE_SPACING_MS } from "@/lib/runtime/cpuAdmission";
import { DEFAULT_CPU_PRESSURE_POLICY } from "@/lib/runtime/cpuPressure";
import { currentOperationLease, OperationLeaseExpiredError } from "@/lib/operationLease";

async function committing(publication: "internal" | "remote-branch" = "internal") {
  const h = harness();
  await create(h.ports, BUILD_ONLY as never, { publication });
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  lane.cursor!.state = "committing";
  Object.assign(lane.runs[0]!.attempts[0]!, { state: "committing", verdict: { status: "pass" } });
  savePipelines([lane]);
  return { h, lane };
}

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test.each(["never", "late-write"] as const)("an expired controller abandons a %s await and the next tick admits and launches the waiting stage", async mode => {
  const h = harness();
  let stageNow = Date.parse("2026-10-20T00:00:00.000Z"), eligible = false;
  h.ports.now = () => new Date(stageNow).toISOString();
  const queue = new CpuAdmissionQueue(path.join(process.env.LLV_STATE_DIR!, `hung-pass-${mode}.sqlite`), () => stageNow);
  const keys = new Set<string>();
  h.ports.cpuPressureHold = (key, priority) => {
    if (key === undefined) throw new Error("missing stage CPU admission key");
    keys.add(key);
    const wait = queue.check(key, eligible, undefined, true, priority);
    return wait ? { since: wait.since, avg10: 90, deferred: false, policy: DEFAULT_CPU_PRESSURE_POLICY, queue: wait } : null;
  };
  await create(h.ports, BUILD_ONLY as never);
  await tickPipelines([], h.ports); await tickPipelines([], h.ports);
  expect(h.spawnInputs).toHaveLength(0);
  expect(keys.size).toBe(1);
  const entered = latch(), release = latch(), lateSettled = latch();
  const timers: Array<{ active: boolean; callback: () => void }> = [];
  const logs: string[] = [];
  let now = 0, admissions = 0, lateError: unknown;
  h.ports.cpuAdmissionReconcile = async () => {
    if (++admissions !== 1) { queue.reconcile("stage:", keys); return; }
    if (mode === "never") { entered.resolve(); await new Promise<void>(() => {}); return; }
    await withPipelineMutation(async (rows, persist) => {
      entered.resolve();
      await release.promise;
      try {
        rows[0]!.state = "paused";
        await persist([rows[0]!]);
      } catch (error) { lateError = error; throw error; }
      finally { lateSettled.resolve(); }
    });
  };
  const controller = new FlowPipelineController({
    tickPipelines: entries => tickPipelinesController(entries, h.ports),
    now: () => now,
    scan: async () => ({ files: [], complete: false }),
    scheduleTimeout: callback => { const timer = { active: true, callback }; timers.push(timer); return timer; },
    clearTimeout: timer => { (timer as typeof timers[number]).active = false; },
    log: message => { logs.push(message); },
  }, { phaseDeadlineMs: 500, maxPasses: 1 });
  try {
    const first = controller.tick();
    await until(entered.promise);
    now = 500;
    timers.find(timer => timer.active)!.callback();
    await until(first);
    eligible = true; stageNow += 5_000;
    await until(controller.poll());
    expect(admissions).toBeGreaterThan(1);
    expect(h.spawnInputs).toHaveLength(1);
    expect(logs.some(line => line.includes("port.cpuAdmissionReconcile"))).toBe(true);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("running");
    if (mode === "late-write") {
      release.resolve();
      await until(lateSettled.promise);
      expect(lateError).toBeInstanceOf(Error);
      expect((lateError as Error).message).toBe("controller pass deadline exceeded");
      expect(loadPipelines()[0]!.state).toBe("running");
      await until(controller.poll());
      expect(h.spawnInputs).toHaveLength(1);
    }
    const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"), { readonly: true });
    try { expect(db.query("SELECT count(*) AS n FROM state_leases").get()).toEqual({ n: 0 }); }
    finally { db.close(); }
  } finally { release.resolve(); await settlePipelineControllerJobs(); queue.close(); }
});

test("an in-flight reserved launch retains custody across pass expiry and settles without redispatch", async () => {
  const h = harness();
  let stageNow = Date.parse("2026-10-20T00:00:00.000Z"), eligible = false;
  h.ports.now = () => new Date(stageNow).toISOString();
  const queue = new CpuAdmissionQueue(path.join(process.env.LLV_STATE_DIR!, "expired-reservation.sqlite"), () => stageNow);
  const keys = new Set<string>();
  h.ports.cpuPressureHold = (key, priority) => {
    if (key === undefined) throw new Error("missing stage CPU admission key");
    keys.add(key);
    const wait = queue.check(key, eligible, undefined, true, priority);
    return wait ? { since: wait.since, avg10: 90, deferred: false, policy: DEFAULT_CPU_PRESSURE_POLICY, queue: wait } : null;
  };
  await create(h.ports, BUILD_ONLY as never);
  await tickPipelines([], h.ports); await tickPipelines([], h.ports);
  expect(h.spawnInputs).toHaveLength(0);
  const entered = latch(), release = latch(), settled = latch();
  let receiptState: "starting" | "failed" = "starting";
  let dispatches = 0, receiptReads = 0;
  h.ports.spawnReceipt = launchId => {
    if (launchId !== "launch-expired") return null;
    receiptReads++;
    return { state: receiptState } as never;
  };
  h.ports.spawnAgent = async (_input, onReserved) => {
    dispatches++;
    await onReserved({ launchId: "launch-expired", conversationId: "conversation-expired", accountId: "fixture-account" });
    entered.resolve();
    try { await release.promise; throw new OperationLeaseExpiredError(); }
    finally { settled.resolve(); }
  };
  const timers: Array<{ active: boolean; callback: () => void }> = [];
  let now = 0;
  const controller = new FlowPipelineController({
    tickPipelines: entries => tickPipelinesController(entries, h.ports),
    now: () => now,
    scan: async () => ({ files: [], complete: false }),
    scheduleTimeout: callback => { const timer = { active: true, callback }; timers.push(timer); return timer; },
    clearTimeout: timer => { (timer as typeof timers[number]).active = false; },
    log: () => {},
  }, { phaseDeadlineMs: 500, maxPasses: 1 });
  try {
    eligible = true; stageNow += 5_000;
    const first = controller.tick();
    await until(entered.promise);
    now = 500;
    timers.find(timer => timer.active)!.callback();
    await until(first);
    const reserved = loadPipelines()[0]!.runs[0]!.attempts[0]!;
    expect(reserved.activation?.phase).toBe("dispatching");
    receiptState = "failed";
    release.resolve();
    await until(settled.promise);

    await until(controller.poll());
    const reconciled = loadPipelines()[0]!.runs[0]!.attempts[0]!;
    expect(reconciled.activation).toBeUndefined();
    expect(receiptReads).toBeGreaterThan(0);
    expect(dispatches).toBe(1);
  } finally { release.resolve(); await settlePipelineControllerJobs(); queue.close(); }
});

test("a waiting production publisher releases its settlement permit for another passed stage", () => withControllerAuditState(async () => {
  const publishers: Array<Awaited<ReturnType<typeof committing>> & {
    publication: ReturnType<typeof publishHarness>; exec: ReturnType<typeof harness>["ports"]["exec"];
  }> = [];
  for (let n = 0; n < 4; n++) {
    const lane = await committing("remote-branch");
    const publication = publishHarness(lane.h);
    publishers.push({ ...lane, publication, exec: lane.h.ports.exec });
  }
  const { h, lane } = await committing();
  lane.delivery = undefined;
  lane.state = "paused";
  const records = () => [...publishers.map(publisher => publisher.lane), lane];
  savePipelines(records());
  const release = latch(), entered = latch();
  const localExec = h.ports.exec, pushes = new Map<string, number>();
  let active = 0, maximum = 0;
  h.ports.exec = async (command, args, cwd, env, options) => {
    const publisher = publishers.find(row => row.lane.worktreeDir === cwd);
    if (publisher) {
      // Each fixture port must answer for its own checkout; the shared store
      // also contains its siblings and cannot supply a positional branch.
      if (args[0] === "branch" && args[1] === "--show-current")
        return { code: 0, stdout: publisher.lane.branch + "\n", stderr: "" };
      if (args[0] === "symbolic-ref")
        return { code: 0, stdout: `refs/heads/${publisher.lane.branch}\n`, stderr: "" };
      if (args[0] === "ls-remote") return { code: 0, stdout: publisher.publication.remote()
        ? `${publisher.publication.remote()}\trefs/heads/${publisher.lane.branch}\n` : "", stderr: "" };
      if (args[0] === "push") {
        pushes.set(publisher.lane.id, (pushes.get(publisher.lane.id) ?? 0) + 1);
        maximum = Math.max(maximum, ++active);
        if (active === 4) entered.resolve();
        try { await release.promise; } finally { active--; }
      }
      return publisher.exec(command, args, cwd, env, options);
    }
    if (cwd === lane.worktreeDir && args[0] === "branch" && args[1] === "--show-current")
      return { code: 0, stdout: lane.branch + "\n", stderr: "" };
    if (cwd === lane.worktreeDir && args[0] === "symbolic-ref")
      return { code: 0, stdout: `refs/heads/${lane.branch}\n`, stderr: "" };
    return localExec(command, args, cwd, env, options);
  };
  try {
    await tickPipelinesController([], h.ports);
    await until(entered.promise, 10_000);
    const current = loadPipelines();
    current.find(row => row.id === lane.id)!.state = "running";
    savePipelines(current);
    await tickPipelinesController([], h.ports);
    await withControllerPipelineScope([lane.id], async () => {
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => { clearInterval(check); reject(new Error("independent settlement was starved")); }, 5000);
        const check = setInterval(() => {
          if (loadPipelines().find(row => row.id === lane.id)!.runs[0]!.attempts[0]!.state === "passed") {
            clearInterval(check); clearTimeout(deadline); resolve();
          }
        }, 10);
      });
    });
    expect(loadPipelines().find(row => row.id === lane.id)!.lastPassedCommit).toBe(lane.lastPassedCommit);
    expect(active).toBe(4);
    expect(maximum).toBe(4);
  } finally { release.resolve(); await settlePipelineControllerJobs(); }
  expect([...pushes.values()]).toEqual([1, 1, 1, 1]);
  for (const publisher of publishers) expect(loadPipelines().find(row => row.id === publisher.lane.id)!.delivery!.operation!.result?.ok).toBe(true);
}), 60_000);

test("settlement admission retries three timed out windows before parking the preserved pass", async () => {
  const release = latch();
  const { h, lane } = await committing();
  let now = Date.parse(h.ports.now());
  h.ports.now = () => new Date(now).toISOString();
  try {
    for (let n = 0; n < 4; n++) expect(startPipelineControllerJob(`held-settlement-${n}`,
      () => release.promise, async () => "unchanged")).toBe(true);
    await tickPipelinesController([], h.ports);
    for (const delay of [0, 60_000, 5 * 60_000, 15 * 60_000]) {
      now += 15 * 60_000 + delay;
      await tickPipelinesController([], h.ports);
      const current = loadPipelines()[0]!;
      expect(current.lastPassedCommit).toBe(lane.lastPassedCommit);
      expect(current.runs[0]!.attempts[0]!.verdict?.status).toBe("pass");
      expect(current.state).toBe(delay === 15 * 60_000 ? "needs_decision" : "running");
    }
    expect(loadPipelines()[0]!.stateDetail).toContain("after 3 automatic retries");
  } finally { release.resolve(); await settlePipelineControllerJobs(); }
});

test.each(["settles", "exhausts", "publish", "publish-head"] as const)("publication capacity retries retain the reservation: %s", async outcome => {
  const exhausted = outcome !== "settles";
  const { h, lane } = await committing("remote-branch");
  const publication = publishHarness(h);
  let now = Date.parse(h.ports.now());
  h.ports.now = () => new Date(now).toISOString();
  const release = latch();
  const observed = async (predicate: () => boolean) => {
    let timer: ReturnType<typeof setTimeout> | undefined, poll: ReturnType<typeof setInterval> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("publication admission did not settle")), 5000);
        poll = setInterval(() => { if (predicate()) resolve(); }, 10);
      });
    } finally { clearTimeout(timer); clearInterval(poll); }
  };
  const current = () => loadPipelines().find(row => row.id === lane.id)!;
  try {
    for (let n = 0; n < 4; n++) expect(startPipelineControllerJob(`held-publication-${n}`,
      () => release.promise, async () => "unchanged", "publication")).toBe(true);
    await tickPipelinesController([], h.ports);
    await observed(() => current().runs[0]!.attempts[0]!.settlementAdmissionRetry?.failures === 0);
    const reservation = current().delivery!.operation!.id;
    for (const [n, delay] of [0, 60_000, 5 * 60_000].entries()) {
      now += 15 * 60_000 + delay;
      await tickPipelinesController([], h.ports);
      await observed(() => current().runs[0]!.attempts[0]!.settlementAdmissionRetry?.failures === n + 1);
      expect(current().lastPassedCommit).toBe(publication.passedSha);
      expect(current().delivery!.operation!.id).toBe(reservation);
      expect(current().state).toBe("running");
    }
    now += exhausted ? 30 * 60_000 : 15 * 60_000;
    if (!exhausted) { release.resolve(); await settlePipelineControllerJobs(); }
    await tickPipelinesController([], h.ports);
    await observed(() => exhausted ? current().state === "needs_decision" : current().delivery?.operation?.result?.ok === true);
    if (exhausted) expect(current().stateDetail).toContain("after 3 automatic retries");
    expect(h.spawnInputs).toHaveLength(1);
  } finally { release.resolve(); await settlePipelineControllerJobs(); }
  if (exhausted) {
    now += 24 * 60 * 60_000;
    await tickPipelinesController([], h.ports); await settlePipelineControllerJobs();
    expect(current().state).toBe("needs_decision");
    const manualRelease = latch();
    try {
      for (let n = 0; n < 4; n++) expect(startPipelineControllerJob(`manual-publication-${n}`,
        () => manualRelease.promise, async () => "unchanged", "publication")).toBe(true);
      const request = outcome === "publish" ? { action: "publish" as const }
        : outcome === "publish-head" ? { action: "publish" as const, acceptedSha: publication.passedSha }
          : { action: "retry-stage" as const };
      expect((await engineModule.patchPipeline(lane.id, request, h.ports)).error).toBeUndefined();
      await tickPipelinesController([], h.ports);
      await observed(() => current().runs[0]!.attempts[0]!.settlementAdmissionRetry?.failures === 0);
      expect(current().state).toBe("running");
      expect(current().lastPassedCommit).toBe(publication.passedSha);
    } finally { manualRelease.resolve(); await settlePipelineControllerJobs(); }
    await tickPipelinesController([], h.ports); await settlePipelineControllerJobs();
    await observed(() => current().delivery?.operation?.result?.ok === true);
    expect(h.spawnInputs).toHaveLength(1);
  }
});

test("observing an unchanged external job does not request another immediate tick", async () => {
  await settlePipelineControllerJobs();
  await new Promise(resolve => setImmediate(resolve));
  takePipelineControllerJobChanges();
  let wakes = 0, version = "one";
  const unregister = registerPipelineTick(async () => { wakes++; });
  try {
    startPipelineControllerJob("observed-job", async () => ({ ok: true, remote: "unreachable" }), async () => version);
    await settlePipelineControllerJobs();
    expect(wakes).toBe(0);
    expect(takePipelineControllerJobChanges()).toBe(false);
    startPipelineControllerJob("changed-job", async () => { version = "two"; }, async () => version);
    await settlePipelineControllerJobs();
    expect(wakes).toBe(1);
    expect(takePipelineControllerJobChanges()).toBe(true);
  } finally { unregister(); }
});

async function until(promise: Promise<unknown>, timeout = 3_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("boundary did not settle")), timeout); })]); }
  finally { clearTimeout(timer); }
}

test("the real controller returns while a 20 second fenced Git job remains pending, without a second writer", async () => {
  const { h, lane } = await committing();
  const entered = latch(), release = latch();
  const exec = h.ports.exec;
  let executions = 0;
  h.ports.exec = async (command, args, cwd, env, options) => {
    if (options?.inheritFd !== undefined && executions++ === 0) { entered.resolve(); await release.promise; }
    return exec(command, args, cwd, env, options);
  };
  const heartbeats: FlowPipelineControllerHeartbeat[] = [];
  const controller = new FlowPipelineController({
    tickPipelines: files => tickPipelinesController(files, h.ports),
    now: () => 0, scan: async () => ({ files: [], complete: false }), publishHeartbeat: value => heartbeats.push(value), log: () => {},
  }, { maxPasses: 1 });
  const started = performance.now();
  try {
    await until(controller.tick(), 10_000);
    await until(entered.promise);
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(pipelineControllerJobLanes()).toEqual([lane.id]);
    await until(controller.poll());
    expect(heartbeats.filter(row => row.phase === "pipelines").map(row => row.state)).toEqual(["running", "completed", "running", "completed"]);
    expect(executions).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 20_000));
    expect(pipelineControllerJobLanes()).toEqual([lane.id]);
    expect(loadPipelines()[0]!.cursor!.state).toBe("committing");
    const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"), { readonly: true });
    try { expect(db.query("SELECT count(*) AS n FROM state_leases").get()).toEqual({ n: 0 }); }
    finally { db.close(); }
  } finally { release.resolve(); await settlePipelineControllerJobs(); }
  expect(pipelineControllerJobLanes()).toEqual([]);
}, 60_000);

test.each(["branch", "repository", "claim", "release", "remove", "archive", "progress", "raw-owner", "raw-peer"] as const)("a %s peer change retains stage-job authority fences", async change => {
  const { h, lane } = await committing();
  const peer = structuredClone(lane);
  peer.id = "controller-peer";
  Object.assign(peer, pipelineIdentity(peer.id, peer.task, peer.repoDir));
  peer.state = "closed"; peer.closedAt = h.ports.now(); peer.cursor = null;
  peer.delivery = undefined; peer.publication = "internal"; peer.runs = peer.runs.map(run => ({ ...run, attempts: [] }));
  if (change === "release") { peer.state = "paused"; peer.closedAt = null; }
  savePipelines([lane, peer]);
  const entered = latch(), release = latch();
  let signal: AbortSignal | undefined, held = false;
  const exec = h.ports.exec;
  h.ports.exec = async (command, args, cwd, env, options) => {
    if (!held && options?.inheritFd !== undefined) { held = true; signal = options.signal; entered.resolve(); await release.promise; }
    return exec(command, args, cwd, env, options);
  };
  try {
    await until(tickPipelinesController([], h.ports));
    await until(entered.promise);
    const rows = loadPipelines(), updated = rows.find(row => row.id === peer.id)!;
    if (change === "branch") { updated.task += " changed"; Object.assign(updated, pipelineIdentity(updated.id, updated.task, updated.repoDir)); }
    if (change === "repository") { updated.repoDir += "/changed"; Object.assign(updated, pipelineIdentity(updated.id, updated.task, updated.repoDir)); }
    if (change === "claim") { updated.state = "paused"; updated.closedAt = null; }
    if (change === "release") { updated.state = "closed"; updated.closedAt = h.ports.now(); }
    if (change === "progress") updated.stateDetail = "peer progress";
    savePipelines(change === "remove" ? rows.filter(row => row.id !== peer.id) : rows);
    if (change === "raw-owner" || change === "raw-peer") {
      const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"));
      try {
        const row = change === "raw-owner" ? rows.find(row => row.id === lane.id)! : updated;
        if (change === "raw-owner") row.stateDetail = "concurrent raw edit";
        else { row.task += " raw branch"; Object.assign(row, pipelineIdentity(row.id, row.task, row.repoDir)); }
        // Keep the collection and row revision unchanged, as an older SQL writer can.
        db.query("UPDATE state_rows SET value_json=? WHERE collection='pipelines' AND row_key=?").run(JSON.stringify(row), row.id);
      } finally { db.close(); }
    }
    if (change === "archive") expect(await archiveSettledPipelines(Date.parse(h.ports.now()) + 4 * 24 * 60 * 60 * 1000)).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(signal?.aborted).toBe(change !== "progress");
    await until(tickPipelinesController([], h.ports));
    expect(pipelineControllerJobLanes()).toContain(lane.id);
  } finally { release.resolve(); await settlePipelineControllerJobs(); }
});

test("a long commit hook is owned beyond phase completion and keeps its inherited lock descriptor", async () => {
  const { h, lane } = await committing();
  const publication = publishHarness(h);
  const entered = latch(), release = latch();
  const exec = h.ports.exec;
  let inherited = false;
  h.ports.exec = async (command, args, cwd, env, options) => {
    if (args[0] === "commit") { inherited = options?.inheritFd !== undefined; entered.resolve(); await release.promise; }
    return exec(command, args, cwd, env, options);
  };
  try {
    await until(tickPipelinesController([], h.ports));
    await until(entered.promise);
    expect(pipelineControllerJobLanes()).toEqual([lane.id]);
    await until(tickPipelinesController([], h.ports));
    expect(publication.order).toEqual([]);
    expect(inherited).toBe(true);
  } finally { release.resolve(); await settlePipelineControllerJobs(); }
  expect(publication.order.filter(value => value === "commit")).toHaveLength(1);
});

test.each(["refused", "interrupted", "uncertain"] as const)("a %s publication job retains its accepted head and original outcome custody", async outcome => {
  const { h, lane } = await committing("remote-branch");
  const publication = publishHarness(h, { pushFails: outcome === "refused" });
  const exec = h.ports.exec;
  let pushes = 0;
  h.ports.exec = async (command, args, cwd, env, options) => {
    if (args[0] === "push") {
      pushes++;
      if (outcome === "interrupted") return { code: null, stdout: "", stderr: "command cancelled" };
      if (outcome === "uncertain") { await exec(command, args, cwd, env, options); throw new Error("lost push reply"); }
    }
    return exec(command, args, cwd, env, options);
  };
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    await tickPipelinesController([], h.ports); await settlePipelineControllerJobs();
    const recorded = loadPipelines()[0]!;
    expect(recorded.lastPassedCommit).toBe(publication.passedSha);
    expect(pushes).toBe(1);
    expect(recorded.runs[0]!.attempts[0]!.launchId).toBe(lane.runs[0]!.attempts[0]!.launchId);
    expect(recorded.delivery!.operation!.sha).toBe(publication.passedSha);
    if (outcome === "refused") {
      await tickPipelinesController([], h.ports); await settlePipelineControllerJobs();
      expect(loadPipelines()[0]!.state).toBe("needs_decision");
      expect(loadPipelines()[0]!.stateDetail).toContain("shallow update not allowed");
    } else {
      const operation = recorded.delivery!.operation!.id;
      publication.setRemoteReadFails(true);
      await tickPipelinesController([], h.ports); await settlePipelineControllerJobs();
      expect(loadPipelines()[0]!.delivery!.operation!.id).toBe(operation);
      expect(pushes).toBe(1);
      expect(loadPipelines()[0]!.publishedCommit ?? null).toBeNull();
      if (outcome === "uncertain") {
        publication.setRemoteReadFails(false);
        await tickPipelinesController([], h.ports); await settlePipelineControllerJobs();
        expect(pushes).toBe(1);
        expect(loadPipelines()[0]!.delivery!.operation!.result).toMatchObject({ ok: true, remote: "published" });
      }
    }
  } finally { errors.mockRestore(); await settlePipelineControllerJobs(); }
});

test("the fair queue bounds many dirty lanes, retains peer writes across acknowledgment and survives recreation", async () => {
  const { h, lane } = await committing();
  lane.state = "paused";
  const rows = Array.from({ length: 20 }, (_, n) => {
    const row = structuredClone(lane); row.id = `queued-${n}`;
    Object.assign(row, pipelineIdentity(row.id, row.task, row.repoDir)); row.delivery = undefined; row.publication = "internal"; return row;
  });
  savePipelines(rows);
  const first = await selectPipelineControllerWork(0, []);
  expect(first).toHaveLength(4);
  const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"));
  try {
    db.query("UPDATE state_rows SET value_json=json_set(value_json,'$.stateDetail','peer update') WHERE collection='pipelines' AND row_key=?").run(first[0]!.row_key);
    await acknowledgePipelineControllerWork(first[0]!, 16, 1_000);
    expect(db.query<{ dirty: number }, [string]>("SELECT dirty FROM pipeline_tick_work WHERE row_key=?").get(first[0]!.row_key)!.dirty).toBe(1);
    const observed = new Set<string>();
    for (let n = 0; n < 12; n++) {
      const work = await selectPipelineControllerWork(0, []);
      expect(work.length).toBeLessThanOrEqual(4);
      for (const item of work) { observed.add(item.row_key); await acknowledgePipelineControllerWork(item, 0, 1_000); }
    }
    expect(observed.size).toBe(20);
    const due = await selectPipelineControllerWork(1_001, []);
    expect(due.length).toBeGreaterThan(0);
    expect(due.length).toBeLessThanOrEqual(4);
  } finally { db.close(); }
});

test("bounded controller phases finish dirty parked and closed obligations in the full engine's per-lane order", async () => {
  const { h, lane } = await committing();
  const now = h.ports.now(); h.ports.now = () => now;
  const rows = Array.from({ length: 20 }, (_, index) => {
    const row = structuredClone(lane); row.id = `obligation-${index}`;
    Object.assign(row, pipelineIdentity(row.id, row.task, row.repoDir));
    row.state = index % 2 ? "paused" : "closed";
    row.closedAt = row.state === "closed" ? now : null;
    row.cursor = null;
    row.runs = row.runs.map(run => ({ ...run, attempts: [] }));
    row.delivery = undefined; row.publication = "internal";
    row.unconfirmedHosts = [{ stageId: "build", attempt: 1, conversationId: row.id, agentPath: null, paneId: row.id,
      operationId: null, detail: "host disappearance is pending", at: now }];
    return row;
  });
  const operations: string[] = [];
  h.ports.stageHostResident = async target => { operations.push(`resident:${target.conversationId}`); return false; };
  h.ports.paneAgentAlive = async pane => { operations.push(`pane:${pane}`); return false; };
  savePipelines(rows);
  await tickPipelines([], h.ports);
  const expected = loadPipelines(), expectedOperations = operations.splice(0);
  savePipelines(rows);
  for (let phase = 0; phase < 20 && operations.length < expectedOperations.length; phase++) {
    const before = operations.length;
    await tickPipelinesController([], h.ports);
    expect(operations.length - before).toBeLessThanOrEqual(8);
  }
  expect(loadPipelines()).toEqual(expected);
  expect([...operations].sort()).toEqual([...expectedOperations].sort());
  // Fairness can interleave lanes. Each lane retains its own effect order.
  for (const row of rows) expect(operations.filter(operation => operation.endsWith(`:${row.id}`)))
    .toEqual(expectedOperations.filter(operation => operation.endsWith(`:${row.id}`)));
});

test("selectors share immutable candidates across kinds by revision and detach mutations", async () => {
  const { lane } = await committing();
  const first = await selectControllerPipelines("hosts"), second = await selectControllerPipelines("hosts");
  expect(first[0]).toBe(second[0]);
  expect((await selectControllerPipelines("running"))[0]).toBe(first[0]);
  expect(Object.isFrozen(first[0]!.runs[0]!.attempts[0])).toBe(true);
  await withPipelineMutation(async (rows, persist) => { rows[0]!.stateDetail = "changed"; await persist([rows[0]!]); });
  expect(first[0]!.stateDetail).not.toBe("changed");
  const third = await selectControllerPipelines("hosts");
  expect(third[0]).not.toBe(first[0]);
  expect(third[0]!.id).toBe(lane.id);
  expect(third[0]!.stateDetail).toBe("changed");
  await withPipelineMutation(async (rows, persist) => { rows[0]!.pendingReviewFlowCleanup = ["retained-flow"]; await persist([rows[0]!]); });
  const cleanup = await selectControllerPipelines("cleanup");
  cleanup[0]!.pendingReviewFlowCleanup!.push("discarded-edit");
  expect((await selectControllerPipelines("cleanup"))[0]!.pendingReviewFlowCleanup).toEqual(["retained-flow"]);
});

test.each(["alias", "unknown-common-directory"] as const)("the controller preserves full-engine decisions and command ordering for a %s branch claim", async shape => {
  const { h, lane } = await committing();
  const peer = structuredClone(lane);
  peer.id = "branch-owner";
  peer.repoDir = path.join(lane.repoDir, "alias");
  Object.assign(peer, pipelineIdentity(peer.id, peer.task, peer.repoDir));
  peer.state = "paused";
  peer.cursor = null;
  peer.runs = peer.runs.map(run => ({ ...run, attempts: [] }));
  peer.delivery = undefined;
  peer.publication = "internal";
  const now = h.ports.now(); h.ports.now = () => now;
  const execute = h.ports.exec;
  const commands: string[] = [];
  h.ports.exec = async (command, args, cwd, env, options) => {
    commands.push(JSON.stringify([command, args, cwd]));
    if (args[0] === "branch" && args[1] === "--show-current") return { code: 0, stdout: `${peer.branch}\n`, stderr: "" };
    if (args.includes("--git-common-dir")) return shape === "unknown-common-directory" && cwd !== lane.worktreeDir && cwd !== lane.repoDir
      ? { code: 1, stdout: "", stderr: "common directory unavailable" }
      : { code: 0, stdout: "/fixture/shared.git\n", stderr: "" };
    return execute(command, args, cwd, env, options);
  };
  savePipelines([lane, peer]);
  await tickPipelines([], h.ports);
  const expected = loadPipelines(), expectedCommands = commands.splice(0);
  expect(expected[0]!.stateDetail).toContain("another pipeline owns the stage branch");
  savePipelines([lane, peer]);
  await tickPipelinesController([], h.ports);
  await settlePipelineControllerJobs();
  expect(loadPipelines()).toEqual(expected);
  expect(commands).toEqual(expectedCommands);
});

test.each([0, 1000])("the internal phase never builds a full returned snapshot with %s settled peers", async history => {
  const { h, lane } = await committing();
  lane.state = "paused";
  const peers = Array.from({ length: history }, (_, n) => {
    const peer = structuredClone(lane); peer.id = `settled-${n}`;
    Object.assign(peer, pipelineIdentity(peer.id, peer.task, peer.repoDir));
    peer.state = "closed"; peer.closedAt = h.ports.now(); peer.cursor = null; peer.runs = peer.runs.map(run => ({ ...run, attempts: Array.from({ length: 8 }, (_, index) => ({ ...structuredClone(run.attempts[0]!), n: index + 1,
      accounting: { ...run.attempts[0]!.accounting!, repeatReason: index ? "unknown" as const : null },
      state: "failed", launchId: null, verdict: { status: "fail" }, completedAt: peer.closedAt, output: "retained evidence ".repeat(256) })) })); peer.delivery = undefined; peer.publication = "internal";
    peer.terminalReap = { rounds: 1, stopped: 0, lastAt: peer.closedAt!, settledAt: peer.closedAt!,
      settledAttempts: peer.runs.flatMap(run => run.attempts.map(attempt => `${run.stageId}:${attempt.n}`)) };
    return peer;
  });
  savePipelines([lane, ...peers]);
  const snapshots = spyOn(SqliteStateCollection.prototype, "snapshotAsync");
  try {
    await tickPipelinesController([], h.ports);
    expect(snapshots.mock.calls).toHaveLength(0);
    expect(await selectPipelineControllerWork(0, [])).toHaveLength(1);
    if (process.env.LLV_CONTROLLER_SCALE_EVIDENCE) {
      const samples = [];
      for (let sample = 0; sample < 3; sample++) for (const mode of ["legacy", "candidate"] as const) {
        performanceSpans.clear();
        const io = () => {
          const fields = fs.readFileSync(`/proc/self/task/${process.pid}/stat`, "utf8").split(") ")[1]!.split(" ");
          const reads = fs.readFileSync(`/proc/self/task/${process.pid}/io`, "utf8");
          return { ticks: Number(fields[11]) + Number(fields[12]), rchar: Number(reads.match(/^rchar: (\d+)/m)![1]) };
        };
        const before = io(), started = performance.now();
        let lastTimer = started, maxTimerGapMs = 0;
        const timer = setInterval(() => {
          const now = performance.now(); maxTimerGapMs = Math.max(maxTimerGapMs, now - lastTimer - 10); lastTimer = now;
        }, 10);
        let wallMs: number;
        try {
          if (mode === "legacy") await tickPipelines([], h.ports); else await tickPipelinesController([], h.ports);
          wallMs = performance.now() - started;
          await new Promise(resolve => setTimeout(resolve, 20));
        } finally { clearInterval(timer); }
        const after = io(), mainThreadTicks = after.ticks - before.ticks;
        const spans = performanceSpans.snapshot().records.filter(row => row.kind === "sync");
        samples.push({ sample, mode, wallMs, mainThreadTicks, rchar: after.rchar - before.rchar, maxTimerGapMs,
          copiedRows: spans.filter(row => performanceSites[row.site] === "pipeline.copy").reduce((sum, row) => sum + row.rows, 0),
          maxSliceMs: Math.max(0, ...spans.map(row => row.maxMs)) });
      }
      fs.appendFileSync(process.env.LLV_CONTROLLER_SCALE_EVIDENCE, JSON.stringify({ retainedPeers: history, attemptsPerPeer: 8, samples }) + "\n");
    }
  } finally { snapshots.mockRestore(); await settlePipelineControllerJobs(); }
}, 20_000);

test("a paused lane rotates a bounded historical-attempt window and preserves its current attempt", async () => {
  const { h, lane } = await committing();
  lane.state = "paused";
  const current = lane.runs[0]!.attempts[0]!;
  current.state = "running"; current.verdict = null; current.n = 34;
  current.accounting!.repeatReason = "unknown";
  const history = Array.from({ length: 33 }, (_, index) => ({ ...structuredClone(current), n: index + 1, historical: true,
    accounting: { ...current.accounting!, repeatReason: index ? "unknown" as const : null },
    conversationId: `historical-${index}`, agentPath: `/codex/history-${index}.jsonl`, launchId: null, paneId: null }));
  lane.runs[0]!.attempts = [...history, current];
  savePipelines([lane]);
  const observed = new Set<string>();
  let reads: string[] = [];
  h.ports.durableTurnEvidence = async (_engine, pathname) => { reads.push(pathname); observed.add(pathname); return null; };
  for (let round = 0; round < 3; round++) {
    reads = [];
    await tickPipelinesController([], h.ports);
    expect(reads.length).toBeLessThanOrEqual(16);
    expect(loadPipelines()[0]!.state).toBe("paused");
  }
  expect(observed.size).toBe(33);
  expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.n).toBe(34);
});

test("a large completed lane reaps at most sixteen hosts per phase and reaches the old engine's result", async () => {
  const { h, lane } = await committing();
  const fixedNow = h.ports.now(); h.ports.now = () => fixedNow;
  lane.state = "completed"; lane.cursor = null;
  const original = lane.runs[0]!.attempts[0]!;
  lane.runs[0]!.attempts = Array.from({ length: 65 }, (_, index) => ({ ...structuredClone(original), n: index + 1,
    accounting: { ...original.accounting!, repeatReason: index ? "unknown" as const : null },
    state: "passed", completedAt: h.ports.now(), conversationId: `finished-${index}`, agentPath: `/codex/finished-${index}.jsonl`,
    paneId: null, launchId: null }));
  let probes = 0;
  h.ports.stageHostResident = async () => { probes++; return false; };
  savePipelines([lane]);
  await tickPipelines([], h.ports);
  const expected = loadPipelines()[0]!;
  savePipelines([lane]);
  for (let round = 0; round < 5; round++) {
    probes = 0;
    await tickPipelinesController([], h.ports);
    expect(probes).toBeLessThanOrEqual(16);
  }
  expect(loadPipelines()[0]).toEqual(expected);
  expect(await selectPipelineControllerWork(0, [])).toEqual([]);
});

test("a peer-held SQLite writer yields while a schedule acknowledgment waits", async () => {
  const { h } = await committing();
  const [item] = await selectPipelineControllerWork(0, []);
  const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"));
  db.exec("BEGIN IMMEDIATE");
  let timers = 0, finished = false;
  const timer = setInterval(() => { timers++; }, 2);
  const waiting = acknowledgePipelineControllerWork(item!, 0, Date.parse(h.ports.now()) + 30_000).then(() => { finished = true; });
  const failures: unknown[] = [];
  void waiting.catch(error => failures.push(error));
  try {
    // WAL reads must keep answering while the peer owns the writer. The
    // acknowledgment waits asynchronously under the same contention.
    expect((await findControllerPipeline(item!.row_key))?.id).toBe(item!.row_key);
    expect(await controllerPipelineVersion(item!.row_key)).toContain(":");
    expect(await selectPipelineControllerWork(0, [])).toHaveLength(1);
    expect(await pipelineControllerReady(0, [])).toBe(true);
    expect((await controllerAttemptWindow(item!.row_key, -1, "build")).window).toHaveLength(1);
    expect(await controllerOtherTerminalHosts(item!.row_key, [])).toBe(true);
    expect(await controllerHostHasLiveWork({ stageId: "build", attempt: 1, conversationId: null, agentPath: null, paneId: "missing" })).toBe(false);
    expect(await controllerFlowAttached("missing")).toBe(false);
    expect(await withControllerPipelineScope([item!.row_key],() => controllerUnclaimedPublications())).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(timers).toBeGreaterThan(3);
    expect(finished).toBe(false);
  } finally { db.exec("COMMIT"); clearInterval(timer); await waiting; db.close(); }
  expect(failures).toEqual([]);
});

test("a bounded reconciliation preserves another lane's CPU ticket and FIFO age", async () => {
  const { lane } = await committing();
  const file = instanceCpuAdmissionFile();
  expect(file.startsWith(`${path.dirname(process.env.XDG_CONFIG_HOME!)}${path.sep}`)).toBe(true);
  const queue = instanceCpuAdmissionQueue();
  const prefix = `stage:${crypto.createHash("sha256").update(stateDir()).digest("hex")}:`;
  const peer = `${prefix}unselected-peer:build:1`;
  queue.check(peer, false);
  const db = new Database(file, { readonly: true });
  try {
    const before = db.query("SELECT seq,since FROM tickets WHERE key=?").get(peer);
    const ports = defaultPipelinePorts();
    await withControllerPipelineScope([lane.id], async () => { await ports.cpuAdmissionReconcile?.(ports); });
    expect(db.query("SELECT seq,since FROM tickets WHERE key=?").get(peer)).toEqual(before);
    expect(before).not.toBeNull();
  } finally { db.close(); queue.cancel(peer); }
});

test("a Viewer restart during a real push retains child custody and reconciles its outcome without another push", async () => {
  const box = await realWorktreeLane("controller-job-restart", BUILD_ONLY, "remote-branch");
  const lane = loadPipelines()[0]!;
  lane.cursor!.state = "committing";
  Object.assign(lane.runs[0]!.attempts[0]!, { state: "committing", verdict: { status: "pass" } });
  savePipelines([lane]);
  fs.writeFileSync(path.join(box.worktree, "change.txt"), "accepted stage work\n");
  const hooks = path.join(box.root, "hooks"); fs.mkdirSync(hooks);
  const entered = path.join(box.root, "push-entered"), release = path.join(box.root, "push-release");
  const count = path.join(box.root, "push-count");
  // Arguments are passed as Git configuration, so the hook needs no embedded path.
  fs.writeFileSync(path.join(hooks, "pre-push"), `#!/bin/sh
test_root=$(git config fixture.root)
printf '%s\\n' "$PPID" >> "$test_root/push-count"
touch "$test_root/push-entered"
while [ ! -e "$test_root/push-release" ]; do sleep 0.02; done
`, { mode: 0o700 });
  await box.git(box.worktree, "config", "core.hooksPath", hooks);
  await box.git(box.worktree, "config", "fixture.root", box.root);
  const children: ReturnType<typeof spawn>[] = [];
  const start = () => {
    const env: NodeJS.ProcessEnv = { ...process.env, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" };
    for (const key of Object.keys(env)) if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(key)) delete env[key];
    const child = spawn(process.execPath, [path.resolve("src/lib/pipelines/fixtures/controllerJobResume.ts")], {
      cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let output = "";
    child.stdout!.on("data", chunk => { output += chunk; }); child.stderr!.on("data", chunk => { output += chunk; });
    const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", code => code === 0 ? resolve() : reject(new Error(`recovery child ${code}: ${output}`))); });
    void exited.catch(() => {});
    return { child, exited, output: () => output };
  };
  let gitPid: number | undefined;
  try {
    const first = start();
    await until((async () => { while (!fs.existsSync(entered)) {
      if (first.child.exitCode !== null) { await first.exited; throw new Error(`push hook was not reached: ${first.output()}; ${loadPipelines()[0]?.stateDetail}`); }
      await new Promise(resolve => setTimeout(resolve, 10));
    } })(), 15_000);
    gitPid = Number(fs.readFileSync(count, "utf8").trim());
    expect(gitPid).toBeGreaterThan(1);
    // Only the recorded fixture Viewer dies; its detached Git child keeps the lock.
    first.child.kill("SIGKILL");
    await new Promise(resolve => first.child.once("exit", resolve));
    const second = start(); await until(second.exited, 10_000);
    expect(fs.readFileSync(count, "utf8").trim().split("\n")).toHaveLength(1);
    fs.writeFileSync(release, "release\n");
    await until((async () => {
      for (;;) {
        const head = await box.git(box.repo, "ls-remote", "origin", `refs/heads/${lane.branch}`);
        if (head.startsWith((await box.git(box.worktree, "rev-parse", "HEAD")))) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    })(), 10_000);
    const third = start(); await until(third.exited, 10_000);
    expect(fs.readFileSync(count, "utf8").trim().split("\n")).toHaveLength(1);
    const recovered = loadPipelines()[0]!;
    expect(recovered.delivery!.operation!.state).toBe("settled");
    expect(recovered.delivery!.operation!.result).toMatchObject({ ok: true, remote: "published" });
  } finally {
    fs.writeFileSync(release, "release\n");
    for (const child of children) await stopFixtureProcess(child);
    if (gitPid) await until((async () => { while (fs.existsSync(`/proc/${gitPid}`)) {
      const state = fs.readFileSync(`/proc/${gitPid}/stat`, "utf8").split(") ")[1]?.[0];
      if (state === "Z") return;
      await new Promise(resolve => setTimeout(resolve, 10));
    } })(), 5_000);
    fs.rmSync(box.root, { recursive: true, force: true });
  }
}, 50_000);


test("continuation failures cannot starve later cancellation or host teardown across restart", async () => {
  const { h, lane } = await committing();
  const original = lane.runs[0]!.attempts[0]!;
  lane.runs[0]!.attempts = Array.from({ length: 17 }, (_, index) => ({ ...structuredClone(original), n: index + 1,
    accounting: { ...original.accounting!, repeatReason: index ? "unknown" as const : null },
    conversationId: `close-${index}`, launchId: null, paneId: null, agentPath: null, state: "running", verdict: null, completedAt: null }));
  lane.state = "closed"; lane.closedAt = h.ports.now(); lane.cursor = null;
  const pending = lane.runs[0]!.attempts.map(attempt => ({ stageId: "build", attempt: attempt.n,
    conversationId: attempt.conversationId!, agentPath: null, paneId: null, launchId: null }));
  lane.closeTeardown = { id: "fair-cancellation", phase: "pending", waitingForActivation: false, acknowledgeHosts: false, flow: null };
  lane.closeReport = { pending: structuredClone(pending), pendingContinuations: structuredClone(pending), status: "pending",
    stopped: [], alreadyStopped: [], unconfirmed: [], reviewers: [], acknowledged: [], stillRunning: [], notes: [], worktree: null };
  savePipelines([lane]);
  const cancellations = new Set<string>(), stops = new Set<string>();
  let actions = 0;
  h.ports.invalidateProviderContinuation = async id => { actions++; cancellations.add(id); if (id !== "close-16") throw new Error("temporary refusal"); };
  h.ports.stopStageAgent = async target => { actions++; stops.add(target.conversationId!); return { outcome: "stopped" }; };
  const closeLog = path.join(process.env.LLV_STATE_DIR!, "close-restart.log");
  for (let phase = 0; phase < 10; phase++) {
    actions = 0; await tickPipelinesController([], h.ports);
    expect(actions).toBeLessThanOrEqual(16);
    // A fresh process continues the persisted retry order and cursor.
    if (phase === 0) {
      const child = spawn(process.execPath, [path.resolve("src/lib/pipelines/fixtures/controllerJobResume.ts")], {
        cwd: process.cwd(), env: { ...process.env, LLV_CONTROLLER_CLOSE_LOG: closeLog }, stdio: ["ignore","pipe","pipe"],
      });
      let output = ""; child.stderr!.on("data", chunk => { output += chunk; });
      try { await until(new Promise<void>((resolve,reject) => {
        child.once("error",reject); child.once("close", code => code === 0 ? resolve() : reject(new Error(output)));
      }), 10_000); } finally { await stopFixtureProcess(child); }
      const childActions = fs.readFileSync(closeLog,"utf8").trim().split("\n");
      expect(childActions.length).toBeLessThanOrEqual(16);
      for (const action of childActions) {
        if (action.startsWith("cancel:")) cancellations.add(action.slice(7));
        else if (action.startsWith("stop:")) stops.add(action.slice(5));
      }
    }
  }
  expect(cancellations.size).toBe(17); expect(stops.size).toBe(17);
  const report = loadPipelines()[0]!.closeReport!;
  expect(report.pending).toEqual([]);
  expect(report.pendingContinuations).toHaveLength(16);
  expect(report.pendingContinuations!.every(item => item.detail?.includes("temporary refusal"))).toBe(true);
  // Ten controller passes and a real child restart must finish before the
  // next fixture resets the shared store. The child alone has a ten-second
  // deadline, beyond Bun's default five-second budget for this whole test.
}, 30_000);

test.each([0,1000])("resident terminal hosts use indexed peer ownership with %s retained peers", async history => {
  const { h, lane } = await committing();
  lane.state = "completed"; lane.cursor = null;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.completedAt = h.ports.now(); attempt.state = "passed";
  const peer = structuredClone(lane); peer.id = "live-peer"; peer.state = "paused"; peer.delivery = undefined;
  Object.assign(peer, pipelineIdentity(peer.id, peer.task, peer.repoDir));
  peer.runs[0]!.attempts[0]!.state = "running";
  peer.runs[0]!.attempts[0]!.flowId = "attached-flow";
  const retained = Array.from({ length: history }, (_, index) => {
    const row = structuredClone(lane); row.id = `ownership-history-${index}`;
    Object.assign(row,pipelineIdentity(row.id,row.task,row.repoDir));
    row.state = "closed"; row.closedAt = h.ports.now();
    row.delivery = undefined; row.runs = row.runs.map(run => ({ ...run, attempts: [] }));
    return row;
  });
  savePipelines([lane, peer, ...retained]);
  h.ports.stageHostResident = async () => true;
  h.ports.conversationAgentActive = async () => false;
  let stopped = 0;
  h.ports.stopStageAgent = async () => { stopped++; return { outcome: "stopped" }; };
  const original = SqliteStateCollection.prototype.loadReadonly;
  const loads = spyOn(SqliteStateCollection.prototype, "loadReadonly").mockImplementation(function(this: SqliteStateCollection<unknown>, ...args) {
    if (new Error().stack?.match(/reconcileTerminalStageHosts/)) throw new Error("whole collection ownership read");
    return original.apply(this, args);
  });
  try {
    await tickPipelinesController([], h.ports);
    expect(stopped).toBe(0);
    expect(await controllerFlowAttached("attached-flow")).toBe(true);
    const rows = loadPipelines(); rows[1]!.runs[0]!.attempts[0]!.state = "passed"; savePipelines(rows);
    await tickPipelinesController([], h.ports);
    expect(stopped).toBe(2);
  } finally { loads.mockRestore(); }
});

test.each([64, 4096])("a closed lane with leftover review-flow cleanup ids keeps eligibility checks bounded with %s unlaunched attempts", async history => {
  const { h, lane } = await committing();
  const original = lane.runs[0]!.attempts[0]!;
  lane.state = "closed"; lane.cursor = null; lane.closedAt = h.ports.now();
  lane.runs[0]!.attempts = Array.from({ length: history }, (_, index) => ({ ...structuredClone(original), n: index + 1,
    accounting: { ...original.accounting!, repeatReason: index ? "unknown" as const : null },
    historical: true, state: "failed", verdict: { status: "fail" }, completedAt: lane.closedAt,
    conversationId: null, agentPath: null, paneId: null, launchId: null }));
  lane.runs[0]!.attempts.push({ ...structuredClone(original), n: history + 1,
    accounting: { ...original.accounting!, repeatReason: "unknown" as const }, historical: true,
    state: "running", verdict: null, completedAt: null, conversationId: "late-host", agentPath: "late-host-transcript", launchId: null });
  for (const attempt of lane.runs[0]!.attempts) delete attempt.activation;
  lane.terminalReap = { rounds: 0, stopped: 0, lastAt: lane.closedAt!, settledAt: null,
    settledAttempts: Array.from({ length: history }, (_, n) => `build:${n + 1}`) };
  lane.pendingReviewFlowCleanup = ["cleanup-flow"];
  savePipelines([lane]);
  const closed: string[] = [];
  h.ports.closeFlow = async id => { closed.push(id); return {}; };
  h.ports.conversationAgentActive = async () => true;
  let visits = 0;
  const some = Array.prototype.some;
  Array.prototype.some = function (predicate, thisArg) {
    const count = this.length > 0 && this[0] && typeof this[0] === "object" && "n" in this[0] && "effectiveRole" in this[0];
    return some.call(this, (value, index, array) => { if (count) visits++; return predicate.call(thisArg, value, index, array); });
  };
  try { await tickPipelinesController([], h.ports); }
  finally { Array.prototype.some = some; }
  expect(closed).toEqual([]);
  expect(visits).toBeLessThanOrEqual(256);
  expect((await selectPipelineControllerWork(Number.MAX_SAFE_INTEGER, [])).some(work => work.row_key === lane.id)).toBe(true);
}, 30_000);

test.each(["paused", "running"] as const)("complete warmed %s phases keep attempt visits and copies bounded as one lane grows", async state => {
  const { h, lane } = await committing();
  const exec = h.ports.exec;
  h.ports.exec = (command, args, ...rest) => {
    // The generic Git stub loads a full snapshot to find this branch. Keep
    // the same reply without counting fixture work as engine materialization.
    if (command === "git" && args[0] === "branch" && args[1] === "--show-current") return { code: 0, stdout: `${lane.branch}\n`, stderr: "" };
    return exec(command, args, ...rest);
  };
  lane.state = state; lane.cursor = state === "running" ? { ...lane.cursor!, state: "running" } : null;
  const original = lane.runs[0]!.attempts[0]!;
  for (const history of [32,4096]) {
    lane.runs[0]!.attempts = Array.from({ length: history }, (_, index) => ({ ...structuredClone(original), n: index + 1,
    accounting: { ...original.accounting!, repeatReason: index ? "unknown" as const : null },
      historical: true, state: "failed", verdict: { status: "fail" }, completedAt: h.ports.now(),
      conversationId: `retained-${index}`, agentPath: `retained-path-${index}`, paneId: null, launchId: null }));
    if (state === "running") lane.runs[0]!.attempts.push({ ...structuredClone(original), n: history + 1,
    accounting: { ...original.accounting!, repeatReason: "unknown" as const },
      state: "running", verdict: null, completedAt: null });
    lane.terminalReap = { rounds:1,stopped:history,lastAt:h.ports.now(),settledAt:h.ports.now(),
      settledAttempts:Array.from({ length:history },(_,n) => `build:${n+1}`) };
    savePipelines([lane]); await tickPipelinesController([], h.ports);
    const samples = [];
    for (let sample = 0; sample < (process.env.LLV_CONTROLLER_FIX_EVIDENCE ? 30 : 3); sample++) {
      // Fix the selected obligations across sizes and samples: the first
      // sixteen history references plus the distinct current running tail.
      const schedule = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"));
      try { schedule.query("UPDATE pipeline_tick_work SET attempt_cursor=0 WHERE row_key=?").run(lane.id); }
      finally { schedule.close(); }
      let visits = 0, copies = 0, maxSliceMs = 0, timerDelayMs = 0;
      const isAttempts = (value: unknown[]) => value.length > 0 && value[0] && typeof value[0] === "object" && "n" in value[0] && "effectiveRole" in value[0];
      const iterator = Array.prototype[Symbol.iterator];
      Array.prototype[Symbol.iterator] = function* () {
        const count = isAttempts(this);
        for (const value of iterator.call(this)) { if (count) visits++; yield value; }
        return undefined;
      };
      const some = Array.prototype.some;
      Array.prototype.some = function (predicate, thisArg) {
        const count = isAttempts(this);
        return some.call(this, (value, index, array) => { if (count) visits++; return predicate.call(thisArg,value,index,array); });
      };
      const clone = globalThis.structuredClone;
      globalThis.structuredClone = (value, options) => {
        if (value && typeof value === "object") {
          if ("runs" in value) { copies += (value as unknown as typeof lane).runs.reduce((n,run) => n+run.attempts.length,0); }
          else if ("n" in value && "effectiveRole" in value) { copies++; }
        }
        return clone(value,options);
      };
      const sync = performanceSpans.sync;
      performanceSpans.sync = ((site,work,rows,bytes) => {
        const at = performance.now();
        try { return sync.call(performanceSpans,site,work,rows,bytes); }
        finally { maxSliceMs = Math.max(maxSliceMs,performance.now()-at); }
      }) as typeof sync;
      const threadTicks = () => {
        if (process.platform !== "linux") return 0;
        const fields = fs.readFileSync(`/proc/self/task/${process.pid}/stat`,"utf8").split(") ")[1]!.split(" ");
        return Number(fields[11])+Number(fields[12]);
      };
      const before = threadTicks(), at = performance.now();
      let last = at;
      const timer = setInterval(() => { const now = performance.now(); timerDelayMs = Math.max(timerDelayMs,now-last-2); last = now; },2);
      try { await tickPipelinesController([],h.ports); await new Promise(resolve => setImmediate(resolve)); }
      finally {
        clearInterval(timer); performanceSpans.sync = sync; globalThis.structuredClone = clone;
        Array.prototype.some = some; Array.prototype[Symbol.iterator] = iterator;
      }
      samples.push({ visits, copies, wallMs: performance.now()-at, mainThreadMs: (threadTicks()-before)*10, maxSliceMs, timerDelayMs });
      expect(visits).toBeLessThanOrEqual(256);
      expect(copies).toBeLessThanOrEqual(128);
    }
    if (process.env.LLV_CONTROLLER_FIX_EVIDENCE) fs.appendFileSync(process.env.LLV_CONTROLLER_FIX_EVIDENCE,JSON.stringify({ state, history, samples })+"\n");
  }
},30_000);

test("new terminal batches retain five failed-stop opportunities across windows and restart", async () => {
  const { h, lane } = await committing();
  lane.state = "paused"; lane.cursor = null;
  const original = lane.runs[0]!.attempts[0]!;
  lane.runs[0]!.attempts = Array.from({ length: 18 },(_,index) => ({ ...structuredClone(original), n: index+1,
    accounting: { ...original.accounting!, repeatReason: index ? "unknown" as const : null },
    historical: true, state: "failed", verdict: { status: "fail" }, completedAt: h.ports.now(),
    conversationId: `terminal-${index}`, agentPath: `terminal-path-${index}`, paneId: null, launchId: null }));
  lane.terminalReap = { rounds: 4, stopped: 1, settledAt: h.ports.now(), lastAt: h.ports.now(), settledAttempts: ["build:1"] };
  savePipelines([lane]);
  const stops = new Map<number,number>();
  h.ports.stageHostResident = async () => true;
  h.ports.conversationAgentActive = async () => false;
  h.ports.stopStageAgent = async target => { stops.set(target.attempt,(stops.get(target.attempt) ?? 0)+1); return { outcome: "failed", error: "temporary stop failure" }; };
  for (let phase = 0; phase < 12; phase++) {
    await tickPipelinesController([],h.ports);
    const stored = loadPipelines()[0]!;
    for (const host of stored.unconfirmedHosts ?? []) expect(stops.get(host.attempt)).toBe(5);
    // Reopen the production store between windows. The controller's retry
    // custody must be sufficient without anything held by the prior pass.
    if (phase === 1) {
      const { spawnSync } = await import("node:child_process");
      const log = path.join(process.env.LLV_STATE_DIR!,"restarted-reap.log");
      const result = spawnSync(process.execPath,[path.resolve("src/lib/pipelines/fixtures/controllerJobResume.ts")],{
        env: { ...process.env,LLV_CONTROLLER_REAP_LOG: log },encoding:"utf8",timeout: 15_000 });
      expect(result.status).toBe(0);
      for (const attempt of fs.readFileSync(log,"utf8").trim().split("\n").map(Number)) stops.set(attempt,(stops.get(attempt) ?? 0)+1);
    }
  }
  expect(stops.size).toBe(17);
  expect([...stops.values()]).toEqual(Array(17).fill(5));
  expect(loadPipelines()[0]!.unconfirmedHosts).toHaveLength(17);
});

test("off-window survivor evidence prevents a fresh activation until a peer clears it", async () => {
  const { captureProcessIdentity } = await import("@/lib/processIdentity");
  const h = harness();
  await create(h.ports,BUILD_ONLY as never);
  await tickPipelines([],h.ports); await tickPipelines([],h.ports);
  const lane = loadPipelines()[0]!, original = lane.runs[0]!.attempts[0]!;
  lane.state = "running"; lane.cursor!.state = "pending";
  const history = Array.from({ length: 65 },(_,n) => ({ ...structuredClone(original),n: n+1,historical: true,
    accounting: { ...original.accounting!, repeatReason: n ? "unknown" as const : null },
    state: "failed" as const,verdict: { status: "fail" as const },completedAt: h.ports.now(),
    conversationId: null,agentPath: null,paneId: null,launchId: null }));
  history[64]!.unresolvedTermination = { recordedAt: h.ports.now(),error: "unverified descendant",survivors: [captureProcessIdentity(process.pid)!] };
  lane.runs[0]!.attempts = [...history,{ ...original,n: 66,accounting: { ...original.accounting!, repeatReason: "unknown" as const },state: "pending",conversationId: null,agentPath: null,paneId: null,launchId: null }];
  savePipelines([lane]);
  let spawns = 0;
  const spawnAgent = h.ports.spawnAgent;
  h.ports.spawnAgent = async (...args) => { spawns++; return spawnAgent(...args); };
  await tickPipelinesController([],h.ports);
  expect(spawns).toBe(0);
  expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.state).toBe("pending");
  const peer = loadPipelines(); delete peer[0]!.runs[0]!.attempts[64]!.unresolvedTermination; savePipelines(peer);
  await tickPipelinesController([],h.ports);
  expect(spawns).toBe(1);
});

test("lazy controller copies isolate discarded edits and checkpoint the whole retained lane", async () => {
  const { h,lane } = await committing();
  lane.state = "paused"; lane.cursor = null;
  const original = lane.runs[0]!.attempts[0]!;
  const samples: { history: number;wallMs: number;holdMs: number }[] = [];
  for (const history of [32,1024,4096]) {
    lane.runs[0]!.attempts = Array.from({ length: history },(_,n) => ({ ...structuredClone(original),n:n+1,accounting: { ...original.accounting!, repeatReason: n ? "unknown" as const : null },historical:true,
      conversationId:null,agentPath:null,paneId:null,launchId:null,state:"failed",verdict:{status:"fail"},completedAt:h.ports.now() }));
    savePipelines([lane]);
    const refs = new Map([[lane.id,(await controllerAttemptWindow(lane.id,-1,"")).window]]);
    await withControllerPipelineScope([lane.id],async () => {
      await withPipelineControllerMutation(rows => { rows[0]!.runs[0]!.attempts[0]!.output = "discarded"; },undefined,true);
      expect((await findControllerPipeline(lane.id))!.runs[0]!.attempts[0]!.output).toBe(original.output);
      let holdMs = 0;
      const start = performance.now();
      await withPipelineControllerMutation(async (rows,persist) => {
        rows[0]!.runs[0]!.attempts[0]!.output = "checkpointed";
        await persist([rows[0]!]);
      },ms => { holdMs = Math.max(holdMs,ms); },true);
      samples.push({ history,wallMs:performance.now()-start,holdMs });
    },undefined,refs);
    const stored = loadPipelines()[0]!;
    expect(stored.runs[0]!.attempts).toHaveLength(history);
    expect(stored.runs[0]!.attempts[0]!.output).toBe("checkpointed");
    expect(stored.runs[0]!.attempts.at(-1)!.output).toBe(original.output);
  }
  if (process.env.LLV_CONTROLLER_WRITE_EVIDENCE) fs.appendFileSync(process.env.LLV_CONTROLLER_WRITE_EVIDENCE,JSON.stringify({ checkpoints:samples })+"\n");
},30_000);

test("an off-window activation keeps its custody while the current attempt waits", async () => {
  const h = await reserveActivationOnly();
  const lane = loadPipelines()[0]!, original = lane.runs[0]!.attempts[0]!;
  const history = Array.from({ length: 65 },(_,n) => {
    const attempt = { ...structuredClone(original),n:n+1,accounting: { ...original.accounting!, repeatReason: n ? "unknown" as const : null },historical:true,state:"failed" as const,
      verdict:{status:"fail" as const},completedAt:h.ports.now() };
    delete attempt.activation;
    return attempt;
  });
  history[64]!.activation = structuredClone(original.activation!);
  const current = { ...structuredClone(original),n:66,accounting: { ...original.accounting!, repeatReason: "unknown" as const },state:"pending" as const };
  delete current.activation;
  lane.runs[0]!.attempts = [...history,current];
  savePipelines([lane]);
  let spawns = 0;
  h.ports.spawnAgent = async () => { spawns++; throw new Error("the off-window activation still owns custody"); };
  await tickPipelinesController([],h.ports);
  expect(spawns).toBe(0);
  expect(loadPipelines()[0]!.runs[0]!.attempts[64]!.activation?.id).toBe(original.activation!.id);
});

test("indexed fallback membership preserves off-window conversation, launch and path precedence", async () => {
  const { adoptPipelineFallbackTask } = await import("./engine");
  const { lane } = await committing();
  const original = lane.runs[0]!.attempts[0]!;
  for (const identity of [
    { conversationId:"older-conversation",launchId:"older-launch",agentPath:"older-path" },
    { conversationId:null,launchId:"older-launch",agentPath:"older-path" },
    { conversationId:null,launchId:null,agentPath:"older-path" },
  ]) {
    lane.runs[0]!.attempts = [...Array.from({ length:64 },(_,n) => ({ ...structuredClone(original),n:n+1,accounting: { ...original.accounting!, repeatReason: n ? "unknown" as const : null },
      conversationId:null,launchId:null,agentPath:null })),{ ...structuredClone(original),n:65,accounting: { ...original.accounting!, repeatReason: "unknown" as const },...identity }];
    for (const conversationId of [null,"older-conversation","other-conversation"]) for (const launchId of [null,"older-launch","other-launch"]) {
      const tasks = [{ id:"inherited-task",project:lane.project,assignments:[{ state:"linked",conversationId,launchId,path:"older-path" }] }];
      const expected = structuredClone(lane); expected.taskIds = [];
      const bound = adoptPipelineFallbackTask(expected,tasks as never);
      const candidate = structuredClone(lane); candidate.taskIds = [];
      await withControllerPipelineScope([lane.id],async () => {
        expect(adoptPipelineFallbackTask(candidate,tasks as never)).toBe(bound);
        expect(candidate.taskIds).toEqual(expected.taskIds);
      },undefined,new Map([[lane.id,[]]]));
    }
  }
});


test.each(["snapshot", "evidence"] as const)("a stale %s preparation leaves only its lane pending while peers finish the same pass", async kind => {
  const { h, lane } = await committing();
  const rows = ["stale-lane","fresh-peer"].map(id => {
    const row = structuredClone(lane); row.id = id;
    Object.assign(row,pipelineIdentity(id,row.task,row.repoDir));
    row.state = "paused"; row.cursor = null; row.runs = row.runs.map(run => ({ ...run,attempts: [] }));
    row.delivery = undefined; row.publication = "internal";
    row.unconfirmedHosts = [{ stageId: "build",attempt: 1,conversationId: id,agentPath: null,paneId: id,
      operationId: null,detail: "pending disappearance",at: h.ports.now() }];
    return row;
  });
  savePipelines(rows);
  const observed: string[] = [];
  h.ports.stageHostResident = async target => { observed.push(target.conversationId!); return true; };
  const original = SqliteStateCollection.prototype.pipelineControllerCandidate;
  let stale = true;
  const read = spyOn(SqliteStateCollection.prototype,"pipelineControllerCandidate").mockImplementation(function(this: SqliteStateCollection<unknown>, key) {
    if (stale && key === "stale-lane") { stale = false; throw kind === "snapshot" ? new StateSnapshotChangedError() : new PipelineStoreError("pipeline evidence changed during preparation"); }
    return original.call(this,key);
  });
  try { await tickPipelinesController([],h.ports); }
  finally { read.mockRestore(); }
  expect(observed).toEqual(["fresh-peer"]);
  const db = new Database(path.join(process.env.LLV_STATE_DIR!,"state.sqlite"),{ readonly: true });
  try { expect(db.query("SELECT dirty,attempt_cursor FROM pipeline_tick_work WHERE row_key='stale-lane'").get())
    .toEqual({ dirty: 1,attempt_cursor: 0 }); }
  finally { db.close(); }
  await tickPipelinesController([],h.ports);
  expect(observed).toContain("stale-lane");
});

test("scoped selectors reuse one read connection across all lane and attempt reads", async () => {
  const { h, lane } = await committing();
  lane.state = "paused"; lane.cursor = null; lane.runs = lane.runs.map(run => ({ ...run,attempts: [] }));
  lane.delivery = undefined; lane.publication = "internal";
  savePipelines([lane,...Array.from({ length: 3 },(_,i) => {
    const peer = structuredClone(lane); peer.id = `reader-peer-${i}`;
    Object.assign(peer,pipelineIdentity(peer.id,peer.task,peer.repoDir)); return peer;
  })]);
  await tickPipelinesController([],h.ports);
  resetStateReadonlyConnectionCountForTests();
  await withControllerPipelineScope([lane.id], async () => {
    for (let n = 0; n < 3; n++) {
      for (const kind of ["running","hosts","cleanup","pending-stage","publication"] as const) await selectControllerPipelines(kind);
      await findControllerPipeline(lane.id); await controllerAttemptWindow(lane.id,0,"build");
      await controllerPipelineVersion(lane.id); await controllerFlowAttached("absent");
    }
  });
  await tickPipelinesController([],h.ports);
  expect(stateReadonlyConnectionCountForTests()).toBeLessThanOrEqual(1);
});


test("a lane edit during awaited evidence preserves that edit and lets its peer finish", async () => {
  const { h, lane } = await committing();
  const rows = ["awaited-lane","awaited-peer"].map(id => {
    const row = structuredClone(lane); row.id = id;
    Object.assign(row,pipelineIdentity(id,row.task,row.repoDir));
    row.state = "paused"; row.delivery = undefined; row.publication = "internal";
    row.cursor!.state = "running";
    Object.assign(row.runs[0]!.attempts[0]!,{ historical: true,state: "running",verdict: null,
      agentPath: `/fixture/${id}.jsonl`,conversationId: id,launchId: null });
    return row;
  });
  savePipelines(rows);
  const observed: string[] = [];
  let change = true;
  h.ports.durableTurnEvidence = async (_engine,pathname) => {
    observed.push(pathname);
    if (change && pathname === "/fixture/awaited-lane.jsonl") {
      change = false;
      await withPipelineMutation(async (fresh,persist) => {
        fresh.find(row => row.id === "awaited-lane")!.stateDetail = "concurrent lane edit";
        await persist([fresh.find(row => row.id === "awaited-lane")!]);
      });
    }
    return null;
  };
  await tickPipelinesController([],h.ports);
  expect(observed).toContain("/fixture/awaited-peer.jsonl");
  expect(loadPipelines().find(row => row.id === "awaited-lane")!.stateDetail).toBe("concurrent lane edit");
  const db = new Database(path.join(process.env.LLV_STATE_DIR!,"state.sqlite"),{ readonly: true });
  try { expect(db.query("SELECT dirty,attempt_cursor FROM pipeline_tick_work WHERE row_key='awaited-lane'").get())
    .toEqual({ dirty: 1,attempt_cursor: 0 }); }
  finally { db.close(); }
});


test("refused preparations retain their windows and advance the durable fair walk across restart", async () => {
  const { h, lane } = await committing();
  const rows = Array.from({ length: 20 },(_,i) => {
    const row = structuredClone(lane); row.id = `refused-${i.toString().padStart(2,"0")}`;
    Object.assign(row,pipelineIdentity(row.id,row.task,row.repoDir));
    row.state = "paused"; row.cursor = null; row.runs = row.runs.map(run => ({ ...run,attempts: [] }));
    row.delivery = undefined; row.publication = "internal"; return row;
  });
  savePipelines(rows);
  const observed = new Set<string>();
  const read = spyOn(SqliteStateCollection.prototype,"pipelineControllerCandidate").mockImplementation(key => {
    observed.add(key); throw new StateSnapshotChangedError();
  });
  try { await tickPipelinesController([],h.ports); }
  finally { read.mockRestore(); }
  expect(observed.size).toBe(4);
  const source = `import { SqliteStateCollection,StateSnapshotChangedError } from "./src/lib/state/sqliteStateStore.ts";
    import { tickPipelinesController } from "./src/lib/pipelines/controllerPass.ts";
    const seen=new Set();
    SqliteStateCollection.prototype.pipelineControllerCandidate=function(key){seen.add(key);throw new StateSnapshotChangedError();};
    for(let i=0;i<20;i++)await tickPipelinesController([]);
    console.log(JSON.stringify([...seen]));`;
  const child = Bun.spawnSync({ cmd: [process.execPath,"-e",source],env: { ...process.env,LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" },stdout: "pipe",stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  const resumed = JSON.parse(child.stdout.toString()) as string[];
  expect(resumed.some(key => !observed.has(key))).toBe(true);
  expect(new Set([...observed,...resumed]).size).toBe(20);
  const db = new Database(path.join(process.env.LLV_STATE_DIR!,"state.sqlite"),{ readonly: true });
  try { expect(db.query("SELECT COUNT(*) AS n FROM pipeline_tick_work WHERE dirty=1 AND attempt_cursor=0").get()).toEqual({ n: 20 }); }
  finally { db.close(); }
});


test("a coalesced controller pass captures its deadline after already-ready runtime work", async () => {
  await settlePipelineControllerJobs();
  const h = harness();
  let clock = "2026-10-16T00:00:00.000Z";
  const captured: string[] = [];
  h.ports.now = () => { captured.push(clock); return clock; };
  const runtimeReady = new Promise<void>(resolve => setImmediate(() => {
    clock = "2026-10-16T00:01:00.000Z";
    resolve();
  }));
  const first = tickPipelinesController([], h.ports);
  expect(tickPipelinesController([], h.ports)).toBe(first);
  await first;
  await runtimeReady;
  expect(captured.length).toBeGreaterThan(0);
  expect(captured[0]).toBe("2026-10-16T00:01:00.000Z");
});


test("nested controller jobs retain their bounded attempt selection", async () => {
  const { h, lane } = await committing();
  const original = lane.runs[0]!.attempts[0]!;
  lane.runs[0]!.attempts = Array.from({ length: 1024 }, (_, n) => ({ ...structuredClone(original), n: n + 1,
    accounting: { ...original.accounting!, repeatReason: n ? "unknown" as const : null },
    historical: true, state: "failed", output: "x".repeat(4096), launchId: null, verdict: { status: "fail" } }));
  lane.runs[0]!.attempts.push({ ...original, n: 1025, accounting: { ...original.accounting!, repeatReason: "unknown" as const } });
  savePipelines([lane]);
  const refs = await controllerAttemptWindow(lane.id, 0, "build");
  const references = new Map([[lane.id, [...refs.window, ...refs.current]]]);
  const { controllerReferences, controllerTickFingerprint } = await import("./controllerScope");
  await withControllerPipelineScope([lane.id], async () => {
    await withControllerPipelineScope([lane.id], async () => {
      expect(controllerReferences(lane.id)?.length).toBeLessThanOrEqual(18);
      expect(controllerReferences(lane.id)).toBeDefined();
      const current = await findControllerPipeline(lane.id);
      expect(controllerTickFingerprint(current!).length).toBeLessThan(150_000);
    });
  }, new Set(refs.window.map(ref => JSON.stringify([lane.id, ref.stageId, ref.n]))), references);
});


test("settlement polling reads revisions without cloning retained lane history", () => withControllerAuditState(async () => {
  const { h, lane } = await committing();
  const original = lane.runs[0]!.attempts[0]!;
  lane.runs[0]!.attempts = Array.from({ length: 1024 }, (_, n) => ({ ...structuredClone(original), n: n + 1,
    accounting: { ...original.accounting!, repeatReason: n ? "unknown" as const : null },
    historical: true, state: "failed", output: "x".repeat(4096), launchId: null, verdict: { status: "fail" } }));
  lane.runs[0]!.attempts.push({ ...original, n: 1025, accounting: { ...original.accounting!, repeatReason: "unknown" as const } });
  const peers = Array.from({ length: 16 }, (_, n) => {
    const peer = structuredClone(lane); peer.id = `poll-peer-${n}`;
    Object.assign(peer, pipelineIdentity(peer.id, peer.task, peer.repoDir));
    peer.state = "paused"; peer.cursor = { ...lane.cursor!, state: "running" };
    peer.runs = [{ ...lane.runs[0]!, attempts: [{ ...original, state: "running", verdict: null,
      launchId: null, conversationId: null, agentPath: null, paneId: null }] }];
    peer.delivery = undefined;
    return peer;
  });
  savePipelines([lane, ...peers]);
  const entered = latch(), release = latch();
  const exec = h.ports.exec;
  let held = false;
  h.ports.exec = async (command, args, cwd, env, options) => {
    if (!held && options?.inheritFd !== undefined) { held = true; entered.resolve(); await release.promise; }
    return exec(command, args, cwd, env, options);
  };
  try {
    await tickPipelinesController([], h.ports);
    await until(entered.promise, 10_000);
    const reads = spyOn(SqliteStateCollection.prototype, "get");
    try {
      const samples = [];
      for (let n = 0; n < (process.env.LLV_CONTROLLER_POLL_EVIDENCE ? 3 : 1); n++) {
        const cpu = process.cpuUsage(), at = performance.now();
        let last = at, gaps = 0, maxGapMs = 0;
        const timer = setInterval(() => { const now = performance.now(), gap = now-last-10;
          maxGapMs = Math.max(maxGapMs, gap); if (gap >= 50) gaps++; last = now; },10);
        try { await new Promise(resolve => setTimeout(resolve, process.env.LLV_CONTROLLER_POLL_EVIDENCE ? 3000 : 250)); }
        finally { clearInterval(timer); }
        const used = process.cpuUsage(cpu);
        samples.push({ cpuMs: (used.user+used.system)/1000, wallMs: performance.now()-at, gaps, maxGapMs,
          load: (await import("node:os")).loadavg() });
      }
      if (process.env.LLV_CONTROLLER_POLL_EVIDENCE) fs.appendFileSync(process.env.LLV_CONTROLLER_POLL_EVIDENCE,
        JSON.stringify({ lanes:17, attempts:1025, samples })+"\n");
      expect(reads.mock.calls).toHaveLength(0);
    } finally { reads.mockRestore(); }
  } finally { release.resolve(); await settlePipelineControllerJobs(); }
}), 15_000);


test("shared compact authority observations keep each job's own lane out of its peer token", async () => {
  const { lane } = await committing();
  const peer = structuredClone(lane); peer.id = "authority-peer";
  Object.assign(peer, pipelineIdentity(peer.id, peer.task, peer.repoDir));
  peer.state = "closed"; peer.closedAt = "2026-10-22T00:00:00Z"; peer.cursor = null;
  peer.runs = peer.runs.map(run => ({ ...run, attempts: [] })); peer.delivery = undefined;
  savePipelines([lane, peer]);
  const { stageBranchOwnershipReader } = await import("./stageBranch");
  const owner = stageBranchOwnershipReader(lane.id), other = stageBranchOwnershipReader(peer.id);
  const originalOwner = await owner.read(), originalOther = await other.read();
  await withPipelineMutation(async (rows, persist) => {
    const current = rows.find(row => row.id === lane.id)!;
    current.task += " changed branch";
    Object.assign(current, pipelineIdentity(current.id, current.task, current.repoDir));
    await persist([current]);
  });
  expect(await owner.read()).toBe(originalOwner);
  expect(await other.read()).not.toBe(originalOther);
});

test.each([
  ["direct", "pinned", "dirty", 1], ["direct", "followed", "dirty", 1],
  ["queued", "pinned", "dirty", 1], ["queued", "followed", "dirty", 1],
  ["direct", "pinned", "due", 1], ["direct", "followed", "due", 1],
  ["queued", "pinned", "due", 1], ["queued", "followed", "due", 1],
  ["direct", "pinned", "due", 2], ["direct", "pinned", "due", 3],
  ["direct", "pinned", "mixed-due", 2],
] as const)("a %s lane with a %s base starts as %s despite %i repeatedly timed-out peers",
  (admission, base, readiness, blockerCount) => withControllerAuditState(() => auditPeerRotation(admission, base, readiness, blockerCount)));

async function auditPeerRotation(admission: "direct" | "queued", base: "pinned" | "followed",
  readiness: "dirty" | "due" | "mixed-due", blockerCount: number) {
  const { realExec } = await import("@/lib/workflows/provision");
  const { realProvisionExec } = await import("./git");
  const { StoreBusyBeforeAdmissionError } = await import("@/lib/state/fileTransaction");
  const store = await import("./store");
  const queue = await import("./creationQueue");
  const h = harness();
  const epoch = Date.parse("2026-11-18T00:00:00.000Z");
  let elapsed = 0;
  h.ports.now = () => new Date(epoch + elapsed).toISOString();
  await create(h.ports, BUILD_ONLY as never);
  await tickPipelines([], h.ports); await tickPipelines([], h.ports);
  const blocker = loadPipelines()[0]!;
  Object.assign(blocker, { id: "always-dirty", state: "needs_decision", delivery: undefined });
  Object.assign(blocker, pipelineIdentity(blocker.id, blocker.task, blocker.repoDir));
  const oldAttempt = blocker.runs[0]!.attempts[0]!;
  Object.assign(oldAttempt, { state: "needs_decision", conversationId: "conversation_blocked_stop" });
  oldAttempt.providerWait = { condition: { kind: "host_death", label: "host died", scope: null, resetLabel: null },
    accountId: null, text: "host died", turnTs: epoch, tries: 0, startedAt: h.ports.now(), resumeAt: h.ports.now(), resetsAt: null };
  const blockers = Array.from({ length: blockerCount }, (_, index) => {
    const peer = structuredClone(blocker);
    peer.id = `always-dirty-${index}`;
    Object.assign(peer, pipelineIdentity(peer.id, peer.task, peer.repoDir));
    Object.assign(peer.runs[0]!.attempts[0]!, { conversationId: `conversation_blocked_stop_${index}` });
    return peer;
  });
  const blockerConversations = new Map(blockers.map(peer => [peer.runs[0]!.attempts[0]!.conversationId, peer.id]));
  savePipelines(blockers);
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "provision-under-load-"));
  const repo = path.join(root, "repo");
  const origin = path.join(root, "origin.git");
  fs.mkdirSync(repo);
  const git = async (cwd: string, ...args: string[]) => {
    const result = await realExec("git", args, cwd, {
      GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "noreply@example.invalid",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "noreply@example.invalid",
      GIT_AUTHOR_DATE: h.ports.now(), GIT_COMMITTER_DATE: h.ports.now(),
    });
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  await git(repo, "init", "--initial-branch=main");
  await git(repo, "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "base");
  const sha = await git(repo, "rev-parse", "HEAD");
  await git(root, "clone", "--bare", repo, origin);
  await git(repo, "remote", "add", "origin", origin);

  let entered = latch(), release = latch();
  let enteredBlocker: string | undefined;
  const visitedBlockers = new Set<string>();
  const mixedDue = readiness === "mixed-due";
  const block = async (peer: string) => {
    enteredBlocker = peer;
    visitedBlockers.add(peer);
    entered.resolve();
    await release.promise;
  };
  h.ports.conversationOperatorStopped = async id => {
    const peer = blockerConversations.get(id);
    if (!mixedDue && peer !== undefined) await block(peer);
    return false;
  };
  const fixtureExec = h.ports.exec;
  h.ports.exec = async (command, args, cwd, env, options) => {
    const peer = blockers.find(peer => peer.worktreeDir === cwd);
    if (mixedDue && peer && command === "git" && args[0] === "branch" && args[1] === "--show-current") await block(peer.id);
    return cwd.startsWith(root + path.sep)
      ? realExec(command, args, cwd, env, options) : fixtureExec(command, args, cwd, env, options);
  };
  let adds = 0, fetches = 0;
  h.ports.provisionExec = (command, args, cwd, signal, options) => {
    if (args[0] === "worktree" && args[1] === "add") adds++;
    if (args[0] === "fetch") fetches++;
    return realProvisionExec(command, args, cwd, signal, options);
  };
  h.ports.worktreePresent = fs.existsSync;

  const diagnostics: Array<{ pipelineId: string; at: string; phase: string; admission?: string; step?: string; status?: string }> = [];
  const trace = "[flow pipeline provisioning] ";
  const quiet = process.env.LLV_QUIET_DIAGNOSTICS;
  delete process.env.LLV_QUIET_DIAGNOSTICS;
  const info = spyOn(console, "info").mockImplementation(message => {
    if (typeof message === "string" && message.startsWith(trace)) diagnostics.push(JSON.parse(message.slice(trace.length)));
  });
  const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"));
  try {
    setSystemTime(new Date(epoch));
    const busy = admission === "queued" ? spyOn(store, "createPipelineWithDelivery").mockRejectedValueOnce(
      new StoreBusyBeforeAdmissionError("fixture store busy before admission"),
    ) : undefined;
    const created = await (async () => {
      try {
        return await createPipelineFromRequest({ task: "Ready under load", spec: "First attempt under load", repoDir: repo,
          stages: BUILD_ONLY as never, publication: "internal", ...(base === "pinned" ? { baseRef: sha } : {}),
        }, h.ports, { queueWhenBusy: true, creationRequest: { key: "busy-controller-create", digest: "fixture-create" } });
      } finally { busy?.mockRestore(); }
    })();
    const lane = created.pipeline!;
    expect(lane.state).toBe("provisioning");
    expect(Boolean(created.queued)).toBe(admission === "queued");
    expect(fs.existsSync(lane.worktreeDir)).toBe(false);
    expect((await findControllerPipeline(lane.id))?.id ?? null).toBe(admission === "queued" ? null : lane.id);

    const timers: Array<{ active: boolean; callback: () => void }> = [];
    const log: string[] = [];
    const budget = mixedDue ? 15_000 : 500;
    const controller = new FlowPipelineController({
      tickPipelines: entries => tickPipelinesController(entries, h.ports),
      now: () => epoch + elapsed, monotonicNow: () => elapsed,
      scan: async () => ({ files: [], complete: false }),
      publishHeartbeat: () => {},
      scheduleTimeout: callback => { const timer = { active: true, callback }; timers.push(timer); return timer; },
      clearTimeout: timer => { (timer as typeof timers[number]).active = false; },
      log: message => { log.push(message); },
    }, { phaseDeadlineMs: budget, requestDeadlineMs: budget, maxPasses: 1 });
    for (let pass = 0; pass < 8; pass++) {
      entered = latch(); release = latch(); enteredBlocker = undefined;
      // Drive the blockers through the normal generation trigger. The
      // controller records selection, then each hung call expires before ack.
      for (const peer of blockers) {
        db.query("UPDATE state_rows SET value_json=json_set(value_json,'$.stateDetail',?) WHERE collection='pipelines' AND row_key=?")
          .run(`peer update ${pass}`, peer.id);
      }
      const setDue = db.query("UPDATE pipeline_tick_work SET dirty=0,due_at=? WHERE row_key=?");
      if (mixedDue) setDue.run(epoch - 1, blockers[0]!.id);
      if (readiness !== "dirty" && pass === 0) setDue.run(epoch, lane.id);
      const tick = controller.tick();
      let blocked = false;
      await until(Promise.race([tick, entered.promise.then(() => { blocked = true; })]));
      elapsed += budget;
      setSystemTime(new Date(epoch + elapsed));
      const readWork = db.query<{ generation: number; dirty: number; attempt_cursor: number }, [string]>(
        "SELECT generation,dirty,attempt_cursor FROM pipeline_tick_work WHERE row_key=?",
      );
      const timedOutPeer = enteredBlocker;
      const before = timedOutPeer === undefined ? null : readWork.get(timedOutPeer);
      if (blocked) {
        // The production selection transaction must already be durable.
        expect(db.query<{ row_key: string }, []>("SELECT row_key FROM pipeline_tick_cursor WHERE id=1").get()?.row_key).toBe(timedOutPeer);
        expect(before).toMatchObject({ dirty: mixedDue && timedOutPeer === blockers[0]!.id ? 0 : 1 });
        timers.findLast(timer => timer.active)!.callback();
      }
      await until(tick);
      if (timedOutPeer !== undefined) expect(readWork.get(timedOutPeer)).toEqual(before);
      release.resolve();
      await settlePipelineControllerJobs();
      if (mixedDue && process.env.LLV_COLD_CONTROLLER_EVIDENCE) {
        const dueCursor = db.query<{ row_key: string }, []>("SELECT row_key FROM pipeline_tick_priority_cursor WHERE kind='due'").get();
        console.log("mixed-due-audit", JSON.stringify({ pass, timedOutPeer, dueCursorAtOldPeer: dueCursor?.row_key === blockers[0]!.id,
          cold: readWork.get(lane.id), phases: diagnostics.filter(event => event.pipelineId === lane.id).map(event => event.phase) }));
      }
    }
    const deadlines = log.filter(line => line.includes(mixedDue ? "port.exec" : "port.conversationOperatorStopped")).length;
    const attempts = (await findControllerPipeline(lane.id))?.runs[0]?.attempts;
    if (process.env.LLV_COLD_CONTROLLER_EVIDENCE) {
      const cursor = db.query<{ row_key: string }, []>("SELECT row_key FROM pipeline_tick_cursor WHERE id=1").get();
      console.log("dirty-peer-rotation-audit", JSON.stringify({ admission, base, readiness, blockerCount, deadlines,
        attempts: attempts?.length ?? 0, cursorAtBlocker: blockers.some(peer => peer.id === cursor?.row_key) }));
    }
    expect(deadlines).toBeGreaterThan(0);
    expect(visitedBlockers.size).toBe(blockerCount);
    expect(attempts).toMatchObject([{ n: 1, state: "running" }]);
    expect(h.spawnInputs.filter(input => input.cwd === lane.worktreeDir)).toHaveLength(1);
    expect(adds).toBe(1);
    expect(fetches).toBe(base === "pinned" ? 0 : 1);
    expect(await git(lane.worktreeDir, "rev-parse", "HEAD")).toBe(sha);
    expect((await git(repo, "worktree", "list", "--porcelain")).split("\n").filter(line => line === `worktree ${lane.worktreeDir}`)).toHaveLength(1);
    expect(queue.listQueuedPipelineCreations()).toEqual([]);
    const events = diagnostics.filter(event => event.pipelineId === lane.id);
    const { startedAt } = (await findControllerPipeline(lane.id))!.runs[0]!.attempts[0]!;
    expect(events).toEqual([
      { pipelineId: lane.id, at: new Date(epoch).toISOString(), phase: "accepted", admission },
      { pipelineId: lane.id, at: expect.any(String), phase: "scheduler-selected" },
      { pipelineId: lane.id, at: expect.any(String), phase: "state-validated" },
      ...(["common-directory", ...(base === "pinned" ? [] : ["fetch"]), "worktree-add"].flatMap(step => [
        { pipelineId: lane.id, at: expect.any(String), phase: "git-started", step },
        { pipelineId: lane.id, at: expect.any(String), phase: "git-finished", step, status: "ok" },
      ])),
      { pipelineId: lane.id, at: startedAt, phase: "first-attempt" },
    ]);
    const times = events.map(event => Date.parse(event.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(Date.parse(startedAt!) - epoch).toBeLessThanOrEqual(4 * budget);
  } finally {
    release.resolve();
    await settlePipelineStopReadLanes();
    await settlePipelineControllerJobs();
    db.close();
    info.mockRestore();
    setSystemTime();
    if (quiet !== undefined) process.env.LLV_QUIET_DIAGNOSTICS = quiet;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test.each([
  ["direct", "pinned"], ["direct", "followed"], ["queued", "pinned"], ["queued", "followed"],
] as const)("operator audit production-length deadline for cold provisioning: %s %s", (admission, base) => auditIsolatedColdProvisioning(admission, base, 1), 30_000);

test("the independent deadline holds for a cold lane beside three stalled stop reads",
  () => auditIsolatedColdProvisioning("direct", "pinned", 3), 30_000);

test.each([
  ["clear", 620], ["operator-stop", 620], ["clear-after-pause", 620],
  ["clear", 5_500], ["operator-stop", 5_500], ["clear-after-pause", 5_500],
] as const)(
  "a slow scoped RPC returns %s after %i ms while an unrelated cold lane starts before the deadline",
  (reply, responseMs) => auditIsolatedColdProvisioning("direct", "pinned", 1, { reply, responseMs }), 30_000);

test.each(["stop", "withdrawal", "close-withdrawal"] as const)(
  "an accepted peer %s remains pending while the controller starts an unrelated child",
  mutation => auditIsolatedColdProvisioning("direct", "pinned", 1, { mutation }), 30_000);

test.each([
  ["stop", false, false], ["withdrawal", false, false], ["stop", true, false],
  ["withdrawal", true, false], ["withdrawal", true, true],
] as const)(
  "a fresh process reconciles an owned %s after its sender exits, admission still pending %s, stale refusal %s",
  (mutation, holdBeforeAdmission, staleRefusal) => withControllerAuditState(async () => {
    const fixture = await ownedStageControl(mutation, "2026-11-18T12:00:00.000Z", holdBeforeAdmission);
    const target = {
      conversationId: fixture.conversationId, launchId: fixture.launchId, agentPath: fixture.transcriptPath,
      stageId: "build", attempt: 1, paneId: null,
    };
    const source = `
      import { defaultPipelinePorts, invalidateProviderContinuation } from "./src/lib/pipelines/engine.ts";
      import { terminalIdleStopKey } from "./src/lib/pipelines/stageControlCustody.ts";
      const { mutation, target } = JSON.parse(process.argv[1]);
      try {
        const outcome = mutation === "stop"
          ? await defaultPipelinePorts().stopStageAgent(target, { onlyIfIdle: true, operationId: terminalIdleStopKey(target) })
          : (await invalidateProviderContinuation(target.conversationId, undefined, { key: "fixture-restart-withdrawal", artifactPath: target.agentPath }), { outcome: "confirmed" });
        console.log("owned-control-result", JSON.stringify(outcome));
      } catch (error) {
        console.log("owned-control-result", JSON.stringify({ outcome: "unknown", reason: String(error) }));
      }
    `;
    const start = () => Bun.spawn([process.execPath, "-e", source, JSON.stringify({ mutation, target })], {
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const incumbent = start();
    const initialError = new Response(incumbent.stderr).text();
    const initialOutput = new Response(incumbent.stdout).text();
    const observe = async () => {
      const process = start();
      try {
        const result = Promise.all([process.exited, new Response(process.stderr).text(), new Response(process.stdout).text()]);
        await until(result, 6_000);
        const [code, errors, output] = await result;
        expect(code, errors).toBe(0);
        const observed = output.split("\n").find(line => line.startsWith("owned-control-result "));
        if (!observed) throw new Error("restarted mutation observer did not report an outcome");
        return JSON.parse(observed.slice("owned-control-result ".length));
      } finally {
        if (process.exitCode === null && process.signalCode === null) process.kill();
        await process.exited;
      }
    };
    try {
      const held = holdBeforeAdmission ? fixture.mutationEntered : fixture.mutationAccepted;
      await until(Promise.race([held, incumbent.exited.then(async code => {
        throw new Error(`owned mutation sender exited before it reached the held phase (${code}): ${await initialError} ${await initialOutput}`);
      })]), 6_000);
      if (staleRefusal) {
        fixture.publish("running", "fixture-writer-two");
        fixture.release();
        expect(await incumbent.exited).toBe(0);
        expect(await initialOutput).toContain("the session row changed");
        expect(fixture.withdrawals).toHaveLength(0);
        const active = await observe();
        expect(active).toMatchObject({ outcome: "unknown", reason: expect.stringContaining("awaits a confirmed receipt") });
        expect(fixture.dispatches).toHaveLength(1);
        fixture.publish("idle", "fixture-writer-two");
        expect(await observe()).toEqual({ outcome: "confirmed" });
        expect(await observe()).toEqual({ outcome: "confirmed" });
        expect(fixture.withdrawals).toHaveLength(1);
        expect(fixture.dispatches).toEqual(["append-session-fenced", "append-session-fenced"]);
        return;
      }
      incumbent.kill();
      await incumbent.exited;
      const pending = await observe();
      expect(fixture.dispatches).toHaveLength(1);
      if (holdBeforeAdmission) {
        expect(fixture.stops).toHaveLength(0);
        expect(fixture.withdrawals).toHaveLength(0);
        expect(pending.outcome).toBe(mutation === "stop" ? "unconfirmed" : "unknown");
        if (mutation === "withdrawal") expect(pending.reason).toContain("awaits a confirmed receipt");
        fixture.release();
        await until(fixture.mutationAccepted);
      }
      const reconciled = holdBeforeAdmission ? await observe() : pending;
      expect(fixture.dispatches).toHaveLength(1);
      if (mutation === "stop") {
        expect(fixture.stops).toHaveLength(1);
        expect(reconciled).toMatchObject({ outcome: "unconfirmed", operationId: fixture.stops[0]!.operationId });
        const { claimIdleStop, readIdleStop, terminalIdleStopKey } = await import("./stageControlCustody");
        const binding = await readIdleStop(terminalIdleStopKey(target));
        if (!binding) throw new Error("the accepted stop has no ownership binding");
        const alias = terminalIdleStopKey({ ...target, launchId: "another-attempt-for-the-same-host" });
        const { kind: _kind, operationId: _operationId, ...identity } = binding;
        expect(await claimIdleStop(alias, identity)).toEqual({ acquired: false, binding });
        expect(await readIdleStop(alias)).toEqual(binding);
      } else {
        expect(fixture.withdrawals).toHaveLength(1);
        expect(reconciled).toEqual({ outcome: "confirmed" });
        const { claimWithdrawal, readWithdrawal } = await import("./stageControlCustody");
        const binding = await readWithdrawal("fixture-restart-withdrawal");
        if (!binding) throw new Error("the accepted withdrawal has no ownership binding");
        const { kind: _kind, producerPrefix: _prefix, ...identity } = binding;
        const closeOwner = "fixture-close-withdrawal";
        expect(await claimWithdrawal(closeOwner, identity)).toEqual({ acquired: false, binding });
        expect(await readWithdrawal(closeOwner)).toEqual(binding);
      }
    } finally {
      if (incumbent.exitCode === null && incumbent.signalCode === null) incumbent.kill();
      await incumbent.exited;
      await fixture.dispose();
    }
  }), 25_000);

test.each(["stop", "withdrawal"] as const)(
  "a delayed %s cannot act on a replacement turn",
  mutation => withControllerAuditState(async () => {
    const fixture = await ownedStageControl(mutation, "2026-11-18T12:00:00.000Z", true);
    const { terminalIdleStopKey } = await import("./stageControlCustody");
    const { defaultPipelinePorts, invalidateProviderContinuation } = await import("./engine");
    const target = {
      conversationId: fixture.conversationId, launchId: fixture.launchId, agentPath: fixture.transcriptPath,
      stageId: "build", attempt: 1, paneId: null,
    };
    const stop = () => defaultPipelinePorts().stopStageAgent(target, { onlyIfIdle: true, operationId: terminalIdleStopKey(target) });
    const withdraw = () => invalidateProviderContinuation(target.conversationId, undefined, { key: "fixture-stale-withdrawal", artifactPath: target.agentPath });
    try {
      if (mutation === "withdrawal") {
        await expect(invalidateProviderContinuation(target.conversationId, undefined, {
          key: "fixture-other-generation", artifactPath: target.agentPath + ".old",
        })).rejects.toThrow("cannot prove session authority");
        expect(fixture.dispatches).toHaveLength(0);
      }
      const pending = (mutation === "stop" ? stop() : withdraw()).then(
        value => ({ value, error: null }), error => ({ value: null, error: String(error) }),
      );
      await until(fixture.mutationEntered);
      fixture.publish("running", "fixture-writer-two");
      const current = fixture.journal.readSession({ conversationId: fixture.conversationId });
      if (!current) throw new Error("the replacement turn has no session row");
      fixture.release();
      const result = await pending;
      const settled = fixture.journal.readSession({ conversationId: fixture.conversationId });
      // A refused kill publishes its receipt while leaving session authority intact.
      const rejected = fixture.stops[0]?.receipt;
      if (mutation === "stop" && !rejected) throw new Error("the refused stop has no journal receipt");
      expect(settled).toEqual({ ...current, recentReceipts: rejected ? [rejected] : current.recentReceipts });
      expect(current.activeTurnId).toBe("fixture-new-turn");
      expect(fixture.dispatches).toHaveLength(1);
      if (mutation === "withdrawal") {
        expect(result.error).toContain("session row changed");
        expect(fixture.withdrawals).toHaveLength(0);
        await expect(withdraw()).rejects.toThrow("awaits a confirmed receipt");
        expect(fixture.dispatches).toEqual(["append-session-fenced"]);
        return;
      }
      expect(result.value).toEqual({ outcome: "deferred" });
      expect(fixture.stops[0]?.receipt).toMatchObject({ status: "rejected", reason: "idle-retirement-deferred" });
      expect(await stop()).toEqual({ outcome: "deferred" });
      expect(fixture.dispatches).toHaveLength(1);

      fixture.publish("idle", "fixture-writer-two");
      const fresh = await stop();
      expect(fixture.stops).toHaveLength(2);
      expect(fixture.stops[1]?.receipt.status).toBe("queued");
      expect(fixture.stops[1]?.operationId).not.toBe(fixture.stops[0]?.operationId);
      expect(fresh).toMatchObject({ outcome: "unconfirmed", operationId: fixture.stops[1]?.operationId });
      expect(await stop()).toEqual(fresh);
      expect(fixture.dispatches).toHaveLength(2);
    } finally {
      await fixture.dispose();
    }
  }), 12_000);

test.each(["cancel", "settle"] as const)("an earlier stop receipt read shares the confirmation deadline (%s)",
  mode => withControllerAuditState(async () => {
    const { retirePipelineStageAgent } = await import("./engine");
    const { terminalIdleStopKey } = await import("./stageControlCustody");
    const { runtimeHostClient } = await import("@/lib/runtime/client");
    const fixture = await ownedStageControl("stop", "2026-11-18T12:00:00.000Z", true);
    const target = { conversationId: fixture.conversationId, launchId: fixture.launchId,
      agentPath: fixture.transcriptPath, stageId: "build", attempt: 1, paneId: null };
    const operationId = terminalIdleStopKey(target);
    const first = retirePipelineStageAgent(target, { operationId });
    const entered = latch(), hold = latch();
    const cancel = new AbortController();
    let pending: ReturnType<typeof retirePipelineStageAgent> | undefined;
    try {
      await until(fixture.mutationEntered);
      fixture.publish("running", "fixture-writer-two");
      fixture.release();
      expect(await first).toEqual({ outcome: "deferred" });
      expect(fixture.stops[0]?.receipt.reason).toBe("idle-retirement-deferred");
      fixture.publish("idle", "fixture-writer-two");
      const real = runtimeHostClient()!;
      const reads: Array<{ signal?: AbortSignal; timeoutMs?: number }> = [];
      let now = 0;
      const client = new Proxy(real, {
        get(subject, key, receiver) {
          if (key === "operationStatus") return async (id: string, options?: { signal?: AbortSignal; timeoutMs?: number }) => {
            reads.push(options ?? {});
            if (reads.length === 1) {
              entered.resolve();
              await hold.promise;
            }
            return subject.operationStatus(id, options);
          };
          const value = Reflect.get(subject, key, receiver);
          return typeof value === "function" ? value.bind(subject) : value;
        },
      });
      pending = retirePipelineStageAgent(target, { operationId, client, signal: cancel.signal,
        budgetMs: 1_500, now: () => now, sleep: async () => { now = 1_500; } });
      await until(entered.promise);
      if (mode === "cancel") cancel.abort(new Error("caller cancelled during receipt read"));
      else now = 1_100;
      hold.resolve();
      const result = await pending;
      if (mode === "cancel") {
        expect(reads[0]?.signal?.aborted).toBe(true);
        expect(reads.map(read => read.timeoutMs)).toEqual([1_500]);
        expect(fixture.dispatches).toHaveLength(1);
        expect(result).toMatchObject({ outcome: "unconfirmed", operationId: fixture.stops[0]?.operationId });
      } else {
        expect(reads.map(read => read.timeoutMs)).toEqual([1_500, 400]);
        expect(fixture.dispatches).toHaveLength(2);
        expect(result).toMatchObject({ outcome: "unconfirmed", operationId: fixture.stops[1]?.operationId });
      }
    } finally {
      cancel.abort();
      hold.resolve();
      fixture.release();
      await Promise.allSettled([first, pending]);
      await fixture.dispose();
    }
  }), 12_000);

type StopReadCase = { reply: "clear" | "operator-stop" | "clear-after-pause"; responseMs: number };
type ColdProvisionScenario = StopReadCase | { mutation: "stop" | "withdrawal" | "close-withdrawal" };

async function delayedScopedStopServer(conversationId: string, admittedAt: string, scenario: StopReadCase, pause: () => Promise<void>) {
  const { reply, responseMs } = scenario;
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR!, "stop-rpc-"));
  const socketPath = path.join(dir, "host.sock");
  const pending = new Set<Promise<void>>();
  const evidence = { requests: 0, responses: 0, closedBeforeResponse: 0 };
  const server = createServer(socket => {
    let input = "";
    socket.on("error", () => {});
    socket.on("data", function readRequest(chunk) {
      input += chunk.toString();
      const end = input.indexOf("\n");
      if (end === -1) return;
      socket.off("data", readRequest);
      const request = JSON.parse(input.slice(0, end));
      if (request.method !== "effect-batch" || request.params.conversationId !== conversationId || (request.params.afterEventSeq ?? 0) !== 0) {
        socket.end(JSON.stringify({ id: request.id, ok: false, error: "unexpected fixture RPC" }) + "\n");
        return;
      }
      evidence.requests++;
      const operation = (async () => {
        if (reply === "clear-after-pause") await pause();
        await Bun.sleep(responseMs);
        if (socket.destroyed || socket.readableEnded) { evidence.closedBeforeResponse++; return; }
        const result = reply === "operator-stop" ? [{
          id: "effect:fixture-stop", eventSeq: 1, kind: "runtime.stop-boundary",
          payload: { conversationId, operationId: "fixture-stop", admittedAt, origin: "operator", originAuthenticated: true },
        }] : [];
        socket.end(JSON.stringify({ id: request.id, ok: true, result }) + "\n");
        evidence.responses++;
      })();
      pending.add(operation);
      void operation.then(() => pending.delete(operation), error => socket.destroy(error));
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  const previous = process.env.LLV_RUNTIME_HOST_SOCKET;
  process.env.LLV_RUNTIME_HOST_SOCKET = socketPath;
  return { evidence, async close() {
    if (previous === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
    else process.env.LLV_RUNTIME_HOST_SOCKET = previous;
    await Promise.all(pending);
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  } };
}

function auditIsolatedColdProvisioning(admission: "direct" | "queued", base: "pinned" | "followed", blockerCount: number, scenario?: ColdProvisionScenario) {
  return withControllerAuditState(() => auditColdProvisioning(admission, base, blockerCount, scenario));
}

async function withControllerAuditState(audit: () => Promise<void>) {
  const { AgentRegistry, agentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
  const previousRegistry = agentRegistry();
  const previousState = process.env.LLV_STATE_DIR;
  const state = fs.mkdtempSync(path.join(process.env.TMPDIR!, "controller-audit-state-"));
  process.env.LLV_STATE_DIR = state;
  let registry: InstanceType<typeof AgentRegistry> | undefined;
  try {
    registry = new AgentRegistry();
    setAgentRegistryForTests(registry);
    await audit();
  } finally {
    setAgentRegistryForTests(previousRegistry);
    registry?.close();
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(state, { recursive: true, force: true });
  }
}

async function auditColdProvisioning(admission: "direct" | "queued", base: "pinned" | "followed", blockerCount: number, scenario?: ColdProvisionScenario) {
  const rpc = scenario && "reply" in scenario ? scenario : undefined;
  const mutation = scenario && "mutation" in scenario ? scenario.mutation : undefined;
  const reply = rpc?.reply;
  const f = await realWorktreeLane("cold-provision-audit", BUILD_ONLY as never);
  const h = f.h;
  const old = loadPipelines()[0]!;
  const attempt = old.runs[0]!.attempts[0]!;
  const requestedAt = h.ports.now();
  attempt.suspension = { reason: "account", detail: "suspended producer",
    requestedAt, stoppedAt: requestedAt, retryRequestedAt: requestedAt };
  const blockers = [old];
  for (let index = 1; index < blockerCount; index++) {
    const peer = structuredClone(old);
    peer.id = `cold-stalled-peer-${index}`;
    peer.delivery = undefined;
    Object.assign(peer, pipelineIdentity(peer.id, peer.task, peer.repoDir));
    Object.assign(peer.runs[0]!.attempts[0]!, { conversationId: `conversation_cold_peer_${index}`,
      launchId: `fixture-cold-peer-${index}`, agentPath: `/codex/cold-peer-${index}.jsonl`, paneId: `%cold-peer-${index}` });
    await f.git(f.repo, "worktree", "add", "-b", peer.branch, peer.worktreeDir, f.base);
    blockers.push(peer);
  }
  savePipelines(blockers);
  const blockedConversations = new Set(blockers.map(peer => peer.runs[0]!.attempts[0]!.conversationId));
  const blockedPanes = new Set(blockers.map(peer => peer.runs[0]!.attempts[0]!.paneId));
  const account = attempt.accountId!;
  h.ports.conversationAgentActive = async id => !blockedConversations.has(id);
  h.ports.paneAgentAlive = async pane => !blockedPanes.has(pane);
  h.ports.allowedAccountIds = () => [account];
  h.ports.resolveProjectSpawn = engine => ({ kind: "available", account: { engine, accountId: account,
    kind: "managed", home: f.root, transcriptRoot: f.root, env: { NODE_ENV: "test" } } });

  const blocked = latch(), release = latch(), launched = latch(), launchTickExited = latch();
  let stalled = true, stopReads = 0, cancelledReads = 0, childLaunched = false;
  const observerReady = latch(), observationComplete = latch();
  let observation: { children: number; callbacks: number; deadlineReached: boolean;
    callbackMs: number | null; childMs: number | null; tickExitMs: number | null } | undefined;
  const observer = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "coldLaunchDeadline.ts")], {
    stdin: "ignore", stdout: "ignore", stderr: "inherit",
    ipc(message) {
      if (message === "ready") observerReady.resolve();
      else {
        observation = message as typeof observation;
        observationComplete.resolve();
      }
    },
  });
  const observedBlockers = new Set<string>();
  let stopServer: Awaited<ReturnType<typeof delayedScopedStopServer>> | undefined;
  let heldControl: Awaited<ReturnType<typeof ownedStageControl>> | undefined;
  h.ports.conversationOperatorStopped = async (id, since, ignored) => {
    if (mutation || !blockedConversations.has(id)) return false;
    stopReads++;
    if (!stalled && !stopServer) return false;
    observedBlockers.add(id);
    blocked.resolve();
    if (stopServer) return defaultPipelinePorts().conversationOperatorStopped!(id, since, ignored);
    const signal = currentOperationLease()?.abort.signal;
    await new Promise<void>(resolve => {
      const cancel = () => { cancelledReads++; resolve(); };
      if (signal?.aborted) cancel();
      else signal?.addEventListener("abort", cancel, { once: true });
      void release.promise.then(() => {
        signal?.removeEventListener("abort", cancel);
        resolve();
      });
    });
    return false;
  };
  const logs: string[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const controller = new FlowPipelineController({
    tickPipelines: entries => tickPipelinesController(entries, h.ports),
    scan: async () => ({ files: [], complete: false }),
    scheduleTimeout: (callback, delay) => {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
      timers.add(timer);
      return timer;
    },
    clearTimeout: handle => {
      const timer = handle as ReturnType<typeof setTimeout>;
      clearTimeout(timer);
      timers.delete(timer);
    },
    log: message => { logs.push(message); },
  }, { phaseDeadlineMs: 15_000, maxPasses: 1 });
  let tickExitReported = false;
  const runTick = async () => {
    await controller.tick();
    if (childLaunched && !tickExitReported) {
      tickExitReported = true;
      observer.send("tick-exit");
      launchTickExited.resolve();
    }
  };
  let wake: Promise<void> | undefined;
  const unregister = registerPipelineTick(() => (wake = runTick()));
  h.ports.scheduleTick = delay => { if (delay === 0) requestPipelineTick(); };
  let cpuNow = Date.parse(requestedAt);
  const queue = new CpuAdmissionQueue(path.join(f.root, "cold-cpu.sqlite"), () => cpuNow);
  const cpuKeys = new Set<string>();
  h.ports.cpuPressureHold = (key, priority) => {
    if (key === undefined) throw new Error("missing stage CPU admission key");
    cpuKeys.add(key);
    const allow = !reply || childLaunched || !key.includes(`:${old.id}:`);
    const wait = queue.check(key, allow, undefined, true, priority);
    return wait ? { since: wait.since, avg10: 90, deferred: false, policy: DEFAULT_CPU_PRESSURE_POLICY, queue: wait } : null;
  };
  let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">> | undefined;
  let tick: Promise<void> | undefined;
  try {
    await until(observerReady.promise);
    if (rpc) stopServer = await delayedScopedStopServer(attempt.conversationId!, requestedAt, rpc, async () => {
      await withPipelineMutation(async (rows, persist) => {
        const paused = rows.find(row => row.id === old.id)!;
        paused.pausedState = "running";
        paused.pausedAt = h.ports.now();
        paused.state = "paused";
        await persist([paused]);
      });
    });
    if (mutation) {
      heldControl = await ownedStageControl(mutation === "stop" ? "stop" : "withdrawal", requestedAt);
      const { conversationId, launchId, transcriptPath } = heldControl;
      Object.assign(attempt, { conversationId, launchId, agentPath: transcriptPath, paneId: null });
      blockedConversations.clear();
      blockedConversations.add(conversationId);
      blockedPanes.clear();
      if (mutation === "stop") {
        old.state = "completed";
        old.cursor = null;
        Object.assign(attempt, { state: "passed", completedAt: requestedAt, verdict: { status: "pass" } });
        delete attempt.suspension;
        const real = defaultPipelinePorts();
        h.ports.stopStageAgent = real.stopStageAgent;
        h.ports.stageHostResident = real.stageHostResident;
      } else {
        h.ports.invalidateProviderContinuation = defaultPipelinePorts().invalidateProviderContinuation;
        if (mutation === "close-withdrawal") {
          old.state = "closed";
          old.closedAt = requestedAt;
          old.cursor = null;
          old.closeTeardown = { id: "fixture-close-withdrawal", phase: "pending", waitingForActivation: false,
            acknowledgeHosts: false, flow: null };
          old.closeReport = { status: "pending", pending: [], pendingContinuations: [{
            stageId: old.runs[0]!.stageId, attempt: attempt.n, conversationId, launchId, agentPath: transcriptPath, paneId: null,
          }], stopped: [], alreadyStopped: [], unconfirmed: [], reviewers: [], acknowledged: [], stillRunning: [], notes: [], worktree: null };
        }
      }
      savePipelines(blockers);
      void heldControl.mutationAccepted.then(() => { observedBlockers.add(conversationId); blocked.resolve(); });
    }
    if (process.env.LLV_COLD_CONTROLLER_LATE === "1") {
      const exec = h.ports.provisionExec!;
      h.ports.provisionExec = async (command, args, cwd, signal, options) => {
        if (args[0] === "worktree" && args[1] === "add") await Bun.sleep(15_100);
        return exec(command, args, cwd, signal, options);
      };
    }
    const store = await import("./store");
    const { StoreBusyBeforeAdmissionError } = await import("@/lib/state/fileTransaction");
    const busy = admission === "queued" ? spyOn(store, "createPipelineWithDelivery").mockRejectedValueOnce(
      new StoreBusyBeforeAdmissionError("fixture store busy before admission"),
    ) : undefined;
    const created = await createPipelineFromRequest({
      task: "Cold lane beside a suspended stage", repoDir: f.repo, publication: "internal",
      stages: BUILD_ONLY as never, ...(base === "pinned" ? { baseRef: f.base } : {}),
    }, h.ports, { queueWhenBusy: true, creationRequest: { key: "cold-provision-audit", digest: base } })
      .finally(() => busy?.mockRestore());
    observer.send("accepted");
    const cold = created.pipeline!;
    expect(cold.state).toBe("provisioning");
    expect(Boolean(created.queued)).toBe(admission === "queued");
    expect(fs.existsSync(cold.worktreeDir)).toBe(false);
    const spawnAgent = h.ports.spawnAgent;
    h.ports.spawnAgent = async (input, reserve) => {
      if (input.cwd !== cold.worktreeDir) return spawnAgent(input, reserve);
      observer.send("callback");
      const result = await spawnAgent(input, reserve);
      // The reservation must already be durable before the child can execute.
      expect((await findControllerPipeline(cold.id))?.runs[0]?.attempts).toMatchObject([{ n: 1, launchId: result.launchId }]);
      child = Bun.spawn([process.execPath, "-e", "console.log('fixture first launch')"],
        { cwd: input.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      observer.send("child");
      childLaunched = true;
      const [exit, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      expect({ exit, output: output.trim() }).toEqual({ exit: 0, output: "fixture first launch" });
      launched.resolve();
      return result;
    };
    tick = runTick();
    // The independent process owns the acceptance-to-child deadline. This
    // wait also lets a deliberately late child report its actual launch.
    await until(Promise.race([
      Promise.all([blocked.promise, launched.promise, launchTickExited.promise]),
      tick.then(() => new Promise<never>(() => {})),
    ]), 24_000);
    expect(logs.filter(line => line.includes("pending at deadline"))).toEqual([]);
    expect(observedBlockers.size).toBe(blockerCount);
    const retained = (await findControllerPipeline(old.id))!;
    if (!reply && mutation !== "stop" && mutation !== "close-withdrawal") {
      expect(retained.runs[0]?.attempts).toMatchObject([{ n: 1, suspension: { retryRequestedAt: requestedAt } }]);
    }
    expect(cpuKeys.size).toBeGreaterThan(0);
    expect(await f.git(cold.worktreeDir, "rev-parse", "HEAD")).toBe(f.base);
    const worktrees = (await f.git(f.repo, "worktree", "list", "--porcelain")).split("\n");
    expect(worktrees.filter(line => line === `worktree ${cold.worktreeDir}`)).toHaveLength(1);

    if (heldControl) {
      for (let pass = 0; pass < 4; pass++) await controller.tick();
      expect(heldControl.stops).toHaveLength(mutation === "stop" ? 1 : 0);
      expect(heldControl.withdrawals).toHaveLength(mutation === "stop" ? 0 : 1);
      if (mutation === "stop") {
        const operation = heldControl.stops[0]!;
        expect(operation.receipt.status).toBe("queued");
        heldControl.publish("running", "fixture-writer-two");
        const refused = heldControl.journal.transitionOperation(operation.operationId, "delivering");
        expect(refused.receipt).toMatchObject({ status: "failed", reason: "idle-retirement-deferred" });
        expect(heldControl.journal.readSession({ conversationId: heldControl.conversationId })?.activeTurnId).toBe("fixture-new-turn");
      }
      heldControl.release();
    }
    stalled = false;
    release.resolve();
    await settlePipelineStopReadLanes();
    for (let pass = 0; pass < 4; pass++) await controller.tick();
    const waitingForCpu = await findControllerPipeline(old.id);
    if (mutation === "stop") {
      expect(waitingForCpu?.state).toBe("completed");
      expect(heldControl?.stops).toHaveLength(1);
    } else if (mutation === "close-withdrawal") {
      expect(waitingForCpu).toMatchObject({ state: "closed", closeReport: { status: "settled", pendingContinuations: [] } });
    } else if (reply === "operator-stop") {
      expect(waitingForCpu?.stateDetail).toContain("stopped by operator");
      const stopped = waitingForCpu?.runs[0]?.attempts[0]?.suspension?.operatorStoppedAt;
      expect(typeof stopped).toBe("string");
      expect(Date.parse(stopped!)).toBeGreaterThanOrEqual(Date.parse(requestedAt));
    } else if (reply === "clear-after-pause") {
      expect(waitingForCpu?.state).toBe("paused");
      expect(waitingForCpu?.runs[0]?.attempts.map(item => item.n)).toEqual([1]);
    } else {
      expect(waitingForCpu?.stateDetail).toContain("CPU queue");
      expect(waitingForCpu?.runs[0]?.attempts.at(-1)).toMatchObject({ n: 2, state: "pending" });
    }
    for (let window = 0; window < blockerCount; window++) {
      cpuNow += CPU_QUEUE_SPACING_MS;
      for (let pass = 0; pass < 4; pass++) await controller.tick();
    }
    for (const peer of blockers) {
      const recovered = await findControllerPipeline(peer.id);
      if (mutation === "stop" || mutation === "close-withdrawal" || reply && reply !== "clear") {
        expect(recovered?.runs[0]?.attempts.map(item => item.n)).toEqual([1]);
        expect(h.spawnInputs.filter(input => input.cwd === old.worktreeDir)).toHaveLength(1);
        continue;
      }
      expect(recovered?.runs[0]?.attempts.map(({ n, state, accountId }) => ({ n, state, accountId })), recovered?.stateDetail ?? "").toEqual([
        { n: 1, state: "failed", accountId: account }, { n: 2, state: "running", accountId: account },
      ]);
    }
    expect((await findControllerPipeline(cold.id))?.runs[0]?.attempts).toMatchObject([{ n: 1, state: "running" }]);
    expect(h.spawnInputs.filter(input => input.cwd === cold.worktreeDir)).toHaveLength(1);
    if (stopServer) expect(stopServer.evidence).toEqual({ requests: 1, responses: 1, closedBeforeResponse: 0 });
    if (heldControl) {
      expect(heldControl.stops).toHaveLength(mutation === "stop" ? 1 : 0);
      expect(heldControl.withdrawals).toHaveLength(mutation === "stop" ? 0 : 1);
    }
    observer.send("finished");
    await until(observationComplete.promise);
    if (process.env.LLV_COLD_CONTROLLER_EVIDENCE) {
      console.log("cold-controller-audit", JSON.stringify({ admission, base, blockerCount, ...observation, stopReads, cancelledReads, scenario, rpc: stopServer?.evidence,
        dispatchedStops: heldControl?.stops.length, withdrawals: heldControl?.withdrawals.length }));
    }
    expect(observation).toMatchObject({ callbacks: 1, children: 1 });
    expect(observation?.deadlineReached, "independent acceptance-to-child deadline of 15000 ms").toBe(false);
  } finally {
    stalled = false;
    release.resolve();
    heldControl?.release();
    unregister();
    if (child?.exitCode === null) child.kill();
    await child?.exited;
    await Promise.allSettled([tick, wake]);
    await settlePipelineStopReadLanes();
    await stopServer?.close();
    await heldControl?.dispose();
    if (observer.exitCode === null) observer.kill();
    await observer.exited;
    for (const timer of timers) clearTimeout(timer);
    await settlePipelineControllerJobs();
    await (await import("@/lib/links/taskPageWorker")).shutdownTaskPageWorker();
    queue.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
}

test.each(["recovers", "exhausts"] as const)("a classified provisioning lock retry %s across controller processes", async outcome => {
  const f = await realWorktreeLane("provision-lock-restart", BUILD_ONLY as never);
  const initial = Date.parse("2026-11-18T00:00:00.000Z");
  const iso = (offset: number) => new Date(initial + offset).toISOString();
  f.h.ports.now = () => iso(0);
  const source = `
    import { defaultPipelinePorts } from "./src/lib/pipelines/engine.ts";
    import { realProvisionExec } from "./src/lib/pipelines/git.ts";
    import { tickPipelinesController } from "./src/lib/pipelines/controllerPass.ts";
    import { settlePipelineControllerJobs } from "./src/lib/pipelines/controllerJobs.ts";
    import { registerPipelineTick } from "./src/lib/pipelines/controllerSignal.ts";
    registerPipelineTick(async () => {});
    const ports = defaultPipelinePorts();
    ports.now = () => process.env.LLV_FIXTURE_RETRY_AT;
    ports.structuredDeliveryPublication = () => "unbound";
    ports.worktreeDiskWait = () => null;
    ports.cpuAdmissionReconcile = async () => {};
    ports.scheduleTick = () => {};
    let adds = 0;
    ports.provisionExec = async (...args) => {
      if (args[1][0] === "worktree" && args[1][1] === "add") adds++;
      return realProvisionExec(...args);
    };
    await tickPipelinesController([], ports);
    await settlePipelineControllerJobs();
    console.log(adds);
  `;
  const runAt = async (offset: number) => {
    const child = Bun.spawn([process.execPath, "-e", source], {
      env: { ...process.env, LLV_QUIET_DIAGNOSTICS: "1", LLV_FIXTURE_RETRY_AT: iso(offset), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const result = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    try {
      await until(result, 10_000);
      const [exit, stdout, stderr] = await result;
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
      return Number(stdout.trim());
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  };
  try {
    const created = await createPipelineFromRequest({ task: "Retry a held ref", repoDir: f.repo, baseRef: f.base,
      stages: BUILD_ONLY as never, publication: "internal" }, f.h.ports);
    const lane = created.pipeline!;
    const lock = path.join(f.repo, ".git", "refs", "heads", `${lane.branch}.lock`);
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "");
    await tickPipelinesController([], f.h.ports);
    await settlePipelineControllerJobs();
    const waiting = (await findControllerPipeline(lane.id))!;
    expect(waiting.stateDetail).toContain("a Git lock was held");
    expect(waiting.provisioningWait).toMatchObject({ startedAt: iso(0), retryAfter: iso(5_000), rounds: 1, budgetMs: 180_000 });
    expect(await runAt(4_999)).toBe(0);
    expect((await findControllerPipeline(lane.id))?.provisioningWait).toEqual(waiting.provisioningWait);
    if (outcome === "exhausts") {
      expect(await runAt(180_000)).toBe(1);
      const parked = await findControllerPipeline(lane.id);
      expect(parked).toMatchObject({ state: "needs_decision", baseRef: f.base,
        stateDetail: expect.stringContaining("gave up after 1 retries over 180s: a Git lock was held") });
      expect(parked?.runs[0]?.attempts).toEqual([]);
      expect(await runAt(181_000)).toBe(0);
      expect(fs.existsSync(lane.worktreeDir)).toBe(false);
    } else {
      fs.rmSync(lock);
      expect(await runAt(5_000)).toBe(1);
      expect(await f.git(lane.worktreeDir, "rev-parse", "HEAD")).toBe(f.base);
      f.h.ports.now = () => iso(5_000);
      for (let round = 0; round < 3; round++) await tickPipelinesController([], f.h.ports);
      expect(f.h.spawnInputs.filter(input => input.cwd === lane.worktreeDir)).toHaveLength(1);
      expect((await findControllerPipeline(lane.id))?.runs[0]?.attempts).toMatchObject([{ n: 1, state: "running" }]);
      expect((await findControllerPipeline(lane.id))?.provisioningWait).toBeUndefined();
    }
  } finally {
    await settlePipelineControllerJobs();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("provisioning yields the controller phase and has capacity while all publishers wait", async () => {
  const h = harness();
  const lane = await create(h.ports, BUILD_ONLY as never, { repoDir: "/repo-a" });
  const peer = structuredClone(lane);
  peer.id = "fast-provision-peer";
  peer.repoDir = "/repo-b";
  peer.delivery = undefined;
  Object.assign(peer, pipelineIdentity(peer.id, peer.task, peer.repoDir));
  savePipelines([lane, peer]);
  const entered = latch(), release = latch(), peerReady = latch();
  const unregister = registerPipelineTick(async () => {
    if ((await findControllerPipeline(peer.id))?.state === "running") peerReady.resolve();
  });
  const exec = h.ports.exec;
  h.ports.exec = (command, args, cwd, env, options) => {
    if (cwd === peer.worktreeDir && args[0] === "branch" && args[1] === "--show-current")
      return { code: 0, stdout: peer.branch + "\n", stderr: "" };
    if (cwd === peer.worktreeDir && args[0] === "symbolic-ref")
      return { code: 0, stdout: `refs/heads/${peer.branch}\n`, stderr: "" };
    return exec(command, args, cwd, env, options);
  };
  h.ports.provisionExec = async (command, args, cwd, signal) => {
    if (args.includes("--git-common-dir")) {
      if (cwd === lane.repoDir) { entered.resolve(); await release.promise; }
      return { code: 0, stdout: cwd + "/.git", stderr: "" };
    }
    if (signal?.aborted) return { code: null, stdout: "", stderr: "cancelled" };
    return exec(command, args, cwd);
  };
  let tick: Promise<unknown> | undefined;
  try {
    for (let i = 0; i < 4; i++) expect(startPipelineControllerJob(
      `waiting-publisher-${i}`, () => release.promise, async () => "unchanged")).toBe(true);
    tick = tickPipelinesController([], h.ports);
    await until(tick);
    await until(entered.promise);
    await until(peerReady.promise);
    expect((await findControllerPipeline(lane.id))?.state).toBe("provisioning");
    expect((await findControllerPipeline(peer.id))?.state).toBe("running");
    await until(tickPipelinesController([], h.ports));
    // The first running pass creates the attempt; its new activation enters
    // the bounded attempt window on the following pass.
    await until(tickPipelinesController([], h.ports));
    expect(h.spawnInputs.some(input => input.cwd === peer.worktreeDir)).toBe(true);
  } finally { release.resolve(); await tick; await settlePipelineControllerJobs(); unregister(); }
  expect((await findControllerPipeline(lane.id))?.state).toBe("running");
});

test.each(["failure", "pause", "remove", "branch", "owner"] as const)("a detached provisioning %s settles against the current lane", async change => {
  const h = harness();
  const lane = await create(h.ports, BUILD_ONLY as never);
  const entered = latch(), release = latch();
  const exec = h.ports.exec;
  h.ports.provisionExec = async (command, args, cwd, signal) => {
    if (args.includes("--git-common-dir")) {
      entered.resolve(); await release.promise;
      if (change === "failure") return { code: 1, stdout: "", stderr: "fixture common directory refused" };
    }
    if (signal?.aborted) return { code: null, stdout: "", stderr: "cancelled" };
    return exec(command, args, cwd);
  };
  let tick: Promise<unknown> | undefined;
  try {
    tick = tickPipelinesController([], h.ports);
    await until(tick);
    await until(entered.promise);
    if (change === "remove") savePipelines([]);
    if (["pause", "branch", "owner"].includes(change)) {
      const current = loadPipelines()[0]!;
      if (change === "pause") { current.state = "paused"; current.pausedState = "provisioning"; }
      if (change === "branch") {
        current.task += " edited";
        Object.assign(current, pipelineIdentity(current.id, current.task, current.repoDir));
      }
      if (change === "owner") current.delivery!.epoch++;
      savePipelines([current]);
    }
  } finally { release.resolve(); await tick; await settlePipelineControllerJobs(); }
  const current = await findControllerPipeline(lane.id);
  if (change === "remove") expect(current).toBeNull();
  else if (change === "pause") expect(current?.state).toBe("paused");
  else if (change === "branch" || change === "owner") expect(current?.state).toBe("provisioning");
  else {
    expect(current?.state).toBe("needs_decision");
    expect(current?.stateDetail).toContain("fixture common directory refused");
  }
  expect(h.spawnInputs).toHaveLength(0);
  expect(pipelineControllerJobLanes()).toEqual([]);
});

test("a new controller process resumes active and repository-waiting provisioning after its job owner exits", async () => {
  const h = harness();
  const lane = await create(h.ports, BUILD_ONLY as never);
  lane.baseBranch = "main"; lane.baseRef = "1".repeat(40);
  lane.baseRefPinned = true; lane.lastPassedCommit = lane.baseRef;
  const peer = structuredClone(lane);
  peer.id = "restart-repository-waiter"; peer.delivery = undefined;
  Object.assign(peer, pipelineIdentity(peer.id, peer.task, peer.repoDir));
  savePipelines([lane, peer]);
  const source = `
    const { defaultPipelinePorts } = await import("./src/lib/pipelines/engine.ts");
    const { tickPipelinesController } = await import("./src/lib/pipelines/controllerPass.ts");
    const { settlePipelineControllerJobs, startPipelineControllerJob } = await import("./src/lib/pipelines/controllerJobs.ts");
    const { registerPipelineTick } = await import("./src/lib/pipelines/controllerSignal.ts");
    registerPipelineTick(async () => {});
    const ports = defaultPipelinePorts();
    ports.structuredDeliveryPublication = () => "unbound";
    ports.cpuAdmissionReconcile = async () => {};
    ports.worktreeDiskWait = () => null;
    ports.scheduleTick = () => {};
    let lookups = 0;
    let repositoryWaiterReady;
    const repositoryWaiter = new Promise(resolve => { repositoryWaiterReady = resolve; });
    ports.provisionExec = async (command, args) => {
      if (args.includes("--git-common-dir")) {
        if (++lookups === 2) repositoryWaiterReady();
        return { code: 0, stdout: "/fixture/common.git", stderr: "" };
      }
      if (args[0] === "worktree" && args[1] === "add" && process.argv[1] === "hold") {
        await repositoryWaiter;
        await new Promise(resolve => setImmediate(resolve));
        // Three spare permits prove the second lane is outside capacity.
        for (let i = 0; i < 3; i++) if (!startPipelineControllerJob(
          "restart-capacity-" + i, () => new Promise(() => {}), async () => "unchanged", "provisioning"))
          throw new Error("repository waiter retained active capacity");
        console.log("provision-entered");
        await new Promise(() => {});
      }
      if (args[0] === "show-ref" || args.some(arg => arg.startsWith("refs/heads/")))
        return { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: args[0] === "rev-parse" ? "1".repeat(40) : "", stderr: "" };
    };
    await tickPipelinesController([], ports);
    await settlePipelineControllerJobs();
  `;
  const child = spawn(process.execPath, ["-e", source, "hold"], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  const entered = latch();
  child.stdout!.on("data", data => { if (String(data).includes("provision-entered")) entered.resolve(); });
  try {
    await until(entered.promise);
    expect((await findControllerPipeline(lane.id))?.state).toBe("provisioning");
    expect((await findControllerPipeline(peer.id))?.state).toBe("provisioning");
  } finally { await stopFixtureProcess(child); }
  const resumed = Bun.spawn([process.execPath, "-e", source, "resume"],
    { env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([resumed.exited, new Response(resumed.stderr).text()]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect((await findControllerPipeline(lane.id))?.state).toBe("running");
  expect((await findControllerPipeline(peer.id))?.state).toBe("running");
});

test("provisioning job admission is bounded separately and returns capacity after settlement", async () => {
  const release = latch();
  try {
    for (let i = 0; i < 4; i++) expect(startPipelineControllerJob(
      `bounded-provision-${i}`, () => release.promise, async () => "unchanged", "provisioning")).toBe(true);
    expect(startPipelineControllerJob("fifth-provision", async () => {}, async () => "unchanged", "provisioning")).toBe(false);
    expect(startPipelineControllerJob("independent-settlement", () => release.promise, async () => "unchanged")).toBe(true);
    expect(startPipelineControllerJob("bounded-provision-0", async () => {}, async () => "unchanged", "provisioning")).toBe(false);
  } finally { release.resolve(); await settlePipelineControllerJobs(); }
  expect(startPipelineControllerJob("next-provision", async () => {}, async () => "unchanged", "provisioning")).toBe(true);
  await settlePipelineControllerJobs();
  expect(pipelineControllerJobLanes()).toEqual([]);
});

test.each(["resolve", "reject"] as const)("repository waiters reacquire bounded capacity after their wait: %s", async outcome => {
  const rejects = outcome === "reject";
  const predecessor = latch(), waiting = [latch(), latch()], resumed = [latch(), latch()];
  const finish = [latch(), latch()], active = Array.from({ length: 4 }, () => latch());
  const order: number[] = [], failures: unknown[] = [];
  const refusal = new Error("fixture predecessor refused");
  try {
    for (let i = 0; i < 2; i++) expect(startPipelineControllerJob(`repository-waiter-${i}`, async waitOutsideCapacity => {
      waiting[i]!.resolve();
      try { await waitOutsideCapacity(predecessor.promise.then(() => { if (rejects) throw refusal; })); }
      catch (error) { failures.push(error); }
      order.push(i); resumed[i]!.resolve();
      await finish[i]!.promise;
    }, async () => "unchanged", "provisioning")).toBe(true);
    await until(Promise.all(waiting.map(row => row.promise)));
    expect(pipelineControllerJobLanes()).toEqual(["repository-waiter-0", "repository-waiter-1"]);
    expect(startPipelineControllerJob("repository-waiter-0", async () => {}, async () => "unchanged", "provisioning")).toBe(false);
    for (let i = 0; i < active.length; i++) expect(startPipelineControllerJob(
      `active-repository-${i}`, () => active[i]!.promise, async () => "unchanged", "provisioning")).toBe(true);
    predecessor.resolve();
    await new Promise(resolve => setImmediate(resolve));
    expect(order).toEqual([]);
    active[0]!.resolve();
    await until(resumed[0]!.promise);
    expect(order).toEqual([0]);
    expect(startPipelineControllerJob("excess-active-repository", async () => {}, async () => "unchanged", "provisioning")).toBe(false);
    finish[0]!.resolve();
    await until(resumed[1]!.promise);
    expect(order).toEqual([0, 1]);
    expect(failures).toEqual(rejects ? [refusal, refusal] : []);
    expect(startPipelineControllerJob("excess-active-repository", async () => {}, async () => "unchanged", "provisioning")).toBe(false);
  } finally {
    predecessor.resolve();
    for (const row of [...active, ...finish]) row.resolve();
    await settlePipelineControllerJobs();
  }
  expect(startPipelineControllerJob("after-repository-wait", async () => {}, async () => "unchanged", "provisioning")).toBe(true);
  await settlePipelineControllerJobs();
  expect(pipelineControllerJobLanes()).toEqual([]);
});

test.each(["success", "failure", "pause", "remove", "branch", "owner"] as const)("repository-waiting provisioning rechecks authority after its predecessor: %s", change => withControllerAuditState(async () => {
  const h = harness();
  const lane = await create(h.ports, BUILD_ONLY as never, { repoDir: "/linked-a" });
  const peer = structuredClone(lane), unrelated = structuredClone(lane);
  for (const [row, id, repo] of [[peer, "linked-peer", "/linked-b"], [unrelated, "unrelated-peer", "/other-repo"]] as const) {
    row.id = id; row.repoDir = repo; row.delivery = undefined;
    Object.assign(row, pipelineIdentity(row.id, row.task, row.repoDir));
  }
  savePipelines([lane]);
  const entered = latch(), release = latch(), peerLookup = latch(), otherReady = latch();
  const unregister = registerPipelineTick(async () => {
    if ((await findControllerPipeline(unrelated.id))?.state === "running") otherReady.resolve();
  });
  const exec = h.ports.exec;
  let peerLookups = 0, peerCommands = 0, holding = false;
  h.ports.provisionExec = async (command, args, cwd) => {
    if (args.includes("--git-common-dir")) {
      if (cwd === peer.repoDir) { peerLookups++; peerLookup.resolve(); }
      return { code: 0, stdout: cwd === unrelated.repoDir ? "/other-common.git" : "/linked-common.git", stderr: "" };
    }
    if (cwd === peer.repoDir || cwd === peer.worktreeDir) peerCommands++;
    if (!holding && cwd === lane.repoDir && args[0] === "worktree" && args[1] === "add") {
      holding = true; entered.resolve(); await release.promise;
      if (change === "failure") return { code: 1, stdout: "", stderr: "fatal: fixture worktree refused" };
    }
    return exec(command, args, cwd);
  };
  try {
    await until(tickPipelinesController([], h.ports));
    // The worktree command runs under the common-directory owner. Admit the
    // contenders while that command is held and retain the selected cursor.
    await until(entered.promise);
    expect(pipelineControllerJobLanes()).toEqual([lane.id]);
    await withDeliveryMutationAsync(tx => { tx.put(peer); tx.put(unrelated); }, 2);
    await until(tickPipelinesController([], h.ports));
    await until(peerLookup.promise);
    await until(otherReady.promise);
    expect(pipelineControllerJobLanes()).toContain(peer.id);
    expect(peerLookups).toBe(1);
    expect(peerCommands).toBe(0);
    expect((await findControllerPipeline(peer.id))?.state).toBe("provisioning");
    expect((await findControllerPipeline(unrelated.id))?.state).toBe("running");
    if (["pause", "remove", "branch", "owner"].includes(change)) {
      const rows = loadPipelines(), current = rows.find(row => row.id === peer.id)!;
      if (change === "pause") { current.state = "paused"; current.pausedState = "provisioning"; }
      if (change === "branch") {
        current.task += " edited";
        Object.assign(current, pipelineIdentity(current.id, current.task, current.repoDir));
      }
      if (change === "owner") {
        current.delivery = structuredClone(lane.delivery);
        current.delivery!.ownerId = current.id; current.delivery!.epoch++;
        current.delivery!.target.branch = `refs/heads/${current.branch}`;
      }
      savePipelines(change === "remove" ? rows.filter(row => row.id !== peer.id) : rows);
    }
  } finally { release.resolve(); await settlePipelineControllerJobs(); unregister(); }
  const current = await findControllerPipeline(peer.id);
  if (change === "success" || change === "failure") {
    expect(peerCommands).toBeGreaterThan(0);
    expect(current?.state).toBe("running");
    if (change === "failure") expect((await findControllerPipeline(lane.id))?.state).toBe("needs_decision");
  } else {
    expect(peerCommands).toBe(0);
    if (change === "remove") expect(current).toBeNull();
    else expect(current?.state).toBe(change === "pause" ? "paused" : "provisioning");
  }
}), 10_000);

test("four linked provisioning lanes leave capacity for a later independent launch", async () => {
  const h = harness();
  const lane = await create(h.ports, BUILD_ONLY as never, { repoDir: "/linked-0" });
  const linked = [lane, ...Array.from({ length: 3 }, (_, i) => {
    const row = structuredClone(lane);
    row.id = `linked-${i + 1}`; row.repoDir = `/linked-${i + 1}`; row.delivery = undefined;
    Object.assign(row, pipelineIdentity(row.id, row.task, row.repoDir));
    return row;
  })];
  savePipelines(linked);
  const entered = latch(), release = latch(), linkedLookups = latch(), independentReady = latch();
  let independent: typeof lane | undefined, lookups = 0, linkedCommands = 0, holding = false;
  const unregister = registerPipelineTick(async () => {
    if (independent && (await findControllerPipeline(independent.id))?.state === "running") independentReady.resolve();
  });
  const exec = h.ports.exec;
  h.ports.exec = (command, args, cwd, env, options) => {
    if (independent && cwd === independent.worktreeDir) {
      if (args[0] === "branch" && args[1] === "--show-current") return { code: 0, stdout: independent.branch, stderr: "" };
      if (args[0] === "symbolic-ref") return { code: 0, stdout: `refs/heads/${independent.branch}`, stderr: "" };
    }
    return exec(command, args, cwd, env, options);
  };
  h.ports.provisionExec = async (command, args, cwd) => {
    if (args.includes("--git-common-dir")) {
      if (linked.some(row => row.repoDir === cwd) && ++lookups === 4) linkedLookups.resolve();
      return { code: 0, stdout: cwd === independent?.repoDir ? "/independent.git" : "/linked.git", stderr: "" };
    }
    if (linked.some(row => row.repoDir === cwd || row.worktreeDir === cwd)) {
      linkedCommands++;
      if (!holding) { holding = true; entered.resolve(); await release.promise; }
    }
    return exec(command, args, cwd);
  };
  try {
    await until(tickPipelinesController([], h.ports));
    await until(entered.promise);
    await until(linkedLookups.promise);
    const created = await createPipelineFromRequest({ task: "Independent lane", spec: "Provision beside a held repository", repoDir: "/independent", stages: BUILD_ONLY as never, publication: "internal" }, h.ports);
    expect(created.pipeline).toBeDefined();
    independent = created.pipeline!;
    await until(tickPipelinesController([], h.ports));
    await until(independentReady.promise);
    await until(tickPipelinesController([], h.ports));
    await until(tickPipelinesController([], h.ports));
    expect(h.spawnInputs.filter(input => input.cwd === independent!.worktreeDir)).toHaveLength(1);
    expect(linkedCommands).toBe(1);
    for (const row of linked) expect((await findControllerPipeline(row.id))?.state).toBe("provisioning");
    expect(lookups).toBe(4);
  } finally { release.resolve(); await settlePipelineControllerJobs(); unregister(); }
  for (const row of linked) expect((await findControllerPipeline(row.id))?.state).toBe("running");
  expect(pipelineControllerJobLanes()).toEqual([]);
});
