import fs from "node:fs";
import { procBackend } from "@/lib/proc";
import { bridgeDirectiveBody } from "@/lib/bridge/directive";
import type { MessageOrigin } from "@/lib/runtime/messageOrigin";
import { agentRegistry } from "@/lib/agent/registry";
import { canonicalOrchestratorProject } from "@/lib/orchestrator/seats";
import { seatIdentityResolver } from "@/lib/bridge/seatIdentity";
import { externalRelayFile, type PairedRelay, type RunLedger, type RelayStore, type RunRecord } from "./store";
import type { ExternalRelayCompletion } from "./protocol";
import { isOwnerRequestTimeoutReply } from "./requestTimeout";
import { bindRequesterEntry, canonicalRelayProject, legacyRequesterId, requesterEntries } from "./trustedRequesters";

function currentRunEntry(run: RunRecord, relay: PairedRelay, relays: readonly PairedRelay[]) {
  const target = relay.targets.find(item => item.id === run.targetId);
  if (!run.ownerTurn || relay.paused !== false || target?.enabled !== true) return null;
  const saved = run.ownerTurn.entry;
  if (saved?.tier === "requester") {
    const deadline = run.ownerTurn.leaseDeadlineAt;
    if (deadline === undefined || !Number.isFinite(deadline) || Date.now() >= deadline) return null;
  }
  const entry = requesterEntries(relay, target).find(entry => entry.id === (saved?.id ?? legacyRequesterId(target.id)));
  if (!entry || canonicalRelayProject(entry.project) !== canonicalRelayProject(target.project)) return null;
  if (!saved && (entry.kind !== "paired-owner" || entry.source !== "earlier-switch")) return null;
  const current = bindRequesterEntry(relay, entry, relays);
  if (saved && (current.kind !== saved.kind || current.tier !== saved.tier
    || canonicalRelayProject(current.project) !== canonicalRelayProject(saved.project))) return null;
  return saved ?? current;
}

export function ownerRunSettingsAllow(run: RunRecord, store: Pick<RelayStore, "relays">): boolean {
  const relay = store.relays.find(item => item.id === run.relayId);
  if (!relay || !run.ownerTurn) return false;
  return run.ownerTurn.prototype === true
    ? relay.paused === false && relay.targets.some(target => target.id === run.targetId && target.enabled === true)
    : currentRunEntry(run, relay, store.relays) !== null;
}

/** MCP reads only: no store creation, pruning or mutation during admission. */
export function liveOwnerRelayConversation(conversationId: string): boolean {
  return liveOwnerRelayRun(conversationId) !== null;
}

export function liveOwnerRelayRequest(conversationId: string) {
  const run = liveOwnerRelayRun(conversationId);
  return run ? { requestId: run.requestId, relayId: run.relayId, targetId: run.targetId } : null;
}

function liveOwnerRelayRun(conversationId: string): RunRecord | null {
  try {
    const ledger = JSON.parse(fs.readFileSync(externalRelayFile("runs"), "utf8")) as RunLedger;
    const store = JSON.parse(fs.readFileSync(externalRelayFile("relays"), "utf8")) as RelayStore;
    if (ledger.v !== 1 || store.v !== 1) return null;
    for (const run of ledger.runs) {
      if (!run.ownerTurn || run.ownerTurn.cancel || run.conversationId !== conversationId || !run.ownerIdentity || procBackend.processIdentity(run.ownerPid) !== run.ownerIdentity) continue;
      // The preceding turn can still call MCP while the reply waits in the queue.
      // Only delivery of this request grants its conversation the owner's tools.
      const continuation = run.ownerTurn.continuation;
      if (continuation) {
        const snapshot = agentRegistry().deliverySnapshotForOperation(continuation.operationId);
        const owner = snapshot.deliveryOperationOwners[continuation.operationId];
        const delivery = owner && snapshot.heldDeliveries[owner.deliveryId];
        if (delivery?.conversationId !== conversationId || delivery.state !== "delivered") continue;
      }
      const relay = store.relays.find(r => r.id === run.relayId);
      const entry = relay && currentRunEntry(run, relay, store.relays);
      if (entry) return { ...run, ownerTurn: { ...run.ownerTurn, entry } };
    }
    return null;
  } catch {
    return null;
  }
}

/** Reuse the gateway's directive body, keeping agent authorship. The quoted
 * instruction comes from the runner's verified owner turn, never MCP input. */
export function ownerRelayPayload(text: string, conversationId: string): { text: string; origin: MessageOrigin; requesterRequestId?: string } | null {
  const run = liveOwnerRelayRun(conversationId);
  if (!run?.ownerTurn) return null;
  const turn = run.ownerTurn;
  const request = turn.request;
  if (!request || typeof request.text !== "string" || (request.requestText !== null && typeof request.requestText !== "string")) return null;
  const entry = turn?.entry;
  const requester = entry?.tier === "requester";
  const directive = requester
    ? `${JSON.stringify(entry.label)} delegated this request as a trusted requester for project ${JSON.stringify(entry.project)}. The quoted request carries this trusted requester's authority for that project. Act within that project's scope.`
    : "The install owner delegated this request through a verified owner relay. The quoted owner request carries operator authority, as a voice gateway directive does. Act on it within this project's scope.";
  return {
    text: bridgeDirectiveBody(`${directive}\n\n${requester ? "Trusted requester" : "Owner"} request: ${JSON.stringify(request)}${turn.bridgeReport ? `\n\nQuoted bridge report: ${JSON.stringify(turn.bridgeReport)}` : ""}\n\nRelay context:\n${text}`),
    origin: { kind: "agent", role: "owner-relay", conversationId },
    ...(requester ? { requesterRequestId: run.requestId } : {}),
  };
}

/** A report approval stays addressed to its source seat, including migrations
 * that rekey that same conversation. It cannot authorize a different project. */
export function ownerRelayTargetMatches(conversationId: string, project: string, recipient: string | null | undefined): boolean {
  const run = liveOwnerRelayRun(conversationId);
  if (!run?.ownerTurn || !entryAllowsProject(run.ownerTurn.entry, project)) return false;
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

/** Async request-bound check for the inline MCP adapter. Its live owner lease
 * supplies process custody; this check reads current persisted revocation state
 * without blocking the Viewer loop or probing process identity synchronously. */
export async function ownerRelayAuthorizedAsync(relayId: string, targetId: string, requestId: string): Promise<boolean> {
  try {
    const [storeText, ledgerText] = await Promise.all([
      fs.promises.readFile(externalRelayFile("relays"), "utf8"),
      fs.promises.readFile(externalRelayFile("runs"), "utf8"),
    ]);
    const store = JSON.parse(storeText) as RelayStore;
    const ledger = JSON.parse(ledgerText) as RunLedger;
    const run = ledger.runs.find(row => row.requestId === requestId && row.relayId === relayId && row.targetId === targetId);
    return store.v === 1 && ledger.v === 1 && !!run?.ownerTurn && !run.ownerTurn.cancel
      && ownerRunSettingsAllow(run, store);
  } catch { return false; }
}

/** Recovery retains the original owner launch's authority, across processes. */
export function ownerRelaySpawnAuthorized(clientAttemptId: string | null | undefined): boolean {
  if (!clientAttemptId?.startsWith("relay-owner-")) return true;
  try {
    const ledger = JSON.parse(fs.readFileSync(externalRelayFile("runs"), "utf8")) as RunLedger;
    const run = ledger.runs.find(row => row.ownerTurn?.clientAttemptId === clientAttemptId);
    return !!run && !!run.ownerIdentity && procBackend.processIdentity(run.ownerPid) === run.ownerIdentity
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
    return !!run?.ownerTurn && !!run.ownerIdentity && procBackend.processIdentity(run.ownerPid) === run.ownerIdentity
      && ownerRelayAuthorized(run.relayId, run.targetId, run.requestId);
  } catch { return false; }
}
