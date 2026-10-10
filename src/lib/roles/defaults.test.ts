import { expect, test } from "bun:test";
import { ROLE_DEFAULTS } from "./defaults";

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
