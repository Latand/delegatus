import { expect, test } from "bun:test";
import { publicationApp403, publicationDeadlineOnly, publicationFrozenInstallFailure, pipelinePublishesRemoteBranch } from "./publication";
import { FORGE_PUSH_MINT_MARKER } from "../../../bin/forge-app-token.mjs";
import type { Pipeline } from "./types";
import { admissionLockWait } from "../../../scripts/cpu-admission-lock";

async function admissionFailureOutput(): Promise<string> {
  let now = 0;
  const lines = ["pre-push: privacy", "pre-push: CPU admission for publication checks",
    "gate-slot: Waiting for the CPU queue · 8th · waited 7 min · high priority"];
  const wait = admissionLockWait(undefined, line => lines.push(line), {
    now: () => now, sleep: async ms => { now += ms; },
  });
  try { await wait(() => { throw Object.assign(new Error("queue busy"), { code: "SQLITE_BUSY" }); }); }
  catch (error) { lines.push(`gate-slot: ${(error as Error).message}`); }
  return lines.join("\n");
}

test("a production admission lock deadline before checks start is retryable", async () => {
  expect(publicationDeadlineOnly(await admissionFailureOutput())).toBe(true);
});

test.each(["types", "eslint", "touched tests", "frozen install", "touched tests: failed (1)", "Linux tests: failed (1)"])("a started %s phase prevents an admission retry", async phase => {
  const output = await admissionFailureOutput();
  expect(publicationDeadlineOnly(`pre-push: ${phase}\n${output}`)).toBe(false);
  expect(publicationDeadlineOnly(`${output}\npre-push: ${phase}`)).toBe(false);
});

test.each(["PRIVACY GATE: FAIL", "NEW src/work.test.ts: named assertion",
  "owned runner: budget cleanup failed: child tree could not be stopped"])("a real refusal vetoes a pre-run admission retry: %s", async refusal => {
  expect(publicationDeadlineOnly(`${refusal}\n${await admissionFailureOutput()}`)).toBe(false);
});

test("queue waiting without a proven admission deadline keeps its refusal", () => {
  expect(publicationDeadlineOnly("pre-push: CPU admission for publication checks\ngate-slot: Waiting for the CPU queue · 8th · waited 7 min · high priority")).toBe(false);
});

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

test.each(["EEXIST: cannot create link", "pre-push: frozen install: failed (1)\nENOSPC"])("a frozen install refusal retains its environment cause: %s", refusal => {
  expect(publicationFrozenInstallFailure(`pre-push: frozen install\n${refusal}`)).toBe(true);
});

test.each([
  "(fail) named assertion [2.00ms]",
  "NEW src/work.test.ts: named assertion",
  "src/work.ts: error TS2353: invalid property",
  "pre-push: types: failed (1)",
  "owned runner: budget cleanup failed: child tree could not be stopped",
  "PRIVACY GATE: FAIL",
  "fatal: HTTP 403",
  "error: RPC failed; HTTP 403 curl 22",
  "remote: Permission denied",
])("a frozen install marker preserves a later decisive refusal: %s", refusal => {
  expect(publicationFrozenInstallFailure(`pre-push: frozen install\n${refusal}`)).toBe(false);
});

test("a frozen install marker preserves a verified App denial", () => {
  const output = `pre-push: frozen install\n${FORGE_PUSH_MINT_MARKER}\nfatal: HTTP 403`;
  expect(publicationApp403(output)).toBe(true);
  expect(publicationFrozenInstallFailure(output)).toBe(false);
});

test("a stale frozen install marker retains the Git transport cause", async () => {
  const { publicationFailureCause } = await import("./git");
  expect(publicationFailureCause({ step: "publishing the pipeline branch", code: 1, signal: null, durationMs: 1700,
    outputTail: "pre-push: frozen install\nfatal: HTTP 403" }))
    .toBe("git push was refused (exit 1): fatal: HTTP 403");
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
