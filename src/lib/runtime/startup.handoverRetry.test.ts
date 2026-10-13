import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";
import { procBackend } from "@/lib/proc";
import { RuntimeJournal } from "@/runtime-host/journal";

import { RuntimeHostUnavailableError, type RuntimeHostClient } from "./client";
import { adoptStructuredHostsAtStartup, type StructuredStartupDependencies } from "./startup";
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

test("a row handed over while the pass ran makes the pass retry instead of waiting for on-demand hosting", async () => {
  const error = await pass("unhosted", "handoff", "25300000-0000-0000-0000-000000000061");
  expect(error).toBeInstanceOf(RuntimeHostUnavailableError);
  expect(String(error)).toContain("codex:25300000-0000-0000-0000-000000000061");
});

test("a dead row with no engine still completes the pass for on-demand hosting, handed over or not", async () => {
  expect(await pass("dead", "handoff", "25300000-0000-0000-0000-000000000062")).toBeNull();
  expect(await pass("dead", null, "25300000-0000-0000-0000-000000000063")).toBeNull();
});
