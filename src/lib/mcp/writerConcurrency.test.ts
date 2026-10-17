import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readStateCollectionRows } from "@/lib/state/sqliteStateStore";
import { ownFixtureChild, reapFixtureChildren } from "./ownedFixtureChildren";

const sandboxes: string[] = [];

afterEach(async () => {
  await reapFixtureChildren();
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});
afterAll(reapFixtureChildren);

test.skipIf(!process.env.MCP_SQL_OBSERVER)("native SQL observer reconciles handles, explicit/autocommit/empty commits, rollback and successful/failed waits", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-sql-observer-control-"));
  sandboxes.push(root);
  const database = path.join(root, "control.sqlite");
  let overheadSample = 0;
  const run = (mode: string, observed = true, holdMs = 600) => {
    const suffix = mode === "overhead" ? `-${++overheadSample}` : "";
    const events = path.join(root, `${mode}${suffix}.ndjson`);
    const ready = path.join(root, `${mode}.ready`);
    const child = ownFixtureChild(Bun.spawn({
      cmd: [process.execPath, ...(observed ? ["--preload", path.resolve("scripts/sqlite-observer.ts")] : []), path.join(import.meta.dir, "writerConcurrencyChild.ts")],
      env: { ...process.env, LLV_STATE_DIR: root, MCP_BENCH_SCRATCH_ROOT: path.dirname(root), MCP_SQL_OBSERVER: observed ? process.env.MCP_SQL_OBSERVER : undefined, MCP_SQL_EVENTS: observed ? events : undefined, LLV_WRITER_OBSERVER_CONTROL: mode,
        LLV_WRITER_DATABASE: mode === "overhead" ? path.join(root, `overhead-${overheadSample}.sqlite`) : database,
        LLV_WRITER_READY: ready, LLV_WRITER_HOLD_MS: String(holdMs) },
      stdout: "pipe", stderr: "pipe",
    }));
    const stderr = new Response(child.stderr).text();
    const stdout = new Response(child.stdout).text();
    return { child, ready, events, stdout, done: async () => {
      const code = await child.exited;
      if (code !== 0) throw new Error(await stderr);
      return fs.existsSync(events) ? fs.readFileSync(events, "utf8").trim().split("\n").map(line => JSON.parse(line) as { event: string; value: number }) : [];
    } };
  };
  const initial = await run("transactions").done();
  const count = (events: typeof initial, event: string) => events.filter(row => row.event === event).length;
  expect(count(initial, "open")).toBe(3);
  expect(count(initial, "close")).toBe(3);
  expect(initial.filter(row => row.event === "open").map(row => row.value)).toEqual([0, 1, 1]);
  expect(count(initial, "commit")).toBe(4);
  expect(count(initial, "rollback")).toBe(1);
  expect(count(initial, "begin")).toBe(3);
  const locker = run("lock", false);
  await waitFor(locker.ready);
  const waited = await run("wait").done();
  await locker.done();
  expect(count(waited, "commit")).toBe(1);
  expect(count(waited, "sqlite-sleep-ns")).toBeGreaterThan(0);
  fs.unlinkSync(locker.ready);
  const nextLocker = run("lock", false);
  await waitFor(nextLocker.ready);
  const refused = await run("refuse").done();
  await nextLocker.done();
  expect(count(refused, "commit")).toBe(0);
  expect(count(refused, "sqlite-sleep-ns")).toBeGreaterThan(0);
  expect(fs.readFileSync(path.join(root, "refuse.ndjson.js"), "utf8")).toContain('"event":"busy-result"');
  const lease = run("lease-hold", true, 800);
  await waitFor(lease.ready);
  const leaseWaiter = run("lease-wait");
  const leaseEvents = await leaseWaiter.done();
  const heldEvents = await lease.done() as Array<{ event: string; value: number; sql?: string; atNs?: number }>;
  const acquire = heldEvents.findIndex(row => row.event === "lease-statement" && /^\s*INSERT INTO state_leases/.test(row.sql ?? ""));
  const release = heldEvents.findIndex((row, index) => index > acquire && row.event === "lease-statement" && /^\s*DELETE FROM state_leases/.test(row.sql ?? ""));
  const acquiredAt = heldEvents.slice(acquire + 1).find(row => row.event === "commit")!.atNs!;
  const releasedAt = heldEvents.slice(release + 1).find(row => row.event === "commit")!.atNs!;
  expect(acquire).toBeGreaterThan(-1);
  expect(release).toBeGreaterThan(acquire);
  expect((releasedAt - acquiredAt) / 1e6).toBeGreaterThanOrEqual(750);
  expect(count(leaseEvents, "sqlite-sleep-ns")).toBe(0);
  const leaseJs = fs.readFileSync(`${leaseWaiter.events}.js`, "utf8");
  expect(leaseJs).toContain('"event":"lease-held-refusal"');
  expect(leaseJs).toContain('"event":"lease-acquired"');
  const overhead: Array<{ observed: boolean; iterations: number; elapsedMs: number }> = [];
  for (let repeat = 0; repeat < 3; repeat++) for (const observed of repeat % 2 ? [true, false] : [false, true]) {
    const sample = run("overhead", observed);
    const events = await sample.done();
    if (observed) expect(count(events, "domain-statement")).toBe(1000);
    overhead.push({ observed, ...JSON.parse((await sample.stdout).trim()) });
  }
  console.log(`SQL observer controls ${JSON.stringify({ overhead })}`);
}, 30_000);

async function waitFor(pathname: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(pathname)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${pathname}`);
    await Bun.sleep(5);
  }
}

type WriterOperation = "create" | "update" | "transition";

async function prepareWriters(sandbox: string): Promise<void> {
  // These fixtures have no catalog scanner or seat controller. Declare the
  // project membership that production admission reads, then finish startup
  // before either writer is deliberately held inside its transaction.
  const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } = await import("@/lib/orchestrator/seats");
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = sandbox;
  try {
    beginOrchestratorSeatIntent({ project: "viewer", mandate: "Fixture board", clientRequestId: "writer-seat", mode: "existing" });
    completeOrchestratorSeatIntent({ project: "viewer", clientRequestId: "writer-seat", conversationId: "conversation_writer_seat", path: null, preparedAuthCredentialBaseline: null });
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
  }
  const child = ownFixtureChild(Bun.spawn({ cmd: [process.execPath, path.join(import.meta.dir, "writerConcurrencyChild.ts")],
    env: { ...process.env, LLV_STATE_DIR: sandbox, LLV_WRITER_PREPARE: "1" }, stdout: "ignore", stderr: "pipe" }));
  const error = new Response(child.stderr).text();
  if (await child.exited !== 0) throw new Error(await error);
}

/** The task store lives in `state.sqlite` beside its legacy path (#1870). */
function persistedTasks(stateFile: string): { tasks: Record<string, unknown>[]; recentCreates: Record<string, unknown>[] } {
  const rows = (readStateCollectionRows(path.join(path.dirname(stateFile), "state.sqlite"), "tasks") ?? []) as Record<string, unknown>[];
  return {
    tasks: rows.filter((row) => typeof row.status === "string"),
    recentCreates: rows.filter((row) => typeof row.clientRequestId === "string"),
  };
}

async function runConcurrentWriters(
  kind: "task" | "pipeline",
  initialState: string,
  operation: WriterOperation = "create",
): Promise<{ creatorPath: string | null; enteredBeforeRelease: boolean; persisted: Record<string, unknown> }> {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `llv-${kind}-writers-`));
  sandboxes.push(sandbox);
  const stateFile = path.join(sandbox, `${kind}s.json`);
  fs.writeFileSync(stateFile, initialState, "utf8");
  let creatorPath: string | null = null;
  let codexHome: string | null = null;
  if (kind === "pipeline" && operation === "create") {
    codexHome = path.join(sandbox, "codex");
    creatorPath = path.join(codexHome, "sessions", "creator.jsonl");
    fs.mkdirSync(path.dirname(creatorPath), { recursive: true });
    fs.writeFileSync(creatorPath, "{}\n", "utf8");
    const { AgentRegistry } = await import("@/lib/agent/registry");
    new AgentRegistry(
      path.join(sandbox, "agent-registry.json"),
      undefined,
      undefined,
      { sqliteMode: "sqlite" },
    ).ensureConversation("codex", creatorPath, null);
  }
  const claudeHome = path.join(sandbox, "claude");
  fs.mkdirSync(claudeHome, { recursive: true });
  // Start admission is exercised with injected launch ports, never a real CLI.
  fs.writeFileSync(path.join(claudeHome, ".credentials.json"), "{}", { mode: 0o600 });
  const fixture = path.join(import.meta.dir, "writerConcurrencyChild.ts");
  await prepareWriters(sandbox);
  const begin = path.join(sandbox, "writers.begin");
  const writers = ["http", "mcp"].map((writer) => {
    const ready = path.join(sandbox, `${writer}.ready`);
    const release = path.join(sandbox, `${writer}.release`);
    const initialized = path.join(sandbox, `${writer}.initialized`);
    const child = ownFixtureChild(Bun.spawn({
      cmd: [process.execPath, fixture],
      cwd: process.cwd(),
      env: {
        ...process.env,
        LLV_STATE_DIR: sandbox,
        LLV_CLAUDE_HOME: claudeHome,
        LLV_WRITER_KIND: kind,
        LLV_WRITER_INTERFACE: writer,
        LLV_WRITER_OPERATION: operation,
        LLV_WRITER_READY: ready,
        LLV_WRITER_RELEASE: release,
        LLV_WRITER_INITIALIZED: initialized,
        LLV_WRITER_BEGIN: begin,
        ...(codexHome ? { LLV_CODEX_HOME: codexHome } : {}),
        ...(creatorPath ? { LLV_WRITER_SRC: creatorPath } : {}),
        LLV_AGENT_REGISTRY_SQLITE: "sqlite",
      },
      stdout: "ignore",
      stderr: "pipe",
    }));
    const errors = new Response(child.stderr).text();
    return { child, ready, release, initialized, errors };
  });

  await Promise.all(writers.map(async writer => Promise.race([
    waitFor(writer.initialized), writer.child.exited.then(async () => { throw new Error(await writer.errors || "writer failed during initialization"); }),
  ])));
  fs.writeFileSync(begin, "begin");

  await Promise.race([
    Promise.any(writers.map(({ ready }) => waitFor(ready))),
    Promise.all(writers.map(async ({ child, errors }) => {
      await child.exited;
      throw new Error((await errors) || "writer exited before reaching the barrier");
    })),
  ]);
  const first = writers.find(({ ready }) => fs.existsSync(ready))!;
  const second = writers.find((candidate) => candidate !== first)!;
  await Bun.sleep(750);
  const enteredBeforeRelease = fs.existsSync(second.ready);
  fs.writeFileSync(first.release, "release\n", "utf8");
  await Promise.race([waitFor(second.ready), second.child.exited.then(async () => { throw new Error(await second.errors || "second writer exited before its barrier"); })]);
  fs.writeFileSync(second.release, "release\n", "utf8");

  const exitCodes = await Promise.all(writers.map(({ child }) => child.exited));
  if (exitCodes.some((code) => code !== 0)) {
    const errors = await Promise.all(writers.map(({ errors }) => errors));
    throw new Error(errors.filter(Boolean).join("\n"));
  }
  return {
    creatorPath,
    enteredBeforeRelease,
    persisted: kind === "task" ? persistedTasks(stateFile) : {
      pipelines: readStateCollectionRows(path.join(sandbox, "state.sqlite"), "pipelines") ?? [],
    },
  };
}

test("Viewer HTTP and standalone MCP task creates preserve both writes across processes", async () => {
  const result = await runConcurrentWriters("task", "{\"tasks\":[]}\n");
  const persisted = result.persisted as { tasks: unknown[]; recentCreates: unknown[] };
  expect(result.enteredBeforeRelease).toBe(false);
  expect(persisted.tasks).toHaveLength(2);
  expect(persisted.recentCreates).toHaveLength(2);
}, 15_000);

test("Viewer HTTP and standalone MCP pipeline creates preserve both writes across processes", async () => {
  const result = await runConcurrentWriters("pipeline", "{\"schemaVersion\":3,\"pipelines\":[]}\n");
  const persisted = result.persisted as { pipelines: Array<{ srcPath: string | null; srcConversationId: string | null }> };
  expect(result.enteredBeforeRelease).toBe(false);
  expect(persisted.pipelines).toHaveLength(2);
  expect(persisted.pipelines.every((pipeline) =>
    pipeline.srcPath === result.creatorPath
    && pipeline.srcConversationId?.startsWith("conversation_") === true)).toBe(true);
}, 15_000);

test("Viewer HTTP PATCH and standalone MCP update_task serialize across processes", async () => {
  const now = "2026-07-20T10:00:00.000Z";
  const task = (id: string) => ({
    id,
    project: "viewer",
    status: "inbox",
    text: `${id} original`,
    placement: "unplaced",
    assignments: [],
    createdAt: now,
    updatedAt: now,
  });
  const result = await runConcurrentWriters("task", JSON.stringify({
    tasks: [task("task-http"), task("task-mcp")],
  }), "update");
  const persisted = result.persisted as { tasks: Array<{ id: string; text: string }> };
  expect(result.enteredBeforeRelease).toBe(false);
  expect(persisted.tasks.find(({ id }) => id === "task-http")?.text).toBe("http updated task");
  expect(persisted.tasks.find(({ id }) => id === "task-mcp")?.text).toBe("mcp updated task");
}, 15_000);

test("Viewer HTTP pipeline start and standalone MCP pipeline_action serialize across processes", async () => {
  const baseRef = "0".repeat(40);
  const pipeline = (id: string) => ({
    id,
    task: `${id} task`,
    project: "live-log-viewer-next",
    repoDir: process.cwd(),
    worktreeDir: path.join(path.dirname(process.cwd()), `${path.basename(process.cwd())}-pipeline-${id}`),
    branch: `pipeline/${id}-task-${id}`,
    baseBranch: "main",
    baseRef,
    lastPassedCommit: baseRef,
    stages: [{
      id: "implement",
      kind: "run",
      "prompt": "Implement the task",
      next: null,
      onFail: null,
      effectiveRole: {
        roleId: null,
        engine: "claude",
        model: null,
        effort: null,
        access: "read-write",
        promptScaffold: null,
      },
    }],
    runs: [{ stageId: "implement", attempts: [] }],
    cursor: { stageId: "implement", state: "pending", input: null, activatedBy: null },
    state: "draft",
    pausedState: null,
    stateDetail: null,
    srcPath: null,
    srcConversationId: null,
    createdAt: "2026-07-20T10:00:00.000Z",
    closedAt: null,
    hiddenAt: null,
  });
  const result = await runConcurrentWriters("pipeline", JSON.stringify({
    schemaVersion: 3,
    pipelines: [pipeline("pipeline-http"), pipeline("pipeline-mcp")],
  }), "transition");
  const persisted = result.persisted as { pipelines: Array<{ id: string; state: string }> };
  expect(result.enteredBeforeRelease).toBe(false);
  expect(persisted.pipelines.find(({ id }) => id === "pipeline-http")?.state).toBe("provisioning");
  expect(persisted.pipelines.find(({ id }) => id === "pipeline-mcp")?.state).toBe("provisioning");
}, 15_000);

test("an aged live writer without process identity retains the transaction until release", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-live-owner-writers-"));
  sandboxes.push(sandbox);
  const stateFile = path.join(sandbox, "tasks.json");
  const claudeHome = path.join(sandbox, "claude");
  fs.mkdirSync(claudeHome, { recursive: true });
  // Start admission is exercised with injected launch ports, never a real CLI.
  fs.writeFileSync(path.join(claudeHome, ".credentials.json"), "{}", { mode: 0o600 });
  const fixture = path.join(import.meta.dir, "writerConcurrencyChild.ts");
  fs.writeFileSync(stateFile, "{\"tasks\":[]}\n", "utf8");
  await prepareWriters(sandbox);

  const spawnWriter = (writer: "http" | "mcp") => {
    const ready = path.join(sandbox, `${writer}.ready`);
    const release = path.join(sandbox, `${writer}.release`);
    const child = ownFixtureChild(Bun.spawn({
      cmd: [process.execPath, fixture],
      cwd: process.cwd(),
      env: {
        ...process.env,
        LLV_STATE_DIR: sandbox,
        LLV_CLAUDE_HOME: claudeHome,
        LLV_WRITER_KIND: "task",
        LLV_WRITER_INTERFACE: writer,
        LLV_WRITER_READY: ready,
        LLV_WRITER_RELEASE: release,
        LLV_WRITER_NO_PROCESS_IDENTITY: "1",
      },
      stdout: "ignore",
      stderr: "pipe",
    }));
    return { child, ready, release };
  };

  const first = spawnWriter("http");
  await waitFor(first.ready);
  /* The fixture ages its lease before opening the SQL transaction, leaving
     SQLite free so the peer must check the live owner rather than a SQL lock. */
  const { Database } = process.getBuiltinModule("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(path.join(sandbox, "state.sqlite"));
  try {
    const held = db.query<{ acquired_at: number; owner_start_identity: string | null }, []>(
      "SELECT acquired_at, owner_start_identity FROM state_leases WHERE collection = 'tasks'",
    ).get();
    expect(held?.acquired_at).toBeLessThanOrEqual(Date.now() - 59_000);
    expect(held?.owner_start_identity).toBeNull();
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
  } finally {
    db.close();
  }

  const second = spawnWriter("mcp");
  await waitFor(`${second.ready}.waiting`);
  const enteredBeforeRelease = fs.existsSync(second.ready);
  fs.writeFileSync(first.release, "release\n", "utf8");
  if (!enteredBeforeRelease) await waitFor(second.ready);
  fs.writeFileSync(second.release, "release\n", "utf8");

  const exitCodes = await Promise.all([first.child.exited, second.child.exited]);
  if (exitCodes.some((code) => code !== 0)) {
    const errors = await Promise.all([new Response(first.child.stderr).text(), new Response(second.child.stderr).text()]);
    throw new Error(errors.filter(Boolean).join("\n"));
  }
  expect(enteredBeforeRelease).toBe(false);
  expect(persistedTasks(stateFile).tasks).toHaveLength(2);
}, 15_000);
