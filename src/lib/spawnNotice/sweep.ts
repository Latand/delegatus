import crypto from "node:crypto";

import type { MessageOrigin } from "@/lib/runtime/messageOrigin";

import type {
  SpawnNoticeAttempt,
  SpawnNoticeChild,
  SpawnNoticeSettlement,
  SpawnNoticeSkip,
  SpawnNoticeTurn,
} from "./store";

/**
 * The Viewer half of docs/design/spawn-completion-notice.md (§3–§5): turns
 * the obligation rows the runtime host's consumer wrote into one queued
 * message per child to whoever launched it.
 *
 * Every read and write goes through {@link SpawnNoticeSweepPorts}, so the
 * rules — hold a busy child, coalesce inside 30 s, resolve a retired seat to
 * the current one, skip a gone or archived launcher, retry an uncertain send
 * under the same key — are tested without a registry, a runtime host or a
 * delivery layer.
 */

/** At most one notice per child per this window; turns in between fold in. */
export const SPAWN_NOTICE_COALESCE_MS = 30_000;
/** The final message's share of a notice. */
export const SPAWN_NOTICE_FINAL_MESSAGE_BYTES = 4_096;
/** Uncertain or transient answers retried before the rows are failed: about
    ten minutes at the controller's 30-second cadence. */
export const SPAWN_NOTICE_MAX_ATTEMPTS = 20;

export interface SpawnNoticeChildView {
  title: string;
  /** A turn is running on a live host: the turn that ends will cover the
      pending rows. False when the host is gone, whatever the turn says. */
  busy: boolean;
}

export type SpawnNoticeRecipient =
  | { kind: "deliver"; conversationId: string; path: string }
  | { kind: "skip"; reason: SpawnNoticeSkip };

export interface SpawnNoticeFinalMessage {
  text: string | null;
  /** The engine's own error text, when the tail carries one. */
  error: string | null;
}

export interface SpawnNoticeDeliveryRequest {
  pid: null;
  path: string;
  conversationId: string;
  clientMessageId: string;
  text: string;
  images: [];
  origin: MessageOrigin;
  policy: "steer-or-queue";
}

export type SpawnNoticeDeliveryAnswer =
  | { ok: true; operationId: string | null }
  /** `uncertain`: the send may have started, or the refusal is transient;
      the same key is tried again. */
  | { ok: false; error: string; uncertain: boolean };

export interface SpawnNoticeSweepPorts {
  now(): number;
  pending(): SpawnNoticeTurn[];
  childRecord(child: string): SpawnNoticeChild | null;
  /** Null when the registry no longer knows the child. */
  child(child: string): Promise<SpawnNoticeChildView | null>;
  recipient(launcher: string): SpawnNoticeRecipient;
  finalMessage(child: string): SpawnNoticeFinalMessage;
  origin(child: string): MessageOrigin;
  recordAttempt(child: string, attempt: SpawnNoticeAttempt): void;
  settle(child: string, turnIds: readonly string[], settlement: SpawnNoticeSettlement, at: string): void;
  deliver(request: SpawnNoticeDeliveryRequest): Promise<SpawnNoticeDeliveryAnswer>;
  log?(message: string, error?: unknown): void;
}

/** One key per child turn, bounded for the delivery layer's 128-character key. */
export function spawnNoticeMessageId(child: string, turnId: string): string {
  return `spawn_notice_${crypto.createHash("sha256").update(`${child}:${turnId}`).digest("hex")}`;
}

const VERDICT = /^\s*\**\s*Verdict:\s*\**\s*(pass|fail|needs_decision)\b/gim;

/** The last `Verdict: pass|fail|needs_decision` line of a final message. */
export function detectedVerdict(text: string | null): string | null {
  if (!text) return null;
  let verdict: string | null = null;
  for (const match of text.matchAll(VERDICT)) verdict = match[1]!.toLowerCase();
  return verdict;
}

/** Cut to at most `limit` UTF-8 bytes, backing off to a character boundary. */
export function cutUtf8(text: string, limit: number): { text: string; omittedBytes: number } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return { text, omittedBytes: 0 };
  let end = limit;
  /* A continuation byte is 10xxxxxx: back off to the first byte of its character. */
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString("utf8"), omittedBytes: bytes.length - end };
}

export function formatRunTime(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(rest).padStart(2, "0")}s`;
  return `${rest}s`;
}

/** The notice text (§4). `turns` is oldest first; the newest one leads. */
export function composeSpawnNotice(input: {
  child: string;
  title: string;
  turns: readonly SpawnNoticeTurn[];
  final: SpawnNoticeFinalMessage;
}): string {
  const newest = input.turns.at(-1)!;
  const lines = [`Agent finished: ${input.title} (${input.child})`];
  const verdict = detectedVerdict(input.final.text);
  if (verdict) lines.push(`Verdict: ${verdict}`);
  const started = newest.startedAt ? Date.parse(newest.startedAt) : Number.NaN;
  const ended = Date.parse(newest.endedAt);
  const ran = Number.isFinite(started) && Number.isFinite(ended) ? ` · ran ${formatRunTime(ended - started)}` : "";
  const head = newest.outcome === "completed"
    ? "Turn completed"
    : newest.outcome === "interrupted"
      ? `Turn was interrupted: ${input.final.error ?? "no reason recorded"}`
      : `Turn ended with an error: ${input.final.error ?? "no reason recorded"}`;
  const earlier = input.turns.slice(0, -1);
  const unsettled = earlier.filter((turn) => turn.outcome !== "completed");
  const folded = earlier.length > 0
    ? ` · ${input.turns.length} turns since the last notice${unsettled.length
      ? ` (${unsettled.map((turn) => turn.outcome).join(", ")} among the earlier ones)`
      : ""}`
    : "";
  lines.push(`${head}${ran}${folded}`);
  if (input.final.text) {
    const cut = cutUtf8(input.final.text, SPAWN_NOTICE_FINAL_MESSAGE_BYTES);
    lines.push("Final message:", cut.text);
    if (cut.omittedBytes > 0) {
      lines.push(`[… cut: ${cut.omittedBytes} bytes more — conversation_messages conversationId=${input.child}]`);
    }
  } else {
    lines.push(`Final message: none recorded — conversation_messages conversationId=${input.child}`);
  }
  return lines.join("\n");
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

async function deliverAttempt(child: string, attempt: SpawnNoticeAttempt, ports: SpawnNoticeSweepPorts): Promise<void> {
  const at = iso(ports.now());
  const answer = await ports.deliver({
    pid: null,
    path: attempt.recipientPath,
    conversationId: attempt.recipientConversationId,
    clientMessageId: attempt.clientMessageId,
    text: attempt.text,
    images: [],
    origin: ports.origin(child),
    policy: "steer-or-queue",
  }).catch((error: unknown): SpawnNoticeDeliveryAnswer => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    uncertain: true,
  }));
  if (answer.ok) {
    ports.settle(child, attempt.turnIds, {
      state: "sent",
      recipientConversationId: attempt.recipientConversationId,
      clientMessageId: attempt.clientMessageId,
      operationId: answer.operationId,
    }, at);
    return;
  }
  if (answer.uncertain && attempt.attempts < SPAWN_NOTICE_MAX_ATTEMPTS) {
    ports.log?.(`[spawn notice] ${child}: delivery uncertain, retrying under the same key: ${answer.error}`);
    return;
  }
  ports.settle(child, attempt.turnIds, {
    state: "failed",
    reason: answer.error.slice(0, 240),
    recipientConversationId: attempt.recipientConversationId,
    clientMessageId: attempt.clientMessageId,
  }, at);
}

/** One pass over every child with an open obligation. */
export async function sweepSpawnNotices(ports: SpawnNoticeSweepPorts): Promise<void> {
  const byChild = new Map<string, SpawnNoticeTurn[]>();
  for (const row of ports.pending()) {
    const held = byChild.get(row.childConversationId);
    if (held) held.push(row);
    else byChild.set(row.childConversationId, [row]);
  }
  for (const [child, rows] of byChild) {
    try {
      await sweepChild(child, rows, ports);
    } catch (error) {
      ports.log?.(`[spawn notice] ${child}: sweep failed; the next pass retries`, error);
    }
  }
}

async function sweepChild(child: string, rows: SpawnNoticeTurn[], ports: SpawnNoticeSweepPorts): Promise<void> {
  const record = ports.childRecord(child);
  /* A notice already handed over is finished first, exactly as it was
     written, whatever the child has done since. */
  if (record?.attempt) {
    const attempt = { ...record.attempt, attempts: record.attempt.attempts + 1 };
    ports.recordAttempt(child, attempt);
    await deliverAttempt(child, attempt, ports);
    return;
  }
  const now = ports.now();
  const view = await ports.child(child);
  if (view?.busy) return;
  const last = record?.lastSentAt ? Date.parse(record.lastSentAt) : Number.NaN;
  if (Number.isFinite(last) && now - last < SPAWN_NOTICE_COALESCE_MS) return;
  const turns = [...rows].sort((left, right) => left.endedAt.localeCompare(right.endedAt));
  const turnIds = turns.map((turn) => turn.turnId);
  const newest = turns.at(-1)!;
  const recipient = ports.recipient(newest.launcherConversationId);
  if (recipient.kind === "skip") {
    ports.settle(child, turnIds, { state: "skipped", reason: recipient.reason }, iso(now));
    return;
  }
  /* A launcher is fixed at birth and existed before its child, so notices
     only climb the launch tree; this refuses the one degenerate edge. */
  if (recipient.conversationId === child) {
    ports.settle(child, turnIds, { state: "skipped", reason: "self" }, iso(now));
    return;
  }
  const attempt: SpawnNoticeAttempt = {
    clientMessageId: spawnNoticeMessageId(child, newest.turnId),
    recipientConversationId: recipient.conversationId,
    recipientPath: recipient.path,
    text: composeSpawnNotice({ child, title: view?.title ?? "spawned agent", turns, final: ports.finalMessage(child) }),
    turnIds,
    attempts: 1,
    firstAttemptAt: iso(now),
  };
  ports.recordAttempt(child, attempt);
  await deliverAttempt(child, attempt, ports);
}
