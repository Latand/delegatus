import { ROLE_MEMORY_BOUND, type RoleMemoryRule, type RuleLeftReason } from "./roleTypes";

/* Exact duplicates combine without a model. Distinct lessons wait for the
   curator to integrate their conditions. Emergency budget archives are reversible
   and use evidence, never curation status, to choose what leaves. */

export function codePoints(text: string): number {
  return [...text].length;
}

/** The rule archived for `reason` at `at`, with the departure appended to its log. */
export function archivedRule(rule: RoleMemoryRule, at: string, reason: RuleLeftReason, curated = !!rule.curatedAt): RoleMemoryRule {
  return { ...rule, state: "archived", reason, changedAt: at, departures: [...rule.departures ?? [], { at, reason, curated }] };
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
  /** The scope's active rules after the append, in stored order. */
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

export interface RetentionPolicy {
  canCurate: boolean;
  evidence: (rules: readonly RoleMemoryRule[]) => ReadonlyMap<string, { tasks: number; applied: number; lastAppliedAt?: string }>;
}

/** Only unavailable curation permits emergency eviction beyond 125% of target. */
export function retainRules(rules: readonly RoleMemoryRule[], at: string, protectedIds: ReadonlySet<string> = new Set(), bound = ROLE_MEMORY_BOUND, policy?: RetentionPolicy): Pick<AppendOutcome, "active" | "changed" | "archived"> {
  const active = leavingOrder(rules);
  const changed: RoleMemoryRule[] = [];
  const archived: string[] = [];
  const ceiling = bound * 1.25;
  if (scopeChars(active) <= ceiling || policy?.canCurate) return { active, changed, archived };
  const evidence = policy?.evidence(active);
  const newest = active.reduce((latest, rule) => rule.createdAt > latest.createdAt
    || rule.createdAt === latest.createdAt && rule.id > latest.id ? rule : latest, active[0]);
  const candidates = active.filter(rule => rule.id !== newest?.id && !protectedIds.has(rule.id) && !rule.keptByOperatorAt).sort((a, b) => {
    const left = evidence?.get(a.id), right = evidence?.get(b.id);
    return (left?.tasks ?? 0) - (right?.tasks ?? 0)
      || (left?.applied ?? 0) - (right?.applied ?? 0)
      || (left?.lastAppliedAt ?? a.createdAt).localeCompare(right?.lastAppliedAt ?? b.createdAt) || a.id.localeCompare(b.id);
  });
  while (active.length > 1 && scopeChars(active) > ceiling && candidates.length) {
    const left = candidates.shift()!;
    active.splice(active.findIndex(rule => rule.id === left.id), 1);
    const value = evidence?.get(left.id);
    changed.push({ ...archivedRule(left, at, "budget"), note: `Emergency budget archive: ${value?.tasks ?? 0} backing tasks, ${value?.applied ?? 0} applications; oldest application or creation breaks ties. Curation unavailable.` });
    archived.push(left.id);
  }
  return { active, changed, archived };
}

export function appendRule(active: readonly RoleMemoryRule[], incoming: RoleMemoryRule, at: string, bound = ROLE_MEMORY_BOUND, policy?: RetentionPolicy): AppendOutcome {
  const next = leavingOrder(active);
  const changed: RoleMemoryRule[] = [];
  const added: string[] = [];
  const merged: { from: string; into: string }[] = [];
  const duplicate = next.find((rule) => sameRule(rule.rule, incoming.rule));
  if (duplicate) {
    changed.push({ ...incoming, state: "merged", reason: "duplicate", mergedInto: duplicate.id, mergedAt: at, changedAt: at });
    merged.push({ from: incoming.id, into: duplicate.id });
    if (!duplicate.curatedAt && !duplicate.keptByOperatorAt) {
      next.splice(next.indexOf(duplicate), 1);
      const refreshed = { ...duplicate, changedAt: at };
      next.push(refreshed);
      changed.push(refreshed);
    }
  } else {
    next.push(incoming);
    changed.push(incoming);
    added.push(incoming.id);
  }
  const retained = retainRules(next, at, new Set([duplicate?.id ?? incoming.id]), bound, policy);
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
