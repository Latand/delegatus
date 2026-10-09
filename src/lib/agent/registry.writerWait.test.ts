import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { blockingWaitDiagnostics, resetBlockingWaitsForTests, withWaitCorrelation } from "@/lib/blockingWaits";

import { AgentRegistry, normalizeRegistry } from "./registry";
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

test("a writer lock held elsewhere is waited out without holding the event loop, and the mutation commits inside the acquisition", async () => {
  const { store: registry, filename } = store("async-wait");
  try {
    const before = registry.snapshot().revision;
    const holder = new Database(filename);
    holder.exec("PRAGMA busy_timeout = 0");
    holder.exec("BEGIN IMMEDIATE");
    setTimeout(() => holder.exec("ROLLBACK"), 300);
    const startedAt = performance.now();
    let lockedOut = false;
    const { value: write, gapMs } = await longestLoopGap(() => withWaitCorrelation(
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
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(250);
    expect(gapMs).toBeLessThan(150);
    expect(write.acquired && write.value.revision).toBe(before + 1);
    expect(registry.snapshot().file.conversationAliases.conversation_waited).toBeDefined();
    const sample = blockingWaitDiagnostics().longest.find((candidate) => candidate.site === "registry-lock-async");
    expect(sample).toMatchObject({ synchronous: false, label: "delivery.outcome", operationId: "operation-wait" });
    expect(sample!.durationMs).toBeGreaterThanOrEqual(250);
    expect(blockingWaitDiagnostics().sites["registry-lock"]).toBeUndefined();
    /* The connection is back to ordinary mutations afterwards. */
    expect(registry.mutate((file) => { delete file.conversationAliases.conversation_waited; }, false).revision).toBe(before + 2);
  } finally {
    registry.close();
  }
});

test("a lock another process keeps past the deadline is refused: nothing runs and the synchronous wait is never entered", async () => {
  const { store: registry, filename } = store("async-deadline");
  /* Another process, as in the incident: nothing in this one could release it
     while a synchronous acquisition spun. */
  const child = Bun.spawn([process.execPath, "-e", `
    const { Database } = require("bun:sqlite");
    const db = new Database(${JSON.stringify(filename)});
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    process.stdout.write("locked\\n");
    setTimeout(() => { db.exec("ROLLBACK"); db.close(); }, 900);
  `], { stdout: "pipe", stderr: "inherit" });
  try {
    const reader = child.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("locked");
    reader.releaseLock();
    const before = registry.snapshot().revision;
    let ran = false;
    const startedAt = performance.now();
    const { value: write, gapMs } = await longestLoopGap(() => registry.withWriter(() => { ran = true; }, { deadlineMs: 200 }));
    expect(write.acquired).toBe(false);
    expect(ran).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(600);
    expect(gapMs).toBeLessThan(150);
    expect(blockingWaitDiagnostics().sites["registry-lock"]).toBeUndefined();
    expect(blockingWaitDiagnostics().sites["registry-lock-async"]?.count).toBe(1);
    await child.exited;
    expect(registry.snapshot().revision).toBe(before);
  } finally {
    await child.exited;
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
    setTimeout(() => {
      holder.exec("ROLLBACK");
      /* Takes the lock the moment it is free, ahead of the waiting write. */
      other.mutate((file) => { file.conversationAliases.conversation_other = conversation; }, false);
    }, 120);
    const { value: write, gapMs } = await longestLoopGap(() => registry.withWriter(
      () => registry.mutate((file) => {
        expect(file.conversationAliases.conversation_other).toBe(conversation);
        file.conversationAliases.conversation_mine = conversation;
      }, false),
    ));
    expect(write.acquired && write.value.revision).toBe(before + 2);
    expect(gapMs).toBeLessThan(150);
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
    setTimeout(() => holder.exec("ROLLBACK"), 250);
    const { value: written, gapMs } = await longestLoopGap(() => registry.recordDeliveryOutcomeForOperationOffLoop(
      "conversation_none", "operation-none", "delivered"));
    expect(written).toBe(true);
    expect(gapMs).toBeLessThan(150);
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
  } finally {
    await child.exited;
    registry.close();
  }
});
