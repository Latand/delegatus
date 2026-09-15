import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { advanceConversationMigration, drainHeldDeliveries, type HeldDeliveryPort } from "@/lib/accounts/migration/coordinator";
import { emptyLaunchProfile, type HeldDelivery, type ProviderReceipt, type SuccessorProviderPort } from "@/lib/accounts/migration/contracts";
import { AgentRegistry, type RegistryConversation } from "@/lib/agent/registry";
import type { SessionKey } from "@/lib/agent/sessionKey";
import { setBoardFileForTests } from "@/lib/board/store";
import { procBackend } from "@/lib/proc";

import type { StructuredReconfigureEffect } from "./structuredDeliveryQueue";
import { applyStructuredReconfigure } from "./structuredReconfigure";

/*
 * Messages across a SUCCESSFUL account switch (#1695 K6).
 * WRITTEN BEFORE THE FIX: these cases state the contract of
 * `evidence/issue-1695/k6c-plan.md` and fail on #1708's head 04d53556,
 * where a committing switch fails and empties every pending delivery of the
 * conversation. Isolated registry and board files; no host, runtime socket or
 * account is touched.
 */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-switch-commit-messages-"));
let caseNumber = 0;

afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function claudeTranscript(pathname: string): void {
  fs.writeFileSync(pathname, [
    JSON.stringify({ type: "user", timestamp: "2026-07-21T10:00:00.000Z", message: { role: "user", content: "go" } }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-21T10:00:26.000Z",
      message: { role: "assistant", model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text: "worked for 26s" }] },
    }),
  ].join("\n") + "\n");
}

/** The broker process the registry row describes. Structured turn evidence
    only counts while its engine process is verifiably alive, so the fixture
    names this test process. */
function liveProcessIdentity() {
  return { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) };
}

function recordStructuredHost(
  registry: AgentRegistry,
  key: SessionKey,
  artifactPath: string,
  accountId: string,
  activeTurnRef: string | null,
  status: "live" | "idle" | "dead" = activeTurnRef ? "live" : "idle",
): void {
  registry.upsert({
    key,
    artifactPath,
    cwd: "/repo",
    accountId,
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    status,
    host: null,
    structuredHost: {
      kind: "claude-broker",
      endpoint: "stdio:broker",
      process: liveProcessIdentity(),
      eventCursor: 12,
      protocolVersion: "v1",
      writerClaimEpoch: 1,
      activeTurnRef,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: `structured-host:${JSON.stringify(liveProcessIdentity())}`,
    pendingAction: null,
  });
}

function successorProvider(successorPath: string, onCreate?: () => void): SuccessorProviderPort {
  return {
    async create(input): Promise<ProviderReceipt> {
      onCreate?.();
      fs.writeFileSync(successorPath, "");
      return {
        operationId: input.operationId,
        nativeId: "successor-native",
        path: successorPath,
        continuityPaths: [],
        historyHash: "successor-history",
        host: { kind: "claude-stream", identity: "successor-host", epoch: 1, verifiedAt: "2026-07-21T10:01:00.000Z" },
      };
    },
    async verify() {},
  };
}


interface Switch {
  registry: AgentRegistry;
  id: RegistryConversation["id"];
  sourcePath: string;
  sourceKey: SessionKey;
  successorPath: string;
  effect: StructuredReconfigureEffect;
  apply: () => Promise<"applied" | "pending">;
}

/** A switch to account B requested while account A's turn runs, before any delivery is admitted. */
async function switchWaitingForTurn(beforeSwitch: (registry: AgentRegistry, id: RegistryConversation["id"], sourceGenerationId: string) => void = () => {}): Promise<Switch> {
  const root = path.join(sandbox, `case-${caseNumber += 1}`);
  fs.mkdirSync(root);
  setBoardFileForTests(path.join(root, "board.json"));
  const registry = new AgentRegistry(path.join(root, "registry.json"));
  const sourcePath = path.join(root, "source.jsonl");
  const successorPath = path.join(root, "successor.jsonl");
  claudeTranscript(sourcePath);
  registry.reconcileConversations([{
    engine: "claude", path: sourcePath, accountId: "account-a",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "busy", source: "assistant", terminalAt: null }, observedAt: "2026-07-21T10:00:10.000Z",
  }]);
  const admitted = registry.conversationForPath(sourcePath)!;
  const source = admitted.generations.at(-1)!;
  const sourceKey: SessionKey = { engine: "claude", sessionId: source.id };
  recordStructuredHost(registry, sourceKey, sourcePath, "account-a", "turn-source");
  beforeSwitch(registry, admitted.id, source.id);
  const effect: StructuredReconfigureEffect = { operationId: "reconfigure-to-b", conversationId: admitted.id, kind: "reconfigure", model: "claude-opus-5", effort: "high", fast: false, accountId: "account-b", eventSeq: 7 };
  const apply = () => applyStructuredReconfigure(effect, {
    registry,
    validateAccount: async () => {},
    resolveAccount: ((engine: string, accountId: string) => ({ accountId, home: root, engine })) as never,
    releaseHost: async () => true,
    recover: (async () => true) as never,
    migrate: (conversationId, _target, store, ownsOperation, reconfigureOperationId) =>
      advanceConversationMigration(conversationId, store, successorProvider(successorPath), { ownsOperation, reconfigureOperationId, deferBoardRepair: true }),
  });
  expect(await apply()).toBe("pending");
  expect(registry.conversation(admitted.id)!.migration?.phase).toBe("waiting-turn");
  return { registry, id: admitted.id, sourcePath, sourceKey, successorPath, effect, apply };
}

/** The source's turn ends; the queue runs the switch again, and it commits on account B. */
async function turnEndsAndSwitchCommits(fixture: Switch): Promise<RegistryConversation> {
  recordStructuredHost(fixture.registry, fixture.sourceKey, fixture.sourcePath, "account-a", null);
  fixture.registry.reconcileConversations([{
    engine: "claude", path: fixture.sourcePath, accountId: "account-a",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "idle", source: "assistant", terminalAt: "2026-07-21T10:00:26.000Z" }, observedAt: "2026-07-21T10:00:30.000Z",
  }] as never);
  expect(await fixture.apply()).toBe("applied");
  const committed = fixture.registry.conversation(fixture.id)!;
  expect(committed.migration?.phase).toBe("committed");
  expect(committed.generations.at(-1)).toMatchObject({ accountId: "account-b", path: fixture.successorPath });
  return committed;
}

/** A delivery port that records what it is handed and confirms each delivery. */
function recordingPort() {
  const handed: Array<{ id: string; text: string; path: string; operationId: string }> = [];
  const port: HeldDeliveryPort = {
    deliver: async ({ delivery, path: target }) => {
      handed.push({ id: delivery.id, text: delivery.text, path: target, operationId: delivery.command.operationId });
      return "delivered";
    },
  };
  return { port, handed };
}

const snapshotOf = (fixture: Switch, id: string) => structuredClone(fixture.registry.snapshot().heldDeliveries[id]!);

test("a message held while the switch waited, and never attempted, is delivered once on the successor after the switch commits", async () => {
  const fixture = await switchWaitingForTurn();
  const held = fixture.registry.holdDelivery(fixture.id, "sent while the switch waits", "held-during-switch");
  expect({ state: held.state, attempts: held.attempts }).toEqual({ state: "held", attempts: 0 });

  const committed = await turnEndsAndSwitchCommits(fixture);
  const carried = snapshotOf(fixture, held.id);
  expect({ state: carried.state, generationId: carried.generationId, text: carried.text, operationId: carried.command.operationId, clientMessageId: carried.clientMessageId, attempts: carried.attempts })
    .toEqual({ state: "assigned", generationId: committed.generations.at(-1)!.id, text: held.text, operationId: held.command.operationId, clientMessageId: held.clientMessageId, attempts: 0 });

  const { port, handed } = recordingPort();
  await drainHeldDeliveries(fixture.id, port, fixture.registry);
  await drainHeldDeliveries(fixture.id, port, fixture.registry);
  expect(handed).toEqual([{ id: held.id, text: held.text, path: fixture.successorPath, operationId: held.command.operationId }]);
  expect(snapshotOf(fixture, held.id).state).toBe("delivered");
});

test("a message assigned to the source before the switch is never replayed automatically on the successor: it ends not delivered, with its payload and identity kept for an explicit resend", async () => {
  let before: HeldDelivery | null = null;
  const fixture = await switchWaitingForTurn((registry, id) => {
    before = registry.holdDelivery(id, "sent before the switch", "assigned-before-switch");
  });
  expect(before!.state).toBe("assigned");

  await turnEndsAndSwitchCommits(fixture);
  const kept = snapshotOf(fixture, before!.id);
  expect({ state: kept.state, text: kept.text, operationId: kept.command.operationId, clientMessageId: kept.clientMessageId, attempts: kept.attempts })
    .toEqual({ state: "failed", text: before!.text, operationId: before!.command.operationId, clientMessageId: before!.clientMessageId, attempts: before!.attempts });
  expect(kept.error).toMatch(/account migration committed/);

  const { port, handed } = recordingPort();
  await drainHeldDeliveries(fixture.id, port, fixture.registry);
  expect(handed).toEqual([]);
});

test("a held message that already had a delivery attempt is never replayed automatically after the switch commits", async () => {
  const fixture = await switchWaitingForTurn();
  const held = fixture.registry.holdDelivery(fixture.id, "held after an attempt", "attempted-then-held");
  /* The record of an earlier attempt, as a retry placement leaves it: held again with attempts > 0. */
  (fixture.registry as unknown as { mutate<T>(fn: (file: { heldDeliveries: Record<string, HeldDelivery> }) => T): T })
    .mutate((file) => { file.heldDeliveries[held.id]!.attempts = 1; });

  await turnEndsAndSwitchCommits(fixture);
  const kept = snapshotOf(fixture, held.id);
  expect({ state: kept.state, text: kept.text, attempts: kept.attempts }).toEqual({ state: "failed", text: held.text, attempts: 1 });
  const { port, handed } = recordingPort();
  await drainHeldDeliveries(fixture.id, port, fixture.registry);
  expect(handed).toEqual([]);
});
