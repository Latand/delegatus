import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("the first-message as-built record covers the durable seat hand-over", () => {
  for (const path of [
    "evidence/first-message/desktop-handover.json",
    "evidence/first-message/phone-handover.json",
  ]) {
    expect(() => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")).not.toThrow();
  }
});
