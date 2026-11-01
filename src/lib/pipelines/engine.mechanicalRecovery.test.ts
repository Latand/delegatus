import { expect, test, harness, tickPipelines, reserveActivationOnly, loadPipelines, savePipelines,
  create, BUILD_ONLY, realWorktreeLane, realExec, fs, path, spawn, engineModule, publishHarness } from "./engine.fixture";
import type { Pipeline } from "./types";
import { tickPipelinesController } from "./controllerPass";
import { pipelineControllerJobLanes, settlePipelineControllerJobs, startPipelineControllerJob, waitForPipelineControllerJob } from "./controllerJobs";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { SqliteStateCollection } from "@/lib/state/sqliteStateStore";
import { pipelineArtifactsDir } from "./store";
import { ownFixtureTree, stopFixtureTree } from "@/lib/testing/fixtureProcess";
import { spyOn } from "bun:test";

// Every observation starts a new interpreter against the writer's real store.
async function restartedTick(now: string, mode = "spawn", repo?: string, pipelineId?: string) {
  const child = ownFixtureTree(spawn(process.execPath, ["test", "--timeout=60000", import.meta.path, "-t", "restart observation"], { cwd: process.cwd(),
    env: { ...process.env, MECHANICAL_STATE: process.env.LLV_STATE_DIR, MECHANICAL_NOW: now,
      MECHANICAL_MODE: mode, MECHANICAL_REPO: repo, MECHANICAL_PIPELINE_ID: pipelineId },
    stdio: ["ignore", "pipe", "pipe"] }));
  let stdout = "", stderr = "";
  child.stdout!.on("data", chunk => { stdout += chunk; });
  child.stderr!.on("data", chunk => { stderr = (stderr + chunk).slice(-8192); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([
      new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`restart did not finish: ${stderr}`)), 30_000); }),
    ]);
    expect(code, stderr).toBe(0);
    return JSON.parse(stdout.trim().split("\n").at(-1)!) as { lane: Pipeline; spawns: unknown[]; publicationOrder?: string[] };
  } finally { clearTimeout(timer); await stopFixtureTree(child); }
}

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

test.skipIf(process.platform === "win32").each(["settles", "exhausts", "invalid-receipt", "authority-exhausts",
  "authority-paused", "authority-peer", "authority-unreadable", "authority-note-failure"] as const)("real cancelled Git commits retain their retry cap across process restarts: %s", async outcome => {
  const authority = outcome.startsWith("authority-");
  const cancelMode = authority ? "commit-authority-cancel" : "commit-cancel";
  const refusedPark = ["authority-paused", "authority-peer", "authority-unreadable"].includes(outcome);
  const exhausted = outcome === "exhausts" || authority;
  const invalidReceipt = outcome === "invalid-receipt";
  const parked = exhausted && !refusedPark || invalidReceipt;
  savePipelines([]);
  const fixture = await realWorktreeLane("cancelled commit recovery", [{ id: "study", kind: "run",
    role: { roleId: "architect" }, access: "read-only", prompt: "Write the declared output",
    outputs: ["result.txt"], next: null }]);
  try {
    const lane = loadPipelines()[0]!;
    fs.writeFileSync(path.join(fixture.worktree, "result.txt"), "preserved result\n");
    fs.mkdirSync(path.join(fixture.repo, ".git", "hooks"), { recursive: true });
    fs.writeFileSync(path.join(fixture.repo, ".git", "hooks", "pre-commit"),
      '#!/bin/sh\nprintf ready > "$(git rev-parse --git-common-dir)/mechanical-hook-ready"\nexec sleep 60\n', { mode: 0o755 });
    lane.cursor!.state = "committing";
    Object.assign(lane.runs[0]!.attempts[0]!, { state: "committing", verdict: { status: "pass" } });
    savePipelines([lane]);
    let now = Date.parse("2026-10-29T08:48:00.000Z");
    let receipt: string | undefined;
    const delays = invalidReceipt ? [30_000] : [30_000, 60_000, 120_000, 240_000];
    for (const [n, delay] of delays.entries()) {
      const retry = await restartedTick(new Date(now).toISOString(), cancelMode, fixture.repo, fixture.id);
      expect(retry.lane.state).toBe("running");
      expect(retry.lane.lastPassedCommit).toBe(lane.lastPassedCommit);
      expect(retry.lane.runs[0]!.attempts[0]!.stageCommitWait?.failures).toBe(n + 1);
      expect(retry.lane.runs[0]!.attempts[0]!.commitRepair).toBeUndefined();
      expect(retry.spawns).toHaveLength(0);
      const files = fs.readdirSync(pipelineArtifactsDir(lane.id)).filter(file => /^stage-commit-.*\.json$/.test(file));
      expect(files).toHaveLength(1);
      const nextReceipt = fs.readFileSync(path.join(pipelineArtifactsDir(lane.id), files[0]!), "utf8");
      receipt ??= nextReceipt;
      expect(nextReceipt).toBe(receipt);
      now += delay;
    }
    if (!exhausted) fs.writeFileSync(path.join(fixture.repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const receiptPath = path.join(pipelineArtifactsDir(lane.id), fs.readdirSync(pipelineArtifactsDir(lane.id)).find(file => /^stage-commit-.*\.json$/.test(file))!);
    if (invalidReceipt) fs.writeFileSync(receiptPath, "{}\n");
    const finalMode = outcome === "authority-paused" ? "commit-authority-pause"
      : outcome === "authority-peer" ? "commit-authority-peer"
        : outcome === "authority-unreadable" ? "commit-authority-unreadable"
          : outcome === "authority-note-failure" ? "commit-authority-note" : exhausted ? cancelMode : "commit-free";
    const final = await restartedTick(new Date(now).toISOString(), finalMode, fixture.repo, fixture.id);
    expect(final.lane.state).toBe(outcome === "authority-paused" ? "paused" : refusedPark ? "running" : parked ? "needs_decision" : "completed");
    expect(final.lane.runs[0]!.attempts[0]!.verdict?.status).toBe("pass");
    if (exhausted && !refusedPark) {
      expect(final.lane.stateDetail).toContain("after 4 automatic retries");
      expect(final.lane.runs[0]!.attempts[0]!.stageCommitWait?.failures).toBe(5);
    }
    if (refusedPark) expect(final.lane.runs[0]!.attempts[0]!.stageCommitWait?.failures).toBe(4);
    if (invalidReceipt) {
      expect(final.lane.stateDetail).toContain("ownership receipt could not be verified");
      expect(fs.readFileSync(receiptPath, "utf8")).toBe("{}\n");
    }
    expect(await fixture.git(fixture.worktree, "rev-list", "--count", `${fixture.base}..HEAD`)).toBe(parked || refusedPark ? "0" : "1");
    fs.writeFileSync(path.join(fixture.repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const after = await restartedTick(new Date(now + 24 * 60 * 60_000).toISOString(), "commit-free", fixture.repo, fixture.id);
    expect(after.lane.state).toBe(outcome === "authority-paused" ? "paused" : parked ? "needs_decision" : "completed");
    expect(after.spawns).toHaveLength(0);
    if (outcome === "authority-exhausts") {
      const manualAt = new Date(now + 24 * 60 * 60_000).toISOString();
      const ports = { ...fixture.h.ports, exec: realExec, now: () => manualAt };
      expect((await engineModule.patchPipeline(fixture.id, { action: "retry-stage" }, ports)).error).toBeUndefined();
      const resumed = await restartedTick(manualAt, "commit-manual", fixture.repo, fixture.id);
      expect(resumed.lane.state).toBe("completed");
      expect(resumed.lane.runs[0]!.attempts).toHaveLength(1);
      expect(resumed.spawns).toHaveLength(0);
      expect(fs.readFileSync(receiptPath, "utf8")).toBe(receipt!);
      expect(await fixture.git(fixture.worktree, "rev-list", "--count", `${fixture.base}..HEAD`)).toBe("1");
    }
    expect(await fixture.git(fixture.worktree, "rev-list", "--count", `${fixture.base}..HEAD`)).toBe(
      parked && outcome !== "authority-exhausts" || outcome === "authority-paused" ? "0" : "1");
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
}, 240_000);

test.skipIf(process.platform === "win32")("the production authority signal cancels a real commit and retains its mechanical retry", async () => {
  const fixture = await realWorktreeLane("authority cancellation recovery", [{ id: "study", kind: "run",
    role: { roleId: "architect" }, access: "read-only", prompt: "Write the declared output",
    outputs: ["result.txt"], next: null }]);
  const { h } = fixture;
  const ownership = await import("./stageBranch");
  const buildReader = ownership.stageBranchOwnershipReader;
  let rejectNext = false, armed = false, rejected = 0, cancelled = 0;
  const readerSpy = spyOn(ownership, "stageBranchOwnershipReader").mockImplementation(id => {
    const reader = buildReader(id), read = reader.read;
    reader.read = async () => {
      if (id === fixture.id && rejectNext) { rejectNext = false; rejected++; throw new Error("authority read interrupted"); }
      return read();
    };
    return reader;
  });
  const cleanup = new AbortController();
  const watchdog = setTimeout(() => cleanup.abort(), 30_000);
  const root = path.join(fixture.repo, ".git");
  fs.mkdirSync(path.join(root, "hooks"), { recursive: true });
  const watcher = fs.watch(root, (_event, name) => {
    if (!armed && String(name) === "mechanical-hook-ready") { armed = true; rejectNext = true; }
  });
  try {
    const lane = loadPipelines()[0]!;
    let now = Date.parse(h.ports.now());
    h.ports.now = () => new Date(now).toISOString();
    fs.writeFileSync(path.join(fixture.worktree, "result.txt"), "preserved result\n");
    fs.writeFileSync(path.join(root, "hooks", "pre-commit"),
      '#!/bin/sh\nprintf ready > "$(git rev-parse --git-common-dir)/mechanical-hook-ready"\nexec sleep 60\n', { mode: 0o755 });
    lane.cursor!.state = "committing";
    Object.assign(lane.runs[0]!.attempts[0]!, { state: "committing", verdict: { status: "pass" } });
    savePipelines([lane]);
    h.ports.exec = async (command, args, cwd, env, options) => {
      const result = await realExec(command, args, cwd, env, { ...options,
        signal: options?.signal ? AbortSignal.any([options.signal, cleanup.signal]) : cleanup.signal });
      if (args[0] === "commit" && result.stderr === "command cancelled") {
        expect(options?.signal?.aborted).toBe(true);
        cancelled++;
      }
      return result;
    };
    await tickPipelinesController([], h.ports); await settlePipelineControllerJobs();
    expect(rejected).toBe(1);
    expect(cancelled).toBe(1);
    const waiting = loadPipelines()[0]!;
    expect(waiting.runs[0]!.attempts[0]!.stageCommitWait?.failures).toBe(1);
    expect(waiting.runs[0]!.attempts[0]!.commitRepair).toBeUndefined();
    expect(waiting.lastPassedCommit).toBe(lane.lastPassedCommit);
    fs.writeFileSync(path.join(root, "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    now += 30_000;
    await tickPipelinesController([], h.ports); await settlePipelineControllerJobs();
    expect(loadPipelines()[0]!.state).toBe("completed");
    expect(h.spawnInputs).toHaveLength(1);
    expect(await fixture.git(fixture.worktree, "rev-list", "--count", `${fixture.base}..HEAD`)).toBe("1");
  } finally {
    cleanup.abort(); clearTimeout(watchdog); watcher.close();
    await settlePipelineControllerJobs(); readerSpy.mockRestore();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}, 120_000);

async function interruptedBeforeReservation() {
  await reserveActivationOnly();
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  // The historical writer checkpointed spawning before it counted any call.
  attempt.state = "spawning";
  attempt.startedAt = "2026-10-29T08:47:16.000Z";
  delete attempt.activation;
  delete attempt.spawnCalls;
  lane.cursor!.state = "spawning";
  savePipelines([lane]);
  return lane;
}

test("a launch interrupted before reservation retries after restart without another attempt", async () => {
  const lane = await interruptedBeforeReservation();
  const waited = await restartedTick("2026-10-29T08:48:00.000Z");
  expect(waited.lane.state).toBe("running");
  expect(waited.spawns).toHaveLength(0);
  expect(waited.lane.stateDetail).toContain("retry");
  const early = await restartedTick("2026-10-29T08:48:59.999Z");
  expect(early.spawns).toHaveLength(0);
  const recovered = await restartedTick("2026-10-29T08:49:00.000Z");
  expect(recovered.spawns).toHaveLength(1);
  expect(recovered.lane.runs[0]!.attempts).toHaveLength(1);
  expect(recovered.lane.runs[0]!.attempts[0]!.state).toBe("running");
  expect(recovered.lane.lastPassedCommit).toBe(lane.lastPassedCommit);
}, 240_000);

test("three interrupted launch retries retain their cap through real process restarts", async () => {
  await interruptedBeforeReservation();
  let now = Date.parse("2026-10-29T08:48:00.000Z");
  for (const delay of [60_000, 5 * 60_000, 15 * 60_000]) {
    const waiting = await restartedTick(new Date(now).toISOString());
    expect(waiting.lane.state).toBe("running");
    expect(waiting.spawns).toHaveLength(0);
    now += delay;
    const lane = loadPipelines()[0]!;
    lane.runs[0]!.attempts[0]!.state = "spawning";
    lane.runs[0]!.attempts[0]!.startedAt = new Date(now).toISOString();
    lane.cursor!.state = "spawning";
    savePipelines([lane]);
  }
  const parked = await restartedTick(new Date(now).toISOString());
  expect(parked.lane.state).toBe("needs_decision");
  expect(parked.lane.stateDetail).toContain("after 3 automatic retries");
  expect(parked.spawns).toHaveLength(0);
  const after = await restartedTick(new Date(now + 24 * 60 * 60_000).toISOString());
  expect(after.lane.state).toBe("needs_decision");
  expect(after.spawns).toHaveLength(0);
}, 240_000);

test("a counted launch without its receipt remains an uncertain stop", async () => {
  await interruptedBeforeReservation();
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.spawnCalls = 1;
  savePipelines([lane]);
  const result = await restartedTick("2026-10-29T08:48:00.000Z");
  expect(result.lane.state).toBe("needs_decision");
  expect(result.spawns).toHaveLength(0);
});

test.each(["report", "verdict", "output", "empty-output", "completed", "refusal"] as const)("preserved stage evidence prevents an interrupted launch retry: %s", async evidence => {
  const h = harness();
  const now = "2026-10-29T08:48:00.000Z";
  h.ports.now = () => now;
  await create(h.ports, BUILD_ONLY as never);
  await tickPipelines([], h.ports); await tickPipelines([], h.ports);
  const launched = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect((await engineModule.reportStageCompletion({ verdict: "pass", summary: "Preserved work" },
    { kind: "agent", role: "builder", conversationId: launched.conversationId }, h.ports)).error).toBeUndefined();
  const lane = loadPipelines()[0]!, attempt = lane.runs[0]!.attempts[0]!;
  const report = attempt.report!;
  if (evidence !== "report") delete attempt.report;
  attempt.verdict = evidence === "verdict" ? report.verdict : null;
  attempt.output = evidence === "output" ? report.summary! : evidence === "empty-output" ? "" : null;
  attempt.completedAt = evidence === "completed" ? now : null;
  attempt.error = evidence === "refusal" ? "privacy refused result.txt" : null;
  attempt.state = "spawning"; attempt.startedAt = now;
  attempt.launchId = null; attempt.conversationId = null; attempt.sessionId = null;
  attempt.agentPath = null; attempt.paneId = null;
  delete attempt.activation; delete attempt.spawnCalls;
  lane.cursor!.state = "spawning";
  savePipelines([lane]);
  const stopped = await restartedTick(now);
  expect(stopped.lane.state).toBe("needs_decision");
  expect(stopped.lane.runs[0]!.attempts[0]!.spawnInterruptionRetry).toBeUndefined();
  expect(stopped.spawns).toHaveLength(0);
  expect(stopped.lane.runs[0]!.attempts).toHaveLength(1);
  expect(stopped.lane.lastPassedCommit).toBe(lane.lastPassedCommit);
  if (evidence === "report") expect(stopped.lane.runs[0]!.attempts[0]!.report?.summary).toBe(report.summary);
  if (evidence === "verdict") expect(stopped.lane.runs[0]!.attempts[0]!.verdict?.status).toBe("pass");
  if (evidence === "output" || evidence === "empty-output") expect(stopped.lane.runs[0]!.attempts[0]!.output).toBe(attempt.output);
  if (evidence === "refusal") expect(stopped.lane.stateDetail).toContain("privacy refused result.txt");
}, 120_000);

test.each((["valid", "engine", "cwd", "member", "duplicate"] as const)
  .flatMap(kind => [0, 3, 127].map(call => ({ kind, call }))))
("an interrupted uncounted launch checks its admitted receipt before any retry: $kind, key $call", async ({ kind, call }) => {
  const h = await reserveActivationOnly();
  h.ports.now = () => "2026-10-29T08:48:00.000Z";
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  const input = attempt.activation!.input;
  const clientAttemptId = call === 0 ? input.clientAttemptId : `handshake_retry_${call}_${input.clientAttemptId}`.slice(0, 128);
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "mechanical-registry.json"));
  setAgentRegistryForTests(registry);
  h.ports.spawnReceipt = engineModule.defaultPipelinePorts().spawnReceipt;
  try {
    const begun = beginLegacySpawnFixture(registry, { engine: kind === "engine" ? "codex" : input.role.engine,
      cwd: kind === "cwd" ? input.cwd + "/foreign" : input.cwd,
      clientAttemptId, transport: "structured",
      memberships: [{ ...input.membership, ...(kind === "member" ? { containerId: "foreign-lane" } : {}) }] });
    if (begun.kind !== "created") throw new Error("receipt was not admitted");
    if (kind === "duplicate") {
      const second = beginLegacySpawnFixture(registry, { engine: input.role.engine, cwd: input.cwd,
        clientAttemptId: `handshake_retry_1_${input.clientAttemptId}`, transport: "structured", memberships: [input.membership] });
      expect(second.kind).toBe("created");
    }
    delete attempt.activation; delete attempt.spawnCalls;
    savePipelines([lane]);
    await tickPipelines([], h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.launchId).toBe(kind === "valid" ? begun.receipt.launchId : null);
    if (kind !== "valid") expect(loadPipelines()[0]!.stateDetail).toContain("conflicting launch evidence");
    h.ports.now = () => "2026-10-29T08:49:01.000Z";
    await tickPipelines([], h.ports);
    expect(h.spawnInputs).toHaveLength(0);
    // A bound starting receipt keeps the existing evidence-wait budget.
    // Even after that budget expires it must park without a replacement.
    h.ports.now = () => "2026-10-29T09:00:00.000Z";
    await tickPipelines([], h.ports);
    const held = loadPipelines()[0]!;
    expect(held.state).toBe("needs_decision");
    expect(held.runs[0]!.attempts).toHaveLength(1);
    expect(held.runs[0]!.attempts[0]!.spawnInterruptionRetry).toBeUndefined();
    expect(h.spawnInputs).toHaveLength(0);
    expect(registry.spawnReceiptForClientAttempt(clientAttemptId)).toMatchObject({ launchId: begun.receipt.launchId, state: "starting" });
  } finally { registry.close(); setAgentRegistryForTests(null); }
});

test("the first spawning checkpoint already contains the restartable activation", async () => {
  const h = harness();
  await create(h.ports, BUILD_ONLY as never);
  await tickPipelines([], h.ports);
  const prototype = SqliteStateCollection.prototype as InstanceType<typeof SqliteStateCollection<Pipeline>>;
  const original = prototype.reconcileSnapshot;
  let checkpoint: Pipeline | undefined;
  prototype.reconcileSnapshot = function<R>(operation: (records: Pipeline[], persist: (records?: readonly Pipeline[]) => Promise<void>, assertCurrent: (record: Pipeline) => void) => Promise<R> | R,
    ...args: [observeHold?: (heldMs: number) => void, explicitOnly?: boolean, keys?: readonly string[]]): Promise<R> {
    return original.call(this, (records, persist, assertCurrent) => operation(records, async changed => {
      await persist(changed);
      const row = loadPipelines()[0];
      if (!checkpoint && row?.cursor?.state === "spawning") {
        checkpoint = structuredClone(row);
        throw new Error("restart at the first spawning checkpoint");
      }
    }, assertCurrent), ...args) as Promise<R>;
  };
  try { await tickPipelines([], h.ports).catch(() => {}); }
  finally { prototype.reconcileSnapshot = original; }
  expect(checkpoint?.runs[0]!.attempts[0]!.activation?.phase).toBe("reserved");
  expect(h.spawnInputs).toHaveLength(0);
});
