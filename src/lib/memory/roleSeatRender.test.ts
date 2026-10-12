import { expect, test } from "bun:test";
import { renderLearnedRules } from "./roleRender";

const scopes = (role: string) => [`role:seat-project:${role}`, `role:*:${role}`, "project:seat-project", "machine"].map(scope => ({ scope, rules: [] }));

test("even a first seat reads when to leave a rule, create a task and tell the operator", () => {
  const block = renderLearnedRules(scopes("orchestrator"));
  expect(block).toContain("Earlier seats and stage agents");
  expect(block).toContain("designated seat");
  expect(block).toContain("create_task");
  expect(block).toContain("tell the operator");
  expect(block).not.toContain("When you report with stage_report");
});

test("maintainers read seat guidance and leave no rules themselves", () => {
  const block = renderLearnedRules(scopes("maintainer"));
  expect(block).toContain("Earlier agents and this project's seat");
  expect(block).toContain("You leave no rules in this run.");
  expect(block).not.toContain("When you report with stage_report");
});

test("ordinary stages retain their original block byte for byte", () => {
  expect(renderLearnedRules(scopes("builder"))).toBe([
    "Learned rules (Delegatus role memory): 0 role · 0 project · 0 machine",
    "Earlier agents left these when they finished their stages. They are rules of thumb: the brief, the pinned specification and the project's instruction files win where they disagree. Keep them on this machine: never copy a rule into a commit, pull request, issue, task or report; name it by its id.",
    "", "Role rules · Builder on this project", "- none yet",
    "", "Role rules · Builder on every project", "- none yet",
    "", "Project rules · every role on this project", "- none yet",
    "", "Machine rules · every project on this machine", "- none yet", "",
    "When you report with stage_report, its answer asks whether this stage taught anything; most stages answer none. A rule above that proved wrong or too narrow can be rewritten then, by its id.",
  ].join("\n"));
});
