import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CreatePipelineRequest, Pipeline, PipelineMerge } from "@/lib/pipelines/types";
import type { PullRequestState } from "./workLinks";
import type { RefreshOptions } from "./autoRefresh";
import type { MergeOnReviewSetting } from "@/lib/projects/settings";

/* The merge runner (#2187 §4.3-§4.4) against a fake `gh` and clock: invented
   repositories, heads and checks, no network. The stores resolve their state
   directory at import, so a sandbox is pinned before the first store read. */
const sandbox = process.env.REFRESH_LIFECYCLE_STATE ?? fs.mkdtempSync(path.join(os.tmpdir(), "llv-auto-refresh-"));
fs.mkdirSync(sandbox, { recursive: true });
const previousStateDir = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = sandbox;

const {
  MERGE_POLL_MS, MERGE_SETTLE_MS, MERGE_WAIT_LIMIT_MS, MERGE_REASONS, lanePullRequest, resetAutoMergeForTests, sweepAutoMerge, sweepTaskFinishes,
} = await import("./autoMerge");
const { ForgeAppWriteRefused } = await import("./appWrite");

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  if (!process.env.REFRESH_LIFECYCLE_STATE) fs.rmSync(sandbox, { recursive: true, force: true });
});

const REPO = "acme/widgets";
const T0 = Date.parse("2026-09-25T10:00:00Z");
const HEAD_A = "a".repeat(40);
const MAIN_1 = "1".repeat(40);
const MAIN_2 = "2".repeat(40);
const iso = (ms: number) => new Date(ms).toISOString();

const BUILDER = { engine: "claude", model: null, effort: null, roleId: null, access: "read-write", promptScaffold: null };
const REVIEWER = { ...BUILDER, access: "read-only" };

type Attempt = { n: number; state: string; budgetSpent?: boolean; activatedBy?: unknown };

function lane(id: string, extra: { closedAt?: number; reviews?: Attempt[]; builds?: Attempt[]; stages?: unknown[]; acceptances?: unknown[]; head?: string } = {}): Pipeline {
  return {
    id,
    project: "repo-fixture",
    task: `lane ${id}`,
    taskIds: [],
    state: "completed",
    closedAt: iso(extra.closedAt ?? T0 - 1_000),
    hiddenAt: null,
    createdAt: iso(T0 - 3_600_000),
    lastPassedCommit: extra.head ?? HEAD_A,
    stages: extra.stages ?? [
      { id: "build", kind: "run", prompt: "build", next: "review", onFail: null, effectiveRole: BUILDER },
      { id: "review", kind: "run", prompt: "review", next: null, onFail: { to: "build", maxRounds: 2 }, effectiveRole: REVIEWER },
    ],
    runs: [
      { stageId: "build", attempts: (extra.builds ?? [{ n: 1, state: "passed" }]).map((attempt) => ({ effectiveRole: BUILDER, ...attempt })) },
      { stageId: "review", attempts: (extra.reviews ?? [{ n: 1, state: "passed" }]).map((attempt) => ({ effectiveRole: REVIEWER, ...attempt })) },
    ],
    reviewAcceptances: extra.acceptances ?? [],
  } as unknown as Pipeline;
}

type Check = { name: string; status?: string; conclusion?: string; startedAt?: string };
type PullRequest = {
  number: number;
  state: string;
  head: string;
  base: string;
  mergeable: string | null;
  mergeStateStatus: string;
  checks: Check[];
  isDraft?: boolean;
  reviewDecision?: string;
};

const green = (name: string): Check => ({ name, status: "COMPLETED", conclusion: "SUCCESS" });
const red = (name: string): Check => ({ name, status: "COMPLETED", conclusion: "FAILURE" });

/** A fake GitHub: pull requests, commits, the base's required contexts, and
    strict-base changes and owned refresh delivery; GitHub updates are refused. */
function harness(options: { setting?: Partial<MergeOnReviewSetting>; required?: string[]; lanes: Pipeline[]; prs: PullRequest[]; tasks?: string[]; strict?: boolean; mergeBase?: string }) {
  let clock = T0;
  const calls: string[][] = [];
  const pipelines = new Map(options.lanes.map((pipeline) => [pipeline.id, structuredClone(pipeline)]));
  const prs = new Map(options.prs.map((pr) => [pr.number, pr]));
  const prOf = new Map(options.lanes.map((pipeline, index) => [pipeline.id, options.prs[index]!.number]));
  const commits = new Map<string, { parents: string[]; committer: string }>();
  const tasks = new Map((options.tasks ?? []).map((id) => [id, "assigned"]));
  let setting: MergeOnReviewSetting = { enabled: true, changedAt: iso(T0 - 3_600_000), changedBy: "operator", ...options.setting };
  let mergeRefusal: string | null = null;
  let baseTip = MAIN_1;
  let cached: PullRequestState | null = null;
  let createMode: "ok" | "throw" | "lost" | "refuse" = "ok";
  const creates: Array<{ request: unknown; options: unknown }> = [];
  const byKey = new Map([...pipelines.values()].filter(pipeline => pipeline.creationRequest)
    .map(pipeline => [pipeline.creationRequest!.key, pipeline]));
  const fail = (stderr: string) => Object.assign(new Error("Command failed: gh"), { stderr });

  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view") {
      const pr = prs.get(Number(args[2]))!;
      return JSON.stringify({
        state: pr.state,
        isDraft: pr.isDraft ?? false,
        headRefOid: pr.head,
        baseRefName: pr.base,
        mergeable: pr.mergeable,
        mergeStateStatus: pr.mergeStateStatus,
        reviewDecision: pr.reviewDecision ?? "",
        mergeCommit: pr.state === "MERGED" ? { oid: "f".repeat(40) } : null,
        mergedAt: pr.state === "MERGED" ? iso(clock) : null,
        statusCheckRollup: pr.checks.map((check) => ({
          __typename: "CheckRun",
          name: check.name,
          status: check.status ?? "COMPLETED",
          conclusion: check.conclusion ?? "SUCCESS",
          startedAt: check.startedAt ?? iso(T0),
          completedAt: "0001-01-01T00:00:00Z",
          workflowName: "ci",
        })),
      });
    }
    if (args[0] === "api" && /\/issues\/\d+\/comments/.test(args[1] ?? "")) return "";
    if (args[0] === "api" && /\/pulls\/\d+\/reviews/.test(args[1] ?? "")) return "";
    if (args[0] === "api" && args[1]?.startsWith(`repos/${REPO}/rules/branches/`)) return "[]";
    if (args[0] === "api" && args[1]?.startsWith(`repos/${REPO}/compare/`)) return options.mergeBase ?? baseTip;
    if (args[0] === "api" && args[1]?.startsWith(`repos/${REPO}/branches/`)) return args.at(-1) === ".commit.sha" ? baseTip : JSON.stringify(options.required ?? []);
    if (args[0] === "repo" && args[1] === "view") return JSON.stringify({ squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: true });
    if (args[0] === "api" && args[1] === "-X" && args[2] === "PUT") throw new Error("GitHub update-branch is forbidden");
    if (args[0] === "api" && args[1]?.startsWith(`repos/${REPO}/commits/`)) {
      const sha = args[1].split("/").at(-1)!;
      return JSON.stringify(commits.get(sha) ?? { parents: [], committer: "someone" });
    }
    if (args[0] === "pr" && args[1] === "merge") {
      const pr = prs.get(Number(args[2]))!;
      if (mergeRefusal) throw fail(mergeRefusal);
      const match = args[args.indexOf("--match-head-commit") + 1];
      if (match !== pr.head) throw fail("GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)");
      pr.state = "MERGED";
      if (options.strict) {
        baseTip = MAIN_2;
        for (const peer of prs.values()) if (peer.state === "OPEN") peer.mergeStateStatus = "BEHIND";
      }
      return "";
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };

  const writes: Array<{ args: string[]; repository: string }> = [];
  let writeRefusal: string | null = null;
  const ports = {
    now: () => clock,
    activeSeat: async () => ({ srcPath: null, srcConversationId: "seat-one" }),
    startRefresh: async (request: CreatePipelineRequest, options: RefreshOptions) => {
      creates.push({ request, options });
      if (createMode === "throw") throw new Error("store busy");
      if (createMode === "refuse") return { error: "target already owned", status: 409 };
      let refreshed = byKey.get(options.creationRequest.key);
      if (!refreshed) {
        refreshed = lane(`refresh-${byKey.size + 1}`);
        refreshed.state = "running";
        refreshed.taskIds = request.taskIds ?? [];
        refreshed.delivery = { ...structuredClone(optionsLaneDelivery), active: true, ownerId: refreshed.id,
          target: { ...optionsLaneDelivery.target, ...request.delivery, branch: request.delivery!.branch } };
        refreshed.refreshOf = { pipelineId: options.refreshOf.pipelineId, base: options.refreshOf.base };
        refreshed.creationRequest = structuredClone(options.creationRequest);
        refreshed.srcConversationId = options.refreshOf.lineage.srcConversationId;
        byKey.set(options.creationRequest.key, refreshed);
        pipelines.set(refreshed.id, refreshed);
      }
      if (createMode === "lost") throw new Error("answer lost");
      return { pipeline: structuredClone(refreshed) };
    },
    run,
    write: async (args: string[], repository: string) => {
      writes.push({ args, repository });
      if (writeRefusal) throw new ForgeAppWriteRefused(writeRefusal);
      return run(args);
    },
    loadPipelines: () => [...pipelines.values()].map((pipeline) => structuredClone(pipeline)),
    loadRefreshByKey: (key: string) => byKey.get(key) ?? null,
    mutate: async (id: string, change: (pipeline: Pipeline) => boolean) => {
      const pipeline = pipelines.get(id);
      if (!pipeline) return false;
      const draft = structuredClone(pipeline);
      if (!change(draft)) return false;
      pipelines.set(id, draft);
      return true;
    },
    setting: () => setting,
    pullRequestOf: (pipeline: Pipeline) => lanePullRequest(pipeline) ?? (prOf.has(pipeline.id) ? { repository: REPO, number: prOf.get(pipeline.id)! } : null),
    cachedState: () => cached,
    finishTask: (taskId: string) => {
      if (!tasks.has(taskId)) return "missing" as const;
      if (tasks.get(taskId) === "done") return "already-done" as const;
      tasks.set(taskId, "done");
      return "moved" as const;
    },
  };

  return {
    creates,
    byKey,
    ports,
    setCached: (value: PullRequestState | null) => { cached = value; },
    setBase: (value: string) => { baseTip = value; },
    setCreateMode: (value: typeof createMode) => { createMode = value; },
    add: (value: Pipeline) => { pipelines.set(value.id, value); },
    remove: (id: string) => { pipelines.delete(id); },
    calls,
    prs,
    commits,
    merge: (id: string): PipelineMerge | undefined => pipelines.get(id)?.merge,
    pipeline: (id: string) => pipelines.get(id)!,
    taskStatus: (id: string) => tasks.get(id),
    setSetting: (next: Partial<MergeOnReviewSetting>) => { setting = { ...setting, ...next }; },
    refuseMerges: (message: string) => { mergeRefusal = message; },
    /** Every call that went through the App write seam, and how to refuse them. */
    writes,
    refuseAppWrites: (message: string | null) => { writeRefusal = message; },
    merges: () => calls.filter((args) => args[0] === "pr" && args[1] === "merge"),
    updates: () => calls.filter((args) => args[0] === "api" && args[2] === "PUT"),
    sweep: async () => sweepAutoMerge(ports),
    sweepFinishes: async () => sweepTaskFinishes(ports),
    /** Sweeps once per poll interval until `until` (ms after now), or until `stop`. */
    async run(forMs: number, stop: () => boolean = () => false) {
      const end = clock + forMs;
      while (clock <= end) {
        await sweepAutoMerge(ports);
        if (stop()) return;
        clock += MERGE_POLL_MS;
      }
    },
    advance: (ms: number) => { clock += ms; },
    now: () => clock,
  };
}

const openPr = (number: number, extra: Partial<PullRequest> = {}): PullRequest => ({
  number, state: "OPEN", head: HEAD_A, base: "main", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", checks: [green("ci")], ...extra,
});


const optionsLaneDelivery = {
  target: { repository: "repo-fixture", remote: "https://github.com/acme/widgets.git", branch: "refs/heads/topic", pr: 11 },
  disposition: "owner" as const, publish: "disabled" as const, active: false, ownerId: "finished", epoch: 1, journal: [],
};
function finished() {
  const value = lane("finished");
  value.repoDir = "/fixture/repository";
  value.baseBranch = "main";
  value.taskIds = ["task-one"];
  value.finishesTaskIds = ["task-one"];
  value.delivery = structuredClone(optionsLaneDelivery);
  return value;
}
const conflicting = () => openPr(11, { mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" });
beforeEach(() => resetAutoMergeForTests());

test("a red non-required check behind main refreshes once without blocking", async () => {
  const h = harness({ required: ["ci"], mergeBase: MAIN_1, lanes: [finished()],
    prs: [openPr(11, { checks: [green("ci"), red("optional-audit")] })] });
  h.setBase(MAIN_2);
  await h.sweep();
  expect(h.merge("finished")).toMatchObject({ state: "refreshing", reason: null,
    refresh: { base: MAIN_2, head: HEAD_A, pipelineId: "refresh-1" } });
  expect(h.creates).toHaveLength(1);
  expect(h.calls).toContainEqual(["api", `repos/${REPO}/compare/${MAIN_2}...${HEAD_A}`, "--jq", ".merge_base_commit.sha"]);
  expect(h.writes).toEqual([]);

  const head = "b".repeat(40);
  Object.assign(h.pipeline("refresh-1"), { state: "completed", lastPassedCommit: head });
  h.pipeline("refresh-1").delivery!.active = false;
  Object.assign(h.prs.get(11)!, { head, checks: [] });
  await h.sweep();
  expect(h.merge("refresh-1")).toMatchObject({ state: "waiting-checks", head, headSeenAt: iso(h.now()) });
  expect(h.merges()).toEqual([]);
  h.prs.get(11)!.checks = [green("ci"), green("optional-audit")];
  await h.run(5 * MERGE_POLL_MS);
  expect(h.merges().map(args => args.at(-1))).toEqual([head]);
  expect(h.creates).toHaveLength(1);
});

test("a red check on a head containing current main keeps its failure reason", async () => {
  const h = harness({ lanes: [finished()], prs: [openPr(11, { checks: [red("optional-audit")] })] });
  await h.sweep();
  expect(h.merge("finished")).toMatchObject({ state: "blocked", reason: 'check "optional-audit" failed' });
  expect(h.creates).toEqual([]);
  expect(h.writes).toEqual([]);
});

test("a second evaluation of the same red head and main reuses the persisted refresh", async () => {
  if (process.env.REFRESH_RESTART_FIXTURE) {
    const stored = JSON.parse(fs.readFileSync(process.env.REFRESH_RESTART_FIXTURE, "utf8")) as { lanes: Pipeline[]; pr: PullRequest };
    const restarted = harness({ mergeBase: MAIN_1, lanes: stored.lanes, prs: stored.lanes.map(() => stored.pr) });
    restarted.setBase(MAIN_2);
    await restarted.run(10 * MERGE_POLL_MS);
    expect(restarted.merge("finished")!.refresh).toEqual(stored.lanes.find(lane => lane.id === "finished")!.merge!.refresh);
    expect(restarted.creates).toEqual([]);
    expect(restarted.writes).toEqual([]);
    return;
  }
  const h = harness({ mergeBase: MAIN_1, lanes: [finished()], prs: [openPr(11, { checks: [red("ci")] })] });
  h.setBase(MAIN_2);
  await h.sweep();
  const reservation = structuredClone(h.merge("finished")?.refresh);
  expect(reservation).toMatchObject({ base: MAIN_2, head: HEAD_A, pipelineId: "refresh-1" });
  resetAutoMergeForTests();
  await h.run(10 * MERGE_POLL_MS);
  expect(h.merge("finished")!.refresh).toEqual(reservation);
  expect(h.creates).toHaveLength(1);
  expect(h.writes).toEqual([]);
  const fixture = path.join(sandbox, "refresh-restart.json");
  fs.writeFileSync(fixture, JSON.stringify({ lanes: h.ports.loadPipelines(), pr: h.prs.get(11) }));
  const child = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern", "^a second evaluation of the same red head and main reuses the persisted refresh$"], {
    env: { ...process.env, REFRESH_RESTART_FIXTURE: fixture }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit, `${stdout}\n${stderr}`).toBe(0);
});

test("a green PR behind main merges under soft protection without refreshing", async () => {
  const h = harness({ required: ["ci"], mergeBase: MAIN_1, lanes: [finished()], prs: [openPr(11)] });
  h.setBase(MAIN_2);
  await h.run(5 * MERGE_POLL_MS);
  expect(h.merge("finished")).toMatchObject({ state: "merged", by: "auto-merge" });
  expect(h.creates).toEqual([]);
  expect(h.merges()).toHaveLength(1);
  expect(h.calls.some(args => args[1]?.includes("/compare/"))).toBe(false);
});

test.each(["retry", "archive"] as const)("the durable refresh bound survives %s and a process restart", async mode => {
  const name = `the durable refresh bound survives ${mode} and a process restart`;
  if (!process.env.REFRESH_LIFECYCLE_PHASE) {
    const root = path.join(sandbox, `lifecycle-${mode}`);
    for (const phase of ["prepare", "verify"]) {
      const child = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern", `^${name}$`], {
        env: { ...process.env, REFRESH_LIFECYCLE_PHASE: phase, REFRESH_LIFECYCLE_STATE: root },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exit, `${phase}: ${out}\n${err}`).toBe(0);
    }
    return;
  }
  const store = await import("@/lib/pipelines/store");
  const { productionAutoMergePorts } = await import("./autoMerge");
  const { mergeOnReviewSetting, setMergeOnReview } = await import("@/lib/projects/settings");
  const makeLane = (id: string) => {
    const source = finished();
    const value = store.buildPipeline({ id, task: "Refresh bound", project: source.project, repoDir: source.repoDir,
      stages: source.stages, srcPath: null, srcConversationId: null, now: iso(T0), state: "draft" });
    Object.assign(value, { state: "completed", cursor: null, closedAt: iso(T0), lastPassedCommit: HEAD_A,
      delivery: { ...structuredClone(optionsLaneDelivery), ownerId: id } });
    for (const run of value.runs) run.attempts = [{
      n: 1, state: "passed", effectiveRole: run.stageId === "review" ? REVIEWER : BUILDER,
      launchId: null, conversationId: null, sessionId: null, agentPath: null, paneId: null, flowId: null,
      startedAt: iso(T0), completedAt: iso(T0), output: null, verdict: { status: "pass" }, error: null,
    } as Pipeline["runs"][number]["attempts"][number]];
    return value;
  };
  const h = harness({ lanes: [finished()], mergeBase: MAIN_1,
    prs: [openPr(11, { checks: [green("ci"), red("optional-audit")] })] });
  h.setBase(MAIN_2);
  let starts = 0;
  const ports = productionAutoMergePorts({
    loadPipelines: store.loadPipelinesForList, now: () => T0, run: h.ports.run,
    setting: mergeOnReviewSetting, activeSeat: async () => null,
    write: async () => { throw new Error("unexpected forge write"); },
    startRefresh: async (_request, options) => {
      starts++;
      const child = makeLane(`child-${process.env.REFRESH_LIFECYCLE_PHASE}-${starts}`);
      child.state = "closed";
      child.creationRequest = options.creationRequest;
      child.refreshOf = { pipelineId: options.refreshOf.pipelineId, base: options.refreshOf.base };
      store.savePipelines([...store.loadPipelines(), child]);
      return { pipeline: child };
    },
  });
  if (process.env.REFRESH_LIFECYCLE_PHASE === "prepare") {
    setMergeOnReview("repo-fixture", true, "operator", iso(T0 - 3_600_000));
    store.savePipelines([makeLane("original")]);
    await sweepAutoMerge(ports);
    expect(starts).toBe(1);
    expect(store.loadPipelines().find(p => p.id === "original")!.merge!.refresh).toMatchObject({
      base: MAIN_2, head: HEAD_A, pipelineId: "child-prepare-1",
    });
    if (mode === "retry") {
      const { patchPipeline } = await import("@/lib/pipelines/engine");
      const retried = await patchPipeline("original", { action: "retry-merge" });
      expect("pipeline" in retried).toBe(true);
      expect(store.loadPipelines().find(p => p.id === "original")!.merge!.refresh).toBeUndefined();
    } else {
      expect(await store.archiveSettledPipelines(T0 + 4 * 24 * 60 * 60_000)).toBe(2);
      expect(store.loadPipelinesForList()).toHaveLength(0);
      store.savePipelines([makeLane("next")]);
    }
    return;
  }
  const carrier = mode === "retry" ? "original" : "next";
  await sweepAutoMerge(ports);
  expect(starts).toBe(0);
  expect(store.loadPipelines().find(p => p.id === carrier)!.merge).toMatchObject({
    state: "blocked", reason: 'check "optional-audit" failed',
  });
  // The same immutable child receipt must not consume a newer main's tuple.
  h.setBase("3".repeat(40));
  const { patchPipeline } = await import("@/lib/pipelines/engine");
  const retried = await patchPipeline(carrier, { action: "retry-merge" });
  expect("pipeline" in retried).toBe(true);
  await sweepAutoMerge(ports);
  expect(starts).toBe(1);
  expect(store.loadPipelines().find(p => p.id === carrier)!.merge!.refresh).toMatchObject({ base: "3".repeat(40), head: HEAD_A });
});

test("completed lanes on one PR share the refresh bound across a process restart", async () => {
  const verifyBound = async (h: ReturnType<typeof harness>, existingCreations: number) => {
    await h.run(10 * MERGE_POLL_MS);
    expect(h.creates).toHaveLength(existingCreations);
    expect(h.merge("second")).toMatchObject({ state: "blocked", reason: 'check "ci" failed' });
    expect(h.merge("second")!.refresh).toBeUndefined();
    expect(h.writes).toEqual([]);

    // Retry the stopped carrier after a genuinely new main revision arrives.
    h.setBase("3".repeat(40));
    Object.assign(h.merge("second")!, { state: "queued", attempts: 1, reason: null, blockedAt: null,
      readFailures: 0, nextReadAt: null, head: null, headSeenAt: null, lastChecks: null, updatedAt: iso(h.now()) });
    await h.sweep();
    expect(h.creates).toHaveLength(existingCreations + 1);
    expect(h.merge("second")).toMatchObject({ state: "refreshing", refresh: { base: "3".repeat(40), head: HEAD_A, pipelineId: "refresh-2" } });
    expect(h.writes).toEqual([]);
  };
  if (process.env.SHARED_REFRESH_RESTART_FIXTURE) {
    const stored = JSON.parse(fs.readFileSync(process.env.SHARED_REFRESH_RESTART_FIXTURE, "utf8")) as { lanes: Pipeline[]; pr: PullRequest };
    const h = harness({ mergeBase: MAIN_1, lanes: stored.lanes, prs: stored.lanes.map(() => stored.pr) });
    h.setBase(MAIN_2);
    await verifyBound(h, 0);
    return;
  }
  const second = finished();
  second.id = "second";
  second.delivery!.ownerId = second.id;
  const pr = conflicting();
  pr.checks = [red("ci")];
  const h = harness({ mergeBase: MAIN_1, lanes: [finished(), second], prs: [pr, pr] });
  h.setBase(MAIN_2);
  await h.sweep();
  expect(h.creates).toHaveLength(1);
  expect(h.merge("finished")!.refresh).toMatchObject({ base: MAIN_2, head: HEAD_A });
  h.pipeline("refresh-1").state = "completed";
  h.pipeline("refresh-1").delivery!.active = false;
  Object.assign(pr, { mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" });

  const fixture = path.join(sandbox, "shared-refresh-restart.json");
  fs.writeFileSync(fixture, JSON.stringify({ lanes: h.ports.loadPipelines(), pr }));
  const child = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern",
    "^completed lanes on one PR share the refresh bound across a process restart$"], {
    env: { ...process.env, SHARED_REFRESH_RESTART_FIXTURE: fixture }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit, `${stdout}\n${stderr}`).toBe(0);
  resetAutoMergeForTests();
  await verifyBound(h, 1);
});

test.each(["same", "repository", "PR", "head", "base"] as const)("an immutable refresh receipt distinguishes the %s tuple", async difference => {
  const h = harness({ mergeBase: MAIN_1, lanes: [finished()], prs: [conflicting()] });
  h.setBase(MAIN_2);
  await h.sweep();
  expect(h.creates).toHaveLength(1);
  for (const id of ["finished", "refresh-1"]) {
    Object.assign(h.pipeline(id), { state: "closed", hiddenAt: iso(T0) });
    h.pipeline(id).delivery!.active = false;
  }
  const previous = h.merge("finished")!;
  if (difference === "repository") previous.repository = "acme/other";
  if (difference === "PR") previous.prNumber = 12;
  if (difference === "head") previous.refresh!.head = "b".repeat(40);
  if (difference === "base") previous.refresh!.base = "3".repeat(40);
  // Seed a child for the chosen tuple, then drop the mutable parent evidence.
  const { refreshReservation } = await import("./autoRefresh");
  const receipt = h.pipeline("refresh-1");
  const reservation = refreshReservation(h.pipeline("finished"), previous.refresh!.base, previous.refresh!.head, T0, "main");
  receipt.creationRequest = { key: reservation.key, digest: reservation.digest };
  h.byKey.clear();
  h.byKey.set(reservation.key, receipt);
  delete previous.refresh;
  const next = finished();
  next.id = "next";
  next.delivery!.ownerId = next.id;
  h.add(next);
  Object.assign(h.prs.get(11)!, { mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", checks: [red("ci")] });
  await h.sweep();
  expect(h.creates).toHaveLength(difference === "same" ? 1 : 2);
  expect(h.merge("next")!.state).toBe(difference === "same" ? "blocked" : "refreshing");
  expect(h.writes).toEqual([]);
});

test.each([
  ["base read", "carrier"], ["comparison", "carrier"], ["reservation", "carrier"],
  ["base read", "child"], ["comparison", "child"], ["reservation", "child"],
] as const)("a matching reservation arriving during %s on the %s prevents another refresh", async (seam, evidence) => {
  const prior = harness({ lanes: [finished()], prs: [conflicting()] });
  prior.setBase(MAIN_2);
  await prior.sweep();
  const reserved = structuredClone(prior.pipeline("finished"));
  Object.assign(reserved, { id: "previous", state: "closed", hiddenAt: iso(T0) });
  const h = harness({ mergeBase: MAIN_1, lanes: [finished()], prs: [openPr(11, { checks: [red("ci")] })] });
  h.setBase(MAIN_2);
  const insert = () => {
    if (evidence === "carrier") h.add(reserved);
    else {
      const child = prior.pipeline("refresh-1");
      h.byKey.set(child.creationRequest!.key, child);
    }
  };
  const run = h.ports.run;
  let compared = false;
  h.ports.run = async args => {
    const raw = await run(args);
    if (seam === "base read" && args.at(-1) === ".commit.sha") insert();
    if (args[1]?.includes("/compare/")) {
      compared = true;
      if (seam === "comparison") insert();
    }
    return raw;
  };
  const mutate = h.ports.mutate;
  h.ports.mutate = async (id, change) => {
    if (compared && seam === "reservation") insert();
    return mutate(id, change);
  };
  await h.sweep();
  expect(h.merge("finished")).toMatchObject({ state: "blocked", reason: 'check "ci" failed' });
  expect(h.merge("finished")!.refresh).toBeUndefined();
  expect(h.creates).toEqual([]);
  expect(h.writes).toEqual([]);
});

test("an unavailable refresh receipt lookup starts no work and takes the bounded read-failure path", async () => {
  const h = harness({ mergeBase: MAIN_1, lanes: [finished()], prs: [openPr(11, { checks: [red("ci")] })] });
  h.setBase(MAIN_2);
  h.ports.loadRefreshByKey = () => { throw new Error("receipt lookup unavailable"); };
  await h.run(3 * MERGE_POLL_MS);
  expect(h.merge("finished")).toMatchObject({ state: "blocked", reason: MERGE_REASONS.unreachable, readFailures: 3 });
  expect(h.merge("finished")!.refresh).toBeUndefined();
  expect(h.creates).toEqual([]);
  expect(h.writes).toEqual([]);
});

test.each(["unreadable", "malformed"])("a %s ancestry comparison takes the bounded read-failure path", async mode => {
  const h = harness({ lanes: [finished()], prs: [openPr(11, { checks: [red("ci")] })] });
  const run = h.ports.run;
  h.ports.run = async args => {
    const raw = await run(args);
    if (!args[1]?.includes("/compare/")) return raw;
    if (mode === "unreadable") throw new Error("comparison unavailable");
    return "null";
  };
  await h.run(3 * MERGE_POLL_MS);
  expect(h.merge("finished")).toMatchObject({ state: "blocked", reason: MERGE_REASONS.unreachable, readFailures: 3 });
  expect(h.creates).toEqual([]);
  expect(h.writes).toEqual([]);
});

test.each(["base read", "comparison", "reservation"])("a red-check refresh rechecks admission after %s", async seam => {
  const h = harness({ mergeBase: MAIN_1, lanes: [finished()], prs: [openPr(11, { checks: [red("ci")] })] });
  h.setBase(MAIN_2);
  const run = h.ports.run;
  let compared = false;
  h.ports.run = async args => {
    const raw = await run(args);
    if (seam === "base read" && args.at(-1) === ".commit.sha") h.setSetting({ enabled: false });
    if (args[1]?.includes("/compare/")) {
      compared = true;
      if (seam === "comparison") h.pipeline("finished").delivery!.active = true;
    }
    return raw;
  };
  const mutate = h.ports.mutate;
  h.ports.mutate = async (id, change) => {
    if (compared && seam === "reservation") h.pipeline("finished").runs[1]!.attempts[0]!.state = "failed";
    return mutate(id, change);
  };
  await h.sweep();
  expect(h.merge("finished")).toMatchObject({ state: "blocked", reason: 'check "ci" failed' });
  expect(h.creates).toEqual([]);
  expect(h.writes).toEqual([]);
});

test("a red refresh head missing the base it already tried blocks without another refresh", async () => {
  const value = finished();
  value.refreshOf = { pipelineId: "original", base: MAIN_2 };
  const h = harness({ mergeBase: MAIN_1, lanes: [value], prs: [openPr(11, { checks: [red("ci")] })] });
  h.setBase(MAIN_2);
  await h.run(5 * MERGE_POLL_MS);
  expect(h.merge("finished")).toMatchObject({ state: "blocked", reason: 'check "ci" failed' });
  expect(h.creates).toEqual([]);
  expect(h.writes).toEqual([]);
});

test("red checks behind main refresh only the first queued PR", async () => {
  const first = finished();
  const second = finished();
  second.id = "second";
  second.closedAt = iso(T0);
  second.delivery!.target.branch = "refs/heads/second";
  second.delivery!.target.pr = 22;
  second.delivery!.ownerId = second.id;
  const h = harness({ mergeBase: MAIN_1, lanes: [first, second],
    prs: [openPr(11, { checks: [red("ci")] }), openPr(22, { checks: [red("ci")] })] });
  h.setBase(MAIN_2);
  await h.run(10 * MERGE_POLL_MS);
  expect(h.creates).toHaveLength(1);
  expect((h.creates[0]!.request as CreatePipelineRequest).delivery?.pr).toBe(11);
  expect(h.merge("second")).toMatchObject({ state: "queued", head: null });
  expect(h.calls.filter(args => args[0] === "pr" && args[1] === "view").map(args => args[2])).toEqual(["11"]);
  expect(h.writes).toEqual([]);
});

test("one conflict starts one visible refresh on the same task and delivery, without a forge write", async () => {
  const h = harness({ lanes: [finished()], prs: [conflicting()] });
  await h.run(30 * 60_000);
  expect(h.creates).toHaveLength(1);
  expect(h.merge("finished")).toMatchObject({ state: "refreshing", refresh: { pipelineId: "refresh-1", base: MAIN_1, head: HEAD_A, attempt: 0 } });
  expect(h.creates[0]).toMatchObject({
    request: { taskIds: ["task-one"], finishesTask: ["task-one"], delivery: { branch: "refs/heads/topic", pr: 11 }, publication: "remote-branch", autoStart: true,
      stages: [
        { id: "refresh", role: { roleId: "merger" }, next: "review", onFail: null },
        { id: "review", role: { roleId: "reviewer" }, next: null, onFail: { to: "fix", maxRounds: 1, onExhausted: "advance" } },
        { id: "fix", role: { roleId: "merger" }, next: "review" },
      ] },
    options: { creationRequest: { key: expect.stringMatching(/^auto-refresh:[0-9a-f]{64}$/) }, refreshOf: { pipelineId: "finished", base: MAIN_1, lineage: { srcConversationId: "seat-one" } } },
  });
  expect(h.writes).toHaveLength(0);
});


test.each([false, true])("a spent budget's final passed fix may refresh only after a terminal re-check (terminal: %s)", async terminal => {
  const value = finished();
  if (!terminal) {
    value.stages[1]!.next = "ship";
    value.stages.push({ ...value.stages[0]!, id: "ship", next: null });
    value.runs.push({ stageId: "ship", attempts: [{ ...value.runs[0]!.attempts[0]! }] });
  }
  value.runs[1]!.attempts[0]!.state = "failed";
  value.runs[1]!.attempts[0]!.budgetSpent = true;
  value.runs[0]!.attempts[0]!.activatedBy = { edge: "fail", budgetSpent: true, stageId: "review", attempt: 1 };
  const h = harness({ lanes: [value], prs: [conflicting()] });
  await h.sweep();
  expect(h.creates).toHaveLength(terminal ? 0 : 1);
  if (terminal) {
    expect(h.merge("finished")).toBeUndefined();
    expect(h.calls).toEqual([]);
    expect(h.writes).toEqual([]);
  }
});

test("a second base movement waits for the running refresh, then starts one successor", async () => {
  const h = harness({ lanes: [finished()], prs: [conflicting()] });
  await h.sweep();
  h.setBase(MAIN_2);
  await h.run(5 * 60_000);
  expect(h.creates).toHaveLength(1);
  h.pipeline("refresh-1").state = "completed";
  h.pipeline("refresh-1").delivery!.active = false;
  await h.sweep();
  await h.sweep();
  expect(h.creates).toHaveLength(2);
  expect(h.pipeline("refresh-2").refreshOf).toEqual({ pipelineId: "refresh-1", base: MAIN_2 });
  expect(h.writes).toHaveLength(0);
});

test("a refresh conflicting against the same base stops instead of looping", async () => {
  const h = harness({ lanes: [finished()], prs: [conflicting()] });
  await h.sweep();
  h.pipeline("refresh-1").state = "completed";
  h.pipeline("refresh-1").delivery!.active = false;
  await h.sweep();
  expect(h.creates).toHaveLength(1);
  expect(h.merge("refresh-1")).toMatchObject({ state: "blocked", reason: MERGE_REASONS.refreshSameBase });
});

test("a semantic conflict names its hunk on the successor and keeps the PR open", async () => {
  const h = harness({ lanes: [finished()], prs: [conflicting()] });
  await h.sweep();
  const request = h.creates[0]!.request as CreatePipelineRequest;
  expect(request.stages[0]!.onFail).toBeNull();
  h.pipeline("refresh-1").state = "needs_decision";
  h.pipeline("refresh-1").stateDetail = "src/example.ts:12 @@ -9,6 +9,7 @@ changes either side's behaviour";
  await h.run(30 * 60_000);
  expect(h.merge("finished")).toMatchObject({ state: "blocked", reason: h.pipeline("refresh-1").stateDetail });
  expect(h.pipeline("refresh-1").srcConversationId).toBe("seat-one");
  expect(h.creates).toHaveLength(1);
  expect(h.writes).toHaveLength(0);
});

test("setting off makes no reads or refresh and cancels an existing refresh without interrupting it", async () => {
  const h = harness({ lanes: [finished()], prs: [conflicting()], setting: { enabled: false } });
  await h.sweep();
  expect(h.calls).toHaveLength(0);
  expect(h.merge("finished")).toBeUndefined();
  expect(h.creates).toHaveLength(0);
  h.setSetting({ enabled: true });
  await h.sweep();
  h.setSetting({ enabled: false });
  await h.sweep();
  expect(h.merge("finished")).toMatchObject({ state: "cancelled", reason: MERGE_REASONS.settingOff });
  expect(h.pipeline("refresh-1").state).toBe("running");
  h.pipeline("refresh-1").state = "completed";
  await h.sweep();
  expect(h.merge("refresh-1")).toBeUndefined();
  expect(h.writes).toHaveLength(0);
});

test.each(["running", "needs_review", "needs_decision"] as const)("a %s lane is left untouched", async (state) => {
  const value = finished();
  value.state = state;
  const h = harness({ lanes: [value], prs: [conflicting()] });
  await h.sweep();
  expect(h.merge("finished")).toBeUndefined();
  expect(h.calls).toHaveLength(0);
  expect(h.creates).toHaveLength(0);
});

test.each(["target", "pr"])("an open lane joined by %s prevents a refresh", async (join) => {
  const h = harness({ lanes: [finished()], prs: [conflicting()] });
  const open = finished();
  open.id = "other";
  open.state = "running";
  if (join === "pr") open.delivery!.target.branch = "refs/heads/other";
  else open.delivery!.target.pr = 12;
  h.add(open);
  await h.sweep();
  expect(h.creates).toHaveLength(0);
  expect(h.merge("finished")).toMatchObject({ state: "blocked", reason: MERGE_REASONS.conflict });
});

test.each(["comparison", "multiple PRs"] as const)("a linked %s lane on another branch prevents refresh", async (association) => {
  const h = harness({ lanes: [finished()], prs: [conflicting()] });
  const open = lane("linked-work");
  open.state = "running";
  open.delivery = {
    ...structuredClone(optionsLaneDelivery),
    disposition: association === "comparison" ? "comparison" : "owner",
    active: association !== "comparison",
    target: { ...optionsLaneDelivery.target, branch: "refs/heads/other", pr: undefined },
  };
  open.workLinks = [11, ...(association === "multiple PRs" ? [12] : [])].map((number) => ({
    repository: REPO, number, kind: "pr" as const, addedAt: iso(T0), addedBy: "operator" as const,
  }));
  h.add(open);
  await h.sweep();
  expect(h.creates).toHaveLength(0);
  expect(h.merge("finished")).toMatchObject({ state: "blocked", reason: MERGE_REASONS.conflict });
});

test.each(["throw", "lost"] as const)("restart after %s replays one reserved refresh", async (mode) => {
  const h = harness({ lanes: [finished()], prs: [conflicting()] });
  h.setCreateMode(mode);
  await h.sweep();
  const reserved = structuredClone(h.merge("finished")!.refresh!);
  expect(reserved.pipelineId).toBeNull();
  resetAutoMergeForTests();
  h.setCreateMode("ok");
  await h.sweep();
  expect(h.byKey.size).toBe(1);
  expect(h.merge("finished")!.refresh).toEqual({ ...reserved, pipelineId: "refresh-1" });
  expect(h.creates[1]!.options).toEqual(h.creates[0]!.options);
});

test("two concurrent Viewer sweeps reserve and create one refresh", async () => {
  const h = harness({ lanes: [finished()], prs: [conflicting()] });
  await Promise.all([sweepAutoMerge(h.ports), sweepAutoMerge({ ...h.ports })]);
  expect(h.byKey.size).toBe(1);
  expect(h.creates).toHaveLength(1);
});

test("refused creation and a closed successor leave a plain stopped reason", async () => {
  const refused = harness({ lanes: [finished()], prs: [conflicting()] });
  refused.setCreateMode("refuse");
  await refused.sweep();
  expect(refused.merge("finished")).toMatchObject({ state: "blocked", reason: "Delegatus could not start the refresh: target already owned" });
  const closed = harness({ lanes: [finished()], prs: [conflicting()] });
  await closed.sweep();
  closed.pipeline("refresh-1").state = "closed";
  await closed.sweep();
  expect(closed.merge("finished")).toMatchObject({ state: "blocked", reason: MERGE_REASONS.refreshClosed });
  expect(refused.writes).toHaveLength(0);
  expect(closed.writes).toHaveLength(0);
});

test("the successor uses the existing green-check runner and settles its parent", async () => {
  const h = harness({ lanes: [finished()], prs: [conflicting()] });
  await h.sweep();
  h.pipeline("refresh-1").state = "completed";
  h.pipeline("refresh-1").delivery!.active = false;
  h.prs.get(11)!.mergeStateStatus = "CLEAN";
  h.prs.get(11)!.mergeable = "MERGEABLE";
  await h.run(6 * 60_000);
  expect(h.merge("refresh-1")).toMatchObject({ state: "merged", by: "auto-merge" });
  expect(h.merge("finished")).toMatchObject({ state: "merged", by: "auto-merge" });
  expect(h.merges()).toHaveLength(1);
});

test("a failed successor check never merges red", async () => {
  const h = harness({ lanes: [finished()], prs: [conflicting()] });
  await h.sweep();
  h.pipeline("refresh-1").state = "completed";
  h.pipeline("refresh-1").delivery!.active = false;
  h.prs.get(11)!.mergeStateStatus = "CLEAN";
  h.prs.get(11)!.mergeable = "MERGEABLE";
  h.prs.get(11)!.checks = [red("ci")];
  await h.run(6 * 60_000);
  expect(h.merge("refresh-1")).toMatchObject({ state: "blocked", reason: 'check "ci" failed' });
  expect(h.merge("finished")).toMatchObject({ state: "blocked", reason: 'check "ci" failed' });
  expect(h.writes).toHaveLength(0);
});

const { laneMergeWord, mergeNeedsYou, mergeReasonText } = await import("@/components/pipelines/pipelineBlockModel");
const { translate } = await import("@/lib/i18n");
test("the refreshing card stays visible without Needs you and new stopped reasons render in both languages", async () => {
  const h = harness({ lanes: [finished()], prs: [conflicting()] });
  await h.sweep();
  expect(laneMergeWord(h.pipeline("finished"))).toBe("updating");
  expect(mergeNeedsYou(h.pipeline("finished"))).toBe(false);
  for (const lang of ["en", "uk"] as const) {
    const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate(lang, key, params);
    for (const [reason, key] of [[MERGE_REASONS.refreshClosed, "refreshClosed"], [MERGE_REASONS.refreshSameBase, "refreshSameBase"]] as const) {
      expect(mergeReasonText(t, reason)).toBe(t(`pipelineBlock.mergeReason.${key}`));
      expect(t(`pipelineBlock.mergeReason.${key}`)).not.toContain("pipelineBlock.");
    }
    expect(mergeReasonText(t, "Delegatus could not start the refresh: target already owned")).toBe(t("pipelineBlock.mergeReason.refusedRefresh", { message: "target already owned" }));
  }
});


test("turning the setting off during the base-tip read admits no refresh", async () => {
  const h = harness({ lanes: [finished()], prs: [conflicting()] });
  const run = h.ports.run;
  h.ports.run = async (args) => {
    const answer = await run(args);
    if (args.at(-1) === ".commit.sha") h.setSetting({ enabled: false });
    return answer;
  };
  await h.sweep();
  expect(h.creates).toHaveLength(0);
  expect(h.merge("finished")?.state).not.toBe("refreshing");
});

test("a persisted refreshing reservation survives store reload, and malformed metadata is refused", async () => {
  const h = harness({ lanes: [finished()], prs: [conflicting()] });
  await h.sweep();
  const { buildPipeline, savePipelines, loadPipelines } = await import("@/lib/pipelines/store");
  const value = buildPipeline({ id: "persisted", task: "Refresh", project: "fixture", repoDir: "/fixture/repository",
    stages: [{ id: "refresh", kind: "run", prompt: "Merge", next: null, effectiveRole: BUILDER as Pipeline["stages"][number]["effectiveRole"] }],
    srcPath: null, srcConversationId: null, now: iso(T0), state: "draft" });
  value.state = "completed";
  value.cursor = null;
  value.closedAt = iso(T0);
  value.merge = structuredClone(h.merge("finished")!);
  value.refreshOf = { pipelineId: "earlier", base: MAIN_1 };
  savePipelines([value]);
  expect(loadPipelines()[0]!.merge!.refresh).toEqual(value.merge.refresh);
  expect(loadPipelines()[0]!.refreshOf).toEqual(value.refreshOf);
  for (const bad of [{ base: "wrong" }, { baseBranch: "" }, { baseBranch: 7 }, { attempt: -1 }, { digest: "wrong" }, { pipelineId: 7 }]) {
    const invalid = structuredClone(value);
    Object.assign(invalid.merge!.refresh!, bad);
    expect(() => savePipelines([invalid])).toThrow("malformed pipeline record");
  }
});


test("setting cancellation during seat lookup starts no reserved work", async () => {
  const h = harness({ lanes: [finished()], prs: [conflicting()] });
  h.ports.activeSeat = async () => {
    h.setSetting({ enabled: false });
    return { srcPath: null, srcConversationId: "seat-one" };
  };
  await h.sweep();
  expect(h.creates).toHaveLength(0);
  await h.sweep();
  expect(h.merge("finished")).toMatchObject({ state: "cancelled", reason: MERGE_REASONS.settingOff });
});


test.each(["merged", "closed"] as const)("forge cache %s settles a refreshing parent", async (state) => {
  const h = harness({ lanes: [finished()], prs: [conflicting()] });
  await h.sweep();
  h.setCached(state);
  h.prs.get(11)!.state = state.toUpperCase();
  await h.sweep();
  expect(h.merge("finished")).toMatchObject(state === "merged" ? { state: "merged", by: "outside" } : { state: "blocked", reason: MERGE_REASONS.closed });
  expect(h.creates).toHaveLength(1);
  expect(h.writes).toHaveLength(0);
});

test("three failed creates stop with a plain reason and one durable reservation", async () => {
  const h = harness({ lanes: [finished()], prs: [conflicting()] });
  h.setCreateMode("throw");
  await h.run(5 * 60_000);
  expect(h.merge("finished")).toMatchObject({ state: "blocked", reason: "Delegatus could not start the refresh: store busy", refresh: { pipelineId: null } });
  expect(h.creates).toHaveLength(3);
  expect(new Set(h.creates.map(item => (item.options as RefreshOptions).creationRequest.key)).size).toBe(1);
  expect(h.writes).toHaveLength(0);
});

test("an old stopped conflict starts no refresh until an explicit retry", async () => {
  const value = finished();
  delete value.delivery;
  const h = harness({ lanes: [value], prs: [conflicting()] });
  await h.sweep();
  expect(h.merge("finished")?.state).toBe("blocked");
  h.pipeline("finished").delivery = structuredClone(optionsLaneDelivery);
  const calls = h.calls.length;
  await h.run(10 * 60_000);
  expect(h.creates).toHaveLength(0);
  expect(h.calls).toHaveLength(calls);
  const merge = h.pipeline("finished").merge!;
  merge.state = "queued";
  merge.attempts += 1;
  await h.sweep();
  expect(h.creates).toHaveLength(1);
  expect((h.creates[0]!.options as RefreshOptions).creationRequest.key).toMatch(/^auto-refresh:[0-9a-f]{64}$/);
});


test("a completed refresh advances its parent's check state before merging", async () => {
  const h = harness({ lanes: [finished()], prs: [conflicting()] });
  await h.sweep();
  const successor = h.pipeline("refresh-1");
  successor.state = "completed";
  successor.delivery!.active = false;
  successor.lastPassedCommit = "b".repeat(40);
  Object.assign(h.prs.get(11)!, { head: successor.lastPassedCommit, mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" });
  await h.sweep();
  await h.sweep();
  expect(h.merge("finished")?.state).toBe("waiting-checks");
  expect(h.writes).toHaveLength(0);
  await h.run(6 * 60_000);
  expect(h.merge("finished")).toMatchObject({ state: "merged", mergedHead: successor.lastPassedCommit });
  expect(h.merges()).toHaveLength(1);
});


test.each(["main", "release/stable"])("a PR successor names the forge base and its tip as the source, and the delivery branch only as the target", async base => {
  const value = finished();
  value.baseBranch = "topic";
  const h = harness({ lanes: [value], prs: [{ ...conflicting(), base }] });
  await h.sweep();
  const request = h.creates[0]!.request as CreatePipelineRequest;
  const [refresh, review, fix] = request.stages;
  const publicText = [request.task, request.spec, ...request.stages.map(stage => stage.prompt)].join("\n");
  expect(h.merge("finished")!.refresh).toMatchObject({ baseBranch: base, base: MAIN_1 });
  expect(request.baseBranch).toBe(base);
  expect(request.task).toContain(`merge current ${base}`);
  expect(request.spec).toContain(`refresh from ${base}`);
  expect(refresh!.prompt).toContain(`Merge current origin/${base} into this PR's delivery branch refs/heads/topic`);
  expect(refresh!.prompt).toContain(`base ${base} at ${MAIN_1}; reviewed head ${HEAD_A}; delivery refs/heads/topic`);
  expect(review!.prompt).toContain(`plus ${base}'s changes`);
  expect(fix!.prompt).toContain("this PR's delivery branch refs/heads/topic");
  expect(publicText).not.toContain("origin/topic");
  expect(publicText).not.toContain("base topic");
  expect(publicText).not.toContain("refresh from topic");
});


test("a reserved refresh replays the same source and target after branch metadata changes", async () => {
  const value = finished();
  value.baseBranch = "topic";
  const h = harness({ lanes: [value], prs: [{ ...conflicting(), base: "release/stable" }] });
  h.setCreateMode("throw");
  await h.sweep();
  const reservation = structuredClone(h.merge("finished")!.refresh!);
  const request = structuredClone(h.creates[0]!.request as CreatePipelineRequest);
  h.pipeline("finished").baseBranch = "another-checkout-base";
  h.prs.get(11)!.base = "another-integration-base";
  h.setBase(MAIN_2);
  h.setCreateMode("ok");
  await h.sweep();
  expect(h.creates).toHaveLength(2);
  expect(h.creates[1]!.request).toEqual(request);
  expect(h.creates[1]!.options).toEqual(h.creates[0]!.options);
  expect(h.merge("finished")!.refresh).toEqual({ ...reservation, pipelineId: "refresh-1" });
  expect(request.baseBranch).toBe("release/stable");
  expect(request.stages[0]!.prompt).toContain("Merge current origin/release/stable into this PR's delivery branch refs/heads/topic");
  expect(request.spec).toContain(`base release/stable at ${MAIN_1}; reviewed head ${HEAD_A}; delivery refs/heads/topic`);
});

test("a legacy reservation replays with the forge base after a failed creation", async () => {
  const value = finished();
  value.baseBranch = "topic";
  const h = harness({ lanes: [value], prs: [{ ...conflicting(), base: "release/stable" }] });
  h.setCreateMode("throw");
  await h.sweep();
  delete h.pipeline("finished").merge!.refresh!.baseBranch;
  h.setCreateMode("ok");
  await h.sweep();
  expect((h.creates.at(-1)!.request as CreatePipelineRequest).baseBranch).toBe("release/stable");
  expect(h.creates[1]!.options).toEqual(h.creates[0]!.options);
});


test("a missing forge base uses the repository default branch", async () => {
  const value = finished(); value.baseBranch = "topic";
  const h = harness({ lanes: [value], prs: [{ ...conflicting(), base: "" }] });
  const run = h.ports.run;
  h.ports.run = async args => args[0] === "repo" && args.includes("defaultBranchRef") ? "trunk" : run(args);
  await h.sweep();
  expect((h.creates[0]!.request as CreatePipelineRequest).baseBranch).toBe("trunk");
});

test("an inconsistent forge base equal to the delivery branch starts no self-merge", async () => {
  const h = harness({ lanes: [finished()], prs: [{ ...conflicting(), base: "topic" }] });
  await h.sweep();
  expect(h.creates).toHaveLength(0);
  expect(h.writes).toHaveLength(0);
});


test("progress observed before write admission cannot advance a reopened successor", async () => {
  const h = harness({ lanes: [finished()], prs: [conflicting()] });
  await h.sweep();
  h.pipeline("refresh-1").state = "completed";
  h.pipeline("refresh-1").delivery!.active = false;
  Object.assign(h.prs.get(11)!, { mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" });
  await h.sweep();
  const mutate = h.ports.mutate;
  h.ports.mutate = async (id, change) => {
    if (id === "finished") h.pipeline("refresh-1").state = "running";
    return mutate(id, change);
  };
  await h.sweep();
  expect(h.merge("finished")?.state).toBe("refreshing");
  expect(h.writes).toHaveLength(0);
});


test("strict protection refreshes the next PR locally and waits for checks on its new head", async () => {
  const first = finished(), second = finished();
  second.id = "second";
  second.closedAt = iso(T0);
  second.delivery!.ownerId = second.id;
  second.delivery!.target = { ...second.delivery!.target, branch: "refs/heads/second", pr: 22 };
  const oldChecks = [green("privacy-tracker-audit"), green("privacy-tracker-audit"), green("typecheck")]
    .map(check => ({ ...check, startedAt: iso(T0 - 7_200_000) }));
  const h = harness({ strict: true, required: ["privacy-tracker-audit", "typecheck"], lanes: [first, second],
    prs: [openPr(11, { checks: structuredClone(oldChecks) }), openPr(22, { checks: structuredClone(oldChecks) })] });
  await h.run(5 * 60_000, () => h.merges().length === 1);
  expect(h.merges().map(args => args[2])).toEqual(["11"]);
  expect(h.prs.get(22)!.mergeStateStatus).toBe("BEHIND");
  await h.sweep();
  expect(h.creates).toHaveLength(1);
  expect(h.merge("second")).toMatchObject({ state: "refreshing", refresh: { base: MAIN_2, head: HEAD_A, pipelineId: "refresh-1" } });
  const request = h.creates[0]!.request as CreatePipelineRequest;
  expect(request.delivery).toMatchObject({ branch: "refs/heads/second", pr: 22 });
  expect(h.updates()).toHaveLength(0);
  const refreshedHead = "b".repeat(40);
  Object.assign(h.pipeline("refresh-1"), { state: "completed", lastPassedCommit: refreshedHead });
  h.pipeline("refresh-1").delivery!.active = false;
  Object.assign(h.prs.get(22)!, { head: refreshedHead, mergeStateStatus: "CLEAN", checks: [] });
  await h.sweep();
  expect(h.merge("refresh-1")).toMatchObject({ state: "waiting-checks", head: refreshedHead, headSeenAt: iso(h.now()) });
  h.advance(3 * 60_000);
  await h.sweep();
  expect(h.merges()).toHaveLength(1);
  h.prs.get(22)!.checks = [green("privacy-tracker-audit"), { name: "privacy-tracker-audit", status: "IN_PROGRESS", conclusion: "" }, green("typecheck")];
  await h.run(2 * MERGE_POLL_MS);
  expect(h.merges()).toHaveLength(1);
  h.prs.get(22)!.checks = structuredClone(oldChecks);
  await h.run(3 * MERGE_POLL_MS, () => h.merges().length === 2);
  expect(h.merges().map(args => [args[2], args.at(-1)])).toEqual([["11", HEAD_A], ["22", refreshedHead]]);
  expect(h.updates()).toHaveLength(0);
  expect(h.writes.every(write => write.args[0] === "pr" && write.args[1] === "merge")).toBe(true);
});

test.each(["missing delivery", "active owner", "disabled", "changed during base read", "retargeted delivery", "review changed", "changed during reservation"])("BEHIND never falls back to update-branch when refresh is %s", async mode => {
  const value = finished();
  if (mode === "missing delivery") delete value.delivery;
  const h = harness({ lanes: [value], prs: [openPr(11, { mergeStateStatus: "BEHIND" })] });
  if (mode === "active owner") {
    const owner = finished(); owner.id = "active"; owner.state = "running"; h.add(owner);
  }
  if (mode === "disabled") delete (h.ports as Partial<typeof h.ports>).startRefresh;
  if (mode === "changed during reservation") {
    const mutate = h.ports.mutate;
    h.ports.mutate = async (id, change) => {
      if (h.merge(id)) h.pipeline(id).delivery!.active = true;
      return mutate(id, change);
    };
  }
  if (["changed during base read", "retargeted delivery", "review changed"].includes(mode)) {
    const run = h.ports.run;
    h.ports.run = async args => {
      const result = await run(args);
      if (args.at(-1) === ".commit.sha") {
        if (mode === "retargeted delivery") h.pipeline("finished").delivery!.target.branch = "refs/heads/changed";
        else if (mode === "review changed") h.pipeline("finished").runs[1]!.attempts[0]!.state = "failed";
        else h.pipeline("finished").delivery!.active = true;
      }
      return result;
    };
  }
  await h.sweep();
  expect(h.creates).toHaveLength(0);
  expect(h.writes).toHaveLength(0);
  expect(h.merge("finished")?.state).toBe("blocked");
  expect(h.merge("finished")?.reason).toContain("Delegatus could not start the refresh");
});

function queuedRefreshes(required?: string[]) {
  const lanes = Array.from({ length: 12 }, (_, index) => {
    const value = finished();
    value.id = `queued-${index}`;
    value.closedAt = iso(T0 + index);
    value.delivery!.ownerId = value.id;
    value.delivery!.target = { ...value.delivery!.target, branch: `refs/heads/topic-${index}`, pr: index + 11 };
    return value;
  });
  return harness({ required, lanes, prs: lanes.map((_, index) => openPr(index + 11, { mergeStateStatus: "BEHIND" })) });
}

test("a main move refreshes only the queue head across repeated sweeps", async () => {
  const h = queuedRefreshes();
  await h.run(5 * MERGE_POLL_MS);
  h.setBase(MAIN_2);
  await h.run(5 * MERGE_POLL_MS);
  expect(h.creates).toHaveLength(1);
  expect(h.merge("queued-1")).toMatchObject({ state: "queued", reviewedHead: HEAD_A, head: null });
  expect(h.calls.filter(args => args[0] === "pr" && args[1] === "view").every(args => args[2] === "11")).toBe(true);
});

test("a merged head releases the next refresh", async () => {
  const h = queuedRefreshes();
  await h.sweep();
  h.pipeline("refresh-1").state = "completed";
  h.pipeline("refresh-1").merge = { ...h.merge("queued-0")!, state: "merged" };
  await h.sweep();
  expect(h.creates).toHaveLength(2);
  expect(h.merge("queued-1")?.state).toBe("refreshing");
});

test("two refresh slots are honoured and larger limits are capped", async () => {
  for (const concurrency of [2, 20]) {
    resetAutoMergeForTests();
    const h = queuedRefreshes();
    Object.assign(h.ports, { refreshConcurrency: concurrency });
    await h.run(5 * MERGE_POLL_MS);
    expect(h.creates).toHaveLength(2);
  }
});

test.each([0, -1, Number.NaN, 1.9])("refresh concurrency %s retains one head slot", async refreshConcurrency => {
  const h = queuedRefreshes();
  Object.assign(h.ports, { refreshConcurrency });
  await h.run(5 * MERGE_POLL_MS);
  expect(h.creates).toHaveLength(1);
  expect(h.merge("queued-1")).toMatchObject({ state: "queued", reviewedHead: HEAD_A, head: null });
});

test.each(["closed", "needs_decision"] as const)("a %s head refresh retains its reason and releases the next PR", async state => {
  const h = queuedRefreshes();
  await h.sweep();
  h.pipeline("refresh-1").state = state;
  h.pipeline("refresh-1").stateDetail = "Resolution needs a decision";
  await h.sweep();
  expect(h.merge("queued-0")).toMatchObject({ state: "blocked", reason: state === "closed" ? MERGE_REASONS.refreshClosed : "Resolution needs a decision" });
  expect(h.creates).toHaveLength(2);
});

for (const refusal of ["hidden", "setting moved"] as const) for (const refreshConcurrency of [1, 2]) {
  test(`a completed refresh refused admission by ${refusal} releases the next PR at concurrency ${refreshConcurrency}`, async () => {
    const h = queuedRefreshes();
    Object.assign(h.ports, { refreshConcurrency });
    await h.sweep();
    const child = h.pipeline("refresh-1");
    child.state = "completed";
    child.closedAt = iso(T0);
    child.delivery!.active = false;
    if (refusal === "hidden") child.hiddenAt = iso(T0);
    else h.setSetting({ changedAt: iso(T0 + 1) });

    await h.sweep();
    const stoppedAt = h.merge("queued-0")!.updatedAt;
    await h.run(5 * MERGE_POLL_MS);
    expect(h.merge("refresh-1")).toBeUndefined();
    expect(h.merge("queued-0")).toMatchObject({ state: "blocked", reviewedHead: HEAD_A,
      reason: `Refresh was not admitted: ${refusal === "hidden" ? "lane is hidden" : "lane did not complete after the merge setting was enabled"}` });
    expect(h.creates).toHaveLength(refreshConcurrency + 1);
    expect((h.creates[refreshConcurrency]!.request as CreatePipelineRequest).delivery?.pr).toBe(11 + refreshConcurrency);
    expect(h.merge(`queued-${refreshConcurrency}`)?.state).toBe("refreshing");
    expect(h.merge(`queued-${refreshConcurrency + 1}`)).toMatchObject({ state: "queued", reviewedHead: HEAD_A, head: null });
    expect(h.merge("queued-0")!.updatedAt).toBe(stoppedAt);
    expect(h.writes).toHaveLength(0);
  });
}

for (const change of ["visible", "running", "different base"] as const) test(`a completed refresh admission refusal is rechecked under the original's lock: ${change}`, async () => {
  const h = queuedRefreshes();
  await h.sweep();
  const child = h.pipeline("refresh-1");
  child.state = "completed";
  child.delivery!.active = false;
  child.hiddenAt = iso(T0);
  const mutate = h.ports.mutate;
  let raced = false;
  h.ports.mutate = async (id, apply) => {
    if (id === "queued-0" && !raced) {
      raced = true;
      if (change === "visible") h.pipeline(child.id).hiddenAt = null;
      else if (change === "running") h.pipeline(child.id).state = "running";
      else h.pipeline(child.id).refreshOf!.base = MAIN_2;
    }
    return mutate(id, apply);
  };
  await h.sweep();
  expect(raced).toBe(true);
  expect(h.merge("queued-0")).toMatchObject({ state: "refreshing", reason: null });
  expect(h.creates).toHaveLength(1);
  expect(h.writes).toHaveLength(0);
});

test("a completed refresh awaiting admission keeps its slot and acquires its own check clock", async () => {
  const h = queuedRefreshes();
  await h.sweep();
  const child = h.pipeline("refresh-1");
  child.state = "completed";
  child.delivery!.active = false;
  child.lastPassedCommit = "b".repeat(40);
  Object.assign(h.prs.get(11)!, { head: child.lastPassedCommit, mergeStateStatus: "CLEAN", checks: [] });
  const mutate = h.ports.mutate;
  let holdAdmission = true;
  h.ports.mutate = async (id, apply) => id === child.id && holdAdmission ? false : mutate(id, apply);
  await h.sweep();
  expect(h.merge(child.id)).toBeUndefined();
  expect(h.merge("queued-0")?.state).toBe("refreshing");
  expect(h.creates).toHaveLength(1);
  holdAdmission = false;
  await h.run(2 * MERGE_POLL_MS);
  expect(h.merge(child.id)).toMatchObject({ state: "waiting-checks", reviewedHead: child.lastPassedCommit });
  expect(h.merge("queued-0")?.state).toBe("waiting-checks");
  expect(h.merge("queued-1")).toMatchObject({ state: "queued", reviewedHead: HEAD_A, head: null });
  expect(h.creates).toHaveLength(1);
  expect(h.writes).toHaveLength(0);
});

test.each(["closed", "needs_decision"] as const)("a hidden original releases its %s refresh with the failure reason", async state => {
  const h = queuedRefreshes();
  await h.sweep();
  h.pipeline("queued-0").hiddenAt = iso(T0);
  h.pipeline("refresh-1").state = state;
  h.pipeline("refresh-1").stateDetail = "Resolution needs a decision";
  await h.run(5 * MERGE_POLL_MS);
  expect(h.merge("queued-0")).toMatchObject({ state: "blocked",
    reason: state === "closed" ? MERGE_REASONS.refreshClosed : "Resolution needs a decision" });
  expect(h.creates).toHaveLength(2);
  expect((h.creates[1]!.request as CreatePipelineRequest).delivery?.pr).toBe(12);
  expect(h.merge("queued-2")?.head).toBeNull();
});

test.each([1, 2])("closed originals retain their active refresh slots at concurrency %s", async refreshConcurrency => {
  const h = queuedRefreshes();
  Object.assign(h.ports, { refreshConcurrency });
  await h.sweep();
  for (let i = 0; i < refreshConcurrency; i++) h.pipeline(`queued-${i}`).state = "closed";
  await h.run(5 * MERGE_POLL_MS);
  expect(h.creates).toHaveLength(refreshConcurrency);
  expect(h.merge(`queued-${refreshConcurrency}`)?.head).toBeNull();
});

test("an out-of-window refresh preserves capacity while completed carriers recover", async () => {
  const h = queuedRefreshes();
  await h.sweep();
  h.pipeline("queued-0").merge!.requestedAt = iso(T0 + 100);
  h.prs.get(12)!.mergeStateStatus = "CLEAN";
  h.prs.get(13)!.state = "MERGED";
  const owner = structuredClone(h.pipeline("refresh-1"));

  await h.sweep();
  expect(h.merge("queued-1")).toMatchObject({ state: "waiting-checks", head: HEAD_A, readAt: iso(T0), headSeenAt: iso(T0) });
  const reads = h.calls.length;
  await h.sweep();
  expect(h.calls).toHaveLength(reads);
  h.advance(MERGE_SETTLE_MS);
  await h.sweep();
  expect(h.merge("queued-1")).toMatchObject({ state: "queued", readAt: iso(h.now()), nextReadAt: iso(h.now() + MERGE_POLL_MS) });
  expect(h.merge("queued-1")!.reason).toContain("refresh-1");
  expect(h.merge("queued-2")!.readAt).toBeNull();
  expect(h.creates).toHaveLength(1);
  expect(h.writes).toEqual([]);
  expect(h.merges()).toEqual([]);

  // A future poll must not hide a check hold that has already expired.
  Object.assign(h.prs.get(12)!, { mergeStateStatus: "UNKNOWN", mergeable: null });
  h.pipeline("queued-1").merge!.nextReadAt = iso(T0 + 2 * MERGE_WAIT_LIMIT_MS);
  h.advance(MERGE_WAIT_LIMIT_MS - MERGE_SETTLE_MS);
  await h.sweep();
  expect(h.merge("queued-1")).toMatchObject({ state: "blocked", reason: MERGE_REASONS.checksTimeout,
    readAt: iso(h.now()), nextReadAt: null });
  await h.sweep();
  expect(h.merge("queued-2")).toMatchObject({ state: "merged", by: "outside", mergedHead: HEAD_A,
    readAt: iso(h.now()), nextReadAt: null });
  expect(h.creates).toHaveLength(1);
  expect(h.writes).toEqual([]);
  expect(h.merges()).toEqual([]);
  expect(h.pipeline("refresh-1")).toEqual(owner);
  expect(h.merge("queued-3")!.readAt).toBeNull();
});

test("queued followers persist their FIFO head and refresh capacity holder until progress", async () => {
  const h = queuedRefreshes();
  await h.sweep();
  h.pipeline("queued-0").merge!.requestedAt = iso(T0 + 100);
  Object.assign(h.prs.get(12)!, { mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" });
  h.prs.get(13)!.mergeStateStatus = "CLEAN";
  await h.sweep();
  const reason = "queued behind PR #12 (pipeline queued-1); waiting for repository capacity held by refresh refresh-1";
  expect(h.merge("queued-2")).toMatchObject({ state: "queued", reason, readAt: null, nextReadAt: null, attempts: 0 });
  expect(h.merge("queued-1")!.reason).toContain(MERGE_REASONS.conflict);
  const retained = structuredClone(h.merge("queued-2"));
  const calls = h.calls.length;
  let tailWrites = 0;
  const mutate = h.ports.mutate;
  h.ports.mutate = async (id, change) => {
    const changed = await mutate(id, change);
    if (id === "queued-2" && changed) tailWrites++;
    return changed;
  };
  h.advance(1);
  await h.sweep();
  expect(h.merge("queued-2")).toEqual(retained);
  expect(tailWrites).toBe(0);
  expect(h.calls).toHaveLength(calls);
  expect(h.writes).toEqual([]);

  // A different carrier of the same head PR must replace the persisted id.
  const nextHead = structuredClone(h.pipeline("queued-1"));
  nextHead.id = "head-successor";
  h.remove("queued-1");
  h.add(nextHead);
  await h.sweep();
  expect(h.merge("queued-2")!.reason).toBe(reason.replace("pipeline queued-1", "pipeline head-successor"));
  expect(tailWrites).toBe(1);

  const holder = structuredClone(h.pipeline("refresh-1"));
  holder.id = "refresh-replacement";
  h.remove("refresh-1");
  h.add(holder);
  h.merge("queued-0")!.refresh!.pipelineId = holder.id;
  await h.sweep();
  expect(h.merge("queued-2")!.reason).toBe(reason.replace("pipeline queued-1", "pipeline head-successor").replace("refresh-1", holder.id));
  expect(tailWrites).toBe(2);

  h.pipeline(holder.id).state = "closed";
  h.pipeline(holder.id).delivery!.active = false;
  await h.sweep();
  expect(h.merge("queued-2")!.reason).toBe("queued behind PR #12 (pipeline head-successor)");
  // Remove the head's conflict and let it merge, then the clean follower.
  Object.assign(h.prs.get(12)!, { mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" });
  await h.run(10 * MERGE_POLL_MS, () => h.merge("queued-2")?.state === "merged");
  expect(h.merges().map(args => args[2])).toEqual(["12", "13"]);
  expect(h.merge("queued-2")).toMatchObject({ state: "merged", reason: null });
});

test("a clean follower in the second polling slot retains its FIFO explanation", async () => {
  const h = queuedRefreshes(["ci"]);
  Object.assign(h.ports, { refreshConcurrency: 2 });
  h.prs.get(11)!.mergeStateStatus = "CLEAN";
  h.prs.get(11)!.checks = [{ name: "ci", status: "IN_PROGRESS" }];
  h.prs.get(12)!.mergeStateStatus = "CLEAN";
  await h.sweep();
  h.advance(MERGE_SETTLE_MS);
  await h.sweep();
  expect(h.merge("queued-1")).toMatchObject({ state: "queued", head: HEAD_A,
    reason: "queued behind PR #11 (pipeline queued-0)" });
  const retained = structuredClone(h.merge("queued-1"));
  h.advance(1);
  await h.sweep();
  expect(h.merge("queued-1")).toEqual(retained);
  expect(h.creates).toEqual([]);
  expect(h.writes).toEqual([]);
  h.prs.get(11)!.checks = [green("ci")];
  await h.run(5 * MERGE_POLL_MS, () => h.merges().length === 2);
  expect(h.merges().map(args => args[2])).toEqual(["11", "12"]);
  expect(h.merge("queued-1")).toMatchObject({ state: "merged", reason: null });
});

test.each(["retry", "cancel", "running"] as const)("a queued explanation preserves a racing %s", async change => {
  const h = queuedRefreshes();
  await h.sweep();
  h.pipeline("queued-0").merge!.requestedAt = iso(T0 + 100);
  const mutate = h.ports.mutate;
  let raced = false;
  let retained: PipelineMerge | undefined;
  h.ports.mutate = async (id, apply) => {
    if (id === "queued-2" && !raced) {
      raced = true;
      const current = h.pipeline(id);
      if (change === "retry") current.merge!.attempts++;
      else if (change === "cancel") current.merge!.state = "cancelled";
      else current.state = "running";
      current.merge!.reason = "new operator decision";
      retained = structuredClone(current.merge);
    }
    return mutate(id, apply);
  };
  await h.sweep();
  expect(raced).toBe(true);
  expect(h.merge("queued-2")).toEqual(retained);
  expect(h.writes).toEqual([]);
});

test.each(["BEHIND", "DIRTY"])("an out-of-window refresh defers a %s head without losing its blocker or owner", async mergeStateStatus => {
  const h = queuedRefreshes();
  await h.sweep();
  h.pipeline("queued-0").merge!.requestedAt = iso(T0 + 100);
  Object.assign(h.prs.get(12)!, { mergeStateStatus, mergeable: mergeStateStatus === "DIRTY" ? "CONFLICTING" : "MERGEABLE" });
  const owner = structuredClone(h.pipeline("refresh-1"));
  await h.run(5 * MERGE_POLL_MS);
  expect(h.merge("queued-1")).toMatchObject({ state: "checking", head: HEAD_A,
    readAt: iso(h.now() - MERGE_POLL_MS) });
  expect(h.merge("queued-1")!.refresh).toBeUndefined();
  expect(h.merge("queued-1")!.reason).toContain("refresh-1");
  expect(h.merge("queued-1")!.reason).toContain(mergeStateStatus === "DIRTY" ? MERGE_REASONS.conflict : "behind");
  expect(h.creates).toHaveLength(1);
  expect(h.writes).toEqual([]);
  expect(h.merges()).toEqual([]);
  expect(h.pipeline("refresh-1")).toEqual(owner);
  expect(h.merge("queued-2")!.readAt).toBeNull();

  h.pipeline("refresh-1").state = "closed";
  h.pipeline("refresh-1").delivery!.active = false;
  await h.sweep();
  expect(h.merge("queued-1")!.state).toBe("refreshing");
  expect(h.creates).toHaveLength(2);
  expect((h.creates[1]!.request as CreatePipelineRequest).delivery?.pr).toBe(12);
  expect(h.writes).toEqual([]);
});

test.each([false, true])("an out-of-window refresh permits an expired failed read, preserving a racing retry: %s", async retry => {
  const h = queuedRefreshes();
  await h.sweep();
  h.pipeline("queued-0").merge!.requestedAt = iso(T0 + 100);
  Object.assign(h.merge("queued-1")!, { head: HEAD_A, headSeenAt: iso(T0 - MERGE_WAIT_LIMIT_MS),
    lastChecks: ["ci"], nextReadAt: iso(T0 + MERGE_WAIT_LIMIT_MS) });
  const owner = structuredClone(h.pipeline("refresh-1"));
  const run = h.ports.run;
  let read = false;
  h.ports.run = async args => {
    if (args[0] !== "pr" || args[1] !== "view" || args[2] !== "12") return run(args);
    await Promise.resolve();
    read = true;
    if (retry) Object.assign(h.merge("queued-1")!, { attempts: 1, head: null, headSeenAt: null, state: "queued", nextReadAt: null });
    throw new Error("fixture forge unavailable");
  };
  await h.sweep();
  expect(read).toBe(true);
  expect(h.merge("queued-1")).toMatchObject(retry
    ? { state: "queued", attempts: 1, headSeenAt: null, readFailures: 0 }
    : { state: "blocked", reason: MERGE_REASONS.checksTimeout, nextReadAt: null, readFailures: 1 });
  expect(h.creates).toHaveLength(1);
  expect(h.writes).toEqual([]);
  expect(h.merges()).toEqual([]);
  expect(h.pipeline("refresh-1")).toEqual(owner);
});

test("a green conflicting PR expires with its conflict and capacity holder", async () => {
  const h = queuedRefreshes();
  await h.sweep();
  h.pipeline("queued-0").merge!.requestedAt = iso(T0 + 100);
  Object.assign(h.prs.get(12)!, { mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" });
  const owner = structuredClone(h.pipeline("refresh-1"));
  await h.sweep();
  h.pipeline("queued-1").merge!.nextReadAt = iso(T0 + 2 * MERGE_WAIT_LIMIT_MS);
  h.advance(MERGE_WAIT_LIMIT_MS);
  await h.sweep();
  expect(h.merge("queued-1")).toMatchObject({ state: "blocked",
    reason: `${MERGE_REASONS.conflict}; waiting for repository capacity held by refresh refresh-1`,
    readAt: iso(h.now()), nextReadAt: null });
  expect(h.creates).toHaveLength(1);
  expect(h.writes).toEqual([]);
  expect(h.merges()).toEqual([]);
  expect(h.pipeline("refresh-1")).toEqual(owner);
});

test("an out-of-window refresh defers an unattached reservation until capacity returns", async () => {
  const h = queuedRefreshes();
  h.setCreateMode("throw");
  await h.sweep();
  const reservation = structuredClone(h.merge("queued-0")!.refresh!);
  h.pipeline("queued-0").merge!.requestedAt = iso(T0 + 100);
  h.setCreateMode("ok");
  await h.sweep();
  expect(h.creates).toHaveLength(2);
  const owner = structuredClone(h.pipeline("refresh-1"));

  h.pipeline("queued-0").merge!.requestedAt = iso(T0 - 1);
  await h.run(5 * MERGE_POLL_MS);
  expect(h.creates).toHaveLength(2);
  expect(h.merge("queued-0")!.refresh).toEqual(reservation);
  expect(h.pipeline("refresh-1")).toEqual(owner);
  expect(h.writes).toEqual([]);
  expect(h.merges()).toEqual([]);

  h.pipeline("refresh-1").state = "closed";
  h.pipeline("refresh-1").delivery!.active = false;
  await h.sweep();
  expect(h.creates).toHaveLength(3);
  expect(h.merge("queued-0")!.refresh!.pipelineId).toBe("refresh-2");
});

test("out-of-window refresh capacity is reconstructed after a process restart", async () => {
  if (process.env.MERGE_CAPACITY_RESTART_FIXTURE) {
    const stored = JSON.parse(fs.readFileSync(process.env.MERGE_CAPACITY_RESTART_FIXTURE, "utf8")) as { lanes: Pipeline[]; prs: PullRequest[] };
    const h = harness(stored);
    h.prs.get(12)!.mergeStateStatus = "CLEAN";
    const owner = structuredClone(h.pipeline("refresh-1"));
    await h.run(MERGE_SETTLE_MS + MERGE_POLL_MS);
    expect(h.merge("queued-1")!.head).toBe(HEAD_A);
    expect(h.merge("queued-1")!.reason).toContain("refresh-1");
    expect(h.creates).toEqual([]);
    expect(h.writes).toEqual([]);
    expect(h.pipeline("refresh-1")).toEqual(owner);
    return;
  }
  const h = queuedRefreshes();
  await h.sweep();
  h.pipeline("queued-0").merge!.requestedAt = iso(T0 + 100);
  const lanes = h.ports.loadPipelines();
  const fixture = path.join(sandbox, "merge-capacity-restart.json");
  fs.writeFileSync(fixture, JSON.stringify({ lanes, prs: lanes.map(lane => h.prs.get(lane.delivery!.target.pr!)) }));
  const child = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern", "^out-of-window refresh capacity is reconstructed after a process restart$"], {
    env: { ...process.env, MERGE_CAPACITY_RESTART_FIXTURE: fixture }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit, `${stdout}\n${stderr}`).toBe(0);
});

test("an archived original preserves its completed refresh's queue position", async () => {
  const h = queuedRefreshes();
  await h.sweep();
  const archived = structuredClone(h.pipeline("queued-0"));
  h.remove(archived.id);
  const ancestryReads: string[][] = [];
  Object.assign(h.ports, { loadRefreshAncestors: (ids: readonly string[]) => {
    ancestryReads.push([...ids]);
    return ids.includes(archived.id) ? [archived] : [];
  } });
  const child = h.pipeline("refresh-1");
  child.state = "completed";
  child.closedAt = iso(T0 + 10 * MERGE_POLL_MS);
  child.delivery!.active = false;
  child.lastPassedCommit = "b".repeat(40);
  Object.assign(h.prs.get(11)!, { head: child.lastPassedCommit, mergeStateStatus: "CLEAN", checks: [] });
  h.advance(MERGE_POLL_MS);
  await h.sweep();
  expect(ancestryReads).toEqual([[archived.id]]);
  expect(h.merge("refresh-1")?.state).toBe("waiting-checks");
  expect(h.creates).toHaveLength(1);
  expect(h.merge("queued-1")?.head).toBeNull();
});

test("a refreshed carrier keeps the head slot when main moves again", async () => {
  const h = queuedRefreshes();
  await h.sweep();
  const head = "b".repeat(40);
  Object.assign(h.pipeline("refresh-1"), { state: "completed", lastPassedCommit: head });
  h.pipeline("refresh-1").delivery!.active = false;
  Object.assign(h.prs.get(11)!, { head, mergeStateStatus: "CLEAN", checks: [] });
  await h.sweep();
  h.setBase(MAIN_2);
  h.prs.get(11)!.mergeStateStatus = "BEHIND";
  h.advance(MERGE_POLL_MS);
  await h.sweep();
  expect(h.creates).toHaveLength(2);
  expect((h.creates[1]!.request as CreatePipelineRequest).delivery?.pr).toBe(11);
  expect(h.merge("queued-1")?.state).toBe("queued");
});

test("a second ready slot cannot merge ahead of the refreshing head", async () => {
  const h = queuedRefreshes();
  Object.assign(h.ports, { refreshConcurrency: 2 });
  h.prs.get(12)!.mergeStateStatus = "CLEAN";
  await h.run(5 * MERGE_POLL_MS);
  expect(h.creates).toHaveLength(1);
  expect(h.merges()).toHaveLength(0);
  expect(h.merge("queued-1")).toMatchObject({ state: "queued", reason: "queued behind PR #11 (pipeline refresh-1)" });
  expect(h.merge("queued-2")?.head).toBeNull();
});

test("persisted refresh reservations replay only within the head limit", async () => {
  const h = queuedRefreshes();
  h.setCreateMode("throw");
  await h.sweep();
  const reservation = structuredClone(h.merge("queued-0")!.refresh!);
  for (let index = 1; index < 12; index++) {
    const merge = h.pipeline(`queued-${index}`).merge!;
    merge.state = "refreshing";
    merge.refresh = { ...reservation, key: `refresh-reservation-${index}` };
  }
  h.setCreateMode("ok");
  await h.run(5 * MERGE_POLL_MS);
  expect(h.creates).toHaveLength(2); // First failed call, then the head replay.
  expect(h.merge("queued-0")!.refresh!.pipelineId).toBe("refresh-1");
  expect(h.merge("queued-1")!.refresh!.pipelineId).toBeNull();
});

test("refresh stages defer tier and account selection to live launch capacity", async () => {
  const { refreshRequest } = await import("./autoRefresh");
  const value = finished();
  value.merge = { prNumber: 11, refresh: { base: MAIN_1, head: HEAD_A } } as PipelineMerge;
  const request = refreshRequest(value);
  for (const stage of request.stages) {
    expect(stage).toMatchObject({ preferredServiceTier: "ultrafast", engine: "codex", model: "gpt-6.1-sol", effort: "high" });
    expect(stage.account).toBeUndefined();
    expect(stage.serviceTier).toBeUndefined();
  }
  expect(request.stages.map(stage => stage.role?.roleId)).toEqual(["merger", "reviewer", "merger"]);
});
