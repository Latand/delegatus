import os from "node:os";
import path from "node:path";
import { agentRegistry, readOnlyConversationLookupFromSnapshot } from "@/lib/agent/registry";
import { FileClaudeDeliveryLedger } from "@/lib/runtime/claudeStreamBrokerHost";
import { nativeHookCursor } from "./native";
import { memoryIndex } from "./service";

/** What one transcript's operator turns received from shared memory. */
export interface TranscriptMemory {
  /** Titles of the memories added to each turn. */
  offers: Record<string, string[]>;
  /** The file each of those titles was read from, in the same order; null when the index no longer holds it. */
  paths: Record<string, Array<string | null>>;
  /** Turns whose candidates were judged and none was chosen. */
  none: string[];
}

/** Keys are the engine's occurrence identity, never the operator's words. */
export function memoryForTranscript(filename: string): TranscriptMemory {
  const result: TranscriptMemory = { offers: {}, paths: {}, none: [] };
  try {
    const conversation = readOnlyConversationLookupFromSnapshot(agentRegistry().readOnlySnapshot()).conversationForPath(filename);
    if (!conversation) return result;
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
    const keyFor = (requestId: string) => requestId.startsWith("native:") ? native.get(requestId)
      : conversation.engine === "claude" ? ledger.find(r => r.entry.id === requestId)?.engineMessageId : requestId;
    for (const offer of offered) {
      const key = keyFor(offer.requestId);
      if (key) (result.offers[key] ??= []).push(offer.title);
    }
    // The reader and the quiet line are extras: the titles stand without them.
    try {
      const sources = index.offerSources(conversation.id), home = os.homedir();
      for (const offer of offered) {
        const key = keyFor(offer.requestId), source = sources.get(offer.id);
        if (key) (result.paths[key] ??= []).push(source ? source.startsWith(home + path.sep) ? "~/" + path.relative(home, source) : source : null);
      }
      for (const request of index.unmatchedTurns(conversation.id)) {
        const key = keyFor(request);
        if (key && !result.offers[key]) result.none.push(key);
      }
    } catch { result.paths = {}; result.none = []; }
    return result;
  } catch { return { offers: {}, paths: {}, none: [] }; }
}

export function offeredMemoryForTranscript(filename: string): Record<string, string[]> {
  return memoryForTranscript(filename).offers;
}
