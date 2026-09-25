import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Pipeline } from "@/lib/pipelines/types";

/* The merge runner against the real pipeline store and settings file
   (#2187 §4.1, §4.4, §4.6): a record it writes survives the store's
   validation, a stopped merge raises lane-merge, and retry-merge requeues it.
   The stores resolve their state directory at import, so a sandbox is pinned
   before any of them loads. */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-auto-merge-store-"));
const previousStateDir = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = sandbox;

const { MERGE_POLL_MS, MERGE_REASONS, productionAutoMergePorts, resetAutoMergeForTests, sweepAutoMerge } = await import("./autoMerge");
const { patchPipeline } = await import("@/lib/pipelines/engine");
const { loadPipelines, pipelineIdentity, savePipelines } = await import("@/lib/pipelines/store");
const { mergeOnReviewSetting, resetProjectSettingsForTests, setMergeOnReview } = await import("@/lib/projects/settings");
const { laneNeed } = await import("@/components/attention/needReason");
const { pipelineAnswers } = await import("@/components/pipelines/pipelineBlockModel");
const { refreshLifecycleJournal } = await import("@/lib/lifecycle/projector");
const { queryLifecycleEvents } = await import("@/lib/lifecycle/journal");

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
      if (args[0] === "api" && args[1] === `repos/${REPO}/branches/main`) return "[]";
      if (args[0] === "repo") return JSON.stringify({ squashMergeAllowed: true });
      if (args[0] === "pr" && args[1] === "merge") { mergeState = "MERGED"; return ""; }
      throw new Error(`unexpected gh ${args.join(" ")}`);
    },
  });

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
  expect(events.filter((event) => event.type === "pipeline_merged").map((event) => event.summary)).toEqual(["pull request #7 merged by Delegatus"]);
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
