import { expect, test } from "bun:test";

import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import { buildProjectSummaries } from "../projectModel";
import { buildNeedsYouQueue } from "./attentionQueue";
import { needsYouCounts, needsYouDismissal, needsYouEntryRole, needsYouSections, needsYouSubject } from "./needsYouPanel";

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

test("the queue is grouped by project: the project on screen first, the rest in the order of their oldest wait", () => {
  const sections = needsYouSections(QUEUE, "alpha");
  expect(sections.map((section) => [section.project, section.entries.map((entry) => entry.id)])).toEqual([
    ["alpha", ["/alpha-builder:waiting:" + (NOW - 2_000), "ask-1", "ask-2", "lane-alpha"]],
    ["gamma", ["/gamma-old:waiting:" + (NOW - 3_000)]],
    ["beta", ["/beta:waiting:" + (NOW - 1_000)]],
  ]);
  /* On the Overview no project leads. */
  expect(needsYouSections(QUEUE, null).map((section) => section.project)).toEqual(["gamma", "alpha", "beta"]);
  /* A project with nothing waiting has no section, even on screen. */
  expect(needsYouSections(QUEUE, "delta").map((section) => section.project)).toEqual(["gamma", "alpha", "beta"]);
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
  expect(all.subjects.map((subject) => subject.kind)).toEqual(["conversation", "report", "report", "pipeline"]);
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
