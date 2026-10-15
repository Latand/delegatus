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
