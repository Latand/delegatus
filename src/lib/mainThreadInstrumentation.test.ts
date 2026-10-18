import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { NextRequest, NextResponse } from "next/server";
import { createViewerLoopMonitor, type ViewerOperation } from "./viewerLoopMonitor";
import { createPerformanceSpans, performanceSites, performanceSpans } from "./performanceSpans";
import { hostedConversationsFromSnapshot } from "./mcp/bindings";
import { scanProcesses } from "./tempSweep";
import { agentLivenessSnapshot, type AgentLivenessSources } from "./lifecycle/liveness";
import { blockingWaitRole, recordBlockingWait, registryWaitCallSite, resetBlockingWaitsForTests } from "./blockingWaits";

/* Execute the shipped entry-point bodies with fixture ports. In particular,
 * importing runtime-host/main would start listeners and release succession.
 * Selecting its timer callback lets this test run the same body without booting
 * a host. No source substitutions or fake implementation of a wrapper. */
const root = path.resolve(import.meta.dir, "../..");
function expressions(file: string, name: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found.push(node.getText(source).replace(/^export /, ""));
    if (ts.isMethodDeclaration(node) && node.name.getText(source) === name) found.push(node.getText(source).replace(/^private /, "function "));
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      if (name === "receiptSweepTimer") {
        const callback = (n: ts.Node) => {
          if (ts.isCallExpression(n) && n.expression.getText(source) === "setInterval") found.push(n.arguments[0]!.getText(source));
          else ts.forEachChild(n, callback);
        };
        ts.forEachChild(node, callback);
      } else if (node.initializer) found.push(node.initializer.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(found.length).toBeGreaterThan(0);
  return found;
}
function bind(source: string, ports: Record<string, unknown>): (...args: unknown[]) => unknown {
  const js = ts.transpile(`const entry = (${source});`, { target: ts.ScriptTarget.ES2022 });
  return new Function(...Object.keys(ports), `${js}\nreturn entry;`)(...Object.values(ports));
}
function harness() {
  let at = 0;
  const lines: string[] = [];
  const monitor = createViewerLoopMonitor(line => lines.push(line), () => at, createPerformanceSpans(() => at));
  const slow = () => { at += 1_000; };
  const operation = <T>(label: ViewerOperation, work: () => T): T => monitor.run(label, work);
  return { monitor, slow, operation, check(label: ViewerOperation) {
    monitor.tick();
    const gap = JSON.parse(lines.at(-1)!.slice("[viewer loop-gap] ".length));
    expect(gap.operations).toContainEqual(expect.objectContaining({ name: label }));
    monitor.stop();
  } };
}

test.each([
  ["src/lib/attention/reconcileController.ts", "startAttentionReconcile", "pass", "attention.reconcile"],
  ["src/lib/asks/controller.ts", "startAsksClassifier", "sweep", "asks.sweep"],
  ["src/lib/tempSweep.ts", "startTempSweep", "sweep", "temp.sweep"],
  ["src/lib/runtime/structuredHostRetirement.ts", "startStructuredHostRetirement", "sweep", "hosts.retirement"],
] as const)("%s labels the scheduled pass, including a rejected port", async (file, name, port, label) => {
  for (const failed of [false, true]) {
    const h = harness();
    let tick: (() => unknown) | undefined;
    const timer = { unref() {} };
    const symbol = Symbol("fixture timer");
    const host = {};
    const start = bind(expressions(file, name)[0]!, {
      withViewerOperation: h.operation, host, TIMER: symbol, sweepHost: host, retirementHost: host,
      tempSweepMaxAgeMs: () => 1, tempSweepMode: () => "dry-run",
      FIRST_RECONCILE_DELAY_MS: 30_000, FIRST_SWEEP_DELAY_MS: 60_000,
      STRUCTURED_HOST_RETIREMENT_INTERVAL_MS: 300_000,
      ATTENTION_RECONCILE_INTERVAL_MS: 60_000, ASKS_SWEEP_INTERVAL_MS: 15_000, TEMP_SWEEP_INTERVAL_MS: 3_600_000,
    });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const pass = async () => { h.slow(); await held; if (failed) throw new Error("fixture refusal"); };
    const reconcile = label === "hosts.retirement" ? bind(expressions(file, "reconcileStructuredHostRetirement")[0]!, {
      structuredHostRetirementIdleMs: () => 1, console: { error() {} },
    }) : null;
    start({ schedule: (cb: () => unknown) => { tick = cb; return timer; },
      scheduleInterval: (cb: () => unknown) => { tick = cb; return timer; },
      [port]: reconcile ? () => reconcile({ sweep: pass }) : pass,
    });
    tick!();
    h.check(label);
    // Do not arm a follow-up; this fixture owns no real timers.
    for (const key of Reflect.ownKeys(host)) Reflect.deleteProperty(host, key);
    release();
    await held;
    // hosts.retirement deliberately delegates rejection handling to its pass.
    // Its injected port mirrors that production contract.
    await new Promise<void>(resolve => setImmediate(resolve));
  }
});

test.each(["resources", "orchestrator/seat", "attention"])("%s read labels survive success and failure", async route => {
  for (const failed of [false, true]) {
    const h = harness();
    const read = () => { h.slow(); if (failed) throw new Error("fixture refusal"); return null; };
    const entry = bind(expressions(`src/app/api/${route}/route.ts`, "GET")[0]!, {
      withViewerOperation: h.operation, NextResponse, rejectCrossOrigin: () => null,
      readResourcesWithDiagnostic: async () => { read(); return { payload: {}, diagnostic: { phases: {} } }; },
      resourceDiagnosticHeader: () => "fixture",
      readOrchestratorSeatFileOrNull: read, readDeputyFileOrNull: () => null,
      allSeatConversationsIn: () => null, withDeputyRefs: () => null,
      MAX_ECHOED_IDS: 16, attentionRecordsForSurface: read,
      attentionFailure: () => NextResponse.json({}, { status: 500 }),
    });
    try { await entry(new NextRequest("http://localhost/api/read?scope=all&records=only")); }
    catch (error) { expect(failed).toBe(true); expect(String(error)).toContain("fixture refusal"); }
    h.check(route === "resources" ? "resources.read" : route === "attention" ? "attention.read" : "seat.panel");
  }
});

test.each([false, true])("host receipt sweep labels the real timer body (failed=%s)", failed => {
  const h = harness();
  let errors = 0;
  const tick = bind(expressions("src/runtime-host/main.ts", "receiptSweepTimer")[0]!, {
    viewerLoopMonitor: h.monitor,
    journal: { isWritable: () => true, maintainProducerReceipts: () => { h.slow(); if (failed) throw new Error("fixture refusal"); return {}; } },
    receiptSweepReporter: { record: () => null }, console: { error: () => { errors++; } },
  });
  tick(); h.check("runtime-journal.receipt-sweep"); expect(errors).toBe(Number(failed));
});

test.each([
  ["src/lib/forge/autoMerge.ts", "sweepAutoMerge", "forge.auto-merge"],
  ["src/lib/forge/autoMerge.ts", "sweepTaskFinishes", "forge.auto-merge"],
  ["src/lib/forge/sweep.ts", "sweepForgeLinks", "forge.sweep"],
] as const)("%s %s labels fixture reads and thrown reads", async (file, name, label) => {
  for (const failed of [false, true]) {
    const h = harness();
    const entry = bind(expressions(file, name)[0]!, {
      withViewerOperation: h.operation,
      readForgeCache: () => ({ data: { repositories: {} }, error: null }),
      forgeCacheFile: () => "fixture", pendingForgeNudges: () => new Map(),
      collectDemand: bind(expressions("src/lib/forge/sweep.ts", "collectDemand")[0]!, {}),
    });
    try {
      await entry({ now: () => 0, finishTask: () => {},
        loadPipelines: () => { h.slow(); if (failed) throw new Error("fixture refusal"); return []; },
        loadTasks: () => [],
      });
    } catch (error) { expect(failed).toBe(true); expect(String(error)).toContain("fixture refusal"); }
    h.check(label);
  }
});

test.each([false, true])("notice prune bodies label their database work (failed=%s)", failed => {
  for (const spawn of [true, false]) {
    const h = harness();
    const read = () => { h.slow(); if (failed) throw new Error("fixture refusal"); return []; };
    const entry = bind(expressions(spawn ? "src/lib/spawnNotice/store.ts" : "src/lib/runtime/deliveryProgress.ts", spawn ? "pruneSpawnNotices" : "prune")[0]!, {
      withViewerOperation: h.operation, collection: () => ({ keyRange: read }),
      DELIVERY_PROGRESS_TERMINAL_RETENTION_MS: 1_000, DELIVERY_PROGRESS_MIN_RETENTION_MS: 500, TERMINAL_ROW_LIMIT: 5,
    });
    try {
      if (spawn) expect(entry("2026-10-18T00:00:00Z")).toBe(0);
      else entry.call({ now: () => 10_000, records: new Map(), dirty: new Set() }, { query: () => ({ run: read }) });
    } catch (error) { expect(failed).toBe(true); expect(String(error)).toContain("fixture refusal"); }
    h.check(spawn ? "spawn-notice.prune" : "delivery-progress.prune");
  }
});

test.each([false, true])("release retention labels its injected process scan (failed=%s)", async failed => {
  const h = harness();
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR!, "retention-fixture-")));
  const releases = path.join(directory, "releases"); fs.mkdirSync(releases);
  const entry = bind(expressions("src/lib/selfUpdate/retention.ts", "retainReleases")[0]!, {
    withViewerOperation: h.operation, fs, path, DAY: 86_400_000,
    writeJsonDurably: (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value)),
    console: { log() {}, error() {} },
  });
  try {
    const report = await entry({ releasesDir: releases, checkout: null }, {}, {
      now: () => 0, reportFile: path.join(directory, "report.json"), mountPoints: () => [],
      scan: () => { h.slow(); if (failed) throw new Error("fixture refusal"); return { ownNamespace: "mnt:[fixture]", processes: [] }; },
      git: async () => ({ code: 0, stdout: "", stderr: "" }),
    }) as { errors: string[] };
    expect(report.errors.length).toBe(Number(failed));
    h.check("self-update.retention");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test.each([false, true])("release byte counting records synchronous success and failure (failed=%s)", failed => {
  performanceSpans.clear();
  const directory = fs.mkdtempSync(path.join(process.env.TMPDIR!, "bytes-fixture-"));
  fs.writeFileSync(path.join(directory, "fixture"), "fixture");
  const bytes = bind(expressions("src/lib/selfUpdate/retention.ts", "bytesOf")[0]!, { performanceSpans, fs, path });
  try {
    if (failed) expect(() => bytes(path.join(directory, "missing"))).toThrow();
    else expect(bytes(directory)).toBeGreaterThanOrEqual(0);
    expect(performanceSpans.snapshot().records.map(row => ({ kind: row.kind, site: performanceSites[row.site], failed: row.failed })))
      .toContainEqual({ kind: "sync", site: "self-update.bytes", failed });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); performanceSpans.clear(); }
});

test("every revalidation timer labels its synchronous row read and refusal", () => {
  const callbacks = expressions("src/lib/pipelines/engine.ts", "revalidate");
  expect(callbacks).toHaveLength(7);
  for (const callback of callbacks) for (const failed of [false, true]) {
    const h = harness();
    const abort = new AbortController();
    const record = { id: "fixture", state: "provisioning" };
    const read = () => { h.slow(); if (failed) throw new Error("fixture refusal"); return record; };
    const tick = bind(callback, {
      withViewerOperation: h.operation, findPipelineRecord: read, matches: () => true,
      pipeline: record, preview: record, attempt: { activation: true }, expected: JSON.stringify(record), abort,
      jobs: [{ pipeline: record, fence: "{}", abort }], provisionFence: () => ({}),
      admission: null, budgetRefusal: () => null, receiptMatches: () => true,
      reviewIngressFence: () => "fixture", fence: "fixture",
    });
    try { tick(); } catch (error) { expect(failed).toBe(true); expect(String(error)).toContain("fixture refusal"); }
    h.check("pipelines.revalidate");
  }
});

test("synchronous caller enumeration, proc scan and liveness reads emit measured slices", async () => {
  performanceSpans.clear();
  hostedConversationsFromSnapshot({ conversations: {}, entries: {} });
  const directory = fs.mkdtempSync(path.join(process.env.TMPDIR!, "proc-fixture-"));
  try {
    scanProcesses(directory);
    const sources = {
      now: () => 0, registrySnapshot: () => ({ conversations: {}, entries: {}, conversationAliases: {} }),
      pipelines: () => [], flows: () => [], listFiles: async () => [], workProcesses: () => [],
      probe: { now: () => 0, pidAlive: () => false, processIdentity: () => null },
    } as unknown as AgentLivenessSources;
    await agentLivenessSnapshot({}, sources);
    const slices = performanceSpans.snapshot().records.map(row => ({ kind: row.kind, site: performanceSites[row.site], failed: row.failed }));
    for (const site of ["mcp.caller-enumeration", "proc.scan", "liveness.snapshot"] as const) expect(slices).toContainEqual({ kind: "sync", site, failed: false });
    expect(() => hostedConversationsFromSnapshot({ get conversations(): never { throw new Error("fixture refusal"); }, entries: {} })).toThrow("fixture refusal");
    expect(performanceSpans.snapshot().records.some(row => performanceSites[row.site] === "mcp.caller-enumeration" && row.failed)).toBe(true);
    sources.registrySnapshot = () => { throw new Error("fixture refusal"); };
    await expect(agentLivenessSnapshot({}, sources)).rejects.toThrow("fixture refusal");
    expect(performanceSpans.snapshot().records.some(row => performanceSites[row.site] === "liveness.snapshot" && row.failed)).toBe(true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); performanceSpans.clear(); }
});

test("an unavailable proc root retains its synchronous span through the portable fallback", () => {
  performanceSpans.clear();
  const fallback = { ownNamespace: null, processes: [] };
  const scan = bind(expressions("src/lib/tempSweep.ts", "scanProcesses")[0]!, {
    performanceSpans, fs: { readdirSync: () => { throw new Error("fixture refusal"); } }, portableScan: () => fallback,
  });
  try {
    expect(scan("fixture")).toBe(fallback);
    expect(performanceSpans.snapshot().records.map(row => ({ kind: row.kind, site: performanceSites[row.site], failed: row.failed })))
      .toContainEqual({ kind: "sync", site: "proc.scan", failed: false });
  } finally { performanceSpans.clear(); }
});

test("slow registry wait logs contain caller coordinates without a private path", () => {
  expect(registryWaitCallSite("Error\n at privateFn (/private/root/src/lib/agent/sqliteRegistryStore.ts:10:2)\n at caller (/private/root/src/lib/runtime/deliveryQueue.ts:42:7)")).toBe("src/lib/runtime/deliveryQueue.ts:42:7");
  expect(registryWaitCallSite("Error\n at privateFn (/private/root/private.ts:10:2)")).toBe("unresolved");
  expect(registryWaitCallSite("Error\n at a (/private/root/.next/server/chunks/fixture.js:1:10)\n at b (/private/root/.next/server/chunks/fixture.js:1:42)"))
    .toBe(".next/server/chunks/fixture.js:1:10 <- .next/server/chunks/fixture.js:1:42");
  const lines: string[] = [];
  resetBlockingWaitsForTests(line => lines.push(line));
  try {
    for (const site of ["registry-lock", "registry-revision-retry", "registry-lock-async"] as const) recordBlockingWait({ site, durationMs: 300, synchronous: site !== "registry-lock-async" });
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const sample = JSON.parse(line.slice("[blocking-wait] ".length));
      expect(sample.callSite).toMatch(/^src\/lib\/mainThreadInstrumentation.test.ts:\d+:\d+(?: <- src\/.*:\d+:\d+)*$/);
      expect(line).not.toContain(root);
    }
  } finally { resetBlockingWaitsForTests(); }
});

test.each(["viewer", "runtime-host", "mcp"])("%s transaction holds identify their own process on commit and rollback", role => {
  const owner = process.env.LLV_STATE_OWNER;
  process.env.LLV_STATE_OWNER = role;
  try {
    for (const failed of [false, true]) for (const heldMs of [49, 50]) {
      let at = 0;
      const warnings: unknown[][] = [];
      const transaction = bind(expressions("src/lib/state/sqliteStateStore.ts", "withImmediateTransaction")[0]!, {
        stateLockAttempt: (_site: string, work: () => unknown) => work(),
        performance: { now: () => at }, process, blockingWaitRole,
        injectWriteFault() {}, noteStateCommit() {}, rollbackQuietly() {},
        stateLockDeferral: () => false, classifyStateError: (error: unknown) => error,
        console: { warn: (...args: unknown[]) => warnings.push(args) },
      });
      const work = () => { at = heldMs; if (failed) throw new Error("fixture refusal"); return 42; };
      const db = { exec() {}, query: () => ({ get: () => ({ changes: 0 }) }) };
      if (failed) expect(() => transaction(db, "busy", work, "fixture")).toThrow("fixture refusal");
      else expect(transaction(db, "busy", work, "fixture")).toBe(42);
      if (heldMs < 50) expect(warnings).toEqual([]);
      else {
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toHaveLength(1);
        const line = String(warnings[0]![0]);
        expect(line).not.toContain("\n");
        expect(JSON.parse(line.slice("[state transaction-hold] ".length))).toEqual({ collection: "fixture", heldMs, pid: process.pid, role });
      }
    }
  } finally { if (owner === undefined) delete process.env.LLV_STATE_OWNER; else process.env.LLV_STATE_OWNER = owner; }
});
