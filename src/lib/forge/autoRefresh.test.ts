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
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-auto-refresh-"));
const previousStateDir = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = sandbox;

const {
  MERGE_POLL_MS, MERGE_REASONS, lanePullRequest, resetAutoMergeForTests, sweepAutoMerge, sweepTaskFinishes,
} = await import("./autoMerge");
const { ForgeAppWriteRefused } = await import("./appWrite");

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
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
function harness(options: { setting?: Partial<MergeOnReviewSetting>; required?: string[]; lanes: Pipeline[]; prs: PullRequest[]; tasks?: string[]; strict?: boolean }) {
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
  const byKey = new Map<string, Pipeline>();
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

test("one conflict starts one visible refresh on the same task and delivery, without a forge write", async () => {
  const h = harness({ lanes: [finished()], prs: [conflicting()] });
  await h.run(30 * 60_000);
  expect(h.creates).toHaveLength(1);
  expect(h.merge("finished")).toMatchObject({ state: "refreshing", refresh: { pipelineId: "refresh-1", base: MAIN_1, head: HEAD_A, attempt: 0 } });
  expect(h.creates[0]).toMatchObject({
    request: { taskIds: ["task-one"], finishesTask: ["task-one"], delivery: { branch: "refs/heads/topic", pr: 11 }, publication: "remote-branch", autoStart: true,
      stages: [
        { id: "refresh", role: { roleId: "builder" }, next: "review", onFail: null },
        { id: "review", role: { roleId: "reviewer" }, next: null, onFail: { to: "fix", maxRounds: 1, onExhausted: "advance" } },
        { id: "fix", role: { roleId: "builder", params: { mode: "apply-fixes" } }, next: "review" },
      ] },
    options: { creationRequest: { key: "auto-refresh:finished:0" }, refreshOf: { pipelineId: "finished", base: MAIN_1, lineage: { srcConversationId: "seat-one" } } },
  });
  expect(h.writes).toHaveLength(0);
});


test("spent review budget with its final passed fix may refresh", async () => {
  const value = finished();
  value.runs[1]!.attempts[0]!.state = "failed";
  value.runs[1]!.attempts[0]!.budgetSpent = true;
  value.runs[0]!.attempts[0]!.activatedBy = { edge: "fail", budgetSpent: true, stageId: "review", attempt: 1 };
  const h = harness({ lanes: [value], prs: [conflicting()] });
  await h.sweep();
  expect(h.creates).toHaveLength(1);
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
  for (const instruction of ["needs_decision", "file:line", "@@", "git merge --abort", "Never guess", "noreply", "machine identity"]) {
    expect(request.stages[0]!.prompt).toContain(instruction);
  }
  expect(request.stages[1]!.prompt).toContain("git show --remerge-diff");
  h.pipeline("refresh-1").state = "needs_decision";
  h.pipeline("refresh-1").stateDetail = "src/example.ts:12 @@ -9,6 +9,7 @@ changes either side's behaviour";
  await h.run(30 * 60_000);
  expect(h.merge("finished")?.state).toBe("refreshing");
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
  expect((h.creates[0]!.options as RefreshOptions).creationRequest.key).toBe("auto-refresh:finished:1");
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
  expect(request.stages[0]!.prompt).toContain("machine identity");
  expect(request.stages[0]!.prompt).toContain("Never rebase, force-push or call GitHub update-branch");
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
