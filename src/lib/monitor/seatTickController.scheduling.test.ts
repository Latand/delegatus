import { expect, test, harness, PROJECT, CONVERSATION, RECENT, OVERDUE,
  OPEN_LANE, pipelineRecord, fs, path, spawn, spyOn, SANDBOX, readSeatTickState, writeSeatTickState, emptySeatTickState, NOW,
  runSeatTickCheck, reconcileSeatTick, startSeatTick, stopSeatTick, DEFAULT_SEAT_TICK_POLICY } from "./seatTickController.fixture";
import type { DeliveryOutcome } from "@/lib/delivery";
import type { DeadlineScheduler } from "@/lib/deadline";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function virtualClock() {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const scheduler: DeadlineScheduler = {
    setTimeout: (run, delay) => { const id = ++next; timers.set(id, { at: now + delay, run }); return id; },
    clearTimeout: handle => { timers.delete(handle as number); },
  };
  return { now: () => now, scheduler, advance: (delta: number) => {
    now += delta;
    for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.run(); }
  }, timers };
}

test("a sweep has one curator owner and every project journals phase timings", async () => {
  const rig = harness({ state: RECENT });
  const clock = virtualClock();
  Object.assign(rig.deps, { workClock: clock.now, workScheduler: clock.scheduler });
  rig.deps.sources!.activeSeats = () => [PROJECT, "second-project", "third-project"];
  let reconciles = 0, choices = 0;
  rig.deps.curation = {
    reconcile: async () => { reconciles++; return null; },
    launchIfDue: async () => { choices++; return null; },
  };
  const records = await reconcileSeatTick(rig.deps);
  expect(records).toHaveLength(3);
  expect(reconciles).toBe(1);
  expect(choices).toBe(1);
  expect(new Set(records.map(record => record.timing!.checkId)).size).toBe(3);
  for (const record of records) {
    expect(record.timing!.phases.some(row => row.phase === "check.sources.seatFor")).toBe(true);
    expect(record.timing!.cpuUs).toBeGreaterThanOrEqual(0);
  }
});

test("a check awaits its production journal and closes completed phase spans", async () => {
  const { readSeatTickRecords } = await import("./journalStore");
  const rig = harness({ state: RECENT });
  delete rig.deps.appendRecord; delete rig.deps.readRecords;
  const previous = process.env.LLV_SEAT_TICK_AUDIT_FILE;
  const file = path.join(SANDBOX, "check-timings.ndjson");
  process.env.LLV_SEAT_TICK_AUDIT_FILE = file;
  try {
    const record = await runSeatTickCheck(PROJECT, rig.deps);
    if (!record?.timing) throw Error("expected a check with phase timings");
    expect(readSeatTickRecords(1, file, PROJECT)[0]).toEqual(record);
    expect(record.timing.phases.filter(row => row.pending)).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.LLV_SEAT_TICK_AUDIT_FILE;
    else process.env.LLV_SEAT_TICK_AUDIT_FILE = previous;
  }
});

async function withCheckJournal(name: string, worker: boolean, run: (file: string) => Promise<void>) {
  const { stopSeatTickJournalWorkerForTests } = await import("./seatTickJournalWorker");
  const previous = {
    LLV_SEAT_TICK_AUDIT_FILE: process.env.LLV_SEAT_TICK_AUDIT_FILE,
    LLV_SEAT_TICK_JOURNAL_WORKER: process.env.LLV_SEAT_TICK_JOURNAL_WORKER,
  };
  const file = path.join(SANDBOX, name, "runs.ndjson");
  process.env.LLV_SEAT_TICK_AUDIT_FILE = file;
  process.env.LLV_SEAT_TICK_JOURNAL_WORKER = worker ? "1" : "0";
  try { await run(file); }
  finally {
    if (worker) await stopSeatTickJournalWorkerForTests();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("the next sweep records a check once after a legacy journal writer releases its lock", async () => {
  const { readSeatTickRecords } = await import("./journalStore");
  const { withFileTransactionAsync } = await import("@/lib/state/fileTransaction");
  await withCheckJournal("busy-legacy-journal", false, async file => {
    const rig = harness({ state: RECENT });
    delete rig.deps.appendRecord;
    const entered = deferred(), release = deferred();
    const held = withFileTransactionAsync(file, "fixture journal writer", async () => {
      entered.resolve();
      await release.promise;
    });
    try {
      await entered.promise;
      await reconcileSeatTick(rig.deps, [PROJECT]);
      expect(readSeatTickRecords(10, file, PROJECT)).toEqual([]);
    } finally {
      release.resolve();
      await held;
    }
    await reconcileSeatTick(rig.deps, []);
    await reconcileSeatTick(rig.deps, []);
    expect(readSeatTickRecords(10, file, PROJECT)).toEqual([expect.objectContaining({
      project: PROJECT, at: new Date(NOW).toISOString(),
    })]);
  });
});

test("every sweep checks the full roster while SQLite is busy and a successor records every result once", async () => {
  const { Database } = await import("bun:sqlite");
  const { statePath } = await import("@/lib/configDir");
  const { importLegacySeatTickJournal, readSeatTickRecords } = await import("./journalStore");
  await withCheckJournal("busy-sqlite-journal", false, async file => {
    importLegacySeatTickJournal(file);
    const initialBatch = writePendingCheck(file, 1);
    const unfinishedBatch = writePendingCheck(file, 2);
    const temporary = `${unfinishedBatch}.tmp`;
    fs.renameSync(unfinishedBatch, temporary);
    const rig = harness({ state: RECENT });
    delete rig.deps.appendRecord;
    const projects = ["second-project", "third-project", PROJECT];
    rig.deps.sources!.activeSeats = () => projects;
    const started: string[] = [];
    rig.deps.workStarted = work => { started.push(work.project); };
    let choices = 0;
    Object.assign(rig.deps, {
      ownsTraffic: () => true, recordSuccessions: () => [], release: null, maintenance: null,
      curation: {
        reconcile: async () => null,
        launchIfDue: async () => { choices++; return null; },
      },
    });
    const database = new Database(statePath("state.sqlite"));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const realNow = performance.now.bind(performance);
    let offsetMs = 0;
    const monotonic = spyOn(performance, "now").mockImplementation(() => realNow() + offsetMs);
    const checkIds: string[] = [];
    const pendingDir = `${file}.pending-checks`;
    try {
      database.exec("BEGIN IMMEDIATE");
      for (let sweep = 0; sweep < 4; sweep++) {
        const records = await reconcileSeatTick(rig.deps);
        expect(started.splice(0)).toEqual(projects);
        expect(choices).toBe(sweep + 1);
        expect(records.map(record => record.project)).toEqual(projects);
        checkIds.push(...records.map(record => record.timing!.checkId));
        // Let the next sweep try the backlog again against the same holder.
        offsetMs += 60_001;
      }
      const direct = await runSeatTickCheck(PROJECT, rig.deps);
      expect(started).toEqual([PROJECT]);
      checkIds.push(direct!.timing!.checkId);
      expect(new Set(checkIds).size).toBe(checkIds.length);
      expect(readSeatTickRecords(50, file)).toEqual([]);
      expect(fs.readdirSync(pendingDir).filter(name => name.endsWith(".json"))).toHaveLength(checkIds.length + 1);
      const tickWarnings = warn.mock.calls.filter(([line]) => String(line).startsWith("[seat tick] "));
      expect(tickWarnings).toEqual([
        [expect.stringMatching(/journal is busy \(StateLockDeferredError\).*saved for retry/)],
      ]);
    } finally {
      database.close();
      monotonic.mockRestore();
      warn.mockRestore();
    }

    const child = Bun.spawn([process.execPath, "-e", `
      import fs from "node:fs";
      import { reconcileSeatTick } from "./src/lib/monitor/seatTickController";
      const batch = ${JSON.stringify(initialBatch)};
      const bytes = fs.readFileSync(batch);
      const sweep = () => reconcileSeatTick({
        ownsTraffic: () => true, recordSuccessions: () => [], policy: null, curation: null,
      }, []);
      await sweep();
      // A stopped publisher may leave its batch behind after SQLite commits.
      fs.writeFileSync(batch, bytes, { flag: "wx", mode: 0o600 });
      await sweep();
    `], { stdout: "ignore", stderr: "pipe" });
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (exit !== 0) throw new Error(`seat tick successor exited ${exit}: ${stderr}`);
    expect(stderr.split("\n").filter(line => /^\[seat tick\].*journal/.test(line))).toEqual([]);
    // The successor leaves the unfinished batch for its publisher.
    expect(fs.readdirSync(pendingDir)).toEqual([path.basename(temporary)]);
    const recorded = readSeatTickRecords(50, file);
    expect(recorded[0]).toMatchObject({ project: PROJECT, items: 1 });
    expect(recorded.slice(1).map(record => record.timing?.checkId).sort()).toEqual(checkIds.sort());
  });
});

function writePendingCheck(file: string, order: number) {
  const id = order.toString(16).padStart(32, "0");
  const record = { schemaVersion: 1, at: new Date(NOW).toISOString(), project: PROJECT, seatEpoch: null,
    verdict: "quiet", reasons: [], items: order, deferred: 0, eventsThrough: 0, delivery: null };
  const directory = `${file}.pending-checks`;
  fs.mkdirSync(directory, { recursive: true });
  const batch = path.join(directory, `${String(order).padStart(16, "0")}-${id}.json`);
  fs.writeFileSync(batch, JSON.stringify([{ id, record }]));
  return batch;
}

test("one healthy sweep drains all visible batches in order before journaling its own check", async () => {
  const { readSeatTickRecords } = await import("./journalStore");
  await withCheckJournal("healthy-journal-backlog", false, async file => {
    for (const order of [3, 1, 2]) writePendingCheck(file, order);
    const rig = harness({ state: RECENT });
    delete rig.deps.appendRecord;
    const records = await reconcileSeatTick(rig.deps, [PROJECT]);
    expect(records).toHaveLength(1);
    expect(readSeatTickRecords(10, file, PROJECT)).toEqual([
      ...[1, 2, 3].map(items => expect.objectContaining({ items })),
      records[0],
    ]);
    expect(fs.readdirSync(`${file}.pending-checks`)).toEqual([]);
  });
});

test("a check journals directly when the SQLite writer releases after 150 ms", async () => {
  const { Database } = await import("bun:sqlite");
  const { statePath } = await import("@/lib/configDir");
  const { readSeatTickRecords } = await import("./journalStore");
  await withCheckJournal("short-sqlite-hold", true, async file => {
    const rig = harness({ state: RECENT });
    delete rig.deps.appendRecord;
    // Warm the real worker and create the directory before watching publication.
    await runSeatTickCheck(PROJECT, rig.deps);
    const directory = `${file}.pending-checks`;
    const database = new Database(statePath("state.sqlite"));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let release: ReturnType<typeof setTimeout> | undefined;
    const watcher = fs.watch(directory, () => {
      if (release || !fs.readdirSync(directory).some(name => name.endsWith(".json"))) return;
      release = setTimeout(() => database.exec("ROLLBACK"), 150);
    });
    rig.deps.workStarted = () => { database.exec("BEGIN IMMEDIATE"); };
    try {
      const record = await runSeatTickCheck(PROJECT, rig.deps);
      expect(record).not.toBeNull();
      expect(release).toBeDefined();
      expect(database.inTransaction).toBe(false);
      expect(readSeatTickRecords(10, file, PROJECT)).toHaveLength(2);
      expect(readSeatTickRecords(10, file, PROJECT).at(-1)).toEqual(record);
      expect(fs.readdirSync(directory)).toEqual([]);
      expect(warn.mock.calls).toEqual([]);
    } finally {
      clearTimeout(release);
      watcher.close();
      database.close();
      warn.mockRestore();
    }
  });
});

test.each(["append", "replay"] as const)("a non-busy %s failure names the SQLite error class once and keeps the result for retry", async mode => {
  const { Database } = await import("bun:sqlite");
  const { statePath } = await import("@/lib/configDir");
  const { importLegacySeatTickJournal, readSeatTickRecords } = await import("./journalStore");
  await withCheckJournal(`rejected-journal-${mode}`, mode === "append", async file => {
    importLegacySeatTickJournal(file);
    const rig = harness({ state: RECENT });
    delete rig.deps.appendRecord;
    const database = new Database(statePath("state.sqlite"));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      database.exec(`CREATE TRIGGER reject_journal_insert BEFORE INSERT ON state_rows
        WHEN NEW.row_key LIKE 'r:%' BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END`);
      if (mode === "replay") writePendingCheck(file, 1);
      await reconcileSeatTick(rig.deps, mode === "append" ? [PROJECT] : []);
      await reconcileSeatTick(rig.deps, []);
      const tickWarnings = warn.mock.calls.filter(([line]) => String(line).startsWith("[seat tick] "));
      expect(tickWarnings).toEqual([[expect.stringContaining("SQLiteError")]]);
      expect(String(tickWarnings[0]![0])).not.toMatch(/busy/i);
      expect(readSeatTickRecords(10, file, PROJECT)).toEqual([]);
      expect(fs.readdirSync(`${file}.pending-checks`)).toHaveLength(1);
    } finally {
      database.exec("DROP TRIGGER IF EXISTS reject_journal_insert");
      database.close();
      warn.mockRestore();
    }
  });
});

test("a wall-clock rollback cannot extend the bounded pending-journal cooldown", async () => {
  const { Database } = await import("bun:sqlite");
  const { statePath } = await import("@/lib/configDir");
  const { importLegacySeatTickJournal, readSeatTickRecords } = await import("./journalStore");
  const { SeatTickPendingJournal } = await import("./seatTickPendingJournal");
  await withCheckJournal("monotonic-journal-cooldown", false, async file => {
    importLegacySeatTickJournal(file);
    writePendingCheck(file, 1);
    const wall = spyOn(Date, "now").mockReturnValue(1_000);
    let monotonic = 10;
    const clock = spyOn(performance, "now").mockImplementation(() => monotonic);
    const database = new Database(statePath("state.sqlite"));
    const journal = new SeatTickPendingJournal(file);
    try {
      database.exec("BEGIN IMMEDIATE");
      await journal.ready();
      expect(readSeatTickRecords(10, file, PROJECT)).toEqual([]);
      database.close();
      wall.mockReturnValue(-3_599_000);
      monotonic += 60_001;
      await journal.ready();
      expect(readSeatTickRecords(10, file, PROJECT)).toHaveLength(1);
      await journal.ready();
      expect(readSeatTickRecords(10, file, PROJECT)).toHaveLength(1);
    } finally {
      database.close();
      wall.mockRestore();
      clock.mockRestore();
    }
  });
});

test("a process exit after a busy append reply leaves its result for one successor replay", async () => {
  const { Database } = await import("bun:sqlite");
  const { statePath } = await import("@/lib/configDir");
  const { importLegacySeatTickJournal, readSeatTickRecords } = await import("./journalStore");
  await withCheckJournal("exit-after-busy-reply", true, async file => {
    importLegacySeatTickJournal(file);
    const database = new Database(statePath("state.sqlite"));
    try {
      database.exec("BEGIN IMMEDIATE");
      const child = Bun.spawn([process.execPath, "-e", `
        import { SeatTickPendingJournal } from "./src/lib/monitor/seatTickPendingJournal";
        await new SeatTickPendingJournal(process.env.LLV_SEAT_TICK_AUDIT_FILE).append({
          schemaVersion: 1, at: "2026-08-28T12:00:00.000Z", project: "viewer", seatEpoch: null,
          verdict: "quiet", reasons: [], items: 0, deferred: 0, eventsThrough: 0, delivery: null,
        });
        process.exit(0);
      `], { stdout: "pipe", stderr: "pipe" });
      const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: expect.stringContaining("FileTransactionBusyError") });
      expect(fs.readdirSync(`${file}.pending-checks`).filter(name => name.endsWith(".json"))).toHaveLength(1);
      expect(readSeatTickRecords(10, file, PROJECT)).toEqual([]);
    } finally { database.close(); }
    const recover = Bun.spawn([process.execPath, "-e", `
      import { reconcileSeatTick } from "./src/lib/monitor/seatTickController";
      await reconcileSeatTick({ ownsTraffic: () => true, recordSuccessions: () => [], policy: null, curation: null }, []);
    `], { stdout: "pipe", stderr: "pipe" });
    expect(await recover.exited).toBe(0);
    expect(readSeatTickRecords(10, file, PROJECT)).toHaveLength(1);
    const replay = Bun.spawn([process.execPath, "-e", `
      import { reconcileSeatTick } from "./src/lib/monitor/seatTickController";
      await reconcileSeatTick({ ownsTraffic: () => true, recordSuccessions: () => [], policy: null, curation: null }, []);
    `], { stdout: "pipe", stderr: "pipe" });
    expect(await replay.exited).toBe(0);
    expect(readSeatTickRecords(10, file, PROJECT)).toHaveLength(1);
  });
});

test("a worker reply lost after commit replays its preassigned receipt exactly once", async () => {
  const { readSeatTickRecords } = await import("./journalStore");
  const { configureSeatTickJournalWorkerForTests, stopSeatTickJournalWorkerForTests } = await import("./seatTickJournalWorker");
  const { Database } = await import("bun:sqlite");
  const { statePath } = await import("@/lib/configDir");
  const { importLegacySeatTickJournal } = await import("./journalStore");
  const previous = { audit: process.env.LLV_SEAT_TICK_AUDIT_FILE, worker: process.env.LLV_SEAT_TICK_JOURNAL_WORKER };
  const restoreWorker = configureSeatTickJournalWorkerForTests({ timeoutMs: 1_000, dropReplies: 1 });
  const file = path.join(SANDBOX, "lost-worker-reply", "runs.ndjson");
  process.env.LLV_SEAT_TICK_AUDIT_FILE = file;
  process.env.LLV_SEAT_TICK_JOURNAL_WORKER = "1";
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const rig = harness({ state: RECENT });
    delete rig.deps.appendRecord;
    await reconcileSeatTick(rig.deps, [PROJECT]);
    expect(readSeatTickRecords(10, file, PROJECT)).toHaveLength(1);
    const [batch] = fs.readdirSync(`${file}.pending-checks`);
    expect(batch).toBeDefined();
    const child = Bun.spawn([process.execPath, "-e", `
      import { reconcileSeatTick } from "./src/lib/monitor/seatTickController";
      await reconcileSeatTick({ ownsTraffic: () => true, recordSuccessions: () => [], policy: null, curation: null }, []);
    `], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    expect(readSeatTickRecords(10, file, PROJECT)).toHaveLength(1);

    const busyFile = path.join(SANDBOX, "lost-busy-reply", "runs.ndjson");
    process.env.LLV_SEAT_TICK_AUDIT_FILE = busyFile;
    importLegacySeatTickJournal(busyFile);
    const database = new Database(statePath("state.sqlite"));
    let databaseOpen = true;
    const restoreBusyReply = configureSeatTickJournalWorkerForTests({ timeoutMs: 1_500, dropReplies: 1 });
    try {
      database.exec("BEGIN IMMEDIATE");
      const busyRig = harness({ state: RECENT });
      delete busyRig.deps.appendRecord;
      await reconcileSeatTick(busyRig.deps, [PROJECT]);
      expect(readSeatTickRecords(10, busyFile, PROJECT)).toEqual([]);
      database.close();
      databaseOpen = false;
      const retry = Bun.spawn([process.execPath, "-e", `
        import { reconcileSeatTick } from "./src/lib/monitor/seatTickController";
        await reconcileSeatTick({ ownsTraffic: () => true, recordSuccessions: () => [], policy: null, curation: null }, []);
      `], { stdout: "pipe", stderr: "pipe" });
      expect(await retry.exited).toBe(0);
      expect(readSeatTickRecords(10, busyFile, PROJECT)).toHaveLength(1);
    } finally {
      if (databaseOpen) database.close();
      restoreBusyReply();
    }
  } finally {
    warn.mockRestore();
    restoreWorker();
    await stopSeatTickJournalWorkerForTests();
    if (previous.audit === undefined) delete process.env.LLV_SEAT_TICK_AUDIT_FILE;
    else process.env.LLV_SEAT_TICK_AUDIT_FILE = previous.audit;
    if (previous.worker === undefined) delete process.env.LLV_SEAT_TICK_JOURNAL_WORKER;
    else process.env.LLV_SEAT_TICK_JOURNAL_WORKER = previous.worker;
  }
});

function deployRig() {
  const rig = harness({ state: RECENT, seatDeployments: [{ deploymentId: "deploy-own", conversationId: CONVERSATION }],
    deployments: { "deploy-own": { phase: "succeeded", terminal: true, revision: "a".repeat(40) } },
    delivery: { ok: true, target: "structured", outcome: "delivered", spawned: true, structured: true } });
  rig.deps.sources!.liveness = async () => [{ conversationId: CONVERSATION,
    host: { state: "gone", kind: "structured", pid: null }, reason: "host_gone_turn_settled", turnState: "idle" } as never];
  rig.deps.mcpHealth = () => ({ status: "dead", detail: "stdio host gone" });
  return rig;
}

test.each(["priority", "deploy gather", "general gather", "controller"] as const)(
  "a recorded settlement bypasses a separate 120-second pending lookup: %s", async mode => {
    const { beginSeatDeployment, recordSeatDeployment, seatDeploymentsFor, seatDeploymentsFile } = await import("@/lib/orchestrator/seatDeployments");
    const { seatTickDeployPending, gatherSeatTickDeployInput, gatherSeatTickInput } = await import("./seatTickSources");
    const rig = deployRig();
    const clock = virtualClock();
    const file = seatDeploymentsFile();
    const previous = fs.existsSync(file) ? fs.readFileSync(file) : null;
    const pending = { conversationId: CONVERSATION, project: PROJECT, revision: "b".repeat(40),
      requestedAt: new Date(NOW - 60_000).toISOString(), idempotencyKey: "pending-slow-deploy" };
    const lookupEntered = deferred(), finished = deferred();
    let lookups = 0;
    let checking: Promise<unknown> | undefined;
    try {
      await beginSeatDeployment(pending);
      await recordSeatDeployment({ ...pending, revision: "a".repeat(40), idempotencyKey: "accepted-deploy", deploymentId: "deploy-own" });
      rig.deps.sources!.seatDeployments = seatDeploymentsFor;
      rig.deps.sources!.deploymentByKey = () => {
        lookups++;
        lookupEntered.resolve();
        return new Promise((_, reject) => {
          clock.scheduler.setTimeout(() => reject(new Error("deployment lookup timed out")), 120_000);
        });
      };
      // An overdue seat used to expire at the opening hint, then restart that
      // same remote lookup on each poll, despite its other settled deployment.
      rig.deps.writeState!(PROJECT, { ...rig.deps.readState!(PROJECT), ...OVERDUE });
      Object.assign(rig.deps, { workClock: clock.now, workScheduler: clock.scheduler });
      const sources = rig.deps.sources!;
      const state = rig.deps.readState!(PROJECT);
      checking = mode === "priority" ? seatTickDeployPending(PROJECT, state, DEFAULT_SEAT_TICK_POLICY, sources)
        : mode === "deploy gather" ? gatherSeatTickDeployInput(PROJECT, state, DEFAULT_SEAT_TICK_POLICY, sources)
        : mode === "general gather" ? gatherSeatTickInput(PROJECT, state, DEFAULT_SEAT_TICK_POLICY, sources)
        : runSeatTickCheck(PROJECT, rig.deps);
      void checking.then(() => finished.resolve(), () => finished.resolve());
      await Promise.race([finished.promise, lookupEntered.promise]);
      expect(lookups).toBe(0);
      const result = await checking;
      if (mode === "priority") expect(result).toBe(true);
      else if (mode === "controller") {
        expect(result).toMatchObject({ verdict: "wake", reasons: ["deploy-settled"], delivery: { outcome: "delivered" } });
        expect(rig.sent).toHaveLength(1);
        expect(rig.deps.readState!(PROJECT).announcedDeploys).toEqual(["deploy-own"]);
      } else expect(result).toMatchObject({ settledDeploys: [{ deploymentId: "deploy-own" }] });
      expect(clock.now()).toBeLessThan(DEFAULT_SEAT_TICK_POLICY.checkIntervalMs);
      expect(JSON.parse(fs.readFileSync(file, "utf8")).pending).toEqual([pending]);
    } finally {
      clock.advance(120_000);
      await checking?.catch(() => {});
      if (previous) fs.writeFileSync(file, previous);
      else fs.rmSync(file, { force: true });
    }
  });

test.each(["accepted", "unknown", "unavailable"] as const)(
  "pending recovery without a recorded settlement retains its existing outcome: %s", async outcome => {
    const { beginSeatDeployment, seatDeploymentsFor, seatDeploymentsFile } = await import("@/lib/orchestrator/seatDeployments");
    const { gatherSeatTickDeployInput } = await import("./seatTickSources");
    const rig = deployRig();
    const file = seatDeploymentsFile();
    const previous = fs.existsSync(file) ? fs.readFileSync(file) : null;
    const pending = { conversationId: CONVERSATION, project: PROJECT, revision: "a".repeat(40),
      requestedAt: new Date(NOW - 60_000).toISOString(), idempotencyKey: "pending-recovery" };
    try {
      await beginSeatDeployment(pending);
      rig.deps.sources!.seatDeployments = seatDeploymentsFor;
      const keys: string[] = [];
      rig.deps.sources!.deploymentByKey = async key => {
        keys.push(key);
        if (outcome === "unavailable") throw new Error("lookup unavailable");
        return outcome === "unknown" ? null : { idempotencyKey: key, requestedRevision: pending.revision,
          deploymentId: "deploy-own", revision: pending.revision } as never;
      };
      const result = await gatherSeatTickDeployInput(PROJECT, rig.deps.readState!(PROJECT), DEFAULT_SEAT_TICK_POLICY, rig.deps.sources!);
      expect(keys).toEqual([pending.idempotencyKey]);
      if (outcome === "accepted") expect(result).toMatchObject({ settledDeploys: [{ deploymentId: "deploy-own" }] });
      else expect(result).toBeNull();
      expect(JSON.parse(fs.readFileSync(file, "utf8")).pending).toEqual(outcome === "accepted" ? [] : [pending]);
    } finally {
      if (previous) fs.writeFileSync(file, previous);
      else fs.rmSync(file, { force: true });
    }
  });

test("a deploy settling during an overlong pass is checked at the next poll after completion", async () => {
  const rig = deployRig();
  const clock = virtualClock();
  const settlement = rig.deps.sources!.deployment!;
  let settled = false;
  let sourceNow = NOW;
  rig.deps.sources!.now = () => sourceNow;
  rig.deps.sources!.deployment = id => {
    if (!settled) return { state: "unreadable", error: "still promoting" } as never;
    const result = settlement(id) as { state: string; value?: { updatedAt?: string } };
    return { ...result, value: result.value ? { ...result.value, updatedAt: new Date(NOW + 61_000).toISOString() } : undefined } as never;
  };
  const preparation = deferred();
  const entered = deferred();
  rig.deps.sources!.prepareRead = async () => { entered.resolve(); await preparation.promise; };
  rig.deps.ownsTraffic = () => true;
  rig.deps.recordSuccessions = () => [];
  rig.deps.workClock = clock.now;
  rig.deps.workScheduler = clock.scheduler;
  rig.deps.release = rig.deps.curation = rig.deps.maintenance = null;
  let callback!: () => void;
  let pollMs = 0;
  const longPass = deferred();
  const delivered = deferred();
  const append = rig.deps.appendRecord!;
  rig.deps.appendRecord = record => { append(record); if (record.verdict === "wake") delivered.resolve(); };
  const logs: string[] = [];
  let passes = 0;
  let latestCheck: ReturnType<typeof reconcileSeatTick> | undefined;
  startSeatTick({ clock: clock.now, policy: DEFAULT_SEAT_TICK_POLICY, recordSuccessions: () => [],
    handoffHeld: () => false, drainHeld: () => false,
    scheduleInterval: (run, delay) => { callback = run; pollMs = delay; return { unref() {} } as never; },
    sweep: async () => { const first = ++passes === 1; latestCheck = reconcileSeatTick(rig.deps); await latestCheck; if (first) await longPass.promise; },
    log: line => logs.push(line), appendRecord: () => {} });
  try {
    await entered.promise;
    settled = true;
    clock.advance(DEFAULT_SEAT_TICK_POLICY.checkIntervalMs / 4);
    sourceNow = NOW + clock.now();
    rig.deps.writeState!(PROJECT, { ...rig.deps.readState!(PROJECT), lastWakeAt: new Date(NOW + 60_000).toISOString() });
    // Let the expired project unwind; the first pass stays open independently.
    await new Promise<void>(resolve => setImmediate(resolve));
    clock.advance(DEFAULT_SEAT_TICK_POLICY.checkIntervalMs / 4);
    sourceNow = NOW + clock.now();
    const settledAt = NOW + 61_000;
    clock.advance(pollMs);
    callback();
    expect(passes).toBe(1);
    expect(rig.sent).toHaveLength(0);
    longPass.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    callback();
    await delivered.promise;
    await latestCheck;
    expect(clock.now()).toBe(DEFAULT_SEAT_TICK_POLICY.checkIntervalMs);
    expect(sourceNow - settledAt).toBeGreaterThanOrEqual(0);
    expect(sourceNow - settledAt).toBeLessThan(DEFAULT_SEAT_TICK_POLICY.checkIntervalMs);
    expect(rig.sent).toHaveLength(1);
    expect(rig.sent[0]!.text).toContain("deploy settled");
    expect(logs.some(line => line.includes("sweep-running") && line.includes("ageMs=") && line.includes("state=long-running"))).toBe(true);
  } finally { stopSeatTick(); preparation.resolve(); longPass.resolve(); }
});

test("one project's deadline and late preparation cannot starve or overwrite another deploy", async () => {
  const rig = deployRig();
  const clock = virtualClock();
  const entered = deferred(), preparation = deferred();
  rig.deps.sources!.prepareRead = async () => { entered.resolve(); await preparation.promise; };
  const seatFor = rig.deps.sources!.seatFor;
  rig.deps.sources!.activeSeats = () => ["a-slow", PROJECT];
  rig.deps.sources!.seatFor = project => project === PROJECT ? seatFor(project) : { active: null, pending: null, history: [] };
  Object.assign(rig.deps, { ownsTraffic: () => true, recordSuccessions: () => [],
    workClock: clock.now, workScheduler: clock.scheduler, workBudgetMs: 100,
    curation: null, release: null, maintenance: null });
  const delivered = deferred();
  const append = rig.deps.appendRecord!;
  rig.deps.appendRecord = record => { append(record); if (record.verdict === "wake") delivered.resolve(); };
  const sweep = reconcileSeatTick(rig.deps);
  try {
    await entered.promise;
    clock.advance(100);
    await delivered.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(rig.sent).toHaveLength(1);
    const records = await sweep;
    expect(records.find(record => record.project === "a-slow")).toMatchObject({ verdict: "error" });
    expect(records.find(record => record.project === "a-slow")!.detail).toContain("phase=check.sources.prepareRead");
    const writes = rig.written.length;
    preparation.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(rig.written).toHaveLength(writes);
    expect(rig.sent).toHaveLength(1);
  } finally { preparation.resolve(); await sweep; }
});

test("callbacks during one project check coalesce one owed check with fresh state", async () => {
  const rig = deployRig();
  const preparing = deferred(), entered = deferred(), finished = deferred();
  let preparations = 0, checks = 0;
  const settlement = rig.deps.sources!.deployment!;
  let settled = false;
  rig.deps.sources!.deployment = id => settled ? settlement(id) : { state: "unreadable", error: "still promoting" } as never;
  rig.deps.sources!.prepareRead = async () => {
    if (++preparations === 1) { entered.resolve(); await preparing.promise; }
  };
  let curatorChoices = 0;
  const curator = {
    reconcile: async () => null,
    launchIfDue: async () => { curatorChoices++; return null; },
  };
  Object.assign(rig.deps, { ownsTraffic: () => true, recordSuccessions: () => [],
    workStarted: () => { checks++; }, curation: curator, release: null, maintenance: null });
  const append = rig.deps.appendRecord!;
  rig.deps.appendRecord = record => { append(record); if (checks === 2) finished.resolve(); };
  const first = reconcileSeatTick(rig.deps);
  try {
    await entered.promise;
    const second = reconcileSeatTick(rig.deps), third = reconcileSeatTick(rig.deps);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(checks).toBe(1);
    settled = true;
    preparing.resolve();
    await Promise.all([first, second, third]);
    await finished.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(checks).toBe(2);
    expect(curatorChoices).toBe(2);
    expect(rig.sent).toHaveLength(1);
    expect(rig.deps.readState!(PROJECT).announcedDeploys).toEqual(["deploy-own"]);
  } finally { preparing.resolve(); await first; stopSeatTick(); }
});

test("an alarm-sources cancellation is retried immediately and a newly settled deploy lands", async () => {
  const rig = deployRig();
  const settlement = rig.deps.sources!.deployment!;
  let settled = false;
  rig.deps.sources!.deployment = id => settled ? settlement(id) : { state: "unreadable", error: "still promoting" } as never;
  const rows = OPEN_LANE.map(pipelineRecord);
  rig.deps.sources!.pipelines = () => rows as never;
  const liveness = rig.deps.sources!.liveness;
  const settings = rig.deps.sources!.settings;
  let changed = false;
  rig.deps.sources!.liveness = async request => {
    const result = await liveness(request);
    if (request.project && !changed) {
      changed = true;
      // Eligibility changes still invalidate a check across its source await.
      rig.deps.sources!.settings = project => ({ ...settings(project), wakeIntervalMinutes: 30 });
      settled = true;
    }
    return result;
  };
  const result = await runSeatTickCheck(PROJECT, rig.deps);
  expect(changed).toBe(true);
  expect(rig.journal.some(record => record.detail?.includes("Seat alarm sources changed"))).toBe(true);
  expect(result).toMatchObject({ verdict: "wake", reasons: ["deploy-settled"], delivery: { outcome: "delivered" } });
  expect(rig.sent).toHaveLength(1);
  expect(rig.deps.readState!(PROJECT).announcedDeploys).toEqual(["deploy-own"]);
});

test("a priority deploy preserves opening problem credit before epoch reset", async () => {
  const rig = deployRig();
  const before = rig.deps.readState!(PROJECT);
  rig.deps.writeState!(PROJECT, { ...before, seatEpoch: 6, itemsShown: ["opening-problem"] });
  const calls: string[] = [];
  rig.deps.sources!.prepareRead = async () => { throw new Error("general history must not delay the deploy"); };
  rig.deps.sources!.prepareMemoryProblems = async () => { calls.push("prepared"); };
  rig.deps.sources!.memoryProblems = (_project, shown) => { calls.push(...shown); return []; };
  expect((await runSeatTickCheck(PROJECT, rig.deps))?.delivery?.outcome).toBe("delivered");
  expect(calls).toEqual(["prepared", "opening-problem"]);
  expect(rig.sent).toHaveLength(1);
});

test("a pending memory preparation cannot delay deploy settlement or discard opening problem credit", async () => {
  const rig = deployRig();
  const state = rig.deps.readState!(PROJECT);
  rig.deps.writeState!(PROJECT, { ...state, seatEpoch: 6, itemsShown: ["opening-problem"] });
  const preparation = deferred();
  const entered = deferred();
  const credited: string[][] = [];
  rig.deps.sources!.prepareMemoryProblems = async () => { entered.resolve(); await preparation.promise; };
  rig.deps.sources!.prepareRead = async () => { throw new Error("deploy settlement must not prepare general history"); };
  rig.deps.sources!.memoryProblems = (_project, shown) => { credited.push([...shown]); return []; };
  const checking = runSeatTickCheck(PROJECT, rig.deps);
  try {
    await entered.promise;
    const record = await checking;
    expect(record).toMatchObject({ verdict: "wake", reasons: ["deploy-settled"], delivery: { outcome: "delivered" } });
    expect(rig.sent).toHaveLength(1);
    expect(credited).toEqual([]);
    expect(rig.deps.readState!(PROJECT).memoryProblemCreditOwed).toEqual({
      shown: ["opening-problem"], recipient: { conversationId: CONVERSATION, seatEpoch: 7 },
    });
    preparation.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    rig.deps.sources!.prepareRead = async () => {};
    const retry = await runSeatTickCheck(PROJECT, rig.deps);
    expect(retry?.verdict).toBe("quiet");
    expect(credited).toContainEqual(["opening-problem"]);
    expect(rig.deps.readState!(PROJECT).memoryProblemCreditOwed).toBeUndefined();
  } finally { preparation.resolve(); }
});

test("a failed memory preparation leaves deploy dispatch and problem credit available", async () => {
  const rig = deployRig();
  const state = rig.deps.readState!(PROJECT);
  rig.deps.writeState!(PROJECT, { ...state, itemsShown: ["opening-problem"] });
  rig.deps.sources!.prepareMemoryProblems = async () => { throw new Error("memory unavailable"); };
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["deploy-settled"], delivery: { outcome: "delivered" } });
  expect(rig.sent).toHaveLength(1);
  expect(rig.deps.readState!(PROJECT).memoryProblemCreditOwed?.shown).toEqual(["opening-problem"]);
});

test.each([300_000, 30_000])("an unannounced deploy wakes inside the interval despite a recent wake (%i ms)", async intervalMs => {
  const rig = deployRig();
  const settings = rig.deps.sources!.settings(PROJECT);
  rig.deps.sources!.settings = () => ({ ...settings, wakeIntervalMinutes: intervalMs / 60_000,
    updatedAt: new Date(NOW - 1_000).toISOString() });
  const initial = rig.deps.readState!(PROJECT);
  rig.deps.writeState!(PROJECT, { ...initial, lastWakeAt: new Date(NOW - 10_000).toISOString() });
  // The deploy settled two minutes ago; this project's last wake is recent
  // relative to its normal cadence. The settlement deadline is now due.
  expect((await runSeatTickCheck(PROJECT, rig.deps))?.delivery?.outcome).toBe("delivered");
  expect(rig.sent).toHaveLength(1);
  expect(rig.journal.at(-1)).toMatchObject({ verdict: "wake", reasons: ["deploy-settled"] });
});

test("a blocked optional report read cannot hold up a settled deploy wake", async () => {
  const rig = deployRig();
  let reportReads = 0;
  rig.deps.sources!.reports = { log: () => { reportReads++; return new Promise(() => {}); }, enabled: () => true, operatorLocale: () => "en" } as never;
  const result = await runSeatTickCheck(PROJECT, rig.deps);
  expect(result).toMatchObject({ verdict: "wake", reasons: ["deploy-settled"], delivery: { outcome: "delivered" } });
  expect(reportReads).toBeGreaterThan(0);
  expect(rig.sent).toHaveLength(1);
});

test("release authority lost during a deploy check fences dispatch", async () => {
  const rig = deployRig();
  const read = rig.deps.sources!.liveness;
  let ownsTraffic = true;
  rig.deps.ownsTraffic = () => ownsTraffic;
  rig.deps.sources!.liveness = async request => { ownsTraffic = false; return read(request); };
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toHaveLength(0);
  expect(record?.detail).toContain("viewer-release-replaced");
  expect(rig.deps.readState!(PROJECT).announcedDeploys ?? []).toEqual([]);
});

test("an expired transport continuation keeps its original outstanding key and never credits a late answer", async () => {
  const clock = virtualClock();
  const entered = deferred(), transport = deferred<DeliveryOutcome>();
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE,
    deliverWith: async () => { entered.resolve(); return transport.promise; } });
  Object.assign(rig.deps, { workClock: clock.now, workScheduler: clock.scheduler, workBudgetMs: 100 });
  const checking = runSeatTickCheck(PROJECT, rig.deps);
  await entered.promise;
  clock.advance(100);
  const result = await checking;
  expect(result?.verdict).toBe("error");
  expect(result?.detail).toContain("deadline");
  const saved = rig.deps.readState!(PROJECT);
  const key = saved.outstandingWake?.clientMessageId;
  expect(key ?? null).toBe(rig.sent[0]?.clientMessageId ?? null);
  expect(saved.lastWakeAt).toBe(OVERDUE.lastWakeAt);
  expect(clock.timers.size).toBe(0);
  const writes = rig.written.length;
  transport.resolve({ ok: true, target: "structured", outcome: "delivered" });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(rig.written).toHaveLength(writes);
});

test("a synchronous opening state read that exhausts the budget records one overflow", async () => {
  const clock = virtualClock();
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  Object.assign(rig.deps, { workClock: clock.now, workScheduler: clock.scheduler, workBudgetMs: 100 });
  const readState = rig.deps.readState!;
  rig.deps.readState = project => { clock.advance(100); return readState(project); };
  const result = await runSeatTickCheck(PROJECT, rig.deps);
  expect(result).toMatchObject({ verdict: "error" });
  expect(result?.detail).toContain("phase=check");
  expect(rig.journal.filter(record => record.verdict === "error")).toHaveLength(1);
  expect(rig.sent).toHaveLength(0);
  expect(rig.written).toHaveLength(0);
});

test("opening expiry observes a late rejecting preparation port and records one overflow", async () => {
  const clock = virtualClock();
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  Object.assign(rig.deps, { workClock: clock.now, workScheduler: clock.scheduler, workBudgetMs: 100 });
  rig.deps.sources!.prepareRead = async () => {
    clock.advance(100);
    await new Promise<void>(resolve => setImmediate(resolve));
    throw new Error("late preparation rejection");
  };
  const result = await runSeatTickCheck(PROJECT, rig.deps);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(result).toMatchObject({ verdict: "error" });
  expect(result?.detail).toContain("phase=check.sources.prepareRead");
  expect(rig.journal.filter(record => record.verdict === "error")).toHaveLength(1);
  expect(rig.sent).toHaveLength(0);
  expect(rig.written).toHaveLength(0);
});


test("the project deadline reaches the production liveness reader", async () => {
  const liveness = await import("@/lib/lifecycle/liveness");
  const { defaultSeatTickAdmissionSources } = await import("./seatTickAdmissionSources");
  const clock = virtualClock(), entered = deferred();
  let signal: AbortSignal | undefined;
  const snapshot = spyOn(liveness, "agentLivenessSnapshot").mockImplementation(async request => {
    signal = request.signal ?? undefined;
    entered.resolve();
    await new Promise<void>((_, reject) => request.signal!.addEventListener("abort", () => reject(request.signal!.reason), { once: true }));
    return { conversations: [] } as never;
  });
  try {
    const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
    rig.deps.sources!.liveness = defaultSeatTickAdmissionSources().liveness;
    Object.assign(rig.deps, { workClock: clock.now, workScheduler: clock.scheduler, workBudgetMs: 100 });
    const checking = runSeatTickCheck(PROJECT, rig.deps);
    await entered.promise;
    expect(signal?.aborted).toBe(false);
    clock.advance(100);
    expect((await checking)?.verdict).toBe("error");
    expect(signal?.aborted).toBe(true);
  } finally { snapshot.mockRestore(); }
});

const childMode = process.env.LLV_SEAT_DEADLINE_TEST_MODE;
test.skipIf(!childMode)("seat deadline subprocess case", async () => {
  const filename = process.env.LLV_SEAT_DEADLINE_TEST_STATE!;
  if (childMode === "expire") writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 7, ...OVERDUE }, filename);
  const clock = virtualClock();
  const rig = harness({ pipelines: OPEN_LANE, stateFile: filename, wakeState: "landed",
    ...(childMode === "expire" ? { deliverWith: async () => {
      const key = readSeatTickState(PROJECT, filename).outstandingWake?.clientMessageId;
      process.stdout.write(`DEADLINE_READY:${key ?? "missing"}\n`);
      clock.advance(1000);
      return new Promise<DeliveryOutcome>(() => {});
    } } : {}) });
  rig.deps.workBudgetMs = 1000;
  rig.deps.workClock = clock.now;
  rig.deps.workScheduler = clock.scheduler;
  rig.deps.sources!.prepareRead = async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 1_500));
    process.stdout.write("PREPARATION_READY\n");
  };
  if (childMode === "recover") {
    const key = readSeatTickState(PROJECT, filename).outstandingWake?.clientMessageId;
    expect(typeof key).toBe("string");
    rig.deps.sources!.wakeState = async wake => {
      expect(wake.clientMessageId).toBe(key!);
      process.stdout.write(`RECOVERY_READY:${wake.clientMessageId}\n`);
      clock.advance(250);
      return "landed";
    };
  }
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  const state = readSeatTickState(PROJECT, filename);
  if (childMode === "expire") {
    const key = state.outstandingWake?.clientMessageId;
    expect(typeof key).toBe("string");
    expect(record?.verdict).toBe("error");
    expect(record?.detail).toContain("deadline exceeded");
    expect(key ?? undefined).toBe(rig.sent[0]?.clientMessageId ?? undefined);
    expect(state.lastWakeAt).toBe(OVERDUE.lastWakeAt);
  } else {
    expect(state.outstandingWake).toBeNull();
    expect(state.lastWakeAt).toBe(new Date(NOW).toISOString());
    expect(rig.sent).toHaveLength(0);
  }
  process.stdout.write(`DEADLINE_DONE:${childMode}\n`);
});

test.skipIf(!!childMode)("a deadline in a real process preserves the wake for the restarted controller", async () => {
  const filename = path.join(fs.mkdtempSync(path.join(SANDBOX, "deadline-process-")), "state.json");
  const runner = path.resolve(import.meta.dir, "../../../scripts/owned-runner.ts");
  for (const mode of ["expire", "recover"]) {
    const child = spawn(process.execPath, [runner, "--budget", "15000", process.execPath,
      "test", import.meta.path, "--test-name-pattern", "seat deadline subprocess case"], {
      env: { ...process.env, LLV_SEAT_DEADLINE_TEST_MODE: mode, LLV_SEAT_DEADLINE_TEST_STATE: filename }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "", errors = "";
    child.stdout.on("data", chunk => { output += chunk.toString(); });
    child.stderr.on("data", chunk => { errors += chunk.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject); child.once("close", resolve);
    });
    expect({ code, errors }).toMatchObject({ code: 0 });
    expect(output).toContain(`DEADLINE_DONE:${mode}`);
    expect(output).toContain("PREPARATION_READY");
    if (mode === "expire") expect(output).toMatch(/DEADLINE_READY:[^\s]+/);
    else expect(output).toMatch(/RECOVERY_READY:[^\s]+/);
  }
});
