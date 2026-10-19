import { activeRoleRuleRows } from "./roleViewSource";
import { scopeProject } from "./roleScopes";
import { canonicalProject } from "@/lib/projects/aliases";

/** Live reads keep rewrites, moves and archives visible without an index copy. */
export function searchRoleRules(input: { project?: string; terms?: string[]; id?: string; limit: number }) {
  return activeRoleRuleRows(input).map(rule => {
    const project = scopeProject(rule.scope);
    return {
      id: rule.id, engine: "shared" as const, kind: "instruction" as const,
      scope: project ? "project" as const : "global" as const,
      project: project ? canonicalProject(project) : null,
      sourcePath: "Delegatus role memory", sourceKind: "role_rule" as const,
      title: rule.id, summary: rule.rule, body: rule.rule, writtenAt: rule.changedAt,
      flags: "[]",
    };
  });
}
