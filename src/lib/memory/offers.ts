import path from "node:path";
import { agentRegistry, readOnlyConversationLookupFromSnapshot } from "@/lib/agent/registry";
import { FileClaudeDeliveryLedger } from "@/lib/runtime/claudeStreamBrokerHost";
import { nativeHookCursor, nativeOccurrenceAfter } from "./native";
import { memoryIndex } from "./service";

/** Keys are the engine's occurrence identity, never the operator's words. */
export function offeredMemoryForTranscript(filename: string): Record<string, string[]> {
  try {
    const conversation = readOnlyConversationLookupFromSnapshot(agentRegistry().readOnlySnapshot()).conversationForPath(filename);
    if (!conversation) return {};
    const index = memoryIndex();
    const offered = index.turnOffers(conversation.id);
    const native = new Map<string, string>();
    for (const turn of index.nativeTurns(conversation.id, filename)) {
      let key = turn.occurrence;
      if (!key) {
        const engine = conversation.engine as "claude" | "codex";
        const cursor = nativeHookCursor(filename, engine, turn.request.slice("native:".length));
        const occurrence = cursor?.key && cursor.digest === turn.digest ? cursor : nativeOccurrenceAfter(filename, engine, turn.offset, turn.digest);
        if (occurrence?.digest === turn.digest && index.bindNativeTurn(conversation.id, turn.request, occurrence.key)) key = occurrence.key;
      }
      if (key) native.set(turn.request, key);
    }
    const ledger = conversation.engine === "claude" ? new FileClaudeDeliveryLedger().load(path.basename(filename, ".jsonl")) : [];
    const result: Record<string, string[]> = {};
    for (const offer of offered) {
      const key = offer.requestId.startsWith("native:") ? native.get(offer.requestId) : conversation.engine === "claude" ? ledger.find(r => r.entry.id === offer.requestId)?.engineMessageId : offer.requestId;
      if (key) (result[key] ??= []).push(offer.title);
    }
    return result;
  } catch { return {}; }
}
