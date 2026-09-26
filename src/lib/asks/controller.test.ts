import { expect, test } from "bun:test";

import type { RegistryFile } from "@/lib/agent/registry";
import type { FileEntry } from "@/lib/types";

import { askCandidates } from "./controller";

/* Which conversations the "Asks you" sweep looks at (docs/research/attention-classifier.md
   §7): the ones Delegatus knows, at their current generation, and not the
   engine's own subagents, pipeline stages or review flows, whose turn ends in
   a verdict their lane or flow already surfaces. */

function file(path: string, over: Partial<FileEntry> = {}): FileEntry {
  return {
    path, root: "claude-projects", name: path, project: "repo-widgets", title: "An agent", engine: "claude", kind: "session", fmt: "claude",
    parent: null, mtime: 0, size: 1, activity: "recent", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null,
    lastTurn: { startedAt: 1_000, endedAt: 2_000 },
    ...over,
  } as FileEntry;
}

function conversation(id: string, paths: string[], over: Record<string, unknown> = {}) {
  return { id, engine: "claude", generations: paths.map((path, index) => ({ id: `${id}-g${index}`, path })), continuityPaths: [], supersededBy: null, agentRole: null, projectOwnership: null, ...over };
}

test("keeps the conversations Delegatus knows and leaves out subagents, stages, flows, old generations and strangers", () => {
  const snapshot = {
    conversations: {
      seat: conversation("seat", ["/t/seat.jsonl"], { agentRole: "orchestrator" }),
      builder: conversation("builder", ["/t/builder-old.jsonl", "/t/builder.jsonl"], { projectOwnership: { project: "repo-moved" } }),
      stage: conversation("stage", ["/t/stage.jsonl"]),
      reviewer: conversation("reviewer", ["/t/reviewer.jsonl"]),
      child: conversation("child", ["/t/child.jsonl"]),
      retired: conversation("retired", ["/t/retired.jsonl"], { supersededBy: { conversationId: "seat" } }),
    },
    lineageEdges: { child: { source: "engine-native", role: null }, builder: { source: "viewer-spawn", role: "builder" } },
    memberships: {
      stage: [{ kind: "pipeline", containerId: "p1", role: "builder" }],
      reviewer: [{ kind: "flow", containerId: "f1", role: "reviewer" }],
    },
  } as unknown as RegistryFile;
  const files = [
    "/t/seat.jsonl", "/t/builder.jsonl", "/t/builder-old.jsonl", "/t/stage.jsonl", "/t/reviewer.jsonl", "/t/child.jsonl", "/t/retired.jsonl", "/t/stranger.jsonl",
  ].map((path) => file(path));
  files.push(file("/t/working.jsonl", { activity: "live" }));
  snapshot.conversations.working = conversation("working", ["/t/working.jsonl"]) as never;

  const candidates = askCandidates(files, snapshot);
  expect(candidates.map((candidate) => candidate.subject)).toEqual(["seat", "builder", "working"]);
  expect(candidates[0]).toMatchObject({ role: "orchestrator", project: "repo-widgets", working: false, lastTurnStartedAt: 1_000 });
  expect(candidates[1]).toMatchObject({ role: "builder", project: "repo-moved" });
  expect(candidates[2]!.working).toBe(true);
});
