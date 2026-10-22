import { ROLE_MEMORY_BOUND, type RoleMemoryRule } from "./roleTypes";

/* Consolidation applies the budget to curated rules without a model call: a lesson
   that repeats an active rule (case, spacing and a closing full stop aside)
   merges into it; curation order decides what leaves when the scope exceeds
   its bound. Never-curated lessons wait for a curator; only curated rules
   may leave for budget. Every symbol counts: "x > 0" and "x < 0", or "set -x" and
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
  return `- [${rule.id}] ${rule.rule}`;
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
  /** The scope's active rules after the append, in order of leaving. */
  active: RoleMemoryRule[];
  /** Records whose state changed, the incoming one included when it merged into an older rule. */
  changed: RoleMemoryRule[];
  added: string[];
  merged: { from: string; into: string }[];
  archived: string[];
}

export function leavingOrder(rules: readonly RoleMemoryRule[]): RoleMemoryRule[] {
  return [
    ...rules.filter(rule => !rule.curatedAt && !rule.keptByOperatorAt),
    ...rules.filter(rule => rule.curatedAt && !rule.keptByOperatorAt),
    ...rules.filter(rule => rule.keptByOperatorAt),
  ];
}

/** The same bound applies to append, rewrite, succession and operator Return. */
export function retainRules(rules: readonly RoleMemoryRule[], at: string, protectedIds: ReadonlySet<string> = new Set(), bound = ROLE_MEMORY_BOUND): Pick<AppendOutcome, "active" | "changed" | "archived"> {
  const active = leavingOrder(rules);
  const changed: RoleMemoryRule[] = [];
  const archived: string[] = [];
  while (active.length > 1 && scopeChars(active) > bound) {
    let index = active.findIndex(rule => !!rule.curatedAt && !protectedIds.has(rule.id) && !rule.keptByOperatorAt);
    if (index < 0) index = active.findIndex(rule => !!rule.curatedAt && !protectedIds.has(rule.id));
    if (index < 0) break;
    const [left] = active.splice(index, 1);
    changed.push({ ...left!, state: "archived", reason: "budget", changedAt: at });
    archived.push(left!.id);
  }
  return { active, changed, archived };
}

export function appendRule(active: readonly RoleMemoryRule[], incoming: RoleMemoryRule, at: string, bound = ROLE_MEMORY_BOUND): AppendOutcome {
  const next = leavingOrder(active);
  const changed: RoleMemoryRule[] = [];
  const added: string[] = [];
  const merged: { from: string; into: string }[] = [];
  const duplicate = next.find((rule) => sameRule(rule.rule, incoming.rule));
  if (duplicate) {
    changed.push({ ...incoming, state: "merged", reason: "duplicate", mergedInto: duplicate.id, mergedAt: at, changedAt: at });
    merged.push({ from: incoming.id, into: duplicate.id });
    if (incoming.operatorCorrection || (!duplicate.curatedAt && !duplicate.keptByOperatorAt)) {
      next.splice(next.indexOf(duplicate), 1);
      const refreshed = { ...duplicate, changedAt: at, ...(incoming.operatorCorrection ? { operatorCorrection: true as const } : {}) };
      next.push(refreshed);
      changed.push(refreshed);
    }
  } else {
    next.push(incoming);
    changed.push(incoming);
    added.push(incoming.id);
  }
  const retained = retainRules(next, at, new Set([duplicate?.id ?? incoming.id]), bound);
  return { active: retained.active, changed: [...changed, ...retained.changed], added, merged, archived: retained.archived };
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
  const source = lessonPatternSource(text);
  return source === null ? null : new RegExp(source, "giu");
}

/** Build without compiling, so callers can bound batches and reject oversized sources. */
export function lessonPatternSource(text: string): string | null {
  const normalized = text.normalize("NFKC");
  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (codePoints(words.join("")) >= LESSON_MATCH_MIN_CHARS) {
    return `(?<![\\p{L}\\p{N}])${words.map(escapeRegExp).join("[^\\p{L}\\p{N}]+")}(?![\\p{L}\\p{N}])`;
  }
  const exact = normalized.trim().replace(/[.!。]+$/u, "").trim();
  if (codePoints(exact) < 4) return null;
  return `(?<![\\p{L}\\p{N}])${exact.split(/\s+/).map(escapeRegExp).join("\\s+")}(?![\\p{L}\\p{N}])`;
}
