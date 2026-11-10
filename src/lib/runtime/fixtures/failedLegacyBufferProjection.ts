import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RuntimeSnapshot } from "@/components/runtime/runtimeModel";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { RuntimeJournal } from "@/runtime-host/journal";

import type { RuntimeHostClient } from "../client";
import { bindStructuredDeliveryQueue } from "../structuredDeliveryController";
import { FakeEngineHost, createFakeDeliveryLedger } from "./fakeEngineHost";

export interface FailedLegacyBufferProjectionFixture {
  snapshot: RuntimeSnapshot;
  key: { engine: "codex"; sessionId: string };
  conversationId: string;
  rawIdentifiers: readonly string[];
  dispose(): Promise<void>;
}

function runtimeJournalClient(journal: RuntimeJournal): RuntimeHostClient {
  return {
    snapshot: async () => journal.snapshot(),
    events: async (afterEventSeq) => journal.replay(afterEventSeq),
    append: async (event) => journal.append(event),
    command: async (command) => journal.executeOperation(command),
    operationStatus: async (operationId) => journal.operationResult(operationId),
    producerCursor: async (producerKind, eventKeyPrefix) => journal.producerCursor(producerKind, eventKeyPrefix),
    effectBatch: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transitionOperation: async (operationId, status, details) => journal.transitionOperation(operationId, status, details),
  } as RuntimeHostClient;
}

/**
 * A registry row written while agents ran in terminal panes, projected by a
 * release that no longer hosts any: the conversation records a pane host and
 * an open durable turn, and the structured delivery publisher projects that
 * row to the runtime journal while its stale structured adapter stays dead.
 */
export async function createFailedLegacyBufferProjection(): Promise<FailedLegacyBufferProjectionFixture> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-legacy-buffer-projection-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  setAgentRegistryForTests(registry);
  let journal: RuntimeJournal | null = null;
  try {
    const conversation = registry.ensureConversation("codex", "", "default");
    const sessionId = conversation.generations.at(-1)!.id;
    const artifactPath = path.join(directory, `${sessionId}.jsonl`);
    const profile = emptyLaunchProfile({ cwd: directory });
    registry.recordConversationContinuityPath(conversation.id, artifactPath);
    registry.reconcileConversations([{
      engine: "codex",
      path: "",
      accountId: "default",
      launchProfile: profile,
      turn: { state: "busy", source: "tool", terminalAt: null },
      observedAt: "2026-08-31T18:03:00.000Z",
    }]);
    const key = { engine: "codex" as const, sessionId };
    registry.upsert({
      key,
      artifactPath,
      cwd: directory,
      accountId: "default",
      launchProfile: profile,
      status: "live",
      host: {
        kind: "tmux",
        endpoint: "tmux:legacy-fixture",
        server: { pid: 201, startIdentity: "server:201" },
        paneId: "%20",
        panePid: { pid: 202, startIdentity: "pane:202" },
        windowName: "legacy-fixture",
        agent: { pid: 203, startIdentity: "agent:203" },
        argv: ["codex", "resume", sessionId],
      },
      structuredHost: {
        kind: "codex-app-server",
        endpoint: "fake:stale-adapter",
        process: null,
        eventCursor: 0,
        protocolVersion: "fake-v1",
        writerClaimEpoch: 1,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch: 1,
      claimOwner: null,
      pendingAction: null,
    });
    const staleStructuredAdapter = Object.assign(new FakeEngineHost(createFakeDeliveryLedger(), {
      status: "dead",
      sessionKey: sessionId,
      endpoint: "fake:stale-adapter",
      pid: null,
      processStartIdentity: null,
      eventCursor: 0,
      protocolVersion: "fake-v1",
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
      account: null,
    }), {
      onStateChange: () => () => {},
    });
    journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
    await bindStructuredDeliveryQueue([{ key, host: staleStructuredAdapter }], {
      registry,
      client: runtimeJournalClient(journal),
    });
    const snapshot = journal.snapshot();
    setAgentRegistryForTests(null);
    let disposed = false;
    return {
      snapshot,
      key,
      conversationId: conversation.id,
      rawIdentifiers: [sessionId, conversation.id, "fake:stale-adapter"],
      async dispose() {
        if (disposed) return;
        disposed = true;
        await bindStructuredDeliveryQueue([], { client: null });
        journal?.close();
        fs.rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    setAgentRegistryForTests(null);
    await bindStructuredDeliveryQueue([], { client: null });
    journal?.close();
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
