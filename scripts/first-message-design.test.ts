import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("the first-message as-built record covers the durable seat hand-over", () => {
  const document = readFileSync(new URL("../docs/design/first-bubble-no-raw-json.md", import.meta.url), "utf8");
  const asBuilt = document.split("## 11. As built\n")[1]?.split(/\n## /)[0] ?? "";

  expect(asBuilt).not.toMatch(/Left alone[\s\S]*create draft reappears for a frame/);
  for (const mechanism of [
    "submitting",
    "durable read",
    "heldMandate.ts",
    "conversation identity",
    "record's own slot",
    "provenance",
    "heldMandateMatches",
    "role-scaffolded",
    "opened-section store",
    "displayed text",
    "reopened",
    "MandateCard.tsx",
  ]) {
    expect(asBuilt).toContain(mechanism);
  }
  for (const path of [
    "evidence/first-message/desktop-handover.json",
    "evidence/first-message/phone-handover.json",
  ]) {
    expect(asBuilt).toContain(path);
    expect(() => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")).not.toThrow();
  }
});
