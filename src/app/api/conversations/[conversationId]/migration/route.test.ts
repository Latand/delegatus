import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

import { emptyLaunchProfile, type ViewerConversationId } from "@/lib/accounts/migration/contracts";
import type { SuccessorProviderPort } from "@/lib/accounts/migration/contracts";
import { applyConversationMigration } from "@/lib/accounts/migration/conversationCommand";
import { AgentRegistry, setAgentRegistryForTests, type ConversationObservation } from "@/lib/agent/registry";

const { POST } = await import("./route");

const roots: string[] = [];

afterEach(() => {
  setAgentRegistryForTests(null);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function observation(pathname: string, accountId: string, turnState: "idle" | "busy" = "idle"): ConversationObservation {
  return {
    engine: "codex",
    path: pathname,
    accountId,
    launchProfile: emptyLaunchProfile({ cwd: "/repo/checkout", title: "Implementer", project: "repo", role: "worker" }),
    turn: { state: turnState, source: "empty", terminalAt: null },
    observedAt: new Date().toISOString(),
  };
}

function seededRegistry(withHealthyQuota: boolean, turnState: "idle" | "busy" = "idle"): { registry: AgentRegistry; id: ViewerConversationId } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reseat-route-"));
  roots.push(root);
  const registry = new AgentRegistry(path.join(root, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
  registry.reconcileConversations([observation("/sessions/limited.jsonl", "limited", turnState)]);
  if (withHealthyQuota) {
    registry.recordQuotaEvaluation({
      engine: "codex",
      observations: [{
        engine: "codex",
        accountId: "default",
        authenticated: true,
        authCheckedAt: new Date().toISOString(),
        limits: { session: { usedPercent: 5, resetsAt: null }, weekly: null, plan: null, capturedAt: null },
        provenance: { source: "live", reason: null, staleSince: null },
        observedAt: new Date().toISOString(),
        bootId: "boot",
      }],
      signature: null,
      bootId: "boot",
      now: new Date().toISOString(),
      minimumGapMs: 0,
    });
  }
  setAgentRegistryForTests(registry);
  return { registry, id: registry.conversationForPath("/sessions/limited.jsonl")!.id };
}

function reseatRequest(conversationId: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://127.0.0.1/api/conversations/${conversationId}/migration`, {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("reseat requires a known conversation", async () => {
  seededRegistry(true);
  const response = await POST(
    reseatRequest("conversation_missing", { action: "reseat" }),
    { params: Promise.resolve({ conversationId: "conversation_missing" }) },
  );
  expect(response.status).toBe(404);
});

test("reseat refuses a card whose generation a migration already replaced", async () => {
  const { id } = seededRegistry(true);
  const response = await POST(
    reseatRequest(id, { action: "reseat", path: "/sessions/archived-predecessor.jsonl" }),
    { params: Promise.resolve({ conversationId: id }) },
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ reseat: "already-reseated" });
});

test("reseat without a fresh healthy account is refused, never guessed", async () => {
  const { id } = seededRegistry(false);
  const response = await POST(
    reseatRequest(id, { action: "reseat", path: "/sessions/limited.jsonl" }),
    { params: Promise.resolve({ conversationId: id }) },
  );
  expect(response.status).toBe(409);
  expect((await response.json() as { error: string }).error).toContain("healthy account");
});

test("reseat requests a lineage-safe migration once and repeats idempotently", async () => {
  const { registry, id } = seededRegistry(true);
  const first = await POST(
    reseatRequest(id, { action: "reseat", path: "/sessions/limited.jsonl" }),
    { params: Promise.resolve({ conversationId: id }) },
  );
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ reseat: "requested", targetId: "default", targetLabel: "Main" });
  const migration = registry.conversation(id)!.migration!;
  expect(migration).toMatchObject({ targetId: "default" });

  const repeat = await POST(
    reseatRequest(id, { action: "reseat", path: "/sessions/limited.jsonl" }),
    { params: Promise.resolve({ conversationId: id }) },
  );
  expect(repeat.status).toBe(200);
  expect(await repeat.json()).toMatchObject({ reseat: "already-migrating" });
  expect(registry.conversation(id)!.migration!.operationId).toBe(migration.operationId);
});

test("a reseat behind a still-open turn exposes its exact wait state", async () => {
  const { registry, id } = seededRegistry(true, "busy");
  const response = await POST(
    reseatRequest(id, { action: "reseat", path: "/sessions/limited.jsonl" }),
    { params: Promise.resolve({ conversationId: id }) },
  );
  expect(response.status).toBe(200);
  /* The card learns exactly what the reseat waits on instead of a generic
     "requested"; the wall itself frees the turn on the next inventory pass. */
  expect(await response.json()).toMatchObject({ reseat: "requested", phase: "waiting-turn" });
  expect(registry.conversation(id)!.migration!.phase).toBe("waiting-turn");
});

test("retry reaches normal migration handling", async () => {
  const request = new NextRequest("http://127.0.0.1/api/conversations/conversation_missing/migration", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ action: "retry", expectedRevision: 0 }),
  });

  const response = await POST(request, { params: Promise.resolve({ conversationId: "conversation_missing" }) });

  expect(await response.json()).toEqual({ error: "migration retry failed a recoverable preflight" });
});

test("the operator-facing conversation retry authorizes an unknown Codex fork before advancing", async () => {
  const { registry, id } = seededRegistry(false);
  const requested = registry.requestConversationReseat(id, "default");
  const failed = registry.transitionConversationMigration(
    id,
    requested.migration!.revision,
    ["requested"],
    {
      phase: "failed-recoverable",
      error: "Codex fork outcome is awaiting recovery",
      errorCode: "codex-fork-outcome-unknown",
    },
  );
  let authorized = false;
  const provider: SuccessorProviderPort = {
    virtualSource: true,
    async create(input) {
      expect(authorized).toBeTrue();
      return {
        operationId: input.operationId,
        nativeId: "successor",
        path: "/sessions/successor.jsonl",
        continuityPaths: [],
        historyHash: "hash",
        host: { kind: "codex-app-server", identity: "successor", epoch: 1, verifiedAt: "now" },
      };
    },
    async verify() {},
  };

  const result = await applyConversationMigration(
    { conversationId: id, action: "retry", expectedRevision: failed.migration!.revision },
    {
      registry: () => registry,
      provider: () => provider,
      authorizeForkRetry: async (operationId, conversationId) => {
        expect(operationId).toBe(failed.migration!.operationId);
        expect(conversationId).toBe(id);
        authorized = true;
        return "reauthorized";
      },
    },
  );

  expect(result.status).toBe(200);
  expect(authorized).toBeTrue();
  expect(registry.conversation(id)!.migration?.phase).toBe("committed");
});

test("cancel, rollback and retry commands refused for the lock change nothing, answer retryably and keep the loop free", async () => {
  /* docs/design/delivery-progress-and-drain.md, C2. */
  const { sqliteRegistryFixture, registryLockHolder, longestLoopGap } = await import("@/lib/agent/registryLockHolderFixture");
  const made = sqliteRegistryFixture("llv-conversation-command-refused", { sqliteWriterDeadlineMs: 150 });
  const holder = registryLockHolder(made.sqliteFilename);
  const registry = made.registry;
  try {
    registry.reconcileConversations([observation("/sessions/command-refused.jsonl", "limited")]);
    const id = registry.conversationForPath("/sessions/command-refused.jsonl")!.id;
    registry.commitMigrationIntent({ engine: "codex", targetId: "default", origin: "manual", requestId: "command-refused",
      expectedRevision: registry.engineRouting("codex").revision });
    const before = registry.conversation(id)!.migration!;
    for (const action of ["rollback", "retry"] as const) {
      await holder.hold(500);
      const { value: result, gapMs } = await longestLoopGap(() => applyConversationMigration(
        { conversationId: id, action, expectedRevision: registry.conversation(id)!.migration!.revision },
        { registry: () => registry, provider: () => { throw new Error("no provider is reached"); } }));
      expect(gapMs).toBeLessThan(50);
      expect(result).toMatchObject({ status: 503, body: { retryable: true } });
      expect(registry.conversation(id)!.migration).toMatchObject({ phase: before.phase, revision: before.revision });
      await Bun.sleep(550);
    }
    registry.transitionConversationMigration(id, before.revision, [before.phase], { phase: "waiting-turn" });
    const waiting = registry.conversation(id)!.migration!;
    await holder.hold(500);
    const { value: cancel, gapMs } = await longestLoopGap(() => applyConversationMigration(
      { conversationId: id, action: "cancel", expectedRevision: waiting.revision }, { registry: () => registry, kick: async () => {} }));
    expect(gapMs).toBeLessThan(50);
    expect(cancel).toMatchObject({ status: 503, body: { retryable: true } });
    expect(registry.conversation(id)!.migration).toMatchObject({ phase: "waiting-turn", revision: waiting.revision });
  } finally {
    await holder.close();
    registry.close();
    made.cleanup();
  }
});
