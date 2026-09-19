import fs from "node:fs";

import { claudeUserText } from "@/lib/claudeProtocolUser";
import { numberValue, recordValue, stringValue } from "@/lib/scanner/json";

type RecordLike = Record<string, unknown>;

/**
 * Harness-tracked background work a Claude conversation still holds (#1441).
 *
 * Claude Code can end an assistant turn while work it started keeps running,
 * and re-invokes the agent when that work reports. Between the two the
 * transcript shows a completed turn, which the pipeline controller used to
 * read as the stage's last word. These are the records that say otherwise, as
 * they appear in real stage transcripts:
 *
 *  - A background command (`Bash` with `run_in_background`, or a foreground
 *    command the harness moved to the background at its timeout): the
 *    `tool_result` user record carries `toolUseResult.backgroundTaskId`.
 *  - A `Monitor`: its `tool_result` carries `toolUseResult.taskId` with
 *    `timeoutMs` and `persistent`. A non-persistent monitor expires at
 *    `timeoutMs` even when its expiry notice is missing.
 *  - The report: a `<task-notification>` naming the `<task-id>` with a
 *    `<status>` (completed, failed, killed, stopped), delivered as a user record
 *    when the agent is idle or as a `queued_command` attachment mid-turn. A
 *    Monitor's per-event notices carry no `<status>` and end nothing. A
 *    `queue-operation` enqueue alone has not reached the agent yet, so the
 *    task is still owed a turn and stays pending.
 *  - `TaskStop`: its `tool_result` carries `toolUseResult.task_id`.
 *  - `ScheduleWakeup`: its `tool_result` carries `toolUseResult.scheduledFor`
 *    (epoch ms); any later `ScheduleWakeup` call replaces it, and one with
 *    `stop: true` cancels it.
 *
 * Codex has no equivalent: its tools run inside the turn and nothing
 * re-invokes the agent after the turn ends, so a Codex conversation never
 * holds one.
 */
export type RunningBackgroundTask = {
  id: string;
  kind: "command" | "monitor" | "wakeup";
  /** Epoch ms of the record that started it. */
  startedAt: number;
  /** Epoch ms past which the harness itself has ended it (a monitor's timeout,
      a wakeup's firing time), or null when only its notification ends it. */
  expiresAt: number | null;
};

/** The fold of a transcript's background-task records, in file order. */
export type BackgroundTaskLedger = {
  running: Record<string, RunningBackgroundTask>;
  /** Tasks that already reported, so a start record written after its own
      notification cannot reopen one. */
  ended: string[];
  wakeup: RunningBackgroundTask | null;
  /** Epoch ms of the newest delivered completion notification or stop: the
      moment the agent last heard that background work ended. */
  lastReportedAt: number | null;
};

/** A harness expiry is honoured this long after its nominal time, so the
    notice or the wakeup's own prompt has time to reach the transcript. */
const EXPIRY_GRACE_MS = 2 * 60_000;
const MAX_ENDED_IDS = 500;

export function emptyBackgroundTaskLedger(): BackgroundTaskLedger {
  return { running: {}, ended: [], wakeup: null, lastReportedAt: null };
}

function recordTs(record: RecordLike): number {
  return Date.parse(String(record.timestamp ?? "")) || 0;
}

function taskNotifications(text: string): Array<{ id: string; status: string | null }> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("<task-notification")) return [];
  const found: Array<{ id: string; status: string | null }> = [];
  for (const block of trimmed.matchAll(/<task-notification\b[^>]*>([\s\S]*?)<\/task-notification>/g)) {
    const body = block[1] ?? "";
    const id = body.match(/<task-id>\s*([^<\s]+)\s*<\/task-id>/)?.[1];
    if (!id) continue;
    found.push({ id, status: body.match(/<status>\s*([^<]+?)\s*<\/status>/)?.[1] ?? null });
  }
  return found;
}

function contentParts(record: RecordLike): RecordLike[] {
  const content = recordValue(record.message)?.content;
  return Array.isArray(content) ? content.map((part) => recordValue(part) ?? {}) : [];
}

function end(ledger: BackgroundTaskLedger, id: string, ts: number): void {
  delete ledger.running[id];
  if (!ledger.ended.includes(id)) ledger.ended = [...ledger.ended, id].slice(-MAX_ENDED_IDS);
  ledger.lastReportedAt = Math.max(ledger.lastReportedAt ?? 0, ts) || null;
}

/** Apply one Claude transcript record to the ledger. Pure over its inputs:
    the ledger passed in is copied, never mutated. */
export function foldBackgroundTaskRecord(ledger: BackgroundTaskLedger, record: RecordLike): BackgroundTaskLedger {
  const next: BackgroundTaskLedger = { ...ledger, running: { ...ledger.running } };
  const ts = recordTs(record);
  if (record.type === "assistant") {
    for (const part of contentParts(record)) {
      if (part.type === "tool_use" && part.name === "ScheduleWakeup") next.wakeup = null;
    }
    return next;
  }
  if (record.type === "attachment") {
    const attachment = recordValue(record.attachment);
    if (attachment?.type !== "queued_command") return next;
    for (const notice of taskNotifications(stringValue(attachment.prompt) ?? "")) {
      if (notice.status) end(next, notice.id, ts);
    }
    return next;
  }
  if (record.type !== "user") return next;
  const parts = contentParts(record);
  if (parts.some((part) => part.type === "tool_result")) {
    const result = recordValue(record.toolUseResult);
    if (!result) return next;
    const backgroundId = stringValue(result.backgroundTaskId);
    const monitorId = stringValue(result.taskId);
    const stoppedId = stringValue(result.task_id);
    const scheduledFor = numberValue(result.scheduledFor);
    if (backgroundId && !next.ended.includes(backgroundId)) {
      next.running[backgroundId] = { id: backgroundId, kind: "command", startedAt: ts, expiresAt: null };
    } else if (monitorId && ("timeoutMs" in result || "persistent" in result) && !next.ended.includes(monitorId)) {
      const timeoutMs = numberValue(result.timeoutMs);
      next.running[monitorId] = {
        id: monitorId,
        kind: "monitor",
        startedAt: ts,
        expiresAt: result.persistent !== true && timeoutMs !== null ? ts + timeoutMs : null,
      };
    } else if (stoppedId && ("task_type" in result || /^Successfully stopped/.test(stringValue(result.message) ?? ""))) {
      end(next, stoppedId, ts);
    } else if (scheduledFor !== null) {
      next.wakeup = { id: `wakeup@${new Date(scheduledFor).toISOString()}`, kind: "wakeup", startedAt: ts, expiresAt: scheduledFor };
    }
    return next;
  }
  for (const notice of taskNotifications(claudeUserText(recordValue(record.message)?.content))) {
    if (notice.status) end(next, notice.id, ts);
  }
  return next;
}

export function foldBackgroundTaskRecords(ledger: BackgroundTaskLedger, records: readonly RecordLike[]): BackgroundTaskLedger {
  return records.reduce(foldBackgroundTaskRecord, ledger);
}

/** Everything the ledger holds open, oldest first, expired or not. */
export function heldBackgroundTasks(ledger: BackgroundTaskLedger): RunningBackgroundTask[] {
  const tasks = Object.values(ledger.running);
  if (ledger.wakeup) tasks.push(ledger.wakeup);
  return tasks.sort((left, right) => left.startedAt - right.startedAt);
}

/** The held tasks the harness has not itself ended by `nowMs`. */
export function liveBackgroundTasks(tasks: readonly RunningBackgroundTask[], nowMs: number): RunningBackgroundTask[] {
  return tasks.filter((task) => task.expiresAt === null || task.expiresAt + EXPIRY_GRACE_MS > nowMs);
}

/** What the ledger still holds at `nowMs`, oldest first. */
export function pendingBackgroundTasks(ledger: BackgroundTaskLedger, nowMs: number): RunningBackgroundTask[] {
  return liveBackgroundTasks(heldBackgroundTasks(ledger), nowMs);
}

/** One line naming the held tasks, for a state detail or a refusal. */
export function describeBackgroundTasks(tasks: readonly RunningBackgroundTask[]): string {
  return tasks.map((task) => task.kind === "wakeup"
    ? `a wakeup scheduled for ${new Date(task.expiresAt ?? 0).toISOString()}`
    : `${task.kind === "monitor" ? "monitor" : "background task"} ${task.id}`).join(", ");
}

/**
 * Does this conversation hold a running background task? The one predicate the
 * pipeline controller, `stage_report` and review flows share: the harness-
 * tracked work (see {@link RunningBackgroundTask}) a Claude transcript started
 * and has not yet heard the end of, as of `nowMs`. Empty for Codex.
 */
export function runningBackgroundTasks(
  records: readonly RecordLike[],
  engine: "claude" | "codex",
  nowMs: number,
): RunningBackgroundTask[] {
  if (engine !== "claude") return [];
  return pendingBackgroundTasks(foldBackgroundTaskRecords(emptyBackgroundTaskLedger(), records), nowMs);
}

/** Lines that can move the ledger; everything else is skipped unparsed. */
const RELEVANT_LINE = /backgroundTaskId|task-notification|"taskId"|"task_id"|scheduledFor|"ScheduleWakeup"/;
const READ_CHUNK_BYTES = 1 << 20;
const MAX_CACHED_TRANSCRIPTS = 256;

type CachedLedger = { dev: bigint; ino: bigint; offset: number; ledger: BackgroundTaskLedger };
const cache = new Map<string, CachedLedger>();

/**
 * The ledger of one whole transcript, read incrementally: a task started
 * hours of output ago is still in it, which the bounded tail the turn reader
 * uses cannot promise. Only complete lines are consumed; a replaced or
 * truncated file starts over. Null when the file cannot be read.
 */
export async function readBackgroundTaskLedger(transcriptPath: string): Promise<BackgroundTaskLedger | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(transcriptPath, "r");
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) return null;
    const size = Number(stat.size);
    let cached = cache.get(transcriptPath);
    if (!cached || cached.dev !== stat.dev || cached.ino !== stat.ino || cached.offset > size) {
      cached = { dev: stat.dev, ino: stat.ino, offset: 0, ledger: emptyBackgroundTaskLedger() };
    }
    let { offset, ledger } = cached;
    let carry = Buffer.alloc(0);
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    while (offset < size) {
      const read = await handle.read(buffer, 0, Math.min(READ_CHUNK_BYTES, size - offset), offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
      /* Split on the newline byte, so a multi-byte character across a chunk
         boundary is decoded whole. */
      const pending = carry.length ? Buffer.concat([carry, buffer.subarray(0, read.bytesRead)]) : buffer.subarray(0, read.bytesRead);
      const lastNewline = pending.lastIndexOf(0x0a);
      if (lastNewline < 0) {
        carry = Buffer.from(pending);
        continue;
      }
      for (const line of pending.subarray(0, lastNewline).toString("utf8").split("\n")) {
        if (!RELEVANT_LINE.test(line)) continue;
        try {
          const record = JSON.parse(line) as unknown;
          if (record && typeof record === "object" && !Array.isArray(record)) ledger = foldBackgroundTaskRecord(ledger, record as RecordLike);
        } catch {
          /* A torn or foreign line moves nothing. */
        }
      }
      carry = Buffer.from(pending.subarray(lastNewline + 1));
    }
    /* The unterminated tail is read again once its line is complete. */
    const consumed = offset - carry.length;
    cache.delete(transcriptPath);
    cache.set(transcriptPath, { dev: stat.dev, ino: stat.ino, offset: consumed, ledger });
    while (cache.size > MAX_CACHED_TRANSCRIPTS) cache.delete(cache.keys().next().value!);
    return ledger;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}
