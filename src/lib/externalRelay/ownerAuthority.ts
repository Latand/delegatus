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
      if (run.conversationId !== conversationId || !run.ownerIdentity || procBackend.processIdentity(run.ownerPid) !== run.ownerIdentity) return false;
      const relay = store.relays.find(r => r.id === run.relayId);
      const target = relay?.targets.find(t => t.id === run.targetId);
      return relay?.paused === false && target?.enabled === true && target.ownerTier === true;
    });
  } catch {
    return false;
  }
}
