import fs from "node:fs";
import { tailRecords } from "./activity";
import { recordValue, recordsValue, stringValue } from "./json";
import type { FileEntry } from "@/lib/types";
import type { RuntimeEngine } from "@/lib/agent/runtimeConfig";

type TranscriptEntry = Pick<FileEntry, "path" | "root" | "size" | "mtime">;

export function lastAssistantMessage(entry: TranscriptEntry): { text: string; ts: number } | null {
  const records = tailRecords(entry.path, entry.size, entry.mtime * 1000);
  return lastAssistantMessageFromRecords(records, entry.root, entry.mtime * 1000);
}

/** Same extraction over an already-read record tail, for callers that obtain
    their records from a durable (identity-verified) read instead of the
    scanner's permissive cache. */
export function lastAssistantMessageFromRecords(
  source: Record<string, unknown>[],
  root: FileEntry["root"],
  fallbackTs: number,
  options: { preserveWhitespace?: boolean; turnId?: string; turnStartedAt?: string | null; turnEndedAt?: string | null } = {},
): { text: string; ts: number } | null {
  if (root === "codex-sessions" && options.turnId) {
    const turnId = options.turnId;
    const payloadAt = (index: number) => recordValue(source[index]?.payload) ?? {};
    const terminalIndex = source.findIndex((obj) => {
      const payload = recordValue(obj.payload) ?? {};
      return payload.type === "task_complete" && payload.turn_id === turnId;
    });
    if (terminalIndex < 0) return null;

    const direct = stringValue(payloadAt(terminalIndex).last_agent_message);
    const directText = options.preserveWhitespace ? direct : direct?.trim();
    const terminalTs = Date.parse(String(source[terminalIndex]?.timestamp ?? "")) || fallbackTs;
    if (directText?.trim()) return { text: directText, ts: terminalTs };

    for (let index = terminalIndex - 1; index >= 0; index -= 1) {
      const payload = payloadAt(index);
      const type = stringValue(payload.type);
      if (type === "task_complete") break;
      const recordTurn = stringValue(payload.turn_id);
      if (type === "task_started" && recordTurn && recordTurn !== turnId) break;
      if (type !== "agent_message" || recordTurn && recordTurn !== turnId) continue;
      const sourceText = stringValue(payload.message);
      const text = options.preserveWhitespace ? sourceText : sourceText?.trim();
      if (text?.trim()) {
        const ts = Date.parse(String(source[index]?.timestamp ?? "")) || fallbackTs;
        return { text, ts };
      }
    }
    return null;
  }

  const startedAt = options.turnStartedAt ? Date.parse(options.turnStartedAt) : Number.NaN;
  const endedAt = options.turnEndedAt ? Date.parse(options.turnEndedAt) : Number.NaN;
  let claudeStart = startedAt;
  if (root === "claude-projects" && !Number.isFinite(claudeStart) && Number.isFinite(endedAt)) {
    /* Older notice rows may lack a start time. The last user record before
       this turn's end is the best transcript-local boundary available. */
    for (const obj of source) {
      const ts = Date.parse(String(obj.timestamp ?? ""));
      if (ts > endedAt) break;
      if (obj.type === "user" && Number.isFinite(ts)) claudeStart = ts;
    }
  }
  for (const obj of [...source].reverse()) {
    const ts = Date.parse(String(obj.timestamp ?? "")) || fallbackTs;
    if (root === "codex-sessions") {
      // Generic readers also use messages from a turn still in progress.
      const payload = recordValue(obj.payload) ?? {};
      const type = payload.type;
      if (type === "agent_message") return { text: stringValue(payload.message) ?? "", ts };
      let sourceText: string | null = null;
      if (type === "task_complete") sourceText = stringValue(payload.last_agent_message);
      if (type === "message" && payload.role === "assistant") {
        sourceText = recordsValue(payload.content).map((part) => stringValue(part.text) ?? stringValue(part.input_text) ?? "").join("\n");
      }
      const text = options.preserveWhitespace ? sourceText : sourceText?.trim();
      if (text?.trim()) return { text, ts };
    } else if (root === "claude-projects" && obj.type === "assistant") {
      if (Number.isFinite(endedAt) && (ts > endedAt || (Number.isFinite(claudeStart) && ts < claudeStart))) continue;
      const source = recordsValue(recordValue(obj.message)?.content)
        .filter((part) => part.type === "text")
        .map((part) => stringValue(part.text) ?? "")
        .join("\n");
      const text = options.preserveWhitespace ? source : source.trim();
      if (text.trim()) return { text, ts };
    }
  }
  return null;
}

export function transcriptEntryFromPath(transcriptPath: string, engine: RuntimeEngine | null): TranscriptEntry | null {
  try {
    const stat = fs.statSync(transcriptPath);
    return {
      path: transcriptPath,
      root: engine === "claude" || (!engine && transcriptPath.includes("/.claude/projects/"))
        ? "claude-projects"
        : "codex-sessions",
      size: stat.size,
      mtime: stat.mtimeMs / 1_000,
    };
  } catch {
    return null;
  }
}

/** The last text an agent wrote, with an identity that names that message:
    Claude's record uuid, Codex's turn id (a turn has one final message). The
    "Asks you" classifier sends each message once by this id. A Codex turn
    that ended on an engine error carries `error`, and its text is the error. */
export interface FinalAssistantMessage {
  id: string;
  text: string;
  ts: number;
  engineError: boolean;
}

export function finalAssistantMessageFromRecords(
  source: Record<string, unknown>[],
  root: FileEntry["root"],
  fallbackTs: number,
): FinalAssistantMessage | null {
  for (const obj of [...source].reverse()) {
    const ts = Date.parse(String(obj.timestamp ?? "")) || fallbackTs;
    if (root === "codex-sessions") {
      const payload = recordValue(obj.payload) ?? {};
      if (stringValue(payload.type) !== "task_complete") continue;
      const text = stringValue(payload.last_agent_message)?.trim();
      const turnId = stringValue(payload.turn_id);
      if (!text || !turnId) return null;
      return { id: `codex-turn:${turnId}`, text, ts, engineError: payload.error !== undefined && payload.error !== null };
    }
    if (root === "claude-projects" && obj.type === "assistant") {
      const text = recordsValue(recordValue(obj.message)?.content)
        .filter((part) => part.type === "text")
        .map((part) => stringValue(part.text) ?? "")
        .join("\n")
        .trim();
      const id = stringValue(obj.uuid) ?? stringValue(recordValue(obj.message)?.id);
      if (text && id) return { id: `claude:${id}`, text, ts, engineError: obj.isApiErrorMessage === true };
    }
  }
  return null;
}

export function finalAssistantMessage(entry: TranscriptEntry): FinalAssistantMessage | null {
  const records = tailRecords(entry.path, entry.size, entry.mtime * 1000);
  return finalAssistantMessageFromRecords(records, entry.root, entry.mtime * 1000);
}
