import fs from "node:fs";
import path from "node:path";

import { expect, test } from "bun:test";
import { PROTOTYPE_PUBLICATION_RULE, ROLE_DEFAULTS } from "./defaults";

const repository = path.resolve(import.meta.dir, "../../..");

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
    "that the PR merged and waits for a deploy while it is pending",
    "the deployed commit only after confirming a successful deployment contains the merge",
    "Reopen only for new evidence of a real problem, such as a reverted PR or a promised part still open",
  ]) expect(scaffold).toContain(phrase);
  expect(scaffold).not.toContain("A task that is merged and not deployed stays open");
  /* The literal notes are the maintenance brief's, in the operator's language. */
  expect(scaffold).not.toContain("Змерджено");
  expect(fs.readFileSync(path.join(repository, "src/lib/boardMaintenance/text.ts"), "utf8")).toContain("Змерджено #N. Чекає деплою.");
});

test("deployer follows the project's committed procedure, which for Delegatus lives in its instruction files", () => {
  const scaffold = ROLE_DEFAULTS.find(role => role.id === "deployer")!.promptScaffold;
  expect(scaffold).toContain("never write a replacement for a procedure the project has committed");
  expect(scaffold).toContain("When the procedure records its own verdict, judge the final serving state and the protected work from that verdict");
  for (const named of ["scripts/deploy-checkout.py", "docs/deploy-checkout.md", "verdict.json"]) expect(scaffold).not.toContain(named);
  const agents = fs.readFileSync(path.join(repository, "AGENTS.md"), "utf8");
  for (const named of ["scripts/deploy-checkout.py", "docs/deploy-checkout.md", "deploy-verdicts/latest-<install-id>.json", "verdict.json", "writes no\nreplacement switch script"]) expect(agents).toContain(named);
});

test("reviewers require captured-base evidence before attributing a test failure", () => {
  const scaffold = ROLE_DEFAULTS.find(role => role.id === "reviewer")!.promptScaffold;
  expect(scaffold).toContain("Test baseline:");
  expect(scaffold).toContain("captured review base");
  expect(scaffold).toContain("documented baseline comparison helper");
  expect(scaffold).toContain("the exact base and head commits, the full test identity and both outcomes");
  expect(scaffold).toContain("it alone never warrants a finding or a failing verdict");
  expect(scaffold).toContain("New head-only failures still block");
  expect(scaffold).toContain("Missing, skipped or incomplete runs");
  expect(scaffold).toContain("independently evidenced defects in the diff still warrant findings");
});

test("prototype builders hand frames to a critic before a separate publication stage", () => {
  expect(PROTOTYPE_PUBLICATION_RULE).toContain("frame directory in your report");
  expect(PROTOTYPE_PUBLICATION_RULE).toContain("onFail proto-fix, maxRounds 2, onExhausted advance");
  expect(PROTOTYPE_PUBLICATION_RULE).toContain("Only its publish stage calls publish_prototype_review after the critic passes or its findings are fixed");
});
