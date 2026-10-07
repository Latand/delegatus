import { ROLE_MEMORY_BOUND, type RoleMemoryRule } from "./roleTypes";

/* Consolidation keeps a scope under its bound without a model call: a lesson
   that repeats an active rule word for word (case, spacing and punctuation
   aside) merges into it, and while the scope is over the bound its oldest
   rule is archived. Similar wording is never merged: two rules that share
   most of their words can still ask for different things, or opposite ones,
   and only a model could combine them without losing one. Every rule that
   leaves the injected text keeps its record, its state and the reason, so the
   window's history shows it; nothing is deleted (operator, 2026-10-02:
   «Может быть, они потом понадобятся»). */

export function codePoints(text: string): number {
  return [...text].length;
}

export function ruleLine(rule: Pick<RoleMemoryRule, "id" | "rule" | "why">): string {
  return `- [${rule.id}] ${rule.rule} Why: ${rule.why}`;
}

/** The size of a scope as injected: its rule lines, in code points. */
export function scopeChars(rules: readonly Pick<RoleMemoryRule, "id" | "rule" | "why">[]): number {
  return codePoints(rules.map(ruleLine).join("\n"));
}

/** The text two rules are compared by: letters and digits only, lower case. */
function normalized(text: string): string {
  return (text.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
}

/** Two rules are one rule only when they say the same words in the same order. */
export function sameRule(a: string, b: string): boolean {
  return normalized(a) === normalized(b);
}

export interface AppendOutcome {
  /** The scope's active rules after the append, in injection order. */
  active: RoleMemoryRule[];
  /** Records whose state changed, the incoming one included when it merged into an older rule. */
  changed: RoleMemoryRule[];
  added: string[];
  merged: { from: string; into: string }[];
  archived: string[];
}

export function appendRule(active: readonly RoleMemoryRule[], incoming: RoleMemoryRule, at: string, bound = ROLE_MEMORY_BOUND): AppendOutcome {
  const next = [...active];
  const changed: RoleMemoryRule[] = [];
  const added: string[] = [];
  const merged: { from: string; into: string }[] = [];
  const archived: string[] = [];
  const duplicate = next.find((rule) => sameRule(rule.rule, incoming.rule));
  if (duplicate) {
    changed.push({ ...incoming, state: "merged", reason: "duplicate", mergedInto: duplicate.id, changedAt: at });
    merged.push({ from: incoming.id, into: duplicate.id });
  } else {
    next.push(incoming);
    changed.push(incoming);
    added.push(incoming.id);
  }
  while (next.length > 1 && scopeChars(next) > bound) {
    const oldest = next.shift()!;
    changed.push({ ...oldest, state: "archived", reason: "budget", changedAt: at });
    archived.push(oldest.id);
  }
  return { active: next, changed, added, merged, archived };
}

/** Letters and digits a stored text needs before it is looked for in outgoing
    text: a shorter one ("x", "a review round") is too ordinary to withhold. */
export const LESSON_MATCH_MIN_CHARS = 16;

/** Finds a stored lesson's words in other text, whatever the case, spacing,
    punctuation or line wrapping between them; null for a text too short to
    look for. Pure, so the bridge's privacy filter can use it too. */
export function lessonPattern(text: string): RegExp | null {
  const words = text.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
  if (codePoints(words.join("")) < LESSON_MATCH_MIN_CHARS) return null;
  const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped.join("[^\\p{L}\\p{N}]+")}(?![\\p{L}\\p{N}])`, "giu");
}
