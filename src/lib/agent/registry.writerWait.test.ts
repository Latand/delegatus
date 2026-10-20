import { loopProgressProbe, registryLockHolder, whileRegistryWriterHeld } from "./registryLockHolderFixture";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { blockingWaitDiagnostics, resetBlockingWaitsForTests, withWaitCorrelation } from "@/lib/blockingWaits";

import { AgentRegistry, closeAgentRegistryForTests, normalizeRegistry, readAgentSessionTarget, setAgentRegistryForTests } from "./registry";
import { SqliteAgentRegistryStore } from "./sqliteRegistryStore";

/*
 * Incident 2026-10-06: registry mutation retries of 1.0–4.1 s ran on the
 * Viewer's event loop, so every request behind them waited too. The delivery
 * path now waits for the write lock asynchronously and keeps it for the write,
 * and a lock it cannot get in time is refused. These hold the lock from
 * another connection or process and measure the caller's event loop. Every
 * database here is a private temporary file.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-writer-wait-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
beforeEach(() => resetBlockingWaitsForTests(() => {}));

for (const revoked of [false, true]) test(`a mixed account callback retries a rival writer outside custody and repeats its guard (revoked=${revoked})`, async () => {
  const directory = fs.mkdtempSync(path.join(root, "mixed-writer-"));
  const filename = path.join(directory, "registry.json");
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  const peer = new Database(path.join(directory, "registry.sqlite"));
  let attempts = 0;
  let current = true;
  let rivalHeld = false;
  try {
    const work = registry.accountMutationWrite("registry.mixed-fixture", () => {
      attempts++;
      if (attempts === 1) {
        peer.exec("BEGIN IMMEDIATE");
        rivalHeld = true;
        setImmediate(() => {
          if (revoked) current = false;
          peer.exec("ROLLBACK");
          rivalHeld = false;
        });
      }
      registry.setEngineRouting("codex", "mixed-account");
    }, () => { if (!current) throw new Error("mixed custody replaced"); }, { releaseBeforeWrite: true });
    if (revoked) await expect(work).rejects.toThrow("mixed custody replaced");
    else expect((await work).acquired).toBe(true);
    expect(attempts).toBe(revoked ? 1 : 2);
    expect(registry.engineRouting("codex").activeAccountId).toBe(revoked ? null : "mixed-account");
    expect(blockingWaitDiagnostics().sites["registry-lock"]).toBeUndefined();
    registry.close();
    const reopened = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
    try { expect(reopened.engineRouting("codex").activeAccountId).toBe(revoked ? null : "mixed-account"); }
    finally { reopened.close(); }
  } finally {
    if (rivalHeld) peer.exec("ROLLBACK");
    peer.close(); registry.close();
  }
});

for (const prepared of [false, true]) test(`an admitted group keeps every mutation under its writer and preserves successful members on failure (prepared=${prepared})`, async () => {
  const directory = fs.mkdtempSync(path.join(root, "writer-group-"));
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  const peer = new Database(path.join(directory, "registry.sqlite"));
  const first = "/sessions/group-first.jsonl";
  const second = "/sessions/group-second.jsonl";
  try {
    registry.readOnlySnapshot();
    if (prepared) await registry.prepareReadOnlySnapshot();
    await expect(registry.deliveryWriteBatchOrBusy({ label: "registry.group-fixture" }, () => {
      const a = registry.ensureConversation("codex", first, null);
      expect(registry.conversationForPath(first)?.id).toBe(a.id);
      expect(registry.readOnlySnapshot().conversations[a.id]?.generations[0]?.path).toBe(first);
      peer.exec("PRAGMA busy_timeout = 0");
      expect(() => peer.exec("BEGIN IMMEDIATE")).toThrow();
      registry.ensureConversation("codex", second, null);
      expect(() => registry.setStructuredHost({ engine: "codex", sessionId: "missing" }, null)).toThrow("missing");
      throw new Error("later group member refused");
    })).rejects.toThrow("later group member refused");
    expect(registry.conversationForPath(first)).not.toBeNull();
    expect(registry.conversationForPath(second)).not.toBeNull();
    expect(blockingWaitDiagnostics().sites["registry-lock"]).toBeUndefined();
    peer.exec("BEGIN IMMEDIATE");
    peer.exec("ROLLBACK");
    registry.close();
    const reopened = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
    try {
      expect(reopened.conversationForPath(first)).not.toBeNull();
      expect(reopened.conversationForPath(second)).not.toBeNull();
    } finally { reopened.close(); }
  } finally { peer.close(); registry.close(); }
});

test("a failed batch member rolls back its draft and subsequent members still commit", async () => {
  const f = store("batch-savepoint");
  try {
    await f.store.withWriter(() => f.store.withMutationBatch(() => {
      f.store.mutate(file => { file.engineRouting.codex.activeAccountId = "first"; }, false);
      expect(() => f.store.mutate(file => {
        file.engineRouting.codex.activeAccountId = "refused";
        file.engineRouting.claude.activeAccountId = "refused";
        throw new Error("batch member refused");
      }, false)).toThrow("batch member refused");
      expect(f.store.readOnlySnapshot().file.engineRouting.codex.activeAccountId).toBe("first");
      expect(f.store.readOnlySnapshot().file.engineRouting.claude.activeAccountId).not.toBe("refused");
      f.store.mutate(file => { file.engineRouting.claude.activeAccountId = "last"; }, false);
    }));
    expect(f.store.snapshot().file.engineRouting).toMatchObject({ codex: { activeAccountId: "first" }, claude: { activeAccountId: "last" } });
  } finally { f.store.close(); }
  const reopened = new SqliteAgentRegistryStore(f.filename, { initialSnapshot: () => { throw new Error("already initialized"); }, normalize: normalizeRegistry });
  try {
    expect(reopened.snapshot().file.engineRouting).toMatchObject({ codex: { activeAccountId: "first" }, claude: { activeAccountId: "last" } });
  } finally { reopened.close(); }
});

test("a refused batch commit discards cached drafts and permits a fresh writer", async () => {
  const f = store("batch-commit-refusal");
  const before = structuredClone(f.store.readOnlySnapshot().file.engineRouting);
  const execute = Database.prototype.exec;
  let refuse = false;
  const fault = spyOn(Database.prototype, "exec").mockImplementation(function (this: Database, sql: string) {
    if (refuse && sql === "COMMIT") { refuse = false; throw new Error("batch commit refused"); }
    return execute.call(this, sql);
  });
  try {
    await expect(f.store.withWriter(() => f.store.withMutationBatch(() => {
      f.store.mutate(file => { file.engineRouting.codex.activeAccountId = "discarded"; }, false);
      expect(f.store.readOnlySnapshot().file.engineRouting.codex.activeAccountId).toBe("discarded");
      refuse = true;
    }))).rejects.toThrow("batch commit refused");
    expect(f.store.readOnlySnapshot().file.engineRouting).toEqual(before);
    await f.store.withWriter(() => f.store.mutate(file => { file.engineRouting.codex.activeAccountId = "accepted"; }, false));
    expect(f.store.readOnlySnapshot().file.engineRouting.codex.activeAccountId).toBe("accepted");
  } finally { fault.mockRestore(); f.store.close(); }
});

function store(name: string): { store: SqliteAgentRegistryStore; filename: string } {
  const registry = new AgentRegistry(path.join(root, `${name}.json`), undefined, undefined, { sqliteMode: "off" });
  registry.reconcileConversations([{ engine: "codex", path: `/sessions/${name}.jsonl`, accountId: "default",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }), turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: new Date().toISOString() }]);
  const filename = path.join(root, `${name}.sqlite`);
  return { store: new SqliteAgentRegistryStore(filename, { initialSnapshot: registry.snapshot(), normalize: normalizeRegistry }), filename };
}

/** The longest gap between 5 ms ticks while `operation` runs. */
async function longestLoopGap<T>(operation: () => Promise<T> | T): Promise<{ value: T; gapMs: number }> {
  let last = performance.now();
  let gapMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    gapMs = Math.max(gapMs, now - last);
    last = now;
  }, 5);
  try {
    const value = await operation();
    await new Promise((resolve) => setTimeout(resolve, 15));
    gapMs = Math.max(gapMs, performance.now() - last);
    return { value, gapMs };
  } finally {
    clearInterval(timer);
  }
}

test("spawn failure rechecks recovery authority after waiting for a peer writer", async () => {
  const directory = fs.mkdtempSync(path.join(root, "cancelled-spawn-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd: "/repo", transport: "structured", accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: "/repo", title: "Cancelled recovery fixture" }) });
  registry.holdDelivery(begun.receipt.conversationId, "Original instruction", `spawn_${begun.receipt.launchId}`, "text");
  const before = structuredClone(registry.readOnlySnapshot());
  const peer = new Database(path.join(directory, "agent-registry.sqlite"));
  let active = true;
  let advanced = false;
  let locked = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    peer.exec("BEGIN IMMEDIATE"); locked = true;
    const failing = registry.failSpawnOffLoop(begun.receipt.launchId, "Recovery failure", () => {
      if (!active) throw Error("release retired");
    });
    timer = setTimeout(() => {
      advanced = true; active = false;
      peer.exec("ROLLBACK"); locked = false;
    }, 100);
    await expect(failing).rejects.toThrow("release retired");
    expect(advanced).toBe(true);
    const after = registry.readOnlySnapshot();
    expect(after.receipts).toEqual(before.receipts);
    expect(after.heldDeliveries).toEqual(before.heldDeliveries);
  } finally {
    clearTimeout(timer);
    if (locked) peer.exec("ROLLBACK");
    peer.close(); registry.close();
  }
});

test("a writer lock held elsewhere is waited out without holding the event loop, and the mutation commits inside the acquisition", async () => {
  const { store: registry, filename } = store("async-wait");
  try {
    const before = registry.snapshot().revision;
    const holder = new Database(filename);
    holder.exec("PRAGMA busy_timeout = 0");
    holder.exec("BEGIN IMMEDIATE");
    const probe = loopProgressProbe();
    probe.arm(() => { holder.exec("ROLLBACK"); });
    let lockedOut = false;
    const write = await probe.run(() => withWaitCorrelation(
      { label: "delivery.outcome", operationId: "operation-wait" },
      () => registry.withWriter(() => {
        /* The lock is this connection's from the acquisition to the commit:
           no other writer can get in between the wait and the write. */
        try { holder.exec("BEGIN IMMEDIATE"); holder.exec("ROLLBACK"); }
        catch (error) { lockedOut = (error as { code?: string }).code === "SQLITE_BUSY"; }
        return registry.mutate((file) => { file.conversationAliases.conversation_waited = Object.keys(file.conversations)[0] as `conversation_${string}`; }, false);
      }),
    ));
    holder.close();
    expect(lockedOut).toBe(true);
    expect(write.acquired).toBe(true);

    expect(write.acquired && write.value.revision).toBe(before + 1);
    expect(registry.snapshot().file.conversationAliases.conversation_waited).toBeDefined();
    const sample = blockingWaitDiagnostics().longest.find((candidate) => candidate.site === "registry-lock-async");
    expect(sample).toMatchObject({ synchronous: false, label: "delivery.outcome", operationId: "operation-wait" });
    expect(sample!.durationMs).toBeGreaterThan(0);
    expect(blockingWaitDiagnostics().sites["registry-lock"]).toBeUndefined();
    /* The connection is back to ordinary mutations afterwards. */
    expect(registry.mutate((file) => { delete file.conversationAliases.conversation_waited; }, false).revision).toBe(before + 2);
  } finally {
    registry.close();
  }
});

test("a lock another process keeps past the deadline is refused: nothing runs and the synchronous wait is never entered", async () => {
  const { store: registry, filename } = store("async-deadline");
  const holder = registryLockHolder(filename);
  try {
    await holder.hold();
    const before = registry.snapshot().revision;
    let ran = false;
    const { value: write } = await whileRegistryWriterHeld(holder, () => registry.withWriter(() => { ran = true; }, { deadlineMs: 200 }), { release: false });
    expect(write.acquired).toBe(false);
    expect(ran).toBe(false);

    expect(blockingWaitDiagnostics().sites["registry-lock"]).toBeUndefined();
    expect(blockingWaitDiagnostics().sites["registry-lock-async"]?.count).toBe(1);
    await holder.release();
    expect(registry.snapshot().revision).toBe(before);
  } finally {
    await holder.close();
    registry.close();
  }
});

test("a writer that commits while the delivery write waits is read by it: both changes stand and the loop stays free", async () => {
  const { store: registry, filename } = store("async-contended");
  const other = new SqliteAgentRegistryStore(filename, { initialSnapshot: registry.snapshot().file, normalize: normalizeRegistry });
  const holder = new Database(filename);
  try {
    const before = registry.snapshot().revision;
    const conversation = Object.keys(registry.snapshot().file.conversations)[0] as `conversation_${string}`;
    holder.exec("PRAGMA busy_timeout = 0");
    holder.exec("BEGIN IMMEDIATE");
    const probe = loopProgressProbe();
    probe.arm(() => {
      holder.exec("ROLLBACK");
      /* Takes the lock the moment it is free, ahead of the waiting write. */
      other.mutate((file) => { file.conversationAliases.conversation_other = conversation; }, false);
    });
    const write = await probe.run(() => registry.withWriter(
      () => registry.mutate((file) => {
        expect(file.conversationAliases.conversation_other).toBe(conversation);
        file.conversationAliases.conversation_mine = conversation;
      }, false),
    ));
    expect(write.acquired && write.value.revision).toBe(before + 2);
    const aliases = registry.snapshot().file.conversationAliases;
    expect(aliases.conversation_other).toBe(conversation);
    expect(aliases.conversation_mine).toBe(conversation);
    expect(blockingWaitDiagnostics().sites["registry-revision-retry"]).toBeUndefined();
  } finally {
    holder.close();
    other.close();
    registry.close();
  }
});

test("an acquisition whose operation makes no mutation gives the lock back", async () => {
  const { store: registry, filename } = store("async-noop");
  const other = new Database(filename);
  try {
    expect(await registry.withWriter(() => "nothing")).toEqual({ acquired: true, value: "nothing" });
    other.exec("PRAGMA busy_timeout = 0");
    other.exec("BEGIN IMMEDIATE");
    other.exec("ROLLBACK");
    await expect(registry.withWriter(() => { throw new Error("refused inside"); })).rejects.toThrow("refused inside");
    other.exec("BEGIN IMMEDIATE");
    other.exec("ROLLBACK");
  } finally {
    other.close();
    registry.close();
  }
});

test("the registry's delivery writes wait off the loop in SQLite mode and report a lock they could not get", async () => {
  const filename = path.join(root, "registry-offloop.json");
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  const holder = new Database(`${filename.replace(/\.json$/, "")}.sqlite`);
  try {
    holder.exec("PRAGMA busy_timeout = 0");
    holder.exec("BEGIN IMMEDIATE");
    const probe = loopProgressProbe();
    probe.arm(() => { holder.exec("ROLLBACK"); });
    const written = await probe.run(() => registry.recordDeliveryOutcomeForOperationOffLoop(
      "conversation_none", "operation-none", "delivered"));
    expect(written).toBe(true);
    const sample = blockingWaitDiagnostics().longest.find((candidate) => candidate.site === "registry-lock-async");
    expect(sample).toMatchObject({ label: "delivery.outcome", operationId: "operation-none" });
    /* A plain send has no retry owner to bind, and needs no lock at all. */
    holder.exec("BEGIN IMMEDIATE");
    expect(await registry.bindDeliveryOperationGenerationOffLoop("operation-none", "generation-one")).toBe(true);
    holder.exec("ROLLBACK");
  } finally {
    holder.close();
  }
});

test("measured: the synchronous acquisition holds the caller's loop for the whole hold, and is recorded with its mutation and correlation", async () => {
  const { store: registry, filename } = store("sync-wait");
  /* Another process holds the lock, because nothing in this one can run to
     release it while the synchronous acquisition spins. */
  const child = Bun.spawn([process.execPath, "-e", `
    const { Database } = require("bun:sqlite");
    const db = new Database(${JSON.stringify(filename)});
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    process.stdout.write("locked\\n");
    setTimeout(() => { db.exec("ROLLBACK"); db.close(); }, 400);
  `], { stdout: "pipe", stderr: "inherit" });
  try {
    const reader = child.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("locked");
    reader.releaseLock();
    const { gapMs } = await longestLoopGap(() => withWaitCorrelation({ label: "delivery.outcome", operationId: "operation-sync" },
      () => registry.mutate(function recordDeliveryOutcome(file) {
        file.conversationAliases.conversation_sync = Object.keys(file.conversations)[0] as `conversation_${string}`;
      }, false)));
    expect(gapMs).toBeGreaterThanOrEqual(250);
    const sample = blockingWaitDiagnostics().longest.find((candidate) => candidate.site === "registry-lock");
    expect(sample).toMatchObject({ synchronous: true, subject: "recordDeliveryOutcome", label: "delivery.outcome", operationId: "operation-sync" });
    expect(sample?.callSite).toContain("src/lib/agent/registry.writerWait.test.ts:");
    expect(sample?.callSite).not.toContain(process.env.HOME!);
  } finally {
    await child.exited;
    registry.close();
  }
});


test("admitted reads share the writer transaction and a failing mutation releases it without a partial write", async () => {
  const filename = path.join(root, "admitted-read.json");
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  const holder = new Database(filename.replace(/\.json$/, ".sqlite"));
  const probe = loopProgressProbe();
  try {
    holder.exec("PRAGMA busy_timeout = 0");
    holder.exec("BEGIN IMMEDIATE");
    probe.arm(() => { holder.exec("ROLLBACK"); });
    const result = await probe.run(() => registry.deliveryWriteOrBusy({ label: "pipeline.parent" }, () => {
      expect(registry.conversationForPath("/sessions/admitted.jsonl")).toBeNull();
      return registry.ensureConversation("codex", "/sessions/admitted.jsonl", null);
    }));
    expect(result.id).toBeDefined();
    const first = result.id;
    const replay = await registry.deliveryWriteOrBusy({ label: "pipeline.parent" }, () =>
      registry.ensureConversation("codex", "/sessions/admitted.jsonl", null));
    expect(replay.id).toBe(first);
    await expect(registry.deliveryWriteOrBusy({ label: "pipeline.parent" }, () => {
      registry.conversation(first);
      throw new Error("admission cancelled");
    })).rejects.toThrow("admission cancelled");
    holder.exec("BEGIN IMMEDIATE");
    holder.exec("ROLLBACK");
    expect(registry.conversationForPath("/sessions/admitted.jsonl")?.id).toBe(first);
  } finally { holder.close(); registry.close(); }
});


test("a mutation that throws after changing its draft commits nothing and leaves the next writer usable", async () => {
  const { store: registry } = store("admitted-rollback");
  try {
    const before = registry.snapshot();
    await expect(registry.withWriter(() => registry.mutate(file => {
      file.conversationAliases.conversation_refused = Object.keys(file.conversations)[0] as `conversation_${string}`;
      throw new Error("mutation refused");
    }, false))).rejects.toThrow("mutation refused");
    const after = registry.snapshot();
    expect(after.revision).toBe(before.revision);
    expect(after.file.conversationAliases.conversation_refused).toBeUndefined();
    const next = await registry.withWriter(() => registry.mutate(file => {
      file.conversationAliases.conversation_accepted = Object.keys(file.conversations)[0] as `conversation_${string}`;
    }, false));
    expect(next.acquired && next.value.revision).toBe(before.revision + 1);
  } finally { registry.close(); }
});


test("runtime-switch cancellation reads and releases through real contended registry admissions", async () => {
  const { cancelPendingRuntimeSwitch } = await import("@/lib/pipelines/runtimeSwitch");
  const filename = path.join(root, "cancel-runtime.json");
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  const conversation = registry.ensureConversation("codex", "/fixture/cancel-runtime.jsonl", null);
  resetBlockingWaitsForTests(() => {});
  const holder = registryLockHolder(filename.replace(/\.json$/, ".sqlite"));
  try {
    await holder.hold();
    await whileRegistryWriterHeld(holder, () => cancelPendingRuntimeSwitch(registry, conversation.id, "switch-one"));
    await cancelPendingRuntimeSwitch(registry, conversation.id, "switch-one");
    expect(registry.conversation(conversation.id)?.reconfigureWithdrawals).toEqual([
      expect.objectContaining({ operationId: "switch-one" }),
    ]);
    expect(await registry.deliveryWriteOrBusy({ label: "test.cancellable-read" },
      () => registry.reconfigureOwnedCancellableSwitch(conversation.id))).toBe(false);
    expect(blockingWaitDiagnostics().sites["registry-lock"]).toBeUndefined();
    expect(blockingWaitDiagnostics().sites["registry-revision-retry"]).toBeUndefined();
  } finally { await holder.close(); registry.close(); }
});

// Exercise an actual Viewer request, rather than an already-admitted store callback.
test("Viewer policy write yields to a timer while a child holds the writer", async () => {
  const { NextRequest } = await import("next/server");
  const { PATCH } = await import("@/app/api/accounts/claude/policy/route");
  const directory = fs.mkdtempSync(path.join(root, "viewer-policy-"));
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  const holder = registryLockHolder(path.join(directory, "registry.sqlite"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const previousOwner = process.env.LLV_STATE_OWNER;
  process.env.LLV_STATE_OWNER = "viewer";
  setAgentRegistryForTests(registry);
  try {
    await holder.hold(200);
    let settled = false;
    const tick = new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(!settled), 10);
    });
    const writing = PATCH(new NextRequest("http://localhost/api/accounts/claude/policy", {
      method: "PATCH", headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ automaticSwitching: true, expectedRevision: 0 }),
    })).finally(() => { settled = true; });
    const progress = await tick;
    const response = await writing;
    expect(progress).toBe(true);
    expect(response.status).toBe(200);
    expect(blockingWaitDiagnostics().longest.some(sample => sample.site === "registry-lock-async" && sample.role === "viewer")).toBe(true);
    expect(registry.autoBalancePolicy("claude")).toMatchObject({ enabled: true, revision: 1 });
    expect(blockingWaitDiagnostics().sites["registry-lock"]).toBeUndefined();
    expect(blockingWaitDiagnostics().sites["registry-revision-retry"]).toBeUndefined();
  } finally {
    clearTimeout(timer);
    await holder.close();
    if (previousOwner === undefined) delete process.env.LLV_STATE_OWNER;
    else process.env.LLV_STATE_OWNER = previousOwner;
    setAgentRegistryForTests(null);
    registry.close();
  }
});

test("cold session facade opening yields while the SQLite writer is contended", async () => {
  const directory = fs.mkdtempSync(path.join(root, "session-open-wait-"));
  const previousStateDir = process.env.LLV_STATE_DIR;
  const previousOwner = process.env.LLV_STATE_OWNER;
  process.env.LLV_STATE_DIR = directory;
  process.env.LLV_STATE_OWNER = "viewer";
  const seed = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  const conversation = seed.ensureConversation("codex", "/sessions/session-open.jsonl", null);
  seed.close();
  const archive = new SqliteAgentRegistryStore(path.join(directory, "agent-registry.sqlite"), {
    initialSnapshot: () => { throw new Error("fixture already initialized"); },
    normalize: normalizeRegistry,
  });
  try { expect(archive.archiveInactive()).toBeGreaterThan(0); }
  finally { archive.close(); }
  const archivedDb = new Database(path.join(directory, "agent-registry.sqlite"), { readonly: true });
  try {
    expect(archivedDb.query("SELECT 1 FROM registry_cold WHERE collection='conversations' AND row_key=?").get(conversation.id)).toBeTruthy();
  } finally { archivedDb.close(); }
  const holder = registryLockHolder(path.join(directory, "agent-registry.sqlite"));
  closeAgentRegistryForTests();
  const query = Database.prototype.query;
  let coldKeyScans = 0;
  const queryProbe = spyOn(Database.prototype, "query").mockImplementation((function (this: Database, sql: string) {
    if (/SELECT\s+collection\s*,\s*row_key\s+FROM\s+registry_cold/i.test(sql)) coldKeyScans++;
    return query.call(this, sql);
  }) as typeof Database.prototype.query);
  try {
    await holder.hold(120);
    let settled = false;
    const opening = readAgentSessionTarget(conversation.id, "", AbortSignal.timeout(10_000)).finally(() => { settled = true; });
    const progress = await new Promise<boolean>(resolve => setTimeout(() => resolve(!settled), 10));
    expect(progress).toBe(true);
    expect(settled).toBe(false);
    expect(await opening).toEqual({ path: "/sessions/session-open.jsonl", unavailable: false });
    expect(coldKeyScans).toBe(0);
  } finally {
    queryProbe.mockRestore();
    await holder.close();
    closeAgentRegistryForTests();
    setAgentRegistryForTests(null);
    if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previousStateDir;
    if (previousOwner === undefined) delete process.env.LLV_STATE_OWNER; else process.env.LLV_STATE_OWNER = previousOwner;
  }
});

for (const engine of ["claude", "codex"] as const) {
  test(`Viewer ${engine} policy writes recheck revisions after admission and retain the first commit on reopen`, async () => {
    const { NextRequest } = await import("next/server");
    const { PATCH } = engine === "claude" ? await import("@/app/api/accounts/claude/policy/route") : await import("@/app/api/accounts/codex/policy/route");
    const directory = fs.mkdtempSync(path.join(root, `viewer-conflict-${engine}-`));
    const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
    const holder = registryLockHolder(path.join(directory, "registry.sqlite"));
    setAgentRegistryForTests(registry);
    try {
      await holder.hold();
      const request = () => PATCH(new NextRequest(`http://localhost/api/accounts/${engine}/policy`, {
        method: "PATCH", headers: { host: "localhost", "content-type": "application/json" },
        body: JSON.stringify({ automaticSwitching: true, expectedRevision: 0 }),
      }));
      const first = request();
      const second = request();
      await holder.release();
      const responses = await Promise.all([first, second]);
      expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
      const refused = responses.find(response => response.status === 409)!;
      expect(await refused.json()).toEqual({ error: "automatic balance policy revision is stale" });
      registry.close();
      const reopened = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
      try { expect(reopened.autoBalancePolicy(engine)).toMatchObject({ enabled: true, revision: 1 }); }
      finally { reopened.close(); }
    } finally {
      await holder.close();
      setAgentRegistryForTests(null);
      registry.close();
    }
  });
}

test("Viewer policy writer deadline refuses without a commit and the same request succeeds after release", async () => {
  const { NextRequest } = await import("next/server");
  const { PATCH } = await import("@/app/api/accounts/claude/policy/route");
  const directory = fs.mkdtempSync(path.join(root, "viewer-refusal-"));
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, {
    sqliteMode: "sqlite", sqliteWriterDeadlineMs: 30,
  });
  const holder = registryLockHolder(path.join(directory, "registry.sqlite"));
  const request = () => PATCH(new NextRequest("http://localhost/api/accounts/claude/policy", {
    method: "PATCH", headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ automaticSwitching: true, expectedRevision: 0 }),
  }));
  const before = registry.autoBalancePolicy("claude");
  setAgentRegistryForTests(registry);
  try {
    await holder.hold();
    const response = await request();
    expect(response.status).toBe(409);
    expect(registry.autoBalancePolicy("claude")).toEqual(before);
    expect(blockingWaitDiagnostics().sites["registry-lock"]).toBeUndefined();
    await holder.release();
    expect((await request()).status).toBe(200);
    expect(registry.autoBalancePolicy("claude")).toMatchObject({ enabled: true, revision: 1 });
  } finally {
    await holder.close();
    setAgentRegistryForTests(null);
    registry.close();
  }
});

test("Viewer policy writes commit in admission order when the writer is released between retries", async () => {
  const { NextRequest } = await import("next/server");
  const { PATCH } = await import("@/app/api/accounts/claude/policy/route");
  const directory = fs.mkdtempSync(path.join(root, "viewer-policy-order-"));
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  const holder = registryLockHolder(path.join(directory, "registry.sqlite"));
  const request = (automaticSwitching: boolean) => PATCH(new NextRequest("http://localhost/api/accounts/claude/policy", {
    method: "PATCH", headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ automaticSwitching }),
  }));
  const originalWithWriter = SqliteAgentRegistryStore.prototype.withWriter;
  let firstWaiting!: () => void;
  const observedFirstWait = new Promise<void>(resolve => { firstWaiting = resolve; });
  const withWriter = spyOn(SqliteAgentRegistryStore.prototype, "withWriter").mockImplementation((async function (
    this: SqliteAgentRegistryStore, ...args: Parameters<SqliteAgentRegistryStore["withWriter"]>
  ) {
    if (this.filename === holder.sqliteFilename) firstWaiting();
    const [operation, options] = args;
    return originalWithWriter.call(this, operation, { ...options, probeMs: 100 });
  }) as typeof originalWithWriter);
  setAgentRegistryForTests(registry);
  try {
    await holder.hold();
    const earlier = request(true);
    await observedFirstWait;
    await holder.release();
    const later = request(false);
    const responses = await Promise.all([earlier, later]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(registry.autoBalancePolicy("claude")).toMatchObject({ enabled: false, revision: 2 });
  } finally {
    withWriter.mockRestore();
    await holder.close();
    setAgentRegistryForTests(null);
    registry.close();
  }
});

test("delivery admission refuses at its own deadline while queued behind another writer", async () => {
  const directory = fs.mkdtempSync(path.join(root, "queued-delivery-deadline-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, {
    sqliteMode: "sqlite", sqliteWriterDeadlineMs: 30,
  });
  const holder = registryLockHolder(path.join(directory, "agent-registry.sqlite"));
  let callbacks = 0;
  try {
    await holder.hold();
    const earlier = registry.accountMutationWrite("earlier", () => { callbacks++; }, undefined, { waitMs: 1_000 });
    const started = performance.now();
    const later = registry.deliveryWrite({ label: "later" }, () => { callbacks++; });
    const result = await later;
    expect(result.acquired).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
    expect(callbacks).toBe(0);
    await holder.release();
    expect((await earlier).acquired).toBe(true);
    expect(callbacks).toBe(1);
  } finally {
    await holder.close();
    registry.close();
  }
});

test("account mutation admission refuses at its own deadline while queued behind delivery", async () => {
  const directory = fs.mkdtempSync(path.join(root, "queued-account-deadline-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, {
    sqliteMode: "sqlite", sqliteWriterDeadlineMs: 1_000,
  });
  const holder = registryLockHolder(path.join(directory, "agent-registry.sqlite"));
  let callbacks = 0;
  try {
    await holder.hold();
    const earlier = registry.deliveryWrite({ label: "earlier" }, () => { callbacks++; });
    const later = registry.accountMutationWrite("later", () => { callbacks++; }, undefined, { waitMs: 30 });
    const started = performance.now();
    const result = await later;
    expect(result.acquired).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
    expect(callbacks).toBe(0);
    await holder.release();
    expect((await earlier).acquired).toBe(true);
    expect(callbacks).toBe(1);
  } finally {
    await holder.close();
    registry.close();
  }
});

test("a later quota commit cannot overtake an earlier pending Viewer policy write", async () => {
  const { NextRequest } = await import("next/server");
  const { PATCH } = await import("@/app/api/accounts/claude/policy/route");
  const directory = fs.mkdtempSync(path.join(root, "viewer-policy-quota-order-"));
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  const holder = registryLockHolder(path.join(directory, "registry.sqlite"));
  const originalWithWriter = SqliteAgentRegistryStore.prototype.withWriter;
  let firstWaiting!: () => void;
  const observedFirstWait = new Promise<void>(resolve => { firstWaiting = resolve; });
  const withWriter = spyOn(SqliteAgentRegistryStore.prototype, "withWriter").mockImplementation((async function (
    this: SqliteAgentRegistryStore, ...args: Parameters<SqliteAgentRegistryStore["withWriter"]>
  ) {
    if (this.filename === holder.sqliteFilename) firstWaiting();
    const [operation, options] = args;
    return originalWithWriter.call(this, operation, { ...options, probeMs: 100 });
  }) as typeof originalWithWriter);
  setAgentRegistryForTests(registry);
  try {
    await holder.hold();
    const earlier = PATCH(new NextRequest("http://localhost/api/accounts/claude/policy", {
      method: "PATCH", headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ automaticSwitching: false, expectedRevision: 0 }),
    }));
    await observedFirstWait;
    const laterQuotaCommit = registry.accountMutationWrite("quota.commit", () => registry.recordQuotaEvaluation({
      engine: "claude", observations: [], signature: null, bootId: "quota-order", now: "2026-10-19T00:00:00.000Z", minimumGapMs: 0,
    }));
    await holder.release();
    const response = await earlier;
    const quota = await laterQuotaCommit;
    expect(response.status).toBe(200);
    expect(quota.acquired).toBe(true);
    expect(registry.autoBalancePolicy("claude")).toMatchObject({ enabled: false, revision: 2 });
  } finally {
    await holder.close();
    withWriter.mockRestore();
    setAgentRegistryForTests(null);
    registry.close();
  }
});

test("live quota refresh reads a newer peer observation after writer admission", async () => {
  const { recordLiveObservationOffLoop } = await import("@/lib/accounts/liveLimits");
  const directory = fs.mkdtempSync(path.join(root, "live-observation-"));
  const filename = path.join(directory, "registry.json");
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  const peer = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  const holder = registryLockHolder(path.join(directory, "registry.sqlite"));
  const at = Date.parse("2026-10-18T12:00:00Z");
  const observation = { engine: "codex" as const, accountId: "fixture-account", authenticated: true,
    observedAt: at, authCheckedAt: at, limits: null,
    provenance: { source: "live" as const, reason: null, staleSince: null } };
  try {
    const { durableQuotaObservation } = await import("@/lib/accounts/migration/quotaController");
    // The newer observation exists before the wait. A stale refresh must not
    // overwrite it when it finally obtains the writer.
    const newer = durableQuotaObservation({ ...observation, observedAt: at + 1000 }, "fixture-boot");
    peer.recordQuotaObservation(newer);
    resetBlockingWaitsForTests(() => {});
    await holder.hold();
    const writing = recordLiveObservationOffLoop(observation, "managed", { registry });
    await holder.release();
    expect(await writing).toEqual(newer);
    expect(registry.quotaObservations("codex")).toEqual([newer]);
    expect(blockingWaitDiagnostics().sites["registry-lock"]).toBeUndefined();
  } finally {
    await holder.close();
    registry.close(); peer.close();
  }
});

test("Viewer policy admission reads a bounded number of rows as unrelated conversation history grows", async () => {
  const { NextRequest } = await import("next/server");
  const { PATCH } = await import("@/app/api/accounts/claude/policy/route");
  const reads: number[] = [];
  for (const count of [0, 2000]) {
    const directory = fs.mkdtempSync(path.join(root, `policy-history-${count}-`));
    const filename = path.join(directory, "registry.json");
    const seed = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
    seed.reconcileConversations(Array.from({ length: count }, (_, index) => ({
      engine: "codex" as const, path: `/sessions/history-${index}.jsonl`, accountId: "default",
      observedAt: "2026-10-18T12:00:00.000Z",
      turn: { state: "idle" as const, source: "empty" as const, terminalAt: null },
      launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    })), { snapshot: false });
    seed.close();
    let payloadReads = 0;
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite",
      onSqliteRowPayloadRead: (_collection, rows) => { payloadReads += rows; },
    });
    setAgentRegistryForTests(registry);
    try {
      payloadReads = 0;
      const response = await PATCH(new NextRequest("http://localhost/api/accounts/claude/policy", {
        method: "PATCH", headers: { host: "localhost", "content-type": "application/json" },
        body: JSON.stringify({ automaticSwitching: false, expectedRevision: 0 }),
      }));
      expect(response.status).toBe(200);
      reads.push(payloadReads);
      expect(registry.autoBalancePolicy("claude")).toMatchObject({ enabled: false, revision: 1 });
    } finally { setAgentRegistryForTests(null); registry.close(); }
  }
  expect(reads[1]).toBe(reads[0]!);
  expect(reads[1]).toBeLessThan(10);
});

test("a conversation kill preserves a peer replacement installed during registry writer admission", async () => {
  const { killConversation } = await import("@/lib/delivery");
  const directory = fs.mkdtempSync(path.join(root, "kill-admission-race-"));
  const filename = path.join(directory, "registry.json");
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  const peer = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  const lock = new Database(path.join(directory, "registry.sqlite"));
  const key = { engine: "codex" as const, sessionId: "fixture-kill-admission" };
  const pathname = "/sessions/kill-admission.jsonl";
  const host = { kind: "tmux" as const, endpoint: "/runtime/tmux-fixture",
    server: { pid: 900, startIdentity: "fixture-server" }, paneId: "%7",
    panePid: { pid: 107, startIdentity: "fixture-pane" }, windowName: "fixture-worker",
    agent: { pid: 207, startIdentity: "fixture-agent" }, argv: ["codex", "resume", "fixture"] };
  const replacement = { ...host, paneId: "%8", windowName: "fixture-successor" };
  registry.upsert({ key, artifactPath: pathname, cwd: "/repo", accountId: "default",
    launchProfile: emptyLaunchProfile({ cwd: "/repo" }), status: "idle", host,
    claimEpoch: 3, claimOwner: null, pendingAction: null });
  let held = false;
  let replaced = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await killConversation(pathname, {
      registry, pathAllowed: () => true, listFiles: async () => [],
      killHost: async () => {
        lock.exec("BEGIN IMMEDIATE"); held = true;
        timer = setTimeout(() => {
          lock.exec("ROLLBACK"); held = false;
          const current = peer.readOnlySnapshot().entries[`codex:${key.sessionId}`]!;
          peer.upsert({ ...current, host: replacement, status: "live" });
          replaced = true;
        }, 10);
        return true;
      },
    });
    expect(result).toEqual({ ok: true, target: "%7" });
    expect(replaced).toBe(true);
    expect(registry.readOnlySnapshot().entries[`codex:${key.sessionId}`]).toMatchObject({ host: replacement, status: "live" });
  } finally {
    clearTimeout(timer);
    if (held) lock.exec("ROLLBACK");
    lock.close(); peer.close(); registry.close();
  }
});

for (const view of ["cold", "warm", "prepared"] as const) {
  test(`full ${view} snapshots inside writer admission keep the writer until the mutation commits`, async () => {
    const { store: registry, filename } = store(`admitted-full-${view}`);
    const peer = new SqliteAgentRegistryStore(filename, { normalize: normalizeRegistry,
      initialSnapshot: () => { throw new Error("fixture already imported"); } });
    const lock = new Database(filename);
    lock.exec("PRAGMA busy_timeout = 0");
    try {
      if (view === "warm") registry.readOnlySnapshot();
      if (view === "prepared") await registry.prepareReadOnlySnapshot();
      const target = Object.keys(peer.snapshot().file.conversations)[0] as `conversation_${string}`;
      peer.mutate(file => { file.conversationAliases.conversation_peer = target; }, false);
      const write = await registry.withWriter(() => {
        const snapshot = registry.readOnlySnapshot();
        expect(snapshot.file.conversationAliases.conversation_peer).toBe(target);
        const detached = registry.snapshot();
        delete detached.file.conversationAliases.conversation_peer;
        expect(registry.readOnlySnapshot().file.conversationAliases.conversation_peer).toBe(target);
        expect(() => lock.exec("BEGIN IMMEDIATE")).toThrow();
        return registry.mutate(file => { file.conversationAliases.conversation_admitted = target; }, false);
      });
      expect(write.acquired).toBe(true);
      expect(registry.readOnlySnapshot().file.conversationAliases).toMatchObject({ conversation_peer: target, conversation_admitted: target });
      await expect(registry.withWriter(() => {
        registry.readOnlySnapshot();
        registry.snapshot();
        throw new Error("refused after full read");
      })).rejects.toThrow("refused after full read");
      lock.exec("BEGIN IMMEDIATE");
      lock.exec("ROLLBACK");
      peer.mutate(file => { delete file.conversationAliases.conversation_admitted; }, false);
      expect(registry.readOnlySnapshot().file.conversationAliases.conversation_admitted).toBeUndefined();
    } finally { lock.close(); peer.close(); registry.close(); }
  });
}
