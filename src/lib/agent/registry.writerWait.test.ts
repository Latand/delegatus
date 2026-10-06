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
 * path now waits for the write lock asynchronously. These hold the lock from
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

test("a writer lock held elsewhere is waited out without holding the event loop, and the mutation after it keeps its revision", async () => {
  const { store: registry, filename } = store("async-wait");
  try {
    const before = registry.snapshot().revision;
    const holder = new Database(filename);
    holder.exec("PRAGMA busy_timeout = 0");
    holder.exec("BEGIN IMMEDIATE");
    setTimeout(() => holder.exec("ROLLBACK"), 300);
    const startedAt = performance.now();
    const { value: free, gapMs } = await longestLoopGap(() => withWaitCorrelation(
      { label: "delivery.outcome", operationId: "operation-wait" },
      () => registry.awaitWriterAvailable(),
    ));
    holder.close();
    expect(free).toBe(true);
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(250);
    expect(gapMs).toBeLessThan(150);
    const mutation = registry.mutate((file) => { file.conversationAliases.conversation_waited = Object.keys(file.conversations)[0] as `conversation_${string}`; }, false);
    expect(mutation.revision).toBe(before + 1);
    const sample = blockingWaitDiagnostics().longest.find((candidate) => candidate.site === "registry-lock-async");
    expect(sample).toMatchObject({ synchronous: false, label: "delivery.outcome", operationId: "operation-wait" });
    expect(sample!.durationMs).toBeGreaterThanOrEqual(250);
  } finally {
    registry.close();
  }
});

test("a lock that outlasts the deadline answers false and still never holds the loop", async () => {
  const { store: registry, filename } = store("async-deadline");
  const holder = new Database(filename);
  try {
    holder.exec("PRAGMA busy_timeout = 0");
    holder.exec("BEGIN IMMEDIATE");
    const { value: free, gapMs } = await longestLoopGap(() => registry.awaitWriterAvailable({ deadlineMs: 150 }));
    expect(free).toBe(false);
    expect(gapMs).toBeLessThan(120);
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
    registry.close();
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
