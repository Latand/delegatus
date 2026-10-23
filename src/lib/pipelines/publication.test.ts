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
  "owned runner: budget cleanup failed: child tree could not be stopped",
  "owned test child guardian: surviving owned processes: fixture",
  "owned test child guardian could not end an owned process",
  "owned runner guardian exceeded cleanup deadline",
  "stop them before pushing again",
])("a decisive refusal vetoes a capacity retry: %s", refusal => {
  expect(publicationDeadlineOnly(`pre-push: touched tests: failed (1)\n${refusal}\nowned runner: deadline expired`)).toBe(false);
});

test("an ordinary touched-test exit has no capacity evidence", () => {
  expect(publicationDeadlineOnly("pre-push: touched tests: failed (1)")).toBe(false);
});

// The remote gate runner lost a started run (scripts/gate-runner/client.ts).
test("a gate runner without a verdict is retryable unless a refusal accompanies it", () => {
  const lost = "pre-push: CPU admission for publication checks\ngate-runner: no verdict: the connection to the runner was lost after 41 s; nothing was judged";
  expect(publicationDeadlineOnly(lost)).toBe(true);
  expect(publicationDeadlineOnly(`${lost}\nNEW src/work.test.ts: named assertion`)).toBe(false);
  expect(publicationDeadlineOnly(`PRIVACY GATE: FAIL\n${lost}`)).toBe(false);
  expect(publicationDeadlineOnly("gate-runner: running here: the runner is unavailable: ssh exited 255")).toBe(false);
});

test("a publication stopped by the gate runner names the runner", async () => {
  const { publicationFailureCause, publicationInterruptionCause } = await import("./git");
  const failure = { step: "publishing the pipeline branch", code: 75, signal: null, durationMs: 41_000,
    outputTail: "pre-push: CPU admission for publication checks\ngate-runner: no verdict: the connection to the runner was lost after 41 s; nothing was judged" };
  expect(publicationInterruptionCause(failure)).toBe("the gate runner returned no verdict for the hook's checks (the connection to the runner was lost after 41 s; nothing was judged), and the push did not reach the remote");
  expect(publicationFailureCause(failure)).toContain("the gate runner returned no verdict: the connection to the runner was lost after 41 s");
});
