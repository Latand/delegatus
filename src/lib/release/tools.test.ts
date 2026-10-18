import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { captureTools, requiredReleaseChecks } from "./production";
test("capture readiness probes the host Bun bridge used by the capture agent", async () => {
  let calls = 0;
  const tools = await captureTools("/synthetic/repo", async (file, args, cwd) => {
    calls++; expect(file).toBe("bun"); expect(args[0]).toBe("-e"); expect(cwd).toBe("/synthetic/repo");
    return JSON.stringify({ missing: ["tesseract"], chrome: "chrome-fixture" });
  });
  expect(calls).toBe(1); expect(tools.missing).toEqual(["tesseract"]);
});

const repo = "example/project";
const main = "a".repeat(40), cut = "b".repeat(40);
const heads = { [main]: "c".repeat(40), [cut]: "d".repeat(40) };
const pushChecks = ["typecheck", "privacy-publication", "privacy-tracker-audit"];
const success = (name: string) => ({ name, status: "completed", conclusion: "success" as string | null });
const endpoint = (sha: string, suffix: string) => `repos/${repo}/commits/${sha}/${suffix}`;
const workflowEndpoint = (sha: string) => `repos/${repo}/contents/.github/workflows/bun-runtime.yml?ref=${sha}`;
function checksFixture() {
  const responses = new Map<string, unknown>();
  const calls: string[] = [];
  responses.set(`repos/${repo}/branches/main`, { protection: { required_status_checks: {
    contexts: pushChecks, checks: [...pushChecks, "runtime-gate"].map(context => ({ context })),
  } } });
  for (const sha of [main, cut]) {
    responses.set(endpoint(sha, "check-runs?per_page=100"), { check_runs: pushChecks.map(success) });
    responses.set(endpoint(sha, "status?per_page=100"), { statuses: [] });
    responses.set(workflowEndpoint(sha), readFileSync(new URL("../../../.github/workflows/bun-runtime.yml", import.meta.url), "utf8"));
    responses.set(endpoint(sha, "pulls?per_page=100"), [{ merged_at: "2026-10-17T00:00:00Z", merge_commit_sha: sha,
      base: { ref: "main", repo: { full_name: repo } }, head: { sha: heads[sha] } }]);
    responses.set(endpoint(heads[sha]!, "check-runs?per_page=100"), { check_runs: [success("runtime-gate")] });
    responses.set(endpoint(heads[sha]!, "status?per_page=100"), { statuses: [] });
  }
  const run = async (file: string, args: string[]) => {
    expect(file).toBe("gh"); expect(args[0]).toBe("api");
    const route = args[1]!; calls.push(route);
    if (!responses.has(route)) throw new Error(`unexpected GitHub read: ${route}`);
    const response = responses.get(route);
    if (response instanceof Error) throw response;
    if (route.includes("/contents/")) {
      expect(args.slice(2)).toEqual(["--header", "Accept: application/vnd.github.raw+json"]);
      return String(response);
    }
    return JSON.stringify(response);
  };
  return { responses, calls, run };
}

test("PR-only runtime gates are satisfied by the merged PR heads for main and the frozen cut", async () => {
  const h = checksFixture();
  expect(await requiredReleaseChecks(repo, [main, cut, main], h.run)).toBe("green");
  for (const sha of [main, cut]) {
    expect(h.calls.filter(route => route === endpoint(sha, "check-runs?per_page=100"))).toHaveLength(1);
    expect(h.calls).toContain(endpoint(heads[sha]!, "check-runs?per_page=100"));
  }
});

for (const sha of [main, cut]) {
  test.each([
    ["missing", undefined, "pending"],
    ["running", { name: "typecheck", status: "in_progress", conclusion: null }, "pending"],
    ["failed", { name: "typecheck", status: "completed", conclusion: "failure" }, "red"],
  ] as const)(`a %s push check on ${sha === main ? "main" : "the cut"} keeps its verdict`, async (_, run, verdict) => {
    const h = checksFixture();
    h.responses.set(endpoint(sha, "check-runs?per_page=100"), { check_runs: [...pushChecks.slice(1).map(success), ...(run ? [run] : [])] });
    // A passing PR check must never substitute for a push check on this SHA.
    h.responses.set(endpoint(heads[sha]!, "check-runs?per_page=100"), { check_runs: [success("runtime-gate"), success("typecheck")] });
    expect(await requiredReleaseChecks(repo, [main, cut], h.run)).toBe(verdict);
  });
}

test.each(["pending", "failure", "error", "success"])("commit statuses preserve %s for push checks", async state => {
  const h = checksFixture();
  h.responses.set(endpoint(main, "check-runs?per_page=100"), { check_runs: pushChecks.slice(1).map(success) });
  h.responses.set(endpoint(main, "status?per_page=100"), { statuses: [{ context: "typecheck", state }] });
  expect(await requiredReleaseChecks(repo, [main, cut], h.run)).toBe(state === "success" ? "green" : state === "pending" ? "pending" : "red");
});

test.each([
  ["in_progress", null, "pending"], ["completed", "failure", "red"],
  ["completed", "success", "green"], ["completed", "neutral", "green"], ["completed", "skipped", "green"],
] as const)("the PR-only check still needs a passing PR verdict: %s/%s", async (status, conclusion, verdict) => {
  const h = checksFixture();
  h.responses.set(endpoint(heads[cut]!, "check-runs?per_page=100"), { check_runs: [{ name: "runtime-gate", status, conclusion }] });
  expect(await requiredReleaseChecks(repo, [main, cut], h.run)).toBe(verdict);
});

test("an absent runtime gate on the PR remains pending", async () => {
  const h = checksFixture();
  h.responses.set(endpoint(heads[cut]!, "check-runs?per_page=100"), { check_runs: [] });
  expect(await requiredReleaseChecks(repo, [main, cut], h.run)).toBe("pending");
});

test("a failed runtime gate already on the cut cannot be replaced by passing PR evidence", async () => {
  const h = checksFixture();
  h.responses.set(endpoint(cut, "check-runs?per_page=100"), { check_runs: [...pushChecks.map(success), { ...success("runtime-gate"), conclusion: "failure" }] });
  expect(await requiredReleaseChecks(repo, [main, cut], h.run)).toBe("red");
  expect(h.calls).not.toContain(workflowEndpoint(cut));
});

test.each([
  [],
  [{ merged_at: null, merge_commit_sha: cut, base: { ref: "main", repo: { full_name: repo } }, head: { sha: heads[cut] } }],
  [{ merged_at: "2026-10-17", merge_commit_sha: main, base: { ref: "main", repo: { full_name: repo } }, head: { sha: heads[cut] } }],
  [{ merged_at: "2026-10-17", merge_commit_sha: cut, base: { ref: "other", repo: { full_name: repo } }, head: { sha: heads[cut] } }],
  [{ merged_at: "2026-10-17", merge_commit_sha: cut, base: { ref: "main", repo: { full_name: "example/other" } }, head: { sha: heads[cut] } }],
  [{ merged_at: "2026-10-17", merge_commit_sha: cut, base: { ref: "main", repo: { full_name: repo } }, head: { sha: "invalid" } }],
].map(pulls => ({ pulls })))("PR-only evidence requires the exact merged PR into this repository's main: %#", async ({ pulls }) => {
  const h = checksFixture();
  h.responses.set(endpoint(cut, "pulls?per_page=100"), pulls);
  expect(await requiredReleaseChecks(repo, [main, cut], h.run)).toBe("pending");
});

test.each([
  "on: push", "on: [push, pull_request]", "on:\n  push:\n    branches: [main]\n  pull_request:",
  "on: workflow_dispatch", "on: [pull_request]", "on: pull_request",
])("workflow triggers at the checked revision determine whether PR evidence applies: %s", async triggers => {
  const h = checksFixture();
  h.responses.set(workflowEndpoint(cut), `${triggers}\njobs:\n  runtime-gate:\n    runs-on: ubuntu-latest\n`);
  expect(await requiredReleaseChecks(repo, [main, cut], h.run)).toBe(triggers === "on: [pull_request]" || triggers === "on: pull_request" ? "green" : "pending");
});

test("a renamed workflow job cannot exempt the old required name", async () => {
  const h = checksFixture();
  h.responses.set(workflowEndpoint(cut), "on: pull_request\njobs:\n  replacement:\n    runs-on: ubuntu-latest\n");
  expect(await requiredReleaseChecks(repo, [main, cut], h.run)).toBe("pending");
});

test("unrecognised required contexts stay pending", async () => {
  const h = checksFixture();
  h.responses.set(`repos/${repo}/branches/main`, { protection: { required_status_checks: { contexts: [...pushChecks, "runtime-gate", "new-check"] } } });
  expect(await requiredReleaseChecks(repo, [main, cut], h.run)).toBe("pending");
});

test.each([workflowEndpoint(cut), endpoint(cut, "pulls?per_page=100"), endpoint(heads[cut]!, "check-runs?per_page=100")])("unreadable fallback evidence cannot authorize a release: %s", async route => {
  const h = checksFixture();
  h.responses.set(route, new Error("GitHub unavailable"));
  await expect(requiredReleaseChecks(repo, [main, cut], h.run)).rejects.toThrow("GitHub unavailable");
});
