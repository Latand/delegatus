import { assignDeliveredOccurrences } from "@/components/feed/deliveredOccurrences";
import type { Item } from "@/components/feed/parse";
import { claudeMessageProvenance } from "./claudeMessageProvenance";
import { decodeCodexStructuredUserText } from "./codexStructuredUserText.server";
import { deliveredMessageOccurrences } from "./deliveredMessageOccurrences";
import type { DeliveredMessageProvenance, MessageOrigin } from "./messageOrigin";

export interface AgentRecordAuthor {
  kind: "agent";
  role: string;
  project?: string;
  conversationId?: string;
}

export interface AuthorEvidenceRecord {
  seq: number;
  role: string;
  ts: string | null;
  text: string;
  sourceText?: string;
  sourceId?: string;
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

function recordEvidence(record: AuthorEvidenceRecord, ledger: Record<string, DeliveredMessageProvenance>): {
  text: string; origin: MessageOrigin | null; provenance: DeliveredMessageProvenance | null;
} {
  let text = record.sourceText ?? record.text;
  let origin: MessageOrigin | null = null;
  try {
    const decoded = decodeCodexStructuredUserText(text);
    if (decoded.structured) {
      text = decoded.text;
      origin = decoded.origin ?? null;
    }
  } catch { /* A missing marker record leaves the row unproven. */ }
  return { text, origin, provenance: record.sourceId ? ledger[record.sourceId] ?? null : null };
}

/** Exact Codex markers and Claude ledger UUIDs survive page size, filters,
 * redaction and truncation. Legacy occurrence evidence is assigned over a
 * complete transcript or a bounded time neighborhood, never over the
 * requested page alone. */
export function agentRecordAuthors(
  transcriptPath: string,
  records: ReadonlyArray<AuthorEvidenceRecord>,
  context: ReadonlyArray<AuthorEvidenceRecord> | null = null,
): Map<number, AgentRecordAuthor> {
  const authors = new Map<number, AgentRecordAuthor>();
  const ledger = claudeMessageProvenance(transcriptPath);
  const fallback = new Map<number, DeliveredMessageProvenance>();
  if (context?.length) {
    const items: Item[] = [];
    const seqs = new Map<Item, number>();
    for (const record of context) {
      if (record.role !== "user" || !record.ts) continue;
      const item: Item = { kind: "user", ts: record.ts, text: recordEvidence(record, ledger).text };
      items.push(item);
      seqs.set(item, record.seq);
    }
    for (const [item, provenance] of assignDeliveredOccurrences(items, deliveredMessageOccurrences(transcriptPath))) {
      const seq = seqs.get(item);
      if (seq !== undefined) fallback.set(seq, provenance);
    }
  }
  records.forEach((record, index) => {
    if (record.role !== "user") return;
    const { origin, provenance } = recordEvidence(record, ledger);
    if (origin?.kind === "operator" || provenance?.origin === "operator") return;
    if (origin?.kind === "agent") {
      authors.set(index, authorFromOrigin(origin));
      return;
    }
    if (provenance?.origin === "agent") {
      authors.set(index, authorFromProvenance(provenance));
      return;
    }
    const occurrence = fallback.get(record.seq);
    if (occurrence?.origin === "agent") authors.set(index, authorFromProvenance(occurrence));
  });
  return authors;
}
