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


test("emergency eviction skips pending corrections and ranks the remaining evidence", () => {
  const pending = rule("p", { operatorCorrection: true });
  const rewritten = rule("q", { operatorCorrection: true, curatedAt: at, changedAt: "2026-10-25T00:00:00.000Z" });
  const supported = rule("a", { curatedAt: at });
  const applied = rule("b");
  const unused = rule("c", { curatedAt: at });
  const newest = rule("z", { createdAt: "2026-10-25T00:00:00.000Z" });
  const rules = [pending, supported, applied, unused, rewritten, newest];
  const evidence = new Map([
    ["p", { tasks: 0, applied: 0 }], ["q", { tasks: 0, applied: 0 }],
    ["a", { tasks: 2, applied: 0 }], ["b", { tasks: 1, applied: 2 }],
    ["c", { tasks: 1, applied: 0 }], ["z", { tasks: 0, applied: 0 }],
  ]);
  const bound = scopeChars([pending, rewritten, supported, newest]) / 1.25;
  const result = retainRules(rules, "2026-10-26T00:00:00.000Z", new Set(), bound, { canCurate: false, evidence: () => evidence });
  expect(result.archived).toEqual(["c", "b"]);
  expect(result.active.map(r => r.id).sort()).toEqual(["a", "p", "q", "z"]);
  expect(scopeChars(result.active)).toBeLessThanOrEqual(bound * 1.25);
  expect(result.changed.map(r => [r.id, r.state, r.reason])).toEqual([["c", "archived", "budget"], ["b", "archived", "budget"]]);
});

test("reviewed corrections remain eligible for evidence-ranked emergency eviction", () => {
  const reviewed = rule("a", { operatorCorrection: true, curatedAt: at });
  const newest = rule("b", { createdAt: "2026-10-25T00:00:00.000Z" });
  expect(retainRules([reviewed, newest], at, new Set(), 20, { canCurate: false, evidence: () => new Map() }).archived).toEqual(["a"]);
});
