/**
 * One-line edits to a stored multi-line text, so a caller changes a line by
 * sending that line and never resends the whole value. First written for the
 * seat's monitor note (#2030), where rewriting a 2.3 KB note to change one line
 * cost one seat 337 KB of input; a task's agent-facing `details` uses the same
 * edits (#1845), where a one-line change used to resend an 8.5 KB card.
 */

/** Where a line edit lands: the one line starting with `prefix` (leading
    whitespace ignored on both sides), or the line at the zero-based `index`.
    Given both, the line at `index` must start with `prefix`, so an index read
    off an older copy of the text cannot edit the wrong line. */
export interface LineTarget {
  prefix?: string;
  index?: number;
}

/** Applied in this order, each against the text as the previous one left it. */
export interface LineEdits {
  replaceLine?: LineTarget & { text: string };
  removeLine?: LineTarget;
  appendLine?: string;
}

export const LINE_EDIT_KEYS = ["replaceLine", "removeLine", "appendLine"] as const;

export type LineEditResult = { ok: true; value: string | null } | { ok: false; error: string; field: (typeof LINE_EDIT_KEYS)[number] };

function locateLine(
  lines: readonly string[],
  target: LineTarget,
  edit: "replaceLine" | "removeLine",
  noun: string,
): { ok: true; index: number } | { ok: false; error: string; field: typeof edit } {
  const prefix = typeof target.prefix === "string" ? target.prefix.trimStart() : "";
  if (target.index !== undefined) {
    if (!Number.isInteger(target.index) || target.index < 0 || target.index >= lines.length) {
      return { ok: false, field: edit, error: `${edit}.index ${target.index} is outside ${noun}, which has ${lines.length} line(s) numbered from 0. Nothing was stored` };
    }
    if (prefix && !lines[target.index]!.trimStart().startsWith(prefix)) {
      return { ok: false, field: edit, error: `${edit}: line ${target.index} of ${noun} does not start with the prefix given beside it. Nothing was stored` };
    }
    return { ok: true, index: target.index };
  }
  if (!prefix) return { ok: false, field: edit, error: `${edit} needs a non-empty prefix or an index` };
  const matches = lines.flatMap((line, index) => (line.trimStart().startsWith(prefix) ? [index] : []));
  if (matches.length !== 1) {
    return { ok: false, field: edit, error: `${edit}.prefix matches ${matches.length} lines of ${noun}; it must match exactly one. Nothing was stored` };
  }
  return { ok: true, index: matches[0]! };
}

/** The text after its line edits, or why they were refused. Pure: the stored
    value is handed in and the caller writes the result like a whole new value,
    under that field's own limit. An edit that leaves nothing answers null.
    `noun` names the text in a refusal ("the note", "the details"). */
export function applyLineEdits(value: string | null | undefined, edits: LineEdits, noun: string): LineEditResult {
  const lines = value ? value.split("\n") : [];
  if (edits.replaceLine !== undefined) {
    if (!edits.replaceLine || typeof edits.replaceLine !== "object") return { ok: false, field: "replaceLine", error: "replaceLine must be an object with text and a prefix or an index" };
    const { text, ...target } = edits.replaceLine;
    if (typeof text !== "string") return { ok: false, field: "replaceLine", error: "replaceLine.text must be a string" };
    if (text.includes("\n")) return { ok: false, field: "replaceLine", error: "replaceLine.text must be one line" };
    const found = locateLine(lines, target, "replaceLine", noun);
    if (!found.ok) return found;
    lines[found.index] = text;
  }
  if (edits.removeLine !== undefined) {
    if (!edits.removeLine || typeof edits.removeLine !== "object") return { ok: false, field: "removeLine", error: "removeLine must be an object with a prefix or an index" };
    const found = locateLine(lines, edits.removeLine, "removeLine", noun);
    if (!found.ok) return found;
    lines.splice(found.index, 1);
  }
  if (edits.appendLine !== undefined) {
    if (typeof edits.appendLine !== "string") return { ok: false, field: "appendLine", error: "appendLine must be a string" };
    if (edits.appendLine.includes("\n")) return { ok: false, field: "appendLine", error: "appendLine must be one line" };
    lines.push(edits.appendLine);
  }
  const next = lines.join("\n");
  return { ok: true, value: next.trim() ? next : null };
}
