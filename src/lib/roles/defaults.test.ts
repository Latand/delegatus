import { expect, test } from "bun:test";
import { ROLE_DEFAULTS } from "./defaults";

test("maintainer preserves Done while deployment is pending and follows the project merge setting", () => {
  const scaffold = ROLE_DEFAULTS.find(role => role.id === "maintainer")!.promptScaffold;
  for (const phrase of [
    "Never reopen a Done task only because its merge is not deployed",
    "Done tasks with a pending-deploy note, including older ones",
    "list_tasks with status done without updatedSince and follow nextCursor",
    "mergeOnReview in get_orchestrator",
    "When it is on, a task whose pull requests are all merged is Done",
    "When it is off, an open task in a project that ships by deploy stays open",
    "nothing it promised is still open",
    "Змерджено #N. Чекає деплою.",
    "Розгорнуто <sha>",
    "successful deployment contains the merge",
    "Reopen only for new evidence of a real problem, such as a reverted PR or a promised part still open",
  ]) expect(scaffold).toContain(phrase);
  expect(scaffold).not.toContain("A task that is merged and not deployed stays open");
});

test("deployer uses the committed checkout switch procedure and reads its durable verdict", () => {
  const scaffold = ROLE_DEFAULTS.find(role => role.id === "deployer")!.promptScaffold;
  expect(scaffold).toContain("scripts/deploy-checkout.py");
  expect(scaffold).toContain("docs/deploy-checkout.md");
  expect(scaffold).toContain("verdict.json");
  expect(scaffold).toContain("do not write a replacement switch script");
});

test("reviewers require captured-base evidence before attributing a test failure", () => {
  const scaffold = ROLE_DEFAULTS.find(role => role.id === "reviewer")!.promptScaffold;
  expect(scaffold).toContain("Test baseline comparison:");
  expect(scaffold).toContain("captured review base");
  expect(scaffold).toContain("documented baseline comparison helper");
  expect(scaffold).toContain("exact base/head commits, full test identity and both outcomes");
  expect(scaffold).toContain("it alone never warrants a finding or a failing verdict");
  expect(scaffold).toContain("New head-only failures still block");
  expect(scaffold).toContain("Missing, skipped or incomplete runs");
  expect(scaffold).toContain("Independently evidenced defects in the diff still warrant findings");
});
