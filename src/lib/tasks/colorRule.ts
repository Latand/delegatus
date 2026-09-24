import { TASK_COLORS, type TaskColor } from "./types";

/**
 * The one rule that picks a new task's colour and a fitting icon. It is
 * rendered into the create_task and update_task descriptions and into the
 * orchestrator mandate, so an agent applies it without guessing and the three
 * never drift apart. First match wins: a regression in the deploy script is
 * coral, and lime takes any new capability the lines above it did not claim.
 */
export const TASK_COLOR_RULE: readonly { color: TaskColor; covers: string; icons: readonly string[] }[] = [
  { color: "coral", covers: "a bug, a regression, something broken on prod, an incident", icons: ["bug", "siren", "flame"] },
  { color: "amber", covers: "a release, a deploy, CI, infrastructure, accounts and limits", icons: ["rocket", "server", "key-round"] },
  { color: "violet", covers: "research, an investigation, a design doc, an audit", icons: ["search", "microscope", "file-search"] },
  { color: "sky", covers: "UI/UX, visuals, the phone layout", icons: ["smartphone", "palette", "layout-dashboard"] },
  { color: "teal", covers: "performance, memory, reliability, a state or data migration", icons: ["gauge", "database", "activity"] },
  { color: "pink", covers: "docs, the README, public text", icons: ["book-open", "file-text", "megaphone"] },
  { color: "lime", covers: "any other new capability", icons: ["sparkles", "plus", "puzzle"] },
  { color: "slate", covers: "maintenance, cleanup, tests, a refactor, tooling", icons: ["wrench", "test-tube", "hammer"] },
];

/** The rule as one sentence, the form every description and the mandate carry. */
export function renderTaskColorRule(): string {
  const lines = TASK_COLOR_RULE.map(({ color, covers, icons }) => `${color} = ${covers} (icons such as ${icons.join(", ")})`);
  return `Colour and icon rule, first match wins: ${lines.join("; ")}.`;
}

export type TaskColorInput =
  | { kind: "set"; color: TaskColor }
  | { kind: "clear" }
  /** Named no task colour: stored as no colour, with this note in the answer. */
  | { kind: "clamped"; note: string };

/** What a create's `color` field asks for. Absent, `null`, an empty string and
    `none` mean no colour; a value that is no task colour is clamped to none
    with a note, like an unknown icon, and never refused. */
export function readTaskColorInput(value: unknown): TaskColorInput {
  if (value === null || value === undefined) return { kind: "clear" };
  const key = typeof value === "string" ? value.trim().toLowerCase() : null;
  if (key === "" || key === "none") return { kind: "clear" };
  if (key && (TASK_COLORS as readonly string[]).includes(key)) return { kind: "set", color: key as TaskColor };
  const shown = typeof value === "string" ? `"${value.length > 40 ? `${value.slice(0, 40)}…` : value}"` : typeof value;
  return { kind: "clamped", note: `color ${shown} is not one of ${TASK_COLORS.join(", ")}, so the task has no colour` };
}
