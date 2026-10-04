import path from "node:path";
import { agentRegistry, readOnlyConversationLookupFromSnapshot } from "@/lib/agent/registry";
import { FileClaudeDeliveryLedger } from "@/lib/runtime/claudeStreamBrokerHost";
import { nativeHookCursor } from "./native";
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
      const engine = conversation.engine as "claude" | "codex";
      const cursor = nativeHookCursor(filename, engine, turn.request.slice("native:".length));
      // A preceding same-text row is never evidence for this native id. Leave
      // it unresolved until the engine journals the intended occurrence.
      if (!cursor.key || cursor.digest !== turn.digest) continue;
      if (turn.occurrence !== cursor.key) index.bindNativeTurn(conversation.id, turn.request, cursor.key);
      native.set(turn.request, cursor.key);
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
