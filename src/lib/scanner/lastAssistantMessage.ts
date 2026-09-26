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
): { text: string; ts: number } | null {
  for (const obj of [...source].reverse()) {
    const ts = Date.parse(String(obj.timestamp ?? "")) || fallbackTs;
    if (root === "codex-sessions") {
      const payload = recordValue(obj.payload) ?? {};
      const type = stringValue(payload.type);
      if (type === "task_complete") {
        const text = stringValue(payload.last_agent_message)?.trim();
        if (text) return { text, ts };
      }
      if (type === "agent_message") return { text: stringValue(payload.message) ?? "", ts };
      if (type === "message" && payload.role === "assistant") {
        const text = recordsValue(payload.content)
          .map((part) => stringValue(part.text) ?? stringValue(part.input_text) ?? "")
          .join("\n")
          .trim();
        if (text) return { text, ts };
      }
    }
    if (root === "claude-projects" && obj.type === "assistant") {
      const text = recordsValue(recordValue(obj.message)?.content)
        .filter((part) => part.type === "text")
        .map((part) => stringValue(part.text) ?? "")
        .join("\n")
        .trim();
      if (text) return { text, ts };
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
