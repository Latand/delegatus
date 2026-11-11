import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import { defaultStartHost, spawnStructuredConversation, type SpawnedStructuredHost } from "@/lib/runtime/structuredSpawn";
import * as publicationSource from "@/lib/git/repositoryCommitIdentity";
import { adoptClaudeRegistryHosts, adoptCodexRegistryHosts, flushStructuredHostPersistence } from "@/lib/runtime/registry";
import { assertMemberLaunchAllowed } from "./memberLaunchAuthority";
import { reconcileMemberRevocations } from "./memberRevocation";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { beginLegacySpawnFixture, structuredHostFixture } from "@/lib/agent/registryTestFixtures";
import { captureProcessIdentity, processIdentityStatus } from "@/lib/processIdentity";
import { RuntimeJournal } from "@/runtime-host/journal";
import * as runtimeClient from "@/lib/runtime/client";
import { FakeEngineHost } from "@/lib/runtime/fixtures/fakeEngineHost";
import { StructuredDeliveryQueue } from "@/lib/runtime/structuredDeliveryQueue";
import { structuredHostKillRefFromRegistry, terminateStructuredHostTree } from "@/lib/runtime/structuredHostControl";
import { runtimeJournalClient } from "@/lib/runtime/startupRecipient.fixture";
import { PATCH } from "@/app/api/team/members/[id]/route";
import { claimInstall, createInvite, redeemJoin, restoreMember, revokeMember } from "./members";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { teamStore, resetTeamStoreForTests } from "./store";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(killFailures = 0, engine: "claude" | "codex" = "claude") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "member-revocation-"));
  const previous = process.env.LLV_STATE_DIR;
  cleanups.push(() => { resetTeamStoreForTests(); setAgentRegistryForTests(null); if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); });
  process.env.LLV_STATE_DIR = root;
  resetTeamStoreForTests();
  const store = teamStore();
  const device = { surface: "desktop" as const, browser: "chrome" as const };
  const owner = claimInstall(store, "Owner", device);
  const person = redeemJoin(store, createInvite(store, owner.member, null).code, "Member A", device);
  const registry = new AgentRegistry(path.join(root, "agent-registry.json"));
  cleanups.push(() => registry.close());
  setAgentRegistryForTests(registry);
  const child = Bun.spawn([process.execPath, "-e", "console.log('ready'); setInterval(() => {}, 1000)"], { stdout: "pipe", stderr: "ignore" });
  cleanups.push(async () => { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; });
  const reader = child.stdout.getReader();
  await reader.read(); reader.releaseLock();
  const identity = captureProcessIdentity(child.pid);
  const begun = beginLegacySpawnFixture(registry, { engine, cwd: root, transport: "structured",
    launchProfile: { workspace: { memberId: person.member.id, workspaceId: "workspace-a" } } });
  if (begun.kind !== "created") throw Error("fixture admission failed");
  const key = { engine, sessionId: "00000000-0000-0000-0000-000000000001" };
  const columns = { ...structuredHostFixture(identity, engine === "claude" ? "claude-broker" : "codex-app-server"), activeTurnRef: "turn-a" };
  const settled = registry.settleSpawn(begun.receipt.launchId, { key, artifactPath: path.join(root, `${key.sessionId}.jsonl`), cwd: root,
    accountId: null, status: "live", host: null, launchProfile: begun.receipt.launchProfile, structuredHost: columns,
    claimEpoch: 1, claimOwner: "fixture", pendingAction: null });
  if (settled.kind !== "settled") throw Error("fixture settlement failed");
  expect(registry.hostEntry(key)?.launchProfile?.workspace?.memberId).toBe(person.member.id);
  let journal = new RuntimeJournal(path.join(root, "runtime.sqlite"), { structuredHosts: true });
  cleanups.push(() => journal.close());
  journal.append({ scope: `session:${begun.receipt.conversationId}`, kind: "session-status", payload: {
    conversationId: begun.receipt.conversationId, sessionKey: key, hostKind: "claude-broker", host: "hosted", turn: "running", activeTurnId: "turn-a",
    capabilities: { steer: true, nativeQueue: true, structuredAttention: true },
  } });
  const interrupts: string[] = [];
  const host = new FakeEngineHost(undefined, { status: "active", sessionKey: key.sessionId, endpoint: "fixture:host", pid: child.pid,
    processStartIdentity: identity.startIdentity, eventCursor: 0, protocolVersion: "fixture-v1", activeTurnRef: "turn-a", pendingAttention: [], activeFlags: [], account: null });
  host.interrupt = async () => { interrupts.push("turn-a"); };
  const queue = new StructuredDeliveryQueue({
    effects: async (kinds, after) => journal.effectBatch(100, kinds, after),
    transition: async (id, status, details) => { journal.transitionOperation(id, status, details); },
    status: async id => journal.operationResult(id)?.receipt ?? null,
  }, id => id === begun.receipt.conversationId ? host : null, async (id, target) => {
    if (killFailures-- > 0) return false;
    const ref = structuredHostKillRefFromRegistry(target, { snapshot: () => registry.readOnlySnapshot(), conversationId: id as `conversation_${string}` });
    if (!ref.ok) throw Error(ref.error);
    const entry = registry.hostEntry(target)!;
    const result = await terminateStructuredHostTree(ref.ref, { terminateOwnedHost: async () => false,
      registryCustody: { claimEpoch: entry.claimEpoch, claimOwner: entry.claimOwner, writerClaimEpoch: entry.structuredHost?.writerClaimEpoch ?? null, process: entry.structuredHost?.process ?? null },
      retireRegistryEntry: (key, process, confirmed, custody, scope) => registry.terminateStructuredHost(key, process, confirmed, custody, scope) });
    if (!result.ok) throw Error(result.error);
    await child.exited;
    return true;
  });
  const commands: string[] = [];
  const client = { ...runtimeJournalClient(journal), operationStatus: async (id: string) => journal.operationResult(id), command: async (command: Parameters<runtimeClient.RuntimeHostClient["command"]>[0]) => {
    commands.push(command.operationId!);
    const result = journal.executeOperation(command);
    await queue.drain();
    return journal.operationResult(result.operationId)!;
  } };
  const clientSpy = spyOn(runtimeClient, "runtimeHostClient").mockReturnValue(client);
  cleanups.push(() => clientSpy.mockRestore());
  const revoke = () => PATCH(new NextRequest(`http://127.0.0.1:8898/api/team/members/${person.member.id}`, {
    method: "PATCH", headers: { host: "127.0.0.1:8898", cookie: `llv_member=${owner.cookie}`, "content-type": "application/json" },
    body: JSON.stringify({ status: "revoked" }),
  }), { params: Promise.resolve({ id: person.member.id }) });
  let recoveryAt = Date.now();
  return { root, store, owner, person, registry, child, interrupts, revoke, client, commands, key, queue, receipt: begun.receipt,
    nextRecoveryAt: () => recoveryAt += 60_000,
    restartRuntime: () => { journal.close(); journal = new RuntimeJournal(path.join(root, "runtime.sqlite"), { structuredHosts: true }); },
    get journal() { return journal; } };
}

function queueLaunch(f: Awaited<ReturnType<typeof fixture>>, memberId = f.person.member.id, fromMessage = false) {
  const launchProfile = emptyLaunchProfile({ cwd: f.root, title: "Queued work", workspace: { memberId, workspaceId: "workspace-a", ...(fromMessage ? { fromMessage: true } : {}) } });
  const begun = beginLegacySpawnFixture(f.registry, { engine: "claude", cwd: f.root, transport: "structured", accountId: "subscription-a", accountPin: true, launchProfile });
  if (begun.kind !== "created") throw Error("queue fixture admission failed");
  f.registry.queuePinnedSpawn(begun.receipt.launchId, { version: 1, retryAt: "2099-01-01T00:00:00.000Z", accountId: "subscription-a", locale: "en",
    spec: { engine: "claude", command: "claude", cwd: f.root, windowName: "queued-work", launchProfile }, prompt: "Continue", imageRefs: [], parentArtifactPath: null, pipelineSourceConversationId: null }, "Queued work");
  return begun.receipt.launchId;
}

async function runChild(f: Awaited<ReturnType<typeof fixture>>, mode: string, cut = "") {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/memberRevocationChild.ts"), mode, f.person.member.id, cut, String(f.nextRecoveryAt())], {
    env: { ...process.env, LLV_STATE_DIR: f.root }, stdout: "pipe", stderr: "pipe",
  });
  cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await child.exited; });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, out, err }).toEqual({ code: cut ? 71 : 0, out: "", err: "" });
}

test("revoking a person interrupts and ends their host, with a confirmed count on the same event", async () => {
  const f = await fixture();
  const response = await f.revoke();
  expect(response.status).toBe(200);
  expect(f.interrupts).toEqual(["turn-a"]);
  expect(processIdentityStatus(captureProcessIdentity(f.child.pid))).toBe("dead");
  const events = f.store.events({ actions: ["member.revoked"], limit: 10 });
  expect(events).toHaveLength(1);
  expect(events[0]!.detail).toMatchObject({ stoppedHosts: 1, pending: false });
});

test("a host already gone when revocation arrives is excluded from the stopped count", async () => {
  const f = await fixture();
  f.child.kill("SIGTERM");
  await f.child.exited;
  expect((await f.revoke()).status).toBe(200);
  expect(f.commands).toEqual([]);
  expect(f.store.events({ actions: ["member.revoked"], limit: 1 })[0]!.detail).toMatchObject({ stoppedHosts: 0, pending: false });
});

test("a provisional host's terminal kill does not confirm revocation before native setup cleanup releases its owner", async () => {
  const f = await fixture();
  const begun = beginLegacySpawnFixture(f.registry, { engine: "claude", cwd: f.root, transport: "structured", ownStartingActuation: true,
    launchProfile: { workspace: { memberId: f.person.member.id, workspaceId: "workspace-a" } } });
  if (begun.kind !== "created" || !begun.receipt.admissionOwner) throw Error("provisional admission failed");
  const key = { engine: "claude" as const, sessionId: "00000000-0000-0000-0000-000000000007" };
  f.registry.stageStructuredSpawn(begun.receipt.launchId, { key, artifactPath: path.join(f.root, `${key.sessionId}.jsonl`), cwd: f.root,
    accountId: null, status: "unhosted", host: null, launchProfile: begun.receipt.launchProfile, structuredHost: structuredHostFixture(null),
    claimEpoch: 0, claimOwner: null, pendingAction: "spawn" });
  const command = f.client.command;
  f.client.command = async input => {
    if (input.kind !== "kill" || input.sessionKey.sessionId !== key.sessionId) return command(input);
    const result = f.journal.executeOperation(input);
    f.journal.transitionOperation(result.operationId, "delivering");
    f.journal.transitionOperation(result.operationId, "delivered");
    return f.journal.operationResult(result.operationId)!;
  };
  await f.revoke();
  const { reconcileMemberRevocations } = await import("./memberRevocation");
  await reconcileMemberRevocations({ store: f.store, registry: f.registry, client: f.client, now: f.nextRecoveryAt, assertActive: () => {} });
  expect(f.store.memberRevocationPending(f.person.member.id)).toBe(true);
  f.registry.releaseStructuredSpawnAdmissionOwner(begun.receipt.launchId, begun.receipt.admissionOwner);
  await reconcileMemberRevocations({ store: f.store, registry: f.registry, client: f.client, now: f.nextRecoveryAt, assertActive: () => {} });
  expect(f.store.memberRevocationPending(f.person.member.id)).toBe(false);
  expect(f.store.events({ actions: ["member.revoked"], limit: 1 })[0]!.detail).toMatchObject({ stoppedHosts: 1, pending: false });
});

test("queued launches are held permanently while another person's queue is unchanged", async () => {
  const f = await fixture();
  const own = queueLaunch(f);
  const other = queueLaunch(f, f.owner.member.id);
  const prior = f.registry.spawnReceipt(other);
  const seat = queueLaunch(f, f.person.member.id, true);
  const seatPrior = f.registry.spawnReceipt(seat);
  await f.revoke();
  expect(f.registry.spawnReceipt(own)).toMatchObject({ state: "failed", queuedPinnedSpawn: null, error: expect.stringContaining("member access revoked") });
  expect(f.registry.spawnReceipt(other)).toEqual(prior);
  expect(f.registry.spawnReceipt(seat)).toEqual(seatPrior);
  expect(f.store.events({ actions: ["member.revoked"], limit: 1 })[0]!.detail).toMatchObject({ heldLaunches: 1, stoppedHosts: 1, pending: false });
});

test("restoration waits for shutdown confirmation and never reactivates held work or sessions", async () => {
  const f = await fixture();
  const queued = queueLaunch(f);
  f.client.command = async () => { throw Error("injected control outage"); };
  expect((await f.revoke()).status).toBe(202);
  const restore = () => PATCH(new NextRequest(`http://127.0.0.1:8898/api/team/members/${f.person.member.id}`, {
    method: "PATCH", headers: { host: "127.0.0.1:8898", cookie: `llv_member=${f.owner.cookie}`, "content-type": "application/json" },
    body: JSON.stringify({ status: "active" }),
  }), { params: Promise.resolve({ id: f.person.member.id }) });
  expect((await restore()).status).toBe(409);
  expect(f.store.member(f.person.member.id)?.status).toBe("revoked");
  await runChild(f, "reconcile");
  await f.queue.drain();
  await runChild(f, "reconcile");
  expect((await restore()).status).toBe(200);
  expect(f.store.session(f.person.session.id)?.revokedAt).not.toBeNull();
  expect(f.registry.spawnReceipt(queued)).toMatchObject({ state: "failed", queuedPinnedSpawn: null });
});

test("another person, the owner, and installation seat and pipeline hosts are untouched", async () => {
  const f = await fixture();
  const other = redeemJoin(f.store, createInvite(f.store, f.owner.member, null).code, "Member B", { surface: "desktop", browser: "chrome" });
  const protectedHosts = [];
  for (const [index, principal] of [other.member.id, f.owner.member.id, null, null, f.person.member.id].entries()) {
    const child = Bun.spawn([process.execPath, "-e", "console.log('ready'); setInterval(() => {}, 1000)"], { stdout: "pipe", stderr: "ignore" });
    cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await child.exited; });
    const reader = child.stdout.getReader(); await reader.read(); reader.releaseLock();
    const key = { engine: "claude" as const, sessionId: `00000000-0000-0000-0000-00000000000${index + 2}` };
    const begun = beginLegacySpawnFixture(f.registry, { engine: "claude", cwd: f.root, transport: "structured", role: index === 2 ? "orchestrator" : index === 3 ? "builder" : null,
      launchProfile: principal ? { workspace: { memberId: principal, workspaceId: "workspace-a", ...(index === 4 ? { fromMessage: true } : {}) } } : {} });
    if (begun.kind !== "created") throw Error("protected admission failed");
    const result = f.registry.settleSpawn(begun.receipt.launchId, { key, artifactPath: path.join(f.root, `${key.sessionId}.jsonl`), cwd: f.root,
      accountId: null, status: "live", host: null, launchProfile: begun.receipt.launchProfile, structuredHost: structuredHostFixture(captureProcessIdentity(child.pid)),
      claimEpoch: 1, claimOwner: "fixture", pendingAction: null });
    if (result.kind !== "settled") throw Error("protected settlement failed");
    protectedHosts.push({ identity: captureProcessIdentity(child.pid), key, before: f.registry.hostEntry(key) });
  }
  await f.revoke();
  expect(processIdentityStatus(captureProcessIdentity(f.child.pid))).toBe("dead");
  for (const host of protectedHosts) {
    expect(processIdentityStatus(host.identity)).toBe("alive");
    expect(f.registry.hostEntry(host.key)).toEqual(host.before);
  }
  expect(f.commands).toHaveLength(2);
});

test("a failed revocation transaction changes no session and sends no control", async () => {
  const f = await fixture();
  const write = spyOn(f.store, "enqueueMemberRevocation").mockImplementation(() => { throw Error("injected outbox write failure"); });
  cleanups.push(() => write.mockRestore());
  expect((await f.revoke()).status).toBe(503);
  expect(f.store.member(f.person.member.id)?.status).toBe("active");
  expect(f.store.session(f.person.session.id)?.revokedAt).toBeNull();
  expect(f.store.events({ actions: ["member.revoked"], limit: 10 })).toEqual([]);
  expect(f.commands).toEqual([]);
});

test("a lost stop-result write replays its delivered receipt and records one stopped host", async () => {
  const f = await fixture();
  const save = f.store.saveRevocationTarget.bind(f.store);
  const write = spyOn(f.store, "saveRevocationTarget").mockImplementation(target => {
    if (target.state === "stopped") throw Error("injected result write failure");
    save(target);
  });
  cleanups.push(() => write.mockRestore());
  expect((await f.revoke()).status).toBe(202);
  expect(processIdentityStatus(captureProcessIdentity(f.child.pid))).toBe("dead");
  expect(f.store.events({ actions: ["member.revoked"], limit: 1 })[0]!.detail).toMatchObject({ stoppedHosts: 0, pending: true });
  const commands = [...f.commands];
  await runChild(f, "reconcile");
  expect(f.commands).toEqual(commands);
  expect(f.store.events({ actions: ["member.revoked"], limit: 1 })[0]!.detail).toMatchObject({ stoppedHosts: 1, pending: false });
});

test("a lost hold-result write retains the registry hold and retries without starting or stopping another host", async () => {
  const f = await fixture();
  const queued = queueLaunch(f);
  const save = f.store.saveRevocationTarget.bind(f.store);
  const write = spyOn(f.store, "saveRevocationTarget").mockImplementation(target => {
    if (target.state === "held") throw Error("injected hold-result write failure");
    save(target);
  });
  cleanups.push(() => write.mockRestore());
  expect((await f.revoke()).status).toBe(202);
  expect(f.registry.spawnReceipt(queued)).toMatchObject({ state: "failed", queuedPinnedSpawn: null });
  const commands = [...f.commands];
  await runChild(f, "reconcile");
  expect(f.commands).toEqual(commands);
  expect(f.store.events({ actions: ["member.revoked"], limit: 1 })[0]!.detail).toMatchObject({ stoppedHosts: 1, heldLaunches: 1, pending: false });
});

for (const step of ["before-interrupt", "after-interrupt"] as const) test(`a changed launch principal after an awaited read is refused: ${step}`, async () => {
  const f = await fixture();
  const original = f.registry.hostEntry(f.key)!;
  const replacePrincipal = () => f.registry.upsert({ ...original, launchProfile: { ...original.launchProfile!, workspace: { memberId: f.owner.member.id, workspaceId: "workspace-a" } } });
  if (step === "before-interrupt") {
    const read = f.client.operationStatus;
    f.client.operationStatus = async id => { const result = await read(id); replacePrincipal(); return result; };
  } else {
    const command = f.client.command;
    f.client.command = async input => { const result = await command(input); if (input.kind === "interrupt") replacePrincipal(); return result; };
  }
  expect((await f.revoke()).status).toBe(202);
  expect(processIdentityStatus(captureProcessIdentity(f.child.pid))).toBe("alive");
  expect(f.commands).toHaveLength(step === "before-interrupt" ? 0 : 1);
  expect(f.store.events({ actions: ["member.revoked"], limit: 1 })[0]!.detail).toMatchObject({ stoppedHosts: 0, pending: true });
});

test("pending revocation events survive retention until their stopped count is recorded", async () => {
  const f = await fixture();
  f.client.command = async () => { throw Error("injected control outage"); };
  expect((await f.revoke()).status).toBe(202);
  const event = f.store.events({ actions: ["member.revoked"], limit: 1 })[0]!;
  f.store.pruneEvents(Date.now() + 91 * 24 * 60 * 60 * 1_000);
  expect(f.store.events({ actions: ["member.revoked"], limit: 1 })[0]?.id).toBe(event.id);
  await runChild(f, "reconcile");
  await f.queue.drain();
  await runChild(f, "reconcile");
  expect(f.store.events({ actions: ["member.revoked"], limit: 1 })[0]!.detail).toMatchObject({ stoppedHosts: 1, pending: false });
});

test("a lost event-progress write keeps the already stopped host's durable target for a restart", async () => {
  const f = await fixture();
  const write = spyOn(f.store, "settleRevocationProgress").mockImplementation(() => { throw Error("injected event progress failure"); });
  cleanups.push(() => write.mockRestore());
  expect((await f.revoke()).status).toBe(503);
  const event = f.store.events({ actions: ["member.revoked"], limit: 1 })[0]!;
  expect(f.store.revocationTargets(event.id)).toMatchObject([{ state: "stopped" }]);
  expect(event.detail).toMatchObject({ stoppedHosts: 0, pending: true });
  await runChild(f, "reconcile");
  expect(f.store.events({ actions: ["member.revoked"], limit: 1 })[0]!.detail).toMatchObject({ stoppedHosts: 1, pending: false });
});

for (const cut of ["before-interrupt", "after-interrupt", "after-kill"] as const) test(`restart after durable revocation and ${cut} completes the original stop exactly once`, async () => {
  const f = await fixture();
  const queued = queueLaunch(f);
  await runChild(f, "revoke");
  const event = f.store.events({ actions: ["member.revoked"], limit: 1 })[0]!;
  expect(event.detail).toMatchObject({ stoppedHosts: 0, pending: true });
  expect(processIdentityStatus(captureProcessIdentity(f.child.pid))).toBe("alive");
  await runChild(f, "reconcile", cut);
  f.restartRuntime();
  await runChild(f, "reconcile");
  await f.queue.drain();
  await runChild(f, "reconcile");
  expect(processIdentityStatus(captureProcessIdentity(f.child.pid))).toBe("dead");
  expect(f.registry.spawnReceipt(queued)?.state).toBe("failed");
  const events = f.store.events({ actions: ["member.revoked"], limit: 10 });
  expect(events).toHaveLength(1);
  expect(events[0]!.id).toBe(event.id);
  expect(events[0]!.detail).toMatchObject({ stoppedHosts: 1, heldLaunches: 1, pending: false });
  expect(f.interrupts).toEqual(["turn-a"]);
  await runChild(f, "reconcile");
  expect(f.interrupts).toEqual(["turn-a"]);
});

test("an interrupt failure leaves a durable pending stop and a held queue; repeating revocation completes it", async () => {
  const f = await fixture();
  const queued = queueLaunch(f);
  const real = f.client.command;
  f.client.command = async command => { if (command.kind === "interrupt") throw Error("injected interrupt failure"); return real(command); };
  expect((await f.revoke()).status).toBe(202);
  const event = f.store.events({ actions: ["member.revoked"], limit: 1 })[0]!;
  expect(event.detail).toMatchObject({ stoppedHosts: 0, heldLaunches: 1, pending: true });
  expect(f.registry.spawnReceipt(queued)?.state).toBe("failed");
  expect(processIdentityStatus(captureProcessIdentity(f.child.pid))).toBe("alive");
  f.client.command = real;
  await runChild(f, "reconcile");
  await f.queue.drain();
  await runChild(f, "reconcile");
  expect((await f.revoke()).status).toBe(200);
  expect(f.store.events({ actions: ["member.revoked"], limit: 10 })).toHaveLength(1);
});

test("revocation during native auth keeps fresh setup pending and prevents native execution", async () => {
  const f = await fixture();
  const begun = beginLegacySpawnFixture(f.registry, { engine: "claude", cwd: f.root, transport: "structured", ownStartingActuation: true,
    launchProfile: { workspace: { memberId: f.person.member.id, workspaceId: "workspace-a" } } });
  if (begun.kind !== "created") throw Error("admission failed");
  let spawned = false;
  await expect(spawnStructuredConversation({ registry: f.registry, client: f.client, receipt: begun.receipt, engine: "claude", prompt: "",
    account: { engine: "claude", accountId: "subscription-a", kind: "legacy", home: f.root, transcriptRoot: f.root, env: { NODE_ENV: "test" } },
    spec: { engine: "claude", command: "claude", cwd: f.root, windowName: "native-race", launchProfile: begun.receipt.launchProfile },
  }, { startHost: (input, capability) => defaultStartHost(input, capability, { claude: {
    readAuthStatus: async () => {
      expect(f.registry.spawnReceipt(begun.receipt.launchId)?.hostSetupStartedAt).toBeDefined();
      expect((await f.revoke()).status).toBe(202);
      expect(f.store.memberRevocationPending()).toBe(true);
      return { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" };
    },
    spawnProcess: () => { spawned = true; throw Error("native spawn reached"); },
  } }) })).rejects.toThrow("member access revoked");
  expect(spawned).toBe(false);
  expect(f.registry.spawnReceipt(begun.receipt.launchId)?.admissionOwner).toBeNull();
  await runChild(f, "reconcile");
  expect(f.store.memberRevocationPending()).toBe(false);
  expect(f.store.events({ actions: ["member.revoked"], limit: 1 })[0]!.detail).toMatchObject({ stoppedHosts: 1, heldLaunches: 1, pending: false });
});

for (const engine of ["claude", "codex", "copilot"] as const) for (const resumed of [false, true]) {
  test(`native ${engine} ${resumed ? "adopt" : "start"} rechecks revocation after publication preparation`, async () => {
    const f = await fixture();
    const sessionId = "00000000-0000-0000-0000-000000000008";
    const artifact = path.join(f.root, `${sessionId}.jsonl`);
    const profile = emptyLaunchProfile({ cwd: f.root, workspace: { memberId: f.person.member.id, workspaceId: "workspace-a" } });
    let conversationId: `conversation_${string}` | undefined;
    if (resumed) {
      fs.writeFileSync(artifact, JSON.stringify({ type: "session_meta", payload: { id: sessionId } }) + "\n");
      conversationId = f.registry.ensureConversation(engine, artifact, "subscription-a").id;
      f.registry.upsert({ key: { engine, sessionId }, artifactPath: artifact, cwd: f.root, accountId: "subscription-a", launchProfile: profile,
        status: "dead", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
    }
    const begun = beginLegacySpawnFixture(f.registry, { engine, cwd: f.root, transport: "structured", launchProfile: profile,
      ...(resumed ? { purpose: "resume-successor", expectedArtifactPath: artifact, conversationId } : {}) });
    if (begun.kind !== "created") throw Error("admission failed");
    const original = publicationSource.repositoryPublicationSource;
    const read = spyOn(publicationSource, "repositoryPublicationSource").mockImplementation(async (...args) => {
      const result = await original(...args);
      revokeMember(f.store, f.owner.member, f.person.member);
      return result;
    });
    cleanups.push(() => read.mockRestore());
    let spawned = false;
    const spawnProcess = () => { spawned = true; throw Error("native spawn reached"); };
    await expect(defaultStartHost({ registry: f.registry, client: f.client, receipt: begun.receipt, engine, prompt: "",
      account: { engine, accountId: "subscription-a", kind: "legacy", home: f.root, transcriptRoot: f.root, env: { NODE_ENV: "test" } },
      spec: { engine, command: engine, cwd: f.root, windowName: "native-guard", launchProfile: begun.receipt.launchProfile },
    }, "fixture-capability", {
      claude: { spawnProcess, readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }) },
      codex: { spawnProcess, readProtocolVersion: () => "0.162.1" },
      copilot: { spawnProcess },
    })).rejects.toThrow("member access revoked");
    expect(read).toHaveBeenCalledTimes(1);
    expect(spawned).toBe(false);
  });
}

test("a host setup timeout retains admission until late cleanup confirms release", async () => {
  const f = await fixture();
  const begun = beginLegacySpawnFixture(f.registry, { engine: "claude", cwd: f.root, transport: "structured", ownStartingActuation: true,
    launchProfile: { workspace: { memberId: f.person.member.id, workspaceId: "workspace-a" } } });
  if (begun.kind !== "created") throw Error("admission failed");
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let finish!: (host: SpawnedStructuredHost) => void;
  const pendingHost = new Promise<SpawnedStructuredHost>(resolve => { finish = resolve; });
  const lateHost = new FakeEngineHost();
  let released = false;
  lateHost.release = async () => { released = true; };
  cleanups.push(() => { finish(lateHost as unknown as SpawnedStructuredHost); });
  let ownerReleased!: () => void;
  const ownerRelease = new Promise<void>(resolve => { ownerReleased = resolve; });
  const release = f.registry.releaseStructuredSpawnAdmissionOwner.bind(f.registry);
  const releaseSpy = spyOn(f.registry, "releaseStructuredSpawnAdmissionOwner").mockImplementation((...args) => {
    const result = release(...args); ownerReleased(); return result;
  });
  cleanups.push(() => releaseSpy.mockRestore());
  const opening = spawnStructuredConversation({ registry: f.registry, client: f.client, receipt: begun.receipt, engine: "claude", prompt: "",
    account: { engine: "claude", accountId: "subscription-a", kind: "legacy", home: f.root, transcriptRoot: f.root, env: { NODE_ENV: "test" } },
    spec: { engine: "claude", command: "claude", cwd: f.root, windowName: "late-setup", launchProfile: begun.receipt.launchProfile },
  }, { durableSetupTimeoutMs: 100, startHost: () => { started(); return pendingHost; } });
  const failed = expect(opening).rejects.toThrow("durable host setup timed out");
  await entered;
  expect((await f.revoke()).status).toBe(202);
  await failed;
  await runChild(f, "reconcile");
  expect(f.registry.spawnReceipt(begun.receipt.launchId)?.admissionOwner).not.toBeNull();
  expect(f.store.memberRevocationPending()).toBe(true);
  finish(lateHost as unknown as SpawnedStructuredHost);
  await ownerRelease;
  expect(released).toBe(true);
  await runChild(f, "reconcile");
  expect(f.store.memberRevocationPending()).toBe(false);
});

test("Viewer boot adoption carries member revocation through the host's auth await", async () => {
  const f = await fixture();
  f.child.kill("SIGTERM");
  await f.child.exited;
  const entry = f.registry.hostEntry(f.key)!;
  f.registry.upsert({ ...entry, status: "unhosted", claimOwner: null, structuredHost: { ...entry.structuredHost!, process: null, writerClaimEpoch: 0 } });
  let authRead = false, spawned = false;
  const failures: unknown[] = [];
  const adopted = await adoptClaudeRegistryHosts(f.registry, () => ({ cwd: f.root, env: { NODE_ENV: "test" },
    readAuthStatus: async () => {
      authRead = true;
      revokeMember(f.store, f.owner.member, f.person.member);
      return { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" };
    },
    spawnProcess: () => { spawned = true; throw Error("native spawn reached"); },
  }), { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" }, () => true, undefined, { onFailure: (_entry, error) => { failures.push(error); } });
  expect(authRead).toBe(true);
  expect(spawned).toBe(false);
  expect(adopted).toEqual([]);
  expect(failures).toMatchObject([expect.objectContaining({ message: expect.stringContaining("member access revoked") })]);
});

for (const operationPointer of [false, true]) test(`Viewer boot adoption admits a fresh restored launch with operation pointer ${operationPointer}`, async () => {
  const f = await fixture();
  f.child.kill("SIGTERM");
  await f.child.exited;
  revokeMember(f.store, f.owner.member, f.person.member);
  restoreMember(f.store, f.owner.member, f.store.member(f.person.member.id)!);
  const begun = beginLegacySpawnFixture(f.registry, { engine: "claude", cwd: f.root, transport: "structured", launchProfile: f.receipt.launchProfile });
  if (begun.kind !== "created") throw Error("admission failed");
  const key = { engine: "claude" as const, sessionId: "00000000-0000-0000-0000-000000000009" };
  const settled = f.registry.settleSpawn(begun.receipt.launchId, { key, artifactPath: path.join(f.root, `${key.sessionId}.jsonl`), cwd: f.root,
    accountId: null, status: "unhosted", host: null, launchProfile: begun.receipt.launchProfile, structuredHost: structuredHostFixture(null),
    claimEpoch: 0, claimOwner: null, pendingAction: null, ...(operationPointer ? { structuredHostOperationId: begun.receipt.launchId } : {}) });
  if (settled.kind !== "settled") throw Error("settlement failed");
  let reached = false;
  await adoptClaudeRegistryHosts(f.registry, () => ({ cwd: f.root, env: { NODE_ENV: "test" } }), { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" },
    entry => entry.key.sessionId === key.sessionId, undefined, {
      adoptHost: async (_id, options) => { options.assertCurrent?.(); reached = true; throw Error("native admission reached"); },
    });
  expect(reached).toBe(true);
});

test("a terminal kill refusal retries durably after a process restart without repeating a successful stop", async () => {
  const f = await fixture(1);
  expect((await f.revoke()).status).toBe(202);
  const firstKill = f.commands.find(id => id.startsWith("member-revocation-kill-"))!;
  expect(f.journal.operationResult(firstKill)?.receipt).toMatchObject({ status: "failed", reason: "structured host termination is unavailable" });
  expect(processIdentityStatus(captureProcessIdentity(f.child.pid))).toBe("alive");
  await runChild(f, "reconcile", "after-retry-target");
  f.restartRuntime();
  await runChild(f, "reconcile");
  await f.queue.drain();
  await runChild(f, "reconcile");
  expect((await f.revoke()).status).toBe(200);
  expect(f.journal.operationResult(firstKill)?.receipt.status).toBe("failed");
  expect(f.journal.operationResult(`${firstKill}-1`)?.receipt.status).toBe("delivered");
  expect(processIdentityStatus(captureProcessIdentity(f.child.pid))).toBe("dead");
  expect(f.interrupts).toEqual(["turn-a"]);
  expect(f.store.events({ actions: ["member.revoked"], limit: 10 })).toMatchObject([{ detail: { stoppedHosts: 1, pending: false } }]);
});

test("a rejected kill keeps its reason and retries through the same generation fence", async () => {
  const f = await fixture();
  const command = f.client.command;
  let rejected: string | null = null;
  f.client.command = async input => {
    if (input.kind !== "kill" || rejected) return command(input);
    const result = f.journal.executeOperation(input);
    rejected = result.operationId;
    f.journal.transitionOperation(result.operationId, "rejected", { reason: "injected control rejection" });
    return f.journal.operationResult(result.operationId)!;
  };
  expect((await f.revoke()).status).toBe(202);
  expect(f.store.events({ actions: ["member.revoked"], limit: 1 })[0]!.detail).toMatchObject({ revocationError: "injected control rejection", pending: true });
  await runChild(f, "reconcile");
  f.restartRuntime();
  await f.queue.drain();
  await runChild(f, "reconcile");
  expect(f.journal.operationResult(rejected!)?.receipt).toMatchObject({ status: "rejected", reason: "injected control rejection" });
  expect(f.journal.operationResult(`${rejected}-1`)?.receipt.status).toBe("delivered");
  expect(f.store.events({ actions: ["member.revoked"], limit: 1 })[0]!.detail).toMatchObject({ stoppedHosts: 1, pending: false });
});

test("backward clock revocation stops existing hosts and holds their queue across restore and restart", async () => {
  const f = await fixture();
  const queued = queueLaunch(f);
  const receipt = f.registry.spawnReceipt(queued)!;
  revokeMember(f.store, f.owner.member, f.person.member, Date.parse(receipt.createdAt) - 1_000);
  await runChild(f, "reconcile");
  await f.queue.drain();
  await runChild(f, "reconcile");
  expect(processIdentityStatus(captureProcessIdentity(f.child.pid))).toBe("dead");
  expect(f.registry.spawnReceipt(queued)).toMatchObject({ state: "failed", queuedPinnedSpawn: null });
  restoreMember(f.store, f.owner.member, f.store.member(f.person.member.id)!);
  expect(() => assertMemberLaunchAllowed(receipt)).toThrow("member access revoked");
  expect(f.store.events({ actions: ["member.revoked"], limit: 1 })[0]!.detail).toMatchObject({ stoppedHosts: 1, heldLaunches: 1, pending: false });
});

for (const launchFirst of [false, true]) test(`a recovered launch cannot erase a confirmed host target: launch first ${launchFirst}`, async () => {
  const f = await fixture();
  revokeMember(f.store, f.owner.member, f.person.member);
  const event = f.store.events({ actions: ["member.revoked"], limit: 1 })[0]!;
  const receipt = f.registry.spawnReceipt(f.receipt.launchId)!;
  if (receipt.admissionOwner) f.registry.releaseStructuredSpawnAdmissionOwner(receipt.launchId, receipt.admissionOwner);
  const hostTarget = { id: sessionKeyId(f.key), revocationId: event.id, kind: "host" as const, conversationId: receipt.conversationId,
    key: f.key, turnId: "turn-a", process: captureProcessIdentity(f.child.pid), launchId: receipt.launchId, state: "pending" as const };
  f.store.saveRevocationTarget(hostTarget);
  f.store.saveRevocationTarget({ ...hostTarget, id: receipt.launchId, kind: "launch", key: null, turnId: null, process: null });
  f.store.markRevocationPlanned(event.id);
  const read = f.store.revocationTargets.bind(f.store);
  const order = spyOn(f.store, "revocationTargets").mockImplementation((id, due) => read(id, due).sort((a, b) =>
    (a.kind === "launch" ? -1 : 1) * (launchFirst ? 1 : -1) - (b.kind === "launch" ? -1 : 1) * (launchFirst ? 1 : -1)));
  cleanups.push(() => order.mockRestore());
  await reconcileMemberRevocations({ store: f.store, registry: f.registry, client: f.client, now: f.nextRecoveryAt, assertActive: () => {} });
  // An obsolete conversion replay must preserve both evidence and outcome.
  f.store.saveRevocationTarget({ ...hostTarget, process: null });
  await runChild(f, "reconcile");
  expect((await f.revoke()).status).toBe(200);
  expect(f.store.revocationTargets(event.id).find(target => target.kind === "host")).toMatchObject({ process: hostTarget.process, state: "stopped" });
  expect(f.store.events({ actions: ["member.revoked"], limit: 1 })[0]!.detail).toMatchObject({ stoppedHosts: 1, pending: false });
});

for (const cut of ["after-host-target", "after-launch-target"] as const) test(`launch conversion rolls back a crash ${cut}`, async () => {
  const f = await fixture();
  revokeMember(f.store, f.owner.member, f.person.member);
  const event = f.store.events({ actions: ["member.revoked"], limit: 1 })[0]!;
  const receipt = f.registry.spawnReceipt(f.receipt.launchId)!;
  if (receipt.admissionOwner) f.registry.releaseStructuredSpawnAdmissionOwner(receipt.launchId, receipt.admissionOwner);
  f.store.saveRevocationTarget({ id: receipt.launchId, revocationId: event.id, kind: "launch", conversationId: receipt.conversationId,
    key: null, turnId: null, process: null, launchId: receipt.launchId, state: "pending" });
  f.store.markRevocationPlanned(event.id);
  await runChild(f, "reconcile", cut);
  expect(f.store.revocationTargets(event.id)).toMatchObject([{ kind: "launch", state: "pending" }]);
  await runChild(f, "reconcile");
  await runChild(f, "reconcile");
  await f.queue.drain();
  await runChild(f, "reconcile");
  expect(f.store.events({ actions: ["member.revoked"], limit: 1 })[0]!.detail).toMatchObject({ stoppedHosts: 1, pending: false });
});

for (const restart of [false, true]) test(`failed native cleanup retains custody through Stop and restart ${restart}`, async () => {
  const f = await fixture();
  const begun = beginLegacySpawnFixture(f.registry, { engine: "claude", cwd: f.root, transport: "structured", ownStartingActuation: true,
    launchProfile: { workspace: { memberId: f.person.member.id, workspaceId: "workspace-a" } } });
  if (begun.kind !== "created") throw Error("admission failed");
  const beforeInvalidProof = f.registry.spawnReceipt(begun.receipt.launchId);
  expect(() => f.registry.recordStructuredHostSetup(begun.receipt.launchId, begun.receipt.admissionOwner!, { pid: 1, startIdentity: null }))
    .toThrow("structured termination survivor identity is malformed");
  expect(f.registry.spawnReceipt(begun.receipt.launchId)).toEqual(beforeInvalidProof);
  const extra = Bun.spawn([process.execPath, "-e", "console.log('ready'); setInterval(() => {}, 1000)"], { stdout: "pipe", stderr: "ignore" });
  cleanups.push(async () => { if (extra.exitCode === null) extra.kill("SIGKILL"); await extra.exited; });
  const reader = extra.stdout.getReader(); await reader.read(); reader.releaseLock();
  const extraIdentity = captureProcessIdentity(extra.pid);
  const host = new FakeEngineHost(undefined, { status: "active", sessionKey: "unbound", endpoint: "fixture:unbound", pid: extra.pid,
    processStartIdentity: extraIdentity.startIdentity, eventCursor: 0, protocolVersion: "fixture-v1", activeTurnRef: null, pendingAttention: [], activeFlags: [], account: null });
  host.release = async () => { throw Error("injected native cleanup refusal"); };
  await expect(spawnStructuredConversation({ registry: f.registry, client: f.client, receipt: begun.receipt, engine: "claude", prompt: "",
    account: { engine: "claude", accountId: "subscription-a", kind: "legacy", home: f.root, transcriptRoot: f.root, env: { NODE_ENV: "test" } },
    spec: { engine: "claude", command: "claude", cwd: f.root, windowName: "cleanup-failure", launchProfile: begun.receipt.launchProfile },
  }, { startHost: async () => {
    expect((await f.revoke()).status).toBe(202);
    return host as unknown as SpawnedStructuredHost;
  } })).rejects.toThrow();
  expect(f.registry.spawnReceipt(begun.receipt.launchId)?.admissionOwner).not.toBeNull();
  expect(f.store.memberRevocationPending()).toBe(true);
  expect(processIdentityStatus(extraIdentity)).toBe("alive");

  // A recycled PID may belong to another person's process. Its old start
  // token proves that our incarnation ended; it cannot block the live target.
  const peer = Bun.spawn([process.execPath, "-e", "console.log('ready'); setInterval(() => {}, 1000)"], { stdout: "pipe", stderr: "ignore" });
  cleanups.push(async () => { if (peer.exitCode === null) peer.kill("SIGKILL"); await peer.exited; });
  const peerReader = peer.stdout.getReader(); await peerReader.read(); peerReader.releaseLock();
  const peerIdentity = captureProcessIdentity(peer.pid);
  f.registry.recordStructuredHostSetup(begun.receipt.launchId, begun.receipt.admissionOwner!, { ...peerIdentity, startIdentity: "previous-incarnation" });

  if (restart) {
    await runChild(f, "reconcile", "after-setup-release");
    expect(f.store.memberRevocationPending()).toBe(true);
    await runChild(f, "reconcile");
  } else {
    await reconcileMemberRevocations({ store: f.store, registry: f.registry, client: f.client, now: f.nextRecoveryAt, assertActive: () => {} });
  }
  await extra.exited;
  expect(processIdentityStatus(extraIdentity)).toBe("dead");
  expect(processIdentityStatus(peerIdentity)).toBe("alive");
  expect((await f.revoke()).status).toBe(200);
  expect(f.registry.spawnReceipt(begun.receipt.launchId)?.admissionOwner).toBeNull();
  expect(f.store.memberRevocationPending()).toBe(false);
  expect(f.store.events({ actions: ["member.revoked"], limit: 1 })[0]?.detail).toMatchObject({ stoppedHosts: 2, pending: false });
});

test("dead setup owner before exec converges after startup recovery", async () => {
  const f=await fixture();
  const child=Bun.spawn([process.execPath,path.join(import.meta.dir,"fixtures/memberRevocationChild.ts"),"setup-crash",f.person.member.id],{env:{...process.env,LLV_STATE_DIR:f.root},stdout:"pipe",stderr:"pipe"});
  cleanups.push(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");await child.exited;});
  const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect({exit,err}).toEqual({exit:0,err:""});
  const id=out.trim();
  expect([200, 202]).toContain((await f.revoke()).status);
  const {terminalizeStaleStructuredSpawns,recoverPendingStructuredSpawns}=await import("@/lib/runtime/structuredSpawn");
  await terminalizeStaleStructuredSpawns(f.registry,f.client,{now:f.nextRecoveryAt,timeoutMs:0,assertActive:()=>{}});
  await recoverPendingStructuredSpawns(f.registry,f.client,{now:f.nextRecoveryAt,timeoutMs:0,assertActive:()=>{}});
  await runChild(f,"reconcile");
  await runChild(f,"reconcile");
  const receipt=f.registry.spawnReceipt(id)!;
  const restoreResponse=await PATCH(new NextRequest(`http://127.0.0.1:8898/api/team/members/${f.person.member.id}`,{method:"PATCH",headers:{host:"127.0.0.1:8898",cookie:`llv_member=${f.owner.cookie}`,"content-type":"application/json"},body:JSON.stringify({status:"active"})}),{params:Promise.resolve({id:f.person.member.id})});
  expect(receipt.admissionOwner).toBeNull();
  expect(receipt.state).toBe("failed");
  expect(restoreResponse.status).toBe(200);
  expect(f.store.memberRevocationPending()).toBe(false);
});



test("dead setup owner after native exec is recovered by a fresh process before session staging", async () => {
  const f = await fixture();
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/memberRevocationChild.ts"), "setup-exec-crash", f.person.member.id], {
    env: { ...process.env, LLV_STATE_DIR: f.root }, stdout: "pipe", stderr: "pipe",
  });
  cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await child.exited; });
  const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ exit, err: err.replace(/^.*signal-sandbox.*\n/gm, "") }).toEqual({ exit: 71, err: "" });
  const saved = JSON.parse(out) as import("@/lib/agent/registry").SpawnReceipt;
  expect(saved.key).toBeNull();
  expect(saved.hostSetup?.phase).toBe("executing");
  expect(saved.hostSetup?.processes.length).toBeGreaterThan(0);
  expect(processIdentityStatus(saved.admissionOwner!)).toBe("dead");
  cleanups.push(async () => {
    for (const identity of saved.hostSetup!.processes) {
      if (processIdentityStatus(identity) === "alive") await terminateStructuredHostTree({ kind: "structured", ...identity,
        startIdentity: identity.startIdentity!, bootEpoch: identity.bootEpoch ?? null, engine: "claude", sessionId: null,
        conversationId: saved.conversationId, owned: false, seat: false, turnBusy: null, lastActiveAt: null });
    }
  });
  expect(saved.hostSetup!.processes.some(identity => processIdentityStatus(identity) === "alive")).toBe(true);
  await runChild(f, "revoke");
  for (let pass = 0; pass < 4 && f.store.memberRevocationPending(); pass++) {
    await runChild(f, "reconcile");
    await f.queue.drain();
  }
  expect(f.registry.spawnReceipt(saved.launchId)?.admissionOwner).toBeNull();
  expect(saved.hostSetup!.processes.every(identity => processIdentityStatus(identity) === "dead")).toBe(true);
  expect(f.store.memberRevocationPending()).toBe(false);
  expect(f.store.events({ actions: ["member.revoked"], limit: 1 })[0]?.detail).toMatchObject({ stoppedHosts: 2, pending: false });
  expect((await f.revoke()).status).toBe(200);
});

const firstLaunchId = "00000000-0000-0000-0000-000000000002";
const orderedLaunchIds = [firstLaunchId, firstLaunchId.replaceAll("0", "f")];
test.each((["before-release", "after-release", "restart-before-release"] as const).flatMap(order =>
  orderedLaunchIds.map(launchId => ({ order, launchId }))))(
  "durable native custody and revocation preceding owner cleanup preserve exact stop count (%j)", async ({ order, launchId }) => {
  const f = await fixture();
  const uuid = spyOn(crypto, "randomUUID").mockReturnValue(launchId as ReturnType<typeof crypto.randomUUID>);
  const begun = beginLegacySpawnFixture(f.registry, { engine: "claude", cwd: f.root, transport: "structured", ownStartingActuation: true,
    launchProfile: { workspace: { memberId: f.person.member.id, workspaceId: "workspace-a" } } });
  uuid.mockRestore();
  if (begun.kind !== "created") throw Error("admission failed");
  expect(begun.receipt.launchId).toBe(launchId);
  const extra = Bun.spawn([process.execPath, "-e", "console.log('ready'); setInterval(() => {}, 1000)"], { stdout: "pipe", stderr: "ignore" });
  cleanups.push(async () => { if (extra.exitCode === null) extra.kill("SIGKILL"); await extra.exited; });
  const reader = extra.stdout.getReader(); await reader.read(); reader.releaseLock();
  const native = captureProcessIdentity(extra.pid);
  const host = new FakeEngineHost(undefined, { status: "active", sessionKey: "unbound", endpoint: "fixture:unbound", pid: extra.pid,
    processStartIdentity: native.startIdentity, eventCursor: 0, protocolVersion: "fixture-v1", activeTurnRef: null, pendingAttention: [], activeFlags: [], account: null });
  host.release = async () => { if (extra.exitCode === null) extra.kill("SIGTERM"); await extra.exited; };
  const write = f.registry.deliveryWriteOrBusy.bind(f.registry);
  let reconciled = false;
  f.registry.deliveryWriteOrBusy = async (correlation, action) => {
    const result = await write(correlation, action);
    if (correlation.label === "spawn.setup-cleanup") {
      expect(f.registry.spawnReceipt(begun.receipt.launchId)?.hostSetup?.cleanupConfirmed).toBe(true);
      expect(f.registry.spawnReceipt(begun.receipt.launchId)?.admissionOwner).not.toBeNull();
      if (order === "after-release") f.registry.releaseStructuredSpawnAdmissionOwner(begun.receipt.launchId, begun.receipt.admissionOwner!);
      if (order === "restart-before-release") await runChild(f, "reconcile", "after-setup-release");
      // A child reconciler persists commands; the parent fixture delivers them.
      // Either target ordering can leave a kill pending at the crash boundary.
      for (let pass = 0; pass < 8 && f.store.memberRevocationPending(); pass++) {
        await f.queue.drain();
        await reconcileMemberRevocations({ store: f.store, registry: f.registry, client: f.client, now: f.nextRecoveryAt, assertActive: () => {} });
      }
      expect(f.store.memberRevocationPending()).toBe(false);
      reconciled = true;
    }
    return result;
  };
  await expect(spawnStructuredConversation({ registry: f.registry, client: f.client, receipt: begun.receipt, engine: "claude", prompt: "",
    account: { engine: "claude", accountId: "subscription-a", kind: "legacy", home: f.root, transcriptRoot: f.root, env: { NODE_ENV: "test" } },
    spec: { engine: "claude", command: "claude", cwd: f.root, windowName: "cleanup-race", launchProfile: begun.receipt.launchProfile },
  }, { startHost: async () => {
    f.registry.recordStructuredHostSetup(begun.receipt.launchId, begun.receipt.admissionOwner!, native);
    revokeMember(f.store, f.owner.member, f.person.member);
    return host as unknown as SpawnedStructuredHost;
  } })).rejects.toThrow("member access revoked");
  expect(reconciled).toBe(true);
  expect(processIdentityStatus(native)).toBe("dead");
  expect(f.store.events({ actions: ["member.revoked"], limit: 1 })[0]!.detail).toMatchObject({ stoppedHosts: 2, pending: false });
  const commands = [...f.commands];
  await runChild(f, "reconcile");
  expect((await f.revoke()).status).toBe(200);
  expect(f.commands).toEqual(commands);
  expect(f.store.events({ actions: ["member.revoked"], limit: 1 })[0]!.detail).toMatchObject({ stoppedHosts: 2, heldLaunches: 0, pending: false });
});

test.each((["claude", "codex"] as const).flatMap(engine => [false, true].map(nullRoot => ({ engine, nullRoot }))))(
  "boot adoption retains the replacement through revoke and Viewer loss (%j)", async ({ engine, nullRoot }) => {
  const f = await fixture(0, engine);
  f.child.kill("SIGTERM"); await f.child.exited;
  const entry = f.registry.hostEntry(f.key)!;
  f.registry.upsert({ ...entry, status: "unhosted", claimOwner: null,
    structuredHost: { ...entry.structuredHost!, ...(nullRoot ? { process: null } : {}), writerClaimEpoch: 0 } });
  const old = f.registry.spawnReceipt(f.receipt.launchId)!;
  if (old.admissionOwner) f.registry.releaseStructuredSpawnAdmissionOwner(old.launchId, old.admissionOwner);
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/memberRevocationChild.ts"), "adoption-exec-crash", f.person.member.id, engine], {
    env: { ...process.env, LLV_STATE_DIR: f.root }, stdout: "pipe", stderr: "pipe",
  });
  cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await child.exited; });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, err: err.replace(/^.*signal-sandbox.*\n/gm, "") }).toEqual({ code: 71, err: "" });
  const native = JSON.parse(out) as import("@/lib/processIdentity").ProcessIdentity;
  cleanups.push(async () => { if (processIdentityStatus(native) === "alive") await terminateStructuredHostTree({ kind: "structured", ...native,
    startIdentity: native.startIdentity!, bootEpoch: native.bootEpoch ?? null, engine, sessionId: null, conversationId: null,
    owned: false, seat: false, turnBusy: null, lastActiveAt: null }); });
  expect(processIdentityStatus(native)).toBe("alive");
  const custody = f.registry.spawnReceipt(f.receipt.launchId)!.hostSetup;
  expect(custody?.phase).toBe("executing");
  const claimEpoch = f.registry.hostEntry(f.key)!.claimEpoch;
  let reopened = false;
  const retry = engine === "claude" ? adoptClaudeRegistryHosts : adoptCodexRegistryHosts;
  await retry(f.registry, () => ({ cwd: f.root, env: process.env }), { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" },
    () => true, undefined, { adoptHost: async () => { reopened = true; throw Error("unsettled adoption reopened"); } });
  expect(reopened).toBe(false);
  expect(f.registry.hostEntry(f.key)!.claimEpoch).toBe(claimEpoch);
  expect(f.registry.spawnReceipt(f.receipt.launchId)!.hostSetup).toEqual(custody);
  await runChild(f, "reconcile");
  await runChild(f, "reconcile");
  expect(processIdentityStatus(native)).toBe("dead");
  expect((await f.revoke()).status).toBe(200);
  expect(f.store.memberRevocationPending()).toBe(false);
  expect(f.store.events({ actions: ["member.revoked"], limit: 1 })[0]!.detail).toMatchObject({ stoppedHosts: 1, pending: false });
  restoreMember(f.store, f.owner.member, f.store.member(f.person.member.id)!);
  await runChild(f, "reconcile");
  expect(processIdentityStatus(native)).toBe("dead");
});

test.each((["claude", "codex"] as const).flatMap(engine => [false, true].map(deferred => ({ engine, deferred }))))(
  "boot adoption transfers custody only at a successful checkpoint (%j)", async ({ engine, deferred }) => {
  const f = await fixture(0, engine);
  f.child.kill("SIGTERM"); await f.child.exited;
  const old = f.registry.hostEntry(f.key)!;
  f.registry.upsert({ ...old, status: "unhosted", claimOwner: null,
    structuredHost: { ...old.structuredHost!, writerClaimEpoch: 0 } });
  const { spawnManagedEngine } = await import("@/lib/runtime/agentSignalSandbox");
  let native!: import("node:child_process").ChildProcess;
  let exited!: Promise<void>;
  let host!: FakeEngineHost;
  let failCheckpoint = deferred;
  const persist = f.registry.setStructuredHostClaimed.bind(f.registry);
  const checkpoint = spyOn(f.registry, "setStructuredHostClaimed").mockImplementation((...args) => {
    if (failCheckpoint && args[1].process?.pid === native?.pid) {
      failCheckpoint = false;
      throw Error("checkpoint storage temporarily unavailable");
    }
    return persist(...args);
  });
  cleanups.push(() => checkpoint.mockRestore());
  const adoptHost = async (_id: string, options: { assertCurrent?: () => void }) => {
    native = await spawnManagedEngine(process.execPath, ["--no-env-file", "-e", "console.log('ready'); setInterval(() => {}, 1000)"],
      { cwd: f.root, env: process.env, detached: true }, null, undefined, process.env, undefined, options.assertCurrent);
    exited = new Promise(resolve => native.once("exit", () => resolve()));
    cleanups.push(async () => { if (native.exitCode === null && native.signalCode === null) native.kill("SIGKILL"); await exited; });
    await new Promise<void>(resolve => native.stdout!.once("data", () => resolve()));
    const identity = captureProcessIdentity(native.pid!);
    host = Object.assign(new FakeEngineHost(undefined, { status: "idle", sessionKey: f.key.sessionId, endpoint: `stdio:${native.pid}`,
      pid: native.pid!, processStartIdentity: identity.startIdentity, eventCursor: 1, protocolVersion: "fixture-v1", activeTurnRef: null,
      pendingAttention: [], activeFlags: [], account: null }), {
      setWriterFence: () => {}, onStateChange: () => () => {},
    });
    return host as unknown as import("@/lib/runtime/claudeStreamBrokerHost").ClaudeStreamBrokerHost
      & import("@/lib/runtime/codexAppServerHost").CodexAppServerHost;
  };
  const adopt = engine === "claude" ? adoptClaudeRegistryHosts : adoptCodexRegistryHosts;
  const adopted = await adopt(f.registry, () => ({ cwd: f.root, env: process.env }), { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" },
    () => true, undefined, { adoptHost });
  expect(adopted).toHaveLength(1);
  if (deferred) {
    expect(f.registry.spawnReceipt(f.receipt.launchId)?.hostSetup?.phase).toBe("executing");
    expect(f.registry.hostEntry(f.key)?.structuredHost?.process).toEqual(old.structuredHost!.process);
    await flushStructuredHostPersistence(host);
  }
  expect(f.registry.spawnReceipt(f.receipt.launchId)?.hostSetup).toBeUndefined();
  expect(f.registry.spawnReceipt(f.receipt.launchId)?.admissionOwner).toBeNull();
  expect(f.registry.hostEntry(f.key)?.structuredHost?.process?.pid).toBe(native.pid!);
  expect((await f.revoke()).status).toBe(200);
  await exited;
  expect(f.store.events({ actions: ["member.revoked"], limit: 1 })[0]!.detail).toMatchObject({ stoppedHosts: 1, pending: false });
});

async function crashMemberAdoption(engine: "claude" | "codex", phase: "preparing" | "executing") {
  const f = await fixture(0, engine);
  f.child.kill("SIGTERM"); await f.child.exited;
  const old = f.registry.hostEntry(f.key)!;
  f.registry.upsert({ ...old, status: "unhosted", claimOwner: null,
    structuredHost: { ...old.structuredHost!, process: null, writerClaimEpoch: 0 } });
  const mode = phase === "preparing" ? "adoption-preparing-crash" : "adoption-active-exec-crash";
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/memberRevocationChild.ts"), mode, f.person.member.id, engine], {
    env: { ...process.env, LLV_STATE_DIR: f.root }, stdout: "pipe", stderr: "pipe",
  });
  cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await child.exited; });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, err: err.replace(/^.*signal-sandbox.*\n/gm, "") }).toEqual({ code: 71, err: "" });
  const saved = JSON.parse(out) as import("@/lib/agent/registry").SpawnReceipt;
  cleanups.push(async () => {
    for (const native of saved.hostSetup!.processes) if (processIdentityStatus(native) === "alive")
      await terminateStructuredHostTree({ kind: "structured", ...native, startIdentity: native.startIdentity!, bootEpoch: native.bootEpoch ?? null,
        engine, sessionId: null, conversationId: saved.conversationId, owned: false, seat: false, turnBusy: null, lastActiveAt: null });
  });
  expect(saved.hostSetup?.phase).toBe(phase);
  expect(processIdentityStatus(saved.admissionOwner!)).toBe("dead");
  return { ...f, saved, predecessor: old.structuredHost!.process };
}

test.each((["claude", "codex"] as const).flatMap(engine => (["preparing", "executing"] as const).map(phase => ({ engine, phase }))))(
  "active member adoption recovers dead setup custody on restart (%j)", async ({ engine, phase }) => {
  const f = await crashMemberAdoption(engine, phase);
  const adopt = engine === "claude" ? adoptClaudeRegistryHosts : adoptCodexRegistryHosts;
  let opened = 0;
  await adopt(f.registry, () => ({ cwd: f.root, env: process.env }), { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" },
    () => true, undefined, { adoptHost: async () => {
      opened++;
      expect(f.saved.hostSetup!.processes.every(native => processIdentityStatus(native) === "dead")).toBe(true);
      throw Error("fixture stops before replacement exec");
    } });
  expect(opened).toBe(1);
  expect(f.registry.hostEntry(f.key)!.claimEpoch).toBeGreaterThan(f.saved.hostSetup!.adoptionClaimEpoch!);
  expect(f.registry.spawnReceipt(f.saved.launchId)?.admissionOwner).toBeNull();
  expect(f.store.member(f.person.member.id)?.status).toBe("active");
  expect(f.store.memberRevocationPending()).toBe(false);
});

test.each(["claude", "codex"] as const)("every claimant preserves unfinished adoption custody (%s)", async engine => {
  const f = await crashMemberAdoption(engine, "executing");
  const staged = f.registry.hostEntry(f.key)!;
  f.registry.upsert({ ...staged, structuredHostOperationId: f.saved.launchId,
    structuredHost: { ...staged.structuredHost!, process: f.predecessor } });
  const before = f.registry.hostEntry(f.key)!;
  const owner = captureProcessIdentity(process.pid);
  expect(f.registry.claimStructuredHost(f.key, owner, { allowUnhosted: true })).toBeNull();
  expect(() => f.registry.claim(f.key, before.claimOwner!)).toThrow("structured adoption cleanup is pending");
  expect(f.registry.releaseStructuredSpawnAdmissionOwner(f.saved.launchId, f.saved.admissionOwner!).released).toBe(false);
  expect(f.registry.hostEntry(f.key)).toEqual(before);
  expect(f.registry.spawnReceipt(f.saved.launchId)).toEqual(f.saved);
  const successor = beginLegacySpawnFixture(f.registry, { engine, cwd: f.root, transport: "structured", purpose: "resume-successor",
    conversationId: f.saved.conversationId, launchProfile: f.saved.launchProfile });
  if (successor.kind !== "created") throw Error("successor admission failed");
  expect(f.registry.stageStructuredSpawn(successor.receipt.launchId, { ...before, claimEpoch: before.claimEpoch + 1 })).toMatchObject({
    kind: "conflict", code: "spawn_identity_conflict",
  });
  expect(f.registry.hostEntry(f.key)).toEqual(before);
  expect(f.registry.spawnReceipt(f.saved.launchId)).toEqual(f.saved);
});

test.each(["claude", "codex"] as const)("explicit resume retires crashed adoption before changing its claim (%s)", async engine => {
  const f = await crashMemberAdoption(engine, "executing");
  const begun = beginLegacySpawnFixture(f.registry, { engine, cwd: f.root, transport: "structured", purpose: "resume-successor",
    conversationId: f.saved.conversationId, launchProfile: f.saved.launchProfile });
  if (begun.kind !== "created") throw Error("resume fixture admission failed");
  let opened = 0;
  let replacement!: import("node:child_process").ChildProcess;
  let replacementExited!: Promise<void>;
  const resumed = await spawnStructuredConversation({ registry: f.registry, client: f.client, receipt: begun.receipt, engine, prompt: "",
    account: { engine, accountId: "subscription-a", kind: "legacy", home: f.root, transcriptRoot: f.root, env: { NODE_ENV: "test" } },
    spec: { engine, command: engine, cwd: f.root, windowName: "resume-adoption", transcript: f.saved.artifactPath!, launchProfile: begun.receipt.launchProfile },
  }, { startHost: async () => {
    opened++;
    expect(f.saved.hostSetup!.processes.every(native => processIdentityStatus(native) === "dead")).toBe(true);
    expect(f.registry.spawnReceipt(f.saved.launchId)?.hostSetup?.cleanupConfirmed).toBe(true);
    const { spawnManagedEngine } = await import("@/lib/runtime/agentSignalSandbox");
    replacement = await spawnManagedEngine(process.execPath, ["--no-env-file", "-e", "console.log('ready'); setInterval(() => {}, 1000)"],
      { cwd: f.root, env: process.env, detached: true }, null);
    replacementExited = new Promise(resolve => replacement.once("exit", () => resolve()));
    cleanups.push(async () => { if (replacement.exitCode === null && replacement.signalCode === null) replacement.kill("SIGKILL"); await replacementExited; });
    await new Promise<void>(resolve => replacement.stdout!.once("data", () => resolve()));
    const native = captureProcessIdentity(replacement.pid!);
    const host = Object.assign(new FakeEngineHost(undefined, { status: "idle", sessionKey: f.key.sessionId, endpoint: `stdio:${native.pid}`,
      pid: native.pid, processStartIdentity: native.startIdentity, eventCursor: 1, protocolVersion: "fixture-v1", activeTurnRef: null,
      pendingAttention: [], activeFlags: [], account: null }), {
      identity: { sessionId: f.key.sessionId, threadId: f.key.sessionId, path: f.saved.artifactPath },
      setWriterFence: () => {}, onStateChange: () => () => {},
    });
    return host as unknown as SpawnedStructuredHost;
  }, publishHost: async () => async () => {}, deliverFirst: async () => {} });
  expect(resumed.ok).toBe(true);
  expect(opened).toBe(1);
  expect(processIdentityStatus(captureProcessIdentity(replacement.pid!))).toBe("alive");
  f.restartRuntime();
  await runChild(f, "revoke");
  for (let pass = 0; pass < 4 && f.store.memberRevocationPending(); pass++) {
    await runChild(f, "reconcile");
    await f.queue.drain();
  }
  await replacementExited;
  expect(f.saved.hostSetup!.processes.every(native => processIdentityStatus(native) === "dead")).toBe(true);
  expect(f.registry.spawnReceipt(f.saved.launchId)?.hostSetup?.processes).toEqual(f.saved.hostSetup!.processes);
  expect(f.store.memberRevocationPending()).toBe(false);
  expect(f.store.events({ actions: ["member.revoked"], limit: 1 })[0]?.detail).toMatchObject({ stoppedHosts: 1, pending: false });
});

test.each((["claude", "codex"] as const).flatMap(engine => (["preparing", "executing"] as const).map(phase => ({ engine, phase }))))(
  "live member adoption custody is preserved (%j)", async ({ engine, phase }) => {
  const { recoverMemberAdoption } = await import("@/lib/runtime/memberAdoptionRecovery");
  const f = await fixture(0, engine);
  f.child.kill("SIGTERM"); await f.child.exited;
  const old = f.registry.hostEntry(f.key)!;
  f.registry.upsert({ ...old, status: "unhosted", claimOwner: null, structuredHost: { ...old.structuredHost!, process: null } });
  const owner = captureProcessIdentity(process.pid);
  const claim = f.registry.claimStructuredHost(f.key, owner, { allowUnhosted: true })!;
  f.registry.beginStructuredHostAdoption(f.receipt.launchId, f.key, owner, claim.claimEpoch);
  if (phase === "executing") f.registry.recordStructuredHostSetup(f.receipt.launchId, owner, old.structuredHost!.process!);
  const before = f.registry.spawnReceipt(f.receipt.launchId);
  expect(await recoverMemberAdoption(f.registry, f.key)).toBe(false);
  expect(f.registry.spawnReceipt(f.receipt.launchId)).toEqual(before);
  expect(f.registry.hostEntry(f.key)).toEqual(claim);
});

test.each(["adoption.recovery-tree", "adoption.recovery-cleanup"])(
  "adoption recovery rechecks custody after writer admission (%s)", async boundary => {
  const { recoverMemberAdoption } = await import("@/lib/runtime/memberAdoptionRecovery");
  const f = await crashMemberAdoption("claude", "executing");
  const write = f.registry.deliveryWriteOrBusy.bind(f.registry);
  f.registry.deliveryWriteOrBusy = async (correlation, action) => {
    if (correlation.label === boundary) {
      if (boundary === "adoption.recovery-tree") {
        const result = await write(correlation, action);
        f.registry.upsert({ ...f.registry.hostEntry(f.key)!, claimOwner: "replacement-writer" });
        return result;
      }
      f.registry.upsert({ ...f.registry.hostEntry(f.key)!, claimOwner: "replacement-writer" });
    }
    return write(correlation, action);
  };
  await expect(recoverMemberAdoption(f.registry, f.key)).rejects.toThrow("member adoption recovery custody changed");
  expect(f.registry.spawnReceipt(f.saved.launchId)?.hostSetup?.cleanupConfirmed).not.toBe(true);
  expect(f.registry.spawnReceipt(f.saved.launchId)?.admissionOwner).toEqual(f.saved.admissionOwner);
  if (boundary === "adoption.recovery-tree")
    expect(f.saved.hostSetup!.processes.some(native => processIdentityStatus(native) === "alive")).toBe(true);
});
