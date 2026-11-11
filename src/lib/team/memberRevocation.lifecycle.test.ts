import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
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
import { claimInstall, createInvite, redeemJoin } from "./members";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { teamStore, resetTeamStoreForTests } from "./store";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
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
  const begun = beginLegacySpawnFixture(registry, { engine: "claude", cwd: root, transport: "structured",
    launchProfile: { workspace: { memberId: person.member.id, workspaceId: "workspace-a" } } });
  if (begun.kind !== "created") throw Error("fixture admission failed");
  const key = { engine: "claude" as const, sessionId: "00000000-0000-0000-0000-000000000001" };
  const columns = { ...structuredHostFixture(identity), activeTurnRef: "turn-a" };
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
  return { root, store, owner, person, registry, child, interrupts, revoke, client, commands, key, queue,
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
