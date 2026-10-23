import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Pipeline } from "@/lib/pipelines/types";
import { batchLandingFixture } from "./batchLanding.fixture";

/* The merge runner against the real pipeline store and settings file
   (#2187 §4.1, §4.4, §4.6): a record it writes survives the store's
   validation, a stopped merge raises lane-merge, and retry-merge requeues it.
   The stores resolve their state directory at import, so a sandbox is pinned
   before any of them loads. */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-auto-merge-store-"));
const previousStateDir = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = sandbox;

const { MERGE_POLL_MS, MERGE_REASONS, productionAutoMergePorts, resetAutoMergeForTests, sweepAutoMerge, sweepTaskFinishes } = await import("./autoMerge");
const { patchPipeline } = await import("@/lib/pipelines/engine");
const { loadPipelines, loadPipelinesForList, pipelineIdentity, savePipelines } = await import("@/lib/pipelines/store");
const { mergeOnReviewSetting, resetProjectSettingsForTests, setMergeOnReview } = await import("@/lib/projects/settings");
const { laneNeed } = await import("@/components/attention/needReason");
const { pipelineAnswers } = await import("@/components/pipelines/pipelineBlockModel");
const { refreshLifecycleJournal } = await import("@/lib/lifecycle/projector");
const { queryLifecycleEvents } = await import("@/lib/lifecycle/journal");
const { createTask } = await import("@/lib/tasks/commands");
const { loadTasks, mutateTasks } = await import("@/lib/tasks/store");
const { stampAttentionRoutes } = await import("@/lib/attention/routing");
const { seatAgendaAsks } = await import("@/lib/attention/seatAgenda");
const { FlowPipelineController } = await import("@/lib/pipelines/controller");
const { controllerPipelineKeys, withControllerPipelineScope } = await import("@/lib/pipelines/controllerScope");
const { registerPipelineTick, requestPipelineTick } = await import("@/lib/pipelines/controllerSignal");

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const PROJECT = "repo-merge-fixture";
const REPO = "acme/widgets";
const HEAD = "a".repeat(40);
const T0 = Date.parse("2026-09-25T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const BUILDER = { engine: "claude", model: null, effort: null, roleId: null, access: "read-write", promptScaffold: null };
const REVIEWER = { ...BUILDER, access: "read-only" };

function markedTask(lane: Pipeline): string {
  const task = mutateTasks((tasks) => {
    const created = createTask(tasks, { project: PROJECT, text: "Finish the lane output", placement: "unplaced" });
    if (!created.ok) throw new Error(created.error);
    return { tasks: created.tasks, result: created.task };
  });
  lane.taskIds = [task.id];
  lane.finishesTaskIds = [task.id];
  return task.id;
}

function missingPrLane(id: string): Pipeline {
  const lane = completedLane(id);
  lane.baseRef = "b".repeat(40);
  lane.delivery = {
    target: { repository: PROJECT, remote: `https://github.com/${REPO}.git`, branch: `refs/heads/${lane.branch}` },
    disposition: "owner", publish: "disabled", ownerId: lane.id, epoch: 1, active: false, journal: [],
  };
  return lane;
}

function workerAsks(lane: Pipeline) {
  stampAttentionRoutes([], [lane], T0 / 1000, {
    seatFor: () => "conversation_seat", canonicalProject: (project) => project,
    isSeatConversation: (id) => id === "conversation_seat", escalation: () => null, formWaiting: () => false,
  });
  return seatAgendaAsks({ files: [], pipelines: [lane] }, T0 / 1000, PROJECT);
}

function attempt(n: number, state: string, role: typeof BUILDER) {
  return {
    n, state, effectiveRole: role, launchId: null, conversationId: null, sessionId: null, agentPath: null, paneId: null, flowId: null,
    startedAt: iso(T0 - 60_000), completedAt: iso(T0 - 30_000), input: null, activatedBy: null, output: null, verdict: null, error: null,
  };
}

function completedLane(id: string): Pipeline {
  return {
    id,
    task: "ship the merge runner",
    taskIds: [],
    project: PROJECT,
    repoDir: "/repo",
    ...pipelineIdentity(id, "ship the merge runner", "/repo"),
    baseBranch: "main",
    baseRef: "main",
    lastPassedCommit: HEAD,
    stages: [
      { id: "build", kind: "run", prompt: "build", next: "review", onFail: null, effectiveRole: BUILDER },
      { id: "review", kind: "run", prompt: "review", next: null, onFail: { to: "build", maxRounds: 2 }, effectiveRole: REVIEWER, access: "read-only" },
    ],
    runs: [{ stageId: "build", attempts: [attempt(1, "passed", BUILDER)] }, { stageId: "review", attempts: [attempt(1, "passed", REVIEWER)] }],
    cursor: null,
    state: "completed",
    pausedState: null,
    stateDetail: null,
    srcPath: null,
    srcConversationId: null,
    createdAt: iso(T0 - 3_600_000),
    closedAt: iso(T0 - 1_000),
  } as unknown as Pipeline;
}

test("merge mutations yield after releasing the selected lane and recover after a refused change", async () => {
  const first = completedLane("bounded-merge-first"), second = completedLane("bounded-merge-second");
  savePipelines([first, second]);
  const ports = productionAutoMergePorts({ loadPipelines: loadPipelinesForList });
  let timerRan = false;
  expect(await ports.mutate(first.id, live => {
    expect(controllerPipelineKeys()).toEqual([first.id]);
    live.stateDetail = "first bounded mutation";
    setImmediate(() => { timerRan = true; });
    return true;
  })).toBe(true);
  expect(timerRan).toBe(true);
  await expect(ports.mutate(second.id, live => {
    live.stateDetail = "must roll back";
    throw Error("refused mutation");
  })).rejects.toThrow("refused mutation");
  expect(loadPipelinesForList().find(row => row.id === second.id)?.stateDetail).toBeNull();
  expect(await ports.mutate(second.id, live => { live.stateDetail = "recovered mutation"; return true; })).toBe(true);
  expect(loadPipelinesForList().find(row => row.id === first.id)?.stateDetail).toBe("first bounded mutation");
});

describe("global merge admission", () => {
  const settingsFile = path.join(sandbox, "project-settings.json");
  let previousSettings: Buffer | null;
  beforeEach(() => { previousSettings = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile) : null; });
  afterEach(() => {
    if (previousSettings === null) fs.rmSync(settingsFile, { force: true });
    else fs.writeFileSync(settingsFile, previousSettings);
    resetProjectSettingsForTests();
  });

  function spentReviewLane(id: string): Pipeline {
    const lane = completedLane(id);
    lane.stages[1]!.onFail = { to: "fix", maxRounds: 2 };
    lane.stages[1]!.next = "ship";
    lane.stages.push({ ...lane.stages[0]!, id: "ship", next: null });
    lane.runs.push({ stageId: "ship", attempts: [{ ...lane.runs[0]!.attempts[0]! }] });
    lane.stages.push({ ...lane.stages[0]!, id: "fix", next: null });
    Object.assign(lane.runs[1]!.attempts[0]!, { state: "failed", budgetSpent: true });
    lane.runs.push({ stageId: "fix", attempts: [{ ...lane.runs[0]!.attempts[0]!,
      activatedBy: { stageId: "review", attempt: 1, edge: "fail", budgetSpent: true },
    }] });
    return lane;
  }

  for (const trigger of ["signal", "direct"] as const) test(`a ${trigger} from an in-flight lane runs the global controller outside its scope and admits all five completed peers`, async () => {
    resetAutoMergeForTests();
    setMergeOnReview(PROJECT, true, "operator", iso(T0 - 7_200_000));
    const lanes = [1, 2, 3, 4, 5].map(n => spentReviewLane(`eligible-${n}`));
    savePipelines(lanes);
    const ports = productionAutoMergePorts({
      now: () => T0, loadPipelines, pullRequestOf: () => ({ repository: REPO, number: 7 }), cachedState: () => null,
      run: async () => { throw new Error("offline fixture"); }, log: () => undefined,
    });
    let sweep = Promise.resolve();
    const controller = new FlowPipelineController({
      now: () => 0, tickPipelines: async () => ({ changed: false }), tickFlows: async () => ({ changed: false }),
      sweepAutoMerge: () => { sweep = sweepAutoMerge(ports); },
    }, { maxPasses: 1 });
    let resolve!: () => void, reject!: (error: unknown) => void;
    const finished = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const tick = async () => { await controller.tick(); await sweep; };
    const unregister = registerPipelineTick(async () => { try { await tick(); resolve(); } catch (error) { reject(error); } });
    try {
      await withControllerPipelineScope(["signalling-lane"], async () => {
        if (trigger === "signal") { requestPipelineTick(); await finished; }
        else await tick();
        // Clearing the global job must leave its caller's authority intact.
        expect(controllerPipelineKeys()).toEqual(["signalling-lane"]);
        expect(loadPipelines().toSorted((a, b) => a.id.localeCompare(b.id)).map(lane => [lane.id, lane.merge?.reviewedHead]))
          .toEqual(lanes.map(lane => [lane.id, HEAD]));
      });
    } finally { for (let i = 0; i < 20; i++) await Promise.resolve(); unregister(); }
  });

  test("a missed admission is logged and the next sweep retries the persisted completed lane", async () => {
    resetAutoMergeForTests();
    setMergeOnReview(PROJECT, true, "operator", iso(T0 - 7_200_000));
    savePipelines([spentReviewLane("missed-admission")]);
    const logs: string[] = [];
    const ports = productionAutoMergePorts({
      now: () => T0, loadPipelines, pullRequestOf: () => ({ repository: REPO, number: 7 }), cachedState: () => null,
      run: async () => { throw new Error("offline fixture"); }, log: message => { logs.push(message); },
    });
    const mutate = ports.mutate;
    ports.mutate = async () => false;
    await sweepAutoMerge(ports);
    expect(loadPipelines()[0]!.merge).toBeUndefined();
    expect(logs.some(message => message.includes("missed-admission") && message.includes("not admitted"))).toBe(true);
    ports.mutate = mutate;
    await sweepAutoMerge(ports);
    expect(loadPipelines()[0]!.merge?.reviewedHead).toBe(HEAD);
    const childRoot = fs.mkdtempSync(path.join(sandbox, "fresh-reader-"));
    for (const directory of ["home", "config", "tmp"]) fs.mkdirSync(path.join(childRoot, directory));
    const reader = Bun.spawn([process.execPath, "-e", 'const { loadPipelines } = await import("./src/lib/pipelines/store.ts"); console.log(JSON.stringify(loadPipelines().map(lane => [lane.id, lane.merge?.reviewedHead])));'], {
      cwd: process.cwd(), env: { ...process.env, HOME: path.join(childRoot, "home"), XDG_CONFIG_HOME: path.join(childRoot, "config"),
        TMPDIR: path.join(childRoot, "tmp"), LLV_STATE_DIR: sandbox, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" },
      stdout: "pipe", stderr: "pipe",
    });
    const [output, error, code] = await Promise.all([new Response(reader.stdout).text(), new Response(reader.stderr).text(), reader.exited]);
    expect({ code, error }).toEqual({ code: 0, error: "" });
    expect(JSON.parse(output)).toEqual([["missed-admission", HEAD]]);
  });

  test("retry-merge creates a missing record for a completed eligible lane and preserves it on a duplicate retry", async () => {
    resetAutoMergeForTests();
    setMergeOnReview(PROJECT, true, "operator", iso(T0 - 7_200_000));
    const lane = spentReviewLane("retry-missing");
    lane.workLinks = [{ kind: "pr", repository: REPO, number: 7, addedAt: iso(T0), addedBy: "operator" }];
    savePipelines([lane]);
    const unregister = registerPipelineTick(async () => {});
    try {
      const result = await patchPipeline(lane.id, { action: "retry-merge" }, { now: () => iso(T0) } as never);
      expect(result.error).toBeUndefined();
      expect(loadPipelines()[0]!.merge).toMatchObject({ state: "queued", prNumber: 7, repository: REPO, chain: [HEAD], attempts: 0 });
      const recorded = loadPipelines()[0]!.merge;
      expect((await patchPipeline(lane.id, { action: "retry-merge" }, { now: () => iso(T0 + 1) } as never)).status).toBe(409);
      expect(loadPipelines()[0]!.merge).toEqual(recorded);
    } finally { for (let i = 0; i < 20; i++) await Promise.resolve(); unregister(); }
  });

  test("retry-merge with no record and no implementation PR persists the visible missing-PR block", async () => {
    resetAutoMergeForTests();
    setMergeOnReview(PROJECT, true, "operator", iso(T0 - 7_200_000));
    const lane = spentReviewLane("retry-missing-pr");
    lane.delivery = missingPrLane(lane.id).delivery;
    savePipelines([lane]);
    const result = await patchPipeline(lane.id, { action: "retry-merge" }, { now: () => iso(T0) } as never);
    expect(result.error).toBeUndefined();
    expect(loadPipelines()[0]!.merge).toMatchObject({ state: "blocked", prNumber: null, reason: MERGE_REASONS.noPr });
  });

  test("a missing record on a running lane cannot be retried", async () => {
    const lane = completedLane("retry-running");
    lane.state = "running";
    lane.closedAt = null;
    lane.cursor = { stageId: "build", state: "running", input: null, activatedBy: null };
    savePipelines([lane]);
    const result = await patchPipeline(lane.id, { action: "retry-merge" }, { now: () => iso(T0) } as never);
    expect(result.status).toBe(409);
    expect(result.error).toContain("only a completed pipeline");
    expect(loadPipelines()[0]!.merge).toBeUndefined();
  });

  test("admission uses the passed head and linked PR read after awaiting the write lock", async () => {
    resetAutoMergeForTests();
    setMergeOnReview(PROJECT, true, "operator", iso(T0 - 7_200_000));
    const lane = spentReviewLane("rebound-admission");
    lane.workLinks = [{ kind: "pr", repository: REPO, number: 7, addedAt: iso(T0), addedBy: "operator" }];
    savePipelines([lane]);
    const ports = productionAutoMergePorts({ now: () => T0, loadPipelines, cachedState: () => null,
      run: async () => { throw new Error("offline fixture"); }, log: () => undefined });
    const mutate = ports.mutate;
    let changed = false;
    ports.mutate = async (id, change) => {
      await Promise.resolve();
      if (!changed) {
        changed = true;
        const current = loadPipelines()[0]!;
        current.lastPassedCommit = "b".repeat(40);
        current.workLinks![0]!.number = 8;
        savePipelines([current]);
      }
      return mutate(id, change);
    };
    await sweepAutoMerge(ports);
    expect(loadPipelines()[0]!.merge).toMatchObject({ reviewedHead: "b".repeat(40), prNumber: 8, chain: ["b".repeat(40)] });
  });

  const refusalCases = ["setting off", "completed before setting", "review failed", "no passed commit", "hidden", "comparison", "no repository", "no PR required"] as const;
  type RefusalCase = typeof refusalCases[number];
  function refuseAdmission(lane: Pipeline, reason: RefusalCase) {
    if (reason === "setting off") setMergeOnReview(PROJECT, false, "operator", iso(T0));
    if (reason === "completed before setting") lane.closedAt = iso(T0 - 8_000_000);
    if (reason === "review failed") lane.runs.at(-1)!.attempts[0]!.state = "failed";
    if (reason === "no passed commit") lane.lastPassedCommit = "";
    if (reason === "hidden") lane.hiddenAt = iso(T0);
    if (reason === "comparison") lane.delivery = { target: { repository: PROJECT, remote: `https://github.com/${REPO}.git`, branch: `refs/heads/${lane.branch}` },
      disposition: "comparison", publish: "disabled", ownerId: "other-lane", epoch: 1, active: false, journal: [] };
    if (reason === "no PR required") lane.baseRef = HEAD;
  }

  for (const reason of refusalCases) test(`missing-record admission refuses and logs ${reason} through sweep and retry`, async () => {
    resetAutoMergeForTests();
    setMergeOnReview(PROJECT, true, "operator", iso(T0 - 7_200_000));
    const lane = spentReviewLane("refused-admission");
    if (!["comparison", "no repository", "no PR required"].includes(reason)) lane.workLinks = [{ kind: "pr", repository: REPO, number: 7, addedAt: iso(T0), addedBy: "operator" }];
    refuseAdmission(lane, reason);
    savePipelines([lane]);
    const logs: string[] = [];
    const ports = productionAutoMergePorts({ now: () => T0, loadPipelines, cachedState: () => null,
      run: async () => { throw new Error("refused admission must not read GitHub"); }, log: message => { logs.push(message); } });
    await sweepAutoMerge(ports);
    expect(loadPipelines()[0]!.merge).toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("refused-admission: not admitted:");
    const result = await patchPipeline(lane.id, { action: "retry-merge" }, { now: () => iso(T0) } as never);
    expect(result.status).toBe(409);
    expect(logs[0]).toEndWith(result.error!);
    expect(loadPipelines()[0]!.merge).toBeUndefined();
  });

  for (const reason of refusalCases) test(`admission rechecks ${reason} after awaiting its write lock`, async () => {
    resetAutoMergeForTests();
    setMergeOnReview(PROJECT, true, "operator", iso(T0 - 7_200_000));
    const lane = spentReviewLane("changed-admission");
    lane.workLinks = [{ kind: "pr", repository: REPO, number: 7, addedAt: iso(T0), addedBy: "operator" }];
    savePipelines([lane]);
    const logs: string[] = [];
    const ports = productionAutoMergePorts({ now: () => T0, loadPipelines, cachedState: () => null,
      run: async () => { throw new Error("refused admission must not read GitHub"); }, log: message => { logs.push(message); } });
    const mutate = ports.mutate;
    ports.mutate = async (id, change) => {
      await Promise.resolve();
      const current = loadPipelines()[0]!;
      if (["comparison", "no repository", "no PR required"].includes(reason)) delete current.workLinks;
      refuseAdmission(current, reason);
      savePipelines([current]);
      return mutate(id, change);
    };
    await sweepAutoMerge(ports);
    expect(loadPipelines()[0]!.merge).toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("changed-admission: not admitted:");
  });

  test("an admission exception is logged without preventing eligible peers from getting records", async () => {
    resetAutoMergeForTests();
    setMergeOnReview(PROJECT, true, "operator", iso(T0 - 7_200_000));
    savePipelines([spentReviewLane("exception-lane"), spentReviewLane("peer-lane")]);
    const logs: Array<[string, unknown]> = [];
    const failure = new Error("admission unavailable");
    const ports = productionAutoMergePorts({ now: () => T0, loadPipelines, pullRequestOf: () => ({ repository: REPO, number: 7 }), cachedState: () => null,
      run: async () => { throw new Error("offline fixture"); }, log: (message, error) => { logs.push([message, error]); } });
    const mutate = ports.mutate;
    ports.mutate = (id, change) => id === "exception-lane" ? Promise.reject(failure) : mutate(id, change);
    await sweepAutoMerge(ports);
    expect(loadPipelines().find(lane => lane.id === "exception-lane")!.merge).toBeUndefined();
    expect(loadPipelines().find(lane => lane.id === "peer-lane")!.merge?.reviewedHead).toBe(HEAD);
    expect(logs).toContainEqual(["[auto merge] exception-lane: admission failed; will retry next sweep", failure]);
    ports.mutate = mutate;
    await sweepAutoMerge(ports);
    expect(loadPipelines().find(lane => lane.id === "exception-lane")!.merge?.reviewedHead).toBe(HEAD);
  });

});

test("the setting defaults off, and turning it on keeps its first changedAt on a repeat", () => {
  resetProjectSettingsForTests();
  expect(mergeOnReviewSetting(PROJECT)).toEqual({ enabled: false, changedAt: null, changedBy: null });
  const on = setMergeOnReview(PROJECT, true, "operator", iso(T0 - 7_200_000));
  expect(on).toEqual({ enabled: true, changedAt: iso(T0 - 7_200_000), changedBy: "operator" });
  expect(setMergeOnReview(PROJECT, true, "operator", iso(T0))?.changedAt).toBe(iso(T0 - 7_200_000));
  expect(mergeOnReviewSetting(PROJECT).enabled).toBe(true);
  const stored = JSON.parse(fs.readFileSync(path.join(sandbox, "project-settings.json"), "utf8"));
  expect(stored).toEqual({ schemaVersion: 1, projects: { [PROJECT]: { mergeOnReview: on } } });
});

test("a stopped merge is stored, raises lane-merge with its two answers, and retry-merge requeues it; a merge is journaled", async () => {
  resetAutoMergeForTests();
  savePipelines([completedLane("pipe-merge")]);
  let clock = T0;
  const calls: string[][] = [];
  let mergeState = "DIRTY";
  const ports = productionAutoMergePorts({
    now: () => clock,
    loadPipelines,
    pullRequestOf: () => ({ repository: REPO, number: 7 }),
    cachedState: () => null,
    log: () => undefined,
    run: async (args) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "view") {
        const merged = mergeState === "MERGED";
        return JSON.stringify({
          state: merged ? "MERGED" : "OPEN", isDraft: false, headRefOid: HEAD, baseRefName: "main",
          mergeable: mergeState === "DIRTY" ? "CONFLICTING" : "MERGEABLE", mergeStateStatus: merged ? "UNKNOWN" : mergeState,
          statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: iso(T0) }],
          mergeCommit: merged ? { oid: "f".repeat(40) } : null, mergedAt: merged ? iso(clock) : null,
        });
      }
      if (args[0] === "api" && args[1] === `repos/${REPO}/pulls/7/reviews?per_page=100`) return "";
      if (args[0] === "api" && args[1] === `repos/${REPO}/branches/main`) return "[]";
      if (args[0] === "repo") return JSON.stringify({ squashMergeAllowed: true });
      if (args[0] === "pr" && args[1] === "merge") { mergeState = "MERGED"; return ""; }
      throw new Error(`unexpected gh ${args.join(" ")}`);
    },
  });
  /* The fake `gh` above stands in for the App write seam as well: no token is minted. */
  ports.write = (args) => ports.run(args);

  await sweepAutoMerge(ports);
  const blocked = loadPipelines().find((pipeline) => pipeline.id === "pipe-merge")!;
  expect(blocked.merge).toMatchObject({ state: "blocked", reason: MERGE_REASONS.conflict, repository: REPO, prNumber: 7, chain: [HEAD] });

  const need = laneNeed(blocked);
  expect(need?.cleared).toBeNull();
  expect(need?.need).toMatchObject({ subject: "pipeline", kind: "lane-merge", key: "pipeline:pipe-merge:merge" });
  expect(pipelineAnswers(blocked, (stage) => stage.id)?.choices.map((choice) => choice.action)).toEqual(["dismiss", "retry-merge"]);

  /* Refused while the merge still waits, and while the setting is off. */
  setMergeOnReview(PROJECT, false, "operator");
  const off = await patchPipeline("pipe-merge", { action: "retry-merge" }, { now: () => iso(clock) } as never);
  expect(off.status).toBe(409);
  setMergeOnReview(PROJECT, true, "operator", iso(T0 - 7_200_000));

  const retried = await patchPipeline("pipe-merge", { action: "retry-merge" }, { now: () => iso(clock) } as never);
  expect(retried.error).toBeUndefined();
  expect(retried.pipeline?.merge).toMatchObject({ state: "queued", attempts: 1, reason: null, blockedAt: null, chain: [HEAD] });
  expect(laneNeed(retried.pipeline!)).toBeNull();
  const again = await patchPipeline("pipe-merge", { action: "retry-merge" }, { now: () => iso(clock) } as never);
  expect(again.status).toBe(409);

  /* The conflict is resolved elsewhere; the runner merges on its next reads. */
  mergeState = "CLEAN";
  for (let step = 0; step < 6; step += 1) {
    clock += MERGE_POLL_MS;
    await sweepAutoMerge(ports);
  }
  const merged = loadPipelines().find((pipeline) => pipeline.id === "pipe-merge")!;
  expect(merged.merge).toMatchObject({ state: "merged", by: "auto-merge", mergedHead: HEAD, mergeCommit: "f".repeat(40), method: "squash" });
  expect(calls.filter((args) => args[1] === "merge")).toEqual([["pr", "merge", "7", "--repo", REPO, "--squash", "--match-head-commit", HEAD]]);

  refreshLifecycleJournal({ pipelines: [merged] }, { force: true });
  const events = queryLifecycleEvents({ pipelineId: "pipe-merge", limit: 50 }).events;
  expect(events.filter((event) => event.type === "pipeline_merged").map((event) => event.summary)).toEqual([`pull request #7 merged by Delegatus, head ${HEAD} — ship the merge runner`]);
});

test("Leave the PR open clears the need and the record stays blocked", async () => {
  const lane = { ...completedLane("pipe-leave"), merge: {
    state: "blocked", by: null, repository: REPO, prNumber: 8, policyChangedAt: iso(T0), reviewedHead: HEAD, chain: [HEAD], updates: [],
    seenChecks: [], head: HEAD, headSeenAt: iso(T0), lastChecks: [], readAt: iso(T0), nextReadAt: null, readFailures: 0, requestedAt: iso(T0),
    mergedHead: null, mergeCommit: null, method: null, mergedAt: null, attempts: 0, reason: MERGE_REASONS.noChecks, blockedAt: iso(T0), updatedAt: iso(T0),
  } } as Pipeline;
  savePipelines([...loadPipelines(), lane]);
  const dismissed = await patchPipeline("pipe-leave", { action: "dismiss" }, { now: () => iso(T0 + 60_000) } as never);
  expect(dismissed.pipeline?.merge?.state).toBe("blocked");
  const need = laneNeed(dismissed.pipeline!);
  expect(need?.cleared).not.toBeNull();
  expect(pipelineAnswers(dismissed.pipeline!, (stage) => stage.id)).toBeNull();
});

test("a completed lane with no PR keeps its task open, persists a visible block, and retry-merge waits for a real PR", async () => {
  resetAutoMergeForTests();
  setMergeOnReview(PROJECT, true, "operator", iso(T0 - 7_200_000));
  const task = mutateTasks((tasks) => {
    const created = createTask(tasks, { project: PROJECT, text: "Deliver the reviewed change", placement: "unplaced" });
    if (!created.ok) throw new Error(created.error);
    return { tasks: created.tasks, result: created.task };
  });
  const lane = completedLane("pipe-no-pr");
  lane.baseRef = "b".repeat(40);
  lane.taskIds = [task.id];
  lane.finishesTaskIds = [task.id];
  lane.publishedCommit = HEAD;
  lane.delivery = {
    target: { repository: PROJECT, remote: `https://github.com/${REPO}.git`, branch: `refs/heads/${lane.branch}` },
    disposition: "owner", publish: "disabled", ownerId: lane.id, epoch: 1, active: false, journal: [],
  };
  savePipelines([lane]);
  let clock = T0;
  let merged = false;
  const calls: string[][] = [];
  const ports = productionAutoMergePorts({
    now: () => clock, loadPipelines, cachedState: () => null,
    run: async (args) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "view") {
        expect(args[2]).toBe("7");
        return JSON.stringify({
          state: merged ? "MERGED" : "OPEN", isDraft: false, headRefOid: HEAD, baseRefName: "main",
          mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
          statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
          mergeCommit: merged ? { oid: "f".repeat(40) } : null, mergedAt: merged ? iso(clock) : null,
        });
      }
      if (args[0] === "api" && args[1] === `repos/${REPO}/pulls/7/reviews?per_page=100`) return "";
      if (args[0] === "api" && args[1] === `repos/${REPO}/branches/main`) return "[]";
      if (args[0] === "repo") return JSON.stringify({ squashMergeAllowed: true });
      if (args[0] === "pr" && args[1] === "merge") { merged = true; return ""; }
      throw new Error(`unexpected gh ${args.join(" ")}`);
    },
  });
  ports.write = (args) => ports.run(args);

  await sweepAutoMerge(ports);
  await sweepTaskFinishes(ports);
  const blocked = loadPipelines()[0]!;
  expect(blocked.merge).toMatchObject({ state: "blocked", prNumber: null, reason: "no pull request is linked to this lane; open or attach its PR, then try the merge again" });
  expect(laneNeed(blocked)?.need.kind).toBe("lane-merge");
  expect(pipelineAnswers(blocked, (stage) => stage.id)?.choices.map((choice) => choice.action)).toContain("retry-merge");
  expect(loadTasks().find((item) => item.id === task.id)?.status).toBe("inbox");
  expect(blocked.taskFinishes).toBeUndefined();
  await sweepAutoMerge(ports);
  expect(loadPipelines()[0]!.merge).toEqual(blocked.merge);
  expect(calls).toEqual([]);

  const retried = await patchPipeline(lane.id, { action: "retry-merge" }, { now: () => iso(clock) } as never);
  expect(retried.error).toBeUndefined();
  await sweepAutoMerge(ports);
  expect(loadPipelines()[0]!.merge).toMatchObject({ state: "blocked", prNumber: null, attempts: 1 });
  expect(calls).toEqual([]);

  const attached = loadPipelines()[0]!;
  attached.delivery!.target.pr = 7;
  savePipelines([attached]);
  const withPr = await patchPipeline(lane.id, { action: "retry-merge" }, { now: () => iso(clock) } as never);
  expect(withPr.error).toBeUndefined();
  for (let step = 0; step < 6; step += 1) {
    clock += MERGE_POLL_MS;
    await sweepAutoMerge(ports);
    await sweepTaskFinishes(ports);
    if (!merged) expect(loadTasks().find((item) => item.id === task.id)?.status).toBe("inbox");
  }
  expect(loadPipelines()[0]!.merge).toMatchObject({ state: "merged", prNumber: 7, attempts: 2, mergedHead: HEAD });
  expect(loadTasks().find((item) => item.id === task.id)?.status).toBe("done");
  expect(calls.filter((args) => args[1] === "merge")).toHaveLength(1);
});

test("a human change request persists, and retry-merge waits for that reviewer's approval (#2866)", async () => {
  resetAutoMergeForTests();
  setMergeOnReview(PROJECT, true, "operator", iso(T0 - 7_200_000));
  savePipelines([completedLane("pipe-human-review")]);
  let clock = T0;
  let approved = false;
  let merged = false;
  let writes = 0;
  const ports = productionAutoMergePorts({
    now: () => clock, loadPipelines, pullRequestOf: () => ({ repository: REPO, number: 7 }), cachedState: () => null,
    run: async (args) => {
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({
        state: merged ? "MERGED" : "OPEN", isDraft: false, headRefOid: HEAD, baseRefName: "main",
        mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "",
        statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
      });
      if (args[0] === "api" && args[1]?.includes("/reviews")) return [
        { reviewer: "reviewer-a", isBot: false, state: "CHANGES_REQUESTED" },
        ...(approved ? [{ reviewer: "reviewer-a", isBot: false, state: "APPROVED" }] : []),
      ].map((review) => JSON.stringify(review)).join("\n");
      if (args[0] === "api") return "[]";
      if (args[0] === "repo") return JSON.stringify({ squashMergeAllowed: true });
      if (args[0] === "pr" && args[1] === "merge") { merged = true; return ""; }
      throw new Error(`unexpected gh ${args.join(" ")}`);
    },
  });
  ports.write = (args) => { writes += 1; return ports.run(args); };
  await sweepAutoMerge(ports);
  let stored = loadPipelines()[0]!;
  expect(stored.merge).toMatchObject({ state: "blocked", reason: "a reviewer requested changes" });
  expect(laneNeed(stored)?.need.kind).toBe("lane-merge");
  expect(pipelineAnswers(stored, (stage) => stage.id)?.choices.map((choice) => choice.action)).toContain("retry-merge");
  expect(writes).toBe(0);

  // A re-request changes no submitted review; retry must still refuse.
  expect((await patchPipeline(stored.id, { action: "retry-merge" }, { now: () => iso(clock) } as never)).error).toBeUndefined();
  clock += MERGE_POLL_MS;
  await sweepAutoMerge(ports);
  stored = loadPipelines()[0]!;
  expect(stored.merge).toMatchObject({ state: "blocked", reason: "a reviewer requested changes", attempts: 1 });
  expect(writes).toBe(0);

  approved = true;
  expect((await patchPipeline(stored.id, { action: "retry-merge" }, { now: () => iso(clock) } as never)).error).toBeUndefined();
  for (let step = 0; step < 6; step += 1) {
    clock += MERGE_POLL_MS;
    await sweepAutoMerge(ports);
  }
  expect(loadPipelines()[0]!.merge).toMatchObject({ state: "merged", by: "auto-merge", attempts: 2, reason: null });
  expect(writes).toBe(1);
});

function setBatchReviewHead(lane: Pipeline, graph: ReturnType<typeof batchLandingFixture>) {
  lane.lastPassedCommit = graph.outputHead ?? graph.head;
  if (!graph.outputHead) return;
  lane.publishedCommit = graph.head;
  lane.delivery = {
    target: { repository: PROJECT, remote: `https://github.com/${REPO}.git`, branch: `refs/heads/${lane.branch}` },
    disposition: "owner", publish: "disabled", ownerId: lane.id, epoch: 1, active: false, journal: [],
  };
  lane.stages[1]!.outputs = ["result.md"];
  const review = lane.runs[1]!.attempts[0]!;
  review.completedAt = lane.closedAt;
  review.outputBaseHead = lane.id.includes("unproved") ? graph.landing : graph.head;
}

// Archived batch lanes retained CLOSED plus a trusted landing receipt. The
// individual landing commit precedes the rebased batch's final merge commit.
for (const kind of ["rebased", "nearby-rebase", "offset-rebase", "local-output", "followup", "deletion", "binary", "mode"] as const) for (const initial of ["queued", "blocked", "refreshing"] as const) test(`batch-landed ${kind} closure settles a ${initial} lane without a worker ask`, async () => {
  const stopped = initial !== "queued";
  resetAutoMergeForTests();
  setMergeOnReview(PROJECT, true, "operator", iso(T0 - 7_200_000));
  const lane = completedLane("batch-landed");
  const graph = batchLandingFixture(sandbox, kind);
  lane.repoDir = graph.directory;
  Object.assign(lane, pipelineIdentity(lane.id, lane.task, lane.repoDir));
  setBatchReviewHead(lane, graph);
  const taskId = markedTask(lane);
  savePipelines([lane]);
  let receipt = !stopped;
  let readFailure = false;
  let clock = T0;
  const calls: string[][] = [];
  const landing = graph.landing;
  const batchTip = graph.tip;
  const ports = productionAutoMergePorts({
    now: () => clock, loadPipelines, pullRequestOf: () => ({ repository: REPO, number: 7 }),
    cachedState: () => "closed", log: () => undefined,
    write: async () => { throw new Error("a landed lane must never write to GitHub"); },
    run: async (args) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({
        state: args[2] === "9" ? "MERGED" : "CLOSED", headRefOid: graph.head, baseRefName: "main",
        mergeCommit: args[2] === "9" ? { oid: batchTip } : null, mergedAt: args[2] === "9" ? iso(T0 - 500) : null,
      });
      if (args[1] === `repos/${REPO}/branches/main`) return graph.base;
      if (args[1] === `repos/${REPO}/issues/7/comments?per_page=100`) {
        expect(args).toContain("--paginate");
        if (readFailure) throw new Error("comments unavailable");
        return receipt ? JSON.stringify({ body: `Landed on main as ${landing} through #9.`, author_association: "OWNER" }) : "";
      }
      if (args[1]?.startsWith(`repos/${REPO}/compare/`)) {
        const base = args[1].split("/compare/")[1]!.split("...")[0]!;
        return JSON.stringify({ status: "ahead", merge_base_commit: { sha: base } });
      }
      throw new Error(`unexpected gh ${args.join(" ")}`);
    },
  });
  if (stopped) {
    await sweepAutoMerge(ports);
    expect(loadPipelines()[0]!.merge?.state).toBe("blocked");
    expect(laneNeed(loadPipelines()[0]!)?.need.kind).toBe("lane-merge");
    expect(workerAsks(loadPipelines()[0]!)).toHaveLength(1);
    if (graph.outputHead) {
      // Replay the chain an older watcher stored before admitting the PR head.
      const legacy = loadPipelines()[0]!;
      legacy.merge!.chain = [graph.outputHead];
      savePipelines([legacy]);
    }
    await sweepTaskFinishes(ports);
    expect(loadTasks().find((task) => task.id === taskId)?.status).toBe("inbox");
    await sweepAutoMerge(ports);
    const reads = calls.length;
    await sweepAutoMerge(ports);
    expect(calls).toHaveLength(reads);
    const blockedAt = loadPipelines()[0]!.merge!.blockedAt;
    readFailure = true;
    clock += MERGE_POLL_MS;
    await sweepAutoMerge(ports);
    expect(loadPipelines()[0]!.merge).toMatchObject({ state: "blocked", reason: MERGE_REASONS.closed, blockedAt });
    expect(workerAsks(loadPipelines()[0]!)).toHaveLength(1);
    readFailure = false;
    receipt = true;
    clock += MERGE_POLL_MS;
    if (initial === "refreshing") {
      const refreshing = loadPipelines()[0]!;
      refreshing.merge!.state = "refreshing";
      refreshing.merge!.reason = null;
      refreshing.merge!.blockedAt = null;
      refreshing.merge!.refresh = { attempt: 1, base: batchTip, head: graph.head, key: "refresh-fixture", digest: "f".repeat(64), requestedAt: iso(clock), pipelineId: "successor" };
      savePipelines([refreshing]);
    }
  }
  let sharedMerge: Pipeline["merge"];
  let sharedChain: string[];
  if (kind === "local-output" && (initial === "blocked" || initial === "refreshing")) {
    const shared = loadPipelinesForList().find((candidate) => candidate.id === lane.id)!;
    sharedMerge = shared.merge;
    sharedChain = [...shared.merge!.chain];
    Object.freeze(shared.merge!.chain);
    Object.freeze(shared.merge);
    ports.loadPipelines = loadPipelinesForList;
  }
  await sweepAutoMerge(ports);
  if (kind === "local-output" && (initial === "blocked" || initial === "refreshing")) {
    expect(sharedMerge!.chain).toEqual(sharedChain!);
  }
  await sweepTaskFinishes(ports);
  const landed = loadPipelines()[0]!;
  expect(landed.merge).toMatchObject({ state: "merged", by: "outside", chain: [graph.head], mergedHead: graph.head, mergeCommit: landing, reason: null, blockedAt: null });
  expect(laneNeed(landed)).toBeNull();
  expect(workerAsks(landed)).toEqual([]);
  expect(loadTasks().find((task) => task.id === taskId)?.status).toBe("done");
  const reads = calls.length;
  await sweepAutoMerge(ports);
  await sweepTaskFinishes(ports);
  expect(calls).toHaveLength(reads);
  expect(loadPipelines()[0]!.taskFinishes).toHaveLength(1);
});

for (const kind of ["reverted", "new-head", "wrong-sha", "reverted-deletion", "partial-revert", "whitespace", "reverted-binary", "reverted-mode", "wrong-occurrence", "unproved-local-output"] as const) for (const initial of ["queued", "blocked"] as const) {
  test(`landing safety: ${kind} / ${initial}`, async () => {
    resetAutoMergeForTests();
    setMergeOnReview(PROJECT, true, "operator", iso(T0 - 7_200_000));
    const graph = batchLandingFixture(sandbox, kind);
    const lane = completedLane(`landing-${kind}-${initial}`);
    lane.repoDir = graph.directory;
    Object.assign(lane, pipelineIdentity(lane.id, lane.task, lane.repoDir));
    setBatchReviewHead(lane, graph);
    const taskId = markedTask(lane);
    savePipelines([lane]);
    let clock = T0;
    let receipt = initial === "queued";
    const ports = productionAutoMergePorts({
      now: () => clock, loadPipelines, pullRequestOf: () => ({ repository: REPO, number: 7 }),
      cachedState: () => "closed", log: () => undefined,
      write: async () => { throw new Error("closed PR must not write"); },
      run: async (args) => {
        if (args[0] === "pr" && args[1] === "view") return JSON.stringify({
          state: args[2] === "9" ? "MERGED" : "CLOSED", headRefOid: graph.head, baseRefName: "main",
          mergeCommit: args[2] === "9" ? { oid: graph.tip } : null, mergedAt: iso(T0 - 500),
        });
        if (args[1] === `repos/${REPO}/issues/7/comments?per_page=100`) return receipt
          ? JSON.stringify({ body: `Landed on main as ${graph.landing} through #9.`, author_association: "OWNER" }) : "";
        if (args[1] === `repos/${REPO}/branches/main`) return graph.base;
        if (args[1]?.startsWith(`repos/${REPO}/compare/`)) {
          const [base, target] = args[1].split("/compare/")[1]!.split("...").map(decodeURIComponent);
          graph.git("merge-base", "--is-ancestor", base!, target!);
          return JSON.stringify({ status: base === target ? "identical" : "ahead", merge_base_commit: { sha: base } });
        }
        throw new Error(`unexpected gh ${args.join(" ")}`);
      },
    });
    await sweepAutoMerge(ports);
    if (initial === "blocked") {
      expect(loadPipelines()[0]!.merge?.state).toBe("blocked");
      receipt = true;
      clock += MERGE_POLL_MS;
      await sweepAutoMerge(ports);
    }
    await sweepTaskFinishes(ports);
    const stored = loadPipelines()[0]!;
    expect(stored.merge?.state).toBe("blocked");
    expect(stored.merge).toMatchObject({ state: "blocked", reason: MERGE_REASONS.closed, mergeCommit: null });
    expect(stored.taskFinishes ?? []).toHaveLength(0);
    expect(loadTasks().find((task) => task.id === taskId)?.status).toBe("inbox");
    expect(workerAsks(stored)).toHaveLength(1);
    expect(graph.git("status", "--porcelain")).toBe("");
    expect(graph.git("rev-parse", "main")).toBe(graph.base);
  });
}

for (const kind of ["read-only outputs", "unchanged writer then outputs", "unchanged", "published prototype"] as const) for (const stopped of [false, true]) {
  test(`no PR is expected for ${kind}: ${stopped ? "retire the old stop" : "skip admission"}, no worker ask, marked task finishes`, async () => {
    resetAutoMergeForTests();
    setMergeOnReview(PROJECT, true, "operator", iso(T0 - 7_200_000));
    const lane = missingPrLane(`no-pr-${kind.replaceAll(" ", "-")}`);
    const taskId = markedTask(lane);
    const ports = productionAutoMergePorts({
      now: () => T0, loadPipelines, pullRequestOf: () => null, cachedState: () => null,
      run: async () => { throw new Error("no PR means no GitHub reads"); },
    });
    if (stopped) {
      savePipelines([lane]);
      await sweepAutoMerge(ports);
      lane.merge = loadPipelines()[0]!.merge;
      expect(lane.merge?.reason).toBe(MERGE_REASONS.noPr);
    }
    if (kind === "unchanged") lane.baseRef = HEAD;
    if (kind === "unchanged writer then outputs") {
      lane.runs[0]!.attempts[0]!.completedAt = iso(T0 - 60_000);
      lane.stages[1]!.outputs = ["docs/design/audit.md"];
      lane.runs[1]!.attempts[0]!.outputBaseHead = lane.baseRef;
    }
    if (kind === "read-only outputs") {
      // Archived design/prototype lanes advance HEAD through controller-owned
      // output commits, including when the critic spends its fail-edge budget.
      lane.stages[0]!.effectiveRole = REVIEWER as never;
      lane.stages[0]!.outputs = ["docs/design/prototype"];
      lane.runs[0]!.attempts[0]!.effectiveRole = REVIEWER as never;
      lane.runs[0]!.attempts[0]!.outputBaseHead = lane.baseRef;
    }
    if (kind === "published prototype") {
      // The later archived prototype used writable builders and a terminal
      // publisher. Its form is durably bound to that exact lane and attempt.
      lane.stages.push({ id: "publish", kind: "run", prompt: "publish", next: null, onFail: null, effectiveRole: BUILDER } as never);
      lane.stages[1]!.next = "publish";
      lane.runs.push({ stageId: "publish", attempts: [attempt(1, "passed", BUILDER)] } as never);
      lane.runs.at(-1)!.attempts[0]!.report = {
        seq: 1, at: iso(T0 - 30_000), actor: { kind: "operator" }, verdict: { status: "pass" }, summary: null, calls: 1,
        provenance: { state: "complete", head: HEAD, branch: lane.branch, uncommitted: [], pullRequest: null, pullRequestState: "absent", outputs: [] },
      };
      mutateTasks((tasks) => {
        tasks.find((task) => task.id === taskId)!.prototypeReviews = [{
          id: `pr_${"a".repeat(32)}`, title: "Prototype choices", taskId, project: PROJECT, createdAt: iso(T0 - 500),
          source: { conversationId: null, pipelineId: lane.id, stageId: "publish", attempt: 1 },
          publicationKey: "prototype-fixture", inputDigest: "fixture", variants: [],
        }];
        return { tasks, result: undefined };
      });
    }
    savePipelines([lane]);
    await sweepAutoMerge(ports);
    await sweepTaskFinishes(ports);
    expect(loadPipelines()[0]!.merge).toBeUndefined();
    expect(laneNeed(loadPipelines()[0]!)).toBeNull();
    expect(workerAsks(loadPipelines()[0]!)).toEqual([]);
    expect(loadTasks().find((task) => task.id === taskId)?.status).toBe("done");
  });
}

for (const evidence of ["another lane's form", "earlier publisher attempt", "older published head", "writer changed the output base", "pre-settlement report only"] as const) {
  test(`${evidence} keeps a missing implementation PR blocked`, async () => {
    resetAutoMergeForTests();
    setMergeOnReview(PROJECT, true, "operator", iso(T0 - 7_200_000));
    const lane = missingPrLane("implementation-needs-pr");
    const taskId = markedTask(lane);
    const publisher = lane.runs[1]!.attempts[0]!;
    publisher.report = {
      seq: 1, at: iso(T0 - 30_000), actor: { kind: "operator" }, verdict: { status: "pass" }, summary: null, calls: 1,
      provenance: { state: "complete", head: evidence === "older published head" ? lane.baseRef : HEAD,
        branch: lane.branch, uncommitted: [], pullRequest: null, pullRequestState: "absent", outputs: [] },
    };
    if (evidence === "earlier publisher attempt") {
      lane.runs[1]!.attempts.unshift(structuredClone(publisher));
      publisher.n = 2;
    }
    if (evidence === "writer changed the output base") {
      publisher.outputBaseHead = "c".repeat(40);
      lane.runs[0]!.attempts[0]!.completedAt = iso(T0 - 60_000);
    }
    if (evidence === "pre-settlement report only") {
      lane.runs[0]!.attempts[0]!.report = structuredClone(publisher.report);
      lane.runs[0]!.attempts[0]!.report!.provenance.head = lane.baseRef;
    }
    if (evidence.includes("form") || evidence.includes("publisher") || evidence.includes("published")) mutateTasks((tasks) => {
      tasks.find((task) => task.id === taskId)!.prototypeReviews = [{
        id: `pr_${"b".repeat(32)}`, title: "Choices", taskId, project: PROJECT, createdAt: iso(T0 - 500),
        source: { conversationId: null, pipelineId: evidence === "another lane's form" ? "different-lane" : lane.id, stageId: "review", attempt: 1 },
        publicationKey: "wrong-form-fixture", inputDigest: "fixture", variants: [],
      }];
      return { tasks, result: undefined };
    });
    savePipelines([lane]);
    const ports = productionAutoMergePorts({
      now: () => T0, loadPipelines, pullRequestOf: () => null, cachedState: () => null,
      run: async () => { throw new Error("a missing PR must not query GitHub"); },
    });
    await sweepAutoMerge(ports);
    await sweepTaskFinishes(ports);
    expect(loadPipelines()[0]!.merge).toMatchObject({ state: "blocked", reason: MERGE_REASONS.noPr });
    expect(workerAsks(loadPipelines()[0]!)).toHaveLength(1);
    expect(loadTasks().find((task) => task.id === taskId)?.status).toBe("inbox");
  });
}


describe("refresh retry recovery", () => {
  async function waitingRefresh(state: Pipeline["state"]) {
    resetAutoMergeForTests();
    setMergeOnReview(PROJECT, true, "operator", iso(T0 - 7_200_000));
    const parent = completedLane("refresh-parent");
    parent.workLinks = [{ kind: "pr", repository: REPO, number: 7, addedAt: iso(T0), addedBy: "operator" }];
    savePipelines([parent]);
    expect((await patchPipeline(parent.id, { action: "retry-merge" }, { now: () => iso(T0) } as never)).error).toBeUndefined();
    const waiting = loadPipelines()[0]!;
    waiting.merge!.state = "refreshing";
    waiting.merge!.refresh = { attempt: 0, base: "b".repeat(40), head: HEAD, key: "refresh-recovery", digest: "c".repeat(64), requestedAt: iso(T0), pipelineId: "refresh-child" };
    const child = completedLane("refresh-child");
    child.refreshOf = { pipelineId: waiting.id, base: "b".repeat(40) };
    child.lastPassedCommit = "d".repeat(40);
    child.workLinks = structuredClone(parent.workLinks);
    child.state = state;
    savePipelines([waiting, child]);
    return { waiting, child };
  }

  test.each(["completed", "closed"] as const)("retry accepts a refreshing record after its refresh lane is %s", async state => {
    const { waiting, child } = await waitingRefresh(state);
    const result = await patchPipeline(waiting.id, { action: "retry-merge" }, { now: () => iso(T0 + 1_000) } as never);
    expect(result.error).toBeUndefined();
    const stored = loadPipelines();
    if (state === "completed") {
      expect(stored.find(lane => lane.id === child.id)?.merge).toMatchObject({ state: "queued", reviewedHead: child.lastPassedCommit });
      expect(stored.find(lane => lane.id === waiting.id)?.merge?.refresh?.pipelineId).toBe(child.id);
    } else {
      expect(stored.find(lane => lane.id === waiting.id)?.merge).toMatchObject({ state: "queued", attempts: 1 });
      expect(stored.find(lane => lane.id === waiting.id)?.merge?.refresh).toBeUndefined();
    }
  });

  test.each(["running", "needs_decision"] as const)("retry refuses a refresh still %s", async state => {
    const { waiting } = await waitingRefresh(state);
    const before = loadPipelines();
    const result = await patchPipeline(waiting.id, { action: "retry-merge" }, { now: () => iso(T0 + 1_000) } as never);
    expect(result.status).toBe(409);
    expect(loadPipelines()).toEqual(before);
  });

  test.each(["lineage", "project", "PR", "review"] as const)("retry refuses changed refresh %s evidence without changing either lane", async evidence => {
    const { waiting } = await waitingRefresh("completed");
    const lanes = loadPipelines();
    const child = lanes.find(lane => lane.id === "refresh-child")!;
    if (evidence === "lineage") child.refreshOf!.base = "e".repeat(40);
    if (evidence === "project") child.project = "repo-other";
    if (evidence === "PR") child.workLinks![0]!.number = 9;
    if (evidence === "review") child.runs[1]!.attempts[0]!.state = "failed";
    savePipelines(lanes);
    const before = loadPipelines();
    const result = await patchPipeline(waiting.id, { action: "retry-merge" }, { now: () => iso(T0 + 1_000) } as never);
    expect(result.status).toBe(409);
    expect(loadPipelines()).toEqual(before);
  });

  test("retry recovery uses persisted completion and settings after a process restart", async () => {
    await waitingRefresh("completed");
    const childRoot = fs.mkdtempSync(path.join(sandbox, "refresh-restart-"));
    for (const directory of ["home", "config", "tmp"]) fs.mkdirSync(path.join(childRoot, directory));
    const reader = Bun.spawn([process.execPath, "-e", `
      const { patchPipeline } = await import("./src/lib/pipelines/engine.ts");
      const { loadPipelines } = await import("./src/lib/pipelines/store.ts");
      const result = await patchPipeline("refresh-parent", { action: "retry-merge" }, { now: () => "2026-09-25T10:00:01.000Z" });
      console.log(JSON.stringify({ error: result.error ?? null, lanes: loadPipelines().map(lane => [lane.id, lane.merge?.state, lane.merge?.reviewedHead]).sort((a, b) => a[0].localeCompare(b[0])) }));
    `], {
      cwd: process.cwd(), env: { ...process.env, HOME: path.join(childRoot, "home"), XDG_CONFIG_HOME: path.join(childRoot, "config"),
        TMPDIR: path.join(childRoot, "tmp"), LLV_STATE_DIR: sandbox, LLV_STAGING: "1", LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" }, stdout: "pipe", stderr: "pipe",
    });
    const [output, error, code] = await Promise.all([new Response(reader.stdout).text(), new Response(reader.stderr).text(), reader.exited]);
    expect({ code, error }).toEqual({ code: 0, error: "" });
    expect(JSON.parse(output)).toEqual({ error: null, lanes: [["refresh-child", "queued", "d".repeat(40)], ["refresh-parent", "queued", HEAD]] });
  });

  test.each(["completed", "closed"] as const)("a stale refreshing record on a %s lane cannot prevent a carrier on the same PR from queueing", async state => {
    const { waiting } = await waitingRefresh("closed");
    const closed = loadPipelines().find(lane => lane.id === waiting.id)!;
    closed.state = state;
    const carrier = completedLane("carrier");
    carrier.workLinks = structuredClone(closed.workLinks);
    savePipelines([closed, carrier]);
    const ports = productionAutoMergePorts({ now: () => T0, loadPipelines: loadPipelinesForList,
      cachedState: () => null, run: async () => { throw new Error("offline fixture"); }, log: () => undefined });
    await sweepAutoMerge(ports);
    expect(loadPipelines().find(lane => lane.id === carrier.id)?.merge).toMatchObject({ prNumber: 7, reviewedHead: HEAD });
  });
});
