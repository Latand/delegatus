import { ROLE_MEMORY_BOUND, type RoleMemoryRule } from "./types";

/* Consolidation keeps a scope under its bound without a model call: a lesson
   that restates an active rule merges with it (the fuller text survives), and
   while the scope is over the bound its oldest rule is archived. Every rule
   that leaves the injected text keeps its record, its state and the reason,
   so the window's history shows it; nothing is deleted (operator, 2026-10-02:
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

function words(text: string): Set<string> {
  return new Set(text.normalize("NFKC").toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => codePoints(word) >= 3));
}

/** Two rules state one class: nearly the same words, or one inside the other. */
export function nearDuplicate(a: string, b: string): boolean {
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  const union = left.size + right.size - shared;
  const smaller = Math.min(left.size, right.size);
  return shared / union >= 0.6 || (smaller >= 5 && shared / smaller >= 0.9);
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
  let next = [...active];
  const changed: RoleMemoryRule[] = [];
  const added: string[] = [];
  const merged: { from: string; into: string }[] = [];
  const archived: string[] = [];
  const duplicate = next.find((rule) => nearDuplicate(rule.rule, incoming.rule));
  if (duplicate && codePoints(incoming.rule) < codePoints(duplicate.rule)) {
    changed.push({ ...incoming, state: "merged", reason: "duplicate", mergedInto: duplicate.id, changedAt: at });
    merged.push({ from: incoming.id, into: duplicate.id });
  } else {
    if (duplicate) {
      next = next.filter((rule) => rule.id !== duplicate.id);
      changed.push({ ...duplicate, state: "merged", reason: "duplicate", mergedInto: incoming.id, changedAt: at });
      merged.push({ from: duplicate.id, into: incoming.id });
    }
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
