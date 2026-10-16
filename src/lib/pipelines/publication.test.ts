import { expect, test } from "bun:test";
import { publicationDeadlineOnly, pipelinePublishesRemoteBranch } from "./publication";
import type { Pipeline } from "./types";

for (const [publication, disposition, remote, publishes] of [
  ["remote-branch", "owner", "", true],
  [undefined, "owner", "https://example.invalid/repo.git", true],
  [undefined, "owner", "", false],
  ["internal", "owner", "https://example.invalid/repo.git", false],
  [undefined, "comparison", "https://example.invalid/repo.git", false],
] as const) test(`publication ${publication ?? "implicit"}, ${disposition}, remote=${!!remote}`, () => {
  const delivery: NonNullable<Pipeline["delivery"]> = { target: { repository: "repo-fixture", branch: "refs/heads/lane", remote },
    disposition, publish: disposition === "owner" ? "enabled" : "disabled", active: disposition === "owner", ownerId: "lane", epoch: 1, journal: [] };
  expect(pipelinePublishesRemoteBranch({ publication, delivery })).toBe(publishes);
});


test.each([
  "pre-push: no verdict within the push budget of 840 s: \"touched tests\" was still running",
  "pre-push: touched tests: failed (124)\nowned runner: deadline expired",
  "NEW src/work.test.ts: <runner error> runner did not finish (124)",
  "command timed out after 900000ms",
  "pre-push: Viewer runtime: failed (124)\nowned runner: deadline expired",
])("a deadline without a refusal is retryable: %s", output => {
  expect(publicationDeadlineOnly(output)).toBe(true);
});

test.each([
  "(fail) named assertion [2.00ms]",
  "NEW src/work.test.ts: named assertion",
  "NEW src/work.test.ts: <runner error> runner did not finish (124); (fail) named assertion",
  "pre-push: types: failed (1)",
  "pre-push: privacy: failed (1)",
  "PRIVACY GATE: FAIL",
  "owned runner: surviving owned processes: fixture",
  "stop them before pushing again",
])("a decisive refusal vetoes a capacity retry: %s", refusal => {
  expect(publicationDeadlineOnly(`pre-push: touched tests: failed (1)\n${refusal}\nowned runner: deadline expired`)).toBe(false);
});

test("an ordinary touched-test exit has no capacity evidence", () => {
  expect(publicationDeadlineOnly("pre-push: touched tests: failed (1)")).toBe(false);
});
