import type { RoleMemoryRule } from "./roleTypes";
import type { SelectionScopes } from "./roleSelect";
import type { RoleSelectionProvider } from "./roleSelectionProvider";

export const CORPUS_AT = "2026-10-22T00:00:00.000Z";
export const CORPUS_PROJECT = "selection-fixture";
export const localSelectionProvider: RoleSelectionProvider = {
  id: "fixture", model: "local",
  async readKey() { return null; },
  prepare() { throw Error("the local corpus must never call a provider"); },
};
export function corpusRule(index: number, scope: string, text?: string): RoleMemoryRule {
  const phrases = ["Check durable receipt ownership before replay.", "Inspect translated labels and theme boundaries.", "Read the amber ledger before writing the next revision.", "Keep telescope observations beside the star chart."];
  return { kind: "rule", id: `r_${index.toString(16).padStart(16, "0")}`, scope,
    rule: text ?? `${phrases[index % phrases.length]} ${["a", "ї", "界", "🪐"][index % 4].repeat(20 + index % 61)}`,
    why: "The synthetic ledger needs a repeatable check.", state: "active", hints: [],
    createdAt: CORPUS_AT, changedAt: CORPUS_AT,
    source: { project: CORPUS_PROJECT, pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "fixture" } };
}
export function selectionCorpus(size: number, wide = false): { scopes: SelectionScopes; brief: string } {
  const names = [`role:${CORPUS_PROJECT}:builder`, "role:*:builder", `project:${CORPUS_PROJECT}`, "machine", "swarm:builder"];
  const scopes = names.map(scope => ({ scope, rules: [] as RoleMemoryRule[] }));
  for (let i = 0; i < size; i++) {
    const scope = scopes[i % scopes.length];
    const rule = corpusRule(i + 1, scope.scope, wide ? `Receipt ownership ${"界🪐".repeat(65 + i % 11)}` : undefined);
    if (i < 5) rule.keptByOperatorAt = CORPUS_AT;
    scope.rules.push(rule);
  }
  return { scopes, brief: "Check durable receipt ownership and translated labels before replaying the amber ledger." };
}
