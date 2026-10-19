import { ORCHESTRATOR_PROMPT_VERSION, ORCHESTRATOR_SYSTEM_PROMPT } from "@/lib/orchestrator/prompt";

/**
 * The incumbent's stored mandate for the rotation dialog's evidence (the
 * kanban driver's «rotation dialog: the mandate as a diff» block, over the
 * fixture's `scenario=seat-head&mandate=changed|unchanged`).
 *
 * Both texts derive from the CURRENT built-in default by rules that do not
 * depend on its wording, so a rewritten mandate keeps the same four kinds of
 * change: a dropped list line, an added paragraph, one swapped word, and an
 * appended predecessor handoff section (a stored mandate carries its own).
 * No live seat's text is copied here: it carries conversation ids.
 */
export type FixtureMandateKind = "changed" | "unchanged";

const HEADING = /^#{1,6} /;

export function fixtureIncumbentMandate(kind: FixtureMandateKind): { mandate: string; promptVersion: number } {
  if (kind === "unchanged") return { mandate: ORCHESTRATOR_SYSTEM_PROMPT, promptVersion: ORCHESTRATOR_PROMPT_VERSION };
  const lines = ORCHESTRATOR_SYSTEM_PROMPT.split("\n");
  const headings = lines.flatMap((line, index) => (HEADING.test(line) ? [index] : []));
  const first = headings[0] ?? -1;
  const last = headings.at(-1) ?? lines.length;
  /* Swap one word in the first 150-450 character line under the first heading
     (an intraline pair inside the highlighter's bounds). */
  const swapAt = lines.findIndex((line, index) => index > first && line.length >= 150 && line.length <= 450);
  if (swapAt >= 0) lines[swapAt] = lines[swapAt].replace(/\b[A-Za-z]{6,}\b/, "adjusted");
  /* Drop the last list line above the final heading. */
  for (let index = last - 1; index > first; index -= 1) {
    if (lines[index].startsWith("- ")) {
      lines.splice(index, 1);
      break;
    }
  }
  /* One extra paragraph right under the first heading. */
  lines.splice(first + 1, 0, "Say what you are about to do before you do it, and keep the answer to two short paragraphs.");
  lines.push(
    "",
    "## Handoff from your predecessor (rotation)",
    "The previous orchestrator left the board in order. Its conversation is conversation_previous_0.",
    "Open work: two tasks wait for review.",
  );
  return { mandate: lines.join("\n"), promptVersion: ORCHESTRATOR_PROMPT_VERSION - 1 };
}
