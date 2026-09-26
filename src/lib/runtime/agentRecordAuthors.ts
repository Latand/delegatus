import { assignDeliveredOccurrences } from "@/components/feed/deliveredOccurrences";
import type { Item } from "@/components/feed/parse";
import { decodeCodexStructuredUserText } from "./codexStructuredUserText.server";
import { deliveredMessageOccurrences } from "./deliveredMessageOccurrences";
import type { DeliveredMessageProvenance, MessageOrigin } from "./messageOrigin";

export interface AgentRecordAuthor {
  kind: "agent";
  role: string;
  project?: string;
  conversationId?: string;
}

function authorFromOrigin(origin: MessageOrigin): AgentRecordAuthor {
  return { kind: "agent", role: origin.role ?? "agent",
    ...(origin.project ? { project: origin.project } : {}),
    ...(origin.conversationId ? { conversationId: origin.conversationId } : {}) };
}

function authorFromProvenance(provenance: DeliveredMessageProvenance): AgentRecordAuthor {
  return { kind: "agent", role: provenance.senderRole ?? "agent",
    ...(provenance.senderProject ? { project: provenance.senderProject } : {}),
    ...(provenance.senderConversationId ? { conversationId: provenance.senderConversationId } : {}) };
}

/** MCP's normalized page uses the same delivery evidence as the feed. Each
 * occurrence claims one record, and compact Codex metadata names its own row
 * directly. An old row without evidence remains unnamed. */
export function agentRecordAuthors(
  transcriptPath: string,
  records: ReadonlyArray<{ role: string; ts: string | null; text: string }>,
): Map<number, AgentRecordAuthor> {
  const authors = new Map<number, AgentRecordAuthor>();
  const items: Item[] = [];
  const indices = new Map<Item, number>();
  records.forEach((record, index) => {
    if (record.role !== "user" || !record.ts) return;
    let text = record.text;
    try {
      const decoded = decodeCodexStructuredUserText(record.text);
      if (decoded.structured) {
        text = decoded.text;
        if (decoded.origin?.kind === "agent") authors.set(index, authorFromOrigin(decoded.origin));
        if (decoded.origin?.kind === "operator") return;
      }
    } catch { /* A missing metadata record leaves the delivery unproven. */ }
    if (authors.has(index)) return;
    const item: Item = { kind: "user", ts: record.ts, text };
    items.push(item);
    indices.set(item, index);
  });
  if (!items.length) return authors;
  const occurrences = deliveredMessageOccurrences(transcriptPath).filter((entry) => entry.origin === "agent");
  for (const [item, provenance] of assignDeliveredOccurrences(items, occurrences)) {
    const index = indices.get(item);
    if (index !== undefined) authors.set(index, authorFromProvenance(provenance));
  }
  return authors;
}
