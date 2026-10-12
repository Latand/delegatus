import type { RoleMemoryProjectView, RuleView, ScopeView } from "./roleTypes";
import type { ProfileAnswer } from "./profileTypes";

export function sampleRule(id: string, rule = "Check the sample color before saving."): RuleView {
  return { id, rule, why: "A sample changed color during a preview.", state: "active", hints: [], roleId: "builder", fixRound: false, stageId: "sample", fresh: false, createdAt: "2026-01-01", changedAt: "2026-01-01" };
}
export function sampleScope(scope: string, active: RuleView[]): ScopeView {
  const kind = scope === "machine" ? "machine" : scope.startsWith("role:") ? "role" : "project";
  return { scope, kind, roleId: kind === "role" ? scope.split(":").at(-1)! : null, revision: 1, chars: 100, bound: 10_000, addedToday: 0, active, left: [] };
}
export function sampleMemory(): RoleMemoryProjectView {
  return { project: "garden", enabled: true, scopes: [sampleScope("role:garden:builder", [sampleRule("one"), sampleRule("two")]), sampleScope("role:*:builder", [sampleRule("three")]), sampleScope("project:garden", [sampleRule("four")]), sampleScope("machine", [sampleRule("five")]), sampleScope("role:garden:architect", [])] };
}
export function sampleAnswer(uk = false): ProfileAnswer {
  const topic = uk ? { title: "Перевірка зразків", text: "Агенти перевіряють, як змінюються кольори зразків.", rules: [1] }
    : { title: "Checking samples", text: "Agents check how sample colors change.", rules: [1] };
  return { headline: uk ? "Зрозуміліші зразки" : "Clearer samples", text: uk ? "Агенти перевіряють кольори зразків під час перегляду. Це допомагає зберігати зрозумілі результати." : "Agents check sample colors during previews. This helps them keep the saved result clear.", topics: [topic, { ...topic, title: uk ? "Перегляд кольорів" : "Previewing colors" }, { ...topic, title: uk ? "Збереження результатів" : "Saving results" }] };
}
