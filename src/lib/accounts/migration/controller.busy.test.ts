import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import type { CodexAccount } from "@/lib/accounts/codex";
import { sqliteRegistryFixture } from "@/lib/agent/registryLockHolderFixture";
import { yieldToRuntime } from "@/lib/cooperative";
import { AccountMigrationController, reconcileAccountMigrationCycle } from "./controller";
import { emptyLaunchProfile, type SuccessorProviderPort } from "./contracts";
import { QuotaController } from "./quotaController";

async function within<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("reconciliation test did not progress")), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}

test("a quota commit refused by SQLite while migration waits is handled and retried next pass", async () => {
  const made = sqliteRegistryFixture("llv-controller-busy");
  const registry = made.registry;
  const blocker = new Database(made.sqliteFilename);
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  let unlock = false;
  let release!: () => void;
  let entered!: () => void;
  let rejected!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const creating = new Promise<void>(resolve => { entered = resolve; });
  const quotaRejected = new Promise<void>(resolve => { rejected = resolve; });
  const failures: unknown[] = [];
  let successorStarts = 0;
  let cycle: Promise<unknown> | undefined;
  try {
    registry.reconcileConversations([{
      engine: "codex", path: "/source.jsonl", accountId: "account-a",
      launchProfile: emptyLaunchProfile(), turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-10-14T21:59:00Z",
    }]);
    const intent = registry.commitMigrationIntent({ engine: "codex", targetId: "account-b", origin: "manual",
      requestId: "busy-original-key", expectedRevision: registry.engineRouting("codex").revision });
    const provider: SuccessorProviderPort = {
      virtualSource: true,
      async create(input) {
        successorStarts++;
        entered();
        await held;
        return { operationId: input.operationId, nativeId: "successor", path: "/successor.jsonl",
          continuityPaths: [], historyHash: "hash", host: { kind: "codex-app-server", identity: "successor",
            epoch: 1, verifiedAt: "2026-10-14T22:00:00Z" } };
      },
      async verify() {},
    };
    const account: CodexAccount = { id: "account-a", label: "Account A", kind: "managed",
      home: path.join(made.root, "account"), sessionsDir: path.join(made.root, "sessions"),
      authPresent: true, loginPane: null, createdAt: 1 };
    let first = true;
    const quota = new QuotaController(registry, {
      list: engine => engine === "codex" ? [account] : [], active: () => account.id,
      credentialIdentity: () => "fixture-credential",
      async probe(engine, candidate, now) {
        if (first) {
          first = false;
          await creating;
          blocker.exec("BEGIN IMMEDIATE");
          unlock = true;
        }
        return { engine, accountId: candidate.id, authenticated: true, authCheckedAt: now,
          limits: { session: { usedPercent: 10, resetsAt: null }, weekly: null, plan: "pro", capturedAt: now / 1000 },
          provenance: { source: "live", reason: null, staleSince: null }, observedAt: now };
      },
    });
    const observedQuota = {
      async tick(engine: Parameters<QuotaController["tick"]>[0]) {
        try { await quota.tick(engine); }
        catch (error) { failures.push(error); rejected(); throw error; }
      },
    };
    const controller = new AccountMigrationController(registry, observedQuota,
      () => reconcileAccountMigrationCycle(registry, observedQuota, provider, { async deliver() { return "delivered"; } }));
    cycle = controller.tick().then(() => null, error => error);
    await within(quotaRejected);
    // Leave the migration pending across event-loop turns after the real write refused.
    await yieldToRuntime();
    await yieldToRuntime();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ code: "SQLITE_BUSY" });
    expect(registry.readOnlySnapshot().quotaObservations.codex[account.id]).toBeUndefined();
    blocker.exec("ROLLBACK");
    unlock = false;
    release();
    expect(await within(cycle)).toBeNull();
    expect(warnings.mock.calls).toEqual([["[account migration controller] reconciliation deferred: SQLite writer busy; retrying next pass"]]);
    await within(controller.poll());
    const after = registry.readOnlySnapshot();
    expect(after.quotaObservations.codex[account.id]?.authenticated).toBe(true);
    expect(Object.values(after.migrationIntents)).toHaveLength(1);
    expect(after.migrationIntents[intent.id]?.state).toBe("complete");
    expect(Object.values(after.conversations)[0]?.migration?.phase).toBe("committed");
    expect(successorStarts).toBe(1);
  } finally {
    if (unlock) blocker.exec("ROLLBACK");
    release();
    try { await within(Promise.resolve(cycle)); }
    finally {
      warnings.mockRestore();
      blocker.close();
      registry.close();
      made.cleanup();
    }
  }
}, 20_000);

test("a failed quota peer keeps the cycle owned until every peer settles and preserves other errors", async () => {
  const made = sqliteRegistryFixture("llv-controller-peer-failure");
  const fatal = new Error("quota persistence failed");
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  const calls: string[] = [];
  let cycle: Promise<unknown> | undefined;
  let settled = false;
  try {
    const quota = {
      async tick(engine: Parameters<QuotaController["tick"]>[0]) {
        calls.push(engine);
        if (engine === "claude") throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        if (engine === "codex") { entered(); await held; throw fatal; }
      },
    };
    const controller = new AccountMigrationController(made.registry, quota,
      () => reconcileAccountMigrationCycle(made.registry, quota));
    cycle = controller.tick().then(() => null, error => error).then(outcome => { settled = true; return outcome; });
    await within(started);
    await yieldToRuntime();
    await yieldToRuntime();
    expect(settled).toBe(false);
    expect(controller.poll()).toBe(controller.poll());
    expect(calls).toEqual(["claude", "codex", "copilot"]);
    release();
    expect(await within(cycle)).toBe(fatal);
    expect(warnings.mock.calls).toEqual([]);
  } finally {
    release();
    try { await within(Promise.resolve(cycle)); }
    finally {
      warnings.mockRestore();
      made.registry.close();
      made.cleanup();
    }
  }
});
