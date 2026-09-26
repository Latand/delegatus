import { expect, test } from "bun:test";

import { needsDecisionPipelineRows } from "@/components/mobile/mobileBoardModel";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import { advanceAttentionCycle, buildAttentionQueue } from "../attention";
import { attentionEntryProject, buildMobileAttentionQueue, buildNeedsYouQueue, laneFocusId, laneFocusPath } from "./attentionQueue";

/*
 * One list for the phone (README §4.1, §4.6): conversations waiting on the
 * operator and pipelines in `needs_decision`, joined in the board's order.
 */

const NOW = 1_800_000_000;
const PROJECT = "atlas";

function waiting(path: string, since: number): FileEntry {
  return {
    root: "claude-projects", name: path, path, project: PROJECT, title: path, engine: "claude", kind: "session", fmt: "claude",
    parent: null, mtime: NOW - 60, size: 10, activity: "idle", proc: null, pid: null, model: "opus", pendingQuestion: null,
    waitingInput: { since, screenTail: "❯ 1. Yes", target: "llv:0.0", menu: null },
  } as FileEntry;
}

function pipeline(id: string, state: Pipeline["state"], completedAt: number): Pipeline {
  return {
    id, task: `Lane ${id}`, taskIds: [], project: PROJECT, repoDir: "/repo", worktreeDir: "/repo-lane", branch: "lane/1", baseBranch: "main", baseRef: "main",
    lastPassedCommit: "", stages: [{ id: "implement", kind: "run" }, { id: "review", kind: "review-loop" }],
    runs: [{ stageId: "review", attempts: [{ n: 1, state: "failed", verdict: { status: "fail", findings: ["one"] }, completedAt: new Date(completedAt * 1_000).toISOString() }] }],
    cursor: { stageId: "review", state: "reviewing", input: null, activatedBy: null },
    state, pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null,
    createdAt: new Date((NOW - 7_200) * 1_000).toISOString(), closedAt: null,
  } as unknown as Pipeline;
}

const conversations = buildAttentionQueue([waiting("/p/new.jsonl", NOW - 100), waiting("/p/old.jsonl", NOW - 900)], NOW, PROJECT);
const pipelines = needsDecisionPipelineRows([pipeline("p-decide", "needs_decision", NOW - 3_600), pipeline("p-run", "running", NOW - 60)], PROJECT, NOW);

test("conversations and needs_decision pipelines are ONE list, conversations in queue order first, then the pipelines", () => {
  const entries = buildMobileAttentionQueue(conversations, pipelines);
  expect(entries.map((entry) => `${entry.kind}:${entry.kind === "conversation" ? entry.item.file.path : entry.row.id}`)).toEqual([
    "conversation:/p/old.jsonl",
    "conversation:/p/new.jsonl",
    "pipeline:p-decide",
  ]);
  /* A running pipeline is not a decision, so it is not in the list — and the
     badge that counts this list agrees with the board's Needs-you section. */
  expect(entries).toHaveLength(3);
  expect(entries.every((entry) => entry.id.length > 0)).toBe(true);
});

/* The desktop island and the phone badge read one list (#2129). */

const iso = (seconds: number) => new Date(seconds * 1_000).toISOString();
const parked = pipeline("p-decide", "needs_decision", NOW - 3_600);
/** The same lane, dismissed on its card after it parked on this decision. */
const dismissed = { ...parked, dismissedAt: iso(NOW - 60), dismissedBy: { kind: "operator", surface: "desktop" } } as Pipeline;
const elsewhere = { ...pipeline("p-atlas", "needs_review", NOW - 1_800), project: "harbor" } as Pipeline;

test("a lane parked on a decision is on the list with no conversation waiting, and counts 1", () => {
  const entries = buildNeedsYouQueue([], [parked, pipeline("p-run", "running", NOW - 60)], NOW, []);
  expect(entries.map((entry) => `${entry.kind}:${entry.id}`)).toEqual(["pipeline:p-decide"]);
});

test("a lane dismissed for the decision it waits on, or closing, is off the list", () => {
  expect(buildNeedsYouQueue([], [dismissed], NOW, [])).toEqual([]);
  expect(buildNeedsYouQueue([], [parked], NOW, ["p-decide"])).toEqual([]);
  /* A dismissal made before the lane last moved covers an older decision. */
  const stale = { ...parked, dismissedAt: iso(NOW - 7_000) } as Pipeline;
  expect(buildNeedsYouQueue([], [stale], NOW, []).map((entry) => entry.id)).toEqual(["p-decide"]);
});

test("the list spans every project, conversations first; a project's slice is exactly what the phone badge counts there", () => {
  const files = [waiting("/p/new.jsonl", NOW - 100), waiting("/p/old.jsonl", NOW - 900)];
  const entries = buildNeedsYouQueue(files, [parked, elsewhere], NOW, []);
  expect(entries.map((entry) => `${attentionEntryProject(entry)}:${entry.id.startsWith("p-") ? entry.id : entry.kind}`)).toEqual([
    `${PROJECT}:conversation`,
    `${PROJECT}:conversation`,
    `${PROJECT}:p-decide`,
    "harbor:p-atlas",
  ]);
  const slice = entries.filter((entry) => attentionEntryProject(entry) === PROJECT);
  expect(slice).toEqual(buildMobileAttentionQueue(buildAttentionQueue(files, NOW, PROJECT), needsDecisionPipelineRows([parked, elsewhere], PROJECT, NOW)));
});

test("the N key walks conversations and lanes on one pointer, and reaches the lane", () => {
  const entries = buildNeedsYouQueue([waiting("/p/old.jsonl", NOW - 900)], [parked], NOW, []);
  const pointer = { current: null as string | null };
  expect(advanceAttentionCycle(pointer, entries, 1)?.kind).toBe("conversation");
  const lane = advanceAttentionCycle(pointer, entries, 1);
  expect(lane?.kind === "pipeline" ? lane.row.pipeline.id : null).toBe("p-decide");
  expect(pointer.current).toBe("p-decide");
  expect(advanceAttentionCycle(pointer, entries, 1)?.kind).toBe("conversation");
});

test("a lane is focused by the key its card answers to", () => {
  expect(laneFocusPath("p-decide")).toBe("group::pipeline::p-decide");
  expect(laneFocusId(laneFocusPath("p-decide"))).toBe("p-decide");
  expect(laneFocusId("/p/old.jsonl")).toBeNull();
  expect(laneFocusId("group::pipeline::")).toBeNull();
});
