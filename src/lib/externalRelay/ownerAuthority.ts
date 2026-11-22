import fs from "node:fs";
import { procBackend } from "@/lib/proc";
import { bridgeDirectiveBody } from "@/lib/bridge/directive";
import type { MessageOrigin } from "@/lib/runtime/messageOrigin";
import { agentRegistry } from "@/lib/agent/registry";
import { canonicalOrchestratorProject } from "@/lib/orchestrator/seats";
import { seatIdentityResolver } from "@/lib/bridge/seatIdentity";
import { changeRunAsync, externalRelayFile, ownerRelayStoreDeadline, type RunLedger, type RelayStore, type RunRecord } from "./store";
import type { ExternalRelayCompletion } from "./protocol";
import { isOwnerRequestTimeoutReply } from "./requestTimeout";

/** MCP reads only: no store creation, pruning or mutation during admission. */
export function liveOwnerRelayConversation(conversationId: string): boolean {
  return liveOwnerRelayRun(conversationId) !== null;
}

export function liveOwnerRelayRequest(conversationId: string) {
  const run = liveOwnerRelayRun(conversationId)?.run;
  return run ? { requestId: run.requestId, relayId: run.relayId, targetId: run.targetId } : null;
}

export function liveOwnerRelayProject(conversationId: string): string | null {
  return liveOwnerRelayRun(conversationId)?.project ?? null;
}

export function ownerRelayHandoffOutcome(relayId: string, targetId: string, requestId: string) {
  try {
    const ledger = JSON.parse(fs.readFileSync(externalRelayFile("runs"), "utf8")) as RunLedger;
    return ledger.runs.find(run => run.requestId === requestId && run.relayId === relayId && run.targetId === targetId)
      ?.ownerTurn?.handoffOutcome ?? null;
  } catch { return null; }
}

/** Persist the actual Viewer handoff result on the live owner request. */
export async function recordOwnerRelayHandoffOutcome(conversationId: string, outcome: NonNullable<RunRecord["ownerTurn"]>["handoffOutcome"]): Promise<boolean> {
  const live = liveOwnerRelayRun(conversationId)?.run;
  if (!live?.ownerTurn || !live.ownerIdentity) return false;
  let recorded = false;
  await changeRunAsync(live.requestId, current => {
    if (current.leaseId !== live.leaseId || current.relayId !== live.relayId || current.targetId !== live.targetId
      || current.conversationId !== conversationId || current.ownerIdentity !== live.ownerIdentity
      || !current.ownerTurn || current.ownerTurn.cancel
      || procBackend.processIdentity(current.ownerPid) !== current.ownerIdentity
      || !ownerRelayAuthorized(current.relayId, current.targetId, current.requestId)) return current;
    recorded = true;
    return { ...current, ownerTurn: { ...current.ownerTurn, handoffOutcome: outcome } };
  }, ownerRelayStoreDeadline());
  return recorded;
}

/** Guest-origin owner turns receive only the request-bound seat handoff. */
export function liveOwnerRelayHandoffOnly(conversationId: string): boolean {
  const raw = liveOwnerRelayRun(conversationId)?.run.ownerTurn?.rawRequest;
  return !!raw && typeof raw === "object" && (raw as { delivery?: unknown }).delivery === "guest";
}

function liveOwnerRelayRun(conversationId: string): { run: RunRecord; project: string | null } | null {
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
      const target = relay?.targets.find(t => t.id === run.targetId);
      if (relay?.paused === false && target?.enabled === true && target.ownerTier === true) return { run, project: target.project };
    }
    return null;
  } catch {
    return null;
  }
}

/** Reuse the gateway's directive body, keeping agent authorship. The quoted
 * instruction comes from the runner's verified owner turn, never MCP input. */
export function ownerRelayPayload(text: string, conversationId: string): { text: string; origin: MessageOrigin } | null {
  const turn = liveOwnerRelayRun(conversationId)?.run.ownerTurn;
  const request = turn?.request;
  if (!request || typeof request.text !== "string" || (request.requestText !== null && typeof request.requestText !== "string")) return null;
  return {
    text: bridgeDirectiveBody(`The install owner delegated this request through a verified owner relay. The quoted owner request carries operator authority, as a voice gateway directive does. Act on it within this project's scope.\n\nOwner request: ${JSON.stringify(request)}${turn?.bridgeReport ? `\n\nQuoted bridge report: ${JSON.stringify(turn.bridgeReport)}` : ""}\n\nRelay context:\n${text}`),
    origin: { kind: "agent", role: "owner-relay", conversationId },
  };
}

/** A report approval stays addressed to its source seat, including migrations
 * that rekey that same conversation. It cannot authorize a different project. */
export function ownerRelayTargetMatches(conversationId: string, project: string, recipient: string | null | undefined): boolean {
  const run = liveOwnerRelayRun(conversationId)?.run;
  if (!run) return false;
  const report = run.ownerTurn?.bridgeReport;
  if (!report) return true;
  if (!recipient || canonicalOrchestratorProject(report.project) !== canonicalOrchestratorProject(project)) return false;
  const canonical = seatIdentityResolver(id => agentRegistry().canonicalConversationId(id));
  return canonical(report.sourceSeat) === canonical(recipient);
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
    const relay = store.relays.find(r => r.id === relayId);
    const target = relay?.targets.find(t => t.id === targetId);
    const run = ledger.runs.find(r => r.requestId === requestId && r.relayId === relayId && r.targetId === targetId);
    return store.v === 1 && ledger.v === 1 && !!run?.ownerTurn
      && (!run.ownerTurn.cancel || reply === "status" || reply === "failure" && (run.ownerTurn.confirmed === true || !!run.ownerTurn.quarantinedAt) && !!run.ownerTurn.diagnostic)
      && relay?.paused === false && target?.enabled === true && (target.ownerTier === true || run.ownerTurn.prototype === true);
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
    const relay = store.relays.find(row => row.id === relayId);
    const target = relay?.targets.find(row => row.id === targetId);
    const run = ledger.runs.find(row => row.requestId === requestId && row.relayId === relayId && row.targetId === targetId);
    return store.v === 1 && ledger.v === 1 && !!run?.ownerTurn && !run.ownerTurn.cancel
      && relay?.paused === false && target?.enabled === true && (target.ownerTier === true || run.ownerTurn.prototype === true);
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

/** Request-bound permission for the restricted guest-owner handoff spawn. */
export function ownerRelayHandoffSpawnAuthorized(clientAttemptId: string | null | undefined): boolean {
  if (!clientAttemptId) return false;
  try {
    const ledger = JSON.parse(fs.readFileSync(externalRelayFile("runs"), "utf8")) as RunLedger;
    if (ledger.v !== 1) return false;
    return ledger.runs.some(run => run.ownerTurn?.clientAttemptId === clientAttemptId
      && !!run.ownerIdentity && procBackend.processIdentity(run.ownerPid) === run.ownerIdentity
      && (run.ownerTurn.rawRequest as { delivery?: unknown } | undefined)?.delivery === "guest"
      && ownerRelayAuthorized(run.relayId, run.targetId, run.requestId));
  } catch {
    return false;
  }
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
