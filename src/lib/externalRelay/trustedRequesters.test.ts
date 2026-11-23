import { afterEach, expect, mock, spyOn, test } from "bun:test";
import dns from "node:dns/promises";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { NextRequest } from "next/server";
import { accountManager } from "@/lib/accounts/manager";
import * as actions from "@/lib/conversation/actions";
import * as ephemeral from "@/lib/agent/ephemeral";
import { agentRegistry } from "@/lib/agent/registry";
import { ensureOperatorSpawnCapability } from "@/lib/agent/operatorCapability";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { executeSpawnRequest, productionSpawnCommandDependencies } from "@/lib/agent/spawnCommand";
import { reportSpawnHeaders } from "@/lib/telegram/reportSpawn";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { runAsMcpHttpCaller } from "@/lib/mcp/callerContext";
import { McpTaskExecutor } from "@/lib/mcp/taskExecutor";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } from "@/lib/orchestrator/seats";
import { procBackend } from "@/lib/proc";
import { MEMBER_COOKIE, mintSession } from "@/lib/team/sessions";
import { DELETE as unlinkTelegram } from "@/app/api/team/telegram/route";
import { resetTeamStoreForTests, teamStore, teamStoreFile } from "@/lib/team/store";
import { loadTasks } from "@/lib/tasks/store";
import { withTaskDue } from "@/lib/tasks/taskDue.fixture";
import { partById } from "@/lib/transfer/sections";
import { SourceSnapshot } from "@/lib/transfer/stores";
import * as client from "./client";
import * as cloud from "./cloud";
import * as ownerRun from "./ownerRun";
import { relayAnswerOp } from "./ownerAnswer";
import { readAnswerRecord } from "./answers";
import { endRequesterLease, openRequesterLease, requesterLeaseActive, requesterLeaseWriter } from "./requesterLease";
import { ownerRelayAuthorized, ownerRelayAuthorizedAsync, ownerRelayHandoff, ownerRelayOperationAuthorized, ownerRelaySpawnAuthorized, ownerRelayTargetMatches } from "./ownerAuthority";
import { openOwnerServiceTools, relayServiceToolsOp } from "./ownerServiceTools";
import { refreshRelayTargets } from "./poller";
import { selectOwnerDestination } from "./ownerDestination";
import { conversationAuthority, releaseConversation, reserveChainConversation } from "./conversations";
import { requestSchema } from "./protocol";
import { elevatedRequesterFor } from "./profile";
import { contextRequest } from "./request.fixture";
import { richRequest } from "./rich.fixture";
import { runClaimedRequest } from "./runner";
import { ownerRunRoot } from "./runDirectory";
import { setRelaySwitch } from "./switches";
import * as relayStore from "./store";
import { addPairedOwnerRequester, addTrustedRequester, removeTrustedRequester, trustedRequesterAuditFile } from "./trustedRequesterStore";
import { changeRun, dropRun, externalRelayFile, readRunLedger, readRelayStore, reserveRun, updateRelayStore, updateRelayStoreAsync, type PairedRelay, type RelayTargetSettings, type RunRecord } from "./store";
import { startTestRelay } from "./testRelay";
import { x1Results } from "./toolLoop.fixture";

const addedAt = "2026-09-28T12:00:00Z";
const project = `dir-${"1".repeat(32)}`;
const otherProject = `dir-${"2".repeat(32)}`;
const entry = { id: "grant-one", kind: "requester" as const, key: "u1", project, source: "board" as const, label: "Trusted person", addedAt };
const target: RelayTargetSettings = { id: "target_1", name: "Target", answered_by: "install", fallback: "none",
  enabled: true, engine: "codex", model: "auto", effort: null, project, concurrency: 1, hardCapMinutes: 1 };
const paired = (targets: RelayTargetSettings[], id = "relay_a", ownerId = "101"): PairedRelay => ({
  id, name: "Relay", origin: "http://127.0.0.1:1", api_base: "http://127.0.0.1:1/v1", credential: "transport-credential-placeholder",
  description: "", owner: { namespace: "telegram", id: ownerId, display_name: "Pairing owner", handle: null },
  pairedAt: addedAt, paused: false, limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 }, targets,
});
const granted = { ...target, requesters: { revision: 1, entries: [entry] } };
const setRelays = (...relays: PairedRelay[]) => updateRelayStore(store => ({ ...store, relays }));
const request = (id: string, targetId = target.id) => {
  const parsed = requestSchema.parse({ ...contextRequest, request_id: id, target_id: targetId,
    input: { ...contextRequest.input, tools: [], requester: { ...contextRequest.input.requester, is_admin: false } },
  });
  return { ...parsed, deadline_at: new Date(Date.now() + 20_000).toISOString(),
    input: { ...parsed.input, requester: parsed.input.requester! } };
};
const snapshot = { id: entry.id, kind: entry.kind, tier: "requester" as const, project, label: entry.label };
const leaseFixture = (run: RunRecord) => ({ ...run, stallMs: 45_000, deadlineAt: run.ownerTurn!.leaseDeadlineAt! });
const link = { userId: "101", username: null, firstName: null, linkedAt: addedAt };
const ownerMember = () => {
  const store = teamStore();
  store.insertMember({ id: "member-owner", name: "Owner", role: "owner", status: "active", color: "coral",
    telegram: link, createdAt: addedAt, createdBy: "fixture", revokedAt: null });
  return store;
};
const ownerRequest = () => {
  const raw = request("paired_owner");
  raw.input.requester.is_owner = true;
  return requestSchema.parse(raw);
};

afterEach(() => {
  resetTeamStoreForTests();
  for (const file of [teamStoreFile(), teamStoreFile() + "-wal", teamStoreFile() + "-shm"]) fs.rmSync(file, { force: true });
});

test("only the bound key on its target launches a local elevated run", async () => {
  const longTargetName = "Long target name ".repeat(8).trim().slice(0, 120);
  const relay = paired([{ ...granted, name: longTargetName, engine: "codex-cloud", cloudEnvironmentId: "configured", model: cloud.CLOUD_MODEL },
    { ...target, id: "target_2" }]);
  setRelays(relay);
  const picked = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: {
    engine: "codex", accountId: "fixture", kind: "managed", home: process.env.HOME!, transcriptRoot: process.env.HOME!, env: { NODE_ENV: "test" } } });
  const wire = spyOn(client, "relayCall").mockResolvedValue({ status: 200, body: { status: "ok" } } as never);
  const environment = spyOn(cloud, "cloudEnvironment").mockReturnValue("configured");
  const cloudRun = spyOn(cloud, "runCloudRelay").mockImplementation(() => { throw new Error("unexpected Cloud launch"); });
  const restricted = spyOn(ephemeral, "runEphemeralAgent").mockResolvedValue({ pid: null, identity: null, cancel() {},
    done: Promise.resolve({ status: "failed", answer: null, code: 1, signal: null, durationMs: 0 }) });
  const launch = async (body: Record<string, unknown>) => {
    launches.push(body);
    expect(readRunLedger().runs.find(run => run.requestId === "trusted")?.ownerTurn?.entry).toEqual(snapshot);
    const home = process.env.HOME!;
    const account = { engine: "codex" as const, accountId: "fixture", kind: "managed" as const, home, transcriptRoot: home,
      env: { NODE_ENV: "test" as const } };
    const response = await executeSpawnRequest(new NextRequest("http://127.0.0.1:1/api/spawn", {
      method: "POST", headers: reportSpawnHeaders(ensureOperatorSpawnCapability(), VIEWER_SPAWN_CAPABILITY_HEADER),
      body: JSON.stringify(body),
    }), { ...productionSpawnCommandDependencies, autonomousStructured: true, assertStructuredRuntime() {},
      resolveHealthySpawnAccount: async () => account,
      resolveSpawnAccount: () => account,
      runtimeHostClient: () => ({} as RuntimeHostClient),
      preflightProtocol: async () => {},
      resolvePinnedSpawnAdmission: async () => ({ kind: "admissible", basis: "current", stale: false, retryAt: null }),
      defer() {},
    });
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(202);
    expect(agentRegistry().spawnReceiptForClientAttempt(String(body.clientAttemptId))?.launchProfile.title)
      .toMatch(/^Relay · Long target name .+ · Trusted person$/);
    return { status: response.status, body: { ...result, initialMessage: "delivered" } };
  };
  const launches: Record<string, unknown>[] = [];
  const ports = { launch, observe: async (turn: { conversationId?: string | null }) => {
    expect(await relayAnswerOp(turn.conversationId!, { text: "Done", format: "plain", reply_to: "other_message" })).not.toBeNull();
    return { state: "ended" as const, finalText: "Done" };
  }, stop: async () => {} };
  const previousSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
  process.env.LLV_RUNTIME_HOST_SOCKET = `${process.env.TMPDIR}/unused-fixture.sock`;
  try {
    const raw = request("trusted");
    const rich = richRequest();
    raw.features = rich.features;
    raw.input.format = rich.input.format;
    raw.input.conversation.push({ ...raw.input.conversation[0]!, id: "other_message", author: { key: "u2", name: "Other", self: false } });
    expect(await runClaimedRequest(relay, raw, undefined, { leaseWorker: false, ownerPorts: ports }))
      .toMatchObject({ outcome: "answered", answer: { text: "Done", reply_to: "m1" } });
    expect(readAnswerRecord(relay.id, target.id, "trusted")).toMatchObject({ engine: "codex", outcome: "answered" });
    expect(launches[0]?.prompt).toContain("Trusted person");
    expect(JSON.stringify(launches[0])).not.toContain(relay.credential);
    expect(cloudRun).not.toHaveBeenCalled();
    const other = request("other_target", "target_2");
    const anonymous = request("anonymous");
    anonymous.input.requester.is_anonymous_admin = true;
    const display = request("display");
    display.input.requester.key = "u2";
    display.input.conversation[0]!.author = { key: "u2", name: entry.label, self: false };
    // Restricted runs use a local engine in these negative cases.
    const local = { ...relay, targets: relay.targets.map(item => ({ ...item, engine: "codex" as const })) };
    setRelays(local);
    for (const raw of [other, anonymous, display]) {
      const before = restricted.mock.calls.length;
      await runClaimedRequest(local, raw, undefined, { leaseWorker: false, ownerPorts: ports });
      expect(restricted.mock.calls).toHaveLength(before + 1);
    }
    for (const self of [false, true]) {
      const raw = request(self ? "clone_trigger" : "mismatched_author");
      const malformed = { ...raw, input: { ...raw.input, conversation: [
        { ...raw.input.conversation[0]!, author: { key: self ? "u1" : "u2", name: "Sender", self } },
      ] } };
      const before = restricted.mock.calls.length;
      expect(await runClaimedRequest(local, malformed, undefined, { leaseWorker: false, ownerPorts: ports }))
        .toMatchObject({ outcome: "declined", reason: "invalid_request" });
      expect(restricted.mock.calls).toHaveLength(before);
    }
    expect(launches).toHaveLength(1);
    expect(wire.mock.calls.some(([, url]) => url.endsWith("/send"))).toBe(false);
  } finally {
    if (previousSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
    else process.env.LLV_RUNTIME_HOST_SOCKET = previousSocket;
    dropRun("trusted");
    picked.mockRestore(); wire.mockRestore(); restricted.mockRestore(); environment.mockRestore(); cloudRun.mockRestore();
  }
});

test("unavailable elevated-run storage still permits an unlisted requester's restricted answer", async () => {
  const relay = paired([granted]);
  setRelays(relay);
  const raw = request("restricted_without_elevated_storage");
  raw.input.requester.key = "u2";
  raw.input.conversation[0]!.author.key = "u2";
  const mkdir = fs.promises.mkdir;
  const storage = spyOn(fs.promises, "mkdir").mockImplementation((async (...args: Parameters<typeof mkdir>) => {
    if (args[0] === ownerRunRoot()) throw new Error("elevated-run storage unavailable");
    return mkdir(...args);
  }) as typeof mkdir);
  const select = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: {
    engine: "codex", accountId: "fixture", kind: "managed", home: process.env.HOME!, transcriptRoot: process.env.HOME!, env: { NODE_ENV: "test" } } });
  const wire = spyOn(client, "relayCall").mockResolvedValue({ status: 200, body: { status: "ok" } } as never);
  const restricted = spyOn(ephemeral, "runEphemeralAgent").mockResolvedValue({ pid: null, identity: null, cancel() {},
    done: Promise.resolve({ status: "done", answer: { action: "reply", text: "Restricted reply", reply_to: "m1" },
      code: 0, signal: null, durationMs: 0 }) });
  const launch = mock(async () => { throw new Error("unexpected elevated launch"); });
  try {
    expect(await runClaimedRequest(relay, raw, undefined, { leaseWorker: false, ownerPorts: {
      launch, observe: async () => ({ state: "failed" }), stop: async () => {},
    } })).toMatchObject({ outcome: "answered", answer: { text: "Restricted reply" } });
    expect(restricted).toHaveBeenCalledTimes(1);
    expect(restricted.mock.calls[0]?.[0].webSearch).toBe(true);
    expect(launch).not.toHaveBeenCalled();
    expect(storage.mock.calls.some(([directory]) => directory === ownerRunRoot())).toBe(false);
  } finally {
    storage.mockRestore(); select.mockRestore(); wire.mockRestore(); restricted.mockRestore();
  }
});

test("requester admission waits for a successful heartbeat and loses custody on a service refusal", async () => {
  const waitingForAck = Promise.withResolvers<void>();
  const acknowledge = Promise.withResolvers<void>();
  const loseLease = Promise.withResolvers<void>();
  const observing = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const completions: unknown[] = [];
  const reply = { body: { status: "ok" } };
  let heartbeats = 0;
  const service = await startTestRelay(async (req, body) => {
    if (req.url?.endsWith("/complete")) completions.push(body);
    if (!req.url?.endsWith("/heartbeat")) return reply;
    if (++heartbeats === 1) return { status: 503, body: { error: { code: "unavailable" } } };
    if (heartbeats === 2) { waitingForAck.resolve(); await acknowledge.promise; return reply; }
    await loseLease.promise;
    return { status: 409, body: { error: { code: "lease_lost" } } };
  });
  const relay = { ...paired([granted]), origin: service.origin, api_base: `${service.origin}/v1` };
  setRelays(relay);
  const raw = request("heartbeat_authority");
  raw.liveness = { ...raw.liveness, heartbeat_interval_s: 2 };
  const conversation = "conversation_heartbeat_authority";
  const select = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: {
    engine: "codex", accountId: "fixture", kind: "managed", home: process.env.HOME!, transcriptRoot: process.env.HOME!, env: { NODE_ENV: "test" } } });
  const launch = mock(async () => ({ status: 202, body: { conversationId: conversation, initialMessage: "delivered" } }));
  const pending = runClaimedRequest(relay, raw, undefined, { ownerPorts: {
    launch,
    observe: async () => { observing.resolve(); await finish.promise; return { state: "ended", finalText: "Suppressed" }; },
    stop: async () => { stopped.resolve(); },
  } });
  const earlyExit = pending.then(() => { throw new Error("request settled before its expected checkpoint"); });
  try {
    await Promise.race([waitingForAck.promise, earlyExit]);
    expect(select).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(readRunLedger().runs.find(row => row.requestId === raw.request_id)).toBeUndefined();
    expect(ownerRelayHandoff("context", conversation)).toEqual({ payload: null, requester: false });
    expect(completions).toEqual([]);

    acknowledge.resolve();
    await Promise.race([observing.promise, earlyExit]);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(ownerRelayAuthorized(relay.id, target.id, raw.request_id)).toBe(true);
    expect(await ownerRelayAuthorizedAsync(relay.id, target.id, raw.request_id)).toBe(true);
    expect(ownerRelayHandoff("context", conversation).payload?.requesterRequestId).toBe(raw.request_id);

    loseLease.resolve();
    await Promise.race([stopped.promise, earlyExit]);
    expect(ownerRelayAuthorized(relay.id, target.id, raw.request_id)).toBe(false);
    expect(await ownerRelayAuthorizedAsync(relay.id, target.id, raw.request_id)).toBe(false);
    expect(ownerRelayHandoff("context", conversation).payload).toBeNull();
    finish.resolve();
    expect(await pending).toBeNull();
    expect(completions).toEqual([]);
  } finally {
    acknowledge.resolve(); loseLease.resolve(); finish.resolve();
    await Promise.allSettled([pending, earlyExit]);
    select.mockRestore();
    await service.close();
  }
}, 15_000);

test("a heartbeat response arriving after the acknowledgement window cannot start a requester", async () => {
  const initialWaitEnded = Promise.withResolvers<void>();
  const heartbeatPending = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const completions: unknown[] = [];
  const service = await startTestRelay(async (req, body) => {
    if (req.url?.endsWith("/complete")) completions.push(body);
    if (req.url?.endsWith("/heartbeat")) { heartbeatPending.resolve(); await release.promise; }
    return { body: { status: "ok" } };
  });
  const relay = { ...paired([granted]), origin: service.origin, api_base: `${service.origin}/v1` };
  setRelays(relay);
  const raw = request("heartbeat_timeout");
  raw.liveness = { ...raw.liveness, ack_window_s: 1, stall_window_s: 1 };
  const select = spyOn(accountManager, "resolveHeadlessSpawn");
  const launch = mock(async () => { throw new Error("unexpected launch"); });
  const pending = runClaimedRequest(relay, raw, undefined, { onLeaseReady: initialWaitEnded.resolve, ownerPorts: {
    launch, observe: async () => ({ state: "failed" }), stop: async () => {},
  } });
  const earlyExit = pending.then(() => { throw new Error("request settled before its expected checkpoint"); });
  try {
    await Promise.race([heartbeatPending.promise, earlyExit]);
    await Promise.race([initialWaitEnded.promise, earlyExit]);
    release.resolve();
    expect(await pending).toBeNull();
    expect(select).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(completions).toEqual([]);
    expect(readRunLedger().runs.find(row => row.requestId === raw.request_id)).toBeUndefined();
  } finally {
    release.resolve();
    await Promise.allSettled([pending, earlyExit]);
    select.mockRestore();
    await service.close();
  }
}, 10_000);

test("elapsed request time cannot establish, extend or transfer requester lease custody", async () => {
  const relay = paired([granted]);
  setRelays(relay);
  const now = Date.parse(addedAt);
  const run: RunRecord = { requestId: "lease_binding", leaseId: "lease-one", relayId: relay.id, targetId: target.id,
    ownerPid: process.pid, ownerIdentity: procBackend.processIdentity(process.pid), childPid: null, childIdentity: null,
    runDir: await fs.promises.mkdtemp(`${process.env.TMPDIR}/requester-binding-`), startedAt: addedAt, conversationId: "conversation_lease_binding",
    ownerTurn: { clientAttemptId: "relay-owner-lease-binding", entry: snapshot, leaseDeadlineAt: now + 60_000 } };
  const lease = { ...leaseFixture(run), stallMs: 5000 };
  const clock = spyOn(Date, "now").mockReturnValue(now);
  reserveRun(run);
  try {
    await openRequesterLease(lease);
    const writer = requesterLeaseWriter(lease);
    const authorized = () => ownerRelayAuthorized(relay.id, target.id, run.requestId);
    expect(authorized()).toBe(false);
    writer.acknowledge(now);
    expect(authorized()).toBe(true);
    clock.mockReturnValue(now + 4000);
    writer.acknowledge(now + 3500);
    changeRun(run.requestId, row => ({ ...row, leaseId: "lease-two" }));
    expect(authorized()).toBe(false);
    changeRun(run.requestId, row => ({ ...row, leaseId: run.leaseId }));
    clock.mockReturnValue(now + 5000);
    expect(authorized()).toBe(true);
    clock.mockReturnValue(now + 8500);
    expect(authorized()).toBe(false);
    writer.acknowledge(now + 8500);
    expect(authorized()).toBe(false);
    expect(await ownerRelayAuthorizedAsync(relay.id, target.id, run.requestId)).toBe(false);
    expect(ownerRelayHandoff("context", run.conversationId!)).toEqual({ payload: null, requester: true });
  } finally {
    clock.mockRestore();
    endRequesterLease(lease);
    dropRun(run.requestId);
    await fs.promises.rm(run.runDir, { recursive: true, force: true });
  }
});

test("fresh authority rejects a suspended or removed entry at every durable boundary", async () => {
  const relay = paired([granted]);
  setRelays(relay);
  const id = "leased_request";
  const attempt = "relay-owner-leased_request";
  const conversation = "conversation_granted";
  const operation = "relay-owner-continuation";
  const run = { requestId: id, leaseId: "lease", relayId: relay.id, targetId: target.id, ownerPid: process.pid,
    ownerIdentity: procBackend.processIdentity(process.pid), childPid: null, childIdentity: null, runDir: await fs.promises.mkdtemp(`${process.env.TMPDIR}/requester-auth-`),
    startedAt: addedAt, conversationId: conversation, ownerTurn: { clientAttemptId: attempt, entry: snapshot, leaseDeadlineAt: Date.now() + 60_000,
      request: { text: "Work", requestText: null } } };
  reserveRun(run, 1);
  try {
    const lease = leaseFixture(run);
    await openRequesterLease(lease);
    requesterLeaseWriter(lease).acknowledge(Date.now());
    expect(conversationAuthority(request("conversation").input.requester, snapshot)).toBe("trusted:grant-one");
    expect(ownerRelayTargetMatches(conversation, project, null)).toBe(true);
    expect(ownerRelayTargetMatches(conversation, otherProject, null)).toBe(false);
    expect(ownerRelayHandoff("context", conversation).payload?.text).toContain("Trusted person");
    const check = async (allowed: boolean) => {
      expect(ownerRelayAuthorized(relay.id, target.id, id)).toBe(allowed);
      expect(await ownerRelayAuthorizedAsync(relay.id, target.id, id)).toBe(allowed);
      expect(ownerRelaySpawnAuthorized(attempt)).toBe(allowed);
    };
    await check(true);
    changeRun(id, row => ({ ...row, ownerTurn: { ...row.ownerTurn!, leaseDeadlineAt: Date.now() - 1 } }));
    await check(false);
    changeRun(id, row => ({ ...row, ownerTurn: { ...row.ownerTurn!, leaseDeadlineAt: run.ownerTurn.leaseDeadlineAt } }));
    setRelays(paired([{ ...granted, project: otherProject }]));
    await check(false);
    setRelays(paired([{ ...granted, requesters: { revision: 2, entries: [entry, { ...entry, id: "other", key: "u2", label: "Other" }] } }]));
    await check(true);
    dropRun(id);
    reserveRun({ ...run, ownerTurn: { ...run.ownerTurn, continuation: { operationId: operation } } }, 1);
    expect(ownerRelayOperationAuthorized(operation, conversation)).toBe(true);
    setRelays(paired([{ ...target, requesters: { revision: 3, entries: [{ ...entry, id: "new-id" }] } }]));
    await check(false);
    expect(ownerRelayOperationAuthorized(operation, conversation)).toBe(false);
    expect(ownerRelayHandoff("context", conversation)).toEqual({ payload: null, requester: true });
  } finally { dropRun(id); await fs.promises.rm(run.runDir, { recursive: true, force: true }); }
});

test.each(["configured", "no environment", "oversized context", "owner"] as const)("Cloud admission before either execution path (%s)", async scenario => {
  const cloudTarget = { ...target, ownerTier: true, engine: "codex-cloud" as const, cloudEnvironmentId: "configured", model: cloud.CLOUD_MODEL };
  const a = paired([cloudTarget]);
  const b = paired([cloudTarget], "relay_b", "202");
  const relay = scenario === "owner" ? a : b;
  setRelays(a, b);
  ownerMember();
  const raw = { ...ownerRequest(), request_id: `cloud_${scenario.replaceAll(" ", "_")}`,
    owner_delivery: { chat_id: Number(relay.owner.id), reply_to_message_id: 1, message_thread_id: null } };
  if (scenario === "oversized context") {
    raw.input.instructions = "🧪".repeat(10_000);
    const elevation = elevatedRequesterFor(relay, cloudTarget, raw, [a, b])!;
    expect(ownerRun.prepareOwnerPrompt(raw, elevation.instruction, 1).context).toContain(raw.input.instructions);
  }
  const posts: string[] = [];
  const wire = spyOn(client, "relayCall").mockImplementation(async (_base, route) => {
    posts.push(route);
    return { status: 200, body: { status: "ok" } } as never;
  });
  const environment = spyOn(cloud, "cloudEnvironment").mockReturnValue(scenario === "no environment" ? null : "configured");
  const directory = spyOn(ownerRun, "cloudOwnerDirectory").mockReturnValue(process.env.TMPDIR!);
  const account = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: {
    engine: "codex", accountId: "fixture", kind: "managed", home: process.env.HOME!, transcriptRoot: process.env.HOME!, env: { NODE_ENV: "test" } } });
  const cloudRun = spyOn(cloud, "runCloudRelay");
  const transport = mock(async (_input: cloud.CloudRequest) => "Cloud answer");
  const localLaunch = mock(async () => ({ status: 202, body: { conversationId: "conversation_cloud_fallback", initialMessage: "delivered" } }));
  try {
    const result = await runClaimedRequest(relay, raw, undefined, {
      leaseWorker: false, cloudTransport: transport, ownerPorts: { launch: localLaunch, observe: async () => ({ state: "ended", finalText: "Native answer" }), stop: async () => {} },
    });
    if (scenario === "owner") {
      expect(result).toMatchObject({ outcome: "answered", answer: { text: "Cloud answer" } });
      expect(cloudRun).toHaveBeenCalledTimes(1);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(transport.mock.calls[0]?.[0]).toMatchObject({ fullAccess: true, environmentId: "configured" });
    } else {
      expect(result).toMatchObject({ outcome: "failed", reason: "configuration_error" });
      expect(cloudRun).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
      expect(environment).not.toHaveBeenCalled();
      expect(directory).not.toHaveBeenCalled();
    }
    expect(localLaunch).not.toHaveBeenCalled();
    expect(account).not.toHaveBeenCalled();
    expect(posts.some(route => route.endsWith("/send"))).toBe(false);
    expect(readRunLedger().runs.find(run => run.requestId === raw.request_id)).toBeUndefined();
  } finally { cloudRun.mockRestore(); environment.mockRestore(); directory.mockRestore(); account.mockRestore(); wire.mockRestore(); }
});

function cloudProviderWithoutTerminalReply() {
  const original = process.env.LLV_CODEX_CLOUD_URL;
  process.env.LLV_CODEX_CLOUD_URL = "wss://example.invalid/app-server";
  const socket = new EventEmitter();
  const turnStarted = Promise.withResolvers<void>();
  const methods: string[] = [];
  const transport = cloud.createCloudTransport(() => {
    queueMicrotask(() => socket.emit("open"));
    return { on: socket.on.bind(socket), close() {}, send(data) {
      const { method, id } = JSON.parse(data);
      methods.push(method);
      if (id === undefined) return;
      queueMicrotask(() => {
        const result = method === "thread/start" ? { thread: { id: "thread", environments: [
          { environmentConfigId: "configured", environmentId: "ccarenv_fixture", cwd: "/workspace/fixture" },
        ] } } : method === "turn/start" ? { turn: { id: "turn" } } : {};
        socket.emit("message", JSON.stringify({ id, result }));
        if (method === "turn/start") {
          socket.emit("message", JSON.stringify({ method: "turn/started", params: { threadId: "thread", turn: { id: "turn" } } }));
          turnStarted.resolve();
        }
        // The provider acknowledges interruption but never confirms termination.
      });
    } };
  }, async () => "/workspace/fixture");
  return { transport, turnStarted: turnStarted.promise, methods, close() {
    if (original === undefined) delete process.env.LLV_CODEX_CLOUD_URL;
    else process.env.LLV_CODEX_CLOUD_URL = original;
  } };
}

test("the Cloud transport keeps an acknowledged interrupt unconfirmed without a terminal reply", async () => {
  const provider = cloudProviderWithoutTerminalReply();
  const controller = new AbortController();
  const pending = provider.transport({ prompt: "Fixture request", model: cloud.CLOUD_MODEL,
    fullAccess: true, environmentId: "configured", timeoutMs: 5000, signal: controller.signal });
  try {
    await provider.turnStarted;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ confirmed: false });
    expect(provider.methods).toEqual(["initialize", "initialized", "thread/start", "turn/start", "turn/interrupt"]);
  } finally { controller.abort(); provider.close(); }
});

test("a legacy run retains authority across the upgrade", () => {
  const legacy = { ...target, id: "legacy", ownerTier: true };
  const relay = paired([legacy, granted]);
  setRelays(relay);
  const id = "old_request";
  reserveRun({ requestId: id, leaseId: "lease", relayId: relay.id, targetId: legacy.id, ownerPid: process.pid,
    ownerIdentity: procBackend.processIdentity(process.pid), childPid: null, childIdentity: null,
    runDir: process.env.TMPDIR!, startedAt: addedAt, ownerTurn: { clientAttemptId: "relay-owner-old_request" } }, 1);
  try { expect(ownerRelayAuthorized(relay.id, legacy.id, id)).toBe(true); }
  finally { dropRun(id); }
});

test("poller refresh persists entries only on retained targets", async () => {
  const remote = (target_id: string) => ({ target_id, name: "Refreshed", answered_by: "install", fallback: "none" });
  const service = await startTestRelay(() => ({ body: { targets: [remote(target.id), remote("new_target")] } }));
  const relay = { ...paired([granted, { ...granted, id: "dropped_target" }], "refresh_relay"),
    origin: service.origin, api_base: `${service.origin}/v1` };
  try {
    setRelays(relay);
    await refreshRelayTargets(relay.id, 0);
    const refreshed = readRelayStore().relays[0]!.targets;
    expect(refreshed.map(item => item.id)).toEqual([target.id, "new_target"]);
    expect(refreshed[0]).toMatchObject({ name: "Refreshed", requesters: granted.requesters });
    expect(refreshed[1]).not.toHaveProperty("requesters");
  } finally { await service.close(); }
});

test.each(["settled", "settles during cutoff"] as const)("target refresh leaves reply custody and a reused conversation alone (%s)", async state => {
  const remainingTarget = { ...granted, id: "remaining_target" };
  const fetch = spyOn(client, "fetchRelayTargets").mockResolvedValue([
    { target_id: remainingTarget.id, name: remainingTarget.name, answered_by: "install", fallback: "none" },
  ]);
  const stop = spyOn(actions, "applyConversationAction").mockResolvedValue({ status: 200, body: { error: "fixture" } });
  const relay = paired([granted, remainingTarget], "retained_reply_relay");
  setRelays(relay);
  const conversationId = "conversation_reused";
  const oldRun = { requestId: "settled_reply", leaseId: "old_lease", relayId: relay.id, targetId: target.id,
    ownerPid: process.pid, ownerIdentity: procBackend.processIdentity(process.pid), childPid: null, childIdentity: null,
    startedAt: addedAt, runDir: process.env.TMPDIR!, conversationId, capacityReleased: true as const,
    ownerTurn: { clientAttemptId: "relay-owner-settled_reply", admissionComplete: true, entry: snapshot,
      completionAttempt: { body: { lease_id: "old_lease", outcome: "answered" as const, duration_ms: 1,
        answer: { action: "reply" as const, text: "Older answer", reply_to: "m1" } }, files: [] } } };
  const newRun = { ...oldRun, requestId: "later_turn", leaseId: "new_lease", targetId: remainingTarget.id,
    runDir: await fs.promises.mkdtemp(`${process.env.TMPDIR}/requester-refresh-`),
    capacityReleased: undefined, ownerTurn: { clientAttemptId: "relay-owner-later_turn", entry: snapshot, leaseDeadlineAt: Date.now() + 60_000 } };
  const lease = leaseFixture(newRun);
  await openRequesterLease(lease);
  requesterLeaseWriter(lease).acknowledge(Date.now());
  const write = relayStore.changeRunAsync;
  const cutoff = spyOn(relayStore, "changeRunAsync").mockImplementation(async (id, update, until) => {
    if (id === oldRun.requestId && state === "settles during cutoff") {
      changeRun(id, () => oldRun);
      reserveRun(newRun);
    }
    return write(id, update, until);
  });
  if (state === "settled") {
    reserveRun(oldRun);
    reserveRun(newRun);
  } else {
    reserveRun({ ...oldRun, capacityReleased: undefined });
  }
  try {
    expect(await refreshRelayTargets(relay.id, 0)).toBe("changed");
    expect(cutoff).toHaveBeenCalledTimes(state === "settled" ? 0 : 1);
    expect(stop).not.toHaveBeenCalled();
    expect(readRunLedger().runs.find(row => row.requestId === oldRun.requestId)).toEqual(oldRun);
    expect(ownerRelayAuthorized(relay.id, remainingTarget.id, newRun.requestId)).toBe(true);
  } finally {
    dropRun(oldRun.requestId); dropRun(newRun.requestId); cutoff.mockRestore(); fetch.mockRestore(); stop.mockRestore();
    await fs.promises.rm(newRun.runDir, { recursive: true, force: true });
  }
});

test("a target refresh waits for an in-progress entry write without blocking the Viewer", async () => {
  const readingTargets = Promise.withResolvers<void>();
  const locked = Promise.withResolvers<void>();
  const commit = Promise.withResolvers<void>();
  const relay = paired([granted], "concurrent_refresh");
  const fetch = spyOn(client, "fetchRelayTargets").mockImplementation(async () => {
    readingTargets.resolve();
    return [{ target_id: target.id, name: "Refreshed", answered_by: "install", fallback: "none" }];
  });
  setRelays(relay);
  const writing = updateRelayStoreAsync(async store => {
    locked.resolve();
    await commit.promise;
    return { ...store, relays: [{ ...relay, targets: [{ ...granted, requesters: { revision: 2, entries: [] } }] }] };
  });
  let refreshing: ReturnType<typeof refreshRelayTargets> | undefined;
  try {
    await locked.promise;
    refreshing = refreshRelayTargets(relay.id, 0);
    await readingTargets.promise;
    const first = await Promise.race([
      refreshing,
      new Promise<"timer">(resolve => setTimeout(() => resolve("timer"), 0)),
    ]);
    expect(first).toBe("timer");
    commit.resolve();
    expect(await refreshing).toBe("changed");
    expect(readRelayStore().relays[0]!.targets[0]).toMatchObject({
      name: "Refreshed", requesters: { revision: 2, entries: [] },
    });
  } finally {
    commit.resolve();
    await Promise.allSettled([writing, refreshing]);
    fetch.mockRestore();
  }
}, 15_000);

test("an async MCP call rechecks its grant after awaiting acknowledgement", async () => {
  const relay = paired([granted]);
  setRelays(relay);
  const raw = request("async_tool");
  raw.input.tools = [{ name: "lookup_notes", summary: "Look up notes", mode: "direct", effect: "read", parameters: { type: "object" } }];
  const claim = requestSchema.parse(raw);
  const conversationId = "conversation_async_tool";
  const run = { requestId: claim.request_id, leaseId: claim.lease_id, relayId: relay.id, targetId: target.id,
    ownerPid: process.pid, ownerIdentity: procBackend.processIdentity(process.pid), childPid: null, childIdentity: null,
    runDir: await fs.promises.mkdtemp(`${process.env.TMPDIR}/requester-tool-`), startedAt: addedAt, conversationId,
    ownerTurn: { clientAttemptId: "relay-owner-async-tool", entry: snapshot, leaseDeadlineAt: Date.now() + 60_000 },
  };
  const lease = leaseFixture(run);
  await openRequesterLease(lease);
  requesterLeaseWriter(lease).acknowledge(Date.now());
  reserveRun(run, 1);
  const wire = spyOn(client, "relayCall").mockResolvedValue({ status: 200, body: { status: "ok" } } as never);
  let entered!: () => void, release!: (value: boolean) => void;
  const acknowledging = new Promise<void>(resolve => { entered = resolve; });
  const acknowledgement = new Promise<boolean>(resolve => { release = resolve; });
  const adapter = openOwnerServiceTools(relay, granted, claim, [], {
    signal: new AbortController().signal, lose() {},
    ack: () => { entered(); return acknowledgement; },
  }, {}, () => ownerRelayAuthorizedAsync(relay.id, target.id, claim.request_id));
  adapter.bindConversation(conversationId);
  const pending = relayServiceToolsOp(conversationId, { op: "call", calls: [{ tool: "lookup_notes", arguments: {} }] });
  try {
    await Promise.race([acknowledging, pending.then(() => { throw new Error("tool call did not reach acknowledgement"); })]);
    setRelays(paired([{ ...target, requesters: { revision: 2, entries: [] } }]));
    release(true);
    expect(await pending).toMatchObject({ status: "relay_tools_unavailable", results: [] });
    expect(wire).not.toHaveBeenCalled();
    expect(await relayServiceToolsOp(conversationId, { op: "list" })).toBeNull();
  } finally {
    release(false);
    await pending;
    adapter.unbindConversation(conversationId);
    await adapter.dispose();
    wire.mockRestore();
    dropRun(claim.request_id);
    await fs.promises.rm(run.runDir, { recursive: true, force: true });
  }
});

test.each(["unchanged", "grant removed", "cancelled", "cutoff changed"] as const)(
  "service tool dispatch rechecks authority after reading the lease receipt (%s)", async change => {
    const claim = request("final_tool_check");
    claim.input.tools = [{ name: "lookup_notes", summary: "Look up notes", mode: "direct", effect: "read", parameters: { type: "object" } }];
    const requests: unknown[] = [];
    const service = await startTestRelay((req, body) => {
      if (!req.url?.endsWith("/tool-calls")) return { status: 404 };
      requests.push(body);
      return { body: { ...x1Results.ok, ...(body as object) } };
    });
    const relay = { ...paired([granted]), api_base: service.origin.replace("127.0.0.1", "relay-fixture.invalid") + "/v1" };
    setRelays(relay);
    const conversationId = "conversation_final_tool_check";
    const run = { requestId: claim.request_id, leaseId: claim.lease_id, relayId: relay.id, targetId: target.id,
      ownerPid: process.pid, ownerIdentity: procBackend.processIdentity(process.pid), childPid: null, childIdentity: null,
      runDir: await fs.promises.mkdtemp(`${process.env.TMPDIR}/requester-final-tool-`), startedAt: addedAt, conversationId,
      ownerTurn: { clientAttemptId: "relay-owner-final-tool-check", entry: snapshot, leaseDeadlineAt: Date.now() + 60_000 },
    };
    const lease = leaseFixture(run);
    await openRequesterLease(lease);
    requesterLeaseWriter(lease).acknowledge(Date.now());
    reserveRun(run, 1);
    let resolvedDestination = false;
    let heldReceipt = false;
    const paused = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const lookup = spyOn(dns, "lookup").mockImplementation((async () => {
      resolvedDestination = true;
      return [{ address: "127.0.0.1", family: 4 }];
    }) as unknown as typeof dns.lookup);
    const readFile = fs.promises.readFile;
    const reader = spyOn(fs.promises, "readFile").mockImplementation((async (...args: Parameters<typeof readFile>) => {
      const content = await readFile(...args);
      if (resolvedDestination && !heldReceipt && String(args[0]) === `${run.runDir}/requester-lease/receipt.json`) {
        heldReceipt = true;
        paused.resolve();
        await resume.promise;
      }
      return content;
    }) as typeof readFile);
    const adapter = openOwnerServiceTools(relay, granted, claim, [], {
      signal: new AbortController().signal, lose() {}, ack: async () => true,
    }, {}, () => ownerRelayAuthorizedAsync(relay.id, target.id, claim.request_id));
    adapter.bindConversation(conversationId);
    const pending = relayServiceToolsOp(conversationId, { op: "call", calls: [{ tool: "lookup_notes", arguments: {} }] });
    try {
      await Promise.race([paused.promise, pending.then(() => { throw new Error("tool call did not reach its final lease check"); })]);
      expect(requests).toHaveLength(0);
      if (change === "grant removed") setRelays({ ...relay, targets: [{ ...target, requesters: { revision: 2, entries: [] } }] });
      if (change === "cancelled" || change === "cutoff changed") changeRun(run.requestId, row => ({
        ...row, ownerTurn: { ...row.ownerTurn!, ...(change === "cancelled" ? { cancel: "interrupt" as const } : { leaseDeadlineAt: 0 }) },
      }));
      expect(requesterLeaseActive(lease)).toBe(true);
      resume.resolve();
      const result = await pending;
      if (change === "unchanged") {
        expect(requests).toHaveLength(1);
        expect(result).toMatchObject({ status: "completed", results: [{ status: "ok" }] });
      } else {
        expect(requests).toHaveLength(0);
        expect(result).toMatchObject({ status: "relay_tools_unavailable", results: [] });
      }
    } finally {
      resume.resolve();
      await Promise.allSettled([pending]);
      await adapter.dispose();
      reader.mockRestore();
      lookup.mockRestore();
      dropRun(claim.request_id);
      await fs.promises.rm(run.runDir, { recursive: true, force: true });
      await service.close();
    }
  },
);

test("separate pairing owners and an unreadable team store cannot use the install-owner tier", async () => {
  const a = paired([{ ...target, ownerTier: true }]);
  const b = paired([{ ...target, ownerTier: true }], "relay_b", "202");
  setRelays(b, a);
  const store = ownerMember();
  const claim = ownerRequest();
  expect(elevatedRequesterFor(a, a.targets[0]!, claim, [b, a])?.entry.tier).toBe("owner");
  expect(elevatedRequesterFor(b, b.targets[0]!, claim, [b, a])?.entry.tier).toBe("requester");
  expect(selectOwnerDestination([b, a], a.origin)).toMatchObject({ chatId: "101" });
  store.updateMember({ ...store.owner()!, telegram: null });
  expect(elevatedRequesterFor(a, a.targets[0]!, claim, [b, a])?.entry.tier).toBe("requester");
  resetTeamStoreForTests();
  fs.writeFileSync(teamStoreFile(), "unreadable team database");
  expect(elevatedRequesterFor(a, a.targets[0]!, claim, [a])?.entry.tier).toBe("requester");
  expect(fs.existsSync(externalRelayFile("relays"))).toBe(true);
});

test("the same MCP executor loses owner relay treatment after an independent team write", async () => {
  const store = ownerMember();
  const seatKey = "executor-fixture-seat";
  beginOrchestratorSeatIntent({ project, mandate: "Own this board", clientRequestId: seatKey, mode: "spawn", promptVersion: null });
  expect(completeOrchestratorSeatIntent({ project, clientRequestId: seatKey,
    conversationId: "conversation_executor_fixture_seat", path: null }).kind).toBe("activated");
  const relay = paired([{ ...target, ownerTier: true }]);
  setRelays(relay);
  const registry = agentRegistry();
  const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd: process.env.TMPDIR!, role: "builder", origin: { kind: "operator" } });
  if (begun.kind !== "created") throw new Error("fixture admission failed");
  const capability = registry.rotateSpawnCapabilityForReceipt(begun.receipt.launchId);
  const conversationId = begun.receipt.conversationId;
  const requestId = "executor_authority";
  reserveRun({ requestId, leaseId: "lease", relayId: relay.id, targetId: target.id, ownerPid: process.pid,
    ownerIdentity: procBackend.processIdentity(process.pid), childPid: null, childIdentity: null,
    runDir: process.env.TMPDIR!, startedAt: addedAt, conversationId,
    ownerTurn: { clientAttemptId: "relay-owner-executor", entry: { id: "earlier-switch-target_1", kind: "paired-owner", tier: "owner", project, label: "Paired owner" } } }, 1);
  const executor = new McpTaskExecutor();
  try {
    const create = async (name: string) => {
      const result = await runAsMcpHttpCaller({ capability }, () => executor.callTool("create_task",
        withTaskDue({ text: name, project, clientRequestId: name.toLowerCase().replaceAll(" ", "-") })));
      if (!result.ok) throw new Error(`Task executor refused: ${JSON.stringify(result)}`);
      return loadTasks().find(task => task.id === result.taskId);
    };
    expect((await create("Before owner relink"))?.status).toBe("assigned");
    store.updateMember({ ...store.owner()!, telegram: { ...link, userId: "303" } });
    expect((await create("After owner relink"))?.status).toBe("inbox");
  } finally { await executor.close(); dropRun(requestId); }
});

test("first entry write preserves the legacy grant and audits it once", async () => {
  const { elevatedRequesterFor } = await import("./profile");
  const relay = paired([{ ...target, ownerTier: true }]);
  setRelays(relay);
  const claim = ownerRequest();
  expect(elevatedRequesterFor(relay, relay.targets[0]!, claim, [relay])?.entry.id).toBe("earlier-switch-target_1");
  expect(elevatedRequesterFor(relay, relay.targets[0]!, request("before_unlisted"), [relay])).toBeNull();
  const actor = { surface: "board" as const, approvedBy: "operator" };
  const auditFile = trustedRequesterAuditFile();
  fs.mkdirSync(auditFile);
  try {
    await expect(addTrustedRequester(relay.id, target.id, 0, { key: "u2", label: "Second person" }, actor)).rejects.toBeTruthy();
    expect(readRelayStore().relays[0]?.targets[0]).toMatchObject({ ownerTier: true });
    expect(readRelayStore().relays[0]?.targets[0]).not.toHaveProperty("requesters");
  } finally { fs.rmdirSync(auditFile); }
  await addTrustedRequester(relay.id, target.id, 0, { key: "u2", label: "Second person" }, actor);
  const [current] = readRelayStore().relays;
  const [updated] = current!.targets;
  expect(updated).not.toHaveProperty("ownerTier");
  expect(updated?.requesters?.entries[0]).toMatchObject({ id: "earlier-switch-target_1", source: "earlier-switch", project });
  expect(elevatedRequesterFor(current!, updated!, claim, [current!])?.entry.id).toBe("earlier-switch-target_1");
  expect(elevatedRequesterFor(current!, updated!, request("unlisted"), [current!])).toBeNull();
  const rows = fs.readFileSync(auditFile, "utf8").trim().split("\n").map(row => JSON.parse(row));
  try {
    expect(rows.filter(row => row.action === "earlier-switch")).toHaveLength(1);
    expect(rows.every(row => !Object.hasOwn(row, "key"))).toBe(true);
  } finally { fs.rmSync(auditFile); }
});

test("Add me refuses a second pairing and a solo install without an entry or audit write", async () => {
  const a = paired([target]);
  const b = paired([target], "relay_b", "202");
  setRelays(a, b);
  const before = fs.readFileSync(externalRelayFile("relays"), "utf8");
  const audit = fs.existsSync(trustedRequesterAuditFile()) ? fs.readFileSync(trustedRequesterAuditFile(), "utf8") : null;
  const request = new NextRequest("http://127.0.0.1:1");
  await expect(addPairedOwnerRequester(request, a.id, target.id, 0)).rejects.toMatchObject({ code: "owner_required" });
  const store = ownerMember();
  const session = mintSession(store, store.owner()!.id, "telegram", { surface: "desktop", browser: "chrome" });
  const ownerRequest = new NextRequest("http://127.0.0.1:1", { headers: { cookie: `${MEMBER_COOKIE}=${session.value}` } });
  await expect(addPairedOwnerRequester(ownerRequest, b.id, target.id, 0)).rejects.toMatchObject({ code: "owner_required" });
  expect(fs.readFileSync(externalRelayFile("relays"), "utf8")).toBe(before);
  expect(fs.existsSync(trustedRequesterAuditFile()) ? fs.readFileSync(trustedRequesterAuditFile(), "utf8") : null).toBe(audit);
});

test("the transfer collector carries only the paired-owner entry", () => {
  const pairedOwner = { id: "carried", kind: "paired-owner" as const, source: "earlier-switch" as const,
    label: "Paired owner", project, addedAt };
  setRelays(paired([{ ...target, requesters: { revision: 3, entries: [entry, pairedOwner] } }]));
  const source = new SourceSnapshot(process.env.LLV_STATE_DIR!, process.env.XDG_CONFIG_HOME!, null, null);
  try {
    const output = partById.get("pending:relay-targets")!.collect(source);
    expect(output).toMatchObject([{ value: { target: { requesters: { revision: 3, entries: [pairedOwner] } } } }]);
    expect(JSON.stringify(output)).not.toContain(entry.id);
    expect(JSON.stringify(output)).not.toContain('"key":"u1"');
  } finally { source.close(); }
});

const entryWriter = { surface: "board" as const, approvedBy: "operator" };
for (const state of ["queued", "running", "continuation", "unlink"] as const) {
  test(`revocation cancels a ${state} turn before observation returns`, async () => {
    const isOwner = state === "unlink";
    const relay = paired([isOwner ? { ...target, ownerTier: true } : granted]);
    setRelays(relay, ...(isOwner ? [paired([{ ...target, ownerTier: true }], "relay_b", "202")] : []));
    const store = isOwner ? ownerMember() : null;
    const raw = request(`revocation_${state}`);
    raw.input.requester.is_owner = isOwner;
    if (state === "continuation") {
      raw.chat = { key: "trusted_reply_chain" };
      const seed = reserveChainConversation(relay, granted, requestSchema.parse(raw), "trusted:grant-one")!;
      releaseConversation(seed.id, { state: "idle", runningRequestId: null, conversationId: "conversation_revoked" });
      raw.input.respond_to = "continuation_trigger";
      raw.input.conversation.push({ ...raw.input.conversation[0]!, id: "continuation_trigger", reply_to: "m1" });
      setRelaySwitch("chain_conversations", true);
    }
    const selected = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: {
      engine: "codex", accountId: "fixture", kind: "managed", home: process.env.HOME!, transcriptRoot: process.env.HOME!, env: { NODE_ENV: "test" } } });
    const wire = spyOn(client, "relayCall").mockResolvedValue({ status: 200, body: { status: "ok" } } as never);
    let entered!: () => void, release!: () => void;
    const observing = new Promise<void>(resolve => { entered = resolve; });
    const observation = new Promise<void>(resolve => { release = resolve; });
    const stops: string[] = [];
    const pending = runClaimedRequest(relay, raw, undefined, { leaseWorker: false, ownerPorts: {
      launch: async () => {
        expect(state).not.toBe("continuation");
        return { status: 202, body: { conversationId: "conversation_revoked", initialMessage: state === "queued" ? "queued" : "delivered" } };
      },
      continue: async (turn, _prompt, _target, authorize) => {
        expect(state).toBe("continuation");
        authorize();
        return { ok: true, structured: true, target: turn.conversationId!, outcome: "held", operationId: turn.clientAttemptId };
      },
      observe: async () => { entered(); await observation; return { state: "ended", finalText: "Suppressed" }; },
      stop: async (_id, action) => { stops.push(action); },
    } });
    try {
      await Promise.race([observing, pending.then(() => { throw new Error("elevated turn did not reach observation"); })]);
      if (store) {
        const session = mintSession(store, store.owner()!.id, "telegram", { surface: "desktop", browser: "chrome" });
        expect((await unlinkTelegram(new NextRequest("http://127.0.0.1:1", { method: "DELETE",
          headers: { host: "127.0.0.1:1", origin: "http://127.0.0.1:1", cookie: `${MEMBER_COOKIE}=${session.value}` } }))).status).toBe(200);
      } else {
        await addTrustedRequester(relay.id, target.id, 1, { key: "u2", label: "Other" }, entryWriter);
        expect(ownerRelayAuthorized(relay.id, target.id, raw.request_id)).toBe(true);
        expect(stops).toEqual([]);
        await removeTrustedRequester(relay.id, target.id, 2, entry.id, entryWriter);
      }
      expect(ownerRelayAuthorized(relay.id, target.id, raw.request_id)).toBe(false);
      expect(await ownerRelayAuthorizedAsync(relay.id, target.id, raw.request_id)).toBe(false);
      release();
      expect((await pending)?.outcome).not.toBe("answered");
      expect(stops).toEqual([state === "queued" ? "kill" : "interrupt"]);
    } finally {
      release();
      try { await pending; }
      finally {
        selected.mockRestore();
        wire.mockRestore();
        if (state === "continuation") setRelaySwitch("chain_conversations", false);
      }
    }
  });
}
