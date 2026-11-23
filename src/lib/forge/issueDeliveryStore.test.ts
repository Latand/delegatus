import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "issue-delivery-restart-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
// Each pass is a real process: the boundary, failure count and finality must
// come from durable records, with no surviving module cache or global slot.
const child = `
const { buildPipeline, assignPipelineDelivery, loadPipelines, savePipelines, withPipelineMutation, archiveSettledPipelines } = await import("./src/lib/pipelines/store");
const { creationIssueLinks, issueDeliverySince, sweepIssueDelivery } = await import("./src/lib/forge/issueDelivery");
const { emptyRepositoryEntry, forgeViewOf } = await import("./src/lib/forge/cache");
const { ForgeAppWriteRefused } = await import("./src/lib/forge/appWrite");
const scenario = process.env.DELIVERY_CASE;
const at = "2026-11-01T12:00:00.000Z";
const now = Date.parse(at) + Number(process.env.DELIVERY_PASS) * 600000;
const repo = "acme/widgets";
const data = { schemaVersion: 1, repositories: { [repo]: emptyRepositoryEntry() } };
data.repositories[repo].prs["9"] = { url: "https://github.com/acme/widgets/pull/9", headRefName: "pipeline/source", createdAt: at, state: scenario === "closed-batch-wait" ? "closed" : "merged", mergedAt: at, checkedAt: at, closes: [] };
const prOf = () => ({ repository: repo, number: 9 });
if (!loadPipelines().length && process.env.DELIVERY_PASS === "0") {
  const lane = buildPipeline({ id: "source", task: "Issue #7: Deliver widgets", taskIds: [], project: "fixture", repoDir: "fixture", stages: [{ id: "build", kind: "run", prompt: "Build", next: null, onFail: null, effectiveRole: { roleId: null, engine: "claude", model: null, effort: null, access: "read-write", promptScaffold: null } }], srcPath: null, srcConversationId: null, now: at });
  lane.state = "completed"; lane.closedAt = at; lane.cursor = null;
  assignPipelineDelivery(lane, { repository: "fixture", remote: "https://github.com/acme/widgets.git", branch: "refs/heads/pipeline/source", pr: 9 });
  lane.workLinks = creationIssueLinks(lane, { repository: repo, cache: forgeViewOf(data), lanes: [], pullRequestOf: prOf });
  if (["noted", "reopened"].includes(scenario)) lane.workLinks[0].part = true;
  if (scenario === "legacy-other-base") lane.issueDelivery = [{ repository: repo, number: 7, pr: 9, mode: "close", state: "skipped", reason: "other-base", at }];
  savePipelines([lane]);
}
const boundary = issueDeliverySince(Date.parse(at) - 1000);
let state = ["already-closed", "reopened"].includes(scenario) ? "closed" : "open";
let calls = 0;
await sweepIssueDelivery({
  now: () => now, since: () => issueDeliverySince(now), loadPipelines, loadTasks: () => [],
  repositoryOf: () => repo, pullRequestOf: prOf, cache: () => ({ data, view: forgeViewOf(data) }), inspectTitle: async () => true,
  mutate: async (id, change) => withPipelineMutation(async (rows, persist) => {
    const lane = rows.find(p => p.id === id); if (!lane || !change(lane)) return false;
    await persist(); return true;
  }),
  carriedLanding: async (_lane, _repository, _pr, _base, _head, hint) => {
    if (process.env.DELIVERY_PASS !== "0" && hint.commit !== "c".repeat(40)) throw new Error("Lost the durable batch hint");
    return process.env.DELIVERY_ARRIVED ? { state: "landed", batch: 10, mergedAt: at, commit: "c".repeat(40) }
      : { state: "waiting", batch: 10, commit: "c".repeat(40), after: "d".repeat(40) };
  },
  run: async args => {
    calls++;
    if (["pending", "exhausted"].includes(scenario)) throw new Error("offline");
    if (scenario === "closed-batch-wait" && args[1].endsWith("/pulls/10")) return JSON.stringify({ number: 10, state: process.env.DELIVERY_ARRIVED ? "closed" : "open", merged_at: process.env.DELIVERY_ARRIVED ? at : null,
      title: "Widget batch", head: { ref: "batch/widgets" }, base: { ref: "main", repo: { default_branch: "main" } } });
    if (scenario === "closed-batch-wait" && args[1].endsWith("/pulls/9")) return JSON.stringify({ state: "closed", merged_at: null, head: { sha: "a".repeat(40) }, base: { ref: "batch/widgets", repo: { default_branch: "main" } } });
    if (args[1].includes("/compare/")) return JSON.stringify({ base_commit: { sha: "c".repeat(40) }, merge_base_commit: { sha: (process.env.DELIVERY_ARRIVED ? "c" : "d").repeat(40) } });
    if (args[1].includes("/commits/") && args[1].endsWith("/pulls?per_page=100")) return "[]";
    if (args[1].includes("/pulls/")) return JSON.stringify({ merged_at: at, merge_commit_sha: "c".repeat(40), title: "Widget controls", base: { ref: scenario === "batch-wait" ? "batch/widgets" : scenario === "other-base" ? "release" : "main", repo: { default_branch: "main" } } });
    if (args[1] === "graphql") return JSON.stringify({ data: { repository: { issue: { timelineItems: { nodes: [{ closer: { number: 9, repository: { nameWithOwner: repo } } }] } } } } });
    if (args[1].includes("/comments?")) return "[]";
    return JSON.stringify({ state, state_reason: "completed", ...(scenario === "not-an-issue" ? { pull_request: {} } : {}) });
  },
  write: async args => {
    calls++;
    if (scenario === "app-permission") throw new ForgeAppWriteRefused("grant unavailable");
    if (args.includes("state=closed")) state = "closed";
    if (args.includes("state=open")) state = "open";
    return "{}";
  },
});
const stored = loadPipelines()[0];
const before = stored?.issueDelivery;
const archived = process.env.ARCHIVE_NOW ? await archiveSettledPipelines(Number(process.env.ARCHIVE_NOW)) : null;
console.log(JSON.stringify({ receipt: before?.[0], links: stored?.workLinks, boundary, calls, archived }));
`;
async function run(scenario: string, pass = 0, extra: Record<string, string> = {}) {
  const state = path.join(root, scenario);
  fs.mkdirSync(state, { recursive: true });
  const proc = Bun.spawn([process.execPath, "--eval", child], {
    cwd: process.cwd(), env: { ...process.env, LLV_STATE_DIR: state, DELIVERY_CASE: scenario, DELIVERY_PASS: String(pass), ...extra }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(code, stderr).toBe(0);
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}
test.each([
  ["closed", "closed"], ["already-closed", "already-closed"], ["noted", "noted"], ["reopened", "reopened"],
  ["not-an-issue", "skipped"], ["app-permission", "refused"],
])("real %s writer output survives the pipeline reader and a process restart", async (scenario, state) => {
  const first = await run(scenario!);
  expect(first.receipt.state).toBe(state);
  const second = await run(scenario!, 1);
  expect(second.receipt).toEqual(first.receipt);
  expect(second.calls).toBe(0);
  expect(second.boundary).toBe(first.boundary);
  expect(second.links).toEqual(first.links);
});
test("durable retries survive restarts, obey backoff, and refuse on the third failure", async () => {
  const first = await run("exhausted");
  expect(first.receipt).toMatchObject({ state: "pending", failures: 1 });
  const early = await run("exhausted");
  expect(early.calls).toBe(0); expect(early.receipt).toEqual(first.receipt);
  const second = await run("exhausted", 1);
  expect(second.receipt).toMatchObject({ state: "pending", failures: 2 });
  const third = await run("exhausted", 2);
  expect(third.receipt).toMatchObject({ state: "refused", failures: 3, reason: "github-unavailable" });
  expect((await run("exhausted", 3)).calls).toBe(0);
});
test("unresolved own issue holds real archival, then expires after thirty days", async () => {
  const day = 86400_000; const at = Date.parse("2026-11-01T12:00:00.000Z");
  const held = await run("pending", 0, { ARCHIVE_NOW: String(at + 10 * day) });
  expect(held.archived).toBe(0);
  const expired = await run("pending", 1, { ARCHIVE_NOW: String(at + 31 * day) });
  expect(expired.archived).toBe(1);
});

test("a batch-branch wait survives real restarts without spending failure retries", async () => {
  const first = await run("batch-wait");
  expect(first.receipt).toMatchObject({ state: "pending", failures: 0 });
  expect((await run("batch-wait")).calls).toBe(0);
  const waiting = await run("batch-wait", 1);
  expect(waiting.receipt).toMatchObject({ state: "pending", failures: 0 });
  const landed = await run("batch-wait", 2, { DELIVERY_ARRIVED: "1" });
  expect(landed.receipt.state).toBe("closed");
  expect((await run("batch-wait", 3)).calls).toBe(0);
});

test("closed-PR commit hints and bounded receipt cursors survive real process restarts", async () => {
  const first = await run("closed-batch-wait");
  expect(first.receipt).toMatchObject({ state: "pending", failures: 0, batch: 10, batchCommit: "c".repeat(40), batchAfter: "d".repeat(40) });
  expect((await run("closed-batch-wait")).calls).toBe(0);
  const waiting = await run("closed-batch-wait", 1);
  expect(waiting.receipt).toMatchObject({ state: "pending", batchCommit: "c".repeat(40), batchAfter: "d".repeat(40) });
  const landed = await run("closed-batch-wait", 2, { DELIVERY_ARRIVED: "1" });
  expect(landed.receipt).toMatchObject({ state: "closed", batch: 10, batchCommit: "c".repeat(40) });
  expect(landed.receipt).not.toHaveProperty("batchAfter");
  expect((await run("closed-batch-wait", 3)).calls).toBe(0);
});

test("the real reader preserves a legacy other-base skip without replay", async () => {
  const first = await run("legacy-other-base");
  expect(first.receipt).toMatchObject({ state: "skipped", reason: "other-base" });
  const second = await run("legacy-other-base", 1);
  expect(second.receipt).toEqual(first.receipt); expect(second.calls).toBe(0);
});
