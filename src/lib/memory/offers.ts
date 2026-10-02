import path from "node:path";
import { agentRegistry, readOnlyConversationLookupFromSnapshot } from "@/lib/agent/registry";
import { FileClaudeDeliveryLedger } from "@/lib/runtime/claudeStreamBrokerHost";
import { memoryIndex } from "./service";

/** Keys are the engine's occurrence identity, never the operator's words. */
export function offeredMemoryForTranscript(filename: string): Record<string, string[]> {
  try {
    const conversation = readOnlyConversationLookupFromSnapshot(agentRegistry().readOnlySnapshot()).conversationForPath(filename);
    if (!conversation) return {};
    const offered = memoryIndex().turnOffers(conversation.id);
    const ledger = conversation.engine === "claude" ? new FileClaudeDeliveryLedger().load(path.basename(filename, ".jsonl")) : [];
    const result: Record<string, string[]> = {};
    for (const offer of offered) {
      const key = conversation.engine === "claude" ? ledger.find(r => r.entry.id === offer.requestId)?.engineMessageId : offer.requestId;
      if (key) (result[key] ??= []).push(offer.title);
    }
    return result;
  } catch { return {}; }
}
