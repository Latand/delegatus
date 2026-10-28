import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { deepFreeze } from "@/lib/deepFreeze";
import type { Pipeline, PipelineMerge } from "@/lib/pipelines/types";
import type { MergeOnReviewSetting } from "@/lib/projects/settings";

/* The merge runner (#2187 §4.3-§4.4) against a fake `gh` and clock: invented
   repositories, heads and checks, no network. The stores resolve their state
   directory at import, so a sandbox is pinned first; nothing here writes one. */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-auto-merge-"));
const previousStateDir = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = sandbox;

const {
  MERGE_POLL_MS, MERGE_REASONS, MERGE_SETTLE_MS, MERGE_WAIT_LIMIT_MS, lanePullRequest, mergeEligible, resetAutoMergeForTests, rollupChecks, scheduleAutoMerge, sweepAutoMerge, sweepTaskFinishes,
} = await import("./autoMerge");
const { ForgeAppTokenSource, ForgeAppWriteRefused, forgeAppWriter, forgeWriter } = await import("./appWrite");
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
  reviews?: Review[];
  reviewRead?: string;
};

type Review = { user: { login: string; type: string }; state: string };
const review = (state: string, login = "reviewer-a", type = "User"): Review => ({ user: { login, type }, state });

const green = (name: string): Check => ({ name, status: "COMPLETED", conclusion: "SUCCESS" });
const pending = (name: string): Check => ({ name, status: "IN_PROGRESS", conclusion: "" });
const red = (name: string): Check => ({ name, status: "COMPLETED", conclusion: "FAILURE" });

/** A fake GitHub: pull requests, commits, the base's required contexts, and
    legacy update receipts; any new GitHub branch update is refused. */
function harness(options: { setting?: Partial<MergeOnReviewSetting>; required?: string[]; classicRead?: string; rulesRead?: string; rulesRefusal?: boolean; queuedMerge?: "unreadable" | "open" | "malformed"; lanes: Pipeline[]; prs: PullRequest[]; tasks?: string[] }) {
  let clock = T0;
  const calls: string[][] = [];
  const logs: string[] = [];
  const pipelines = new Map(options.lanes.map((pipeline) => [pipeline.id, structuredClone(pipeline)]));
  const prs = new Map(options.prs.map((pr) => [pr.number, pr]));
  const prOf = new Map(options.lanes.map((pipeline, index) => [pipeline.id, options.prs[index]!.number]));
  const commits = new Map<string, { parents: string[]; committer: string }>();
  const tasks = new Map((options.tasks ?? []).map((id) => [id, "assigned"]));
  let setting: MergeOnReviewSetting = { enabled: true, changedAt: iso(T0 - 3_600_000), changedBy: "operator", ...options.setting };
  let mergeRefusal: string | null = null;
  let failConfirmation = false;
  let afterMutation: ((pipeline: Pipeline) => Promise<void>) | null = null;
  const fail = (stderr: string) => Object.assign(new Error("Command failed: gh"), { stderr });

  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view") {
      if (failConfirmation) {
        failConfirmation = false;
        if (options.queuedMerge === "malformed") return "{}";
        throw fail("confirmation unavailable");
      }
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
    if (args[0] === "api" && /\/pulls\/\d+\/reviews/.test(args[1] ?? "")) {
      expect(args).toContain("--paginate");
      expect(args).toContain("--jq");
      const pr = prs.get(Number(/pulls\/(\d+)/.exec(args[1]!)![1]))!;
      if (pr.reviewRead === "refused") throw fail("reviews unavailable");
      return pr.reviewRead ?? (pr.reviews ?? []).map((review) => JSON.stringify({ reviewer: review.user.login, isBot: review.user.type === "Bot", state: review.state })).join("\n");
    }
    if (args[0] === "api" && args[1]?.startsWith(`repos/${REPO}/rules/branches/`)) {
      expect(args.slice(2)).toEqual(["--paginate", "--jq", "@json"]);
      if (options.rulesRefusal) throw fail("branch rules unavailable");
      return options.rulesRead ?? "[]";
    }
    if (args[0] === "api" && args[1]?.startsWith(`repos/${REPO}/branches/`)) return options.classicRead ?? JSON.stringify(options.required ?? []);
    if (args[0] === "api" && /\/issues\/\d+\/comments/.test(args[1] ?? "")) return "";
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
      if (options.queuedMerge === "unreadable" || options.queuedMerge === "malformed") failConfirmation = true;
      else if (!options.queuedMerge) pr.state = "MERGED";
      return "";
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };

  const writes: Array<{ args: string[]; repository: string }> = [];
  let writeRefusal: string | null = null;
  const ports = {
    log: (line: string) => { logs.push(line); },
    now: () => clock,
    run,
    write: async (args: string[], repository: string, beforeDispatch?: () => void) => {
      beforeDispatch?.();
      writes.push({ args, repository });
      if (writeRefusal) throw new ForgeAppWriteRefused(writeRefusal);
      return run(args);
    },
    loadPipelines: () => [...pipelines.values()].map((pipeline) => deepFreeze(structuredClone(pipeline))),
    mutate: async (id: string, change: (pipeline: Pipeline) => boolean) => {
      const pipeline = pipelines.get(id);
      if (!pipeline) return false;
      const draft = structuredClone(pipeline);
      if (!change(draft)) return false;
      pipelines.set(id, draft);
      if (afterMutation) await afterMutation(draft);
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
    logs,
    ports,
    prs,
    commits,
    merge: (id: string): PipelineMerge | undefined => pipelines.get(id)?.merge,
    pipeline: (id: string) => pipelines.get(id)!,
    taskStatus: (id: string) => tasks.get(id),
    setSetting: (next: Partial<MergeOnReviewSetting>) => { setting = { ...setting, ...next }; },
    refuseMerges: (message: string) => { mergeRefusal = message; },
    afterMutation: (callback: (pipeline: Pipeline) => Promise<void>) => { afterMutation = callback; },
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

/** Replay a durable update issued by an older runner; new writes are forbidden. */
function retainedUpdate(h: ReturnType<typeof harness>, head: string, extra: Partial<PullRequest> = {}) {
  const merge = h.merge("L1")!;
  merge.updates.push({ requestedAt: iso(h.now()), head: null });
  Object.assign(merge, { state: "updating", head: null, headSeenAt: null, lastChecks: null, nextReadAt: null });
  Object.assign(h.prs.get(11)!, { head, ...extra });
}

beforeEach(() => resetAutoMergeForTests());

test("regression: task finishes continue while the optional post-merge forge read is held", async () => {
  const completed = lane("L1");
  completed.taskIds = ["task-1", "task-2"];
  completed.finishesTaskIds = ["task-1"];
  const h = harness({ lanes: [completed], prs: [openPr(11)], tasks: ["task-1", "task-2"] });
  await h.run(MERGE_SETTLE_MS + MERGE_POLL_MS * 2, () => h.merges().length > 0);
  expect(h.merge("L1")?.state).toBe("merged");
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const readEntered = new Promise<void>(resolve => { entered = resolve; });
  let reads = 0;
  const run = h.ports.run;
  const ports = { ...h.ports, prepareRead: async () => {}, run: async (args: string[]) => {
    if (args[1]?.endsWith("/commits/main")) {
      reads++; entered(); await held;
      throw new Error("optional forge read unavailable");
    }
    return run(args);
  } };
  const host = globalThis as typeof globalThis & { __llvAutoMergeRunning?: Promise<unknown> | null; __llvPostMergeRunning?: Promise<unknown> | null };
  let recovery: Promise<unknown> | null | undefined;
  try {
    scheduleAutoMerge(ports);
    recovery = host.__llvPostMergeRunning;
    await readEntered;
    await host.__llvAutoMergeRunning;
    expect(h.taskStatus("task-1")).toBe("done");
    h.pipeline("L1").finishesTaskIds!.push("task-2");
    h.advance(60_000);
    scheduleAutoMerge(ports);
    await host.__llvAutoMergeRunning;
    expect(h.taskStatus("task-2")).toBe("done");
    expect(reads).toBe(1);
  } finally {
    release();
    await host.__llvAutoMergeRunning;
    await recovery;
    await host.__llvPostMergeRunning;
  }
  expect(h.pipeline("L1").taskFinishes?.map(finish => finish.taskId)).toEqual(["task-1", "task-2"]);
});

test.each(["ordinary", "watched"] as const)("regression: a held %s read cannot delay recovery enrolled on a later controller tick", async heldKind => {
  const watched = lane("watched");
  watched.merge = { state: "merged", by: "auto-merge", postMergeWatch: true, repository: REPO, prNumber: 12, mergeCommit: HEAD_B,
    recovery: { firstRedAt: iso(T0 - 60 * 60_000), failures: [{ name: "ci", excerpt: "failed" }], fixPipelineId: "fix" } } as PipelineMerge;
  watched.merge.postMergeWatch = false;
  const blocked = lane("ordinary");
  if (heldKind === "watched") blocked.merge = { ...watched.merge, repository: "acme/held", prNumber: 11, mergeCommit: HEAD_C, postMergeWatch: true };
  const h = harness({ lanes: [blocked, watched], prs: [openPr(11), openPr(12, { state: "MERGED" })], required: ["ci"] });
  let release!: () => void; let entered!: () => void; let recorded!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const readEntered = new Promise<void>(resolve => { entered = resolve; });
  const revertRecorded = new Promise<void>(resolve => { recorded = resolve; });
  let recoveryReads = 0; let revertWrites = 0;
  const ports = { ...h.ports, prepareRead: async () => {},
    run: async (args: string[]) => {
      if ((heldKind === "ordinary" && args[0] === "pr" && args[1] === "view" && args[2] === "11") || args[1]?.endsWith("repos/acme/held/commits/main")) {
        entered(); await held; throw new Error("held forge read unavailable");
      }
      if (args[1]?.startsWith("repos/acme/held/branches/")) return JSON.stringify(["ci"]);
      if (args[1]?.startsWith("repos/acme/held/rules/")) return "[]";
      if (args[1]?.endsWith("/commits/main")) { recoveryReads++; return JSON.stringify({ sha: HEAD_B }); }
      if (args[1]?.includes("check-runs")) return JSON.stringify({ name: "ci", status: "completed", conclusion: "failure", completed_at: iso(T0) });
      if (args[1]?.includes("/status")) return "";
      if (args[1]?.includes("pulls?")) return "";
      if (args[1]?.endsWith("/pulls/12")) return JSON.stringify({ node_id: "PR_fixture" });
      return h.ports.run(args);
    },
    write: async () => { revertWrites++; return JSON.stringify({ data: { revertPullRequest: { revertPullRequest: { number: 13 } } } }); },
    mutate: async (id: string, change: (pipeline: Pipeline) => boolean) => {
      const changed = await h.ports.mutate(id, change);
      if (h.merge("watched")?.recovery?.revertPr) recorded();
      return changed;
    },
  };
  const host = globalThis as typeof globalThis & { __llvAutoMergeRunning?: Promise<unknown> | null; __llvPostMergeRunning?: Promise<unknown> | null };
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let firstRecovery: Promise<unknown> | null | undefined;
  try {
    scheduleAutoMerge(ports);
    firstRecovery = host.__llvPostMergeRunning;
    await readEntered;
    h.pipeline("watched").merge!.postMergeWatch = true;
    h.advance(60_000);
    scheduleAutoMerge(ports);
    await Promise.race([revertRecorded, new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error("watched recovery waited for an unrelated forge read")), 2000);
    })]);
    expect(recoveryReads).toBe(2);
    expect(revertWrites).toBe(1);
    const { postMergeSeatSignals } = await import("./postMerge");
    expect(postMergeSeatSignals([h.pipeline("watched")], "repo-fixture")).toHaveLength(1);
  } finally {
    clearTimeout(deadline); release();
    await firstRecovery;
    await host.__llvAutoMergeRunning;
    await host.__llvPostMergeRunning;
  }
});

test.each([
  ["before-write", "success"], ["credential-mint", "success"], ["in-flight", "success"],
  ["in-flight", "refused"], ["in-flight", "lost-reply"],
] as const)("operator rejection at merge reconciles the actual effect: %s / %s", async (phase, outcome) => {
  const { admitProactiveTask, decideProactiveTask, proactiveDecisionToken } = await import("@/lib/tasks/proactive");
  const { candidate, context, authority, NOW } = await import("@/lib/tasks/proactive.fixture");
  const project = `atlas-merge-${phase}-${outcome}`;
  const { task } = await admitProactiveTask({ ...candidate(`merge-${phase}`), project }, { ...context(), project }, undefined, authority());
  const completed = lane("proactive-merge");
  completed.taskIds = [task.id];
  const h = harness({ lanes: [completed], prs: [openPr(11)] });
  if (outcome === "refused") h.refuseMerges("fixture merge refused");
  await h.sweep();
  expect(h.writes).toEqual([]);
  await decideProactiveTask(task.id, "adopt", "operator", proactiveDecisionToken(task), undefined, () => new Date(NOW).toISOString());
  let rejected = false;
  const reject = async () => {
    if (rejected) return;
    await decideProactiveTask(task.id, "reject", "operator", proactiveDecisionToken(task));
    rejected = true;
  };
  if (phase === "before-write") h.afterMutation(async pipeline => { if (pipeline.merge?.state === "merging") await reject(); });
  else {
    const actualWrite = h.ports.write;
    h.ports.write = forgeWriter(h.ports.run, forgeAppWriter(sandbox, 1_000, {
      source: { HOME: sandbox, NODE_ENV: "test" },
      tokens: new ForgeAppTokenSource(async () => {
        if (phase === "credential-mint") await reject();
        return { token: "fixture", expiresAt: null };
      }),
      exec: async args => {
        // exec is the real dispatch seam: rejection here follows write start.
        if (phase === "in-flight") await reject();
        const reply = await actualWrite(args, REPO);
        if (outcome === "lost-reply") throw new Error("fixture merge acknowledgement was lost");
        return reply;
      },
    }), () => true);
  }
  await h.run(MERGE_SETTLE_MS + MERGE_POLL_MS * 3);
  expect(rejected).toBe(true);
  if (phase !== "in-flight") {
    expect(h.writes).toEqual([]);
    expect(h.merge(completed.id)).toMatchObject({ state: "blocked", reason: expect.stringContaining("rejected") });
  } else {
    expect(h.merges()).toHaveLength(1);
    expect(h.merge(completed.id)).toMatchObject(outcome === "refused"
      ? { state: "blocked", reason: expect.stringContaining("fixture merge refused") }
      : { state: "merged", by: "auto-merge" });
  }
});

test("proactive scope approval cannot count as the implementation's result review", () => {
  const record = lane("proactive-scope-only");
  record.stages.reverse();
  record.stages[0]!.next = "build";
  record.stages[1]!.next = null;
  record.proactiveTaskIds = ["proactive-outcome"];
  expect(mergeEligible(record)).toBe(false);
  delete record.proactiveTaskIds;
  expect(mergeEligible(record)).toBe(true);
});

test.each([false, true])("an unconfirmed proactive merge survives restart and only reconciles its receipt (revoked: %s)", async revoked => {
  const { admitProactiveTask, decideProactiveTask, proactiveDecisionToken } = await import("@/lib/tasks/proactive");
  const { candidate, context, authority } = await import("@/lib/tasks/proactive.fixture");
  const { buildPipeline, savePipelines, findPipelineRecord, isStoredPipeline } = await import("@/lib/pipelines/store");
  const project = `unconfirmed-merge-${revoked}`;
  const { task } = await admitProactiveTask({ ...candidate("unconfirmed-merge"), project }, { ...context(), project }, undefined, authority());
  await decideProactiveTask(task.id, "adopt", "operator", proactiveDecisionToken(task));
  const completed = lane(`unconfirmed-${revoked}`);
  completed.taskIds = [task.id]; completed.proactiveTaskIds = [task.id];
  // Receipt recovery begins after result review of this exact head.
  completed.stages[1]!.role = { roleId: "reviewer" };
  const { resolvePipelineRole, pipelineRoleLookup } = await import("@/lib/pipelines/roles");
  const reviewer = resolvePipelineRole(completed.stages[1]!, "run", pipelineRoleLookup, project);
  if (!reviewer.role) throw new Error(reviewer.error);
  completed.stages[1]!.effectiveRole = reviewer.role;
  completed.runs[1]!.attempts[0]!.effectiveRole = reviewer.role;
  completed.runs[1]!.attempts[0]!.reviewHeadSha = HEAD_A;
  const h = harness({ lanes: [completed], prs: [openPr(11)] });
  const run = h.ports.run;
  const write = h.ports.write;
  let began = false;
  h.ports.run = async args => {
    if (began && args[0] === "pr" && args[1] === "view") throw new Error("fixture receipt unavailable");
    return run(args);
  };
  h.ports.write = async (args, repository, beforeDispatch) => {
    const result = await write(args, repository, beforeDispatch);
    began = true;
    if (revoked) await decideProactiveTask(task.id, "reject", "operator", proactiveDecisionToken(task));
    throw new Error(`fixture acknowledgement lost after ${result.length} response bytes`);
  };
  await h.run(MERGE_SETTLE_MS + MERGE_POLL_MS * 3);
  expect(h.merges()).toHaveLength(1);
  expect(h.merge(completed.id)).toMatchObject({ state: "blocked", effectUncertain: true });
  const stored = buildPipeline({ id: completed.id, task: completed.task, taskIds: completed.taskIds, project,
    repoDir: "/repo", stages: completed.stages, srcPath: null, srcConversationId: null, now: iso(T0) });
  stored.state = "completed"; stored.cursor = null; stored.closedAt = iso(T0);
  stored.lastPassedCommit = HEAD_A; stored.proactiveTaskIds = [task.id]; stored.merge = h.merge(completed.id);
  expect(isStoredPipeline({ ...stored, merge: { ...stored.merge, effectUncertain: "invalid" } })).toBe(false);
  savePipelines([stored]);
  const child = Bun.spawn([process.execPath, path.join(process.cwd(), "src/lib/tasks/proactive.fixture.ts"), "unused", stored.id, "pipeline-record"],
    { env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  let decoded: Pipeline;
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(err);
    decoded = JSON.parse(out.split("RESULT ")[1]!);
    expect(decoded.merge).toEqual(findPipelineRecord(stored.id)!.merge);
    expect(decoded.merge?.effectUncertain).toBe(true);
  } finally { if (child.exitCode === null) child.kill(); await child.exited; }
  const recovered = harness({ lanes: [{ ...completed, merge: decoded!.merge }, lane("accepted-merge", { closedAt: T0 + 1_000 })],
    prs: [openPr(11), openPr(12)] });
  let receipt: "OPEN" | "MERGED" | "unreadable" = "OPEN";
  let receiptReads = 0;
  const read = recovered.ports.run;
  recovered.ports.run = async args => {
    if (args[0] === "pr" && args[1] === "view" && args[2] === "11") {
      receiptReads++;
      if (receipt === "unreadable") throw new Error("fixture receipt unavailable");
      return harness({ lanes: [], prs: [openPr(11, { state: receipt })] }).ports.run(args);
    }
    return read(args);
  };
  recovered.advance(MERGE_SETTLE_MS + MERGE_POLL_MS * 5);
  await recovered.sweep();
  expect(recovered.merges()).toHaveLength(0);
  expect(recovered.merge(completed.id)).toMatchObject({ state: "blocked", effectUncertain: true });
  // A retry may requeue the row between the inventory read and queue assembly.
  // Its unconfirmed receipt keeps custody without occupying accepted work's slot.
  const readRows = recovered.ports.loadPipelines;
  let snapshots = 0;
  recovered.ports.loadPipelines = () => {
    if (++snapshots === 2) {
      const retry = recovered.pipeline(completed.id).merge!;
      retry.state = "queued"; retry.attempts++; retry.reason = null; retry.blockedAt = null;
      retry.readFailures = 0; retry.nextReadAt = null; retry.head = null; retry.headSeenAt = null;
      retry.lastChecks = null; retry.updatedAt = iso(recovered.now() + 1);
    }
    return readRows();
  };
  recovered.advance(MERGE_SETTLE_MS + MERGE_POLL_MS);
  try { await recovered.sweep(); } finally { recovered.ports.loadPipelines = readRows; }
  expect(recovered.merges().filter(args => args[2] === "12")).toHaveLength(1);
  expect(recovered.merges().filter(args => args[2] === "11")).toHaveLength(0);
  receipt = "unreadable"; recovered.advance(MERGE_WAIT_LIMIT_MS + MERGE_POLL_MS);
  // Retry cleared the head clock. Missing proof must remain paced past the
  // ordinary read-failure cap as well as a retained head's wait deadline.
  for (let failure = 1; failure <= 3; failure++) {
    await recovered.sweep();
    expect(recovered.merge(completed.id)).toMatchObject({ state: "blocked", effectUncertain: true, readFailures: failure });
    expect(Date.parse(recovered.merge(completed.id)!.nextReadAt!)).toBe(recovered.now() + MERGE_POLL_MS);
    recovered.advance(MERGE_POLL_MS);
  }
  recovered.pipeline(completed.id).merge!.headSeenAt = iso(recovered.now() - MERGE_WAIT_LIMIT_MS);
  await recovered.sweep();
  expect(Date.parse(recovered.merge(completed.id)!.nextReadAt!)).toBe(recovered.now() + MERGE_POLL_MS);
  const calls = receiptReads;
  await recovered.sweep();
  expect(receiptReads).toBe(calls);
  receipt = "MERGED"; recovered.advance(MERGE_POLL_MS);
  await recovered.sweep();
  expect(recovered.merge(completed.id)).toMatchObject({ state: "merged", by: "auto-merge" });
  expect(recovered.merge(completed.id)?.effectUncertain).toBeUndefined();
  expect(recovered.merges().filter(args => args[2] === "11")).toHaveLength(0);
  savePipelines([{ ...stored, merge: recovered.merge(completed.id) }]);
  expect(findPipelineRecord(stored.id)?.merge?.effectUncertain).toBeUndefined();
});

describe("outstanding human reviews (#2866)", () => {
  test.each(["CLEAN", "HAS_HOOKS", "UNSTABLE", "BLOCKED", "BEHIND", "DIRTY", "UNKNOWN", "DRAFT"])("CHANGES_REQUESTED blocks in %s", async (mergeStateStatus) => {
    const h = harness({ required: ["ci"], lanes: [lane("L1")], prs: [openPr(11, { mergeStateStatus, reviewDecision: "CHANGES_REQUESTED" })] });
    await h.run(MERGE_SETTLE_MS + MERGE_POLL_MS);
    expect(h.merge("L1")).toMatchObject({ state: "blocked", reason: "a reviewer requested changes" });
    expect(h.writes).toEqual([]);
  });

  test("an empty reviewDecision still blocks on a human change request", async () => {
    const h = harness({ lanes: [lane("L1")], prs: [openPr(11, { reviews: [review("CHANGES_REQUESTED")] })] });
    await h.run(MERGE_SETTLE_MS + MERGE_POLL_MS);
    expect(h.merge("L1")).toMatchObject({ state: "blocked", reason: "a reviewer requested changes" });
    expect(h.writes).toEqual([]);
  });

  test("a comment or another reviewer's approval does not clear a human change request", async () => {
    const h = harness({ lanes: [lane("L1")], prs: [openPr(11, { reviews: [review("CHANGES_REQUESTED"), review("COMMENTED"), review("APPROVED", "reviewer-b")] })] });
    await h.run(MERGE_SETTLE_MS + MERGE_POLL_MS);
    expect(h.merge("L1")?.reason).toBe("a reviewer requested changes");
    expect(h.writes).toEqual([]);
  });

  test.each(["APPROVED", "DISMISSED"])("the same reviewer's later %s clears the request across review pages", async (state) => {
    const h = harness({ lanes: [lane("L1")], prs: [openPr(11, {
      reviews: [review("CHANGES_REQUESTED"), review(state)],
    })] });
    await h.run(MERGE_SETTLE_MS + MERGE_POLL_MS);
    expect(h.merge("L1")?.state).toBe("merged");
    expect(h.merges()).toHaveLength(1);
  });

  test.each(["", "CHANGES_REQUESTED"])("bot and agent change requests do not block (decision %s)", async (reviewDecision) => {
    const h = harness({ lanes: [lane("L1")], prs: [openPr(11, { reviewDecision,
      reviews: [review("CHANGES_REQUESTED", "review-agent", "Bot"), review("CHANGES_REQUESTED", "review-agent[bot]")],
    })] });
    await h.run(MERGE_SETTLE_MS + MERGE_POLL_MS);
    expect(h.merge("L1")?.state).toBe("merged");
  });

  test("COMMENTED and PENDING reviews alone do not block", async () => {
    const h = harness({ lanes: [lane("L1")], prs: [openPr(11, { reviews: [review("COMMENTED"), review("PENDING")] })] });
    await h.run(MERGE_SETTLE_MS + MERGE_POLL_MS);
    expect(h.merge("L1")?.state).toBe("merged");
  });

  test.each(["refused", "{}", "[[{}]]"])("an unreadable review history (%s) never authorizes a merge", async (reviewRead) => {
    const h = harness({ lanes: [lane("L1")], prs: [openPr(11, { reviewRead })] });
    await h.run(MERGE_SETTLE_MS + MERGE_POLL_MS);
    expect(h.merge("L1")).toMatchObject({ state: "blocked", reason: MERGE_REASONS.unreachable });
    expect(h.writes).toEqual([]);
  });

  test("REVIEW_REQUIRED keeps the branch-protection reason", async () => {
    const h = harness({ lanes: [lane("L1")], prs: [openPr(11, { mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" })] });
    await h.run(MERGE_SETTLE_MS + MERGE_POLL_MS);
    expect(h.merge("L1")?.reason).toBe(MERGE_REASONS.reviewRequired);
  });
});

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
      expect(earlierReview.merge("L2")).toBeUndefined();
      expect(earlierReview.merges()).toEqual([]);
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

  test("required green checks merge after settling while Docker remains pending", async () => {
    const required = ["privacy-publication", "privacy-tracker-audit"];
    const h = harness({ required, lanes: [lane("L1")], prs: [openPr(11, {
      checks: [...required.map(green), pending("Docker")],
    })] });
    await h.run(MERGE_SETTLE_MS - MERGE_POLL_MS);
    expect(h.merges()).toEqual([]);
    await h.run(MERGE_POLL_MS * 2, () => h.merges().length > 0);
    expect(h.merge("L1")?.state).toBe("merged");
    expect(h.merges()).toHaveLength(1);
    expect(h.prs.get(11)!.checks.at(-1)).toEqual(pending("Docker"));
  });

  test("a pending required context holds a CLEAN PR until it turns green", async () => {
    const required = ["privacy-publication", "privacy-tracker-audit"];
    const h = harness({ required, lanes: [lane("L1")], prs: [openPr(11, {
      checks: [green(required[0]!), pending(required[1]!), pending("Docker")],
    })] });
    await h.run(MERGE_SETTLE_MS * 4);
    expect(h.merges()).toEqual([]);
    expect(h.merge("L1")?.state).toBe("waiting-checks");
    h.prs.get(11)!.checks = [...required.map(green), pending("Docker")];
    await h.run(MERGE_POLL_MS * 2, () => h.merges().length > 0);
    expect(h.merges()).toHaveLength(1);
  });

  test("UNSTABLE with green required contexts merges while an optional job is pending", async () => {
    const required = ["privacy-publication", "privacy-tracker-audit"];
    const h = harness({ required, lanes: [lane("L1")], prs: [openPr(11, {
      checks: [...required.map(green), pending("Docker")], mergeStateStatus: "UNSTABLE",
    })] });
    await h.run(MERGE_SETTLE_MS + MERGE_POLL_MS * 2, () => h.merges().length > 0);
    expect(h.merge("L1")?.state).toBe("merged");
    expect(h.merges()).toHaveLength(1);
  });

  test("a retained update's head is admitted without another GitHub update", async () => {
    const h = harness({ lanes: [lane("L1")], prs: [openPr(11)] });
    await h.sweep();
    h.commits.set(HEAD_B, { parents: [HEAD_A, MAIN_1], committer: "web-flow" });
    retainedUpdate(h, HEAD_B, { mergeStateStatus: "UNKNOWN", mergeable: "UNKNOWN", checks: [] });
    await h.sweep();
    Object.assign(h.prs.get(11)!, { checks: [green("ci")], mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" });
    await h.run(MERGE_SETTLE_MS + MERGE_POLL_MS * 2, () => h.merges().length > 0);
    expect(h.merges()).toEqual([["pr", "merge", "11", "--repo", REPO, "--squash", "--match-head-commit", HEAD_B]]);
    expect(h.merge("L1")).toMatchObject({ state: "merged", chain: [HEAD_A, HEAD_B], mergedHead: HEAD_B });
    expect(h.merge("L1")!.updates).toEqual([{ requestedAt: iso(T0), head: HEAD_B }]);
    expect(h.updates()).toHaveLength(0);
  });

  test("a partial rollup on a retained update's new head cannot reuse old green checks", async () => {
    const h = harness({ required: ["ci", "lint"], lanes: [lane("L1")], prs: [openPr(11, { checks: [green("ci"), green("lint")] })] });
    await h.sweep();
    h.commits.set(HEAD_B, { parents: [HEAD_A, MAIN_1], committer: "web-flow" });
    retainedUpdate(h, HEAD_B, { checks: [green("ci")] });
    await h.run(MERGE_SETTLE_MS * 3);
    expect(h.merges()).toEqual([]);
    expect(h.merge("L1")).toMatchObject({ state: "waiting-checks", reason: "waiting for lint" });
    h.prs.get(11)!.checks = [green("ci"), green("lint")];
    await h.run(MERGE_POLL_MS * 2, () => h.merges().length > 0);
    expect(h.merges()).toHaveLength(1);
    expect(h.updates()).toHaveLength(0);
  });

  test("an optional check seen before a retained update need not report on its new head", async () => {
    const h = harness({ required: ["ci"], lanes: [lane("L1")], prs: [openPr(11, { checks: [green("ci"), green("Docker")] })] });
    await h.sweep();
    h.commits.set(HEAD_B, { parents: [HEAD_A, MAIN_1], committer: "web-flow" });
    retainedUpdate(h, HEAD_B, { checks: [green("ci")] });
    expect(h.merge("L1")?.seenChecks).toContain("Docker");
    await h.run(MERGE_SETTLE_MS + MERGE_POLL_MS * 2, () => h.merges().length > 0);
    expect(h.merge("L1")).toMatchObject({ state: "merged", chain: [HEAD_A, HEAD_B], mergedHead: HEAD_B });
    expect(h.updates()).toHaveLength(0);
  });

  test.each(["unreadable", "open", "malformed"] as const)("an accepted queue request with %s confirmation stays merging until landing is proved", async queuedMerge => {
    const h = harness({ queuedMerge, lanes: [lane("L1")], prs: [openPr(11)] });
    await h.run(MERGE_SETTLE_MS + MERGE_POLL_MS, () => h.merges().length > 0);
    expect(h.merges()).toHaveLength(1);
    expect(h.prs.get(11)!.state).toBe("OPEN");
    expect(h.merge("L1")).toMatchObject({ state: "merging", mergedAt: null });
    h.prs.get(11)!.state = "MERGED";
    await h.run(MERGE_POLL_MS * 2, () => h.merge("L1")?.state === "merged");
    expect(h.merge("L1")?.state).toBe("merged");
    expect(h.merges()).toHaveLength(1);
  });

  test.each(["[]", "[]\n[]\n", "[{\"type\":\"pull_request\"}]\n[]"])("empty requirements allow a settled PR to merge: %s", async (rulesRead) => {
    const h = harness({ rulesRead, lanes: [lane("L1")], prs: [openPr(11)] });
    await h.run(MERGE_SETTLE_MS * 2, () => h.merge("L1")?.state === "merged");
    expect(h.merge("L1")?.state).toBe("merged");
    expect(h.merges()).toHaveLength(1);
  });

  test.skipIf(!Bun.which("gh"))("required-check arguments are accepted by the installed GitHub CLI offline", async () => {
    const h = harness({ lanes: [lane("L1")], prs: [openPr(11)] });
    await h.sweep();
    const reads = h.calls.filter(args => args[0] === "api" && args[1]?.includes("/branches/"));
    expect(reads).toHaveLength(2);
    for (const args of reads) {
      // --help validates real flags without credentials or a network request.
      expect(execFileSync("gh", [...args, "--help"], { encoding: "utf8", timeout: 5_000 })).toContain("--jq");
    }
  });

  test.skipIf(!Bun.which("gh"))("GitHub CLI emits compact page records for empty and inherited branch rules", async () => {
    const pages: unknown[] = [
      [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "ruleset-ci" }] } }],
      [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "inherited-ci" }] } }],
    ];
    const requests: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push(url.pathname + (url.searchParams.has("page") ? "?page=2" : ""));
        const index = url.searchParams.has("page") ? 1 : 0;
        return Response.json(url.pathname === "/empty" ? [] : pages[index], {
          headers: url.pathname !== "/empty" && index === 0
            ? { Link: `<${url.origin}/rules?page=2>; rel="next"` } : {},
        });
      },
    });
    try {
      const h = harness({ lanes: [lane("L1")], prs: [openPr(11)] });
      const run = h.ports.run;
      h.ports.run = async (args) => {
        if (!args[1]?.includes("/rules/branches/")) return run(args);
        // A fixed inert token satisfies gh's auth preflight; only our listener is used.
        const child = Bun.spawn(["gh", "api", `${server.url}${requests.length === 0 ? "empty" : "rules"}`, ...args.slice(2)], {
          env: { ...process.env, GH_TOKEN: "offline", GH_ENTERPRISE_TOKEN: "offline", GITHUB_TOKEN: "", GITHUB_ENTERPRISE_TOKEN: "", NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" },
          stdout: "pipe", stderr: "pipe", timeout: 5_000,
        });
        const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
        return stdout;
      };
      await h.run(MERGE_SETTLE_MS * 2, () => h.merge("L1")?.state === "merged");
      expect(h.merge("L1")?.state).toBe("merged");
      expect(requests).toEqual(["/empty"]);
      resetAutoMergeForTests();
      const inherited = harness({ lanes: [lane("L2")], prs: [openPr(12)] });
      const original = inherited.ports.run;
      inherited.ports.run = args => args[1]?.includes("/rules/branches/") ? h.ports.run(args) : original(args);
      await inherited.sweep();
      expect(inherited.merge("L2")?.reason).toBe("waiting for ruleset-ci, inherited-ci");
      expect(requests).toEqual(["/empty", "/rules", "/rules?page=2"]);
      inherited.prs.get(12)!.checks = [green("ci"), green("ruleset-ci"), green("inherited-ci")];
      await inherited.run(MERGE_SETTLE_MS * 2, () => inherited.merge("L2")?.state === "merged");
      expect(inherited.merge("L2")?.state).toBe("merged");
      resetAutoMergeForTests();
      pages[1] = {};
      const broken = harness({ lanes: [lane("L3")], prs: [openPr(13)] });
      const brokenRun = broken.ports.run;
      broken.ports.run = args => args[1]?.includes("/rules/branches/") ? h.ports.run(args) : brokenRun(args);
      await broken.run(MERGE_SETTLE_MS * 2);
      expect(broken.merge("L3")).toMatchObject({ state: "blocked", reason: MERGE_REASONS.unreachable });
      expect(broken.merges()).toEqual([]);
    } finally {
      await server.stop(true);
    }
  });

  test("active ruleset contexts across pages hold a CLEAN PR until every check arrives", async () => {
    const h = harness({ required: ["ci"], rulesRead: [
      [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }, { context: "ruleset-ci" }] } }],
      [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "inherited-ci" }] } }],
    ].map(page => JSON.stringify(page)).join("\n"), lanes: [lane("L1")], prs: [openPr(11, { base: "release/next" })] });
    await h.run(MERGE_SETTLE_MS * 2);
    expect(h.merges()).toEqual([]);
    expect(h.merge("L1")).toMatchObject({ state: "waiting-checks", reason: "waiting for ruleset-ci, inherited-ci" });
    expect(h.calls).toContainEqual(["api", `repos/${REPO}/rules/branches/release%2Fnext`, "--paginate", "--jq", "@json"]);
    expect(h.calls.some(args => args[1] === `repos/${REPO}/branches/release%2Fnext`)).toBe(true);
    h.prs.get(11)!.checks = [green("ci"), green("ruleset-ci"), pending("inherited-ci")];
    await h.run(MERGE_POLL_MS * 2);
    expect(h.merges()).toEqual([]);
    h.prs.get(11)!.checks = [green("ci"), green("ruleset-ci"), green("inherited-ci")];
    await h.run(MERGE_POLL_MS * 2, () => h.merges().length > 0);
    expect(h.merges()).toHaveLength(1);
    expect(h.merge("L1")?.state).toBe("merged");
  });

  for (const invalid of [
    { classicRead: "not-json" }, { classicRead: "null" }, { classicRead: '["ci",42]' },
    { rulesRead: "not-json" }, { rulesRead: "" }, { rulesRead: "  \n" }, { rulesRead: "{}" }, { rulesRead: "[{}]" }, { rulesRead: "[null]" },
    { rulesRead: "[]\nnot-json" }, { rulesRead: "[]\nnull" },
    { rulesRefusal: true },
    { rulesRead: '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"ci"}]}}]\n{}' },
    { rulesRead: '[{"type":"required_status_checks","parameters":{}}]' },
    { rulesRead: '[{"type":"required_status_checks","parameters":{"required_status_checks":[{}]}}]' },
  ]) {
    test(`invalid required-check discovery fails closed: ${JSON.stringify(invalid)}`, async () => {
      const h = harness({ ...invalid, lanes: [lane("L1")], prs: [openPr(11)] });
      await h.run(MERGE_SETTLE_MS * 2);
      expect(h.merges()).toEqual([]);
      expect(h.merge("L1")).toMatchObject({ state: "blocked", reason: MERGE_REASONS.unreachable });
    });
  }

  test("failed discovery is read again after recovery without caching partial requirements", async () => {
    const options = { rulesRead: '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"ruleset-ci"}]}}]\n{}',
      lanes: [lane("L1")], prs: [openPr(11)] };
    const h = harness(options);
    await h.sweep();
    expect(h.merge("L1")?.readFailures).toBe(1);
    expect(h.merges()).toEqual([]);
    options.rulesRead = "[]";
    await h.run(MERGE_SETTLE_MS + MERGE_POLL_MS * 2, () => h.merges().length > 0);
    expect(h.merges()).toHaveLength(1);
    expect(h.calls.filter(args => args[1]?.includes("/rules/branches/"))).toHaveLength(2);
    expect(h.calls).toContainEqual(["api", `repos/${REPO}/branches/main`, "--jq",
      "[.protection.required_status_checks | (.contexts[]?, .checks[]?.context)]"]);
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

  test("an empty rollup waits for required contexts until they report", async () => {
    const required = ["privacy-publication", "privacy-tracker-audit"];
    const h = harness({ required, lanes: [lane("L1")], prs: [openPr(11, { checks: [] })] });
    await h.run(MERGE_SETTLE_MS * 4);
    expect(h.merges()).toEqual([]);
    expect(h.merge("L1")).toMatchObject({ state: "waiting-checks", reason: `waiting for ${required.join(", ")}` });
    h.prs.get(11)!.checks = required.map(green);
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

  test("two retained update heads extend the legacy chain without a forge update", async () => {
    const h = harness({ lanes: [lane("L1")], prs: [openPr(11)] });
    await h.sweep();
    h.commits.set(HEAD_B, { parents: [HEAD_A, MAIN_1], committer: "web-flow" });
    h.commits.set(HEAD_C, { parents: [HEAD_B, MAIN_2], committer: "web-flow" });
    retainedUpdate(h, HEAD_B);
    await h.sweep();
    retainedUpdate(h, HEAD_C);
    await h.run(MERGE_SETTLE_MS + MERGE_POLL_MS * 2, () => h.merges().length > 0);
    expect(h.merges()).toEqual([["pr", "merge", "11", "--repo", REPO, "--squash", "--match-head-commit", HEAD_C]]);
    expect(h.merge("L1")).toMatchObject({ state: "merged", chain: [HEAD_A, HEAD_B, HEAD_C] });
    expect(h.updates()).toHaveLength(0);
  });

  test("a one-parent web-flow head cannot satisfy a retained update", async () => {
    const h = harness({ lanes: [lane("L1")], prs: [openPr(11)] });
    await h.sweep();
    h.commits.set(HEAD_X, { parents: [HEAD_A], committer: "web-flow" });
    retainedUpdate(h, HEAD_X);
    await h.run(MERGE_POLL_MS * 3);
    expect(h.merges()).toEqual([]);
    expect(h.merge("L1")).toMatchObject({ state: "blocked", reason: MERGE_REASONS.headChanged, chain: [HEAD_A] });
    expect(h.updates()).toHaveLength(0);
  });

  test("a push after the lane finished, with no update outstanding, blocks", async () => {
    const h = harness({ lanes: [lane("L1")], prs: [openPr(11, { head: HEAD_X })] });
    h.commits.set(HEAD_X, { parents: [HEAD_A, MAIN_1], committer: "web-flow" });
    await h.sweep();
    expect(h.merge("L1")).toMatchObject({ state: "blocked", reason: MERGE_REASONS.headChanged });
  });

  test("pending required checks time out at 90 min, and not before", async () => {
    const h = harness({ required: ["e2e"], lanes: [lane("L1")], prs: [openPr(11, { checks: [green("ci"), pending("e2e")], mergeStateStatus: "UNSTABLE" })] });
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

test("large completed prefixes yield before scanning the full auto-merge sweep", async () => {
  const { performanceSpans, performanceSites } = await import("@/lib/performanceSpans");
  let stateReads = 0;
  let queueRowsVisited = 0;
  let resolveQueueTurn!: (visits: number) => void;
  const queueTurn = new Promise<number>(resolve => { resolveQueueTurn = resolve; });
  let queueTurnScheduled = false;
  performanceSpans.observeSite(site => {
    if (performanceSites[site] !== "forge.auto-merge.queue") return;
    queueRowsVisited++;
    if (!queueTurnScheduled) {
      queueTurnScheduled = true;
      setImmediate(() => resolveQueueTurn(queueRowsVisited));
    }
  });
  const rows = Array.from({ length: 804 }, (_, index) => {
    const row = {
      ...lane(`bounded-${index}`),
      merge: { state: "queued", repository: REPO, requestedAt: iso(T0 + index), nextReadAt: iso(T0 + 60_000), refresh: null },
    } as unknown as Pipeline;
    Object.defineProperty(row, "state", { enumerable: true, get: () => { stateReads++; return "completed"; } });
    return row;
  });
  const ports = {
    now: () => T0, run: async () => "", write: async () => "", loadPipelines: () => rows,
    mutate: async () => false, setting: () => ({ enabled: true, changedAt: iso(T0 - 60_000), changedBy: "operator" }),
    pullRequestOf: () => null, cachedState: () => null, finishTask: () => "missing" as const,
  } as unknown as Parameters<typeof sweepAutoMerge>[0];
  try {
    const sweep = sweepAutoMerge(ports);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(stateReads).toBeLessThan(40);
    await sweep;
    expect(await queueTurn).toBeLessThan(40);
  } finally { performanceSpans.observeSite(); }
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

  test("a spent nonterminal budget whose last fix passed is eligible, and so is a skipped or accepted review", () => {
    const spent = lane("spent", {
      reviews: [{ n: 1, state: "failed" }, { n: 2, state: "failed", budgetSpent: true }],
      builds: [{ n: 1, state: "passed" }, { n: 2, state: "passed", activatedBy: { stageId: "review", attempt: 1, edge: "fail" } }, { n: 3, state: "passed", activatedBy: { stageId: "review", attempt: 2, edge: "fail", budgetSpent: true } }],
    });
    spent.stages[1]!.next = "ship";
    spent.stages.push({ ...spent.stages[0]!, id: "ship", next: null });
    spent.runs.push({ stageId: "ship", attempts: [{ ...spent.runs[0]!.attempts[0]! }] });
    expect(mergeEligible(spent)).toBe(true);
    expect(mergeEligible(lane("skipped", { reviews: [{ n: 1, state: "skipped" }] }))).toBe(true);
    expect(mergeEligible(lane("accepted", { reviews: [{ n: 1, state: "failed", budgetSpent: true }], acceptances: [{ stageId: "review", attempt: 1 }] }))).toBe(true);
  });

  test.each([false, true])("a retained completed terminal budget fix cannot automatically merge before its re-check (queued: %s)", async queued => {
    const unreviewed = lane("terminal-spent", {
      reviews: [{ n: 1, state: "failed", budgetSpent: true }],
      builds: [{ n: 1, state: "passed", activatedBy: { stageId: "review", attempt: 1, edge: "fail", budgetSpent: true } }],
    });
    expect(mergeEligible(unreviewed)).toBe(false);
    const h = harness({ lanes: [unreviewed], prs: [openPr(11)] });
    if (queued) {
      h.pipeline(unreviewed.id).runs[1]!.attempts[0]!.state = "passed";
      await h.sweep();
      h.pipeline(unreviewed.id).runs[1]!.attempts[0]!.state = "failed";
      h.calls.length = 0;
      h.advance(MERGE_POLL_MS);
    }
    await h.sweep();
    if (queued) expect(h.merge(unreviewed.id)).toMatchObject({ state: "blocked", reason: "lane has not met the review merge bar" });
    else expect(h.merge(unreviewed.id)).toBeUndefined();
    expect(h.merges()).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  test.each(["pull-request", "reviews", "required-checks", "merge-method", "mutation-lease"])("the review bar is checked again after %s before merge", async seam => {
    const h = harness({ lanes: [lane("review-moved")], prs: [openPr(11)] });
    await h.sweep(); h.advance(MERGE_SETTLE_MS + MERGE_POLL_MS);
    resetAutoMergeForTests();
    const run = h.ports.run;
    const mutate = h.ports.mutate;
    let changed = false;
    h.ports.mutate = async (...args) => {
      if (!changed && seam === "mutation-lease") {
        h.pipeline("review-moved").runs[1]!.attempts[0]!.state = "failed";
        changed = true;
      }
      return mutate(...args);
    };
    h.ports.run = async args => {
      const result = await run(args);
      const atSeam = seam === "pull-request" ? args[0] === "pr" && args[1] === "view"
        : seam === "reviews" ? args[0] === "api" && args[1]?.includes("/reviews?")
        : seam === "required-checks" ? args[0] === "api" && args[1]?.includes("/branches/")
        : seam === "merge-method" && args[0] === "repo" && args[1] === "view";
      if (!changed && atSeam) {
        h.pipeline("review-moved").runs[1]!.attempts[0]!.state = "failed";
        changed = true;
      }
      return result;
    };
    await h.sweep();
    expect(changed).toBe(true);
    expect(h.writes).toEqual([]);
    expect(h.merge("review-moved")).toMatchObject({ state: "blocked", reason: "lane has not met the review merge bar" });
  });
});

describe("writes go out as the App", () => {
  test("the merge uses the App write seam with its repository, and reads never do", async () => {
    const h = harness({ lanes: [lane("L1")], prs: [openPr(11)] });
    await h.run(MERGE_SETTLE_MS + MERGE_POLL_MS * 3, () => h.merges().length > 0);
    expect(h.writes).toEqual([
      { args: ["pr", "merge", "11", "--repo", REPO, "--squash", "--match-head-commit", HEAD_A], repository: REPO },
    ]);
    expect(h.merge("L1")?.state).toBe("merged");
  });

  test("negative control: with no App credential the merge blocks with the refusal and gh is given no write", async () => {
    const refusal = `Delegatus refused this GitHub write to ${REPO}: no GitHub App credential is available for it.`;
    const h = harness({ lanes: [lane("L1")], prs: [openPr(11)] });
    h.refuseAppWrites(refusal);
    await h.run(MERGE_SETTLE_MS + MERGE_POLL_MS * 2, () => h.merge("L1")?.state === "blocked");
    expect(h.merge("L1")).toMatchObject({ state: "blocked", reason: refusal });
    /* `calls` is everything the fake gh was asked to do: views and reads only. */
    expect(h.merges()).toEqual([]);
    expect(h.prs.get(11)!.state).toBe("OPEN");
  });

  test("BEHIND without a refresh owner never attempts a GitHub write, even with no App credential", async () => {
    const h = harness({ lanes: [lane("L1")], prs: [openPr(11, { mergeStateStatus: "BEHIND" })] });
    h.refuseAppWrites("App write unavailable");
    await h.sweep();
    expect(h.merge("L1")?.state).toBe("blocked");
    expect(h.merge("L1")?.reason).toContain("Delegatus could not start the refresh");
    expect(h.writes).toEqual([]);
  });
});

describe("rollup reading", () => {
  test("a re-run supersedes the older run of the same name, and a pending run reads pending", () => {
    expect(rollupChecks([
      { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-09-25T06:00:00Z",
        app: { id: 7 }, checkSuite: { workflowRun: { workflow: { name: "tests" } } } },
      { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-25T06:05:00Z",
        app: { id: 7 }, checkSuite: { workflowRun: { workflow: { name: "tests" } } } },
      { __typename: "CheckRun", name: "slow", status: "IN_PROGRESS", conclusion: "", startedAt: "2026-09-25T06:05:00Z", completedAt: "0001-01-01T00:00:00Z" },
      { __typename: "StatusContext", context: "legacy", state: "ERROR" },
    ])).toEqual([
      { name: "ci", verdict: "green" },
      { name: "legacy", verdict: "red" },
      { name: "slow", verdict: "pending" },
    ]);
  });
});

test("unchanged refusal reasons log once, changes log again, and departed hot lanes are evicted", async () => {
  let rows = deepFreeze([lane("reason-a"), lane("reason-b")]);
  const logs: string[] = [];
  const size = () => (globalThis as typeof globalThis & { __llvAutoMergeAdmissionReasons?: Map<string, string> }).__llvAutoMergeAdmissionReasons?.size;
  const ports = {
    now: () => T0, loadPipelines: () => rows,
    setting: () => ({ enabled: false, changedAt: iso(T0), changedBy: "operator" as const }),
    pullRequestOf: () => null, cachedState: () => null,
    run: async () => { throw new Error("unexpected forge read"); },
    write: async () => { throw new Error("unexpected forge write"); },
    mutate: async () => { throw new Error("unexpected row write"); },
    log: (line: string) => { logs.push(line); },
  };
  await sweepAutoMerge(ports);
  await sweepAutoMerge(ports);
  expect(logs).toHaveLength(2);
  expect(size()).toBe(2);
  expect(logs.every(line => line.includes("not admitted:"))).toBe(true);
  rows = deepFreeze([{ ...rows[0]!, hiddenAt: iso(T0) }, rows[1]!]);
  await sweepAutoMerge(ports);
  expect(logs).toHaveLength(3);
  expect(logs.at(-1)).toContain("reason-a: not admitted: lane is hidden");
  // Keeping the ids but reopening them must evict their completed-lane reasons.
  rows = deepFreeze(rows.map(row => ({ ...row, state: "running" as const })));
  await sweepAutoMerge(ports);
  expect(size()).toBe(0);
  rows = deepFreeze([lane("reason-a"), lane("reason-b")]);
  await sweepAutoMerge(ports);
  expect(logs).toHaveLength(5);
  rows = [];
  await sweepAutoMerge(ports);
  expect(size()).toBe(0);
  rows = deepFreeze([lane("reason-a")]);
  await sweepAutoMerge(ports);
  expect(logs).toHaveLength(6);
});

test("a restarted merge process reports its first refusal once with recreated scheduler ports", async () => {
  const script = `
    const { productionAutoMergePorts, sweepAutoMerge } = await import("./src/lib/forge/autoMerge");
    const lanes = JSON.parse(process.env.MERGE_FIXTURE);
    const ports = () => productionAutoMergePorts({
      loadPipelines: () => lanes, now: () => ${T0},
      setting: () => ({ enabled: false, changedAt: "${iso(T0)}", changedBy: "operator" }),
      pullRequestOf: () => null, hasPublishedPrototype: () => false,
      run: async () => { throw new Error("unexpected forge read"); },
      mutate: async () => { throw new Error("unexpected row write"); },
      log: line => console.log(line),
    });
    await sweepAutoMerge(ports());
    await sweepAutoMerge(ports());
  `;
  const observations: string[][] = [];
  for (let restart = 0; restart < 2; restart++) {
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, MERGE_FIXTURE: JSON.stringify([lane("reason-restart")]) },
      stdout: "pipe", stderr: "pipe",
    });
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, err }).toEqual({ exit: 0, err: "" });
    observations.push(out.trim().split("\n"));
  }
  expect(observations[0]).toHaveLength(1);
  expect(observations[0]![0]).toContain("reason-restart: not admitted:");
  expect(observations[1]).toEqual(observations[0]);
});


describe("merge queue stall recovery", () => {
  test("a retried hold merges old successful duplicate contexts and lets its peer advance", async () => {
    const h = harness({ required: ["privacy-tracker-audit"], lanes: [lane("old"), lane("peer", { closedAt: T0 })],
      prs: [openPr(11, { checks: [green("privacy-tracker-audit"), green("privacy-tracker-audit")]
        .map(check => ({ ...check, startedAt: iso(T0 - MERGE_WAIT_LIMIT_MS * 2) })) }), openPr(22, { checks: [green("privacy-tracker-audit")] })] });
    await h.sweep();
    Object.assign(h.merge("old")!, { state: "waiting-checks", attempts: 1, head: HEAD_A,
      headSeenAt: iso(T0 - MERGE_SETTLE_MS), nextReadAt: null, lastChecks: ["privacy-tracker-audit", "privacy-tracker-audit"] });
    await h.sweep();
    expect(h.merge("old")?.state).toBe("merged");
    await h.run(MERGE_SETTLE_MS + MERGE_POLL_MS);
    expect(h.merges().map(args => args[2])).toEqual(["11", "22"]);
  });

  test("an expired hold overrides a future poll, logs its release, and frees the next lane", async () => {
    const h = harness({ required: ["ci"], lanes: [lane("old"), lane("peer", { closedAt: T0 })],
      prs: [openPr(11, { checks: [pending("ci")] }), openPr(22)] });
    await h.sweep();
    Object.assign(h.merge("old")!, { head: HEAD_A, headSeenAt: iso(T0 - MERGE_WAIT_LIMIT_MS + 1),
      lastChecks: ["ci"], state: "waiting-checks", nextReadAt: iso(T0 + MERGE_WAIT_LIMIT_MS) });
    await h.sweep();
    expect(h.merge("old")?.state).toBe("waiting-checks");
    h.advance(1);
    await h.sweep();
    expect(h.merge("old")).toMatchObject({ state: "blocked", reason: MERGE_REASONS.checksTimeout });
    expect(h.logs.some(line => line.includes("old:") && line.includes(MERGE_REASONS.checksTimeout))).toBe(true);
    await h.run(MERGE_SETTLE_MS + MERGE_POLL_MS);
    expect(h.merges().map(args => args[2])).toEqual(["22"]);
  });

  test("holds and queued peers log once across recreated ports, changed reasons log again, and evictions are bounded", async () => {
    const h = harness({ required: ["ci"], lanes: [lane("old"), lane("peer", { closedAt: T0 })],
      prs: [openPr(11, { checks: [pending("ci")] }), openPr(22)] });
    await h.sweep();
    expect(h.logs.some(line => line.includes("old:") && line.includes("waiting-checks") && line.includes("ci"))).toBe(true);
    expect(h.logs.some(line => line.includes("peer:") && line.includes("queued behind PR #11 (pipeline old)"))).toBe(true);
    const count = h.logs.length;
    await sweepAutoMerge({ ...h.ports });
    expect(h.logs).toHaveLength(count);
    h.advance(MERGE_POLL_MS);
    await sweepAutoMerge({ ...h.ports });
    expect(h.logs).toHaveLength(count);
    h.pipeline("old").hiddenAt = iso(h.now());
    await h.sweep();
    expect(h.logs.at(-1)).toContain("old: skipped: lane is hidden");
    const hiddenCount = h.logs.length;
    h.advance(MERGE_POLL_MS);
    await h.sweep();
    expect(h.logs).toHaveLength(hiddenCount);
    const host = globalThis as typeof globalThis & { __llvAutoMergeLaneReasons?: Map<string, string> };
    expect(host.__llvAutoMergeLaneReasons?.size).toBe(2);
    h.ports.loadPipelines = () => [];
    await h.sweep();
    expect(host.__llvAutoMergeLaneReasons?.size).toBe(0);
  });
});


test.each(["CLEAN", "BEHIND", "unreadable"])("an overdue hold reconciles %s before releasing its slot", async status => {
  const h = harness({ required: ["ci"], lanes: [lane("overdue")], prs: [openPr(11)] });
  await h.sweep();
  Object.assign(h.merge("overdue")!, { state: "waiting-checks", head: HEAD_A,
    headSeenAt: iso(T0 - MERGE_WAIT_LIMIT_MS), lastChecks: ["ci"], nextReadAt: iso(T0 + MERGE_WAIT_LIMIT_MS) });
  if (status === "unreadable") h.ports.run = async () => { throw new Error("fixture read unavailable"); };
  else h.prs.get(11)!.mergeStateStatus = status;
  await h.sweep();
  expect(h.merge("overdue")?.state).toBe(status === "CLEAN" ? "merged" : "blocked");
  if (status !== "CLEAN") expect(h.merge("overdue")?.reason).toBe(MERGE_REASONS.checksTimeout);
  expect(h.updates()).toHaveLength(0);
  expect(h.merges()).toHaveLength(status === "CLEAN" ? 1 : 0);
});

test("an expired read cannot block a retry that arrives while the forge read is awaited", async () => {
  const h = harness({ required: ["ci"], lanes: [lane("racing")], prs: [openPr(11, { checks: [pending("ci")] })] });
  await h.sweep();
  Object.assign(h.merge("racing")!, { state: "waiting-checks", head: HEAD_A,
    headSeenAt: iso(T0 - MERGE_WAIT_LIMIT_MS), lastChecks: ["ci"] });
  const run = h.ports.run;
  h.ports.run = async args => {
    await Promise.resolve();
    Object.assign(h.merge("racing")!, { attempts: 1, state: "queued", head: null, headSeenAt: null, lastChecks: null });
    return run(args);
  };
  await h.sweep();
  expect(h.merge("racing")).toMatchObject({ state: "queued", attempts: 1, headSeenAt: null });
  expect(h.merges()).toHaveLength(0);
  expect(h.logs.some(line => line.includes(MERGE_REASONS.checksTimeout))).toBe(false);
});

test("merge diagnostics flatten and bound reasons, deduplicate, and evict reopened lanes", async () => {
  const h = harness({ lanes: [lane("bounded")], prs: [openPr(11)] });
  await h.sweep();
  Object.assign(h.merge("bounded")!, { state: "blocked", reason: "first\nsecond\r\n" + "x".repeat(1000) });
  await h.sweep();
  const line = h.logs.at(-1)!;
  expect(line).toStartWith("[auto merge] bounded: blocked: first second ");
  expect(line.split(/[\r\n]/)).toHaveLength(1);
  expect(line.length).toBe("[auto merge] bounded: ".length + 400);
  const count = h.logs.length;
  await h.sweep();
  expect(h.logs).toHaveLength(count);
  h.pipeline("bounded").state = "running";
  await h.sweep();
  expect((globalThis as typeof globalThis & { __llvAutoMergeLaneReasons?: Map<string, string> }).__llvAutoMergeLaneReasons?.size).toBe(0);
});


test("closed uncertain merge receipts are bounded and ordered by durable due time", async () => {
  const records = Array.from({ length: 10 }, (_, n) => lane(`receipt-${String(n).padStart(2, "0")}`));
  const h = harness({ lanes: records, prs: records.map((_, n) => openPr(n + 11)) });
  await h.sweep();
  for (const [n, record] of records.entries()) {
    const live = h.pipeline(record.id);
    live.state = "closed"; live.hiddenAt = iso(T0);
    Object.assign(live.merge!, { state: "blocked", effectUncertain: true, nextReadAt: iso(T0 - (10 - n) * MERGE_POLL_MS) });
  }
  const initialCalls = h.calls.length;
  const reads = () => h.calls.slice(initialCalls).filter(args => args[0] === "pr" && args[1] === "view");
  await h.sweep();
  expect(reads()).toHaveLength(8);
  expect(h.merges()).toHaveLength(0);
  expect(h.merge(records[8]!.id)!.readAt).toBeNull();
  const before = reads().length;
  h.advance(MERGE_POLL_MS);
  resetAutoMergeForTests();
  await h.sweep();
  const resumed = reads().slice(before);
  expect(resumed).toHaveLength(8);
  expect(resumed.slice(0, 2).map(args => args[2])).toEqual(["19", "20"]);
  for (const pr of h.prs.values()) pr.state = "MERGED";
  for (let n = 0; n < 2; n++) { h.advance(MERGE_POLL_MS); await h.sweep(); }
  expect(records.every(record => h.merge(record.id)?.state === "merged" && !h.merge(record.id)?.effectUncertain)).toBe(true);
  expect(h.merges()).toHaveLength(0);
});


test.each(["UNKNOWN", "", "UNRECOGNIZED"])("uncertain merge receipt retains paced custody for an invalid forge state: %s", async state => {
  const record = lane("unreadable-state");
  const h = harness({ lanes: [record], prs: [openPr(11)] });
  await h.sweep();
  Object.assign(h.pipeline(record.id).merge!, { state: "blocked", effectUncertain: true, nextReadAt: null });
  Object.assign(h.prs.get(11)!, { state, mergeStateStatus: "BEHIND" });
  const calls = h.calls.length;
  await h.sweep();
  expect(h.merge(record.id)).toMatchObject({ state: "blocked", effectUncertain: true, nextReadAt: iso(h.now() + MERGE_POLL_MS) });
  expect(h.calls.slice(calls).map(args => args.slice(0, 2))).toEqual([["pr", "view"]]);
  expect(h.writes).toHaveLength(0);
});
