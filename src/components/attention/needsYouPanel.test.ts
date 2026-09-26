import { expect, test } from "bun:test";

import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import { buildProjectSummaries, railProjectOrder } from "../projectModel";
import { buildNeedsYouQueue } from "./attentionQueue";
import { needsYouCounts, needsYouDismissal, needsYouEntryRole, needsYouEntrySince, needsYouSections, needsYouSubject } from "./needsYouPanel";

/*
 * The needs-you panel's pure half (docs/design/needs-you-options.md, option
 * B): the one queue by project, the role behind each row, what «Dismiss»
 * names, and the per-project count the rail reads.
 */

const NOW = 1_800_000_000;
const iso = (secondsAgo: number) => new Date((NOW - secondsAgo) * 1000).toISOString();

function file(path: string, project: string, over: Partial<FileEntry> = {}): FileEntry {
  return {
    root: "claude-projects", name: path, path, project, title: path, engine: "claude", kind: "session", fmt: "claude",
    parent: null, mtime: NOW - 60, size: 10, activity: "idle", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null,
    conversationId: `conversation_${path.slice(1)}`,
    ...over,
  } as FileEntry;
}

function lane(id: string, project: string, over: Partial<Pipeline> = {}): Pipeline {
  return {
    id, task: `Lane ${id}`, taskIds: [], project, repoDir: "/repo", worktreeDir: "/repo-lane", branch: `lane/${id}`, baseBranch: "main", baseRef: "main",
    lastPassedCommit: "",
    stages: [
      { id: "implement", kind: "run", effectiveRole: { roleId: "builder" } },
      { id: "verify", kind: "run", effectiveRole: { roleId: "verifier" } },
    ],
    runs: [{ stageId: "verify", attempts: [{ n: 1, state: "failed", verdict: { status: "fail", findings: ["one"] }, completedAt: iso(900) }] }],
    cursor: { stageId: "verify", state: "needs_decision", input: null, activatedBy: null },
    state: "needs_decision", pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null, createdAt: iso(7_200), closedAt: null,
    ...over,
  } as unknown as Pipeline;
}

const waiting = (since: number) => ({ waitingInput: { since: NOW - since, screenTail: "❯ 1. Yes", target: "llv:0.0", menu: null } }) as Partial<FileEntry>;

/* Three projects, the oldest wait in «gamma». alpha's seat has two open
   questions in the report log. */
const FILES = [
  file("/gamma-old", "gamma", waiting(3_000)),
  file("/alpha-builder", "alpha", { ...waiting(2_000), durableLineage: { kind: "spawn", role: "builder", parentConversationId: null, reviewsConversationId: null, memberships: [] } } as unknown as Partial<FileEntry>),
  file("/beta", "beta", waiting(1_000)),
  file("/alpha-seat", "alpha", {
    bridgeAsks: [
      { id: "ask-1", at: iso(500), seq: 21, body: "Keep 25 MB?" },
      { id: "ask-2", at: iso(400), seq: 22, body: "Weekends too?" },
    ],
    bridgeAsk: { id: "ask-2", at: iso(400), seq: 22, body: "Weekends too?" },
  }),
];
const PIPELINES = [lane("lane-alpha", "alpha"), lane("lane-beta-dismissed", "beta", { dismissedAt: iso(10), dismissedBy: { kind: "operator" } } as Partial<Pipeline>)];
const QUEUE = buildNeedsYouQueue(FILES, PIPELINES, NOW, []);

test("an orchestrator seat with several open questions is several rows, each carrying its report", () => {
  const asks = QUEUE.filter((entry) => entry.kind === "conversation" && entry.item.reason.report);
  expect(asks.map((entry) => entry.id)).toEqual(["ask-1", "ask-2"]);
  expect(asks.map((entry) => entry.kind === "conversation" ? entry.item.reason.report : null)).toEqual([{ seq: 21, body: "Keep 25 MB?" }, { seq: 22, body: "Weekends too?" }]);
});

test("the queue is grouped by project: the project on screen first, rows oldest wait first with lanes among the conversations", () => {
  const sections = needsYouSections(QUEUE, "alpha");
  expect(sections.map((section) => [section.project, section.entries.map((entry) => entry.id)])).toEqual([
    /* The lane parked 900 s ago sits between the 2 000 s wait and the questions of 500 s and 400 s. */
    ["alpha", ["/alpha-builder:waiting:" + (NOW - 2_000), "lane-alpha", "ask-1", "ask-2"]],
    ["gamma", ["/gamma-old:waiting:" + (NOW - 3_000)]],
    ["beta", ["/beta:waiting:" + (NOW - 1_000)]],
  ]);
  for (const section of sections) {
    const since = section.entries.map((entry) => needsYouEntrySince(entry)!);
    expect(since).toEqual([...since].sort((a, b) => a - b));
  }
  /* On the Overview no project leads. */
  expect(needsYouSections(QUEUE, null).map((section) => section.project)).toEqual(["gamma", "alpha", "beta"]);
  /* A project with nothing waiting has no section, even on screen. */
  expect(needsYouSections(QUEUE, "delta").map((section) => section.project)).toEqual(["gamma", "alpha", "beta"]);
});

test("the sections after the project on screen follow the rail's order, crowned projects first", () => {
  /* The rail as it lists these projects: beta crowned, then the rest by its own rule. */
  const summaries = buildProjectSummaries(FILES, NOW, [], [], PIPELINES, {}, needsYouCounts(QUEUE));
  const rail = railProjectOrder(summaries, new Set(["beta"]), new Set());
  expect(rail[0]).toBe("beta");
  const overview = needsYouSections(QUEUE, null, rail).map((section) => section.project);
  expect(overview).toEqual(rail.filter((project) => overview.includes(project)));
  /* The queue's own order would have put gamma, the oldest wait, first. */
  expect(overview).not.toEqual(needsYouSections(QUEUE, null).map((section) => section.project));
  /* On a project, it leads and the others keep the rail's order. */
  const onGamma = needsYouSections(QUEUE, "gamma", rail).map((section) => section.project);
  expect(onGamma).toEqual(["gamma", ...rail.filter((project) => project !== "gamma" && overview.includes(project))]);
  /* A project the rail does not list follows the ones it does. */
  expect(needsYouSections(QUEUE, null, ["beta"]).map((section) => section.project)).toEqual(["beta", "gamma", "alpha"]);
});

test("each row's role: the spawn role, the orchestrator for a question in the report log, the stage a lane stopped on", () => {
  const roles = Object.fromEntries(QUEUE.map((entry) => [entry.id, needsYouEntryRole(entry, PIPELINES)]));
  expect(roles[`/alpha-builder:waiting:${NOW - 2_000}`]).toBe("builder");
  expect(roles["ask-1"]).toBe("orchestrator");
  expect(roles["lane-alpha"]).toBe("verifier");
  expect(roles[`/beta:waiting:${NOW - 1_000}`]).toBe("neutral");
});

test("«Dismiss» names exactly what the row drew: a report by seq, a conversation by its reason, a lane by its movement", () => {
  const byId = new Map(QUEUE.map((entry) => [entry.id, entry] as const));
  expect(needsYouSubject(byId.get("ask-2")!)).toEqual({ kind: "report", seq: 22 });
  expect(needsYouSubject(byId.get(`/beta:waiting:${NOW - 1_000}`)!)).toEqual({
    kind: "conversation", conversationId: "conversation_beta", path: "/beta", reasonId: `/beta:waiting:${NOW - 1_000}`, reason: "permission",
  });
  expect(needsYouSubject(byId.get("lane-alpha")!)).toMatchObject({ kind: "pipeline", pipelineId: "lane-alpha" });
  const all = needsYouDismissal(needsYouSections(QUEUE, "alpha")[0]!.entries);
  expect(all.target).toEqual({ kind: "subjects", subjects: all.subjects });
  expect(all.subjects.map((subject) => subject.kind)).toEqual(["conversation", "pipeline", "report", "report"]);
});

test("the rail's ⏸ reads the panel's grouping: one number per project, a dismissed lane counted nowhere", () => {
  const counts = needsYouCounts(QUEUE);
  expect(Object.fromEntries(counts)).toEqual({ gamma: 1, alpha: 4, beta: 1 });
  const summaries = Object.fromEntries(buildProjectSummaries(FILES, NOW, [], [], PIPELINES, {}, counts).map((summary) => [summary.project, summary.attentionCount]));
  expect(summaries).toEqual({ gamma: 1, alpha: 4, beta: 1 });
  /* Without the grouping the rail counted the dismissed lane and one row for
     a seat with two questions. */
  const legacy = Object.fromEntries(buildProjectSummaries(FILES, NOW, [], [], PIPELINES, {}).map((summary) => [summary.project, summary.attentionCount]));
  expect(legacy).not.toEqual(summaries);
});
