import { expect, test } from "bun:test";

import type { Flow } from "@/lib/flows/types";

import { evaluateReaper, runEvaluatedReaper, type HeadlessReviewerProcess, type ReaperInput } from "./reaper";

const NOW = Date.parse("2026-07-12T12:00:00.000Z");

function transcript(index: number): string {
  return `/transcripts/rollout-2026-07-12T00-00-00-019f5${String(index).padStart(7, "0")}-1111-7111-8111-111111111111.jsonl`;
}

function flow(id: string, implementerPath: string, reviewerPath: string): Flow {
  return {
    id, template: "implement-review-loop", project: "repo", cwd: "/repo", implementerPath,
    roles: { implementer: { engine: "codex", model: null, effort: null }, reviewer: { engine: "codex", model: null, effort: null } },
    baseRef: "base", baseMode: "merge-base", mode: "auto", reviewerMode: "headless", roundLimit: 1,
    state: "closed", stateDetail: null, rounds: [{
      n: 1, reviewerPath, reviewerPid: null, reviewerPane: null, findingsPath: "/findings", triggeredBy: "marker",
      readyNote: null, verdict: "APPROVE", findingsCount: 0, startedAt: new Date(NOW - 20 * 60_000).toISOString(),
      reviewedAt: new Date(NOW - 6 * 60_000).toISOString(), relayedAt: null, error: null,
    }], createdAt: new Date(NOW - 60 * 60_000).toISOString(), closedAt: new Date(NOW - 31 * 60_000).toISOString(),
  } as Flow;
}

function reviewer(flowId: string, pid: number, pathname: string): HeadlessReviewerProcess {
  return { flowId, round: 1, pid, identity: `${pid}:one`, path: pathname };
}

function input(overrides: Partial<ReaperInput> = {}): ReaperInput {
  return { now: NOW, reviewerProcesses: [], flows: [], enabled: false, ...overrides };
}

test("a finished headless reviewer is a process candidate with the reviewer idle TTL", () => {
  const reviewerPath = transcript(3);
  const report = evaluateReaper(input({
    flows: [flow("flow-1", transcript(2), reviewerPath)],
    reviewerProcesses: [reviewer("flow-1", 3003, reviewerPath)],
  }));

  expect(report.agents).toMatchObject([{
    targetKind: "process", paneId: null, agentPid: 3003, class: "headless-reviewer", ttlSeconds: 300, eligible: true,
  }]);
  expect(report.eligibleCount).toBe(1);
});

test("a reviewer without a verdict, or inside its idle TTL, is retained", () => {
  const pendingPath = transcript(4);
  const pending = flow("flow-pending", transcript(5), pendingPath);
  pending.rounds[0] = { ...pending.rounds[0]!, verdict: null, reviewedAt: null };
  const freshPath = transcript(6);
  const fresh = flow("flow-fresh", transcript(7), freshPath);
  fresh.rounds[0] = { ...fresh.rounds[0]!, reviewedAt: new Date(NOW - 60_000).toISOString() };

  const report = evaluateReaper(input({
    flows: [pending, fresh],
    reviewerProcesses: [reviewer("flow-pending", 3004, pendingPath), reviewer("flow-fresh", 3006, freshPath), reviewer("flow-gone", 3008, transcript(8))],
  }));

  expect(report.agents.map((agent) => [agent.agentPid, agent.eligible, agent.protectedReasons])).toEqual([
    [3004, false, ["review-verdict-pending", "observation-pending"]],
    [3006, false, ["idle-ttl"]],
    [3008, false, ["unclassified", "observation-pending"]],
  ]);
});

test("dry-run is the default and real mode journals every actuation with its class reason", async () => {
  const reviewerPath = transcript(20);
  const base = input({
    flows: [flow("flow-20", transcript(21), reviewerPath)],
    reviewerProcesses: [reviewer("flow-20", 3020, reviewerPath)],
  });
  let kills = 0;
  const dry = await runEvaluatedReaper(evaluateReaper(base), {
    actuate: async () => { kills += 1; return true; }, journal: () => {},
  });
  expect(dry.mode).toBe("dry-run");
  expect(dry.agents[0]?.action).toBe("dry-run");
  expect(kills).toBe(0);

  const journal: unknown[] = [];
  const real = await runEvaluatedReaper(evaluateReaper({ ...base, enabled: true }), {
    actuate: async () => { kills += 1; return true; }, journal: (record) => journal.push(record),
  });
  expect(real.mode).toBe("active");
  expect(real.agents[0]?.action).toBe("reaped");
  expect(journal).toMatchObject([{ targetKind: "process", agentPid: 3020, class: "headless-reviewer", reason: "idle-ttl-exceeded", outcome: "reaped" }]);
});

test("one rejected actuation is journaled and later candidates continue", async () => {
  const first = transcript(31);
  const second = transcript(32);
  const report = evaluateReaper(input({
    enabled: true,
    flows: [flow("flow-31", transcript(33), first), flow("flow-32", transcript(34), second)],
    reviewerProcesses: [reviewer("flow-31", 3031, first), reviewer("flow-32", 3032, second)],
  }));
  const journals: unknown[] = [];
  let attempts = 0;

  await expect(runEvaluatedReaper(report, {
    actuate: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("lock rejected");
      return true;
    },
    journal: (record) => journals.push(record),
  })).resolves.toBe(report);

  expect(report.agents.map((agent) => agent.action)).toEqual(["kill-failed", "reaped"]);
  expect(journals).toMatchObject([{ outcome: "kill-failed" }, { outcome: "reaped" }]);
});

test("an errored headless reviewer ages from its persisted terminal timestamp", () => {
  const reviewerPath = transcript(41);
  const erroredFlow = flow("flow-errored-reviewer", transcript(40), reviewerPath);
  erroredFlow.rounds[0] = {
    ...erroredFlow.rounds[0]!,
    verdict: null,
    reviewedAt: null,
    error: "reviewer timed out",
    terminalAt: new Date(NOW - 6 * 60_000).toISOString(),
  };
  const report = evaluateReaper(input({
    flows: [erroredFlow],
    reviewerProcesses: [reviewer(erroredFlow.id, 3041, reviewerPath)],
  }));

  expect(report.agents[0]).toMatchObject({
    class: "headless-reviewer",
    idleSeconds: 360,
    eligible: true,
    protectedReasons: [],
  });
});
