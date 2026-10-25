import { expect, test } from "bun:test";
import { appendRule, retainRules, scopeChars } from "./roleConsolidate";
import type { RoleMemoryRule } from "./roleTypes";

const at = "2026-10-24T00:00:00.000Z";
function rule(id: string, extra: Partial<RoleMemoryRule> = {}): RoleMemoryRule {
  return { kind: "rule", id, scope: "project:fixture", rule: id.repeat(30), why: "Preserve useful evidence.", state: "active", hints: [], source: { origin: "operator", project: "fixture", roleId: null, fixRound: false, conversationId: "fixture" }, createdAt: at, changedAt: at, ...extra };
}
test("append above the target preserves curated rules within the hard ceiling", () => {
  const old = rule("a", { curatedAt: at });
  const incoming = rule("b");
  const bound = scopeChars([old, incoming]) - 1;
  expect(appendRule([old], incoming, at, bound).active.map(r => r.id).sort()).toEqual(["a", "b"]);
});
test("fallback never archives operator-kept or newly appended rules", () => {
  const kept = rule("a", { keptByOperatorAt: at, curatedAt: at });
  const old = rule("b", { curatedAt: at });
  const incoming = rule("c");
  const result = appendRule([kept, old], incoming, at, 60);
  expect(result.archived).toEqual([old.id]);
  expect(result.active.map(r => r.id)).toContain(kept.id);
  expect(result.active.map(r => r.id)).toContain(incoming.id);
});

test("emergency selection uses task support then applications then age, not curated status", () => {
  const rules = [rule("a", { curatedAt: at }), rule("b"), rule("c"), rule("d", { createdAt: "2026-10-25T00:00:00.000Z" })];
  const evidence = new Map([["a", { tasks: 3, applied: 0 }], ["b", { tasks: 1, applied: 1 }], ["c", { tasks: 1, applied: 0 }], ["d", { tasks: 1, applied: 0 }]]);
  const result = retainRules(rules, at, new Set(), scopeChars(rules.slice(0, 3)) / 1.25, { canCurate: false, evidence: () => evidence });
  expect(result.archived).toEqual(["c"]);
});
test("an available curator keeps every rule even above the emergency ceiling", () => {
  const rules = [rule("a"), rule("b")];
  expect(retainRules(rules, at, new Set(), 20, { canCurate: true, evidence: () => new Map() }).archived).toEqual([]);
});

test("the exact hard ceiling retains everything and emergency selection protects the newest existing rule", () => {
  const rules = [rule("a"), rule("b"), rule("c", { createdAt: "2026-10-25T00:00:00.000Z" })];
  const evidence = new Map([["a", { tasks: 2, applied: 0 }], ["b", { tasks: 1, applied: 0 }], ["c", { tasks: 0, applied: 0 }]]);
  const policy = { canCurate: false, evidence: () => evidence };
  expect(retainRules(rules, at, new Set(), scopeChars(rules) / 1.25, policy).archived).toEqual([]);
  expect(retainRules(rules, at, new Set(), scopeChars(rules.slice(0, 2)) / 1.25, policy).archived).toEqual(["b"]);
});
