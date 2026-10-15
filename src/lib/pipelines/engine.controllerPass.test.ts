import { expect, test, harness, create, BUILD_ONLY, loadPipelines, savePipelines, tickPipelines, pipelineIdentity, publishHarness, Database, path, fs, spawn, realWorktreeLane, stopFixtureProcess, defaultPipelinePorts, crypto, registerPipelineTick } from "./engine.fixture";
import { FlowPipelineController, type FlowPipelineControllerHeartbeat } from "./controller";
import { tickPipelinesController } from "./controllerPass";
import { pipelineControllerJobLanes, settlePipelineControllerJobs, startPipelineControllerJob, takePipelineControllerJobChanges } from "./controllerJobs";
import { acknowledgePipelineControllerWork, archiveSettledPipelines, controllerPipelineVersion, findControllerPipeline, pipelineControllerReady, selectControllerPipelines, selectPipelineControllerWork, withPipelineMutation } from "./store";
import { SqliteStateCollection } from "@/lib/state/sqliteStateStore";
import { spyOn } from "bun:test";
import { performanceSpans, performanceSites } from "@/lib/performanceSpans";
import { instanceCpuAdmissionFile, instanceCpuAdmissionQueue } from "@/lib/runtime/cpuAdmissionScope";
import { stateDir } from "@/lib/configDir";
import { withControllerPipelineScope } from "./controllerScope";

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
    tickPipelines: files => tickPipelinesController(files, h.ports), tickFlows: async () => ({ changed: false }),
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
}, 30_000);

test.each(["branch", "repository", "claim", "release", "remove", "archive", "progress"] as const)("a %s peer change retains stage-job authority fences", async change => {
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

test("selectors share immutable decoded hosts by revision and detach mutations", async () => {
  const { lane } = await committing();
  const first = await selectControllerPipelines("hosts"), second = await selectControllerPipelines("hosts");
  expect(first[0]).toBe(second[0]);
  await withPipelineMutation(async (rows, persist) => { rows[0]!.stateDetail = "changed"; await persist([rows[0]!]); });
  expect(first[0]!.stateDetail).not.toBe("changed");
  const third = await selectControllerPipelines("hosts");
  expect(third[0]).not.toBe(first[0]);
  expect(third[0]!.id).toBe(lane.id);
  expect(third[0]!.stateDetail).toBe("changed");
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
      state: "failed", launchId: null, verdict: { status: "fail" }, completedAt: peer.closedAt, output: "retained evidence ".repeat(256) })) })); peer.delivery = undefined; peer.publication = "internal";
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
  const history = Array.from({ length: 33 }, (_, index) => ({ ...structuredClone(current), n: index + 1, historical: true,
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
