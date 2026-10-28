import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";
import { readTurboSettings, writeSeatTickSettings, defaultSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { changeConversationSpeed } from "./conversationSpeed";
import type { EngineHost, RuntimeTierRequest } from "./engineHost";

let root: string;
let registry: AgentRegistry;
let fixtureNumber = 0;
let previousState: string | undefined;
beforeEach(() => {
  fixtureNumber = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-speed-"));
  previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(root, "state");
  registry = new AgentRegistry(path.join(root, "registry.json"));
});
afterEach(() => {
  registry.close();
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture(engine: "codex" | "claude" = "codex", tiers = ["priority", "ultrafast"]) {
  fs.writeFileSync(path.join(root, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6.1-sol", service_tiers: tiers.map(id => ({ id })) }] }));
  const transcript = path.join(root, `thread-${engine}-${++fixtureNumber}.jsonl`);
  const conversation = registry.ensureConversation(engine, transcript, "account-a");
  registry.reconcileConversations([{ engine, path: transcript, accountId: "account-a",
    launchProfile: emptyLaunchProfile({ model: "gpt-6.1-sol", effort: "high", fast: false, serviceTier: "default", project: "speed-project" }),
    turn: { state: "idle", source: "empty", terminalAt: null }, observedAt: "2026-01-01T00:00:00.000Z" }]);
  const calls: RuntimeTierRequest[] = [];
  const host = { setTier: async (request: RuntimeTierRequest) => {
    request.authorizeDispatch?.();
    calls.push(request);
    return { appliedTier: request.serviceTier, echoed: true, cut: "none" as const };
  } } as unknown as EngineHost;
  const accounts = () => [{ id: "account-a", label: "Account A", home: root, kind: "managed" as const,
    sessionsDir: root, authPresent: true, loginPane: null, createdAt: 0 }];
  const deps = { registry, accounts, host: async () => host };
  const run = (tier: unknown = "ultrafast") => changeConversationSpeed(conversation.id, tier, "speed-one", deps);
  return { conversation, calls, deps, run };
}

test("speed records the applied profile without cutting, and an offline choice survives a fresh reader", async () => {
  const f = fixture();
  expect(await f.run()).toMatchObject({ status: 200, body: { ok: true, requestedTier: "ultrafast", appliedTier: "ultrafast", echoed: true } });
  expect(f.calls.map(call => call.cut)).toEqual(["none"]);
  expect(registry.conversation(f.conversation.id)?.generations.at(-1)?.launchProfile).toMatchObject({ serviceTier: "ultrafast", fast: true, effort: "high" });
  expect(await changeConversationSpeed(f.conversation.id, "priority", "speed-offline", { ...f.deps, host: async () => null }))
    .toMatchObject({ status: 200, body: { appliedTier: "priority", echoed: false, reason: "the tier applies at the next resume" } });
  const fresh = new AgentRegistry(path.join(root, "registry.json"));
  try { expect(fresh.conversation(f.conversation.id)?.generations.at(-1)?.launchProfile).toMatchObject({ serviceTier: "priority", fast: true }); }
  finally { fresh.close(); }
});

test.each(["bad tier", "", false, undefined])("speed refuses invalid tier %j before any host effect", async tier => {
  const f = fixture();
  expect((await changeConversationSpeed(f.conversation.id, tier, "speed-invalid", f.deps)).status).toBe(400);
  expect(f.calls).toEqual([]);
});

test.each([false, true])("speed returns account-specific catalog refusal (missing=%s)", async missing => {
  const f = fixture("codex", ["priority"]);
  if (missing) fs.unlinkSync(path.join(root, "models_cache.json"));
  const result = await f.run();
  expect(result.body.error).toContain("account-a");
  expect(result.body.error).toContain(missing ? "catalog unavailable" : "offered: priority");
  expect(result.status).toBe(409);
  expect(result.body.code).toBe("service_tier_unavailable");
  expect(f.calls).toEqual([]);
});

test("speed refuses a different engine and pipeline membership", async () => {
  const other = fixture("claude");
  expect(await other.run()).toMatchObject({ status: 400, body: { code: "codex_only" } });
  expect(other.calls).toEqual([]);
  const f = fixture();
  registry.rememberMembership(f.conversation.id, { kind: "pipeline", containerId: "pipeline-a", role: "builder", slot: "run", stageId: "build", stageOrder: 0, round: null, parentConversationId: null });
  expect(await f.run()).toMatchObject({ status: 409, body: { code: "stage_bound" } });
  expect(f.calls).toEqual([]);
});

test.each(["reconfigure", "migration", "hold"])("speed refuses an in-flight %s", async kind => {
  const f = fixture();
  const generation = registry.conversation(f.conversation.id)!.generations.at(-1)!;
  if (kind === "reconfigure") registry.claimConversationReconfigure(f.conversation.id, { operationId: "reconfigure-one", revision: 1, profile: generation.launchProfile });
  else if (kind === "hold") registry.holdForFailedSwitch(f.conversation.id, { operationId: "switch-one", accountId: "account-b", reason: "held" });
  else registry.setConversationMigration(f.conversation.id, { intentId: "migration-one", phase: "waiting-turn", targetId: "account-b", revision: 1,
    error: null, errorCode: null, operationId: "migration-one", sourceGenerationId: generation.id, providerReceipt: null,
    pendingContinuityPaths: [], boardProject: null, boardOperationId: null, boardPlacementProject: null, updatedAt: "2026-01-01T00:00:00.000Z" });
  expect(await f.run()).toMatchObject({ status: 409, body: { code: "runtime_change_in_flight" } });
  expect(f.calls).toEqual([]);
});

test("speed rechecks runtime holds and catalog after host resolution", async () => {
  for (const cause of ["hold", "catalog", "stage", "model"]) {
    const f = fixture();
    const result = await changeConversationSpeed(f.conversation.id, "ultrafast", `speed-race-${cause}`, { ...f.deps, host: async () => {
      if (cause === "hold") registry.holdForFailedSwitch(f.conversation.id, { operationId: "peer-switch", accountId: "account-b", reason: "held" });
      else if (cause === "catalog") fs.unlinkSync(path.join(root, "models_cache.json"));
      else if (cause === "model") registry.updateConversationLaunchProfile(f.conversation.id, { model: "another-model", effort: "high", fast: false });
      else registry.rememberMembership(f.conversation.id, { kind: "pipeline", containerId: "pipeline-a", role: "builder", slot: "run", stageId: "build", stageOrder: 0, round: null, parentConversationId: null });
      return await f.deps.host();
    } });
    expect(result.status).toBe(409);
    expect(f.calls).toEqual([]);
    registry.releaseSwitchHold(f.conversation.id);
  }
});

test("speed refuses a host without tier support and records a differing native echo truthfully", async () => {
  const f = fixture();
  expect(await changeConversationSpeed(f.conversation.id, "ultrafast", "speed-terminal", { ...f.deps, host: async () => ({}) as EngineHost }))
    .toMatchObject({ status: 409, body: { error: expect.stringContaining("cannot change its speed in place") } });
  expect(await changeConversationSpeed(f.conversation.id, "ultrafast", "speed-differs", { ...f.deps, host: async () => ({
    setTier: async () => ({ appliedTier: "priority", echoed: true, cut: "none" }),
  }) as unknown as EngineHost })).toMatchObject({ status: 409, body: { code: "tier_differs", appliedTier: "priority", echoed: true } });
  expect(registry.conversation(f.conversation.id)?.generations.at(-1)?.launchProfile.serviceTier).toBe("priority");
});

test("speed makes the explicit choice Turbo's restoration tier", async () => {
  const f = fixture();
  const at = "2026-01-01T00:00:00.000Z";
  writeSeatTickSettings("speed-project", { ...defaultSeatTickSettings("speed-project"), turbo: {
    enabled: true, startedAt: at, until: null, endedAt: null, endReason: null, updatedAt: at,
    setBy: { kind: "gateway", conversationId: null, project: null, seatEpoch: null }, why: null, plan: [],
    credits: { approved: false, accounts: [], approvedAt: null, withdrawnAt: null, withdrawnBy: null, withdrawnWhy: null },
    switches: [{ conversationId: f.conversation.id, accountId: "account-a", model: "gpt-6.1-sol", from: "default", to: "ultrafast", state: "switched", at }],
  } });
  expect((await f.run()).status).toBe(200);
  expect(readTurboSettings("speed-project").turbo?.switches[0]?.from).toBe("ultrafast");
});


test("speed refuses registered terminal custody even when no structured host resolves", async () => {
  const f = fixture();
  const generation = registry.conversation(f.conversation.id)!.generations.at(-1)!;
  const identity = { pid: 123456, startIdentity: "fixture-process" };
  registry.upsert({ key: { engine: "codex", sessionId: generation.id }, artifactPath: generation.path, cwd: root,
    accountId: "account-a", status: "live", claimEpoch: 1, claimOwner: "terminal-fixture", pendingAction: null,
    host: { kind: "tmux", endpoint: "fixture-endpoint", server: identity, paneId: "%1", panePid: identity,
      windowName: "fixture-window", agent: identity, argv: [] } });
  expect(await changeConversationSpeed(f.conversation.id, "ultrafast", "speed-terminal-custody", { ...f.deps, host: async () => null }))
    .toMatchObject({ status: 409, body: { error: expect.stringContaining("cannot change its speed in place") } });
  expect(registry.conversation(f.conversation.id)?.generations.at(-1)?.launchProfile.serviceTier).toBe("default");
});


test("speed refuses unresolved runtime evidence and preserves a refused native profile", async () => {
  const f = fixture();
  expect((await changeConversationSpeed("conversation_missing", "ultrafast", "speed-missing", f.deps)).status).toBe(409);
  expect(await changeConversationSpeed(f.conversation.id, "ultrafast", "speed-no-account", { ...f.deps, accounts: () => [] }))
    .toMatchObject({ status: 409, body: { code: "service_tier_unavailable" } });
  expect(await changeConversationSpeed(f.conversation.id, "ultrafast", "speed-native-failed", { ...f.deps, host: async () => ({
    setTier: async () => { throw new Error("native speed update refused"); },
  }) as unknown as EngineHost })).toMatchObject({ status: 409, body: { error: "native speed update refused" } });
  expect(registry.conversation(f.conversation.id)?.generations.at(-1)?.launchProfile.serviceTier).toBe("default");
  registry.updateConversationLaunchProfile(f.conversation.id, { model: null, effort: "high", fast: false });
  expect(await f.run()).toMatchObject({ status: 409, body: { code: "model_unknown" } });
  expect(f.calls).toEqual([]);
});
