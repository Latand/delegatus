import fs from "node:fs";
import { procBackend } from "@/lib/proc";
import { externalRelayFile, type RunLedger, type RelayStore } from "./store";

/** MCP reads only: no store creation, pruning or mutation during admission. */
export function liveOwnerRelayConversation(conversationId: string): boolean {
  try {
    const ledger = JSON.parse(fs.readFileSync(externalRelayFile("runs"), "utf8")) as RunLedger;
    const store = JSON.parse(fs.readFileSync(externalRelayFile("relays"), "utf8")) as RelayStore;
    if (ledger.v !== 1 || store.v !== 1) return false;
    return ledger.runs.some(run => {
      if (run.ownerTurn?.cancel || run.conversationId !== conversationId || !run.ownerIdentity || procBackend.processIdentity(run.ownerPid) !== run.ownerIdentity) return false;
      const relay = store.relays.find(r => r.id === run.relayId);
      const target = relay?.targets.find(t => t.id === run.targetId);
      return relay?.paused === false && target?.enabled === true && target.ownerTier === true;
    });
  } catch {
    return false;
  }
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
      && relay?.paused === false && target?.enabled === true && target.ownerTier === true;
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
