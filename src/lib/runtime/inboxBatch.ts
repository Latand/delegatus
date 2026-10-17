import crypto from "node:crypto";
import type { InboxBatchPart, QueueEntry } from "./engineHost";
import { normalizeQueueEntry } from "./engineHost";
import { MAX_STRUCTURED_TEXT_BYTES, structuredContent, structuredContentDigest, type StructuredMessageContent } from "./structuredContent";

export interface InboxMember {
  entry: QueueEntry;
  admittedAt: string;
  eventSeq: number;
  priority: boolean;
}
export function inboxBatchId(parts: readonly Pick<InboxBatchPart, "operationId" | "contentDigest">[]): string {
  return "inbox_" + crypto.createHash("sha256").update(parts.map(p => `${p.operationId}:${p.contentDigest}`).join("\n")).digest("hex").slice(0, 32);
}
function author(entry: QueueEntry): string {
  if (entry.origin?.kind === "operator") return "the operator";
  return entry.origin?.role ? `agent ${entry.origin.role.replace(/[^a-zA-Z0-9_-]/g, "")}` : "Delegatus";
}
function render(members: readonly InboxMember[], held: number): QueueEntry {
  let text = `[Delegatus] ${members.length} messages arrived while you were working. They follow in the order they were sent.${held ? ` ${held} older messages are held for your next turn.` : ""}\n`;
  const images: StructuredMessageContent["images"] = [];
  const parts: InboxBatchPart[] = [];
  const copies = new Map<string, number>();
  for (const [i, member] of members.entries()) {
    const entry = normalizeQueueEntry(member.entry);
    const origin = entry.origin;
    const copyKey = JSON.stringify([entry.contentDigest, origin?.kind, origin?.role, origin?.project, origin?.conversationId, origin?.channel]);
    const duplicate = copies.get(copyKey) ?? -1;
    if (duplicate < 0) copies.set(copyKey, i);
    const headerStart = text.length;
    const date = Date.parse(member.admittedAt);
    const sent = Number.isFinite(date) ? new Date(date).toISOString().slice(11, 19) + " UTC" : "unknown time";
    text += `[${i + 1}/${members.length} · from ${author(entry)} · sent ${sent}]\n`;
    const textStart = text.length;
    const escaped = /^\[\d+\/\d+ · from /.test(entry.content.text);
    text += duplicate >= 0 ? `same text as ${duplicate + 1}/${members.length}` : (escaped ? "> " : "") + entry.content.text;
    const textEnd = text.length;
    text += "\n";
    const imageStart = images.length;
    if (duplicate < 0) images.push(...entry.content.images);
    parts.push({ operationId: entry.id, contentDigest: entry.contentDigest, admittedAt: member.admittedAt,
      headerStart, textStart, textEnd, imageStart, imageEnd: images.length,
      ...(entry.origin ? { origin: entry.origin } : {}), ...(entry.selectedContext ? { selectedContext: entry.selectedContext } : {}),
      ...(duplicate >= 0 ? { referenceTo: parts[duplicate]!.operationId } : {}), ...(escaped ? { escaped: true } : {}) });
  }
  return { id: inboxBatchId(parts), ...structuredContent(text, images), expectedTurnId: null, parts,
    ...(members[0]?.entry.runtime ? { runtime: members[0].entry.runtime } : {}) };
}

/** Priority chooses membership; the rendered members retain admission order.
 * The prefix is never back-filled around an input that did not fit. */
export function composeBatch(input: readonly InboxMember[]): { entry: QueueEntry; members: InboxMember[]; remaining: InboxMember[] } {
  if (!input.length) throw new Error("inbox batch needs a member");
  // The delivery lane already orders the journal. Do not sort the backlog
  // again on every hand-over; only the bounded chosen prefix needs ordering.
  const ordered = [...input];
  if (ordered.some((m, i) => i > 0 && m.eventSeq < ordered[i - 1]!.eventSeq)) throw new Error("inbox members must follow admission order");
  // Find the first operator item without copying the whole backlog into two
  // additional arrays. Ordinary members retain their admission order.
  const priorityCandidates: InboxMember[] = [];
  const ordinaryCandidates: InboxMember[] = [];
  const ordinaryPrefix: number[] = [0];
  const indexByEventSeq = new Map<number, number>();
  for (const member of ordered) {
    indexByEventSeq.set(member.eventSeq, ordinaryPrefix.length - 1);
    (member.priority ? priorityCandidates : ordinaryCandidates).push(member);
    ordinaryPrefix.push(ordinaryPrefix.at(-1)! + Number(!member.priority));
  }
  const candidates = [...priorityCandidates, ...ordinaryCandidates];
  const selected: InboxMember[] = [];
  for (const m of candidates) {
    const proposed = [...selected, m].sort((a, b) => a.eventSeq - b.eventSeq);
    const end = proposed.at(-1)!.eventSeq;
    const endIndex = indexByEventSeq.get(end)!;
    const selectedOrdinaryBeforeEnd = proposed.filter(member => !member.priority && member.eventSeq < end).length;
    const held = ordinaryPrefix[endIndex]! - selectedOrdinaryBeforeEnd;
    const entry = render(proposed, held);
    // Reserve 256 bytes for the intro, in addition to the actual part text.
    const introBytes = Buffer.byteLength(entry.content!.text.slice(0, entry.parts![0]!.headerStart));
    const bytes = Buffer.byteLength(entry.content!.text) + Math.max(0, 256 - introBytes);
    if (bytes > MAX_STRUCTURED_TEXT_BYTES || entry.content!.images.length > 16
      || entry.content!.images.reduce((total, image) => total + image.bytes, 0) > 18 * 1024 * 1024) break;
    selected.push(m);
  }
  if (!selected.length) selected.push(candidates[0]!);
  selected.sort((a, b) => a.eventSeq - b.eventSeq);
  const remaining = ordered.filter(m => !selected.includes(m));
  const held = remaining.filter(m => !m.priority && m.eventSeq < selected.at(-1)!.eventSeq).length;
  const entry = selected.length === 1 ? { ...normalizeQueueEntry(selected[0]!.entry), expectedTurnId: null } : render(selected, held);
  return { entry, members: selected, remaining };
}

export function batchPartContent(entry: QueueEntry, part: InboxBatchPart): StructuredMessageContent {
  const content = entry.content!;
  if (part.referenceTo) {
    const previous = entry.parts!.slice(0, entry.parts!.indexOf(part)).find(p => p.operationId === part.referenceTo && !p.referenceTo);
    if (!previous) throw new Error("invalid inbox reference");
    return batchPartContent(entry, previous);
  }
  const text = content.text.slice(part.textStart, part.textEnd);
  return { text: part.escaped ? text.slice(2) : text, images: content.images.slice(part.imageStart, part.imageEnd) };
}

/** Both the recorded content and every member digest participate in authority.
 * No content-only match can grant membership in a batch. */
export function verifyBatchMembership(entry: QueueEntry, operationId: string, digest: string | null | undefined): boolean {
  try {
    const parts = entry.parts;
    if (!parts || parts.length < 2 || parts.length > 1000 || !entry.content || !digest
      || entry.id !== inboxBatchId(parts) || entry.contentDigest !== structuredContentDigest(entry.content)
      || new Set(parts.map(p => p.operationId)).size !== parts.length) return false;
    let textEnd = 0, imageEnd = 0;
    for (const p of parts) {
      if (![p.headerStart, p.textStart, p.textEnd, p.imageStart, p.imageEnd].every(Number.isSafeInteger)
        || p.headerStart < textEnd || p.textStart < p.headerStart || p.textEnd < p.textStart || p.textEnd > entry.content.text.length
        || p.imageStart !== imageEnd || p.imageEnd < p.imageStart || p.imageEnd > entry.content.images.length
        || structuredContentDigest(batchPartContent(entry, p)) !== p.contentDigest) return false;
      textEnd = p.textEnd; imageEnd = p.imageEnd;
    }
    return imageEnd === entry.content.images.length && parts.some(p => p.operationId === operationId && p.contentDigest === digest);
  } catch { return false; }
}
