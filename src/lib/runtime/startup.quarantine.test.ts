import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { FakeEngineHost, createFakeDeliveryLedger } from "./fixtures/fakeEngineHost";
import path from "node:path";
import { expect, spyOn, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";
import { procBackend } from "@/lib/proc";
import { RuntimeJournal } from "@/runtime-host/journal";

import { type RuntimeHostClient } from "./client";
import { adoptStructuredHostsAtStartup, structuredStartupDeferral, type StructuredStartupDependencies } from "./startup";
import { bindStructuredDeliveryQueue } from "./structuredDeliveryController";

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

test.skipIf(process.platform === "win32")("missing rollout with a live socket owner is quarantined, then recovered alone", async () => {
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
    adoptCodexHost: async () => { attempts++; if (!recover) throw new Error("no rollout found for thread id fixture"); return host as never; },
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
    expect(retryRecord()).toMatchObject({ reason: "missing-rollout", attempts: 1, quarantined: false });
    await tick(); await tick();
    expect(retryRecord()).toMatchObject({ reason: "missing-rollout", attempts: 3, quarantined: true });
    expect(logs.mock.calls.some(([message, detail]) => String(message).includes("row quarantined")
      && (detail as { key?: string; reason?: string } | undefined)?.key === key
      && (detail as { reason?: string }).reason === "missing-rollout")).toBe(true);
    const { loadTasks } = await import("@/lib/tasks/store");
    const { statePath } = await import("@/lib/configDir");
    const card = loadTasks(statePath("tasks.json")).find(task => task.text.includes(key));
    expect(card?.text).toContain("missing-rollout");
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
  const dependencies: StructuredStartupDependencies = {
    registry, client: runtimeJournalClient(journal), orchestratorSeats: () => [],
    refreshTranscriptState: async () => {}, resolveCodexOwner: () => null,
    resolveClaudeOwner: () => null, adoptClaude: async () => [],
    pipelineEvidence: () => ({ settled: new Set(), deferred: new Set([conversation.id]) }),
    schedule: (callback, delay) => { timers.push({ callback, delay }); return {}; },
  };
  try {
    await adoptStructuredHostsAtStartup(dependencies);
    expect(structuredStartupDeferral()?.hostKeys).toEqual([`codex:${fenced}`]);
    const rowTimer = timers.shift()!;
    clock += rowTimer.delay; rowTimer.callback();
    const deadline = performance.now() + 3000;
    while (timers.length < 2 && performance.now() < deadline) await Bun.sleep(1);
    await adoptStructuredHostsAtStartup(dependencies);
    expect(structuredStartupDeferral()?.hostKeys).toEqual([`codex:${fenced}`]);
    expect(registry.readOnlySnapshot().entries[`codex:${fenced}`]!.claimEpoch).toBe(3);
  } finally {
    now.mockRestore(); await bindStructuredDeliveryQueue([], { registry, client: null }); journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
