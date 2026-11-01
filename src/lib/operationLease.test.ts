import { expect, test } from "bun:test";
import { awaitLeasedOperation, leasedOperationPorts, OperationLease, OperationLeaseExpiredError, trackLeasedOperation, withoutOperationLease } from "./operationLease";
import { createPerformanceSpans } from "./performanceSpans";
import { createViewerLoopMonitor } from "./viewerLoopMonitor";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("a revoked lease releases its await, rejects late port calls, and preserves independent custody", async () => {
  const lease = new OperationLease();
  let calls = 0;
  const ports = lease.run(() => leasedOperationPorts({ effect: () => { calls++; }, wait: async () => new Promise<void>(() => {}) }));
  const waiting = lease.run(() => ports.wait());
  lease.expire();
  await expect(waiting).rejects.toBeInstanceOf(OperationLeaseExpiredError);
  expect(() => lease.run(() => ports.effect())).toThrow(OperationLeaseExpiredError);
  withoutOperationLease(() => ports.effect());
  expect(calls).toBe(1);
});

test("synchronous tracking invokes void and null operations exactly once", () => {
  const lease = new OperationLease();
  let calls = 0;
  lease.run(() => {
    expect(trackLeasedOperation("void", () => { calls++; })).toBeUndefined();
    expect(trackLeasedOperation("null", () => { calls++; return null; })).toBeNull();
  });
  expect(calls).toBe(2);
  expect(lease.snapshot().operations).toEqual([]);
});

test("open operation recording is bounded and reports every omitted active wait", async () => {
  const lease = new OperationLease();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waits = lease.run(() => Array.from({ length: 257 }, () => trackLeasedOperation("pending", () => gate)));
  expect(lease.snapshot().operations).toHaveLength(256);
  expect(lease.snapshot().omitted).toBe(1);
  release(); await Promise.all(waits);
  expect(lease.snapshot()).toEqual({ operations: [], omitted: 0 });
});

test("loop gaps retain open pass sub-operations beyond the sixteen longest labels", async () => {
  let now = 0;
  const lines: string[] = [];
  const spans = createPerformanceSpans(() => now);
  const monitor = createViewerLoopMonitor(line => lines.push(line), () => now, spans);
  const lease = new OperationLease();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const peers = (["registry.read", "registry.write", "registry.prepare", "runtime.startup", "runtime.rpc", "runtime.delivery-list",
    "runtime.delivery-wake", "files.get", "files.health", "controller.scan", "controller.flows", "memory.discovery", "memory.refresh",
    "memory.search", "memory.open", "forge.sweep", "forge.auto-merge", "tasks.system-run", "resources.read", "attention.read"] as const)
    .map(name => monitor.run(name, () => gate));
  now = 100;
  const ports = lease.run(() => leasedOperationPorts({ restoreMirror: async () => gate }));
  const pass = lease.run(() => monitor.run("controller.pipelines", () => spans.wait("runtime.handler", () => ports.restoreMirror())));
  now = 1000;
  monitor.tick();
  const report = JSON.parse(lines[0]!.slice("[viewer loop-gap] ".length));
  expect(report.pendingPasses).toHaveLength(1);
  expect(report.operations.some((op: { name: string }) => op.name === "controller.pipelines")).toBe(false);
  expect(report.pendingPasses[0].operations).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "port.restoreMirror" }), expect.objectContaining({ name: "runtime.handler" }),
  ]));
  lease.expire();
  await expect(pass).rejects.toBeInstanceOf(OperationLeaseExpiredError);
  expect(spans.snapshot().pending).toBe(0);
  release();
  await Promise.all(peers);
});

test.each(["resolve", "reject"] as const)("settled %s waits retire cancellation listeners and pending names", async outcome => {
  const lease = new OperationLease();
  const result = lease.run(() => awaitLeasedOperation("operation", () => outcome === "resolve" ? Promise.resolve(7) : Promise.reject(new Error("refused"))));
  if (outcome === "resolve") expect(await result).toBe(7);
  else await expect(result).rejects.toThrow("refused");
  expect(lease.snapshot().operations).toEqual([]);
  lease.expire();
});

test.each(["caller", "pass"] as const)("command ports forward arguments and combine %s cancellation", async source => {
  const lease = new OperationLease(), caller = new AbortController();
  let received: unknown[] = [];
  const ports = lease.run(() => leasedOperationPorts({ exec: (...args: unknown[]) => { received = args; return Promise.resolve(7); } }));
  expect(await lease.run(() => ports.exec("git", ["status"], "/fixture", { LANG: "C" }, { signal: caller.signal, timeoutMs: 10 }))).toBe(7);
  expect(received.slice(0, 4)).toEqual(["git", ["status"], "/fixture", { LANG: "C" }]);
  const options = received[4] as { signal: AbortSignal; timeoutMs: number };
  expect(options.timeoutMs).toBe(10);
  if (source === "pass") lease.expire(); else caller.abort();
  expect(options.signal.aborted).toBe(true);
  expect(caller.signal.aborted).toBe(source === "caller");
});

test("a process restart can write after an expired pass released its state lease", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "controller-lease-restart-"));
  const setup = `
    const { initializeStateCollections, SqliteStateCollection } = await import("./src/lib/state/sqliteStateStore.ts");
    const { OperationLease, OperationLeaseExpiredError } = await import("./src/lib/operationLease.ts");
    const options = {
      collection: "lease-fixture", schemaVersion: 1, migrationId: "one", busyMessage: "busy",
      key: row => row.id, loadRecords: () => [{ id: "item", value: 0 }], decode: value => value, clone: structuredClone,
    };
    const filename = process.env.LLV_STATE_DIR + "/state.sqlite";
    initializeStateCollections(filename, [options]);
    const store = new SqliteStateCollection(filename, options);
  `;
  const run = (code: string) => {
    const child = spawnSync(process.execPath, ["-e", setup + code], { cwd: process.cwd(), encoding: "utf8", timeout: 20_000,
      env: { ...process.env, LLV_STATE_DIR: root, LLV_GATE_STATE_DIR: root, HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"), TMPDIR: root } });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stdout + child.stderr).toBe(0);
    return child.stdout.trim();
  };
  try {
    expect(run(`
      const lease = new OperationLease(); let enter;
      const entered = new Promise(resolve => { enter = resolve; });
      const pending = lease.run(() => store.mutate(async () => { enter(); await new Promise(() => {}); }));
      await entered; lease.expire();
      try { await pending; throw new Error("expired mutation succeeded"); }
      catch(error) { if (!(error instanceof OperationLeaseExpiredError)) throw error; }
      const { Database } = await import("bun:sqlite");
      const db = new Database(process.env.LLV_STATE_DIR + "/state.sqlite", { readonly: true });
      if (db.query("SELECT count(*) AS n FROM state_leases").get().n !== 0) throw new Error("expired pass retained its lease");
      db.close();
      store.close(); console.log("released");
    `)).toBe("released");
    expect(run(`
      await store.mutate(async (rows, persist) => { rows[0].value = 1; await persist(); });
      if (store.get("item").value !== 1) throw new Error("restart did not progress");
      store.close(); console.log("committed");
    `)).toBe("committed");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
