import { ROLE_MEMORY_BOUND, type RoleMemoryRule } from "./roleTypes";

/* Consolidation keeps a scope under its bound without a model call: a lesson
   that repeats an active rule (case, spacing and a closing full stop aside)
   merges into it, and while the scope is over the bound its oldest rule is
   archived. Every symbol counts: "x > 0" and "x < 0", or "set -x" and
   "set +x", ask for different things. Similar wording is never merged: two
   rules that share most of their words can still ask for different things, or
   opposite ones, and only a model could combine them without losing one.
   Every rule that leaves the injected text keeps its record, its state and
   the reason, so the window's history shows it; nothing is deleted (operator,
   2026-10-02: «Может быть, они потом понадобятся»). */

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

/** The text two rules are compared by: lower case, each word and each symbol
    one token whatever the spacing around it, a closing full stop dropped. */
function canonical(text: string): string {
  const tokens = text.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) ?? [];
  while (tokens.length && /^[.!。]$/u.test(tokens.at(-1)!)) tokens.pop();
  return tokens.join(" ");
}

/** Two rules are one rule only when they say the same words and symbols in the same order. */
export function sameRule(a: string, b: string): boolean {
  return canonical(a) === canonical(b);
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

/** Letters and digits a lesson's rule and why each need. Below this a text is
    too ordinary to tell apart from any other ("x", "Writes raced."), so it
    could not be withheld from outgoing text without withholding everything
    like it; leave_lesson refuses it. */
export const LESSON_MATCH_MIN_CHARS = 16;

export function lettersAndDigits(text: string): number {
  return codePoints((text.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? []).join(""));
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Finds a stored lesson in other text. A text with enough letters and digits
    is found by its words, whatever the case, spacing, punctuation or line
    wrapping between them; a shorter one (a record kept from before the
    minimum) only as written, case and spacing aside. Null for a text under
    four characters, which the publication gate ignores too. Pure, so the
    bridge's privacy filter can use it. */
export function lessonPattern(text: string): RegExp | null {
  const normalized = text.normalize("NFKC");
  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (codePoints(words.join("")) >= LESSON_MATCH_MIN_CHARS) {
    return new RegExp(`(?<![\\p{L}\\p{N}])${words.map(escapeRegExp).join("[^\\p{L}\\p{N}]+")}(?![\\p{L}\\p{N}])`, "giu");
  }
  const exact = normalized.trim().replace(/[.!。]+$/u, "").trim();
  if (codePoints(exact) < 4) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])${exact.split(/\s+/).map(escapeRegExp).join("\\s+")}(?![\\p{L}\\p{N}])`, "giu");
}
