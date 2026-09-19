import fs from "node:fs";

import { lastAssistantMessageFromRecords } from "@/lib/flows/findings";
import { tailRecords } from "@/lib/scanner/activity";

import { redactBounded } from "./redact";
import type { SeatTickItem } from "./types";

/** How much of a child's final message a wake carries. */
export const CHILD_FINAL_MESSAGE_LIMIT = 600;

/**
 * A settled child's final message, for the wake that names it (#1881).
 *
 * Read here, by the controller, for the few child lines of a wake that is
 * already going out — never by the pre-check, which decides from durable state
 * alone. One bounded tail read per line, the same read a review round's
 * verdict comes from; a transcript that cannot be read, or holds no assistant
 * text in its tail, leaves the line as it was.
 */
export function childFinalMessage(transcriptPath: string, engine: string | null): string | null {
  try {
    const stat = fs.statSync(transcriptPath);
    if (!stat.isFile()) return null;
    const records = tailRecords(transcriptPath, stat.size, stat.mtimeMs);
    const root = engine === "codex" ? "codex-sessions" : "claude-projects";
    const message = lastAssistantMessageFromRecords(records, root, stat.mtimeMs);
    const text = message?.text.replace(/\s+/g, " ").trim();
    return text ? redactBounded(text, CHILD_FINAL_MESSAGE_LIMIT) : null;
  } catch {
    return null;
  }
}

/** The wake's items with each settled child's final message attached. */
export function withChildFinalMessages(items: readonly SeatTickItem[], read: typeof childFinalMessage = childFinalMessage): SeatTickItem[] {
  return items.map((item) => {
    if (!item.finalMessageFrom) return item;
    const finalMessage = read(item.finalMessageFrom.path, item.finalMessageFrom.engine);
    return finalMessage ? { ...item, finalMessage } : item;
  });
}
