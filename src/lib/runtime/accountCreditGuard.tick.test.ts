import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrationDeliveryFixture } from "@/test-helpers/migrationDelivery";
import { bindStructuredDeliveryQueue } from "./structuredDeliveryController";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";
import { AgentRegistry } from "@/lib/agent/registry";
import { interruptionObligationDirectory, interruptionObligationStore } from "./interruptionObligations";
import { ACCOUNT_GUARD_FALLBACK_MS, enforceAccountCreditGuard } from "./accountCreditGuard";
import { DeliveryWake } from "./deliveryWake";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-ticks-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
function fixture(name: string) {
  const registry = new AgentRegistry(path.join(root, name, "registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  const directory = interruptionObligationDirectory(registry.filename);
  const store = interruptionObligationStore(directory);
  const poll = (now = 0) => enforceAccountCreditGuard(registry, [], async () => true, async () => false, async () => null,
    { onlyIfChanged: true, now });
  return { registry, directory, store, poll };
}
const cut = (n: number) => ({ conversationId: `conversation_fixture_${n}` as const, engine: "codex" as const,
  hostKey: `codex:fixture-${n}`, path: `/fixture/${n}.jsonl`, owner: null, claimEpoch: 1, turnRef: "fixture-turn",
  boundary: "paid-credit-guard", reason: "account-guard" as const, recordedAt: "2026-01-01T00:00:00.000Z",
  checkpoint: { lastEventKind: null, lastEventAt: null }, seat: null });

function countReads(directory: string) {
  let count = 0;
  const original = fs.readFileSync;
  const spy = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]).startsWith(directory)) count++;
    return Reflect.apply(original, fs, args);
  }) as typeof original);
  return { get count() { return count; }, restore: () => spy.mockRestore() };
}

test("an unchanged tick performs no registry or obligation-store work after its bounded pending sweep", async () => {
  const f = fixture("unchanged");
  try {
    for (let n = 0; n < 128; n++) f.store.record(cut(n));
    // Drain the initial records and the pending index marker.
    for (let n = 0; n < 3; n++) await f.poll();
    const reads = countReads(f.directory);
    const sqlQueries = spyOn(Database.prototype, "query");
    const sqlExec = spyOn(Database.prototype, "exec");
    const quota = spyOn(f.registry, "quotaObservations");
    const snapshot = spyOn(f.registry, "readOnlySnapshot");
    try {
      for (let n = 1; n <= 4; n++) await f.poll(n * 1_000);
      expect(reads.count).toBe(0);
      expect(sqlQueries).not.toHaveBeenCalled();
      expect(sqlExec).not.toHaveBeenCalled();
      expect(quota).not.toHaveBeenCalled();
      expect(snapshot).not.toHaveBeenCalled();
    } finally { reads.restore(); quota.mockRestore(); snapshot.mockRestore(); sqlQueries.mockRestore(); sqlExec.mockRestore(); }
  } finally { f.registry.close(); }
});

test("a local pending write wakes the guard, while replaying that cut leaves the next tick idle", async () => {
  const f = fixture("changed");
  try {
    await f.poll();
    f.store.record(cut(1));
    const reads = countReads(f.directory);
    try { await f.poll(1); expect(reads.count).toBeGreaterThan(0); } finally { reads.restore(); }
    f.store.record(cut(1));
    const replay = countReads(f.directory);
    try { await f.poll(2); expect(replay.count).toBe(0); } finally { replay.restore(); }
  } finally { f.registry.close(); }
});

test("a failed store pass remains dirty and is retried on the next tick", async () => {
  const f = fixture("refusal");
  const failed = spyOn(f.registry, "quotaObservations").mockImplementationOnce(() => { throw new Error("quota unavailable"); });
  try {
    await expect(f.poll()).rejects.toThrow("quota unavailable");
    await f.poll(1);
    expect(failed).toHaveBeenCalledTimes(2);
    await f.poll(2);
    expect(failed).toHaveBeenCalledTimes(2);
  } finally { failed.mockRestore(); f.registry.close(); }
});

for (const failureAt of ["operator stop", "continuation"] as const) {
  test(`a failed ${failureAt} reconciliation retries its pending page on the next tick`, async () => {
    const f = migrationDeliveryFixture();
    const store = interruptionObligationStore(interruptionObligationDirectory(f.registry.filename));
    const generation = f.conversation.generations.at(-1)!;
    const ids: string[] = [];
    let failedId: string | null = null;
    let fail = true;
    const visits = new Map<string, number>();
    const resumed: string[] = [];
    f.registry.upsert({ ...f.registry.readOnlySnapshot().entries[`codex:${f.key.sessionId}`]!, status: "dead", structuredHost: null });
    const { accountManager } = await import("@/lib/accounts/manager");
    const selection = spyOn(accountManager, "resolveProjectSpawn").mockReturnValue({ kind: "available",
      account: { engine: "codex", accountId: "account-a", kind: "managed", home: f.root, transcriptRoot: f.root, env: { NODE_ENV: "test" } } });
    const poll = (now: number) => enforceAccountCreditGuard(f.registry, [], async () => true, async (_id, recordedAt) => {
      const id = ids[Number(recordedAt.slice(17, 19)) + Number(recordedAt.slice(14, 16)) * 60]!;
      visits.set(id, (visits.get(id) ?? 0) + 1);
      if (failureAt === "operator stop" && fail && visits.size === 3) { fail = false; failedId = id; throw new Error("reconciliation unavailable"); }
      return failureAt === "operator stop";
    }, async request => {
      if (fail && resumed.length === 2) { fail = false; failedId = request.clientMessageId!; throw new Error("reconciliation unavailable"); }
      resumed.push(request.clientMessageId!);
      return { ok: true, structured: true, outcome: "delivered", operationId: request.operationId!, target: f.conversation.id,
        receipt: { operationId: request.operationId!, idempotencyKey: request.clientMessageId!, conversationId: f.conversation.id,
          kind: "send", status: "delivered", revision: 1, at: "2026-01-01T00:00:00.000Z" } };
    }, { onlyIfChanged: true, now });
    try {
      for (let n = 0; n < 130; n++) ids.push(store.record({ ...cut(n), conversationId: f.conversation.id,
        hostKey: `codex:${f.key.sessionId}`, path: generation.path, turnRef: `retry-${n}`,
        recordedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString() }).obligation.id);
      await expect(poll(0)).rejects.toThrow("reconciliation unavailable");
      expect(failedId).not.toBeNull();
      const failed = failedId!;
      await poll(1);
      expect(visits.get(failed)).toBe(2);
      for (let n = 2; n <= 5; n++) await poll(n);
      expect(store.list()).toHaveLength(130);
      expect(store.list().every(row => row.state === (failureAt === "operator stop" ? "discharged" : "delivered"))).toBe(true);
      if (failureAt === "continuation") {
        expect(resumed).toHaveLength(130);
        expect(new Set(resumed).size).toBe(130);
      } else expect(resumed).toEqual([]);
      const calls = [...visits.values()].reduce((a, b) => a + b, 0);
      await poll(6);
      expect([...visits.values()].reduce((a, b) => a + b, 0)).toBe(calls);
    } finally { selection.mockRestore(); await f.cleanup(); }
  });
}

test("external writes are found by the slow fallback, and a fresh process inspects durable pending work", async () => {
  const f = fixture("external");
  const childSource = `import { accountGuardObligationStore } from ${JSON.stringify(path.join(import.meta.dir, "interruptionObligations.ts"))};
    await accountGuardObligationStore(process.argv[1]).record(JSON.parse(process.argv[2]));`;
  try {
    await f.poll();
    const child = Bun.spawn([process.execPath, "-e", childSource, f.directory, JSON.stringify(cut(1))], {
      env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const errors = new Response(child.stderr).text();
    if (await child.exited !== 0) throw new Error(await errors);
    await errors;
    const reads = countReads(f.directory);
    try {
      await f.poll(1); expect(reads.count).toBe(0);
      await f.poll(ACCOUNT_GUARD_FALLBACK_MS); expect(reads.count).toBeGreaterThan(0);
    } finally { reads.restore(); }
    const restartSource = `import fs from "node:fs";
import { AgentRegistry } from ${JSON.stringify(path.resolve(import.meta.dir, "../agent/registry.ts"))};
      import { enforceAccountCreditGuard } from ${JSON.stringify(path.join(import.meta.dir, "accountCreditGuard.ts"))};
      const registry = new AgentRegistry(process.argv[1], undefined, undefined, {sqliteMode:"sqlite"});
      let reads=0; const read=fs.readFileSync; fs.readFileSync=(...args)=>{if(String(args[0]).startsWith(process.argv[2]))reads++;return Reflect.apply(read,fs,args)};
      try { await enforceAccountCreditGuard(registry,[],async()=>true,async()=>false,async()=>null,{onlyIfChanged:true,now:0}); }
      finally { fs.readFileSync=read; registry.close(); }
      console.log(reads);`;
    const restart = Bun.spawn([process.execPath, "-e", restartSource, f.registry.filename, f.directory], {
      env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const output = new Response(restart.stdout).text(); const stderr = new Response(restart.stderr).text();
    if (await restart.exited !== 0) throw new Error(await stderr);
    expect(Number((await output).trim())).toBeGreaterThan(0); await stderr;
  } finally { f.registry.close(); }
});


test("the delivery watchdog skips guard storage when its inputs are unchanged", async () => {
  const f = migrationDeliveryFixture();
  const interval = globalThis.setInterval;
  let tick: (() => void) | undefined;
  const capture = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, ms?: number) => {
    if (ms === 31_337) tick = callback;
    return interval(callback, ms);
  }) as typeof setInterval);
  try {
    await bindStructuredDeliveryQueue([], { registry: f.registry, client: f.client,
      watchdogIntervalMs: 31_337, hostlessSettleIntervalMs: 0, settlementSweepMs: 0 });
    await kickStructuredDeliveryQueue();
    expect(tick).toBeDefined();
    const reads = countReads(interruptionObligationDirectory(f.registry.filename));
    const quota = spyOn(f.registry, "quotaObservations");
    try {
      for (let n = 0; n < 3; n++) {
        tick!();
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      expect(reads.count).toBe(0);
      expect(quota).not.toHaveBeenCalled();
    } finally { reads.restore(); quota.mockRestore(); }
  } finally {
    capture.mockRestore();
    await bindStructuredDeliveryQueue([], { client: null });
    await f.cleanup();
  }
});

test("the delivery watchdog bounds guard logs while pending work retries during startup", async () => {
  const f = migrationDeliveryFixture();
  const store = interruptionObligationStore(interruptionObligationDirectory(f.registry.filename));
  const pending = store.record({ ...cut(1), conversationId: f.conversation.id,
    hostKey: `codex:${f.key.sessionId}`, path: f.conversation.generations.at(-1)!.path,
    seat: { project: "rotated-seat", seatEpoch: 1 } }).obligation;
  const interval = globalThis.setInterval;
  let tick: (() => void) | undefined;
  const capture = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, ms?: number) => {
    if (ms === 31_337) tick = callback;
    return interval(callback, ms);
  }) as typeof setInterval);
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const message = "[structured delivery] paid-credit guard retry pending";
  const logs = spyOn(console, "error").mockImplementation(() => {});
  const guardLogs = () => logs.mock.calls.filter(([label]) => label === message);
  const quota = spyOn(f.registry, "quotaObservations").mockReturnValue([]);
  const fault = new Error("quota unavailable");
  const tickAt = async (ms: number) => {
    now = ms;
    const calls = quota.mock.calls.length;
    tick!();
    await Promise.resolve();
    if (quota.mock.calls.length > calls) {
      // Join the real in-flight pass, including any asynchronous store work.
      await enforceAccountCreditGuard(f.registry, [], async () => true, async () => false, async () => null)
        .catch(error => { expect(error).toBe(fault); });
    }
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  const failAt = async (ms: number) => {
    // The host selector reads quota first. Fault the guard's own pass so it
    // leaves its existing pending work eligible for the next tick.
    quota.mockReturnValueOnce([]).mockImplementationOnce(() => { throw fault; });
    await tickAt(ms);
  };
  try {
    await bindStructuredDeliveryQueue([], { registry: f.registry, client: f.client, deferStartupWork: true,
      watchdogIntervalMs: 31_337, hostlessSettleIntervalMs: 0, settlementSweepMs: 0 });
    expect(tick).toBeDefined();
    for (let second = 0; second < 60; second++) await failAt(second * 1_000);
    expect(quota).toHaveBeenCalledTimes(120);
    expect(guardLogs()).toHaveLength(1);
    expect(guardLogs()).toEqual([[message, fault]]);
    expect(store.list().find(row => row.id === pending.id)?.state).toBe("owed");
    await failAt(60_000);
    expect(quota).toHaveBeenCalledTimes(122);
    expect(guardLogs()).toEqual([[message, fault], [message, { suppressedFailures: 59 }]]);

    await tickAt(61_000);
    expect(store.list().find(row => row.id === pending.id)?.state).toBe("discharged");
    await tickAt(62_000);
    await tickAt(63_000);
    expect(guardLogs()).toHaveLength(2);
    await failAt(123_000);
    expect(guardLogs()).toEqual([[message, fault], [message, { suppressedFailures: 59 }], [message, { suppressedFailures: 0 }]]);
  } finally {
    quota.mockRestore(); logs.mockRestore(); clock.mockRestore(); capture.mockRestore();
    await f.cleanup();
  }
});

test("post-startup drain retries keep string guard failures within the shared log budget and recover work", async () => {
  const f = migrationDeliveryFixture();
  const store = interruptionObligationStore(interruptionObligationDirectory(f.registry.filename));
  const pending = store.record({ ...cut(1), conversationId: f.conversation.id,
    hostKey: `codex:${f.key.sessionId}`, path: f.conversation.generations.at(-1)!.path,
    seat: { project: "rotated-seat", seatEpoch: 1 } }).obligation;
  const message = "[structured delivery] paid-credit guard retry pending";
  const logs = spyOn(console, "error").mockImplementation(() => {});
  const retryDelays: number[] = [];
  const originalSchedule = DeliveryWake.prototype.schedule;
  const schedule = spyOn(DeliveryWake.prototype, "schedule").mockImplementation(function (this: DeliveryWake, ms: number) {
    retryDelays.push(ms);
    return originalSchedule.call(this, ms);
  });
  let now = 100;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const quota = spyOn(f.registry, "quotaObservations").mockReturnValue([]);
  try {
    await bindStructuredDeliveryQueue([], { registry: f.registry, client: f.client,
      watchdogIntervalMs: 0, hostlessSettleIntervalMs: 0, settlementSweepMs: 0 });
    for (let attempt = 0; attempt < 5; attempt++) {
      quota.mockImplementationOnce(() => { throw "quota unavailable"; });
      await kickStructuredDeliveryQueue();
    }
    expect(retryDelays).toEqual([25, 50, 100, 200, 400]);
    expect(logs.mock.calls.filter(([label]) => label === message)).toHaveLength(1);
    expect(logs.mock.calls.some(([label]) => label === "[structured delivery] queue drain failed; retry scheduled")).toBe(false);
    expect(store.list().find(row => row.id === pending.id)?.state).toBe("owed");

    now += 1_000;
    quota.mockRestore();
    await kickStructuredDeliveryQueue();
    expect(logs.mock.calls.filter(([label]) => label === message)).toHaveLength(1);
    expect(store.list().find(row => row.id === pending.id)?.state).toBe("discharged");
  } finally {
    quota.mockRestore(); clock.mockRestore(); schedule.mockRestore(); logs.mockRestore();
    await bindStructuredDeliveryQueue([], { client: null });
    await f.cleanup();
  }
});

test("successful drain passes do not reset the guard diagnostic deadline", async () => {
  const f = migrationDeliveryFixture();
  const logs = spyOn(console, "error").mockImplementation(() => {});
  const quota = spyOn(f.registry, "quotaObservations").mockReturnValue([]);
  let now = 100;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const message = "[structured delivery] paid-credit guard retry pending";
  try {
    await bindStructuredDeliveryQueue([], { registry: f.registry, client: f.client,
      watchdogIntervalMs: 0, hostlessSettleIntervalMs: 0, settlementSweepMs: 0 });
    for (let attempt = 0; attempt < 5; attempt++) {
      quota.mockImplementationOnce(() => { throw new Error("quota unavailable"); });
      await kickStructuredDeliveryQueue();
      await kickStructuredDeliveryQueue();
    }
    expect(logs.mock.calls.filter(([label]) => label === message)).toHaveLength(1);
    expect(logs.mock.calls.some(([label]) => label === "[structured delivery] queue drain failed; retry scheduled")).toBe(false);
    now = 1_000;
    quota.mockImplementationOnce(() => { throw new Error("quota unavailable"); });
    await kickStructuredDeliveryQueue();
    expect(logs.mock.calls.filter(([label]) => label === message)).toHaveLength(1);
  } finally {
    quota.mockRestore(); clock.mockRestore(); logs.mockRestore();
    await bindStructuredDeliveryQueue([], { client: null });
    await f.cleanup();
  }
});
