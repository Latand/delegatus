import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import type { OrchestratorSeat } from "@/lib/orchestrator/seats";
import { interruptionObligationDirectory, interruptionObligationStore } from "./interruptionObligations";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { FakeEngineHost, createFakeDeliveryLedger } from "./fixtures/fakeEngineHost";
import path from "node:path";
import { expect, spyOn, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";
import { procBackend } from "@/lib/proc";
import { RuntimeJournal } from "@/runtime-host/journal";

import { type RuntimeHostClient } from "./client";
import { adoptStructuredHostsAtStartup, type StructuredStartupDependencies } from "./startup";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";
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

async function pass(status: "unhosted" | "dead", pendingAction: "handoff" | null, sessionId: string): Promise<unknown> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-handover-retry-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  passedOverRow(registry, directory, sessionId, status, pendingAction);
  const dependencies: StructuredStartupDependencies = {
    registry,
    client: runtimeJournalClient(journal),
    orchestratorSeats: () => [],
    refreshTranscriptState: async () => {},
    resolveCodexOwner: () => null,
    resolveClaudeOwner: () => null,
    adoptClaude: async () => [],
    schedule: () => ({ unref() {} }),
  };
  try {
    await adoptStructuredHostsAtStartup(dependencies);
    return null;
  } catch (error) {
    return error;
  } finally {
    await bindStructuredDeliveryQueue([], { registry, client: null });
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("a row handed over while the pass ran completes boot and retries in isolation", async () => {
  const error = await pass("unhosted", "handoff", "25300000-0000-0000-0000-000000000061");
  expect(error).toBeNull();
});

test("a dead row with no engine still completes the pass for on-demand hosting, handed over or not", async () => {
  expect(await pass("dead", "handoff", "25300000-0000-0000-0000-000000000062")).toBeNull();
  expect(await pass("dead", null, "25300000-0000-0000-0000-000000000063")).toBeNull();
});


test.skipIf(process.platform === "win32").each(["pending-send", "owed-continuation"])("D3 a failed Codex attachment does not hold an adopted Claude seat: %s", async mode => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-ready-seat-"));
  fs.chmodSync(directory, 0o700);
  const socket = path.join(directory, "rpc.sock");
  const server = net.createServer(connection => { connection.on("error", () => {}); connection.end(); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  fs.chmodSync(socket, 0o600);
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const codexId = ["f3000000", "0000", "4000", "8000", "000000000001"].join("-");
  passedOverRow(registry, directory, codexId, "unhosted", "handoff");
  const prior = registry.readOnlySnapshot().entries[`codex:${codexId}`]!;
  registry.upsert({ ...prior, claimOwner: null, pendingAction: null, status: "live",
    structuredHost: { ...prior.structuredHost!, endpoint: `codex-unix:${socket}`, process: captureProcessIdentity(process.pid) } });
  const sessionId = ["f3000000", "0000", "4000", "8000", "000000000002"].join("-");
  const artifactPath = path.join(directory, `${sessionId}.jsonl`);
  fs.writeFileSync(artifactPath, JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: "work" } }) + "\n");
  const conversation = registry.ensureConversation("claude", artifactPath, null);
  registry.upsert({ ...prior, key: { engine: "claude", sessionId }, artifactPath, claimOwner: null, pendingAction: null, status: "live",
    structuredHost: { ...prior.structuredHost!, kind: "claude-broker", process: null, activeTurnRef: "seat-turn" } });
  journal.append({ scope: { type: "session", id: conversation.id }, kind: "session-status", payload: {
    conversationId: conversation.id, sessionKey: { engine: "claude", sessionId }, hostKind: "claude-broker",
    host: "hosted", turn: "idle", provenance: "structured", artifactPath, cwd: directory,
    capabilities: { steer: false, structuredAttention: true },
  } });
  const seat = { project: "ready-seat", state: "active", conversationId: conversation.id, path: artifactPath, seatEpoch: 4 } as OrchestratorSeat;
  const store = interruptionObligationStore(interruptionObligationDirectory(registry.filename));
  const { obligation } = store.record({ conversationId: conversation.id, engine: "claude", hostKey: `claude:${sessionId}`,
    path: artifactPath, owner: null, claimEpoch: 3, turnRef: "cut-turn", boundary: "release-cut", reason: "viewer-release",
    recordedAt: new Date(Date.now() - 2_000).toISOString(), checkpoint: { lastEventKind: "tool-call", lastEventAt: Date.now() - 60_000 },
    seat: { project: seat.project, seatEpoch: seat.seatEpoch } });
  if (mode === "pending-send") {
    registry.holdDelivery(conversation.id, "wake the seat", "ready-seat-message", "text", [], null, { operationId: "ready-seat-message", kind: "send", policy: "queue" });
    journal.executeOperation({ kind: "send", operationId: "ready-seat-message", idempotencyKey: "ready-seat-message",
      conversationId: conversation.id, text: "wake the seat", policy: "queue" });
  }
  const blockedConversation = registry.conversationForPath(prior.artifactPath)!;
  journal.append({ scope: { type: "session", id: blockedConversation.id }, kind: "session-status", payload: {
    conversationId: blockedConversation.id, sessionKey: prior.key, hostKind: "codex-app-server",
    host: "hosted", turn: "idle", provenance: "structured", artifactPath: prior.artifactPath,
    capabilities: { steer: true, structuredAttention: true },
  } });
  journal.executeOperation({ kind: "send", operationId: "contested-seat-message", idempotencyKey: "contested-seat-message",
    conversationId: blockedConversation.id, text: "wait for the existing owner", policy: "interrupt-active" });
  const ledger = createFakeDeliveryLedger();
  let releases = 0;
  const host = Object.assign(new FakeEngineHost(ledger), { onStateChange: () => () => {}, release: async () => { releases++; } });
  const scheduled: Array<() => void> = [];
  let clock = Date.now();
  const dateNow = spyOn(Date, "now").mockImplementation(() => clock);
  let codexAttempts = 0;
  let claudeAttempts = 0;
  let runtimeGeneration = "initial";
  const dependencies: StructuredStartupDependencies = { registry,
      client: { ...runtimeJournalClient(journal), startupGeneration: async () => runtimeGeneration },
      orchestratorSeats: () => [seat], interruptions: store, resolveCodexOwner: () => null, resolveClaudeOwner: () => null,
      refreshTranscriptState: async () => {},
      schedule: (callback, delay) => { scheduled.push(() => { clock += delay; callback(); }); return { unref() {} }; },
      adoptCodexHost: async () => { codexAttempts += 1; throw new Error("rollout is not yet available"); },
      adoptClaude: async (_store, _optionsFor, _env, shouldAdopt = () => true) => {
        const entry = registry.readOnlySnapshot().entries[`claude:${sessionId}`]!;
        if (!shouldAdopt(entry)) return [];
        claudeAttempts += 1;
        registry.upsert({ ...entry, status: "idle" });
        return [{ key: { engine: "claude", sessionId }, host: host as never }];
      },
  };
  try {
    await adoptStructuredHostsAtStartup(dependencies);
    const expected = mode === "pending-send" ? "ready-seat-message" : obligation.id;
    const arrived = () => ledger.writes.filter(item => mode === "pending-send" ? item.id === expected : item.id === store.list().find(cut => cut.id === obligation.id)?.operationId);
    const deadline = performance.now() + 2_000;
    while (arrived().length === 0 && performance.now() < deadline) await Bun.sleep(5);
    expect(arrived()).toHaveLength(1);
    expect(codexAttempts).toBe(1);
    expect(scheduled.length).toBeGreaterThan(0);
    if (mode === "pending-send") runtimeGeneration = "replacement";
    scheduled.at(-1)!();
    while (codexAttempts < 2 && performance.now() < deadline) await Bun.sleep(5);
    await adoptStructuredHostsAtStartup(dependencies);
    expect(codexAttempts).toBe(2);
    expect(claudeAttempts).toBe(1);
    expect(releases).toBe(0);
    expect(journal.operationResult("contested-seat-message")?.receipt.status).toBe("queued");
    expect(arrived()).toHaveLength(1);
    if (mode === "pending-send") {
      journal.executeOperation({ kind: "send", operationId: "ready-seat-second-message", idempotencyKey: "ready-seat-second-message",
        conversationId: conversation.id, text: "wake after runtime replacement", policy: "queue" });
      await kickStructuredDeliveryQueue();
      const settled = performance.now() + 2000;
      while (!ledger.writes.some(write => write.id === "ready-seat-second-message") && performance.now() < settled) await Bun.sleep(1);
      expect(ledger.writes.filter(write => write.id === "ready-seat-second-message")).toHaveLength(1);
    }
  } finally {
    await bindStructuredDeliveryQueue([], { registry, client: null });
    dateNow.mockRestore();
    journal.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
