import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

import { emptyLaunchProfile, type ViewerConversationId } from "@/lib/accounts/migration/contracts";
import type { SuccessorProviderPort } from "@/lib/accounts/migration/contracts";
import { applyConversationMigration } from "@/lib/accounts/migration/conversationCommand";
import { AgentRegistry, setAgentRegistryForTests, type ConversationObservation } from "@/lib/agent/registry";

const { POST } = await import("./route");
const { createConversationMigrationPOST } = await import("./handlers");

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

function seededRegistry(withHealthyQuota: boolean, turnState: "idle" | "busy" = "idle", sqlite = false, deadlineMs = 5_000): { registry: AgentRegistry; id: ViewerConversationId } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reseat-route-"));
  roots.push(root);
  const registry = new AgentRegistry(path.join(root, "agent-registry.json"), undefined, undefined,
    sqlite ? { sqliteMode: "sqlite", sqliteFilename: path.join(root, "registry.sqlite"), sqliteWriterDeadlineMs: deadlineMs } : { sqliteMode: "off" });
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

for (const refuse of [false, true]) test(`legacy reseat waits off-loop, correlates its migration and preserves a refused send (${refuse})`, async () => {
  const { registryLockHolder, whileRegistryWriterHeld } = await import("@/lib/agent/registryLockHolderFixture");
  const { blockingWaitDiagnostics, resetBlockingWaitsForTests } = await import("@/lib/blockingWaits");
  const { advanceConversationMigration, drainHeldDeliveries } = await import("@/lib/accounts/migration/coordinator");
  const { registry, id } = seededRegistry(true, "busy", true, refuse ? 80 : 5_000);
  const holder = registryLockHolder(path.join(roots.at(-1)!, "registry.sqlite"));
  const held = registry.holdDelivery(id, "accepted before reseat", "reseat-original-key");
  try {
    resetBlockingWaitsForTests(() => {});
    await holder.hold();
    const { value } = await whileRegistryWriterHeld(holder, () => applyConversationMigration({ conversationId: id, action: "reseat" }, { registry: () => registry }), { release: !refuse });
    expect(value.status).toBe(refuse ? 503 : 200);
    expect(registry.snapshot().heldDeliveries[held.id]?.text).toBe(held.text);
    if (refuse) {
      expect(value.body).toMatchObject({ retryable: true });
      expect(registry.conversation(id)?.migration).toBeNull();
      await holder.release();
      expect((await applyConversationMigration({ conversationId: id, action: "reseat" }, { registry: () => registry })).status).toBe(200);
    } else {
      expect(blockingWaitDiagnostics().longest.find(wait => wait.label === "migration.reseat-request")?.operationId).toBe(registry.conversation(id)?.migration?.operationId);
    }
    registry.reconcileConversations([observation("/sessions/limited.jsonl", "limited", "idle")]);
    const provider: SuccessorProviderPort = { virtualSource: true, async create(input) {
      return { operationId: input.operationId, nativeId: "reseat-successor", path: "/sessions/reseat-successor.jsonl", continuityPaths: [], historyHash: "hash",
        host: { kind: "codex-app-server", identity: "reseat-successor", epoch: 1, verifiedAt: "now" } };
    }, async verify() {}, async publishHost() {} };
    await advanceConversationMigration(id, registry, provider);
    let inputs = 0;
    const port = { async deliver() { inputs += 1; return "delivered" as const; } };
    await drainHeldDeliveries(id, port, registry);
    await drainHeldDeliveries(id, port, registry);
    expect(inputs).toBe(1);
  } finally { await holder.close(); registry.close(); }
});

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
  const { sqliteRegistryFixture, registryLockHolder, whileRegistryWriterHeld } = await import("@/lib/agent/registryLockHolderFixture");
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
      await holder.hold();
      const { value: result } = await whileRegistryWriterHeld(holder, () => applyConversationMigration(
        { conversationId: id, action, expectedRevision: registry.conversation(id)!.migration!.revision },
        { registry: () => registry, provider: () => { throw new Error("no provider is reached"); } }), { release: false });

      expect(result).toMatchObject({ status: 503, body: { retryable: true } });
      expect(registry.conversation(id)!.migration).toMatchObject({ phase: before.phase, revision: before.revision });
      await holder.release();
    }
    registry.transitionConversationMigration(id, before.revision, [before.phase], { phase: "waiting-turn" });
    const waiting = registry.conversation(id)!.migration!;
    await holder.hold();
    const { value: cancel } = await whileRegistryWriterHeld(holder, () => applyConversationMigration(
      { conversationId: id, action: "cancel", expectedRevision: waiting.revision }, { registry: () => registry, kick: async () => {} }), { release: false });

    expect(cancel).toMatchObject({ status: 503, body: { retryable: true } });
    expect(registry.conversation(id)!.migration).toMatchObject({ phase: "waiting-turn", revision: waiting.revision });
  } finally {
    await holder.close();
    registry.close();
    made.cleanup();
  }
});


test.each(["default", "different"])("successful migration retry clears only its fulfilled account hold (%s)", async (heldAccount) => {
  const { registry, id } = seededRegistry(false);
  const requested = registry.requestConversationReseat(id, "default");
  const failed = registry.transitionConversationMigration(id, requested.migration!.revision, ["requested"],
    { phase: "failed-recoverable", error: "temporary provider failure" });
  registry.holdForFailedSwitch(id, { operationId: "failed-switch", accountId: heldAccount, reason: "temporary provider failure" });
  const provider: SuccessorProviderPort = { virtualSource: true,
    async create(input) { return { operationId: input.operationId, nativeId: "retried-successor", path: "/sessions/retried-successor.jsonl", continuityPaths: [], historyHash: "hash",
      host: { kind: "codex-app-server", identity: "retried-successor", epoch: 1, verifiedAt: "now" } }; },
    async verify() {},
  };
  const result = await applyConversationMigration({ conversationId: id, action: "retry", expectedRevision: failed.migration!.revision },
    { registry: () => registry, provider: () => provider });
  expect(result.status).toBe(200);
  expect(registry.conversation(id)!.migration?.phase).toBe("committed");
  expect(registry.switchHold(id)?.accountId ?? null).toBe(heldAccount === "default" ? null : heldAccount);
});

test("keep-current acknowledges its durable change while an unrelated queue drain waits", async () => {
  const { registry, id } = seededRegistry(false);
  registry.holdForFailedSwitch(id, { operationId: "held-switch", accountId: "default", reason: "temporary failure" });
  const result = await Promise.race([
    applyConversationMigration({ conversationId: id, action: "keep-current" }, { registry: () => registry, kick: () => new Promise<void>(() => {}) }),
    new Promise<null>(resolve => setTimeout(() => resolve(null), 300)),
  ]);
  expect(result?.status).toBe(200);
  expect(registry.switchHold(id)).toBeNull();
});

describe("a member's explicit account choice on a running conversation", () => {
  const W = `w_${"d".repeat(32)}`;
  const previousState = process.env.LLV_STATE_DIR;
  let stateRoot = "";

  afterEach(async () => {
    (await import("@/lib/team/store")).resetTeamStoreForTests();
    if (previousState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previousState;
    if (stateRoot) fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  async function setup(pool: string[] | null) {
    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llv-member-account-"));
    process.env.LLV_STATE_DIR = path.join(stateRoot, "state");
    const { resetTeamStoreForTests, teamStore } = await import("@/lib/team/store");
    resetTeamStoreForTests();
    const { claimInstall } = await import("@/lib/team/members");
    const { createWorkspace } = await import("@/lib/team/workspaces");
    const { setWorkspaceDefaults } = await import("@/lib/team/workspaceDefaults");
    const { mintSession, MEMBER_COOKIE } = await import("@/lib/team/sessions");
    const store = teamStore();
    const owner = claimInstall(store, "Owner", { surface: "desktop", browser: "chrome" }).member;
    store.insertMember({ id: "m_member", name: "Member", role: "member", status: "active", color: "teal", telegram: null,
      createdAt: new Date().toISOString(), createdBy: owner.id, revokedAt: null });
    createWorkspace(store, owner, { id: W, name: "Alpha", projects: ["repo"] });
    store.putWorkspaceMember(W, "m_member", "member", owner.id, new Date().toISOString());
    if (pool) await setWorkspaceDefaults(store, owner, W, { accounts: { codex: pool } });
    const { registry, id } = seededRegistry(false);
    registry.reconcileConversations([{ ...observation("/sessions/limited.jsonl", "limited"),
      launchProfile: emptyLaunchProfile({ cwd: "/repo/checkout", title: "Implementer", project: "repo", role: "worker", model: "gpt-6.1-sol", effort: "high", fast: false }) }]);
    const cookie = (memberId: string) => `${MEMBER_COOKIE}=${mintSession(store, memberId, "claim", { surface: "desktop", browser: "chrome" }).value}`;
    return { registry, id, member: cookie("m_member"), owner: cookie(owner.id) };
  }

  const select = (post: ReturnType<typeof createConversationMigrationPOST>, id: string, cookie: string, accountId: string) =>
    post(new NextRequest(`http://127.0.0.1/api/conversations/${id}/migration`, {
      method: "POST", headers: { host: "127.0.0.1", origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", "content-type": "application/json", cookie },
      body: JSON.stringify({ action: "select-account", accountId }),
    }), { params: Promise.resolve({ conversationId: id }) });

  test("is refused outside the pool and where there is no pool, the same for an account that exists or not, and reaches no host", async () => {
    for (const [pool, reason] of [[["limited", "account-a"], "outside_account_list"], [null, "no_account_list"]] as const) {
      const { registry, id, member } = await setup(pool as string[] | null);
      let dispatched = 0;
      const post = createConversationMigrationPOST({ registry: () => registry, dispatchControl: async () => { dispatched++; return { status: 200, body: { ok: true } } as never; } });
      const answers = [];
      for (const account of ["account-b", "account-zzz"]) {
        const response = await select(post, id, member, account);
        answers.push({ status: response.status, body: await response.json() as { error: string; code: string; reason: string } });
      }
      expect(answers[0]).toMatchObject({ status: 409, body: { code: "project_account_refused", reason } });
      expect(answers[1]!.status).toBe(409);
      expect(answers[1]!.body.reason).toBe(reason);
      expect(answers[1]!.body.error.replaceAll("account-zzz", "account-b")).toBe(answers[0]!.body.error);
      expect(dispatched).toBe(0);
    }
  });

  test("is refused for an agent bound to the member, and left alone for an agent bound to nobody", async () => {
    const { registry, id } = await setup(["account-a"]);
    const profile = (workspace?: { memberId: string; workspaceId: string }) => emptyLaunchProfile({ cwd: "/repo/checkout", title: "Agent", project: "repo", role: "worker", model: "gpt-6.1-sol", effort: "high", fast: false, ...(workspace ? { workspace } : {}) });
    registry.reconcileConversations([
      { ...observation("/sessions/bound-agent.jsonl", "limited"), launchProfile: profile({ memberId: "m_member", workspaceId: W }) },
      { ...observation("/sessions/free-agent.jsonl", "limited"), launchProfile: profile() },
    ]);
    const bound = registry.conversationForPath("/sessions/bound-agent.jsonl")!.id;
    const free = registry.conversationForPath("/sessions/free-agent.jsonl")!.id;
    const { conversationAccountChoiceRefusal } = await import("@/lib/team/conversationAccountChoice");
    const request = new NextRequest("http://127.0.0.1/api/conversation-host", { method: "POST", headers: { host: "127.0.0.1" } });
    const refused = await conversationAccountChoiceRefusal(request, { kind: "agent", conversationId: bound }, id, "account-b");
    expect(refused?.status).toBe(409);
    expect(await refused!.json()).toMatchObject({ code: "project_account_refused", reason: "outside_account_list" });
    expect(await conversationAccountChoiceRefusal(request, { kind: "agent", conversationId: bound }, id, "account-a")).toBeNull();
    expect(await conversationAccountChoiceRefusal(request, { kind: "agent", conversationId: free }, id, "account-b")).toBeNull();
  });

  test("keeps the account the conversation already runs on, an account in the pool, and the owner's choice", async () => {
    const { registry, id, member, owner } = await setup(["account-a"]);
    const current = registry.conversation(id)!.generations.at(-1)!.accountId!;
    const dispatchedFor: string[] = [];
    const post = createConversationMigrationPOST({ registry: () => registry, dispatchControl: async input => {
      dispatchedFor.push(input.reconfiguration?.accountId ?? ""); return { status: 200, body: { ok: true } } as never;
    } });
    expect((await select(post, id, member, "account-a")).status).toBe(200);
    expect((await select(post, id, member, current)).status).toBe(200);
    expect((await select(post, id, owner, "account-b")).status).toBe(200);
    expect(dispatchedFor).toEqual(["account-a", current, "account-b"]);
  });
});
