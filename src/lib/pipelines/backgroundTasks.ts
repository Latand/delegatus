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
  /** TaskStop tool-use ids paired with their requested task ids. An error
      result contains only text, so this keeps that terminal fact correlated. */
  taskStops: Record<string, string>;
  wakeup: RunningBackgroundTask | null;
  /** Epoch ms of the newest delivered completion notification or stop: the
      moment the agent last heard that background work ended. */
  lastReportedAt: number | null;
};

const MAX_ENDED_IDS = 500;
const MAX_TASK_STOP_IDS = 500;

export function emptyBackgroundTaskLedger(): BackgroundTaskLedger {
  return { running: {}, ended: [], taskStops: {}, wakeup: null, lastReportedAt: null };
}

function recordTs(record: RecordLike): number {
  return Date.parse(String(record.timestamp ?? "")) || 0;
}

/** A restart reports every task the previous process left without a record in
    one notification: several `<task-id>` lines under one `<status>`, plus a
    scan marker with this prefix that names no task. */
const ORPHAN_SUMMARY_PREFIX = "__orphan_summary";

function taskNotifications(text: string): Array<{ id: string; terminal: boolean }> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("<task-notification")) return [];
  const found: Array<{ id: string; terminal: boolean }> = [];
  for (const block of trimmed.matchAll(/<task-notification\b[^>]*>([\s\S]*?)<\/task-notification>/g)) {
    const body = block[1] ?? "";
    /* A Monitor's expiry is terminal for the watch even if the watched
       stream remains alive. Claude reports that notice without <status>. */
    const terminal = /<status>\s*[^<]+?\s*<\/status>/.test(body)
      || /\[Monitor expired after\s+\d+(?:\.\d+)?\s*[smh]\b/i.test(body);
    for (const match of body.matchAll(/<task-id>\s*([^<\s]+)\s*<\/task-id>/g)) {
      const id = match[1]!;
      if (!id.startsWith(ORPHAN_SUMMARY_PREFIX)) found.push({ id, terminal });
    }
  }
  return found;
}

function contentParts(record: RecordLike): RecordLike[] {
  const content = recordValue(record.message)?.content;
  return Array.isArray(content) ? content.map((part) => recordValue(part) ?? {}) : [];
}

function toolResultText(record: RecordLike): string {
  return contentParts(record)
    .filter((part) => part.type === "tool_result")
    .map((part) => stringValue(part.content) ?? stringValue(part.text) ?? "")
    .join("\n");
}

function noTaskFoundId(text: string): string | null {
  return text.match(/\bNo task found with ID:\s*([^<\s]+)/i)?.[1] ?? null;
}

function end(ledger: BackgroundTaskLedger, id: string, ts: number): void {
  delete ledger.running[id];
  if (!ledger.ended.includes(id)) ledger.ended = [...ledger.ended, id].slice(-MAX_ENDED_IDS);
  ledger.lastReportedAt = Math.max(ledger.lastReportedAt ?? 0, ts) || null;
}

/** Apply one Claude transcript record to the ledger. Pure over its inputs:
    the ledger passed in is copied, never mutated. */
export function foldBackgroundTaskRecord(ledger: BackgroundTaskLedger, record: RecordLike): BackgroundTaskLedger {
  const next: BackgroundTaskLedger = { ...ledger, running: { ...ledger.running }, taskStops: { ...ledger.taskStops } };
  const ts = recordTs(record);
  if (record.type === "assistant") {
    for (const part of contentParts(record)) {
      if (part.type === "tool_use" && part.name === "ScheduleWakeup") next.wakeup = null;
      if (part.type === "tool_use" && part.name === "TaskStop") {
        const callId = stringValue(part.id);
        const taskId = stringValue(recordValue(part.input)?.task_id);
        if (callId && taskId) {
          next.taskStops[callId] = taskId;
          const oldest = Object.keys(next.taskStops).slice(0, -MAX_TASK_STOP_IDS);
          for (const id of oldest) delete next.taskStops[id];
        }
      }
    }
    return next;
  }
  if (record.type === "attachment") {
    const attachment = recordValue(record.attachment);
    if (attachment?.type !== "queued_command") return next;
    for (const notice of taskNotifications(stringValue(attachment.prompt) ?? "")) {
      if (notice.terminal) end(next, notice.id, ts);
    }
    return next;
  }
  if (record.type !== "user") return next;
  const parts = contentParts(record);
  if (parts.some((part) => part.type === "tool_result")) {
    const result = recordValue(record.toolUseResult);
    const toolResult = parts.find((part) => part.type === "tool_result");
    const stopCallId = stringValue(toolResult?.tool_use_id);
    const requestedStopId = stopCallId ? next.taskStops[stopCallId] ?? null : null;
    if (stopCallId) delete next.taskStops[stopCallId];
    const noTaskId = noTaskFoundId(toolResultText(record));
    const missingTask = requestedStopId === noTaskId ? noTaskId : null;
    if (!result) {
      if (missingTask) end(next, missingTask, ts);
      return next;
    }
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
    if (missingTask) end(next, missingTask, ts);
    return next;
  }
  for (const notice of taskNotifications(claudeUserText(recordValue(record.message)?.content))) {
    if (notice.terminal) end(next, notice.id, ts);
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
  return tasks.filter((task) => task.expiresAt === null || task.expiresAt > nowMs);
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

/** How long a stage or a review flow waits, silent, on background work its
    agent started before it parks naming it (#1441). An hour covers the longest
    re-invocation the harness schedules itself (a wakeup clamps at 3600 s) and a
    long bench or CI wait; parking earlier would lose the work the task is doing.
    A host that died writes nothing more, so this bound covers it too. */
export const BACKGROUND_TASK_WAIT_CEILING_MS = 60 * 60_000;
/** The bound on the whole wait, however often the agent answers in between:
    a persistent monitor over a source that keeps emitting, or a wakeup the
    agent keeps re-arming, never lets the silence bound run out. */
export const BACKGROUND_TASK_WAIT_LIMIT_MS = 4 * 60 * 60_000;
export const BACKGROUND_TASK_WAIT_DETAIL_PREFIX = "waiting: ";

/** A wait on background work, as the stage attempt or the flow records it.
    `openedAt` is when the wait began and bounds it as a whole; `since` is when
    the reader first saw the transcript silent at `silentSince` (its newest
    record) with the work out. `until` is when the wait parks if the work never
    reports: the earlier of the silence bound and the whole-wait bound. */
export type BackgroundWait = {
  openedAt: string;
  since: string;
  until: string;
  silentSince: number | null;
  tasks: Array<{ id: string; kind: RunningBackgroundTask["kind"] }>;
};

/**
 * One step of a bounded wait on live background work, shared by the pipeline
 * controller and review flows. Any new record (a monitor event the agent
 * answered, a new task) restarts the silence bound; nothing restarts the
 * whole-wait bound. `expired` names the bound that ran out, and `reason` is
 * the park reason naming the work; otherwise `detail` is the visible state
 * detail for the wait.
 */
export function stepBackgroundWait(
  prior: BackgroundWait | undefined | null,
  live: readonly RunningBackgroundTask[],
  silentSince: number | null,
  now: string,
  settlesOn: string,
): { wait: BackgroundWait; expired: false; detail: string } | { wait: BackgroundWait; expired: true; reason: string } {
  const since = prior && prior.silentSince === silentSince ? prior.since : now;
  const openedAt = prior?.openedAt ?? now;
  const silenceBound = Date.parse(since) + BACKGROUND_TASK_WAIT_CEILING_MS;
  const wholeBound = Date.parse(openedAt) + BACKGROUND_TASK_WAIT_LIMIT_MS;
  const until = new Date(Math.min(silenceBound, wholeBound)).toISOString();
  const named = describeBackgroundTasks(live);
  const wait: BackgroundWait = { openedAt, since, until, silentSince, tasks: live.map((task) => ({ id: task.id, kind: task.kind })) };
  if (Date.parse(now) >= Date.parse(until)) {
    return {
      wait,
      expired: true,
      reason: silenceBound <= wholeBound
        ? `waiting for ${named} exceeded ${BACKGROUND_TASK_WAIT_CEILING_MS / 60_000} min without a notification; the agent and its work were left running`
        : `waiting for ${named} exceeded ${BACKGROUND_TASK_WAIT_LIMIT_MS / 3_600_000} h in all without the work reporting; the agent and its work were left running`,
    };
  }
  return { wait, expired: false, detail: `${BACKGROUND_TASK_WAIT_DETAIL_PREFIX}${named}; ${settlesOn}, and parks at ${until} if it never does` };
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
const RELEVANT_LINE = /backgroundTaskId|task-notification|"taskId"|"task_id"|scheduledFor|"ScheduleWakeup"|No task found with ID:/;
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
