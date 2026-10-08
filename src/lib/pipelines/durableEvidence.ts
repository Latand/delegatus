import fs from "node:fs";

import { claudeUserText, isClaudeInterruptSentinelText, isClaudeTurnWindowMeta } from "@/lib/claudeProtocolUser";
import { claudeMessageProvenance } from "@/lib/runtime/claudeMessageProvenance";
import { RECOVERY_NOTICE_ORIGIN } from "@/lib/runtime/recoveryNotices";
import { decodeCodexStructuredUserText } from "@/lib/runtime/codexStructuredUserText.server";

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
  /** Delivered prompts in this verified tail. Harness wakes and controller
      continuations retain quota recovery; external prompts withdraw it. */
  prompts?: Array<{ ts: number; origin: "external" | "harness" | "pipeline" }>;
  /** First cut of the open chain: the provider cuts after this attempt's last
      agent output. Null when agent output follows every cut. */
  firstProviderCutAt?: number | null;
  /** Prompts after the open chain's first cut, in verified record order.
      Omitted when no chain is open. */
  externalPromptAfterCut?: boolean;
  automaticPromptAfterCut?: boolean;
  /** Whether the requested cut is still in the open chain. A requested cut of
      0 names the chain a zero-time successor inherited, open from the attempt
      start. False once agent output follows it; omitted when the verified read
      cannot place it. */
  requestedCutOpen?: boolean;
  /** False if the bounded verified read could not cover the open chain. */
  promptHistoryComplete?: boolean;
  /** Native human prompt or task start witness, excluding tool results and shutdown markers. */
  turnStartedAt?: number | null;
  /** The verified read covers the complete artifact and contains only Codex's
      launch metadata record. */
  launchOnly?: boolean;
  /** Timestamp of the newest record in the artifact, whatever its kind — the
      witness that a transcript has been silent since a runtime-host succession
      cut its turn (#1747). Distinct from `message.ts`, which moves only on an
      assistant message: a delivered prompt and a tool result move this and not
      that. Null when the read found no record carrying a timestamp. */
  lastRecordAt?: number | null;
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

/** A record the agent authored after the provider accepted a turn. */
function agentOutput(record: RecordLike, codex: boolean): boolean {
  if (codex) {
    const payload = recordValue(record.payload);
    const type = stringValue(payload?.type) ?? "";
    return type === "agent_message" || type === "agent_reasoning" || type === "reasoning"
      || type === "message" && payload?.role === "assistant" || type.endsWith("_call")
      || type === "item_completed" && /^(?:agent_?message|reasoning)$/i.test(stringValue(recordValue(payload?.item)?.type) ?? "");
  }
  const message = recordValue(record.message);
  return record.type === "assistant" && record.isApiErrorMessage !== true && message?.model !== "<synthetic>"
    && recordsValue(message?.content).some(part => part.type === "tool_use" || part.type === "thinking"
      || part.type === "text" && !!stringValue(part.text)?.trim());
}

/** Track the open cut chain in physical record order: agent output closes it,
    and the next native provider cut of this attempt opens a new one. */
function cutChain(codex: boolean, startedAt: number, requestedAt: number | undefined, fallbackTs: number) {
  let firstCutAt: number | null = null;
  let requestedOpen: boolean | undefined;
  return {
    feed(record: RecordLike): "output" | "first-cut" | "cut" | null {
      const at = recordTs(record, fallbackTs);
      if (requestedAt === 0 && requestedOpen === undefined && at > 0 && !(at < startedAt)) requestedOpen = true;
      if (agentOutput(record, codex)) {
        firstCutAt = null;
        if (requestedOpen) requestedOpen = false;
        return "output";
      }
      const failure = at > 0 && !(at < startedAt) ? terminalProviderMessageFromRecords([record], codex, 0) : null;
      // The same record ends a stage attempt in the tick's turn reading.
      if (!failure || failure.errorClass === "turn_aborted"
        || turnStateFromRecords([record], codex ? "codex" : "claude").state !== "terminal"
          && (codex || !claudeApiErrorClosedAttempt([record]))) return null;
      if (requestedAt && at === requestedAt) requestedOpen = true;
      if (firstCutAt !== null) return "cut";
      firstCutAt = at;
      return "first-cut";
    },
    firstCutAt: () => firstCutAt,
    requestedOpen: () => requestedOpen,
  };
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

function nativeTurnStartedAt(records: RecordLike[], codex: boolean): number | null {
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index]!;
    if (codex) {
      const payload = recordValue(record.payload);
      if (!payload || !(CODEX_TURN_START_TYPES.has(String(payload.type))
        || payload.type === "message" && payload.role === "user")) continue;
    } else {
      if (record.type !== "user" || record.isMeta === true || record.interruptedByShutdown === true || "interruptedMessageId" in record) continue;
      const content = recordValue(record.message)?.content;
      if (recordsValue(content).some(part => part.type === "tool_result")) continue;
      const text = typeof content === "string" ? content : recordsValue(content).filter(part => part.type === "text").map(part => stringValue(part.text) ?? "").join("\n");
      if (!text.trim() || /^\s*\[Request interrupted by user(?: for tool use)?\]\s*$/.test(text)) continue;
    }
    const timestamp = recordTs(record, 0);
    if (timestamp) return timestamp;
  }
  return null;
}

/** Recover a continuation boundary without retaining intervening tool output.
 * Backward reads hold one small native record; oversized records are skipped.
 * The descriptor and pathname must still match the snapshot preceding the tail. */
async function recoverNativeTurnStart(pathname: string, codex: boolean, after: number, baseline: fs.BigIntStats): Promise<number | null> {
  let handle: fs.promises.FileHandle | null = null;
  const same = (a: fs.BigIntStats, b: fs.BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
  try {
    handle = await fs.promises.open(pathname, "r");
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !same(baseline, before)) return null;
    let position = Number(before.size);
    if (!Number.isSafeInteger(position)) return null;
    const buffer = Buffer.alloc(65_536);
    let pending: Buffer = Buffer.alloc(0);
    let oversized = false;
    let found: number | null = null;
    let done = false;
    const prepend = (part: Buffer) => {
      if (oversized) return;
      if (part.length + pending.length > 131_072) { pending = Buffer.alloc(0); oversized = true; }
      else pending = Buffer.concat([part, pending]);
    };
    const finish = () => {
      if (!oversized && pending.length) {
        try {
          const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pending));
          const record = recordValue(value);
          const timestamp = record ? nativeTurnStartedAt([record], codex) : null;
          if (timestamp !== null) { found = timestamp >= after ? timestamp : null; done = true; }
        } catch { /* A non-native or oversized historical line supplies no witness. */ }
      }
      pending = Buffer.alloc(0); oversized = false;
    };
    while (position > 0 && !done) {
      const length = Math.min(buffer.length, position); position -= length;
      let read = 0;
      while (read < length) {
        const chunk = await handle.read(buffer, read, length - read, position + read);
        if (!chunk.bytesRead) return null;
        read += chunk.bytesRead;
      }
      let end = length;
      for (let index = length - 1; index >= 0 && !done; index--) {
        if (buffer[index] !== 0x0a) continue;
        prepend(buffer.subarray(index + 1, end)); finish(); end = index;
      }
      if (!done) prepend(buffer.subarray(0, end));
    }
    if (!done) finish();
    const end = await handle.stat({ bigint: true });
    const pathEnd = await fs.promises.stat(pathname, { bigint: true });
    return same(before, end) && same(end, pathEnd) ? found : null;
  } catch { return null; }
  finally { await handle?.close().catch(() => undefined); }
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

function codexNativeUserPrompt(record: RecordLike) {
  const payload = recordValue(record.payload);
  if (!payload) return null;
  const item = recordValue(payload.item);
  const family = payload.type === "user_message" ? "event"
    : payload.type === "message" && payload.role === "user" ? "response"
    : payload.type === "item_completed" && (item?.type === "UserMessage" || item?.type === "userMessage") ? "item" : null;
  if (!family) return null;
  const user = family === "item" ? item! : payload;
  const text = stringValue(user.message) ?? stringValue(user.text) ?? stringValue(user.content)
    ?? (Array.isArray(user.content) ? user.content.map(part => typeof part === "string" ? part
      : stringValue(recordValue(part)?.text) ?? stringValue(recordValue(part)?.content) ?? "").join("") : "");
  return { text };
}

/** Tool results and metadata never stand in for a delivered prompt. SDK
    envelopes need the broker's authorship join: human and controller sends
    share that envelope in production. Missing provenance stays external. */
function stagePrompts(records: RecordLike[], codex: boolean, transcriptPath: string): Array<NonNullable<StageTurnEvidence["prompts"]>[number] & { recordIndex: number }> {
  const provenance = codex ? {} : claudeMessageProvenance(transcriptPath);
  return records.flatMap<NonNullable<StageTurnEvidence["prompts"]>[number] & { recordIndex: number }>((record, recordIndex) => {
    const ts = recordTs(record, 0);
    // A native row without time still participates in physical prompt order.
    if (codex) {
      const prompt = codexNativeUserPrompt(record);
      if (!prompt) return [];
      let automatic = false;
      try {
        const origin = decodeCodexStructuredUserText(prompt.text).origin;
        automatic = origin?.kind === "agent" && (origin.role === "pipeline" || origin.role === RECOVERY_NOTICE_ORIGIN.role);
      } catch { /* Unavailable metadata leaves this prompt external. */ }
      return [{ ts, recordIndex, origin: automatic ? "pipeline" as const : "external" as const }];
    }
    if (record.type !== "user") return [];
    const text = claudeUserText(recordValue(record.message)?.content).trim();
    if (!text && !recordsValue(recordValue(record.message)?.content).some(part => part.type === "image")) return [];
    const kind = stringValue(record.origin) ?? stringValue(recordValue(record.origin)?.kind);
    const author = provenance[stringValue(record.uuid) ?? ""];
    const human = kind === "human" || kind === "operator" || record.promptSource === "typed" || author?.origin === "operator";
    if (!human && (kind === "task" || kind === "task-notification" || kind === "scheduled-trigger"
      || record.turnOrigin === "task_notification" || record.turnOrigin === "scheduled")) return [{ ts, recordIndex, origin: "harness" as const }];
    // Native human rows may have no authorship fields. Their prose alone
    // cannot establish a harness wake or a metadata envelope.
    const metadata = record.isMeta === true || record.isCompactSummary === true || "interruptedMessageId" in record
      || record.promptSource === "command" || record.promptSource === "system"
      || record.interruptedByShutdown === true && isClaudeInterruptSentinelText(text);
    if (!human && metadata && isClaudeTurnWindowMeta(record)) return [];
    return [{ ts, recordIndex, origin: !human && author?.origin === "agent" && (author.senderRole === "pipeline" || author.senderRole === RECOVERY_NOTICE_ORIGIN.role) ? "pipeline" as const : "external" as const }];
  });
}

/** Bound for verified reads of report prose and prompts since a provider cut.
    A brief is relayed at 60 KiB at most; oversized history remains unknown
    when this window cannot cover the requested boundary. */
export const MAX_REPORT_EVIDENCE_BYTES = 8 * 1024 * 1024;

function transcriptSnapshot(pathname: string): string | null {
  try {
    const stat = fs.statSync(pathname, { bigint: true });
    return stat.isFile() ? [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":") : null;
  } catch { return null; }
}

/** Verify history in physical order while retaining only the open cut chain.
    Older rows are validated too: backdated context cannot hide a cut or the
    output that closed it. The byte bound counts from the chain's first cut, so
    a record of any size before it is parsed and dropped. An open chain over
    the bound returns no records; the stable scan still places its first cut
    and the requested position. */
async function readRecoveryWindow(pathname: string, codex: boolean, startedAt: number, requestedAt: number | undefined,
  fallbackTs: number, snapshot: string | null,
): Promise<{ records: RecordLike[] | null; firstCutAt: number | null; requestedCutOpen?: boolean } | null> {
  if (!snapshot) return null;
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(pathname, "r");
    const stat = await handle.stat({ bigint: true });
    if ([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":") !== snapshot) return null;
    const size = Number(stat.size);
    if (!Number.isSafeInteger(size)) return null;
    const chain = cutChain(codex, startedAt, requestedAt, fallbackTs);
    let records: RecordLike[] = [];
    let retainedBytes = 0;
    // A line spanning reads is kept as its parts and joined once at its end.
    let pending: Buffer[] = [];
    const consume = (bytes: Buffer): boolean => {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
      if (!text) return true;
      const value = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const record = value as RecordLike;
      const step = chain.feed(record);
      if (step === "output" || step === "first-cut") {
        records = [];
        retainedBytes = 0;
      }
      // An open chain over the bound stays unknown unless later output closes it.
      if (chain.firstCutAt() !== null && retainedBytes <= MAX_REPORT_EVIDENCE_BYTES) {
        retainedBytes += bytes.length + 1;
        if (retainedBytes <= MAX_REPORT_EVIDENCE_BYTES) records.push(record);
        else records = [];
      }
      return true;
    };
    for (let offset = 0; offset < size;) {
      const buffer = Buffer.alloc(Math.min(65536, size - offset));
      const read = await handle.read(buffer, 0, buffer.length, offset);
      if (read.bytesRead !== buffer.length) return null;
      offset += read.bytesRead;
      let begin = 0;
      for (let end = buffer.indexOf(10); end >= 0; end = buffer.indexOf(10, begin)) {
        const line = buffer.subarray(begin, end);
        if (!consume(pending.length ? Buffer.concat([...pending, line]) : line)) return null;
        pending = [];
        begin = end + 1;
      }
      if (begin < buffer.length) pending.push(buffer.subarray(begin));
    }
    if (pending.length && !consume(Buffer.concat(pending))) return null;
    const after = await handle.stat({ bigint: true });
    if ([after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs].join(":") !== snapshot
      || transcriptSnapshot(pathname) !== snapshot) return null;
    const requestedCutOpen = chain.requestedOpen();
    return { records: retainedBytes > MAX_REPORT_EVIDENCE_BYTES ? null : records, firstCutAt: chain.firstCutAt(),
      ...(requestedCutOpen === undefined ? {} : { requestedCutOpen }) };
  } catch { return null; }
  finally { await handle?.close().catch(() => undefined); }
}

export async function durableStageTurnEvidence(
  engine: FlowEngine,
  transcriptPath: string,
  reportAt?: string | null,
  attemptStartedAt?: string | null,
  readTail: typeof readStableTailRecords = readStableTailRecords,
  afterCutAt?: number,
): Promise<StageTurnEvidence | null> {
  const snapshot = transcriptSnapshot(transcriptPath);
  const artifactBefore = await fs.promises.stat(transcriptPath, { bigint: true }).catch(() => null);
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
  const cutTime = afterCutAt && afterCutAt > 0 ? afterCutAt : NaN;
  let promptBoundary = cutTime;
  let evidenceRead = read;
  let recoveryWindowVerified = false;
  let evidenceBytes = 131_072;
  let reportProse: string | null = null;
  let turnRecords = evidenceRead.records;
  let message;
  let turn;
  while (true) {
    turnRecords = providerTurnRecords(evidenceRead.records, codex);
    message = lastAssistantMessageFromRecords(turnRecords, codex ? "codex-sessions" : "claude-projects", fallbackTs);
    turn = turnStateFromRecords(turnRecords, codex ? "codex" : "claude");
    // Before a wait has been saved, the attempt's history owns cancellation.
    // Expand only for a provider failure that ends the attempt, read as the
    // final turn below reads it; ordinary stages keep their cheap tail read.
    if (!Number.isFinite(promptBoundary) && Number.isFinite(startedTime)
      && (turn.state === "terminal" || !codex && claudeApiErrorClosedAttempt(turnRecords))
      && terminalProviderMessageFromRecords(turnRecords, codex, fallbackTs)) {
      promptBoundary = startedTime;
    }
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
    const oldestAt = evidenceRead.records.map(record => recordTs(record, 0)).find(ts => ts > 0);
    const reportCovered = !Number.isFinite(reportTime) || !evidenceRead.prefixTruncated
      || reportProse !== null && message !== null && turn.state !== "unknown"
      || Number.isFinite(startedTime) && oldestAt !== undefined && oldestAt <= startedTime;
    // Backdated context cannot prove coverage of the cancellation boundary.
    // The verified recovery window must cover the open cut chain.
    const promptsCovered = !Number.isFinite(promptBoundary) || !evidenceRead.prefixTruncated;
    if (reportCovered && promptsCovered) break;
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
  let turnStartedAt = nativeTurnStartedAt(turnRecords, codex);
  // Equal temporal fences query the continuation admission itself. Its native
  // start must remain recoverable even when final-output evidence hits its cap.
  if (turnStartedAt === null && evidenceRead.prefixTruncated && Number.isFinite(startedTime)
    && reportTime === startedTime && artifactBefore) turnStartedAt = await recoverNativeTurnStart(transcriptPath, codex, startedTime, artifactBefore);
  let windowRequestedCutOpen: boolean | undefined;
  let overflow: { firstCutAt: number | null; requestedCutOpen?: boolean } | null = null;
  if (evidenceRead.prefixTruncated && Number.isFinite(promptBoundary) && readTail === readStableTailRecords) {
    const window = await readRecoveryWindow(transcriptPath, codex, startedTime, afterCutAt, fallbackTs, snapshot);
    if (window?.records) {
      evidenceRead = { integrity: "complete", prefixTruncated: true, records: window.records };
      recoveryWindowVerified = true;
      windowRequestedCutOpen = window.requestedCutOpen;
      // Terminal and reset evidence stays with the verified tail, which also
      // contains quota observations immediately before the physical cut.
    } else if (window) overflow = window;
  }
  const terminalNotice = terminalProviderMessageFromRecords(turnRecords, codex, fallbackTs);
  const nativeCut = terminalNotice?.errorClass === "turn_aborted";
  const terminal = nativeCut || turn.state === "terminal" || (!codex && claudeApiErrorClosedAttempt(turnRecords));
  const newest = turnRecords.at(-1);
  const ledger = codex ? null : await readBackgroundTaskLedger(transcriptPath);
  const chain = cutChain(codex, startedTime, afterCutAt, fallbackTs);
  let cutIndex = -1;
  evidenceRead.records.forEach((record, recordIndex) => {
    const step = chain.feed(record);
    if (step === "output") cutIndex = -1;
    else if (step === "first-cut") cutIndex = recordIndex;
  });
  // An open chain over the read bound keeps its prompts unknown. Its first cut
  // and whether agent output closed the requested cut are known from the
  // stable scan of the whole artifact.
  const firstProviderCutAt = overflow ? overflow.firstCutAt : chain.firstCutAt();
  const historyComplete = !evidenceRead.prefixTruncated || recoveryWindowVerified;
  // A partial tail proves a requested position closed, never still open.
  const requestedCutOpen = recoveryWindowVerified ? windowRequestedCutOpen
    : overflow ? overflow.requestedCutOpen
      : afterCutAt === 0 && !historyComplete && chain.requestedOpen() ? undefined : chain.requestedOpen();
  const prompts = stagePrompts(evidenceRead.records, codex, transcriptPath);
  // Native prompt rows and their authorship join must describe one snapshot
  // whenever recovery reads them. A raced append cannot turn a confirmed
  // automatic prompt into human input.
  if ((Number.isFinite(promptBoundary) || afterCutAt !== undefined)
    && (snapshot === null || transcriptSnapshot(transcriptPath) !== snapshot)) return null;
  const afterCut = cutIndex < 0 ? [] : prompts.filter(prompt => prompt.recordIndex > cutIndex);
  return {
    turn: terminal ? "terminal" : turn.state === "busy" ? "busy" : "unknown",
    message: nativeCut ? null : message,
    // Shutdown normalization may remove a human prompt whose turn was interrupted.
    // Cancellation evidence must retain that prompt even when terminal evidence does not.
    prompts: prompts.map(prompt => ({ ts: prompt.ts, origin: prompt.origin })),
    firstProviderCutAt,
    ...(cutIndex < 0 ? {} : {
      externalPromptAfterCut: afterCut.some(prompt => prompt.origin === "external"),
      automaticPromptAfterCut: afterCut.some(prompt => prompt.origin !== "external"),
    }),
    ...(requestedCutOpen === undefined ? {} : { requestedCutOpen }),
    promptHistoryComplete: historyComplete,
    ...(reportAt ? { reportProse } : {}),
    lastRecordAt: newest ? recordTs(newest, fallbackTs) || null : null,
    turnStartedAt,
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
