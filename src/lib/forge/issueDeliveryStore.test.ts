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
data.repositories[repo].prs["9"] = { url: "https://github.com/acme/widgets/pull/9", headRefName: "pipeline/source", createdAt: at, state: "merged", mergedAt: at, checkedAt: at, closes: [] };
const prOf = () => ({ repository: repo, number: 9 });
if (!loadPipelines().length && process.env.DELIVERY_PASS === "0") {
  const lane = buildPipeline({ id: "source", task: "Issue #7: Deliver widgets", taskIds: [], project: "fixture", repoDir: "fixture", stages: [{ id: "build", kind: "run", prompt: "Build", next: null, onFail: null, effectiveRole: { roleId: null, engine: "claude", model: null, effort: null, access: "read-write", promptScaffold: null } }], srcPath: null, srcConversationId: null, now: at });
  lane.state = "completed"; lane.closedAt = at; lane.cursor = null;
  assignPipelineDelivery(lane, { repository: "fixture", remote: "https://github.com/acme/widgets.git", branch: "refs/heads/pipeline/source", pr: 9 });
  lane.workLinks = creationIssueLinks(lane, { repository: repo, cache: forgeViewOf(data), lanes: [], pullRequestOf: prOf });
  if (["noted", "reopened"].includes(scenario)) lane.workLinks[0].part = true;
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
  run: async args => {
    calls++;
    if (["pending", "exhausted"].includes(scenario)) throw new Error("offline");
    if (args[1].includes("/pulls/")) return JSON.stringify({ merged_at: at, title: "Widget controls", base: { ref: scenario === "other-base" ? "release" : "main", repo: { default_branch: "main" } } });
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
  ["not-an-issue", "skipped"], ["other-base", "skipped"], ["app-permission", "refused"],
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
