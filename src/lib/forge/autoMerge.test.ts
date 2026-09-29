import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import type { Pipeline, PipelineMerge } from "@/lib/pipelines/types";
import type { MergeOnReviewSetting } from "@/lib/projects/settings";

/* The merge runner (#2187 §4.3-§4.4) against a fake `gh` and clock: invented
   repositories, heads and checks, no network. The stores resolve their state
   directory at import, so a sandbox is pinned first; nothing here writes one. */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-auto-merge-"));
const previousStateDir = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = sandbox;

const {
  MERGE_POLL_MS, MERGE_REASONS, MERGE_SETTLE_MS, MERGE_WAIT_LIMIT_MS, lanePullRequest, mergeEligible, resetAutoMergeForTests, rollupChecks, sweepAutoMerge, sweepTaskFinishes,
} = await import("./autoMerge");
const { pipelineGraphError } = await import("../pipelines/store");

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const REPO = "acme/widgets";
const T0 = Date.parse("2026-09-25T10:00:00Z");
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const HEAD_C = "c".repeat(40);
const HEAD_X = "e".repeat(40);
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
const pending = (name: string): Check => ({ name, status: "IN_PROGRESS", conclusion: "" });
const red = (name: string): Check => ({ name, status: "COMPLETED", conclusion: "FAILURE" });

/** A fake GitHub: pull requests, commits, the base's required contexts, and
    what each `update-branch` does to its pull request. */
function harness(options: { setting?: Partial<MergeOnReviewSetting>; required?: string[]; lanes: Pipeline[]; prs: PullRequest[]; tasks?: string[] }) {
  let clock = T0;
  const calls: string[][] = [];
  const pipelines = new Map(options.lanes.map((pipeline) => [pipeline.id, structuredClone(pipeline)]));
  const prs = new Map(options.prs.map((pr) => [pr.number, pr]));
  const prOf = new Map(options.lanes.map((pipeline, index) => [pipeline.id, options.prs[index]!.number]));
  const commits = new Map<string, { parents: string[]; committer: string }>();
  const tasks = new Map((options.tasks ?? []).map((id) => [id, "assigned"]));
  let setting: MergeOnReviewSetting = { enabled: true, changedAt: iso(T0 - 3_600_000), changedBy: "operator", ...options.setting };
  let onUpdate: ((pr: PullRequest) => void) | null = null;
  let mergeRefusal: string | null = null;
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
    if (args[0] === "api" && args[1]?.startsWith(`repos/${REPO}/branches/`)) return JSON.stringify(options.required ?? []);
    if (args[0] === "repo" && args[1] === "view") return JSON.stringify({ squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: true });
    if (args[0] === "api" && args[1] === "-X" && args[2] === "PUT") {
      const number = Number(/pulls\/(\d+)\/update-branch/.exec(args[3]!)![1]);
      const pr = prs.get(number)!;
      const expected = args[5]!.replace("expected_head_sha=", "");
      if (expected !== pr.head) throw fail("gh: expected head sha didn’t match current head ref. (HTTP 422)");
      onUpdate?.(pr);
      return JSON.stringify({ message: "Updating pull request branch." });
    }
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
      return "";
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };

  const ports = {
    now: () => clock,
    run,
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
    cachedState: () => null,
    finishTask: (taskId: string) => {
      if (!tasks.has(taskId)) return "missing" as const;
      if (tasks.get(taskId) === "done") return "already-done" as const;
      tasks.set(taskId, "done");
      return "moved" as const;
    },
  };

  return {
    calls,
    prs,
    commits,
    merge: (id: string): PipelineMerge | undefined => pipelines.get(id)?.merge,
    pipeline: (id: string) => pipelines.get(id)!,
    taskStatus: (id: string) => tasks.get(id),
    setSetting: (next: Partial<MergeOnReviewSetting>) => { setting = { ...setting, ...next }; },
    onUpdate: (handler: (pr: PullRequest) => void) => { onUpdate = handler; },
    refuseMerges: (message: string) => { mergeRefusal = message; },
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

beforeEach(() => resetAutoMergeForTests());

describe("merge runner (#2187 §4.3-§4.4)", () => {
  test("a completed writable review queues, merges after green checks, then finishes its task", async () => {
    const completed = lane("L1");
    completed.taskIds = ["task-1"];
    completed.finishesTaskIds = ["task-1"];
    completed.stages[1]!.access = "read-write";
    completed.stages[1]!.effectiveRole = BUILDER as Pipeline["stages"][number]["effectiveRole"];
    completed.runs[1]!.attempts[0]!.effectiveRole = BUILDER as Pipeline["runs"][number]["attempts"][number]["effectiveRole"];
    completed.delivery = { target: { remote: "https://github.com/acme/widgets.git" } } as Pipeline["delivery"];
    completed.runs[1]!.attempts[0]!.report = { provenance: { pullRequest: { number: 11 } } } as Pipeline["runs"][number]["attempts"][number]["report"];
    expect(lanePullRequest(completed)).toEqual({ repository: REPO, number: 11 });
    const h = harness({ lanes: [completed], prs: [openPr(11)], tasks: ["task-1"] });
    await h.run(MERGE_SETTLE_MS + MERGE_POLL_MS * 2, () => h.merges().length > 0);
    await h.sweepFinishes();
    expect(h.merge("L1")).toMatchObject({ state: "merged", prNumber: 11 });
    expect(h.taskStatus("task-1")).toBe("done");
    expect(h.pipeline("L1").taskFinishes).toMatchObject([{ taskId: "task-1", outcome: "moved" }]);
  });

  test("a terminal read-only declared output keeps the reported PR head for merging", async () => {
    const completed = lane("L1", { head: HEAD_B });
    completed.delivery = { publish: "disabled", target: { remote: "https://github.com/acme/widgets.git" } } as Pipeline["delivery"];
    completed.stages.push({ id: "critique", kind: "run", prompt: "critique", next: null, outputs: ["docs/critique.md"], onFail: { to: "build", maxRounds: 2 }, effectiveRole: REVIEWER } as Pipeline["stages"][number]);
    completed.runs.push({ stageId: "critique", attempts: [{ n: 1, state: "passed", completedAt: completed.closedAt, effectiveRole: REVIEWER, report: { provenance: { head: HEAD_A } } }] } as unknown as Pipeline["runs"][number]);
    const h = harness({ lanes: [completed], prs: [openPr(11, { head: HEAD_A })] });
    await h.run(MERGE_SETTLE_MS + MERGE_POLL_MS * 2, () => h.merges().length > 0);
    expect(h.merge("L1")).toMatchObject({ state: "merged", reviewedHead: HEAD_B, chain: [HEAD_A] });
    expect(h.merges()).toHaveLength(1);
    const pushed = harness({ lanes: [completed], prs: [openPr(11, { head: HEAD_B })] });
    await pushed.run(MERGE_SETTLE_MS + MERGE_POLL_MS * 2, () => pushed.merges().length > 0);
    expect(pushed.merge("L1")).toMatchObject({ state: "merged", chain: [HEAD_B] });
    completed.publishedCommit = HEAD_A;
    const publishedProducer = harness({ lanes: [completed], prs: [openPr(11, { head: HEAD_A })] });
    await publishedProducer.run(MERGE_SETTLE_MS + MERGE_POLL_MS * 2, () => publishedProducer.merges().length > 0);
    expect(publishedProducer.merge("L1")).toMatchObject({ state: "merged", chain: [HEAD_A] });
    const changed = harness({ lanes: [completed], prs: [openPr(11, { head: HEAD_X })] });
    await changed.sweep();
    expect(changed.merge("L1")).toMatchObject({ state: "blocked", reason: MERGE_REASONS.headChanged });
  });

  test("a completed fail, writable fix, pass lane names an ancestor PR head as behind", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "llv-merge-fix-ancestor-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    try {
      git("init", "--initial-branch=main");
      git("config", "user.name", "Fixture");
      git("config", "user.email", "fixture");
      fs.writeFileSync(path.join(repo, "work.txt"), "build\n");
      git("add", "work.txt");
      git("commit", "-m", "build");
      const oldHead = git("rev-parse", "HEAD");
      fs.writeFileSync(path.join(repo, "work.txt"), "fix\n");
      git("add", "work.txt");
      git("commit", "-m", "fix");
      const reviewedHead = git("rev-parse", "HEAD");
      const completed = lane("L1", { head: reviewedHead, reviews: [
        { n: 1, state: "failed" }, { n: 2, state: "passed" },
      ] });
      completed.repoDir = repo;
      completed.stages.push({ id: "review-fix", kind: "run", prompt: "fix", next: "review", effectiveRole: BUILDER } as Pipeline["stages"][number]);
      completed.runs.push({ stageId: "review-fix", attempts: [{ n: 1, state: "passed", effectiveRole: BUILDER,
        report: { provenance: { head: reviewedHead } } }] } as unknown as Pipeline["runs"][number]);
      const reviews = completed.runs.find((run) => run.stageId === "review")!.attempts;
      reviews[0]!.report = { provenance: { head: oldHead } } as typeof reviews[0]["report"];
      reviews[1]!.report = { provenance: { head: reviewedHead } } as typeof reviews[1]["report"];
      const h = harness({ lanes: [completed], prs: [openPr(11, { head: oldHead })] });
      await h.sweep();
      expect(h.merge("L1")).toMatchObject({ state: "blocked", reason: `PR head is behind the reviewed head ${reviewedHead}` });
      expect(h.merges()).toHaveLength(0);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("behind-head reason uses the latest executed review when declaration order differs", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "llv-merge-review-order-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    try {
      git("init", "--initial-branch=main");
      git("config", "user.name", "Fixture");
      git("config", "user.email", "fixture");
      fs.writeFileSync(path.join(repo, "work.txt"), "reviewed by pre-review\n");
      git("add", "work.txt");
      git("commit", "-m", "build");
      const preReviewHead = git("rev-parse", "HEAD");
      fs.writeFileSync(path.join(repo, "work.txt"), "reviewed by final-review\n");
      git("commit", "-am", "apply fixes");
      const finalReviewHead = git("rev-parse", "HEAD");

      const stages = [
        { id: "build", kind: "run", prompt: "build", next: "pre-review", onFail: null, effectiveRole: BUILDER },
        { id: "final-review", kind: "run", prompt: "review", next: null, onFail: { to: "apply", maxRounds: 1 }, effectiveRole: REVIEWER },
        { id: "pre-review", kind: "run", prompt: "review", next: "apply", onFail: { to: "apply", maxRounds: 1 }, effectiveRole: REVIEWER },
        { id: "apply", kind: "run", prompt: "apply fixes", next: "final-review", onFail: null, effectiveRole: BUILDER },
      ] as Pipeline["stages"];
      expect(pipelineGraphError(stages)).toBeNull();

      const completed = lane("L1", { head: finalReviewHead });
      completed.repoDir = repo;
      completed.stages = stages;
      completed.runs = [
        { stageId: "build", attempts: [{ n: 1, state: "passed", completedAt: iso(T0 - 4_000), effectiveRole: BUILDER }] },
        { stageId: "final-review", attempts: [{ n: 1, state: "passed", completedAt: iso(T0 - 1_000), reviewHeadSha: finalReviewHead, effectiveRole: REVIEWER,
          report: { provenance: { head: finalReviewHead } } }] },
        { stageId: "pre-review", attempts: [{ n: 1, state: "passed", completedAt: iso(T0 - 3_000), reviewHeadSha: preReviewHead, effectiveRole: REVIEWER,
          report: { provenance: { head: preReviewHead } } }] },
        { stageId: "apply", attempts: [{ n: 1, state: "passed", completedAt: iso(T0 - 2_000), effectiveRole: BUILDER }] },
      ] as unknown as Pipeline["runs"];

      const h = harness({ lanes: [completed], prs: [openPr(11, { head: preReviewHead })] });
      await h.sweep();
      expect(h.merge("L1")).toMatchObject({ state: "blocked", reason: `PR head is behind the reviewed head ${finalReviewHead}` });
      expect(h.merges()).toHaveLength(0);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("an explicit review SHA wins over completion time after local declared output", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "llv-merge-reviewed-output-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    try {
      git("init", "--initial-branch=main");
      git("config", "user.name", "Fixture");
      git("config", "user.email", "fixture");
      fs.writeFileSync(path.join(repo, "work.txt"), "PR base\n");
      git("add", "work.txt");
      git("commit", "-m", "PR base");
      const prHead = git("rev-parse", "HEAD");
      fs.writeFileSync(path.join(repo, "work.txt"), "reviewed fix\n");
      git("commit", "-am", "reviewed fix");
      const reviewedHead = git("rev-parse", "HEAD");
      fs.writeFileSync(path.join(repo, "work.txt"), "local output\n");
      git("commit", "-am", "local output");
      const completed = lane("L1", { head: git("rev-parse", "HEAD") });
      completed.repoDir = repo;
      completed.delivery = { publish: "disabled", target: { remote: "https://github.com/acme/widgets.git" } } as Pipeline["delivery"];
      completed.runs[1]!.attempts[0]!.reviewHeadSha = reviewedHead;
      completed.runs[1]!.attempts[0]!.completedAt = completed.closedAt;
      completed.runs[1]!.attempts[0]!.report = { provenance: { head: reviewedHead } } as typeof completed.runs[1]["attempts"][number]["report"];
      completed.stages[1]!.next = "output";
      completed.stages.push({ id: "output", kind: "run", prompt: "write output", next: null, outputs: ["result.md"], effectiveRole: REVIEWER } as Pipeline["stages"][number]);
      completed.runs.push({ stageId: "output", attempts: [{ n: 1, state: "passed", completedAt: completed.closedAt,
        outputBaseHead: reviewedHead, effectiveRole: REVIEWER, report: { provenance: { head: reviewedHead } } }] } as unknown as Pipeline["runs"][number]);
      const behind = harness({ lanes: [completed], prs: [openPr(11, { head: prHead })] });
      await behind.sweep();
      expect(behind.merge("L1")).toMatchObject({ state: "blocked", reason: `PR head is behind the reviewed head ${reviewedHead}` });

      const outputBase = harness({ lanes: [completed], prs: [openPr(11, { head: reviewedHead })] });
      await outputBase.sweep();
      expect(outputBase.merge("L1")).toMatchObject({ chain: [reviewedHead] });
      expect(outputBase.merge("L1")?.state).not.toBe("blocked");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a divergent failed-attempt SHA is not reported as behind the reviewed head", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "llv-merge-divergent-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    try {
      git("init", "--initial-branch=main");
      git("config", "user.name", "Fixture");
      git("config", "user.email", "fixture");
      fs.writeFileSync(path.join(repo, "work.txt"), "base\n");
      git("add", "work.txt");
      git("commit", "-m", "base");
      const base = git("rev-parse", "HEAD");
      fs.writeFileSync(path.join(repo, "work.txt"), "rejected attempt\n");
      git("commit", "-am", "rejected attempt");
      const rejectedHead = git("rev-parse", "HEAD");
      git("reset", "--hard", base);
      fs.writeFileSync(path.join(repo, "work.txt"), "accepted retry\n");
      git("commit", "-am", "accepted retry");
      const reviewedHead = git("rev-parse", "HEAD");
      const completed = lane("L1", { head: reviewedHead, builds: [{ n: 1, state: "failed" }],
        reviews: [{ n: 1, state: "passed" }] });
      completed.repoDir = repo;
      completed.runs[0]!.attempts[0]!.report = { provenance: { head: rejectedHead } } as typeof completed.runs[0]["attempts"][number]["report"];
      completed.runs[1]!.attempts[0]!.report = { provenance: { head: reviewedHead } } as typeof completed.runs[1]["attempts"][number]["report"];
      const h = harness({ lanes: [completed], prs: [openPr(11, { head: rejectedHead })] });
      await h.sweep();
      expect(h.merge("L1")).toMatchObject({ state: "blocked", reason: MERGE_REASONS.headChanged });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a local reviewed descendant identifies a behind PR without stage reports", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "llv-merge-ancestor-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    try {
      git("init", "--initial-branch=main");
      git("config", "user.name", "Fixture");
      git("config", "user.email", "fixture");
      fs.writeFileSync(path.join(repo, "work.txt"), "build\n");
      git("add", "work.txt");
      git("commit", "-m", "build");
      const oldHead = git("rev-parse", "HEAD");
      fs.writeFileSync(path.join(repo, "work.txt"), "fix\n");
      git("add", "work.txt");
      git("commit", "-m", "fix");
      const reviewedHead = git("rev-parse", "HEAD");
      const completed = lane("L1", { head: reviewedHead });
      completed.repoDir = repo;
      completed.runs[1]!.attempts[0]!.completedAt = completed.closedAt;
      const h = harness({ lanes: [completed], prs: [openPr(11, { head: oldHead })] });
      await h.sweep();
      expect(h.merge("L1")).toMatchObject({ state: "blocked", reason: `PR head is behind the reviewed head ${reviewedHead}` });

      const unreviewed = lane("L2", { head: reviewedHead, reviews: [{ n: 1, state: "failed", budgetSpent: true }] });
      unreviewed.repoDir = repo;
      unreviewed.stages[1]!.onFail = { to: "review-fix", maxRounds: 1 };
      unreviewed.stages.push({ id: "review-fix", kind: "run", prompt: "fix", next: "review", effectiveRole: BUILDER } as Pipeline["stages"][number]);
      unreviewed.runs.push({ stageId: "review-fix", attempts: [{ n: 1, state: "passed", effectiveRole: BUILDER,
        activatedBy: { stageId: "review", attempt: 1, edge: "fail", budgetSpent: true } }] } as unknown as Pipeline["runs"][number]);
      const earlierReview = harness({ lanes: [unreviewed], prs: [openPr(11, { head: oldHead })] });
      await earlierReview.sweep();
      expect(earlierReview.merge("L2")).toMatchObject({ state: "blocked", reason: MERGE_REASONS.headChanged });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("CLEAN with settled green checks merges with --match-head-commit, and never before the checks settled", async () => {
    const h = harness({ lanes: [lane("L1")], prs: [openPr(11)] });
    await h.run(MERGE_SETTLE_MS - MERGE_POLL_MS);
    expect(h.merges()).toEqual([]);
    expect(h.merge("L1")?.state).toBe("waiting-checks");
    await h.run(MERGE_POLL_MS * 2, () => h.merges().length > 0);
    expect(h.merges()).toEqual([["pr", "merge", "11", "--repo", REPO, "--squash", "--match-head-commit", HEAD_A]]);
    const merge = h.merge("L1")!;
    expect(merge).toMatchObject({ state: "merged", by: "auto-merge", mergedHead: HEAD_A, method: "squash", prNumber: 11 });
    expect(merge.mergeCommit).toBe("f".repeat(40));
    expect(merge.chain).toEqual([HEAD_A]);
  });

  test("an empty rollup with CLEAN does not merge, and blocks after 3 min with no checks reported", async () => {
    const h = harness({ lanes: [lane("L1")], prs: [openPr(11, { checks: [] })] });
    await h.run(MERGE_SETTLE_MS - MERGE_POLL_MS);
    expect(h.merge("L1")?.state).toBe("waiting-checks");
    await h.run(MERGE_POLL_MS * 3);
    expect(h.merges()).toEqual([]);
    expect(h.merge("L1")).toMatchObject({ state: "blocked", reason: MERGE_REASONS.noChecks });
  });

  test("BEHIND updates the branch with the chain tip as expected_head_sha, then merges the update's head", async () => {
    const h = harness({ lanes: [lane("L1")], prs: [openPr(11, { mergeStateStatus: "BEHIND" })] });
    h.commits.set(HEAD_B, { parents: [HEAD_A, MAIN_1], committer: "web-flow" });
    h.onUpdate((pr) => Object.assign(pr, { head: HEAD_B, mergeStateStatus: "UNKNOWN", mergeable: "UNKNOWN", checks: [] }));
    await h.sweep();
    expect(h.updates()).toEqual([["api", "-X", "PUT", `repos/${REPO}/pulls/11/update-branch`, "-f", `expected_head_sha=${HEAD_A}`]]);
    expect(h.merge("L1")?.state).toBe("updating");
    /* GitHub registers the new head's checks, then they pass. */
    h.advance(MERGE_POLL_MS);
    await h.sweep();
    Object.assign(h.prs.get(11)!, { checks: [green("ci")], mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" });
    await h.run(MERGE_SETTLE_MS + MERGE_POLL_MS * 2, () => h.merges().length > 0);
    expect(h.merges()).toEqual([["pr", "merge", "11", "--repo", REPO, "--squash", "--match-head-commit", HEAD_B]]);
    expect(h.merge("L1")).toMatchObject({ state: "merged", chain: [HEAD_A, HEAD_B], mergedHead: HEAD_B });
    expect(h.merge("L1")!.updates).toEqual([{ requestedAt: expect.any(String), head: HEAD_B }]);
  });

  test("a partial rollup right after update-branch (fewer names than the previous head) does not merge", async () => {
    const h = harness({ lanes: [lane("L1")], prs: [openPr(11, { checks: [green("ci"), green("lint")], mergeStateStatus: "BEHIND" })] });
    h.commits.set(HEAD_B, { parents: [HEAD_A, MAIN_1], committer: "web-flow" });
    h.onUpdate((pr) => Object.assign(pr, { head: HEAD_B, mergeStateStatus: "CLEAN", checks: [green("ci")] }));
    await h.sweep();
    expect(h.updates()).toHaveLength(1);
    await h.run(MERGE_SETTLE_MS * 3);
    expect(h.merges()).toEqual([]);
    expect(h.merge("L1")).toMatchObject({ state: "waiting-checks", reason: "waiting for lint" });
    h.prs.get(11)!.checks = [green("ci"), green("lint")];
    await h.run(MERGE_POLL_MS * 2, () => h.merges().length > 0);
    expect(h.merges()).toHaveLength(1);
  });

  test("a rollup missing a required context waits until it arrives", async () => {
    const h = harness({ required: ["privacy-publication"], lanes: [lane("L1")], prs: [openPr(11)] });
    await h.run(MERGE_SETTLE_MS * 4);
    expect(h.merges()).toEqual([]);
    expect(h.merge("L1")).toMatchObject({ state: "waiting-checks", reason: "waiting for privacy-publication" });
    h.prs.get(11)!.checks = [green("ci"), green("privacy-publication")];
    await h.run(MERGE_POLL_MS * 2, () => h.merges().length > 0);
    expect(h.merges()).toHaveLength(1);
  });

  test("a set that grows between two reads restarts the wait", async () => {
    const h = harness({ lanes: [lane("L1")], prs: [openPr(11)] });
    await h.run(MERGE_SETTLE_MS - MERGE_POLL_MS);
    /* A workflow that registers late shows up, already green, on the read the
       merge would otherwise have happened on. */
    h.prs.get(11)!.checks = [green("ci"), green("late")];
    await h.sweep();
    expect(h.merges()).toEqual([]);
    expect(h.merge("L1")?.state).toBe("waiting-checks");
    h.advance(MERGE_POLL_MS);
    await h.sweep();
    expect(h.merges()).toHaveLength(1);
  });

  test("UNKNOWN and a null mergeable wait and never block, inside the 90-minute bound", async () => {
    const h = harness({ lanes: [lane("L1")], prs: [openPr(11, { mergeStateStatus: "UNKNOWN", mergeable: "UNKNOWN" })] });
    await h.run(30 * 60_000);
    expect(h.merge("L1")?.state).toBe("checking");
    Object.assign(h.prs.get(11)!, { mergeable: null });
    await h.run(30 * 60_000);
    expect(h.merges()).toEqual([]);
    expect(h.merge("L1")?.state).toBe("checking");
    Object.assign(h.prs.get(11)!, { mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" });
    await h.run(MERGE_POLL_MS, () => h.merges().length > 0);
    expect(h.merge("L1")?.state).toBe("merged");
  });

  test("two updates in a row keep the head in the chain", async () => {
    const h = harness({ lanes: [lane("L1")], prs: [openPr(11, { mergeStateStatus: "BEHIND" })] });
    h.commits.set(HEAD_B, { parents: [HEAD_A, MAIN_1], committer: "web-flow" });
    h.commits.set(HEAD_C, { parents: [HEAD_B, MAIN_2], committer: "web-flow" });
    let updates = 0;
    h.onUpdate((pr) => {
      updates += 1;
      /* After the first update main moves again, so the PR is behind once more. */
      Object.assign(pr, updates === 1 ? { head: HEAD_B, mergeStateStatus: "BEHIND" } : { head: HEAD_C, mergeStateStatus: "CLEAN" });
    });
    await h.run(MERGE_SETTLE_MS + MERGE_POLL_MS * 4, () => h.merges().length > 0);
    expect(h.updates().map((args) => args[5])).toEqual([`expected_head_sha=${HEAD_A}`, `expected_head_sha=${HEAD_B}`]);
    expect(h.merges()).toEqual([["pr", "merge", "11", "--repo", REPO, "--squash", "--match-head-commit", HEAD_C]]);
    expect(h.merge("L1")).toMatchObject({ state: "merged", chain: [HEAD_A, HEAD_B, HEAD_C] });
  });

  test("a one-parent web-flow head after an update blocks: the PR head changed after the lane finished", async () => {
    const h = harness({ lanes: [lane("L1")], prs: [openPr(11, { mergeStateStatus: "BEHIND" })] });
    /* A web-UI file edit is committed by web-flow too, with one parent. */
    h.commits.set(HEAD_X, { parents: [HEAD_A], committer: "web-flow" });
    h.onUpdate((pr) => Object.assign(pr, { head: HEAD_X, mergeStateStatus: "CLEAN" }));
    await h.run(MERGE_POLL_MS * 3);
    expect(h.merges()).toEqual([]);
    expect(h.merge("L1")).toMatchObject({ state: "blocked", reason: MERGE_REASONS.headChanged, chain: [HEAD_A] });
  });

  test("a push after the lane finished, with no update outstanding, blocks", async () => {
    const h = harness({ lanes: [lane("L1")], prs: [openPr(11, { head: HEAD_X })] });
    h.commits.set(HEAD_X, { parents: [HEAD_A, MAIN_1], committer: "web-flow" });
    await h.sweep();
    expect(h.merge("L1")).toMatchObject({ state: "blocked", reason: MERGE_REASONS.headChanged });
  });

  test("pending checks time out at 90 min, and not before", async () => {
    const h = harness({ lanes: [lane("L1")], prs: [openPr(11, { checks: [green("ci"), pending("e2e")], mergeStateStatus: "UNSTABLE" })] });
    await h.run(MERGE_WAIT_LIMIT_MS - MERGE_POLL_MS);
    expect(h.merge("L1")?.state).toBe("waiting-checks");
    await h.run(MERGE_POLL_MS * 2);
    expect(h.merges()).toEqual([]);
    expect(h.merge("L1")).toMatchObject({ state: "blocked", reason: MERGE_REASONS.checksTimeout });
  });

  test("a red check that branch protection does not require still blocks, with its name", async () => {
    const h = harness({ required: ["ci"], lanes: [lane("L1")], prs: [openPr(11, { checks: [green("ci"), red("slow")], mergeStateStatus: "UNSTABLE" })] });
    await h.sweep();
    expect(h.merges()).toEqual([]);
    expect(h.merge("L1")).toMatchObject({ state: "blocked", reason: 'check "slow" failed' });
  });

  test("DIRTY blocks: a conflict is never resolved by the runner", async () => {
    const h = harness({ lanes: [lane("L1")], prs: [openPr(11, { mergeStateStatus: "DIRTY", mergeable: "CONFLICTING", checks: [] })] });
    await h.sweep();
    expect(h.merge("L1")).toMatchObject({ state: "blocked", reason: MERGE_REASONS.conflict });
    expect(h.updates()).toEqual([]);
  });

  test("two lanes in one repository merge one at a time, in completion order", async () => {
    const h = harness({
      lanes: [lane("L2", { closedAt: T0 - 500, head: HEAD_B }), lane("L1", { closedAt: T0 - 5_000 })],
      prs: [openPr(22, { head: HEAD_B }), openPr(11)],
    });
    await h.run(MERGE_SETTLE_MS - MERGE_POLL_MS);
    /* Only the head of the queue is read. */
    expect(h.calls.some((args) => args[1] === "view" && args[2] === "22")).toBe(false);
    expect(h.merge("L2")?.state).toBe("queued");
    await h.run(MERGE_SETTLE_MS * 3, () => h.merges().length === 2);
    expect(h.merges().map((args) => args[2])).toEqual(["11", "22"]);
    expect(h.merge("L1")?.state).toBe("merged");
    expect(h.merge("L2")?.state).toBe("merged");
  });

  test("off, nothing calls gh at all, and no lane is queued", async () => {
    const h = harness({ setting: { enabled: false }, lanes: [lane("L1")], prs: [openPr(11)] });
    await h.run(MERGE_SETTLE_MS * 3);
    expect(h.calls).toEqual([]);
    expect(h.merge("L1")).toBeUndefined();
  });

  test("turning the setting off cancels a merge that only waits, and nothing calls gh pr merge", async () => {
    const h = harness({ lanes: [lane("L1")], prs: [openPr(11)] });
    await h.run(MERGE_POLL_MS);
    expect(h.merge("L1")?.state).toBe("waiting-checks");
    h.setSetting({ enabled: false });
    await h.run(MERGE_SETTLE_MS * 3);
    expect(h.merges()).toEqual([]);
    expect(h.merge("L1")).toMatchObject({ state: "cancelled", reason: MERGE_REASONS.settingOff });
  });

  test("a lane that completed before the setting went on is not queued", async () => {
    const h = harness({ setting: { changedAt: iso(T0) }, lanes: [lane("L1", { closedAt: T0 - 60_000 })], prs: [openPr(11)] });
    await h.run(MERGE_SETTLE_MS * 2);
    expect(h.calls).toEqual([]);
    expect(h.merge("L1")).toBeUndefined();
  });

  test("a merge GitHub refuses blocks with GitHub's words", async () => {
    const h = harness({ lanes: [lane("L1")], prs: [openPr(11)] });
    h.refuseMerges("GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)");
    await h.run(MERGE_SETTLE_MS + MERGE_POLL_MS, () => h.merges().length > 0);
    expect(h.merges()).toHaveLength(1);
    expect(h.merge("L1")).toMatchObject({
      state: "blocked",
      reason: "GitHub refused the merge: GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)",
    });
  });

  test("gh failing three reads in a row blocks as unreachable", async () => {
    const h = harness({ lanes: [lane("L1")], prs: [openPr(11)] });
    h.prs.delete(11);
    await h.run(MERGE_POLL_MS * 2);
    expect(h.merge("L1")?.state).toBe("blocked");
    expect(h.merge("L1")?.reason).toBe(MERGE_REASONS.unreachable);
    expect(h.merges()).toEqual([]);
  });
});

describe("eligibility (#2187 §4.2)", () => {
  test("a passed review is eligible; no review stage, or one still failed, is not", () => {
    expect(mergeEligible(lane("ok"))).toBe(true);
    const designReview = lane("design-review");
    designReview.stages[1]!.id = "design-review";
    designReview.stages[1]!.effectiveRole = BUILDER as Pipeline["stages"][number]["effectiveRole"];
    designReview.runs[1]!.stageId = "design-review";
    designReview.runs[1]!.attempts[0]!.effectiveRole = BUILDER as Pipeline["runs"][number]["attempts"][number]["effectiveRole"];
    expect(mergeEligible(designReview)).toBe(true);
    expect(mergeEligible(lane("no-review", {
      stages: [{ id: "build", kind: "run", prompt: "build", next: null, onFail: null, effectiveRole: BUILDER }],
    }))).toBe(false);
    expect(mergeEligible(lane("failed", { reviews: [{ n: 1, state: "failed" }] }))).toBe(false);
  });

  test("a spent budget whose last fix passed is eligible, and so is a skipped or accepted review", () => {
    const spent = lane("spent", {
      reviews: [{ n: 1, state: "failed" }, { n: 2, state: "failed", budgetSpent: true }],
      builds: [{ n: 1, state: "passed" }, { n: 2, state: "passed", activatedBy: { stageId: "review", attempt: 1, edge: "fail" } }, { n: 3, state: "passed", activatedBy: { stageId: "review", attempt: 2, edge: "fail", budgetSpent: true } }],
    });
    expect(mergeEligible(spent)).toBe(true);
    expect(mergeEligible(lane("skipped", { reviews: [{ n: 1, state: "skipped" }] }))).toBe(true);
    expect(mergeEligible(lane("accepted", { reviews: [{ n: 1, state: "failed", budgetSpent: true }], acceptances: [{ stageId: "review", attempt: 1 }] }))).toBe(true);
  });
});

describe("rollup reading", () => {
  test("a re-run supersedes the older run of the same name, and a pending run reads pending", () => {
    expect(rollupChecks([
      { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-09-25T06:00:00Z" },
      { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-25T06:05:00Z" },
      { __typename: "CheckRun", name: "slow", status: "IN_PROGRESS", conclusion: "", startedAt: "2026-09-25T06:05:00Z", completedAt: "0001-01-01T00:00:00Z" },
      { __typename: "StatusContext", context: "legacy", state: "ERROR" },
    ])).toEqual([
      { name: "ci", verdict: "green" },
      { name: "legacy", verdict: "red" },
      { name: "slow", verdict: "pending" },
    ]);
  });
});
