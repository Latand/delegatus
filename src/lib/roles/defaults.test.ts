import { expect, test } from "bun:test";
import { ROLE_DEFAULTS } from "./defaults";

test("deployer uses the committed checkout switch procedure and reads its durable verdict", () => {
  const scaffold = ROLE_DEFAULTS.find(role => role.id === "deployer")!.promptScaffold;
  expect(scaffold).toContain("scripts/deploy-checkout.py");
  expect(scaffold).toContain("docs/deploy-checkout.md");
  expect(scaffold).toContain("verdict.json");
  expect(scaffold).toContain("do not write a replacement switch script");
});
