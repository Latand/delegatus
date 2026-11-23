import fs from "node:fs";
import { procBackend } from "@/lib/proc";
import { bridgeDirectiveBody } from "@/lib/bridge/directive";
import type { MessageOrigin } from "@/lib/runtime/messageOrigin";
import { agentRegistry } from "@/lib/agent/registry";
import { canonicalOrchestratorProject } from "@/lib/orchestrator/seats";
import { seatIdentityResolver } from "@/lib/bridge/seatIdentity";
import { externalRelayFile, runHoldsConversation, type PairedRelay, type RunLedger, type RelayStore, type RunRecord } from "./store";
import type { ExternalRelayCompletion } from "./protocol";
import { isOwnerRequestTimeoutReply } from "./requestTimeout";
import { bindRequesterEntry, canonicalRelayProject, legacyRequesterId, pairedOwnerTier, requesterEntries } from "./trustedRequesters";
import { requesterLeaseActive, requesterLeaseUntilAsync } from "./requesterLease";

function currentRunEntry(run: RunRecord, relay: PairedRelay, relays: readonly PairedRelay[]) {
  const target = relay.targets.find(item => item.id === run.targetId);
  if (!run.ownerTurn || relay.paused !== false || target?.enabled !== true) return null;
  const saved = run.ownerTurn.entry;
  const entry = requesterEntries(relay, target).find(entry => entry.id === (saved?.id ?? legacyRequesterId(target.id)));
  if (!entry || canonicalRelayProject(entry.project) !== canonicalRelayProject(target.project)) return null;
  if (!saved && (entry.kind !== "paired-owner" || entry.source !== "earlier-switch")) return null;
  const current = bindRequesterEntry(relay, entry, relays);
  if (saved && (current.kind !== saved.kind || current.tier !== saved.tier
    || canonicalRelayProject(current.project) !== canonicalRelayProject(saved.project))) return null;
  return saved ?? current;
}

function requesterDeadlineAllows(run: RunRecord): boolean {
  const deadline = run.ownerTurn?.leaseDeadlineAt;
  return typeof deadline === "number" && Number.isFinite(deadline) && Date.now() < deadline;
}

function requesterLeaseAllows(run: RunRecord, tier: "owner" | "requester"): boolean {
  return tier === "owner" || requesterDeadlineAllows(run) && requesterLeaseActive(run);
}

export function ownerRunSettingsAllow(run: RunRecord, store: Pick<RelayStore, "relays">): boolean {
  if (run.ownerTurn?.prototype !== true) return effectiveOwnerRunTier(run, store) !== null;
  const relay = store.relays.find(relay => relay.id === run.relayId);
  const target = relay?.targets.find(target => target.id === run.targetId);
  if (relay?.paused !== false || target?.enabled !== true) return false;
  const grant = run.ownerTurn.prototypeGrant;
  return !grant || requesterEntries(relay, target).some(entry => entry.id === grant.id && entry.kind === "paired-owner"
    && canonicalRelayProject(entry.project) === canonicalRelayProject(grant.project)
    && canonicalRelayProject(target.project) === canonicalRelayProject(grant.project));
}

function configuredRunTier(run: RunRecord, store: Pick<RelayStore, "relays">) {
  if (run.ownerTurn?.prototype) return null;
  const relay = store.relays.find(item => item.id === run.relayId);
  return (relay && currentRunEntry(run, relay, store.relays)?.tier) ?? null;
}

export function effectiveOwnerRunTier(run: RunRecord, store: Pick<RelayStore, "relays">) {
  const tier = configuredRunTier(run, store);
  return tier && requesterLeaseAllows(run, tier) ? tier : null;
}

/** Classify delivery custody even after the execution lease has expired. */
export function ownerRunIsRequester(run: RunRecord, store: Pick<RelayStore, "relays">): boolean {
  if (run.ownerTurn?.entry) return run.ownerTurn.entry.tier === "requester";
  const relay = store.relays.find(item => item.id === run.relayId);
  return !!relay && currentRunEntry(run, relay, store.relays)?.tier === "requester";
}

/** The final /send boundary must require owner tier, even for pre-upgrade rows. */
export function ownerLateDeliveryAllowed(run: RunRecord): boolean {
  const store = readAuthorityStore();
  return !!store && effectiveOwnerRunTier(run, store) === "owner";
}

/** MCP reads only: no store creation, pruning or mutation during admission. */
export function liveOwnerRelayConversation(conversationId: string): boolean {
  return liveOwnerRelayRun(conversationId) !== null;
}

export function liveOwnerRelayRequest(conversationId: string) {
  const run = liveOwnerRelayRun(conversationId);
  return run ? { requestId: run.requestId, relayId: run.relayId, targetId: run.targetId, tier: run.ownerTurn?.entry?.tier } : null;
}

function liveOwnerRelayRun(conversationId: string): RunRecord | null {
  return conversationRelayAuthority(conversationId)?.run ?? null;
}

function readAuthorityStore(): RelayStore | null {
  try {
    const store = JSON.parse(fs.readFileSync(externalRelayFile("relays"), "utf8")) as RelayStore;
    return store.v === 1 && Array.isArray(store.relays) ? store : null;
  } catch { return null; }
}

export function hasRequesterRelayCustody(conversationId: string): boolean {
  return conversationRelayAuthority(conversationId)?.requester === true;
}

function conversationRelayAuthority(conversationId: string): { run: RunRecord | null; requester: boolean } | null {
  let requester = false;
  try {
    const ledger = JSON.parse(fs.readFileSync(externalRelayFile("runs"), "utf8")) as RunLedger;
    if (ledger.v !== 1) return null;
    let relays: PairedRelay[] | undefined;
    let owner: RunRecord | null = null;
    for (const run of ledger.runs) {
      if (!run.ownerTurn || run.ownerTurn.prototype || run.conversationId !== conversationId
        || (!runHoldsConversation(run) && !run.ownerTurn.quarantinedAt)) continue;
      relays ??= readAuthorityStore()?.relays ?? [];
      const relay = relays.find(r => r.id === run.relayId);
      const entry = relay && currentRunEntry(run, relay, relays);
      const tier = entry?.tier ?? run.ownerTurn.entry?.tier ?? (relay ? pairedOwnerTier(relay, relays) : "requester");
      const requesterRun = tier === "requester";
      requester ||= requesterRun;
      if (!entry || !requesterLeaseAllows(run, entry.tier) || run.ownerTurn.cancel || run.ownerTurn.quarantinedAt || !run.ownerIdentity
        || procBackend.processIdentity(run.ownerPid) !== run.ownerIdentity) continue;
      // The preceding turn can still call MCP while the reply waits in the queue.
      // Only delivery of this request grants its conversation the owner's tools.
      const continuation = run.ownerTurn.continuation;
      if (continuation) {
        const snapshot = agentRegistry().deliverySnapshotForOperation(continuation.operationId);
        const owner = snapshot.deliveryOperationOwners[continuation.operationId];
        const delivery = owner && snapshot.heldDeliveries[owner.deliveryId];
        if (delivery?.conversationId !== conversationId || delivery.state !== "delivered") continue;
      }
      const authorized = { ...run, ownerTurn: { ...run.ownerTurn, entry } };
      if (requesterRun) return { run: authorized, requester: true };
      owner ??= authorized;
    }
    // A stopped or revoked requester cannot fall through to another authority
    // while its turn still owns the conversation.
    return requester ? { run: null, requester } : owner && { run: owner, requester };
  } catch {
    return requester ? { run: null, requester } : null;
  }
}

/** Reuse the gateway's directive body, keeping agent authorship. The quoted
 * instruction comes from the runner's verified owner turn, never MCP input. */
export function ownerRelayHandoff(text: string, conversationId: string): {
  payload: { text: string; origin: MessageOrigin; requesterRequestId?: string } | null;
  requester: boolean;
} {
  const authority = conversationRelayAuthority(conversationId);
  const run = authority?.run;
  const requester = authority?.requester === true;
  if (!run?.ownerTurn) return { payload: null, requester };
  const turn = run.ownerTurn;
  const request = turn.request;
  if (!request || typeof request.text !== "string" || (request.requestText !== null && typeof request.requestText !== "string")) return { payload: null, requester };
  const entry = turn.entry;
  const directive = entry?.tier === "requester"
    ? `${JSON.stringify(entry.label)} delegated this request as a trusted requester for project ${JSON.stringify(entry.project)}. The quoted request carries this trusted requester's authority for that project. Act within that project's scope.`
    : "The install owner delegated this request through a verified owner relay. The quoted owner request carries operator authority, as a voice gateway directive does. Act on it within this project's scope.";
  return { requester, payload: {
    text: bridgeDirectiveBody(`${directive}\n\n${requester ? "Trusted requester" : "Owner"} request: ${JSON.stringify(request)}${turn.bridgeReport ? `\n\nQuoted bridge report: ${JSON.stringify(turn.bridgeReport)}` : ""}\n\nRelay context:\n${text}`),
    origin: { kind: "agent", role: "owner-relay", conversationId },
    ...(requester ? { requesterRequestId: run.requestId } : {}),
  } };
}

/** A report approval stays addressed to its source seat, including migrations
 * that rekey that same conversation. It cannot authorize a different project. */
export function ownerRelayTargetMatches(conversationId: string, project: string, recipient: string | null | undefined,
  requesterRequestId?: string): boolean {
  const run = liveOwnerRelayRun(conversationId);
  if (!run?.ownerTurn || !entryAllowsProject(run.ownerTurn.entry, project)) return false;
  if (requesterRequestId !== undefined && (run.requestId !== requesterRequestId || run.ownerTurn.entry?.tier !== "requester")) return false;
  const report = run.ownerTurn?.bridgeReport;
  if (!report) return true;
  if (!recipient || canonicalOrchestratorProject(report.project) !== canonicalOrchestratorProject(project)) return false;
  const canonical = seatIdentityResolver(id => agentRegistry().canonicalConversationId(id));
  return canonical(report.sourceSeat) === canonical(recipient);
}

function entryAllowsProject(entry: NonNullable<RunRecord["ownerTurn"]>["entry"], project: string): boolean {
  return entry?.tier !== "requester" || entry.project !== null
    && canonicalOrchestratorProject(entry.project) === canonicalOrchestratorProject(project);
}

export function ownerRelayProjectMatches(conversationId: string, project: string): boolean {
  const turn = liveOwnerRelayRun(conversationId)?.ownerTurn;
  return !!turn && entryAllowsProject(turn.entry, project);
}


/** Fail closed at every admission and delivery boundary; reads only. */
export function ownerRelayAuthorized(relayId: string, targetId: string, requestId: string): boolean {
  return ownerRelayReplyAuthorized(relayId, targetId, requestId, "agent");
}

/** Only the runner's failure reply may follow a diagnosed, settled stop.
 * Agent tools and queued sends keep using ownerRelayAuthorized. */
export function ownerRelayFailureReplyAuthorized(relayId: string, targetId: string, requestId: string): boolean {
  return ownerRelayReplyAuthorized(relayId, targetId, requestId, "failure");
}

/** The fixed deadline notice may precede stop confirmation. It grants no
 * execution authority and still requires current request/relay settings. */
export function ownerRelayStatusReplyAuthorized(relayId: string, targetId: string, requestId: string, body: ExternalRelayCompletion, plainMax: number): boolean {
  return isOwnerRequestTimeoutReply(body, plainMax) && ownerRelayReplyAuthorized(relayId, targetId, requestId, "status");
}

function ownerRelayReplyAuthorized(relayId: string, targetId: string, requestId: string, reply: "agent" | "status" | "failure"): boolean {
  try {
    const store = JSON.parse(fs.readFileSync(externalRelayFile("relays"), "utf8")) as RelayStore;
    const ledger = JSON.parse(fs.readFileSync(externalRelayFile("runs"), "utf8")) as RunLedger;
    const run = ledger.runs.find(r => r.requestId === requestId && r.relayId === relayId && r.targetId === targetId);
    return store.v === 1 && ledger.v === 1 && !!run?.ownerTurn
      && (!run.ownerTurn.cancel || reply === "status" || reply === "failure" && (run.ownerTurn.confirmed === true || !!run.ownerTurn.quarantinedAt) && !!run.ownerTurn.diagnostic)
      && ownerRunSettingsAllow(run, store);
  } catch { return false; }
}

async function readToolAuthority(relayId: string, targetId: string, requestId: string) {
  const [storeText, ledgerText] = await Promise.all([
    fs.promises.readFile(externalRelayFile("relays"), "utf8"),
    fs.promises.readFile(externalRelayFile("runs"), "utf8"),
  ]);
  const store = JSON.parse(storeText) as RelayStore;
  const ledger = JSON.parse(ledgerText) as RunLedger;
  const run = ledger.runs.find(row => row.requestId === requestId && row.relayId === relayId && row.targetId === targetId);
  const turn = run?.ownerTurn;
  if (store.v !== 1 || ledger.v !== 1 || !run || !turn || turn.cancel || turn.quarantinedAt) return null;
  return { run, turn, tier: configuredRunTier(run, store) };
}

/** Async request-bound check for the inline MCP adapter. Its live owner lease
 * supplies process custody; this check reads current persisted revocation state
 * without blocking the Viewer loop or probing process identity synchronously. */
export async function ownerRelayAuthorizedAsync(relayId: string, targetId: string, requestId: string): Promise<boolean> {
  try {
    const prior = await readToolAuthority(relayId, targetId, requestId);
    if (prior?.tier !== "requester") return prior?.tier === "owner";
    if (!requesterDeadlineAllows(prior.run)) return false;
    const receiptUntil = await requesterLeaseUntilAsync(prior.run);
    if (receiptUntil === null || Date.now() >= receiptUntil) return false;
    // Grant removal and cancellation can commit while the receipt read is in flight.
    const current = await readToolAuthority(relayId, targetId, requestId);
    return current?.tier === "requester" && current.run.leaseId === prior.run.leaseId && current.run.runDir === prior.run.runDir
      && current.turn.clientAttemptId === prior.turn.clientAttemptId && current.turn.entry?.id === prior.turn.entry?.id
      && Date.now() < receiptUntil && requesterDeadlineAllows(prior.run) && requesterDeadlineAllows(current.run);
  } catch { return false; }
}

/** Recovery retains the original owner launch's authority, across processes. */
export function ownerRelaySpawnAuthorized(clientAttemptId: string | null | undefined): boolean {
  if (!clientAttemptId?.startsWith("relay-owner-")) return true;
  try {
    const ledger = JSON.parse(fs.readFileSync(externalRelayFile("runs"), "utf8")) as RunLedger;
    const run = ledger.runs.find(row => row.ownerTurn?.clientAttemptId === clientAttemptId);
    return !!run && !run.ownerTurn?.prototype && !!run.ownerIdentity && procBackend.processIdentity(run.ownerPid) === run.ownerIdentity
      && ownerRelayAuthorized(run.relayId, run.targetId, run.requestId);
  } catch { return false; }
}

/** A queued continuation remains bound to its durable owner turn after the
 * request callback has returned. Check the operation and conversation at each
 * delivery boundary; the in-memory admission callback is only an early guard. */
export function ownerRelayOperationAuthorized(operationId: string, conversationId: string): boolean {
  if (!operationId.startsWith("relay-owner-")) return true;
  try {
    const ledger = JSON.parse(fs.readFileSync(externalRelayFile("runs"), "utf8")) as RunLedger;
    const run = ledger.runs.find(row => row.ownerTurn?.continuation?.operationId === operationId
      && row.conversationId === conversationId);
    const continuation = run?.ownerTurn?.continuation;
    if (continuation?.retryOfOperationId && (!Number.isFinite(Date.parse(continuation.deadlineAt ?? ""))
      || Date.now() >= Date.parse(continuation.deadlineAt!))) return false;
    return !!run?.ownerTurn && !run.ownerTurn.prototype && !!run.ownerIdentity && procBackend.processIdentity(run.ownerPid) === run.ownerIdentity
      && ownerRelayAuthorized(run.relayId, run.targetId, run.requestId);
  } catch { return false; }
}
