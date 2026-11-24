import type { BoardTask } from "./types";

/** Old undo receipts could mark the scanner's placeholder as a manual title. */
export function hasLegacySessionPlaceholder(task: Pick<BoardTask, "text" | "origin">): boolean {
  return task.origin?.kind === "conversation" && !task.origin.refinedBy
    && /^(Claude|Codex) session$/i.test(task.text.split(/\r?\n/, 1)[0]?.trim() ?? "");
}
