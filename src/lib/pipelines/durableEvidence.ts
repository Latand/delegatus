import fs from "node:fs";

import { turnStateFromRecords } from "@/lib/accounts/migration/turnState";
import type { RuntimeEngine as FlowEngine } from "@/lib/agent/runtimeConfig";
import { lastAssistantMessageFromRecords } from "@/lib/scanner/lastAssistantMessage";
import { heldBackgroundTasks, readBackgroundTaskLedger, type RunningBackgroundTask } from "@/lib/pipelines/backgroundTasks";
import { readStableTailRecords } from "@/lib/scanner/activity";
import { numberValue, recordValue, recordsValue, stringValue } from "@/lib/scanner/json";

import { classifyProviderCondition } from "./providerConditions";

type RecordLike = Record<string, unknown>;

/**
 * Turn evidence read straight from the stage transcript artifact — the durable
 * completion authority for a pipeline attempt. Independent of the scanner
 * projection (which can transiently lose the transcript) and of the runtime
 * session ledger (which can stay `running` past the end of the turn). `turn` is
 * "terminal" only on native lifecycle evidence (Claude end-turn stop, Codex
 * task/turn completion with no open tool calls), so a mid-work assistant
 * message can never present as a completed turn.
 */
export type StageTurnEvidence = {
  turn: "terminal" | "busy" | "unknown";
  message: { text: string; ts: number } | null;
  /** Prose written before this attempt's stage_report call, when the agent
      followed its detailed answer with a shorter closing message. */
  reportProse?: string | null;
  /** The verified read covers the complete artifact and contains only Codex's
      launch metadata record. */
  launchOnly?: boolean;
  /** Timestamp of the newest record in the artifact, whatever its kind — the
      witness that a transcript has been silent since a runtime-host succession
      cut its turn (#1747). Distinct from `message.ts`, which moves only on an
      assistant message: a delivered prompt and a tool result move this and not
      that. Null when the read found no record carrying a timestamp. */
  lastRecordAt?: number | null;
  /** Timestamp of the newest record the agent's work wrote: a prompt, a reply,
      a tool call or its result. The bookkeeping a CLI writes as it exits or
      resumes (a shutdown interrupt, a replayed meta prompt, a synthetic
      no-response, Codex token counts and turn aborts) is left out, and so is
      an undated record, which `lastRecordAt` dates by the file. A move here is
      work; a move of `lastRecordAt` alone may be neither. */
  lastAgentEventAt?: number | null;
  /** The provider's own end-of-turn notice, when the record that closed the
      turn is one: a session or model limit, an expired credential, a refusal —
      a message the CLI writes *instead of* the agent's answer, so the turn
      ended with nothing to parse (#1141). Null whenever the turn ended on the
      agent's own message, and null while the turn is still open, so silence
      can never present as one. */
  terminalProviderMessage?: {
    text: string;
    ts: number;
    errorClass?: string | null;
    /** Usage-limit evidence from this same terminal turn. */
    usageLimit?: { resetsAt: number | null };
  } | null;
  /** Harness-tracked background work the conversation started and has not
      heard the end of (#1441), read from the whole artifact, expired or not:
      the reader filters by its own clock with `liveBackgroundTasks`. While one
      is live, a terminal turn is not the conversation's last. Empty for Codex;
      absent when the artifact could not be read for it. */
  backgroundTasks?: RunningBackgroundTask[];
  /** Epoch ms of the newest task notification or stop the agent received. A
      stage report filed before it was filed while that work was still out. */
  backgroundReportedAt?: number | null;
};

function recordTs(record: RecordLike, fallbackTs: number): number {
  return Date.parse(String(record.timestamp ?? "")) || fallbackTs;
}

function claudeAssistantText(record: RecordLike): string {
  return recordsValue(recordValue(record.message)?.content)
    .filter((part) => part.type === "text")
    .map((part) => stringValue(part.text) ?? "")
    .join("\n")
    .trim();
}

/** Codex turn-end records that carry a provider failure instead of a result.
    A clean completion has no error field at all, so it yields nothing here. */
function codexTurnEndFailure(payload: RecordLike): string | null {
  const error = recordValue(payload.error);
  const info = stringValue(payload.codex_error_info) ?? stringValue(error?.codex_error_info);
  const message = stringValue(error?.message)
    ?? stringValue(payload.error)
    ?? (info ? stringValue(payload.message) : null);
  return message ?? info;
}

function codexErrorInfo(payload: RecordLike): string | null {
  return stringValue(payload.codex_error_info)
    ?? stringValue(recordValue(payload.error)?.codex_error_info);
}

function isCodexUsageLimit(payload: RecordLike): boolean {
  const info = codexErrorInfo(payload)?.toLowerCase();
  return info === "usage_limit" || info === "usage_limit_exceeded";
}

/** Claude CLI writes a synthetic assistant with this terminal API-error code
    and notice when the account's session capacity is spent. */
function isClaudeUsageLimit(record: RecordLike, text: string): boolean {
  return record.isApiErrorMessage === true
    && record.error === "rate_limit"
    && classifyProviderCondition("claude", stringValue(record.error), text).kind === "usage_limit";
}

/** Resolve a native reset label against the closing record's date in its own
    timezone. Never use this machine's timezone or the artifact's mtime: they
    can differ from the provider's clock, including after a transcript replay. */
function claudeUsageLimitResetAt(record: RecordLike, text: string): number | null {
  const timestamp = stringValue(record.timestamp) ?? "";
  if (!/(?:z|[+-]\d{2}:?\d{2})$/i.test(timestamp)) return null;
  const recordedAt = Date.parse(timestamp);
  const label = /\bresets\s+(?:([a-z]{3,9})\s+(\d{1,2})(?:,?\s+(\d{4}))?(?:,\s*|\s+at\s+|\s+))?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(([^)]+)\)/i.exec(text);
  if (!label || !Number.isFinite(recordedAt)) return null;
  let hour = Number(label[4]);
  const minute = Number(label[5] ?? 0);
  if (minute > 59 || (label[6] ? hour < 1 || hour > 12 : hour > 23)) return null;
  if (label[6]) hour = hour % 12 + (label[6].toLowerCase() === "pm" ? 12 : 0);
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: label[7]!.trim(), year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23",
    });
    const localTime = (instant: number) => {
      const parts = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, part.value]));
      return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    };
    const localDate = new Date(localTime(recordedAt));
    const month = label[1] ? ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(label[1].slice(0, 3).toLowerCase()) : localDate.getUTCMonth();
    const day = label[2] ? Number(label[2]) : localDate.getUTCDate();
    const year = label[3] ? Number(label[3]) : localDate.getUTCFullYear();
    if (month < 0 || day < 1 || day > 31) return null;
    // A clock-only notice means the next daily occurrence. A named date may
    // cross New Year; an explicit year is never silently rolled forward.
    for (let next = 0; next < (label[3] ? 1 : 2); next += 1) {
      const wall = Date.UTC(year + (label[1] ? next : 0), month, day + (label[1] ? 0 : next), hour, minute);
      const date = new Date(wall);
      if (label[1] && (date.getUTCMonth() !== month || date.getUTCDate() !== day)) return null;
      // Sample both sides of a timezone transition and round-trip candidates.
      // A repeated DST clock uses the later occurrence to avoid an early retry;
      // a nonexistent clock cannot establish a reset instant.
      const candidates = [-86_400_000, 0, 86_400_000].map(delta => {
        const probe = wall + delta;
        return wall - (localTime(probe) - probe);
      }).filter(instant => localTime(instant) === wall);
      if (candidates.length === 0) return null;
      const reset = Math.max(...candidates);
      if (reset >= recordedAt) return reset / 1_000;
    }
  } catch { /* An absent/unsupported timezone leaves the reset unknown. */ }
  return null;
}

const CODEX_TURN_END_TYPES = new Set(["task_complete", "turn_complete", "turn_completed", "turn_aborted"]);
const CODEX_TURN_START_TYPES = new Set(["task_started", "turn_started", "user_message"]);

/** Reset of the governing window in the quota event immediately preceding a
    terminal usage-limit record. A windowless credits event says nothing about
    the reset, so the scan continues to the latest event that carries windows. */
function codexUsageLimitResetAt(records: RecordLike[], endIndex: number): number | null {
  for (let index = endIndex - 1; index >= 0; index -= 1) {
    const payload = recordValue(records[index]?.payload) ?? {};
    const type = stringValue(payload.type) ?? "";
    if (CODEX_TURN_START_TYPES.has(type)) return null;
    const info = recordValue(payload.info);
    const rateLimits = recordValue(payload.rate_limits) ?? recordValue(info?.rate_limits);
    if (!rateLimits) continue;
    const limitId = stringValue(rateLimits.limit_id);
    if (limitId && limitId !== "codex") continue;
    const windows = [recordValue(rateLimits.primary), recordValue(rateLimits.secondary)]
      .filter((window): window is RecordLike => window !== null)
      .flatMap((window) => {
        const usedPercent = numberValue(window.used_percent);
        if (usedPercent === null) return [];
        return [{ usedPercent, resetsAt: numberValue(window.resets_at) }];
      });
    if (windows.length === 0) continue;
    const governingPercent = Math.max(...windows.map((window) => window.usedPercent));
    const governingResets = windows
      .filter((window) => window.usedPercent === governingPercent)
      .map((window) => window.resetsAt);
    return governingResets.every((reset): reset is number => reset !== null)
      ? Math.max(...governingResets)
      : null;
  }
  return null;
}

function providerTurnRecords(records: RecordLike[], codex: boolean): RecordLike[] {
  if (codex) return records;
  // A metadata replay ending in shutdown preserves any native provider class.
  // A real continuation prompt or real assistant output starts a newer turn.
  let closedByMarker = false;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    if (record.type === "result" || record.type === "assistant" && record.isApiErrorMessage === true) {
      return closedByMarker ? records.slice(0, index + 1) : records;
    }
    if (record.type === "assistant") {
      if (recordValue(record.message)?.model !== "<synthetic>" || !/^no response requested\.?$/i.test(claudeAssistantText(record).trim())) return records;
      closedByMarker = true;
    } else if (record.type === "user") {
      const content = stringValue(recordValue(record.message)?.content) ?? claudeAssistantText(record);
      const interrupted = record.interruptedByShutdown === true || "interruptedMessageId" in record
        || /^\s*\[Request interrupted by user(?: for tool use)?\]\s*$/.test(content);
      if (interrupted) closedByMarker = true;
      else if (!closedByMarker || record.isMeta !== true) return records;
    }
  }
  return records;
}

/**
 * The notice the provider wrote when it ended the turn, read from the record
 * that CLOSED it — the assistant record Claude flags `isApiErrorMessage`, or
 * the Codex turn-end record carrying a failure. Everything after that record
 * on Claude's side is bookkeeping the CLI appends once the turn is over.
 *
 * Read from the closing record rather than from prose, so an agent that merely
 * quotes a limit notice in its answer is not mistaken for one, and a later
 * prompt that reopened the turn withdraws the evidence.
 */
function terminalProviderMessageFromRecords(
  records: RecordLike[],
  codex: boolean,
  fallbackTs: number,
): NonNullable<StageTurnEvidence["terminalProviderMessage"]> | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    if (codex) {
      const payload = recordValue(record.payload) ?? {};
      const type = stringValue(payload.type) ?? "";
      if (CODEX_TURN_START_TYPES.has(type)) return null;
      if (!CODEX_TURN_END_TYPES.has(type)) continue;
      const failure = codexTurnEndFailure(payload) ?? (type === "turn_aborted" ? "stage turn aborted before completion" : null);
      return failure
        ? {
            text: failure,
            errorClass: codexErrorInfo(payload) ?? (type === "turn_aborted" ? "turn_aborted" : null),
            ts: recordTs(record, fallbackTs),
            ...(isCodexUsageLimit(payload)
              ? { usageLimit: { resetsAt: codexUsageLimitResetAt(records, index) } }
              : {}),
          }
        : null;
    }
    const message = recordValue(record.message);
    const content = stringValue(message?.content) ?? claudeAssistantText(record);
    const interrupted = record.type === "user" && (record.interruptedByShutdown === true
      || "interruptedMessageId" in record || /^\s*\[Request interrupted by user(?: for tool use)?\]\s*$/.test(content));
    if (interrupted || (record.type === "result" && record.subtype === "interrupted")
      || (record.type === "assistant" && ["aborted", "interrupted"].includes(stringValue(message?.stop_reason) ?? ""))) {
      return { text: "stage turn interrupted before completion", ts: recordTs(record, fallbackTs), errorClass: "turn_aborted" };
    }
    if (record.type === "user") return null;
    if (record.type !== "assistant") continue;
    if (record.isApiErrorMessage !== true) return null;
    const text = claudeAssistantText(record);
    return text
      ? {
          text,
          errorClass: stringValue(record.error),
          ts: recordTs(record, fallbackTs),
          ...(isClaudeUsageLimit(record, text) ? { usageLimit: { resetsAt: claudeUsageLimitResetAt(record, text) } } : {}),
        }
      : null;
  }
  return null;
}

const CODEX_BOOKKEEPING_TYPES = new Set(["token_count", "turn_aborted"]);

function agentEventAt(records: RecordLike[], codex: boolean): number | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    const at = Date.parse(String(record.timestamp ?? ""));
    if (!Number.isFinite(at)) continue;
    if (codex) {
      const type = stringValue(recordValue(record.payload)?.type);
      if (type && !CODEX_BOOKKEEPING_TYPES.has(type)) return at;
      continue;
    }
    if (record.type !== "user" && record.type !== "assistant") continue;
    const message = recordValue(record.message);
    if (record.isMeta === true || message?.model === "<synthetic>") continue;
    const content = stringValue(message?.content) ?? claudeAssistantText(record);
    if (record.type === "user" && (record.interruptedByShutdown === true || "interruptedMessageId" in record
      || /^\s*\[Request interrupted by user(?: for tool use)?\]\s*$/.test(content))) continue;
    return at;
  }
  return null;
}

/** Whether a Claude stage attempt ended on a provider failure the CLI gave up
    on: its newest prompt or assistant record is a flagged API error stamped
    with a closing stop reason. The shared turn projection keeps such a turn
    open unless the error class is terminal for the session, because activity
    and account migration must not read a retry as an end (#1811). A stage
    reads it as the end of its attempt whatever the class, since the engine
    retries the stage itself and needs the class to choose how. */
function claudeApiErrorClosedAttempt(records: RecordLike[]): boolean {
  const newest = records.findLast((record) => record.type === "assistant" || record.type === "user");
  if (newest?.type !== "assistant" || newest.isApiErrorMessage !== true) return false;
  const stop = stringValue(recordValue(newest.message)?.stop_reason);
  return stop === "end_turn" || stop === "stop_sequence";
}

/** The widest verified read spent looking for a reported attempt's prose. A
    brief is relayed at 60 KiB at most, so a window this size holds it with
    room for the tool output written after the report. */
export const MAX_REPORT_EVIDENCE_BYTES = 8 * 1024 * 1024;

export async function durableStageTurnEvidence(
  engine: FlowEngine,
  transcriptPath: string,
  reportAt?: string | null,
  attemptStartedAt?: string | null,
  readTail: typeof readStableTailRecords = readStableTailRecords,
): Promise<StageTurnEvidence | null> {
  const read = await readTail(transcriptPath);
  if (read.integrity !== "complete") return null;
  const codex = engine === "codex";
  let fallbackTs = 0;
  try {
    fallbackTs = fs.statSync(transcriptPath).mtimeMs;
  } catch {
    /* The identity-verified read succeeded; a raced-away stat only loses the
       timestamp fallback for records that carry no timestamp of their own. */
  }
  const reportTime = reportAt ? Date.parse(reportAt) : NaN;
  const startedTime = attemptStartedAt ? Date.parse(attemptStartedAt) : NaN;
  let evidenceRead = read;
  let evidenceBytes = 131_072;
  let reportProse: string | null = null;
  let turnRecords = evidenceRead.records;
  let message;
  let turn;
  while (true) {
    turnRecords = providerTurnRecords(evidenceRead.records, codex);
    message = lastAssistantMessageFromRecords(turnRecords, codex ? "codex-sessions" : "claude-projects", fallbackTs);
    turn = turnStateFromRecords(turnRecords, codex ? "codex" : "claude");
    if (Number.isFinite(reportTime)) {
      reportProse = lastAssistantMessageFromRecords(
        turnRecords.filter((record) => {
          const timestamp = recordTs(record, fallbackTs);
          return timestamp <= reportTime && (!Number.isFinite(startedTime) || timestamp > startedTime);
        }),
        codex ? "codex-sessions" : "claude-projects",
        fallbackTs,
      )?.text ?? null;
    }
    if (!Number.isFinite(reportTime) || !evidenceRead.prefixTruncated
      || (reportProse !== null && message !== null && turn.state !== "unknown")) break;
    /* Once the window reaches back to the attempt's start, an older record
       cannot belong to this attempt: an agent that wrote no prose before its
       report is answered here, without reading the whole transcript. */
    const oldestAt = evidenceRead.records.map((record) => recordTs(record, 0)).find((ts) => ts > 0);
    if (Number.isFinite(startedTime) && oldestAt !== undefined && oldestAt <= startedTime) break;
    if (evidenceBytes >= MAX_REPORT_EVIDENCE_BYTES) break;
    // A JSONL line crossing the tail boundary is discarded. Grow the
    // verified window until both the final and pre-report messages are read.
    evidenceBytes = Math.min(evidenceBytes * 2, MAX_REPORT_EVIDENCE_BYTES);
    const expanded = await readTail(transcriptPath, evidenceBytes);
    /* A transcript appended between the reads fails the identity check. The
       last complete read still stands, and it is what the background-task
       hold and the verdict were going to read anyway. */
    if (expanded.integrity !== "complete") break;
    evidenceRead = expanded;
  }
  const terminalNotice = terminalProviderMessageFromRecords(turnRecords, codex, fallbackTs);
  const nativeCut = terminalNotice?.errorClass === "turn_aborted";
  const terminal = nativeCut || turn.state === "terminal" || (!codex && claudeApiErrorClosedAttempt(turnRecords));
  const newest = turnRecords.at(-1);
  const ledger = codex ? null : await readBackgroundTaskLedger(transcriptPath);
  return {
    turn: terminal ? "terminal" : turn.state === "busy" ? "busy" : "unknown",
    message: nativeCut ? null : message,
    ...(reportAt ? { reportProse } : {}),
    lastRecordAt: newest ? recordTs(newest, fallbackTs) || null : null,
    lastAgentEventAt: agentEventAt(evidenceRead.records, codex),
    launchOnly: codex
      && !evidenceRead.prefixTruncated
      && evidenceRead.records.length === 1
      && evidenceRead.records[0]?.type === "session_meta",
    /* Gated on the turn reading above: a provider error the CLI may still
       retry inside an open turn keeps the busy projection (#516) and carries
       no notice. The one reading past the shared projection is a Claude API
       error stamped with a closing stop reason, which ends the stage attempt
       whatever its class (`claudeApiErrorClosedAttempt`). */
    terminalProviderMessage: terminal ? terminalNotice : null,
    ...(codex
      ? { backgroundTasks: [], backgroundReportedAt: null }
      : ledger
        ? { backgroundTasks: heldBackgroundTasks(ledger), backgroundReportedAt: ledger.lastReportedAt }
        : {}),
  };
}
