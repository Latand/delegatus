import { assignDeliveredOccurrences } from "@/components/feed/deliveredOccurrences";
import type { Item } from "@/components/feed/parse";
import { claudeMessageProvenance } from "./claudeMessageProvenance";
import { decodeCodexStructuredUserText } from "./codexStructuredUserText.server";
import { deliveredMessageOccurrences } from "./deliveredMessageOccurrences";
import { messageTextDigest } from "./messageTextDigest";
import type { DeliveredMessageProvenance, MessageOrigin } from "./messageOrigin";

const NO_OCCURRENCE_DIGESTS: ReadonlySet<string> = new Set();

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

function recordEvidence(
  record: AuthorEvidenceRecord,
  engine: "claude" | "codex" | "copilot",
  occurrenceDigests: ReadonlySet<string>,
): {
  text: string; origin: MessageOrigin | null;
} {
  const text = record.sourceText ?? record.text;
  if (engine !== "codex") return { text, origin: null };
  try {
    const decoded = decodeCodexStructuredUserText(text);
    if (decoded.structured) {
      if (occurrenceDigests.size === 0) return { text, origin: decoded.origin ?? null };
      const hasDigest = (candidate: string) => occurrenceDigests.has(messageTextDigest(candidate.trim()))
        || occurrenceDigests.has(messageTextDigest(candidate));
      // A Codex envelope and literal marker-shaped content have the same prefix.
      // The admitted text digest decides which bytes this transcript row carries.
      const occurrenceText = !hasDigest(text) && hasDigest(decoded.text) ? decoded.text : text;
      return { text: occurrenceText, origin: decoded.origin ?? null };
    }
  } catch { /* A missing marker record leaves the row unproven. */ }
  return { text, origin: null };
}

/** Exact Codex markers and Claude ledger UUIDs survive page size, filters,
 * redaction and truncation. Legacy occurrence evidence is assigned over a
 * complete transcript or a bounded time neighborhood, never over the
 * requested page alone. */
export function agentRecordAuthors(
  transcriptPath: string,
  engine: "claude" | "codex" | "copilot",
  records: ReadonlyArray<AuthorEvidenceRecord>,
  context: ReadonlyArray<AuthorEvidenceRecord> | null = null,
): Map<number, AgentRecordAuthor> {
  const authors = new Map<number, AgentRecordAuthor>();
  const ledger = engine === "claude" ? claudeMessageProvenance(transcriptPath) : {};
  const fallback = new Map<number, DeliveredMessageProvenance>();
  if (context?.length) {
    const occurrences = deliveredMessageOccurrences(transcriptPath);
    const occurrenceDigests = new Set(occurrences.map((occurrence) => occurrence.textDigest));
    const items: Item[] = [];
    const seqs = new Map<Item, number>();
    for (const record of context) {
      if (record.role !== "user" || !record.ts) continue;
      const item: Item = { kind: "user", ts: record.ts, text: recordEvidence(record, engine, occurrenceDigests).text };
      items.push(item);
      seqs.set(item, record.seq);
    }
    for (const [item, provenance] of assignDeliveredOccurrences(items, occurrences)) {
      const seq = seqs.get(item);
      if (seq !== undefined) fallback.set(seq, provenance);
    }
  }
  records.forEach((record, index) => {
    if (record.role !== "user") return;
    const { origin } = recordEvidence(record, engine, NO_OCCURRENCE_DIGESTS);
    const provenance = record.sourceId ? ledger[record.sourceId] ?? null : null;
    if (provenance?.origin === "operator") return;
    if (provenance?.origin === "agent") {
      authors.set(index, authorFromProvenance(provenance));
      return;
    }
    const occurrence = fallback.get(record.seq);
    if (occurrence?.origin === "operator") return;
    if (occurrence?.origin === "agent") {
      authors.set(index, authorFromProvenance(occurrence));
      return;
    }
    if (origin?.kind === "agent") authors.set(index, authorFromOrigin(origin));
  });
  return authors;
}
