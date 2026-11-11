import crypto from "node:crypto";
import { agentRegistry, type AgentRegistry, type AgentRegistryEntry } from "@/lib/agent/registry";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import { processIdentityStatus } from "@/lib/processIdentity";
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

async function settleTarget(store: TeamStore, registry: AgentRegistry, client: RuntimeHostClient | null,
  revocation: MemberRevocation, target: MemberRevocationTarget, assertActive: () => void): Promise<void> {
  if (target.state !== "pending") return;
  assertActive();
  if (target.kind === "launch") {
    const receipt = registry.spawnReceipt(target.id);
    if (!receipt || receipt.state === "failed" || receipt.state === "conflicted") {
      if (receipt?.hostSetupStartedAt && receipt.admissionOwner) throw new Error("revoked launch host setup cleanup is not confirmed");
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
      if (current?.hostSetupStartedAt && current.admissionOwner) throw new Error("revoked launch host setup cleanup is not confirmed");
      target.state = "held";
    }
    store.saveRevocationTarget(target);
    return;
  }
  if (!target.key) throw new Error("revoked host has no generation fence");
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
