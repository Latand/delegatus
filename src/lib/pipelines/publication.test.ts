import { expect, test } from "bun:test";
import { publicationApp403, publicationDeadlineOnly, pipelinePublishesRemoteBranch } from "./publication";
import { FORGE_PUSH_MINT_MARKER } from "../../../bin/forge-app-token.mjs";
import type { Pipeline } from "./types";

test.each([
  "remote: Permission to acme/widgets.git denied to delivery[bot].",
  "fatal: unable to access repository: The requested URL returned error: 403",
  "fatal: HTTP 403",
])("App git denial after a verified fresh mint is transient: %s", output => {
  expect(publicationApp403(`${FORGE_PUSH_MINT_MARKER}\n${output}`)).toBe(true);
  expect(publicationApp403(output)).toBe(false);
});

test.each(["HTTP 401", "HTTP 404", "HTTP 500", "Permission denied (publickey)", "Everything up-to-date",
  "Delegatus refused this GitHub write: HTTP 403 while verifying the App installation"])("other failures keep their classification: %s", output => {
  expect(publicationApp403(`${FORGE_PUSH_MINT_MARKER}\n${output}`)).toBe(false);
});

test("a failed transport retains its error when git finishes with Everything up-to-date", async () => {
  const { publicationFailureCause } = await import("./git");
  expect(publicationFailureCause({ step: "publishing the pipeline branch", code: 1, signal: null, durationMs: 1700,
    outputTail: "error: RPC failed; HTTP 403 curl 22\nfatal: the remote end hung up unexpectedly\nEverything up-to-date" }))
    .toBe("git push was refused (exit 1): error: RPC failed; HTTP 403 curl 22");
});

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
