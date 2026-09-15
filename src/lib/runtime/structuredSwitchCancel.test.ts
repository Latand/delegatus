import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { advanceConversationMigration } from "@/lib/accounts/migration/coordinator";
import { applyConversationMigration } from "@/lib/accounts/migration/conversationCommand";
import { emptyLaunchProfile, type HeldDelivery, type ProviderReceipt, type SuccessorProviderPort } from "@/lib/accounts/migration/contracts";
import { AgentRegistry, type RegistryConversation } from "@/lib/agent/registry";
import type { SessionKey } from "@/lib/agent/sessionKey";
import { setBoardFileForTests } from "@/lib/board/store";
import { procBackend } from "@/lib/proc";

import type { StructuredReconfigureEffect } from "./structuredDeliveryQueue";
import { applyStructuredReconfigure } from "./structuredReconfigure";

/*
 * Cancelling an account switch without losing anything (#1695 K6b, #1705).
 * PREPARED BEFORE THE IMPLEMENTATION: these cases state the contract of
 * `evidence/issue-1695/k6b-plan.md` and are red on main 098932f8. They use the
 * account-switch fixture of `structuredAccountSwitch.test.ts`: a structured
 * Claude conversation on account A running a turn, with three deliveries
 * around a switch to account B that waits for that turn. The first was
 * assigned to the source before the switch, the second began an attempt
 * before it (uncertain), and the third was held while the switch waited.
 * Isolated registry and board files; no host, runtime socket or account is
 * touched.
 */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-switch-cancel-"));
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

interface PendingSwitch {
  registry: AgentRegistry;
  id: RegistryConversation["id"];
  sourceGenerationId: string;
  effect: StructuredReconfigureEffect;
  profileBefore: RegistryConversation["generations"][number]["launchProfile"];
  apply: (effect?: StructuredReconfigureEffect) => Promise<"applied" | "pending">;
  deliveries: { before: HeldDelivery; uncertain: HeldDelivery; held: HeldDelivery | null };
}

/** A switch to account B requested while account A's turn runs; `claim: false` stops before the queue claims it. */
async function pendingSwitch(options: { claim?: boolean } = {}): Promise<PendingSwitch> {
  const root = path.join(sandbox, `case-${caseNumber += 1}`);
  fs.mkdirSync(root);
  setBoardFileForTests(path.join(root, "board.json"));
  const registry = new AgentRegistry(path.join(root, "registry.json"));
  const sourcePath = path.join(root, "source.jsonl");
  const successorPath = path.join(root, "successor.jsonl");
  claudeTranscript(sourcePath);
  registry.reconcileConversations([{
    engine: "claude",
    path: sourcePath,
    accountId: "account-a",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "busy", source: "assistant", terminalAt: null },
    observedAt: "2026-07-21T10:00:10.000Z",
  }]);
  const admitted = registry.conversationForPath(sourcePath)!;
  const source = admitted.generations.at(-1)!;
  const sourceKey: SessionKey = { engine: "claude", sessionId: source.id };
  recordStructuredHost(registry, sourceKey, sourcePath, "account-a", "turn-source");
  /* Admitted before any migration exists: assigned to the source generation. */
  const before = registry.holdDelivery(admitted.id, "sent before the switch", "before-switch");
  const attempted = registry.holdDelivery(admitted.id, "attempted before the switch", "attempted-before-switch");
  const uncertain = registry.beginDeliveryAttempt(attempted.id, source.id)!;
  const effect: StructuredReconfigureEffect = {
    operationId: "reconfigure-to-b",
    conversationId: admitted.id,
    kind: "reconfigure",
    model: "claude-opus-5",
    effort: "high",
    fast: false,
    accountId: "account-b",
    eventSeq: 7,
  };
  const apply = (next: StructuredReconfigureEffect = effect) => applyStructuredReconfigure(next, {
    registry,
    validateAccount: async () => {},
    resolveAccount: ((engine: string, accountId: string) => ({ accountId, home: root, engine })) as never,
    releaseHost: async () => true,
    recover: (async () => true) as never,
    migrate: (conversationId, _target, store, ownsOperation, reconfigureOperationId) =>
      advanceConversationMigration(conversationId, store, successorProvider(successorPath), { ownsOperation, reconfigureOperationId, deferBoardRepair: true }),
  });
  let held: HeldDelivery | null = null;
  if (options.claim !== false) {
    expect(await apply()).toBe("pending");
    expect(registry.conversation(admitted.id)!.migration).toMatchObject({ phase: "waiting-turn", targetId: "account-b" });
    /* Sent while the switch waits: fenced by its migration. */
    held = registry.holdDelivery(admitted.id, "sent while the switch waits", "during-switch");
    expect(held.state).toBe("held");
  }
  return {
    registry,
    id: admitted.id,
    sourceGenerationId: source.id,
    effect,
    profileBefore: structuredClone(source.launchProfile),
    apply,
    deliveries: { before: registry.snapshot().heldDeliveries[before.id]!, uncertain, held },
  };
}

const delivery = (fixture: PendingSwitch, id: string) => structuredClone(fixture.registry.snapshot().heldDeliveries[id]!);
const failedDeliveries = (fixture: PendingSwitch) => Object.values(fixture.registry.snapshot().heldDeliveries).filter((entry) => entry.state === "failed");

/* The planned registry surface (k6b-plan.md §2, §3). Absent on main: each case below fails there. */
type Planned = AgentRegistry & {
  cancelConversationSwitch(id: RegistryConversation["id"], expectedRevision: number): RegistryConversation;
  withdrawConversationReconfigure(id: RegistryConversation["id"], operationId: string): { kind: "withdrawn" | "replayed" | "claimed" | "settled" };
};
const planned = (registry: AgentRegistry) => registry as Planned;

test("cancelling a claimed switch that waits for the turn rolls it back, settles its owner, and re-arms only the delivery it held", async () => {
  const fixture = await pendingSwitch();
  const { registry, id } = fixture;
  const before = delivery(fixture, fixture.deliveries.before.id);
  const uncertain = delivery(fixture, fixture.deliveries.uncertain.id);
  const held = delivery(fixture, fixture.deliveries.held!.id);
  const migration = registry.conversation(id)!.migration!;

  const cancelled = planned(registry).cancelConversationSwitch(id, migration.revision);

  expect(cancelled.migration?.phase).toBe("rolled-back");
  expect(cancelled.reconfigure?.operationId).toBe(fixture.effect.operationId);
  expect(String(cancelled.reconfigure?.status)).toBe("cancelled");
  expect(registry.snapshot().migrationIntents[migration.intentId]?.state).toBe("stopped");
  expect(cancelled.generations.at(-1)?.launchProfile).toEqual(fixture.profileBefore);
  /* The held delivery goes back to the source with its payload and identity; nothing else moves. */
  const rearmed = delivery(fixture, held.id);
  expect({ state: rearmed.state, generationId: rearmed.generationId, text: rearmed.text, operationId: rearmed.command.operationId, clientMessageId: rearmed.clientMessageId, attempts: rearmed.attempts })
    .toEqual({ state: "assigned", generationId: fixture.sourceGenerationId, text: held.text, operationId: held.command.operationId, clientMessageId: held.clientMessageId, attempts: held.attempts });
  expect(delivery(fixture, before.id)).toEqual(before);
  expect(delivery(fixture, uncertain.id)).toEqual(uncertain);
  expect(failedDeliveries(fixture)).toEqual([]);

  /* The queue retries the effect it had left pending: nothing is requested again. */
  await expect(fixture.apply()).rejects.toThrow(/cancel/);
  const after = registry.conversation(id)!;
  expect(after.migration?.phase).toBe("rolled-back");
  expect(after.generations.at(-1)?.accountId).toBe("account-a");
  expect(delivery(fixture, held.id).state).toBe("assigned");
  expect(failedDeliveries(fixture)).toEqual([]);
});

test("a claimed cancel is refused with nothing changed when its revision is stale or the switch has started", async () => {
  const fixture = await pendingSwitch();
  const { registry, id } = fixture;
  const migration = registry.conversation(id)!.migration!;
  const heldId = fixture.deliveries.held!.id;
  expect(() => planned(registry).cancelConversationSwitch(id, migration.revision + 1)).toThrow(/stale/);
  expect(registry.conversation(id)!.migration?.phase).toBe("waiting-turn");

  registry.transitionConversationMigration(id, migration.revision, ["waiting-turn"], { phase: "preparing" });
  expect(() => planned(registry).cancelConversationSwitch(id, migration.revision)).toThrow(/started/);
  const current = registry.conversation(id)!;
  expect(current.migration?.phase).toBe("preparing");
  expect(current.reconfigure?.status).toBe("applying");
  expect(delivery(fixture, heldId).state).toBe("held");
});

test("a switch withdrawn before the queue claims it is never claimed: no profile is written and no migration is created", async () => {
  const fixture = await pendingSwitch({ claim: false });
  const { registry, id } = fixture;

  expect(planned(registry).withdrawConversationReconfigure(id, fixture.effect.operationId)).toEqual({ kind: "withdrawn" });
  expect(planned(registry).withdrawConversationReconfigure(id, fixture.effect.operationId)).toEqual({ kind: "replayed" });

  await expect(fixture.apply()).rejects.toThrow(/cancel/);
  const after = registry.conversation(id)!;
  expect(after.reconfigure ?? null).toBeNull();
  expect(after.migration ?? null).toBeNull();
  expect(after.generations.at(-1)?.launchProfile).toEqual(fixture.profileBefore);
  expect(failedDeliveries(fixture)).toEqual([]);
});

test("a withdrawal that arrives after the claim writes nothing and leaves the switch to a claimed cancel", async () => {
  const fixture = await pendingSwitch();
  const { registry, id } = fixture;
  expect(planned(registry).withdrawConversationReconfigure(id, fixture.effect.operationId)).toEqual({ kind: "claimed" });
  const after = registry.conversation(id)!;
  expect(after.migration?.phase).toBe("waiting-turn");
  expect(after.reconfigure?.status).toBe("applying");
  /* The queue's retry keeps the switch pending: the withdrawal fenced nothing. */
  expect(await fixture.apply()).toBe("pending");
});

test("a newer switch to another account keeps the held delivery held, with its payload, for the new migration", async () => {
  const fixture = await pendingSwitch();
  const { registry, id } = fixture;
  const held = delivery(fixture, fixture.deliveries.held!.id);

  expect(await fixture.apply({ ...fixture.effect, operationId: "reconfigure-to-c", accountId: "account-c", eventSeq: 8 })).toBe("pending");

  const after = registry.conversation(id)!;
  expect(after.migration).toMatchObject({ phase: "waiting-turn", targetId: "account-c" });
  const kept = delivery(fixture, held.id) as HeldDelivery & { fencedBy?: string | null };
  expect({ state: kept.state, text: kept.text, operationId: kept.command.operationId, fencedBy: kept.fencedBy ?? null })
    .toEqual({ state: "held", text: held.text, operationId: held.command.operationId, fencedBy: after.migration!.operationId });
  expect(failedDeliveries(fixture)).toEqual([]);
});

test("a newer switch back to the source account re-arms the held delivery with its payload, never failing it", async () => {
  const fixture = await pendingSwitch();
  const { registry, id } = fixture;
  const held = delivery(fixture, fixture.deliveries.held!.id);

  await fixture.apply({ ...fixture.effect, operationId: "reconfigure-back-to-a", accountId: "account-a", eventSeq: 8 });

  expect(registry.conversation(id)!.migration?.phase).toBe("rolled-back");
  const rearmed = delivery(fixture, held.id);
  expect({ state: rearmed.state, text: rearmed.text, operationId: rearmed.command.operationId })
    .toEqual({ state: "assigned", text: held.text, operationId: held.command.operationId });
  expect(failedDeliveries(fixture)).toEqual([]);
});

test("the migration route: cancel needs expectedRevision and rolls back a waiting switch; withdraw needs an operation id; rollback keeps its guard", async () => {
  const fixture = await pendingSwitch();
  const { registry, id } = fixture;
  const dependencies = { registry: () => registry };
  const revision = registry.conversation(id)!.migration!.revision;

  expect(await applyConversationMigration({ conversationId: id, action: "rollback" }, dependencies)).toMatchObject({ status: 400 });
  const withdrawn = await applyConversationMigration({ conversationId: id, action: "withdraw", operationId: "" } as never, dependencies);
  expect(withdrawn.status).toBe(400);
  expect(String(withdrawn.body.error)).toMatch(/operationId/);
  const unguarded = await applyConversationMigration({ conversationId: id, action: "cancel" }, dependencies);
  expect(unguarded.status).toBe(400);
  expect(String(unguarded.body.error)).toMatch(/expectedRevision/);
  expect(registry.conversation(id)!.migration?.phase).toBe("waiting-turn");

  const cancelled = await applyConversationMigration({ conversationId: id, action: "cancel", expectedRevision: revision }, dependencies);
  expect(cancelled.status).toBe(200);
  expect(registry.conversation(id)!.migration?.phase).toBe("rolled-back");
  expect(String(registry.conversation(id)!.reconfigure?.status)).toBe("cancelled");
});
