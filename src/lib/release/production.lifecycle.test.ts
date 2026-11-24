import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as runModule from "./run";
import { ready } from "./policy.fixture";
import { releaseState } from "./policy";
import { mergedReleasePullRequests, releaseControllerForSources } from "./production";
import { releaseStages, releasePublishStages } from "./stages";
import { RELEASE_DEFAULTS } from "./settings";
import { mutateReleaseProject, readReleaseProject } from "./store";
import { normalizeStages } from "@/lib/pipelines/engine";
import { pipelineRoleLookup } from "@/lib/pipelines/roles";
import { buildPipeline } from "@/lib/pipelines/store";
import { resetAutoMergeForTests, sweepAutoMerge, type AutoMergePorts } from "@/lib/forge/autoMerge";
import { defaultSeatTickSettings, effectiveSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import type { SeatTickSources } from "@/lib/monitor/seatTickSources";
import type { CreatePipelineRequest, Pipeline } from "@/lib/pipelines/types";

const project = "release-lifecycle", at = "2026-11-01T00:00:00Z", head = "b".repeat(40);
const brief = { cut: "a".repeat(40), lastTag: "v1.0.0", changes: [], askBeforePublish: true };
let directory: string;
const originalState = process.env.LLV_STATE_DIR;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "release-lifecycle-"));
  process.env.LLV_STATE_DIR = directory;
  resetAutoMergeForTests();
});
afterEach(() => {
  process.env.LLV_STATE_DIR = originalState;
  resetAutoMergeForTests();
  fs.rmSync(directory, { recursive: true, force: true });
});
function lane(id: string, publish = false): Pipeline {
  const normalized = normalizeStages(publish ? releasePublishStages({ ...brief, commit: head, pr: 7 }) : releaseStages(brief), pipelineRoleLookup);
  expect(normalized.error).toBeUndefined();
  const row = buildPipeline({ id, task: publish ? "Реліз Delegatus: публікація" : "Реліз Delegatus", project,
    repoDir: process.cwd(), stages: normalized.stages!, srcPath: null, srcConversationId: null, now: at });
  return Object.assign(row, { state: "completed" as const, lastPassedCommit: head, baseRef: head, closedAt: at });
}
function merge(state: NonNullable<Pipeline["merge"]>["state"]): NonNullable<Pipeline["merge"]> {
  return { state, by: "auto-merge", repository: "example/release", prNumber: 7, policyChangedAt: at,
    reviewedHead: head, chain: [head], updates: [], seenChecks: [], head, headSeenAt: at, lastChecks: [], readAt: at,
    nextReadAt: null, requestedAt: at, mergedHead: state === "merged" ? head : null, mergeCommit: state === "merged" ? head : null,
    method: "squash", mergedAt: state === "merged" ? at : null, attempts: 1, reason: null, blockedAt: null, updatedAt: at };
}
function capture(sources: Partial<SeatTickSources>) {
  let ports!: runModule.ReleasePorts;
  const real = runModule.productionReleaseController;
  const spy = spyOn(runModule, "productionReleaseController").mockImplementation(value => { ports = value; return real(value); });
  try { return { controller: releaseControllerForSources(sources as SeatTickSources), get ports() { return ports; } }; }
  finally { spy.mockRestore(); }
}
function fixture() {
  const parent = lane("release-parent"), child = lane("refresh-child");
  for (const [row, epoch] of [[parent, 1], [child, 2]] as const) {
    row.delivery = { target: { repository: project, remote: "fixture", branch: "refs/heads/release", pr: 7 },
      disposition: "owner", publish: "enabled", active: false, ownerId: row.id, epoch, journal: [] };
  }
  parent.merge = { ...merge("refreshing"), refresh: { attempt: 1, base: head, head, key: "refresh", digest: "d", requestedAt: at, pipelineId: child.id } };
  child.refreshOf = { pipelineId: parent.id, base: head }; child.merge = merge("merged");
  const rows = [parent, child];
  const sources = { now: () => Date.parse(at), pipelines: () => rows, archivedPipelines: () => [], settings: () => defaultSeatTickSettings(project) };
  const adapter = capture(sources);
  const requests: CreatePipelineRequest[] = [];
  adapter.ports.settings = () => ({ enabled: true, askBeforePublish: true, minChanges: 30, minGapHours: 12,
    updatedAt: at, setBy: { kind: "gateway", project, conversationId: null, seatEpoch: null }, why: null });
  adapter.ports.observe = async () => ({ policy: { ...ready(), mainVersion: "1.1.0", deployments: [{ revision: brief.cut, at: 0 }] }, repoDir: process.cwd(), src: "seat" });
  adapter.ports.create = async request => { requests.push(request); return "publisher"; };
  mutateReleaseProject(project, row => ({ ...row, live: { key: "release-key", cut: brief.cut, lastTag: brief.lastTag,
    trigger: "amount", startedAt: 0, taskId: "task", pipelineId: parent.id,
    request: { task: parent.task, repoDir: parent.repoDir, src: "seat", baseBranch: "main", publication: "remote-branch", stages: releaseStages(brief) } } }));
  return { parent, child, rows, sources, ...adapter, requests };
}

test("a release follows its merged refresh delivery owner", async () => {
  const h = fixture();
  await sweepAutoMerge({ now: () => Date.parse(at), loadPipelines: () => h.rows,
    mutate: async (id, change) => change(h.rows.find(row => row.id === id)!),
    setting: () => ({ enabled: true, changedAt: at, changedBy: "fixture" }),
    pullRequestOf: () => ({ repository: "example/release", number: 7 }), cachedState: () => "merged",
    run: async () => { throw Error("unexpected forge read"); }, write: async () => { throw Error("unexpected write"); },
  } as AutoMergePorts);
  expect(h.parent.merge!.state).toBe("cancelled");
  expect(h.child.merge!.state).toBe("merged");
  await h.controller.reconcile(project);
  expect(readReleaseProject(project).live).toMatchObject({ phase: "publish", pipelineId: "publisher" });
  expect(h.requests).toHaveLength(1);
  expect(h.requests[0].baseRef).toBe(head);
});

test("a closed preparation follows a merged successor delivery owner", async () => {
  const h = fixture();
  h.parent.state = "closed";
  await h.controller.reconcile(project);
  expect(readReleaseProject(project).live).toMatchObject({ phase: "publish", pipelineId: "publisher" });
  expect(h.requests[0].baseRef).toBe(head);
});

test.each(["open", "different-pr", "different-target", "different-project", "comparison", "wrong-owner", "same-epoch", "closed", "no-merge", "missing-commit"])(
  "%s successor cannot authorize publication", async barrier => {
    const h = fixture();
    if (barrier === "open") h.child.merge = merge("waiting-checks");
    if (barrier === "different-pr") { h.child.delivery!.target.pr = 8; h.child.merge!.prNumber = 8; }
    if (barrier === "different-target") { h.child.delivery!.target.repository = "other"; h.child.merge!.repository = "example/other"; }
    if (barrier === "different-project") h.child.project = "other";
    if (barrier === "comparison") h.child.delivery!.disposition = "comparison";
    if (barrier === "wrong-owner") h.child.delivery!.ownerId = "other";
    if (barrier === "same-epoch") h.child.delivery!.epoch = 1;
    if (barrier === "closed") h.child.state = "closed";
    if (barrier === "no-merge") h.child.merge = undefined;
    if (barrier === "missing-commit") h.child.merge!.mergeCommit = null;
    await h.controller.reconcile(project);
    expect(h.requests).toEqual([]);
    expect(readReleaseProject(project).live?.phase).toBeUndefined();
  });

// Retain the reviewer's real adapter observation, with local CLI/registry fixtures.
async function observe(rows: Pipeline[], archived: Pipeline[] = [], versionAhead = false, pullRequests: unknown[] = [], boundary: string | null = null, frozenCut?: string, releaseEnabled = false, realGit = false) {
  const bin = path.join(directory, "bin"); fs.mkdirSync(bin, { recursive: true });
  const gitLogFile = path.join(directory, "git-log.jsonl");
  const priorPath = process.env.PATH, priorFetch = globalThis.fetch;
  let archiveReads = 0;
  const script = `#!${process.execPath}\nconst tool=process.argv[1].split('/').at(-1),a=process.argv.slice(2);let out='';
if(tool==='git'){if(a[0]==='ls-remote')out='${"a".repeat(40)}\\trefs/tags/v1.0.0';else if(a[0]==='for-each-ref')out='1793318400';else if(a[0]==='rev-parse'&&a[1]==='refs/tags/v1.0.0')out='${"a".repeat(40)}';else if(a[0]==='rev-parse')out='${head}';else if(a[0]==='cat-file')out='object ${head}\\ntype commit\\ntag v1.0.0\\n\\nDelegatus 1.0.0${boundary ? `\\n\\nRelease-Cut: ${boundary}` : ""}';else if(a[0]==='ls-tree')out='package.json';else if(a[0]==='show')out=JSON.stringify({name:'package-example',version:'${versionAhead ? "1.1.0" : "1.0.0"}'});else if(a[0]==='log'){require('fs').appendFileSync(${JSON.stringify(gitLogFile)},JSON.stringify(a)+'\\n');out='${"f".repeat(40)} eligible change (#41)';}else if(a[0]==='diff')out='src/eligible.ts';}
if(tool==='gh'){if(a[0]==='repo')out='example/release';else if(a[0]==='pr'&&a[1]==='list')out=${JSON.stringify(JSON.stringify(pullRequests))};else if(a[1]?.includes('/branches/'))out=JSON.stringify({protection:{required_status_checks:{contexts:[]}}});else if(a[1]?.includes('/check-runs'))out=JSON.stringify({check_runs:[]});else out=JSON.stringify({statuses:[]});}
if(tool==='bun')out=JSON.stringify({missing:[],chrome:'/fixture/chrome'});console.log(out);`;
  for (const name of realGit ? ["gh", "bun"] : ["git", "gh", "bun"]) fs.writeFileSync(path.join(bin, name), script, { mode: 0o700 });
  const withForge = async <T>(work: () => Promise<T>) => {
    process.env.PATH = bin + path.delimiter + priorPath;
    globalThis.fetch = (async () => new Response(JSON.stringify({ version: "1.0.0" }), { status: 200 })) as unknown as typeof fetch;
    try { return await work(); }
    finally { process.env.PATH = priorPath; globalThis.fetch = priorFetch; }
  };
  return withForge(async () => {
    const settings = { ...defaultSeatTickSettings(project), release: { ...RELEASE_DEFAULTS, enabled: releaseEnabled } };
    const adapter = capture({ now: () => Date.parse(at), pipelines: () => rows, archivedPipelines: () => { archiveReads++; return archived; },
      settings: () => settings, seatFor: () => ({ active: { conversationId: "seat" } }),
      registry: () => ({ conversation: () => ({ generations: [{ path: "fixture-seat" }] }) }),
    } as unknown as Partial<SeatTickSources>);
    const productionObserve = adapter.ports.observe;
    const observed = await productionObserve(project, frozenCut);
    if (!observed) throw new Error("fixture release is inapplicable");
    return { ...observed, ports: adapter.ports, controller: adapter.controller, productionObserve, withForge, archiveReads,
      gitLogs: fs.existsSync(gitLogFile) ? fs.readFileSync(gitLogFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [] };
  });
}
test("a successful publish lane ceases to block future releases", async () => {
  const { policy, archiveReads } = await observe([lane("completed-publish", true)], Array.from({ length: 256 }, (_, i) => lane(`cold-${i}`)));
  expect(policy.live).toBe(false);
  expect(archiveReads).toBe(0);
  expect(await releaseState({ ...ready(), live: policy.live })).toMatchObject({ state: "due" });
});
test("production observation reports a version mismatch when only a local tag remains and no publisher is live", async () => {
  const publisher = lane("closed-publisher-observation", true);
  publisher.state = "closed";
  const { policy } = await observe([publisher], [], true);
  expect(policy.live).toBe(false);
  expect(policy).toMatchObject({ lastTag: { name: "v1.0.0", version: "1.0.0" }, mainVersion: "1.1.0" });
  expect(await releaseState({ ...ready(), mainVersion: policy.mainVersion, lastTag: policy.lastTag,
    registryHasTag: policy.registryHasTag })).toMatchObject({ state: "blocked", blocker: 11, reason: "release-version-mismatch" });
});
test("a cancelled completed preparation reports the version mismatch without reading cold lanes", async () => {
  const preparation = lane("cancelled-preparation");
  preparation.merge = merge("cancelled");
  preparation.delivery = { target: { repository: project, remote: "fixture", branch: "refs/heads/release", pr: 7 },
    disposition: "owner", publish: "enabled", active: false, ownerId: preparation.id, epoch: 1, journal: [] };
  const { policy } = await observe([preparation], Array.from({ length: 256 }, (_, i) => lane("cold-cancelled-" + i)), true);
  expect(policy.live).toBe(false);
  expect(await releaseState({ ...ready(), live: policy.live, mainVersion: policy.mainVersion, lastTag: policy.lastTag }))
    .toMatchObject({ state: "blocked", blocker: 11, reason: "release-version-mismatch" });
});
test("a completed preparation stopped by a closed PR is terminal for the live guard", async () => {
  const preparation = lane("closed-pr-preparation");
  preparation.merge = { ...merge("blocked"), reason: "the PR was closed" };
  preparation.delivery = { target: { repository: project, remote: "fixture", branch: "refs/heads/release", pr: 7 },
    disposition: "owner", publish: "enabled", active: false, ownerId: preparation.id, epoch: 1, journal: [] };
  const { policy } = await observe([preparation], [], true);
  expect(policy.live).toBe(false);
  expect(await releaseState({ ...ready(), live: policy.live, mainVersion: policy.mainVersion, lastTag: policy.lastTag }))
    .toMatchObject({ state: "blocked", blocker: 11, reason: "release-version-mismatch" });
});
test("production observation carries the prior Release-Cut into the generated changelog Git range", async () => {
  const repository = lane("boundary-observation-repository"); repository.task = "Maintenance lane"; repository.stages = [];
  const boundary = "d".repeat(40), cut = "e".repeat(40);
  const result = await observe([repository], [], false, [], boundary, cut);
  expect(result.policy.lastTag.boundary).toBe(boundary);
  expect(result.policy.changes).toEqual([{ subject: "eligible change (#41)", files: ["src/eligible.ts"] }]);
  expect(result.gitLogs[0]).toContain(`${boundary}..${cut}`);
});
test("a completed release-titled lane without release stages does not hold the in-flight guard", async () => {
  const manual = lane("manual-release-successor");
  manual.task = "Реліз 2.3.0: changelog correction";
  manual.stages = [];
  const { policy } = await observe([manual], [], true);
  expect(policy.live).toBe(false);
  expect(await releaseState({ ...ready(), live: policy.live, mainVersion: policy.mainVersion, lastTag: policy.lastTag }))
    .toMatchObject({ state: "blocked", blocker: 11, reason: "release-version-mismatch" });
});
test("production recovery retains all merged Release version PR candidates for proof", async () => {
  const commit = "c".repeat(40);
  const valid = { title: "Release 1.1.0", number: 23, baseRefName: "main", mergedAt: at, mergeCommit: { oid: commit } };
  const read = async (rows: unknown[]) => mergedReleasePullRequests("example/release", "1.1.0", head,
    async (...args) => args[0] === "show" ? JSON.stringify({ name: "package-example", version: "1.1.0" }) : "package.json",
    async () => JSON.stringify(rows));
  expect(await read([valid])).toEqual([{ commit, pr: 23, head: undefined, branch: undefined, body: undefined, sameRepository: false }]);
  expect(await read([{ ...valid, title: "Release 1.1.1" }])).toEqual([]);
  expect(await read([valid, { ...valid, number: 24 }])).toHaveLength(2);
});

test("production observer and controller recover the closed preparation at its recorded cut despite newer deployments", async () => {
  const preparation = lane("recovered-preparation");
  const commit = "c".repeat(40);
  preparation.merge = { ...merge("merged"), prNumber: 23, mergeCommit: commit };
  preparation.delivery = { target: { repository: project, remote: "fixture", branch: "refs/heads/release", pr: 23 },
    disposition: "owner", publish: "enabled", active: false, ownerId: preparation.id, epoch: 1, journal: [] };
  const oldCut = brief.cut, newerCut = "f".repeat(40);
  mutateReleaseProject(project, row => ({ ...row, request: { at, by: { kind: "gateway", project, conversationId: null, seatEpoch: null }, why: null },
    history: [{ key: "release-key", cut: oldCut, lastTag: "v1.0.0", trigger: "amount", startedAt: Date.parse(at), taskId: "release-task",
      pipelineId: preparation.id, request: { task: preparation.task, repoDir: process.cwd(), baseRef: oldCut, stages: releaseStages(brief) } as never,
      outcome: "failed", at: Date.parse(at), reason: "release-merge-stopped: the PR was closed" }] }));
  const pullRequest = { title: "Release 1.1.0", number: 23, baseRefName: "main", mergedAt: at, mergeCommit: { oid: commit } };
  const result = await observe([preparation], [], true, [pullRequest], null, undefined, true);
  expect(result.recovery).toEqual({ commit, pr: 23, cut: oldCut });
  result.ports.settings = () => ({ enabled: true, askBeforePublish: true, minChanges: 30, minGapHours: 12,
    updatedAt: at, setBy: { kind: "gateway", project, conversationId: null, seatEpoch: null }, why: null });
  const observedRecovery: unknown[] = [];
  result.ports.observe = async (...args) => {
    const observed = await result.productionObserve(...args);
    observedRecovery.push(observed?.recovery ?? null);
    return observed && { ...observed, policy: { ...observed.policy, enabled: true, tickEnabled: true, mergeEnabled: true,
      checks: "green", tools: [],
      deployments: [{ revision: oldCut, at: Date.parse(at) - 8 * 3_600_000 }, { revision: newerCut, at: Date.parse(at) - 7 * 3_600_000 }],
      isAncestor: async (ancestor: string, descendant: string) => ancestor === descendant || ancestor === oldCut && descendant === newerCut } };
  };
  const admitted: CreatePipelineRequest[] = [];
  result.ports.task = () => "recovery-task";
  result.ports.taskDone = () => false;
  result.ports.create = async request => { admitted.push(request); return "recovery-publisher"; };
  const input = { project, seat: { conversationId: "seat", seatEpoch: 1 },
    settings: effectiveSeatTickSettings(defaultSeatTickSettings(project), Date.parse(at), 60_000) } as never;
  const launch = await result.withForge(() => result.controller.launchIfDue(input));
  if (launch !== "release: launched") throw new Error(`${launch}: ${JSON.stringify(observedRecovery)}`);
  expect(admitted).toHaveLength(1);
  expect(admitted[0]).toMatchObject({ baseRef: commit });
  const publishRequest = JSON.stringify(admitted[0]);
  expect(publishRequest).toContain(oldCut);
  expect(publishRequest).not.toContain(newerCut);
  expect(readReleaseProject(project).live).toMatchObject({ cut: oldCut, pipelineId: "recovery-publisher", phase: "publish" });
});

async function forgeRecovery(scenario: string) {
  const repoDir = path.join(directory, "repo");
  fs.mkdirSync(repoDir);
  const git = async (...args: string[]) => (await promisify(execFile)("git", args, { cwd: repoDir, env: {
    ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at,
  } })).stdout.trim();
  const write = (file: string, content: string) => fs.writeFileSync(path.join(repoDir, file), content);
  const commit = async (message: string) => {
    await git("add", ".");
    await git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  };
  await git("init", "-b", "main");
  await git("config", "user.name", "Release Fixture");
  await git("config", "user.email", ["noreply", "example.invalid"].join("@"));
  await git("remote", "add", "origin", ".");
  write("package.json", '{"name":"package-example","version":"1.0.0"}\n');
  const cut = await commit("Frozen cut");
  await git("tag", "v1.0.0");
  await git("checkout", "-b", "release");
  write("CHANGELOG.md", "Reviewed release notes\n");
  let reviewed: string;
  if (scenario === "rebase-range" || scenario === "rebase-range-mismatch") {
    await commit("Reviewed changelog");
    write("package.json", '{"name":"package-example","version":"1.1.0"}\n');
    reviewed = await commit("Reviewed version bump");
  } else {
    write("package.json", '{"name":"package-example","version":"1.1.0"}\n');
    reviewed = await commit("Reviewed release");
  }
  await git("checkout", "main");
  write("product.txt", "Later product change\n");
  const companion = await commit("Companion from the batch");
  await git("checkout", "release");
  if (scenario === "exact" || scenario === "rebase-range" || scenario === "rebase-range-mismatch") await git("rebase", "main");
  else await git("merge", "--no-edit", "main");
  if (scenario === "rebase-range-mismatch") {
    write("extra-release.txt", "Unreviewed member\n");
    await commit("Unreviewed landing member");
  }
  if (scenario === "moved-head" || scenario === "moved-head-outside-receipt") {
    write("CHANGELOG.md", "Unreviewed release notes\n");
    await commit("Unreviewed PR update");
  }
  const forgeHead = await git("rev-parse", "HEAD");
  await git("checkout", "main");
  await git("merge", ...(["exact", "rebase-range", "rebase-range-mismatch"].includes(scenario) ? ["--ff-only"] : ["--squash"]), "release");
  if (scenario === "changed-landing" || scenario === "blocked-mismatch") write("CHANGELOG.md", "Unreviewed release notes\n");
  const integrated = ["exact", "rebase-range", "rebase-range-mismatch"].includes(scenario)
    ? forgeHead : await commit("Land the release patch from the batch");

  const preparation = lane("forge-preparation");
  const reviewedHead = scenario === "exact" ? forgeHead : reviewed;
  Object.assign(preparation, { repoDir, baseRef: cut, lastPassedCommit: reviewedHead, publishedCommit: reviewedHead });
  preparation.runs = [{ stageId: "review", attempts: [{
    state: scenario === "unreviewed-preparation" ? "failed" : "passed", reviewHeadSha: reviewedHead,
  } as Pipeline["runs"][number]["attempts"][number]] }];
  preparation.delivery = { target: { repository: project, remote: "https://github.com/example/release.git", branch: "refs/heads/release" },
    disposition: "owner", publish: "enabled", active: false, ownerId: preparation.id, epoch: 1, journal: [] };
  if (scenario === "wrong-repository") preparation.delivery.target.remote = "https://github.com/example/other.git";
  if (scenario === "wrong-number") preparation.delivery.target.pr = 24;
  if (scenario === "blocked-mismatch") {
    preparation.merge = { ...merge("blocked"), prNumber: 23, reviewedHead: reviewed, reason: "the PR was closed" };
  }
  if (scenario === "moved-head-outside-receipt") preparation.merge = { ...merge("merged"), by: "outside", prNumber: 23,
    repository: "example/release", mergeCommit: integrated };
  if (scenario === "closed-reviewed") preparation.state = "closed";
  const archived = [];
  if (scenario === "successor" || scenario === "foreign-successor" || scenario === "stale-successor") {
    preparation.state = "closed";
    preparation.lastPassedCommit = cut;
    preparation.publishedCommit = cut;
    preparation.runs = [];
    const successor = lane("forge-fix");
    Object.assign(successor, { repoDir, baseRef: cut, lastPassedCommit: reviewed, publishedCommit: reviewed,
      stages: preparation.stages.filter(stage => stage.id === "fix") });
    successor.delivery = { ...preparation.delivery, target: { ...preparation.delivery.target, pr: 23 },
      ownerId: successor.id, epoch: scenario === "stale-successor" ? 1 : 2 };
    if (scenario === "foreign-successor") successor.project = "another-project";
    archived.push(successor);
  }
  mutateReleaseProject(project, row => ({ ...row, history: [{
    key: "forge-release", cut, lastTag: "v1.0.0", trigger: "amount", startedAt: Date.parse(at),
    taskId: "release-task", pipelineId: preparation.id, request: null, outcome: "failed", at: Date.parse(at),
  }] }));
  const body = scenario === "wrong-cut" ? `Release-Cut: ${companion}`
    : scenario === "missing-cut" ? "Release notes"
    : scenario === "conflicting-cut" ? `Release-Cut: ${cut}\nRelease-Cut: ${companion}`
    : scenario === "successor" ? `Changelog up to production cut ${cut.slice(0, 10)}, with refreshed README pictures.`
    : `Release-Cut: ${cut}`;
  const pr = { title: "Release 1.1.0", number: 23, baseRefName: "main", mergedAt: at,
    mergeCommit: { oid: integrated }, headRefName: scenario === "wrong-branch" ? "another-release" : "release",
    headRefOid: forgeHead, isCrossRepository: scenario === "fork", body };
  let unrelated = null;
  if (scenario === "same-title") {
    write("README.md", "Unrelated follow-up\n");
    const unrelatedCommit = await commit("Unrelated README change");
    unrelated = { ...pr, number: 24, mergeCommit: { oid: unrelatedCommit },
      headRefName: "unrelated-readme", headRefOid: unrelatedCommit, body: "An unrelated merged PR" };
  }
  return { preparation, archived, pr, pullRequests: unrelated ? [pr, unrelated] : [pr], integrated, cut };
}

test.each(["batch", "exact", "rebase-range", "same-title", "closed-reviewed", "successor"])("the %s forge landing recovers a release without a pipeline merge receipt", async scenario => {
  const h = await forgeRecovery(scenario);
  const result = await observe([h.preparation], h.archived, true, h.pullRequests, null, undefined, true, true);
  expect(result.recovery).toEqual({ commit: h.integrated, pr: 23, cut: h.cut });
  expect(result.policy.live).toBe(false);
});

test.each(["changed-landing", "blocked-mismatch", "moved-head", "moved-head-outside-receipt", "rebase-range-mismatch", "unreviewed-preparation", "wrong-cut", "missing-cut", "conflicting-cut",
  "wrong-branch", "wrong-repository", "wrong-number", "fork", "foreign-successor", "stale-successor"])(
  "%s cannot supply release merge proof", async scenario => {
    const h = await forgeRecovery(scenario);
    const result = await observe([h.preparation], h.archived, true, h.pullRequests, null, undefined, true, true);
    expect(result.recovery).toEqual({ commit: h.integrated, pr: 23, cut: null });
  });

test.each(["batch", "changed-landing", "proof-withdrawn"])("a live preparation hands off only proven %s content", async scenario => {
  const h = await forgeRecovery(scenario);
  mutateReleaseProject(project, row => ({
    ...row, history: [], live: { ...row.history[0], request: {
      task: h.preparation.task, repoDir: h.preparation.repoDir, src: "seat", baseBranch: "main", baseRef: h.cut,
      stages: releaseStages({ ...brief, cut: h.cut }),
    } },
  }));
  const result = await observe([h.preparation], [], true, [h.pr], null, undefined, true, true);
  let observations = 0;
  result.ports.observe = async (...args) => {
    const observed = await result.productionObserve(...args);
    const withdrawProof = ++observations === 2 && scenario === "proof-withdrawn";
    return observed && { ...observed, ...(withdrawProof ? { recovery: null } : {}),
      policy: { ...observed.policy, tickEnabled: true, mergeEnabled: true,
      deployments: [{ revision: h.cut, at: Date.parse(at) - 8 * 3_600_000 }] } };
  };
  const admitted: CreatePipelineRequest[] = [];
  result.ports.create = async request => { admitted.push(request); return "forge-publisher"; };
  const reconciled = await result.withForge(() => result.controller.reconcile(project));
  if (scenario === "batch") {
    expect(reconciled).toBe("release: launched");
    expect(admitted).toHaveLength(1);
    expect(admitted[0]).toMatchObject({ baseRef: h.integrated });
    expect(admitted[0].stages.map(stage => stage.id)).toEqual(["review", "publish"]);
    expect(admitted[0].stages.at(-1)?.role?.params).toEqual({ sha: h.integrated, mode: "release" });
    expect(readReleaseProject(project).live).toMatchObject({ cut: h.cut, pipelineId: "forge-publisher", phase: "publish" });
  } else if (scenario === "proof-withdrawn") {
    expect(reconciled).toBe("release: recovery-candidate-changed");
    expect(admitted).toEqual([]);
    expect(readReleaseProject(project).live).toBeNull();
    expect(readReleaseProject(project).history.at(-1)?.reason).toBe("release-recovery-evidence-changed");
  } else {
    expect(reconciled).toBeNull();
    expect(admitted).toEqual([]);
    expect(readReleaseProject(project).live?.pipelineId).toBe(h.preparation.id);
  }
});

test("a completed merged preparation needs no archived successor lookup", async () => {
  const preparation = lane("completed-merged-preparation");
  preparation.merge = merge("merged");
  preparation.delivery = { target: { repository: project, remote: "fixture", branch: "refs/heads/release", pr: 7 },
    disposition: "owner", publish: "enabled", active: false, ownerId: preparation.id, epoch: 1, journal: [] };
  const { policy, archiveReads } = await observe([preparation], Array.from({ length: 256 }, (_, i) => lane(`cold-${i}`)));
  expect(policy.live).toBe(false);
  expect(archiveReads).toBe(0);
});
test.each(["running", "needs_decision", "preparing", "legacy"])("%s release still blocks another release", async state => {
  const row = lane("blocking", state !== "preparing");
  if (state === "running" || state === "needs_decision") row.state = state;
  if (state === "legacy") row.stages.unshift(lane("prepare").stages[0]);
  const { policy } = await observe([row]);
  expect(policy.live).toBe(true);
  expect(await releaseState({ ...ready(), requested: true, live: policy.live })).toMatchObject({ reason: "release-in-flight" });
});
test.each([false, true])("merged successor is excluded from in-flight, archived=%s", async archived => {
  const h = fixture();
  const observed = await observe(archived ? [h.parent] : h.rows, archived ? [h.child] : []);
  expect(observed.policy.live).toBe(false);
  expect(observed.archiveReads).toBe(1);
  h.child.merge = merge("waiting-checks");
  expect((await observe(h.rows)).policy.live).toBe(true);
});

test("a lost successor handoff receipt recovers one real publish lane across process restarts", async () => {
  const h = fixture();
  const fixturePath = path.join(directory, "lanes.json");
  fs.writeFileSync(fixturePath, JSON.stringify(h.rows));
  const script = `
    const fs = await import("node:fs");
    const rows = JSON.parse(fs.readFileSync(${JSON.stringify(fixturePath)}, "utf8"));
    const {spyOn} = await import("bun:test");
    const run = await import(${JSON.stringify(new URL("./run.ts", import.meta.url).href)});
    const {releaseControllerForSources, createReleasePipeline} = await import(${JSON.stringify(new URL("./production.ts", import.meta.url).href)});
    const {createPipelineFromRequest} = await import(${JSON.stringify(new URL("../pipelines/engine.ts", import.meta.url).href)});
    const {pipelineRoleLookup} = await import(${JSON.stringify(new URL("../pipelines/roles.ts", import.meta.url).href)});
    const {loadPipelines} = await import(${JSON.stringify(new URL("../pipelines/store.ts", import.meta.url).href)});
    const {readReleaseProject} = await import(${JSON.stringify(new URL("./store.ts", import.meta.url).href)});
    const project = ${JSON.stringify(project)}, at = ${JSON.stringify(at)};
    let ports;
    const real = run.productionReleaseController;
    const spy = spyOn(run, "productionReleaseController").mockImplementation(value => {ports=value; return real(value);});
    const controller = releaseControllerForSources({now:()=>Date.parse(at), settings:()=>({release:{enabled:true,askBeforePublish:true}}),
      pipelines:()=>[...rows, ...loadPipelines()], archivedPipelines:()=>[]});
    spy.mockRestore();
    ports.observe = async()=>({policy:{...${JSON.stringify({ ...ready(), mainVersion: "1.1.0", deployments: [{ revision: brief.cut, at: 0 }] })},isAncestor:()=>true},repoDir:process.cwd(),src:"seat"});
    const enginePorts = {roleLookup:pipelineRoleLookup,projectForCwd:()=>project,sourcePathAllowed:()=>true,conversationIdForPath:()=>"creator",now:()=>at,
      preflightRepo:async()=>({ok:true,repoDir:process.cwd(),gitCommonDir:process.cwd()+"/.git",worktreeParent:process.cwd()}),
      exec:async(_file,args)=>{
        if(args.length===1&&args[0]==="remote")return {code:0,stdout:"origin\\n",stderr:""};
        if(args[0]==="-c"&&args[2]==="remote"&&args[3]==="-v"){
          const probe=/^remote\\.([^=]+)\\.url=(.*)$/.exec(args[1]);
          if(probe)return {code:0,stdout:probe[1]+"\\t"+probe[2]+" (fetch)\\n"+probe[1]+"\\t"+probe[2]+" (push)\\n",stderr:""};
        }
        return {code:0,stdout:args[0]==="rev-parse"?${JSON.stringify(head)}:process.cwd()+"/fixture.git",stderr:""};
      }};
    let creates=0,error=null;
    ports.create=async(request,key)=>{creates++;const id=await createReleasePipeline(request,key,(req,_p,options)=>createPipelineFromRequest(req,enginePorts,options));
      if(process.argv[2]==="lose")throw new Error("lost receipt");return id;};
    try{await controller.reconcile(project);}catch(e){error=e.message;}
    console.log(JSON.stringify({error,creates,row:readReleaseProject(project),lanes:loadPipelines().map(p=>({id:p.id,baseRef:p.baseRef,creationRequest:p.creationRequest}))}));
  `;
  const scriptPath = path.join(directory, "restart.ts");
  fs.writeFileSync(scriptPath, script);
  const restart = async (mode: string) => {
    const child = await promisify(execFile)(process.execPath, [scriptPath, mode], { env: { ...process.env }, timeout: 30_000 });
    const result = child.stdout.trim().split(/\r?\n/).at(-1) ?? "";
    try { return JSON.parse(result); }
    catch { throw new Error(`release child returned invalid JSON: ${child.stdout.slice(0, 500)} ${child.stderr.slice(0, 500)}`); }
  };
  const lost = await restart("lose");
  expect(lost.error).toBe("lost receipt");
  expect(lost.creates).toBe(1);
  expect(lost.lanes).toHaveLength(1);
  expect(lost.row.live).toMatchObject({ phase: "publish", pipelineId: null });
  for (const mode of ["recover", "again"]) {
    const next = await restart(mode);
    expect(next.error).toBeNull(); expect(next.creates).toBe(0);
    expect(next.lanes).toEqual(lost.lanes);
    expect(next.lanes[0]).toMatchObject({ baseRef: head, creationRequest: { key: "release-key:publish" } });
    expect(next.row.live).toMatchObject({ phase: "publish", pipelineId: lost.lanes[0].id });
  }
});
