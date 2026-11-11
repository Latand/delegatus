import crypto from "node:crypto";
import { agentRegistry, type AgentRegistry, type AgentRegistryEntry, type SpawnReceipt } from "@/lib/agent/registry";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import { processIdentityStatus, sameRecordedProcessIdentity } from "@/lib/processIdentity";
import { terminateStructuredHostTree } from "@/lib/runtime/structuredHostControl";
import { runtimeHostClient, type RuntimeHostClient } from "@/lib/runtime/client";
import { kickStructuredDeliveryQueue } from "@/lib/runtime/structuredDeliverySignal";
import { viewerReleaseOwnsTraffic } from "@/lib/viewerReleaseTraffic";
import { existingTeamStore, type TeamStore, type MemberRevocation, type MemberRevocationTarget } from "./store";

import { MEMBER_REVOCATION_HOLD } from "./memberLaunchAuthority";

function controlId(target: MemberRevocationTarget, kind: "interrupt" | "kill"): string {
  const base = `member-revocation-${kind}-${crypto.createHash("sha256").update(`${target.revocationId}:${target.id}`).digest("hex")}`;
  return kind === "kill" && target.stopAttempt ? `${base}-${target.stopAttempt}` : base;
}

function hostPrincipal(registry: AgentRegistry, entry: AgentRegistryEntry | null) {
  if (entry?.launchProfile) return entry.launchProfile.workspace;
  return entry && registry.conversationForPath(entry.artifactPath)?.generations
    .find(generation => generation.id === entry.key.sessionId || generation.path === entry.artifactPath)?.launchProfile.workspace;
}

function memberOwnsHost(registry: AgentRegistry, entry: AgentRegistryEntry | null, memberId: string): boolean {
  const principal = hostPrincipal(registry, entry);
  return principal?.memberId === memberId && !principal.fromMessage;
}

function plan(store: TeamStore, registry: AgentRegistry, revocation: MemberRevocation): void {
  const targets: MemberRevocationTarget[] = [];
  for (const receipt of registry.memberLaunchReceipts(revocation.memberId)) {
    if (receipt.launchProfile.workspace?.memberId !== revocation.memberId || receipt.launchProfile.workspace.fromMessage || receipt.key) continue;
    targets.push({ id: receipt.launchId, revocationId: revocation.id, kind: "launch", conversationId: receipt.conversationId,
      key: null, turnId: null, process: null, launchId: receipt.launchId, state: "pending" });
  }
  // This indexed selection visits hosted rows, never retained conversation history.
  for (const entry of registry.memberHostEntries(revocation.memberId)) {
    const conversation = registry.conversationForPath(entry.artifactPath);
    const generation = conversation?.generations.find(generation => generation.id === entry.key.sessionId || generation.path === entry.artifactPath);
    const principal = hostPrincipal(registry, entry);
    if (principal?.memberId !== revocation.memberId || principal.fromMessage) continue;
    if (!conversation || !generation) throw new Error("revoked host conversation ownership is unavailable");
    targets.push({ id: sessionKeyId(entry.key), revocationId: revocation.id, kind: "host", conversationId: conversation.id,
      key: entry.key, turnId: entry.structuredHost?.activeTurnRef ?? null, process: entry.structuredHost?.process ?? null,
      launchId: entry.structuredHostOperationId ?? null, state: "pending" });
  }
  store.transaction(() => {
    for (const target of targets) store.saveRevocationTarget(target);
    store.markRevocationPlanned(revocation.id);
  });
}

function recordStoppedTarget(store: TeamStore, registry: AgentRegistry, target: MemberRevocationTarget): void {
  if (!target.process && target.launchId && registry.spawnReceipt(target.launchId)?.admissionOwner)
    throw new Error("revoked launch host setup cleanup is not confirmed");
  // A provisional row with no recorded native process is not a stopped host.
  target.state = target.process ? "stopped" : "gone";
  store.saveRevocationTarget(target);
}

/** Pre-session engines use the same Stop ladder as registered generations.
 * Persist its captured descendants on the receipt before the first effect,
 * so losing either the owner or the response cannot lose a surviving child. */
async function settleSetup(store: TeamStore, registry: AgentRegistry, receipt: SpawnReceipt,
  revocation: MemberRevocation, target: MemberRevocationTarget, assertActive: () => void): Promise<boolean> {
  const owner = receipt.admissionOwner;
  if (!receipt.hostSetupStartedAt) return false;
  if (receipt.launchProfile.workspace?.memberId !== revocation.memberId || receipt.launchProfile.workspace.fromMessage)
    throw new Error("revoked setup launch principal changed");
  const launchIdentity = [receipt.launchId, receipt.conversationId, receipt.engine, receipt.createdAt, receipt.memberRevocationId];
  const setup = receipt.hostSetup;
  if (!owner) {
    assertActive();
    if (setup?.cleanupConfirmed && setup.processes.length
      && setup.processes.every(process => processIdentityStatus(process) === "dead")) {
      target.process ??= setup.processes[0]!;
      target.state = "stopped";
      store.saveRevocationTarget(target);
      return true;
    }
    if (setup?.phase === "executing" && !setup.cleanupConfirmed)
      throw new Error("revoked setup lost cleanup ownership");
    return false;
  }
  const check = () => {
    assertActive();
    const current = registry.spawnReceipt(receipt.launchId);
    if (!current || (current.key && registry.hostEntry(current.key)?.structuredHost?.process)
      || JSON.stringify([current.launchId, current.conversationId, current.engine, current.createdAt, current.memberRevocationId]) !== JSON.stringify(launchIdentity)
      || JSON.stringify(current.key) !== JSON.stringify(receipt.key) || current.launchProfile.workspace?.memberId !== revocation.memberId
      || current.launchProfile.workspace.fromMessage || !current.admissionOwner
      || !sameRecordedProcessIdentity(current.admissionOwner, owner)
      || JSON.stringify(current.hostSetup) !== JSON.stringify(receipt.hostSetup))
      throw new Error("revoked setup custody changed");
    return current;
  };
  check();
  if (!setup || setup.phase === "preparing") {
    // Legacy evidence cannot prove whether exec happened. Current writers
    // record `preparing` before any native adapter is invoked.
    if (!setup || processIdentityStatus(owner) !== "dead") throw new Error("revoked launch host setup cleanup is not confirmed");
  } else if (!setup.cleanupConfirmed) {
    if (!setup.processes.length) throw new Error("revoked launch native setup evidence is not yet available");
    for (const native of [...setup.processes]) {
      check();
      if (processIdentityStatus(native) === "dead") continue;
      if (!native.startIdentity) throw new Error("revoked launch native identity cannot be verified");
      target.process ??= native;
      store.saveRevocationTarget(target);
      const stopped = await terminateStructuredHostTree({ kind: "structured", ...native, startIdentity: native.startIdentity,
        bootEpoch: native.bootEpoch ?? null, engine: receipt.engine, sessionId: null, conversationId: receipt.conversationId,
        seat: false, turnBusy: null, owned: false, lastActiveAt: receipt.hostSetupStartedAt }, {
        retainedSurvivors: setup.processes.filter(process => processIdentityStatus(process) !== "dead"),
        authorize: () => { check(); return null; },
        persistCapturedTree: identities => registry.deliveryWriteOrBusy({ label: "revocation.setup-tree", operationId: receipt.launchId }, () => {
          check();
          for (const identity of identities) registry.recordStructuredHostSetup(receipt.launchId, owner, identity);
          receipt = registry.spawnReceipt(receipt.launchId)!;
          return true;
        }),
      });
      assertActive();
      if (!stopped.ok) throw new Error(stopped.error);
    }
  }
  await registry.deliveryWriteOrBusy({ label: "revocation.setup-settled", operationId: receipt.launchId }, () => {
    check();
    registry.confirmStructuredHostSetupCleanup(receipt.launchId, owner);
    if (!registry.releaseStructuredSpawnAdmissionOwner(receipt.launchId, owner).released)
      throw new Error("revoked setup cleanup release is not confirmed");
  });
  assertActive();
  if (target.process) { target.state = "stopped"; store.saveRevocationTarget(target); return true; }
  return false;
}

async function settleTarget(store: TeamStore, registry: AgentRegistry, client: RuntimeHostClient | null,
  revocation: MemberRevocation, target: MemberRevocationTarget, assertActive: () => void): Promise<void> {
  if (target.state !== "pending") return;
  assertActive();
  if (target.kind === "launch") {
    const receipt = registry.spawnReceipt(target.id);
    if (!receipt || receipt.state === "failed" || receipt.state === "conflicted") {
      if (receipt && await settleSetup(store, registry, receipt, revocation, target, assertActive)) return;
      target.state = receipt?.error === MEMBER_REVOCATION_HOLD ? "held" : "gone";
    } else if (receipt.key) {
      const entry = registry.hostEntry(receipt.key);
      if (!entry || !memberOwnsHost(registry, entry, revocation.memberId)) throw new Error("revoked launch host identity changed");
      store.transaction(() => {
        store.saveRevocationTarget({ id: sessionKeyId(receipt.key!), revocationId: revocation.id, kind: "host", conversationId: receipt.conversationId,
          key: receipt.key!, turnId: entry.structuredHost?.activeTurnRef ?? null, process: entry.structuredHost?.process ?? null, launchId: receipt.launchId, state: "pending" });
        store.saveRevocationTarget({ ...target, state: "gone" });
      });
      return;
    } else {
      const held = await registry.failSpawnOffLoop(target.id, MEMBER_REVOCATION_HOLD, () => {
        assertActive();
        const current = registry.spawnReceipt(target.id);
        if (!current || current.key || current.launchProfile.workspace?.memberId !== revocation.memberId || current.launchProfile.workspace.fromMessage)
          throw new Error("revoked launch identity changed");
      });
      assertActive();
      if (!held) throw new Error("revoked launch hold is pending");
      const current = registry.spawnReceipt(target.id);
      if (current && await settleSetup(store, registry, current, revocation, target, assertActive)) return;
      target.state = "held";
    }
    store.saveRevocationTarget(target);
    return;
  }
  if (!target.key) throw new Error("revoked host has no generation fence");
  const provisional = registry.hostEntry(target.key);
  if (provisional?.structuredHost && !provisional.structuredHost.process && target.launchId) {
    const receipt = registry.spawnReceipt(target.launchId);
    if (receipt && await settleSetup(store, registry, receipt, revocation, target, assertActive)) return;
  }
  if (!client) throw new Error("runtime host is unavailable; revocation remains pending");
  let stopId = controlId(target, "kill");
  let stopped = await client.operationStatus(stopId);
  assertActive();
  if (stopped?.receipt.status === "delivered") {
    recordStoppedTarget(store, registry, target);
    return;
  }
  const current = registry.hostEntry(target.key);
  if (!current?.structuredHost && !current?.structuredTerminationSurvivors?.length && !stopped) {
    target.state = "gone";
    store.saveRevocationTarget(target);
    return;
  }
  if (!memberOwnsHost(registry, current, revocation.memberId)) throw new Error("revoked host launch principal changed");
  if (stopped?.receipt.status === "failed" || stopped?.receipt.status === "rejected") {
    // A terminal refusal has no pending effect to replay. Persist the next
    // command identity before dispatch so restart reuses that exact attempt.
    target.stopAttempt = (target.stopAttempt ?? 0) + 1;
    store.saveRevocationTarget(target);
    stopId = controlId(target, "kill");
    stopped = null;
  }
  if (!stopped) {
    const survivors = current?.structuredTerminationSurvivors ?? [];
    if (target.process && processIdentityStatus(target.process) === "dead"
      && survivors.every(identity => processIdentityStatus(identity) === "dead")) {
      target.state = "gone";
      store.saveRevocationTarget(target);
      return;
    }
    // The same durable commands as the conversation control route. The journal
    // replays their receipts after either process restarts; no new signal path.
    const interruptId = controlId(target, "interrupt");
    await client.command({ kind: "interrupt", operationId: interruptId, idempotencyKey: interruptId,
      conversationId: target.conversationId, turnId: target.turnId, origin: { kind: "operator" } });
    assertActive();
    if (!memberOwnsHost(registry, registry.hostEntry(target.key), revocation.memberId))
      throw new Error("revoked host launch principal changed during interrupt");
    await client.command({ kind: "kill", operationId: stopId, idempotencyKey: stopId,
      conversationId: target.conversationId, sessionKey: target.key, origin: { kind: "operator" } });
    assertActive();
  }
  kickStructuredDeliveryQueue();
  stopped = await client.operationStatus(stopId);
  assertActive();
  if (stopped?.receipt.status !== "delivered") throw new Error(stopped?.receipt.reason ?? "revoked host termination is not confirmed");
  recordStoppedTarget(store, registry, target);
}

interface RevocationPorts { store?: TeamStore; registry?: AgentRegistry; client?: RuntimeHostClient | null; now?: () => number; assertActive?: () => void }
const KEY = Symbol.for("delegatus.memberRevocations");
type Worker = { running?: Promise<boolean>; timer?: ReturnType<typeof setTimeout> };
function worker(): Worker { return (globalThis as typeof globalThis & { [KEY]?: Worker })[KEY] ??= {}; }

/** One bounded pass, called after revocation and independently on Viewer boot. */
export function reconcileMemberRevocations(ports: RevocationPorts = {}): Promise<boolean> {
  const state = worker();
  if (state.running) return state.running;
  state.running = reconcile(ports).finally(() => { state.running = undefined; });
  return state.running;
}

async function reconcile(ports: RevocationPorts): Promise<boolean> {
  const store = ports.store ?? existingTeamStore();
  if (!store) return true;
  const now = ports.now ?? Date.now;
  const pending = store.pendingMemberRevocations(now());
  if (!pending.length) return !store.memberRevocationPending();
  const registry = ports.registry ?? agentRegistry();
  const client = ports.client !== undefined ? ports.client : runtimeHostClient();
  const assertActive = ports.assertActive ?? (() => {
    if (!viewerReleaseOwnsTraffic()) throw new Error("revocation lost Viewer release authority");
  });
  const deadline = performance.now() + 250;
  let complete = true;
  for (const revocation of pending) {
    let error: string | null = null;
    try {
      assertActive();
      if (!revocation.planned) { plan(store, registry, revocation); revocation.planned = true; }
      for (const target of store.revocationTargets(revocation.id, now())) {
        try { await settleTarget(store, registry, client, revocation, target, assertActive); }
        catch (cause) {
          error = cause instanceof Error ? cause.message.slice(0, 240) : "revocation unavailable";
          store.deferRevocationTarget(revocation.id, target.id, now() + 5_000);
        }
        if (performance.now() >= deadline) break;
      }
    } catch (cause) { error = cause instanceof Error ? cause.message.slice(0, 240) : "revocation unavailable"; }
    const done = !error && revocation.planned !== false && !store.revocationTargetsPending(revocation.id);
    store.settleRevocationProgress(revocation.id, done, error, now());
    complete &&= done;
    if (performance.now() >= deadline) break;
  }
  return complete && !store.memberRevocationPending();
}

export function startMemberRevocationWorker(): void {
  const state = worker();
  if (state.timer) return;
  const tick = async () => {
    try { if (viewerReleaseOwnsTraffic()) await reconcileMemberRevocations(); }
    catch { console.error("[team revocation] recovery remains pending"); }
    state.timer = setTimeout(tick, 1_000);
    state.timer.unref?.();
  };
  state.timer = setTimeout(tick, 0);
  state.timer.unref?.();
}
