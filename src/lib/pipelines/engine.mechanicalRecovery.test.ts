import { expect, test, harness, tickPipelines, reserveActivationOnly, loadPipelines, savePipelines,
  create, BUILD_ONLY, realWorktreeLane, realExec, fs, path, spawn, engineModule } from "./engine.fixture";
import type { Pipeline } from "./types";
import { tickPipelinesController } from "./controllerPass";
import { settlePipelineControllerJobs, startPipelineControllerJob } from "./controllerJobs";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { SqliteStateCollection } from "@/lib/state/sqliteStateStore";
import { pipelineArtifactsDir } from "./store";
import { ownFixtureTree, stopFixtureTree } from "@/lib/testing/fixtureProcess";
import { spyOn } from "bun:test";

// Every observation starts a new interpreter against the writer's real store.
async function restartedTick(now: string, mode = "spawn", repo?: string) {
  const child = ownFixtureTree(spawn(process.execPath, ["test", "--timeout=60000", import.meta.path, "-t", "restart observation"], { cwd: process.cwd(),
    env: { ...process.env, MECHANICAL_STATE: process.env.LLV_STATE_DIR, MECHANICAL_NOW: now,
      MECHANICAL_MODE: mode, MECHANICAL_REPO: repo },
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
    return JSON.parse(stdout.trim().split("\n").at(-1)!) as { lane: Pipeline; spawns: unknown[] };
  } finally { clearTimeout(timer); await stopFixtureTree(child); }
}

if (process.env.MECHANICAL_STATE) test("restart observation", async () => {
  const fixtureState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = process.env.MECHANICAL_STATE;
  try {
    const h = harness();
    h.ports.now = () => process.env.MECHANICAL_NOW!;
    const mode = process.env.MECHANICAL_MODE!;
    if (mode.startsWith("commit")) {
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
    if (mode.startsWith("settlement")) {
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      try {
        if (mode === "settlement-block") for (let n = 0; n < 4; n++) {
          expect(startPipelineControllerJob(`blocked-settlement-${n}`, () => held, async () => "unchanged")).toBe(true);
        }
        await tickPipelinesController([], h.ports);
      } finally { release(); await settlePipelineControllerJobs(); }
    } else await tickPipelines([], h.ports);
    console.log(JSON.stringify({ lane: loadPipelines()[0], spawns: h.spawnInputs }));
  } finally { process.env.LLV_STATE_DIR = fixtureState; }
});

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
}, 240_000);

test.skipIf(process.platform === "win32").each(["settles", "exhausts", "invalid-receipt"] as const)("real cancelled Git commits retain their retry cap across process restarts: %s", async outcome => {
  const exhausted = outcome === "exhausts";
  const invalidReceipt = outcome === "invalid-receipt";
  const parked = exhausted || invalidReceipt;
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
      const retry = await restartedTick(new Date(now).toISOString(), "commit-cancel", fixture.repo);
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
    const final = await restartedTick(new Date(now).toISOString(), exhausted ? "commit-cancel" : "commit-free", fixture.repo);
    expect(final.lane.state).toBe(parked ? "needs_decision" : "completed");
    expect(final.lane.runs[0]!.attempts[0]!.verdict?.status).toBe("pass");
    if (exhausted) expect(final.lane.stateDetail).toContain("after 4 automatic retries");
    if (invalidReceipt) {
      expect(final.lane.stateDetail).toContain("ownership receipt could not be verified");
      expect(fs.readFileSync(receiptPath, "utf8")).toBe("{}\n");
    }
    expect(await fixture.git(fixture.worktree, "rev-list", "--count", `${fixture.base}..HEAD`)).toBe(parked ? "0" : "1");
    fs.writeFileSync(path.join(fixture.repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const after = await restartedTick(new Date(now + 24 * 60 * 60_000).toISOString(), "commit-free", fixture.repo);
    expect(after.lane.state).toBe(parked ? "needs_decision" : "completed");
    expect(after.spawns).toHaveLength(0);
    expect(await fixture.git(fixture.worktree, "rev-list", "--count", `${fixture.base}..HEAD`)).toBe(parked ? "0" : "1");
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

test.each(["valid", "engine", "cwd", "member", "duplicate"] as const)("an interrupted uncounted launch checks its admitted receipt before any retry: %s", async kind => {
  const h = await reserveActivationOnly();
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  const input = attempt.activation!.input;
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "mechanical-registry.json"));
  setAgentRegistryForTests(registry);
  try {
    const begun = beginLegacySpawnFixture(registry, { engine: kind === "engine" ? "codex" : input.role.engine,
      cwd: kind === "cwd" ? input.cwd + "/foreign" : input.cwd,
      clientAttemptId: input.clientAttemptId, transport: "structured",
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
    expect(h.spawnInputs).toHaveLength(0);
    expect(registry.spawnReceiptForClientAttempt(input.clientAttemptId)?.launchId).toBe(begun.receipt.launchId);
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
