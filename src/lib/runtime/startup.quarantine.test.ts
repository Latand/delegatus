import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { FakeEngineHost, createFakeDeliveryLedger } from "./fixtures/fakeEngineHost";
import path from "node:path";
import { expect, setSystemTime, spyOn, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry, type AgentRegistryEntry } from "@/lib/agent/registry";
import type { BoardTask } from "@/lib/tasks/types";
import type { StartupRowRetry } from "./startupRowRetries";
import { procBackend } from "@/lib/proc";
import { RuntimeJournal } from "@/runtime-host/journal";

import { type RuntimeHostClient } from "./client";
import { adoptStructuredHostsAtStartup, structuredStartupDeferral, type StructuredStartupDependencies } from "./startup";
import { bindStructuredDeliveryQueue } from "./structuredDeliveryController";
import { enqueueStructuredMessage } from "./structuredMessageDelivery";
import { restartCutEvidenceHolds, restartCutEvidenceUnresolved } from "./restartCutHold";

/* #2761: a successor's startup pass can reach a live worker's row while the
   incumbent still owns it, skip it, and find it released by the incumbent's
   demotion before the pass ends. That row was handed over to this release; it
   must make the pass retry, not wait for on-demand hosting the way a row whose
   engine is long gone does (#1364). Seen in the candidate gate's hand-over
   rehearsal, where the worker stayed unhosted for the rest of the run. */

function runtimeJournalClient(journal: RuntimeJournal): RuntimeHostClient {
  return {
    readSession: async (identity) => journal.readSession(identity),
    snapshot: async () => journal.snapshot(),
    append: async (event) => journal.append(event),
    command: async (command) => journal.executeOperation(command),
    operationStatus: async (operationId, options) => options?.currentRetryLeaf
      ? journal.currentRetryResult(operationId)
      : journal.operationResult(operationId),
    retryOperation: async (operationId, nextIdempotencyKey, options) =>
      journal.retryOperation(operationId, nextIdempotencyKey, options),
    effectBatch: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transitionOperation: async (operationId, status, details) => journal.transitionOperation(operationId, status, details),
  } as RuntimeHostClient;
}

/** A Codex row the adopter passes over this pass: still claimed by a live
    Viewer, its engine released, in the given hand-over state. */
function passedOverRow(registry: AgentRegistry, directory: string, sessionId: string, status: "unhosted" | "dead", pendingAction: "handoff" | null) {
  const artifactPath = path.join(directory, `${sessionId}.jsonl`);
  fs.writeFileSync(artifactPath, `${JSON.stringify({ payload: { type: "user_message" }, timestamp: new Date().toISOString() })}\n`);
  const launchProfile = emptyLaunchProfile({ cwd: directory });
  registry.reconcileConversations([{
    engine: "codex",
    path: artifactPath,
    accountId: null,
    launchProfile,
    turn: { state: "busy", source: "lifecycle", terminalAt: null },
    observedAt: new Date().toISOString(),
  }]);
  registry.upsert({
    key: { engine: "codex", sessionId },
    artifactPath,
    cwd: directory,
    accountId: null,
    launchProfile,
    status,
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:released",
      process: null,
      eventCursor: 8,
      protocolVersion: "test",
      writerClaimEpoch: 3,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 3,
    /* The claim the adopter is refused on: this test process, alive. */
    claimOwner: `structured-host:${JSON.stringify({ pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) })}`,
    pendingAction,
  });
}


test("one blocked row completes boot and sixty subsequent admissions reuse it", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-startup-quarantine-hour-"));
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  passedOverRow(registry, directory, "25300000-0000-0000-0000-000000000072", "unhosted", "handoff");
  let refreshes = 0;
  const dependencies: StructuredStartupDependencies = {
    registry, client: runtimeJournalClient(journal), orchestratorSeats: () => [],
    refreshTranscriptState: async () => { refreshes++; },
    resolveCodexOwner: () => null, resolveClaudeOwner: () => null, adoptClaude: async () => [],
    schedule: () => ({ unref() {} }),
    pipelineEvidence: () => ({ settled: new Set(), deferred: new Set() }),
  };
  try {
    for (let minute = 0; minute < 60; minute++) await adoptStructuredHostsAtStartup(dependencies);
    expect(refreshes).toBe(1);
  } finally {
    await bindStructuredDeliveryQueue([], { registry, client: null }); journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a missing rollout is retired once without blocking an unrelated startup adoption", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-startup-missing-rollout-isolation-"));
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  setSystemTime(new Date("2026-10-19T00:00:00Z"));
  try {
    const missingId = "25300000-0000-0000-0000-000000000080";
    const healthyId = "25300000-0000-0000-0000-000000000081";
    passedOverRow(registry, directory, missingId, "unhosted", "handoff");
    passedOverRow(registry, directory, healthyId, "unhosted", "handoff");
    const missingKey = `codex:${missingId}`;
    fs.unlinkSync(registry.readOnlySnapshot().entries[missingKey]!.artifactPath);
    for (const id of [missingId, healthyId]) {
      const key = `codex:${id}`;
      const entry = registry.readOnlySnapshot().entries[key]!;
      registry.upsert({ ...entry, claimOwner: null });
    }
    const attempts = new Map<string, number>();
    const ledger = createFakeDeliveryLedger();
    const host = Object.assign(new FakeEngineHost(ledger), {
      setWriterFence: () => {}, onEvent: () => () => {}, onStateChange: () => () => {},
    });
    const dependencies: StructuredStartupDependencies = {
      registry, client: runtimeJournalClient(journal), orchestratorSeats: () => [],
      refreshTranscriptState: async () => {}, resolveCodexOwner: () => null,
      resolveClaudeOwner: () => null, adoptClaude: async () => [],
      pipelineEvidence: () => ({ settled: new Set(), deferred: new Set() }),
      schedule: () => ({ unref() {} }),
      adoptCodexHost: async id => {
        attempts.set(id, (attempts.get(id) ?? 0) + 1);
        if (id === missingId) throw new Error("no rollout found for thread id fixture");
        return host as never;
      },
    };
    await adoptStructuredHostsAtStartup(dependencies);
    await adoptStructuredHostsAtStartup(dependencies);

    expect(attempts.get(missingId)).toBe(1);
    expect(attempts.get(healthyId)).toBe(1);
    expect(registry.readOnlySnapshot().entries[missingKey]).toMatchObject({
      status: "unhosted", pendingAction: "handoff", claimOwner: null,
      structuredHost: { process: null, ended: { reason: "missing-rollout" } },
    });
    expect(fs.existsSync(`${registry.filename}.startup-retries`)
      ? fs.readdirSync(`${registry.filename}.startup-retries`).filter(file => file.endsWith(".json"))
      : []).toEqual([]);
  } finally {
    setSystemTime();
    await bindStructuredDeliveryQueue([], { registry, client: null });
    journal.close(); registry.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32").each(["missing-rollout", "transient"])("%s with a live socket owner settles safely", async refusal => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-q-"));
  fs.chmodSync(directory, 0o700);
  const socket = path.join(directory, "rpc.sock");
  const server = net.createServer(connection => { connection.on("error", () => {}); connection.end(); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  fs.chmodSync(socket, 0o600);
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const sessionId = "25300000-0000-0000-0000-000000000073";
  const key = `codex:${sessionId}`;
  passedOverRow(registry, directory, sessionId, "unhosted", "handoff");
  const prior = registry.readOnlySnapshot().entries[key]!;
  fs.unlinkSync(prior.artifactPath);
  registry.upsert({ ...prior, claimOwner: null, status: "live", structuredHost: { ...prior.structuredHost!, endpoint: `codex-unix:${socket}`, process: captureProcessIdentity(process.pid) } });
  let clock = Date.parse("2026-10-16T12:00:00Z");
  const now = spyOn(Date, "now").mockImplementation(() => clock);
  const scheduled: { callback: () => void; delay: number }[] = [];
  const logs = spyOn(console, "error");
  let attempts = 0;
  let refreshes = 0;
  let recover = false;
  const ledger = createFakeDeliveryLedger();
  const host = Object.assign(new FakeEngineHost(ledger), { setWriterFence: () => {}, onEvent: () => () => {}, onStateChange: () => () => {} });
  const dependencies: StructuredStartupDependencies = {
    registry, client: runtimeJournalClient(journal), orchestratorSeats: () => [],
    refreshTranscriptState: async () => { refreshes++; },
    resolveCodexOwner: () => null, resolveClaudeOwner: () => null, adoptClaude: async () => [],
    schedule: (callback, delay) => { scheduled.push({ callback, delay }); return { unref() {} }; },
    pipelineEvidence: () => ({ settled: new Set(), deferred: new Set() }),
    adoptCodexHost: async () => { attempts++; if (!recover) throw new Error(refusal === "missing-rollout" ? "no rollout found for thread id fixture" : "temporary app-server failure"); return host as never; },
  };
  const retryRecord = () => {
    try {
      return fs.readdirSync(`${registry.filename}.startup-retries`).filter(file => file.endsWith(".json"))
        .map(file => JSON.parse(fs.readFileSync(path.join(`${registry.filename}.startup-retries`, file), "utf8")))
        .find(row => row.key === key);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  };
  const tick = async () => {
    const task = scheduled.shift(); expect(task).toBeDefined();
    clock += task!.delay; task!.callback();
    const deadline = performance.now() + 3000;
    while (scheduled.length === 0 && retryRecord() && performance.now() < deadline) await Bun.sleep(1);
    // Join the startup promise before inspecting publication or cleanup.
    await adoptStructuredHostsAtStartup(dependencies);
  };
  try {
    await adoptStructuredHostsAtStartup(dependencies);
    expect(attempts).toBe(1);
    if (refusal === "missing-rollout") {
      expect(registry.readOnlySnapshot().entries[key]).toMatchObject({ status: "unhosted", claimOwner: null,
        structuredHost: { process: null, ended: { reason: "missing-rollout" } } });
      expect(retryRecord()).toBeUndefined();
      expect(scheduled).toHaveLength(0);
      // The app-server may serve other threads. Retirement sends it no signal.
      expect(procBackend.processIdentity(process.pid)).toBeTruthy();
      for (let read = 0; read < 5; read++) await adoptStructuredHostsAtStartup(dependencies);
      expect(attempts).toBe(1);
      return;
    }
    expect(retryRecord()).toMatchObject({ reason: "adoption-failed", attempts: 1, quarantined: false });
    await tick(); await tick();
    expect(retryRecord()).toMatchObject({ reason: "adoption-failed", attempts: 3, quarantined: true });
    expect(logs.mock.calls.some(([message, detail]) => String(message).includes("row quarantined")
      && (detail as { key?: string; reason?: string } | undefined)?.key === key
      && (detail as { reason?: string }).reason === "adoption-failed")).toBe(true);
    const { loadTasks } = await import("@/lib/tasks/store");
    const { statePath } = await import("@/lib/configDir");
    const card = loadTasks(statePath("tasks.json")).find(task => task.text.includes(key));
    expect(card?.text).toContain("adoption-failed");
    expect(refreshes).toBe(1);
    // Neither quarantine nor a failed attach retires the live owner.
    expect(registry.readOnlySnapshot().entries[key]!.structuredHost?.process?.pid).toBe(process.pid);
    recover = true;
    fs.writeFileSync(prior.artifactPath, JSON.stringify({ payload: { type: "user_message" }, timestamp: "2026-10-16T12:00:00Z" }) + "\n");
    await tick();
    expect(attempts).toBe(4);
    expect(retryRecord()).toBeUndefined();
    expect(loadTasks(statePath("tasks.json")).find(task => task.id === card!.id)?.status).toBe("done");
    for (let read = 0; read < 5; read++) await adoptStructuredHostsAtStartup(dependencies);
    expect(attempts).toBe(4);
    expect(refreshes).toBe(1);
    expect(scheduled).toHaveLength(0);
  } finally {
    logs.mockRestore(); now.mockRestore();
    await bindStructuredDeliveryQueue([], { registry, client: null }); journal.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an hour on the production scheduler contains one full pass and bounded row work", async () => {
  const { measureStartupRetries } = await import("../../../scripts/startup-retry-benchmark");
  const sample = await measureStartupRetries();
  expect(sample.fullPasses).toBe(1);
  expect(sample.rowPasses).toBeGreaterThan(0);
  expect(sample.rowPasses).toBeLessThanOrEqual(10);
  expect(sample.cpuMs).toBeGreaterThan(0);
});

test("startup warning attribution is confined to each physical record", async () => {
  const { countAttributedWarningRecords } = await import("../../../scripts/startup-retry-benchmark");
  const prefix = "[structured hosts] pipeline registry unreadable; deferring pipeline adoption";
  const valid = `${prefix} ${JSON.stringify({ pid: 31415, role: "viewer", error: "unavailable" })}`;
  const split = `${prefix} {\n  pid: 31415,\n  role: "viewer"\n}`;
  expect(countAttributedWarningRecords(`${valid}\n${split}\n`, prefix, 31415, "viewer"))
    .toEqual({ total: 2, attributed: 1 });
  expect(countAttributedWarningRecords(`${valid}\n`, prefix, 27182, "viewer"))
    .toEqual({ total: 1, attributed: 0 });
});

test("a row retry preserves another pipeline row's existing startup deferral", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-startup-row-fence-"));
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const blocked = "25300000-0000-0000-0000-000000000076";
  const fenced = "25300000-0000-0000-0000-000000000077";
  passedOverRow(registry, directory, blocked, "unhosted", "handoff");
  passedOverRow(registry, directory, fenced, "unhosted", "handoff");
  const fencedEntry = registry.readOnlySnapshot().entries[`codex:${fenced}`]!;
  const conversation = registry.conversationForPath(fencedEntry.artifactPath)!;
  let clock = Date.parse("2026-10-16T12:00:00Z");
  const now = spyOn(Date, "now").mockImplementation(() => clock);
  const timers: { callback: () => void; delay: number }[] = [];
  let pipelineReads = 0;
  const dependencies: StructuredStartupDependencies = {
    registry, client: runtimeJournalClient(journal), orchestratorSeats: () => [],
    refreshTranscriptState: async () => {}, resolveCodexOwner: () => null,
    resolveClaudeOwner: () => null, adoptClaude: async () => [],
    pipelineEvidence: () => { pipelineReads++; return { settled: new Set(), deferred: new Set([conversation.id]) }; },
    schedule: (callback, delay) => { timers.push({ callback, delay }); return {}; },
  };
  try {
    await adoptStructuredHostsAtStartup(dependencies);
    expect(structuredStartupDeferral()?.hostKeys).toEqual([`codex:${fenced}`]);
    const originalDeferralTimer = timers.at(-1)!;
    const rowTimer = timers.shift()!;
    clock += rowTimer.delay; rowTimer.callback();
    const deadline = performance.now() + 3000;
    while (timers.length < 2 && performance.now() < deadline) await Bun.sleep(1);
    await adoptStructuredHostsAtStartup(dependencies);
    expect(structuredStartupDeferral()?.hostKeys).toEqual([`codex:${fenced}`]);
    expect(registry.readOnlySnapshot().entries[`codex:${fenced}`]!.claimEpoch).toBe(3);
    expect(timers).toContain(originalDeferralTimer);
    const readsBeforeProbe = pipelineReads;
    const timerIndex = timers.indexOf(originalDeferralTimer);
    timers.splice(timerIndex, 1);
    originalDeferralTimer.callback();
    const probeDeadline = performance.now() + 3_000;
    while ((pipelineReads === readsBeforeProbe || structuredStartupDeferral()?.nextProbeMs === originalDeferralTimer.delay)
      && performance.now() < probeDeadline) await Bun.sleep(1);
    expect(pipelineReads).toBeGreaterThan(readsBeforeProbe);
  } finally {
    now.mockRestore(); await bindStructuredDeliveryQueue([], { registry, client: null }); journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a row retry preserves another row's unreadable restart-cut fence and recheck", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-startup-row-restart-cut-fence-"));
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const retrying = "25300000-0000-0000-0000-000000000080";
  const held = "25300000-0000-0000-0000-000000000081";
  const retryingKey = `codex:${retrying}`;
  const heldKey = `codex:${held}`;
  passedOverRow(registry, directory, retrying, "unhosted", "handoff");
  passedOverRow(registry, directory, held, "unhosted", "handoff");
  const heldEntry = registry.readOnlySnapshot().entries[heldKey]!;
  registry.upsert({ ...heldEntry, status: "live", claimOwner: null,
    structuredHost: { ...heldEntry.structuredHost!, process: null } });
  let clock = Date.parse("2026-10-16T12:00:00Z");
  const now = spyOn(Date, "now").mockImplementation(() => clock);
  const scheduled: { callback: () => void; delay: number }[] = [];
  let ledgerReads = 0;
  let ledgerUnreadable = true;
  const ledger = createFakeDeliveryLedger();
  const host = Object.assign(new FakeEngineHost(ledger), {
    setWriterFence: () => {}, onEvent: () => () => {}, onStateChange: () => () => {},
  });
  const dependencies: StructuredStartupDependencies = {
    registry, client: runtimeJournalClient(journal), orchestratorSeats: () => [],
    resolveCodexOwner: () => null, resolveClaudeOwner: () => null, adoptClaude: async () => [],
    refreshTranscriptState: async () => {},
    readHostTurnRecord: () => {
      ledgerReads++;
      return ledgerUnreadable ? { state: "unreadable", reason: "fixture ledger is unreadable" } : { state: "absent" };
    },
    pipelineEvidence: () => ({ settled: new Set(), deferred: new Set() }),
    adoptCodexHost: async () => host as never,
    schedule: (callback, delay) => { scheduled.push({ callback, delay }); return {}; },
  };
  try {
    await adoptStructuredHostsAtStartup(dependencies);
    expect(structuredStartupDeferral()?.hostKeys).toContain(heldKey);
    expect(restartCutEvidenceHolds(heldKey)).toBe(true);
    expect(restartCutEvidenceUnresolved(heldKey)).toBe(true);
    const originalDeferralTimer = scheduled.at(-1)!;
    const retry = scheduled.findIndex(task => task.delay === 1_000);
    expect(retry).toBeGreaterThanOrEqual(0);
    const [rowRetry] = scheduled.splice(retry, 1);

    const row = registry.readOnlySnapshot().entries[retryingKey]!;
    registry.upsert({ ...row, status: "live", claimOwner: null,
      structuredHost: { ...row.structuredHost!, process: null } });
    clock += rowRetry!.delay;
    rowRetry!.callback();
    const retryDeadline = performance.now() + 3_000;
    while (!structuredStartupDeferral()?.hostKeys.includes(retryingKey)
      && performance.now() < retryDeadline) await Bun.sleep(1);

    expect(structuredStartupDeferral()?.hostKeys).toContain(heldKey);
    expect(structuredStartupDeferral()?.hostKeys).toContain(retryingKey);
    expect(restartCutEvidenceHolds(heldKey)).toBe(true);
    expect(restartCutEvidenceUnresolved(heldKey)).toBe(true);
    expect(scheduled).toContain(originalDeferralTimer);
    const readsBeforeProbe = ledgerReads;
    const timerIndex = scheduled.indexOf(originalDeferralTimer);
    scheduled.splice(timerIndex, 1);
    originalDeferralTimer.callback();
    const probeDeadline = performance.now() + 3_000;
    while ((ledgerReads === readsBeforeProbe || structuredStartupDeferral()?.nextProbeMs === 1_000)
      && performance.now() < probeDeadline) await Bun.sleep(1);
    expect(ledgerReads).toBeGreaterThan(readsBeforeProbe);
    expect(restartCutEvidenceUnresolved(heldKey)).toBe(true);

    for (const key of [retryingKey, heldKey]) {
      const entry = registry.readOnlySnapshot().entries[key]!;
      registry.upsert({ ...entry, status: "dead", claimOwner: null,
        structuredHost: { ...entry.structuredHost!, process: null } });
    }
    ledgerUnreadable = false;
    const latestProbe = scheduled.at(-1)!;
    latestProbe.callback();
    const cleanupDeadline = performance.now() + 3_000;
    while (structuredStartupDeferral() !== null && performance.now() < cleanupDeadline) await Bun.sleep(1);
    expect(structuredStartupDeferral()).toBeNull();
  } finally {
    now.mockRestore(); await bindStructuredDeliveryQueue([], { registry, client: null }); journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an early row retry error publishes its quarantine reason when the third attempt fails", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-startup-quarantine-early-error-"));
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const sessionId = "25300000-0000-0000-0000-000000000078";
  const key = `codex:${sessionId}`;
  passedOverRow(registry, directory, sessionId, "unhosted", "handoff");
  let failRead = false;
  const client = runtimeJournalClient(journal);
  const originalRead = client.readSession;
  if (!originalRead) throw new Error("fixture runtime client has no session reader");
  let reads = 0;
  let refreshes = 0;
  client.readSession = async (...args) => {
    reads++;
    if (failRead) throw new Error("runtime session is temporarily unreadable");
    return originalRead(...args);
  };
  let clock = Date.parse("2026-10-16T12:00:00Z");
  const now = spyOn(Date, "now").mockImplementation(() => clock);
  const scheduled: { callback: () => void; delay: number }[] = [];
  const logs = spyOn(console, "error");
  const dependencies: StructuredStartupDependencies = {
    registry, client, orchestratorSeats: () => [], resolveCodexOwner: () => null,
    resolveClaudeOwner: () => null, adoptClaude: async () => [],
    refreshTranscriptState: async () => { refreshes++; }, schedule: (callback, delay) => {
      scheduled.push({ callback, delay }); return {};
    }, pipelineEvidence: () => ({ settled: new Set(), deferred: new Set() }),
  };
  const retryRecord = () => {
    try {
      return fs.readdirSync(`${registry.filename}.startup-retries`).filter(file => file.endsWith(".json"))
        .map(file => JSON.parse(fs.readFileSync(path.join(`${registry.filename}.startup-retries`, file), "utf8")))
        .find(row => row.key === key);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  };
  const fireNext = async (attempts: number) => {
    const task = scheduled.shift(); expect(task).toBeDefined();
    clock += task!.delay; task!.callback();
    const deadline = performance.now() + 3000;
    while ((retryRecord()?.attempts !== attempts || scheduled.length === 0
      || (attempts >= 3 && retryRecord()?.noticePending !== false)) && performance.now() < deadline) await Bun.sleep(1);
    expect(retryRecord()?.attempts).toBe(attempts);
  };
  try {
    await adoptStructuredHostsAtStartup(dependencies);
    expect(retryRecord()).toMatchObject({ attempts: 1, quarantined: false });
    const row = registry.readOnlySnapshot().entries[key]!;
    registry.upsert({ ...row, status: "live", claimOwner: null, structuredHost: { ...row.structuredHost!, process: null } });
    failRead = true;
    await fireNext(2);
    await fireNext(3);
    const retry = retryRecord();
    expect(retry).toMatchObject({ attempts: 3, quarantined: true, reason: "adoption-failed", noticePending: false });
    expect(reads).toBeGreaterThan(0);
    const { loadTasks } = await import("@/lib/tasks/store");
    const { statePath } = await import("@/lib/configDir");
    const card = loadTasks(statePath("tasks.json")).filter(task => task.text.includes(key));
    expect(card).toHaveLength(1);
    expect(card[0]!.text).toContain("adoption-failed");
    expect(refreshes).toBe(1);
    expect(logs.mock.calls.some(([message, detail]) => String(message).includes("row quarantined")
      && (detail as { key?: string } | undefined)?.key === key)).toBe(true);
  } finally {
    logs.mockRestore(); now.mockRestore();
    await bindStructuredDeliveryQueue([], { registry, client: null }); journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an unreadable restart-cut row installs capped pending-work admission on its row retry", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-startup-quarantine-held-work-"));
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const sessionId = "25300000-0000-0000-0000-000000000079";
  const key = `codex:${sessionId}`;
  passedOverRow(registry, directory, sessionId, "unhosted", "handoff");
  let clock = Date.parse("2026-10-16T12:00:00Z");
  const now = spyOn(Date, "now").mockImplementation(() => clock);
  const scheduled: { callback: () => void; delay: number; due: number }[] = [];
  let adoptions = 0;
  let refreshes = 0;
  const ledger = createFakeDeliveryLedger();
  const host = Object.assign(new FakeEngineHost(ledger), {
    setWriterFence: () => {}, onEvent: () => () => {}, onStateChange: () => () => {},
  });
  const dependencies: StructuredStartupDependencies = {
    registry, client: runtimeJournalClient(journal), orchestratorSeats: () => [],
    resolveCodexOwner: () => null, resolveClaudeOwner: () => null, adoptClaude: async () => [],
    refreshTranscriptState: async () => { refreshes++; },
    readHostTurnRecord: () => ({ state: "unreadable", reason: "fixture ledger is unreadable" }),
    pipelineEvidence: () => ({ settled: new Set(), deferred: new Set() }),
    adoptCodexHost: async () => { adoptions++; return host as never; },
    schedule: (callback, delay) => { scheduled.push({ callback, delay, due: clock + delay }); return {}; },
  };
  try {
    await adoptStructuredHostsAtStartup(dependencies);
    const row = registry.readOnlySnapshot().entries[key]!;
    registry.upsert({ ...row, status: "live", claimOwner: null, structuredHost: { ...row.structuredHost!, process: null } });
    const conversation = registry.conversationForPath(row.artifactPath)!;
    const queued = await enqueueStructuredMessage({
      path: row.artifactPath, conversationId: conversation.id, clientMessageId: "startup-held-work-message",
      operationId: "startup-held-work-operation", kind: "send", policy: "queue", turnId: null,
      text: "resume after restart-cut admission", hasImages: false,
    }, { enabled: () => true, client: () => null, registry: () => registry, requestMigrationTick: () => {}, progress: null });
    expect(queued).toMatchObject({ ok: true, outcome: "held" });
    const first = scheduled.shift(); expect(first).toBeDefined();
    clock += first!.delay; first!.callback();
    const deadline = performance.now() + 3000;
    while (structuredStartupDeferral() === null && performance.now() < deadline) await Bun.sleep(1);
    expect(structuredStartupDeferral()?.hostKeys).toContain(key);
    expect(restartCutEvidenceHolds(key)).toBe(true);
    expect(refreshes).toBe(1);
    expect(registry.readOnlySnapshot().heldDeliveries).not.toEqual({});

    while (structuredStartupDeferral()?.nextProbeMs !== 30_000 && clock - Date.parse("2026-10-16T12:00:00Z") < 120_000) {
      const previousProbe = structuredStartupDeferral()?.nextProbeMs;
      expect(previousProbe).toBeGreaterThan(0);
      const index = scheduled.findLastIndex(task => task.delay === previousProbe);
      expect(index).toBeGreaterThanOrEqual(0);
      const [next] = scheduled.splice(index, 1);
      clock = next!.due; next!.callback();
      const probeDeadline = performance.now() + 3000;
      while (structuredStartupDeferral()?.nextProbeMs === previousProbe && performance.now() < probeDeadline) await Bun.sleep(1);
      expect(structuredStartupDeferral()?.nextProbeMs).not.toBe(previousProbe);
    }
    expect(structuredStartupDeferral()?.nextProbeMs).toBe(30_000);
    expect(clock - Date.parse("2026-10-16T12:00:00Z")).toBeGreaterThanOrEqual(30_000);
    expect(adoptions).toBe(0);
    const cappedProbe = scheduled.findIndex(task => task.delay === 30_000);
    expect(cappedProbe).toBeGreaterThanOrEqual(0);
    const [probe] = scheduled.splice(cappedProbe, 1);
    clock = probe!.due; probe!.callback();
    const adoptionDeadline = performance.now() + 3000;
    while ((adoptions === 0 || restartCutEvidenceHolds(key)) && performance.now() < adoptionDeadline) await Bun.sleep(1);
    expect(adoptions).toBeGreaterThan(0);
    expect(restartCutEvidenceHolds(key)).toBe(false);
    expect(Object.values(registry.readOnlySnapshot().heldDeliveries).some(delivery =>
      delivery.text === "resume after restart-cut admission")).toBe(true);
  } finally {
    now.mockRestore(); await bindStructuredDeliveryQueue([], { registry, client: null }); journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test.each(["fresh", "legacy"])("%s missing rollout retires after one app-server refusal and stays retired across boot", async mode => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-rollout-terminal-"));
  try {
    const first = await rolloutBoot(directory, mode);
    expect(first.attempts, JSON.stringify(first)).toBe(1);
    expect(first.entry).toMatchObject({ status: "unhosted", claimOwner: null, structuredHost: {
      process: null, endpoint: "stdio:released", ended: { reason: "missing-rollout" },
    } });
    expect(first.timers).toEqual([]);
    expect(first.tasks.every((task: { status: string }) => task.status === "done")).toBe(true);
    expect(first.tasks).toHaveLength(mode === "legacy" ? 1 : 0);
    const restarted = await rolloutBoot(directory, mode);
    expect(restarted.attempts).toBe(1);
    expect(restarted.timers).toEqual([]);
    expect(restarted.stderr).not.toContain("boot adoption of");
    expect(restarted.entry.status).toBe("unhosted");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}, 20000);

interface RolloutBootResult {
  entry: AgentRegistryEntry;
  retry?: StartupRowRetry;
  tasks: BoardTask[];
  attempts: number;
  timers: number[];
  stderr: string;
}

async function rolloutBoot(directory: string, mode: string, reason = "missing", clock = Date.parse("2026-10-19T00:00:00Z")): Promise<RolloutBootResult> {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/startupRollout.ts"), mode, directory, reason, String(clock)], {
    env: { ...process.env, LLV_STATE_OWNER: undefined, LLV_STATE_DIR: path.join(directory, "state"),
      HOME: path.join(directory, "home"), XDG_CONFIG_HOME: path.join(directory, "config"), TMPDIR: directory,
      LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit, stderr).toBe(0);
  return { ...JSON.parse(stdout.trim().split("\n").at(-1)!), stderr };
}

test("a transient app-server refusal keeps its durable retry across process restarts", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-rollout-transient-"));
  const clock = Date.parse("2026-10-19T00:00:00Z");
  try {
    const first = await rolloutBoot(directory, "fresh", "transient", clock);
    expect(first.attempts, first.stderr).toBe(1);
    expect(first.entry.status).toBe("dead");
    expect(first.entry.structuredHost?.ended).toBeUndefined();
    expect(first.timers).toEqual([1000]);
    const early = await rolloutBoot(directory, "fresh", "transient", clock);
    expect(early.attempts).toBe(1);
    expect(early.timers).toEqual([1000]);
    const due = await rolloutBoot(directory, "fresh", "transient", clock + 1000);
    expect(due.attempts).toBe(2);
    expect(due.timers).toEqual([2000]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}, 20000);

test("a refused terminal notice closure survives restart and retries only cleanup", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-rollout-notice-"));
  try {
    const refused = await rolloutBoot(directory, "refused-notice");
    expect(refused.attempts).toBe(1);
    expect(refused.entry.status).toBe("unhosted");
    expect(refused.retry).toMatchObject({ reason: "missing-rollout", resolved: true });
    expect(refused.tasks).toHaveLength(1);
    expect(refused.tasks[0]!.status).toBe("inbox");
    expect(refused.timers).toEqual([1000]);
    const restarted = await rolloutBoot(directory, "resolve-notice");
    expect(restarted.attempts).toBe(1);
    expect(restarted.entry.status).toBe("unhosted");
    expect(restarted.retry).toBeUndefined();
    expect(restarted.tasks[0]!.status).toBe("done");
    expect(restarted.timers).toEqual([]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}, 20000);

test("a missing-rollout reply cannot retire a replacement writer admitted during the await", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-rollout-replaced-"));
  try {
    const result = await rolloutBoot(directory, "replaced");
    expect(result.attempts).toBe(1);
    expect(result.entry).toMatchObject({ status: "live", claimOwner: "replacement-writer", claimEpoch: 2,
      structuredHost: { endpoint: "fixture:replacement", writerClaimEpoch: 2 } });
    expect(result.entry.structuredHost?.ended).toBeUndefined();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}, 20000);
