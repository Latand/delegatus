import type { FileEntry, TurnBoundary } from "../types";
import { classifyTurnRecord, turnRecordTimestamp } from "@/lib/turnRecords";
import { tailRecordsResult } from "./activity";
import { globalCache } from "./caches";
import { recordValue, recordsValue, stringValue } from "./json";

type RecordLike = Record<string, unknown>;

// v5: meta/command user records no longer open windows (issue #406) — persisted
// v4 boundaries could start before the real initiating prompt.
const turnBoundaryCache = globalCache<[number, number, TurnBoundary | null]>("last-turn-v5");
const recentTurnWindowsCache = globalCache<[number, number, RecentTurnWindows]>("recent-turn-windows-v4");

export interface RecentTurnWindows {
  windows: TurnBoundary[];
  assistantMessagesAtMs?: number[];
  lastAgentWorkAt?: number | null;
  prefixTruncated: boolean;
  complete: boolean;
}

/** A real assistant message the conversation renders as prose. Tool-only
    records are activity without an acknowledgment, and Claude's synthetic
    no-op is deliberately invisible in the feed. */
function visibleAssistantMessage(record: RecordLike, codex: boolean): boolean {
  if (codex) {
    const payload = recordValue(record.payload) ?? {};
    const type = stringValue(payload.type);
    if (type === "agent_message") return (stringValue(payload.message) ?? "").trim().length > 0;
    if (type !== "message" || payload.role !== "assistant") return false;
    return recordsValue(payload.content).some(
      (part) => (stringValue(part.text) ?? stringValue(part.output_text) ?? "").trim().length > 0,
    );
  }
  if (record.type !== "assistant" || record.isApiErrorMessage === true) return false;
  const message = recordValue(record.message) ?? {};
  if (stringValue(message.model) === "<synthetic>") return false;
  if (typeof message.content === "string") return message.content.trim().length > 0;
  return recordsValue(message.content).some(
    (part) => part.type === "text" && (stringValue(part.text) ?? "").trim().length > 0,
  );
}

/** Turn boundaries for the most-recent turn from a chronological record slice.
    The turn opens at the prompt that INITIATED the work — the first prompt
    after the previous turn closed, whoever sent it (operator or a relaying
    agent). Prompts landing while the run is still open (steering, relayed
    follow-ups) must NOT reset the boundary: the reported span is «initiating
    prompt → last activity», never a single action's own duration (issue #268).
    The turn closes at the terminal assistant/tool output — or, when the run
    was interrupted or crashed and no terminal record exists, at the
    authoritative failure evidence. While the agent is still working `endedAt`
    stays null so the UI can tick live elapsed. Returns null when no opening
    prompt survives in the tail window. Pure for testability. */
export function recentTurnWindowsFromRecords(records: RecordLike[], codex: boolean): TurnBoundary[] {
  const tracker = new TurnWindowTracker(codex);
  for (const record of records) tracker.push(record);
  return tracker.finish();
}

/** The same window rules, fed one record at a time, so a whole transcript can
    be walked without holding its records. `latestTimestamp` is the newest
    parseable record time seen, whatever the record was. */
export class TurnWindowTracker {
  private readonly windows: TurnBoundary[] = [];
  private startedAt: number | null = null;
  private open = false;
  private failedWindow: TurnBoundary | null = null;
  latestTimestamp: number | null = null;

  constructor(private readonly codex: boolean) {}

  push(record: RecordLike): void {
    const facts = classifyTurnRecord(record, this.codex);
    this.latestTimestamp = facts.timestampMs ?? this.latestTimestamp;
    // Failure evidence outranks the prompt shape: the interrupt sentinel is a
    // user record with real text and would otherwise register as a prompt.
    if (facts.fails) {
      if (this.open && this.startedAt !== null) {
        const endedAt = Math.max(facts.timestampMs ?? this.latestTimestamp ?? this.startedAt, this.startedAt);
        this.failedWindow = { startedAt: this.startedAt, endedAt };
        this.windows.push(this.failedWindow);
      }
      this.open = false;
      return;
    }
    if (facts.starts) {
      // A later steering prompt only fills in for an initiating prompt whose
      // own timestamp failed to parse — it never moves a valid boundary.
      if (!this.open || this.startedAt === null) {
        this.startedAt = facts.timestampMs;
        this.failedWindow = null;
      }
      this.open = true;
      return;
    }
    if (facts.closes) {
      if (this.open && this.startedAt !== null) {
        const endedAt = Math.max(facts.timestampMs ?? this.latestTimestamp ?? this.startedAt, this.startedAt);
        this.windows.push({ startedAt: this.startedAt, endedAt });
      }
      this.open = false;
      this.failedWindow = null;
      return;
    }
    // Assistant output after failure evidence proves the run survived it (a
    // retried API error): reopen so later prompts keep steering, not resetting.
    if (this.failedWindow && facts.assistantRecord) {
      if (this.windows.at(-1) === this.failedWindow) this.windows.pop();
      this.failedWindow = null;
      this.open = true;
    }
  }

  /** An independent tracker holding the same state, so a read can resume from it or look ahead without disturbing it.
      Windows are never mutated once pushed, so the copy shares them and only owns its own list. */
  clone(): TurnWindowTracker {
    const copy = new TurnWindowTracker(this.codex);
    for (const window of this.windows) copy.windows.push(window);
    copy.startedAt = this.startedAt;
    copy.open = this.open;
    copy.failedWindow = this.failedWindow;
    copy.latestTimestamp = this.latestTimestamp;
    return copy;
  }

  finish(): TurnBoundary[] {
    const windows = this.windows.slice();
    if (this.open && this.startedAt !== null) windows.push({ startedAt: this.startedAt, endedAt: null });
    return windows;
  }
}

/** Turn windows and visible assistant acknowledgements derived from one record slice. */
export function recentTurnActivityFromRecords(
  records: RecordLike[],
  codex: boolean,
): Pick<RecentTurnWindows, "windows" | "assistantMessagesAtMs" | "lastAgentWorkAt"> {
  const assistantMessages = new Set<number>();
  let lastAgentWorkAt: number | null = null;
  for (const record of records) {
    const atMs = turnRecordTimestamp(record.timestamp);
    if (atMs === null) continue;
    if (visibleAssistantMessage(record, codex)) assistantMessages.add(atMs);
    if (isAgentWorkRecord(record, codex)) lastAgentWorkAt = Math.max(lastAgentWorkAt ?? 0, atMs);
  }
  return {
    lastAgentWorkAt,
    windows: recentTurnWindowsFromRecords(records, codex),
    assistantMessagesAtMs: [...assistantMessages].sort((left, right) => left - right),
  };
}

export function lastTurnFromRecords(records: RecordLike[], codex: boolean): TurnBoundary | null {
  return recentTurnWindowsFromRecords(records, codex).at(-1) ?? null;
}

/** Every visible turn window for a conversation transcript tail. */
export function recentTurnWindowsFor(entry: FileEntry): RecentTurnWindows {
  const conversationRoot = entry.root === "claude-projects" || entry.root === "codex-sessions";
  if (!conversationRoot || !entry.path.endsWith(".jsonl")) {
    return { windows: [], prefixTruncated: false, complete: true };
  }
  const mtimeMs = entry.mtime * 1000;
  const cached = recentTurnWindowsCache.get(entry.path);
  if (cached?.[0] === entry.size && cached[1] === mtimeMs) return structuredClone(cached[2]);
  const tail = tailRecordsResult(entry.path, entry.size, mtimeMs);
  const activity = recentTurnActivityFromRecords(tail.records, entry.root === "codex-sessions");
  const result: RecentTurnWindows = {
    ...activity,
    prefixTruncated: tail.prefixTruncated,
    complete: tail.complete,
  };
  if (tail.complete) recentTurnWindowsCache.set(entry.path, [entry.size, mtimeMs, result]);
  return structuredClone(result);
}

/** Last-turn boundaries for a transcript entry, cached by file identity like the sibling
    tail derivations (context, effort). Only conversation transcripts carry the
    per-message timestamps this needs. */
export function lastTurnFor(entry: FileEntry): TurnBoundary | null {
  const conversationRoot = entry.root === "claude-projects" || entry.root === "codex-sessions";
  if (!conversationRoot || !entry.path.endsWith(".jsonl")) return null;
  const mtimeMs = entry.mtime * 1000;
  const cached = turnBoundaryCache.get(entry.path);
  if (cached?.[0] === entry.size && cached[1] === mtimeMs) return cached[2];
  const recent = recentTurnWindowsFor(entry);
  const boundary = recent.windows.at(-1) ?? null;
  if (recent.complete) turnBoundaryCache.set(entry.path, [entry.size, mtimeMs, boundary]);
  return boundary;
}

/** Newest visible assistant acknowledgment carried by the same bounded,
    identity-keyed read as {@link lastTurnFor}. */
export function lastAssistantMessageAtFor(entry: FileEntry): number | null | undefined {
  const conversationRoot = entry.root === "claude-projects" || entry.root === "codex-sessions";
  if (!conversationRoot || !entry.path.endsWith(".jsonl")) return null;
  const recent = recentTurnWindowsFor(entry);
  const last = recent.assistantMessagesAtMs?.at(-1);
  if (typeof last === "number") return last;
  return recent.prefixTruncated ? undefined : null;
}

/** Work evidence shares the existing bounded tail parse and revision cache. */
export function isAgentWorkRecord(record: RecordLike, codex: boolean): boolean {
  if (codex) {
    const payload = recordValue(record.payload) ?? {};
    const kind = stringValue(payload.type);
    if (record.type === "response_item") return (kind === "message" && payload.role === "assistant")
      || ["reasoning", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "web_search_call", "local_shell_call"].includes(kind ?? "");
    return record.type === "event_msg" && ["agent_message", "agent_reasoning", "exec_command_begin", "exec_command_end", "mcp_tool_call_begin", "mcp_tool_call_end"].includes(kind ?? "");
  }
  if (record.isApiErrorMessage === true) return false;
  const message = recordValue(record.message) ?? {};
  if (message.model === "<synthetic>") return false;
  if (record.type === "assistant") return typeof message.content === "string" ? Boolean(message.content.trim())
    : recordsValue(message.content).some(part => ["text", "thinking", "tool_use"].includes(String(part.type)));
  return record.type === "user" && recordsValue(message.content).some(part => part.type === "tool_result");
}

export function lastAgentWorkAtFor(entry: FileEntry): number | null | undefined {
  const recent = recentTurnWindowsFor(entry);
  return recent.lastAgentWorkAt ?? (recent.prefixTruncated ? undefined : null);
}
