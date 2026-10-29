import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as registryModule from "@/lib/agent/registry";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import * as controls from "@/lib/conversation/actions";
import * as sourcesModule from "@/lib/monitor/seatTickSources";
import * as storeModule from "./store";
import { confirmOwnerStop, OWNER_STOP_PENDING_LIMIT_MS, observeOwnerContinuation, type OwnerRunPorts } from "./ownerRun";
import { dropRun, newTargetSettings, readRelayStore, readRunLedger, reserveRun, updateRelayStore, writeRelayFile, type PairedRelay, type RunRecord } from "./store";
import { advertisedSlots } from "./runner";
import { sweepExternalRelayOrphans } from "./poller";
import type { RegistryFile } from "@/lib/agent/registry";
import { statePath } from "@/lib/configDir";
import { readConversations, reserveChainConversationAsync, releaseConversationAsync, type RelayConversation } from "./conversations";
import { procBackend } from "@/lib/proc";
import { contextRequest } from "./request.fixture";
import { ownerTierFor } from "./profile";
import { requestSchema } from "./protocol";

function fixture(sqliteMode: "off" | "sqlite" = "off") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-stop-"));
  const registry = new registryModule.AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode });
  const clientAttemptId = "owner-stop-completed";
  const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd: root, transport: "structured", clientAttemptId,
    conversationId: "conversation_owner-stop-completed" });
  if (begun.kind !== "created") throw Error("fixture launch refused");
  const key = { engine: "codex" as const, sessionId: "00000000-0000-0000-0000-000000000001" };
  registry.completeSpawn(begun.receipt.launchId, { key, artifactPath: path.join(root, `rollout-${key.sessionId}.jsonl`), cwd: root,
    accountId: null, status: "dead", host: null, structuredHost: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
  if (begun.receipt.admissionOwner) registry.releaseStructuredSpawnAdmissionOwner(begun.receipt.launchId, begun.receipt.admissionOwner);
  expect(registry.conversation(begun.receipt.conversationId)?.generations.at(-1)?.id).toBe(key.sessionId);
  const run: RunRecord = { requestId: "owner-stop-completed", relayId: "relay_fixture", targetId: "target_fixture", leaseId: "lease_fixture",
    conversationId: begun.receipt.conversationId, ownerTurn: { clientAttemptId, cancel: "interrupt", admissionComplete: true },
    ownerPid: process.pid, ownerIdentity: null, childPid: null, childIdentity: null, runDir: "", startedAt: "2026-01-01T00:00:00.000Z" };
  return { root, registry, run, key, receipt: begun.receipt, close: () => {
    dropRun(run.requestId); registry.close(); fs.rmSync(root, { recursive: true, force: true });
  } };
}

function production(f: ReturnType<typeof fixture>) {
  const { registry } = f;
  const lookup = spyOn(registryModule, "agentRegistry").mockReturnValue(registry);
  const sources = spyOn(sourcesModule, "defaultSeatTickSources").mockReturnValue({ registry: () => registry,
    now: () => Date.parse("2026-01-01T01:00:00.000Z"), liveness: async () => [{ reason: "host_gone_turn_unverified" }] } as never);
  const control = spyOn(controls, "applyConversationAction").mockResolvedValue({ status: 503, body: { error: "no host" } });
  return { control, close: () => { control.mockRestore(); sources.mockRestore(); lookup.mockRestore(); } };
}

for (const mode of ["off", "sqlite"] as const) for (const bound of [false, true]) test(`a returned failed admission releases its own live lease before proving no execution (${mode}, attributed=${bound})`, async () => {
  const f = fixture(mode); const ports = production(f);
  const begun = beginLegacySpawnFixture(f.registry, { engine: "codex", cwd: f.root, transport: "structured",
    clientAttemptId: "failed-admission", conversationId: "conversation_failed-admission" });
  if (begun.kind !== "created") throw Error("fixture admission refused");
  f.registry.failSpawn(begun.receipt.launchId, "database is locked");
  if (bound) f.run.conversationId = begun.receipt.conversationId; else delete f.run.conversationId;
  f.run.ownerTurn!.clientAttemptId = begun.receipt.clientAttemptId!;
  reserveRun(f.run, 1);
  try {
    expect(f.registry.spawnReceiptForClientAttempt("failed-admission")?.admissionOwner?.pid).toBe(process.pid);
    expect(await confirmOwnerStop(f.run)).toBe(true);
    expect(f.registry.spawnReceiptForClientAttempt("failed-admission")?.admissionOwner).toBeNull();
    expect(readRunLedger().runs.find(row => row.requestId === f.run.requestId)?.ownerTurn).toMatchObject({ confirmed: true, released: { reason: "no_execution" } });
    expect(ports.control).not.toHaveBeenCalled();
  } finally { ports.close(); f.close(); }
});

for (const mode of ["off", "sqlite"] as const) test(`failed admission owned by a live peer is retained until its owner exits (${mode})`, async () => {
  const f = fixture(mode); const ports = production(f);
  const child = Bun.spawn([process.execPath, "-e", `
    import { AgentRegistry } from "./src/lib/agent/registry";
    import { beginLegacySpawnFixture } from "./src/lib/agent/registryTestFixtures";
    const registry = new AgentRegistry(process.env.OWNER_STOP_REGISTRY, undefined, undefined, { sqliteMode: process.env.OWNER_STOP_SQLITE });
    const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd: process.cwd(), transport: "structured",
      clientAttemptId: "peer-failed-admission", conversationId: "conversation_peer-failed-admission" });
    registry.failSpawn(begun.receipt.launchId, "database is locked");
    console.log("ready");
    await Bun.stdin.text();
    registry.close();
  `], { cwd: process.cwd(), env: { ...process.env, OWNER_STOP_REGISTRY: f.registry.filename, OWNER_STOP_SQLITE: mode },
    stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const errors = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  try {
    expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe("ready");
    f.run.conversationId = "conversation_peer-failed-admission";
    f.run.ownerTurn!.clientAttemptId = "peer-failed-admission";
    reserveRun(f.run, 1);
    expect(await confirmOwnerStop(f.run)).toBe(false);
    expect(f.registry.spawnReceiptForClientAttempt("peer-failed-admission")?.admissionOwner?.pid).toBe(child.pid);
    expect(ports.control).toHaveBeenCalled();
    child.stdin.end(); await child.exited;
    expect(await confirmOwnerStop(f.run)).toBe(true);
    expect(readRunLedger().runs.find(row => row.requestId === f.run.requestId)?.ownerTurn?.confirmed).toBe(true);
  } finally {
    if (child.exitCode === null) child.stdin.end();
    await child.exited; await errors; reader.releaseLock(); ports.close(); f.close();
  }
});

test("a legacy slot-only release quarantines across fresh processes, detaching its continuation cursor and retaining delivery custody", async () => {
  const f = fixture();
  const now = Date.parse("2026-10-28T12:00:00Z");
  const cancelledAt = new Date(now - OWNER_STOP_PENDING_LIMIT_MS).toISOString();
  const request = requestSchema.parse({ ...contextRequest, request_id: f.run.requestId, chat: { key: "restart-stop-chain" }, input: { ...contextRequest.input,
    requester: { ...contextRequest.input.requester, is_owner: true } } });
  const context = ownerTierFor({ ownerTier: true }, request)!;
  const lateAnswer = { body: { lease_id: f.run.leaseId, outcome: "answered" as const,
    answer: { action: "reply" as const, text: "Saved answer", reply_to: context.messageId }, duration_ms: 1 }, files: [] };
  const target = { ...newTargetSettings({ target_id: f.run.targetId, name: "Target", answered_by: "install", fallback: "none" }), engine: "codex" as const, ownerTier: true };
  const relay = { id: f.run.relayId, targets: [target], paused: false } as PairedRelay;
  const previousRelays = readRelayStore();
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  const chainFile = statePath("external-relay/conversations.json");
  const previousChains = fs.existsSync(chainFile) ? fs.readFileSync(chainFile) : null;
  const chain = (await reserveChainConversationAsync(relay, target, request, "owner-tier", Date.now() + 5000))!;
  const operationId = "relay-owner-stop-continuation";
  await releaseConversationAsync(chain.id, { state: "running", runningRequestId: request.request_id, conversationId: f.run.conversationId,
    pendingCursor: { operationId, seen: ["unconfirmed"], staticDigest: "pending" } }, Date.now() + 5000, request.request_id);
  f.run.ownerTurn = { ...f.run.ownerTurn!, clientAttemptId: operationId, continuation: { operationId }, context, rawRequest: request, cancelledAt,
    released: { at: cancelledAt, reason: "stop_unconfirmed" }, lateAnswer };
  reserveRun(f.run, 1);
  try {
    for (let restart = 0; restart < 2; restart++) {
      const child = Bun.spawn([process.execPath, "-e", `
        import { confirmOwnerStop } from "./src/lib/externalRelay/ownerRun";
        import { readRunLedger, ownerStopPending, newTargetSettings } from "./src/lib/externalRelay/store";
        import { sweepConversationsAsync, resolveChainConversationAsync, reserveChainConversationAsync, releaseConversationAsync } from "./src/lib/externalRelay/conversations";
        import { ownerRelayAuthorized } from "./src/lib/externalRelay/ownerAuthority";
        import { sweepExternalRelayOrphans } from "./src/lib/externalRelay/poller";
        let stops = 0;
        const run = readRunLedger().runs.find(row => row.requestId === "owner-stop-completed");
        const settled = await confirmOwnerStop(run, { now: () => ${now}, stopRetryMs: 1,
          stop: async () => { stops++; throw Error("control refused"); },
          observe: async () => ({ state: "running" }) });
        const saved = readRunLedger().runs.find(row => row.requestId === run.requestId);
        const target = { ...newTargetSettings({ target_id: run.targetId, name: "Target", answered_by: "install", fallback: "none" }), engine: "codex" };
        const relay = { id: run.relayId, targets: [target] };
        await sweepConversationsAsync([relay], ${Date.parse(chain.createdAt)}, Date.now() + 5000);
        const request = { ...saved.ownerTurn.rawRequest, request_id: "restart-next" };
        await resolveChainConversationAsync(relay, target, request, "owner-tier", Date.now() + 5000);
        const next = await reserveChainConversationAsync(relay, target, request, "owner-tier", Date.now() + 5000);
        let sends = 0;
        globalThis.fetch = async () => { sends++; throw Error("unexpected service delivery"); };
        await sweepExternalRelayOrphans();
        console.log(JSON.stringify({ settled, stops, pending: ownerStopPending(saved), capacityReleased: saved.capacityReleased === true,
          admitted: !!next, conversationId: next?.conversationId ?? null, authorized: ownerRelayAuthorized(run.relayId, run.targetId, run.requestId), sends }));
        if (next) await releaseConversationAsync(next.id, {}, Date.now() + 5000, request.request_id);
      `], { cwd: process.cwd(), env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
      const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code).toBe(0);
      expect(JSON.parse(output)).toEqual({ settled: true, stops: restart ? 0 : 3, pending: false, capacityReleased: true,
        admitted: true, conversationId: null, authorized: false, sends: 0 });
      expect(error.includes("ALARM:")).toBe(!restart);
    }
    const saved = readRunLedger().runs.find(row => row.requestId === f.run.requestId)!;
    expect(saved.capacityReleased).toBe(true);
    expect(saved.ownerTurn?.confirmed).toBeUndefined();
    expect(saved.ownerTurn?.cancelledAt).toBe(cancelledAt);
    expect(saved.ownerTurn?.lateAnswer).toEqual(lateAnswer);
    expect(saved.ownerTurn?.continuation).toEqual({ operationId });
  } finally {
    if (previousChains) fs.writeFileSync(chainFile, previousChains); else fs.rmSync(chainFile, { force: true });
    updateRelayStore(() => previousRelays);
    f.close();
  }
});

test("quarantine rechecks custody after awaiting its ledger writer", async () => {
  const f = fixture();
  const now = Date.parse("2026-10-28T12:00:00Z");
  f.run.ownerTurn!.cancelledAt = new Date(now - OWNER_STOP_PENDING_LIMIT_MS).toISOString();
  reserveRun(f.run, 1);
  const write = storeModule.changeRunAsync;
  const writer = spyOn(storeModule, "changeRunAsync").mockImplementation(async (id, change, until) => {
    storeModule.changeRun(id, row => ({ ...row, leaseId: "replacement-lease", ownerTurn: { ...row.ownerTurn!, clientAttemptId: "replacement-attempt" } }));
    return write(id, change, until);
  });
  try {
    expect(await confirmOwnerStop(f.run, { now: () => now, stopRetryMs: 1,
      launch: async () => { throw Error("unexpected launch"); },
      observe: async () => ({ state: "running" }), stop: async () => { throw Error("control refused"); } })).toBe(false);
    const saved = readRunLedger().runs.find(row => row.requestId === f.run.requestId)!;
    expect(saved.leaseId).toBe("replacement-lease");
    expect(saved.capacityReleased).toBeUndefined();
    expect(saved.ownerTurn?.quarantinedAt).toBeUndefined();
  } finally { writer.mockRestore(); f.close(); }
});

for (const mode of ["off", "sqlite"] as const) test(`a completed owner launch with an unreadable ended turn releases stop custody without host control (${mode})`, async () => {
  const f = fixture(mode); const ports = production(f);
  reserveRun(f.run, 1);
  try {
    expect(await confirmOwnerStop(f.run)).toBe(true);
    expect(readRunLedger().runs.find(row => row.requestId === f.run.requestId)?.ownerTurn?.confirmed).toBe(true);
    expect(ports.control).not.toHaveBeenCalled();
  } finally { ports.close(); f.close(); }
});

test("a retired continuation without a spawn receipt settles the production stop", async () => {
  const f = fixture(); const ports = production(f);
  f.run.ownerTurn!.clientAttemptId = "owner-stop-continuation";
  f.run.ownerTurn!.continuation = { operationId: "owner-stop-continuation" };
  const delivery = f.registry.holdDelivery(f.receipt.conversationId, "Fixture instruction", "owner-stop-continuation", "text", [], null,
    { operationId: "owner-stop-continuation" });
  f.registry.terminalizeHeldDelivery(delivery.id, "fixture cutoff");
  reserveRun(f.run, 1);
  try {
    expect(f.registry.spawnReceiptForClientAttempt(f.run.ownerTurn!.clientAttemptId)).toBeNull();
    expect(await confirmOwnerStop(f.run)).toBe(true);
    expect(ports.control).not.toHaveBeenCalled();
  } finally { ports.close(); f.close(); }
});

test("stop recovery observes the persisted continuation operation after a refused control", async () => {
  const f = fixture();
  f.run.ownerTurn!.continuation = { operationId: "owner-stop-continuation" };
  reserveRun(f.run, 1);
  const ports: OwnerRunPorts = { launch: async () => { throw Error("unexpected launch"); },
    stop: async () => { throw Error("control unavailable"); }, stopRetryMs: 1,
    observe: async turn => {
      expect(turn.continuation).toEqual(f.run.ownerTurn!.continuation);
      return observeOwnerContinuation(turn, { registry: () => f.registry, now: () => 0,
        liveness: async () => [{ reason: "host_gone_turn_open" }] } as never,
        async () => ({ state: "delivered", conversationId: f.run.conversationId!, acceptedAt: f.run.startedAt, settledAt: f.run.startedAt }));
    } };
  try { expect(await confirmOwnerStop(f.run, ports)).toBe(true); }
  finally { f.close(); }
});

const blockers: [string, (snapshot: RegistryFile, f: ReturnType<typeof fixture>) => void][] = [
  ["missing conversation", (s, f) => { delete s.conversations[f.run.conversationId!]; }],
  ["missing current entry", (s, f) => { delete s.entries[`codex:${f.key.sessionId}`]; }],
  ["live status", (s, f) => { s.entries[`codex:${f.key.sessionId}`]!.status = "live"; }],
  ["legacy host", (s, f) => { s.entries[`codex:${f.key.sessionId}`]!.host = {} as never; }],
  ["structured host", (s, f) => { s.entries[`codex:${f.key.sessionId}`]!.structuredHost = {} as never; }],
  ["claim", (s, f) => { s.entries[`codex:${f.key.sessionId}`]!.claimOwner = "fixture-owner"; }],
  ["pending action", (s, f) => { s.entries[`codex:${f.key.sessionId}`]!.pendingAction = "resume"; }],
  ["termination survivor", (s, f) => { s.entries[`codex:${f.key.sessionId}`]!.structuredTerminationSurvivors = [{} as never]; }],
  ["live historical owner", (s, f) => { s.entries["codex:historical"] = { ...s.entries[`codex:${f.key.sessionId}`]!,
    key: { engine: "codex", sessionId: "historical" }, claimOwner: "fixture-owner" }; }],
  ["open aliased receipt", (s, f) => {
    s.conversationAliases.conversation_alias = f.run.conversationId! as `conversation_${string}`;
    s.receipts.peer = { ...s.receipts[f.receipt.launchId]!, launchId: "peer", conversationId: "conversation_alias", state: "starting" };
  }],
  ["terminal receipt admission owner", (s, f) => { s.receipts[f.receipt.launchId]!.admissionOwner = {} as never; }],
  ["terminal receipt queued launch", (s, f) => { s.receipts[f.receipt.launchId]!.queuedPinnedSpawn = {} as never; }],
  ["applying reconfigure", (s, f) => { s.conversations[f.run.conversationId!]!.reconfigure = { status: "applying" } as never; }],
  ["pending migration", (s, f) => { s.conversations[f.run.conversationId!]!.migration = { phase: "prepared" } as never; }],
  ["pending peer delivery", (s, f) => {
    s.heldDeliveries.peer = { conversationId: f.run.conversationId!, state: "queued", text: "Fixture peer" } as never;
  }],
  ["failed delivery with owed text", (s, f) => {
    s.heldDeliveries.peer = { conversationId: f.run.conversationId!, state: "failed", text: "Fixture peer" } as never;
  }],
];
for (const [name, alter] of blockers) test(`stop retains custody with ${name}`, async () => {
  const f = fixture(); const ports = production(f);
  reserveRun(f.run, 1);
  const snapshot = f.registry.livenessConversationSnapshot(f.run.conversationId!);
  alter(snapshot, f);
  const read = spyOn(f.registry, "livenessConversationSnapshot").mockReturnValue(snapshot);
  try {
    expect(await confirmOwnerStop(f.run)).toBe(false);
    expect(readRunLedger().runs.find(row => row.requestId === f.run.requestId)?.ownerTurn?.confirmed).not.toBe(true);
    expect(ports.control).toHaveBeenCalled();
  } finally { read.mockRestore(); ports.close(); f.close(); }
});

test("unreadable custody is retained and cleanup is revalidated after its await", async () => {
  const f = fixture(); const ports = production(f);
  reserveRun(f.run, 1);
  const read = spyOn(f.registry, "livenessConversationSnapshot").mockImplementation(() => { throw Error("unreadable fixture"); });
  try {
    expect(await confirmOwnerStop(f.run)).toBe(false);
    read.mockRestore();
    // A queued prompt is cut off asynchronously. Another owner can arrive
    // while that write waits; the old hostless snapshot cannot settle it.
    const delivery = f.registry.holdDelivery(f.receipt.conversationId, "Fixture instruction", "initial-prompt", "text", [], null,
      { operationId: `spawn_message_${f.receipt.launchId}` });
    const write = f.registry.deliveryWrite.bind(f.registry);
    const writer = spyOn(f.registry, "deliveryWrite").mockImplementation(async (...args) => {
      const result = await write(...args);
      f.registry.upsert({ ...f.registry.livenessConversationSnapshot(f.run.conversationId!).entries[`codex:${f.key.sessionId}`]!,
        claimOwner: "replacement-owner", pendingAction: "resume" });
      return result;
    });
    try {
      expect(await confirmOwnerStop(f.run)).toBe(false);
      expect(f.registry.deliverySnapshotForOperation(delivery.command.operationId).heldDeliveries[delivery.id]!.text).toBe("");
      expect(readRunLedger().runs.find(row => row.requestId === f.run.requestId)?.ownerTurn?.confirmed).not.toBe(true);
    } finally { writer.mockRestore(); }
  } finally { read.mockRestore(); ports.close(); f.close(); }
});

for (const mode of ["off", "sqlite"] as const) test(`a restarted production sweeper retires dead continuation custody and restores target capacity (${mode})`, async () => {
  const f = fixture(mode);
  f.run.ownerTurn!.clientAttemptId = "owner-stop-continuation";
  f.run.ownerTurn!.continuation = { operationId: "owner-stop-continuation" };
  const delivery = f.registry.holdDelivery(f.receipt.conversationId, "Fixture instruction", "owner-stop-continuation", "text", [], null,
    { operationId: "owner-stop-continuation" });
  f.registry.terminalizeHeldDelivery(delivery.id, "fixture cutoff");
  reserveRun(f.run, 3);
  const chainFile = statePath("external-relay/conversations.json");
  const previousChains = fs.existsSync(chainFile) ? fs.readFileSync(chainFile) : null;
  const chain: RelayConversation = { id: "00000000-0000-0000-0000-000000000002", relayId: f.run.relayId, targetId: f.run.targetId,
    chatKey: "fixture", requesterKey: "fixture", authority: "owner-tier", anchors: [], conversationId: f.run.conversationId!,
    engine: "codex", sessionId: f.key.sessionId, accountId: null, cwd: null, turns: 1, turnsSinceCompaction: 1,
    createdAt: f.run.startedAt, lastTurnAt: f.run.startedAt, seen: [], staticDigest: null, lastPromptTokens: null, compactions: 0,
    state: "running", runningRequestId: f.run.requestId };
  writeRelayFile(chainFile, { v: 2, conversations: [chain] });
  expect(readConversations()).toHaveLength(1);
  const relay = { id: f.run.relayId, targets: [{ id: f.run.targetId, enabled: true, engine: "codex", model: "fixture", concurrency: 3 }] } as never;
  expect(advertisedSlots(relay)).toEqual([{ target_id: f.run.targetId, free: 2 }]);
  try {
    // Both processes reopen the persisted registry and ledger. No relay is
    // paired in this state, so sweeping cannot send a service completion.
    for (let restart = 0; restart < 2; restart++) {
      const child = Bun.spawn([process.execPath, "-e", `
        import { spyOn } from "bun:test";
        import * as registryModule from "./src/lib/agent/registry";
        import { sweepExternalRelayOrphans } from "./src/lib/externalRelay/poller";
        import { readRunLedger } from "./src/lib/externalRelay/store";
        const registry = new registryModule.AgentRegistry(process.env.OWNER_STOP_REGISTRY, undefined, undefined, { sqliteMode: process.env.OWNER_STOP_SQLITE });
        spyOn(registryModule, "agentRegistry").mockReturnValue(registry);
        await sweepExternalRelayOrphans();
        console.log(JSON.stringify({ remaining: readRunLedger().runs.length }));
        registry.close();
      `], { cwd: process.cwd(), env: { ...process.env, OWNER_STOP_REGISTRY: f.registry.filename, OWNER_STOP_SQLITE: mode }, stdout: "pipe", stderr: "pipe" });
      const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ code, error }).toEqual({ code: 0, error: "" });
      expect(JSON.parse(output)).toEqual({ remaining: 0 });
    }
    expect(advertisedSlots(relay)).toEqual([{ target_id: f.run.targetId, free: 3 }]);
    expect(readConversations()).toEqual([]);
    await sweepExternalRelayOrphans({ launch: async () => { throw Error("unexpected launch"); },
      observe: async () => { throw Error("unexpected observation"); }, stop: async () => { throw Error("unexpected stop"); } });
  } finally {
    if (previousChains) fs.writeFileSync(chainFile, previousChains); else fs.rmSync(chainFile, { force: true });
    f.close();
  }
});

test("completed cleanup stays with a live foreign owner until that process exits", async () => {
  const f = fixture();
  const child = Bun.spawn([process.execPath, "-e", 'console.log("ready"); await Bun.stdin.text();'],
    { env: { ...process.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  try {
    expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe("ready");
    const identity = procBackend.processIdentity(child.pid);
    expect(identity).not.toBeNull();
    reserveRun({ ...f.run, ownerPid: child.pid, ownerIdentity: identity, capacityReleased: true,
      ownerTurn: { ...f.run.ownerTurn!, confirmed: true } }, 3);
    await sweepExternalRelayOrphans();
    expect(readRunLedger().runs.some(row => row.requestId === f.run.requestId)).toBe(true);
    child.stdin.end(); await child.exited;
    await sweepExternalRelayOrphans();
    expect(readRunLedger().runs.some(row => row.requestId === f.run.requestId)).toBe(false);
  } finally {
    if (child.exitCode === null) child.stdin.end();
    await child.exited; reader.releaseLock(); f.close();
  }
});
