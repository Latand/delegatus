import fs from "node:fs";
import { procBackend } from "@/lib/proc";
import { bridgeDirectiveBody } from "@/lib/bridge/directive";
import type { MessageOrigin } from "@/lib/runtime/messageOrigin";
import { agentRegistry } from "@/lib/agent/registry";
import { canonicalOrchestratorProject } from "@/lib/orchestrator/seats";
import { seatIdentityResolver } from "@/lib/bridge/seatIdentity";
import { externalRelayFile, type RunLedger, type RelayStore, type RunRecord } from "./store";

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
    return ledger.runs.find(run => {
      if (!run.ownerTurn || run.ownerTurn.cancel || run.conversationId !== conversationId || !run.ownerIdentity || procBackend.processIdentity(run.ownerPid) !== run.ownerIdentity) return false;
      const relay = store.relays.find(r => r.id === run.relayId);
      const target = relay?.targets.find(t => t.id === run.targetId);
      return relay?.paused === false && target?.enabled === true && target.ownerTier === true;
    }) ?? null;
  } catch {
    return null;
  }
}

/** Reuse the gateway's directive body, keeping agent authorship. The quoted
 * instruction comes from the runner's verified owner turn, never MCP input. */
export function ownerRelayPayload(text: string, conversationId: string): { text: string; origin: MessageOrigin } | null {
  const turn = liveOwnerRelayRun(conversationId)?.ownerTurn;
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
  const run = liveOwnerRelayRun(conversationId);
  if (!run) return false;
  const report = run.ownerTurn?.bridgeReport;
  if (!report) return true;
  if (!recipient || canonicalOrchestratorProject(report.project) !== canonicalOrchestratorProject(project)) return false;
  const canonical = seatIdentityResolver(id => agentRegistry().canonicalConversationId(id));
  return canonical(report.sourceSeat) === canonical(recipient);
}


/** Fail closed at every admission and delivery boundary; reads only. */
export function ownerRelayAuthorized(relayId: string, targetId: string, requestId: string): boolean {
  try {
    const store = JSON.parse(fs.readFileSync(externalRelayFile("relays"), "utf8")) as RelayStore;
    const ledger = JSON.parse(fs.readFileSync(externalRelayFile("runs"), "utf8")) as RunLedger;
    const relay = store.relays.find(r => r.id === relayId);
    const target = relay?.targets.find(t => t.id === targetId);
    const run = ledger.runs.find(r => r.requestId === requestId && r.relayId === relayId && r.targetId === targetId);
    return store.v === 1 && ledger.v === 1 && !!run?.ownerTurn && !run.ownerTurn.cancel
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
