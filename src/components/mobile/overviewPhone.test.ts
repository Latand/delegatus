import { expect, test } from "bun:test";

import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { BOARD } from "./mobileNav";
import { overviewAttention, overviewLiftProject, overviewScreenProject, overviewStackKey, overviewStackScreens } from "./overviewPhone";
import { attentionKey } from "./phoneKanbanModel";

/* #2098: which project a screen over the phone's Overview belongs to, and
   the order the Overview's columns pin what needs the operator. Invented
   projects and records only. */

const NOW = 1_800_000_000;

const file = (path: string, project: string, extra: Partial<FileEntry> = {}): FileEntry => ({
  path, project, root: "claude-projects", name: path, title: path, engine: "claude", kind: "session", fmt: "claude",
  parent: null, mtime: NOW - 60, size: 1, activity: "idle", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null,
  ...extra,
}) as FileEntry;
const asking = (path: string, project: string, askedAgo: number) => file(path, project, {
  pendingQuestion: { kind: "question", toolUseId: `tool-${path}`, transcriptPath: path, pid: 1, paneTarget: null, askedAt: new Date((NOW - askedAgo) * 1000).toISOString(), questions: [{ question: "Which one?", header: "One", multiSelect: false, options: [] }] },
} as Partial<FileEntry>);
const task = (id: string, project: string): BoardTask => ({ id, project, text: id, status: "assigned", placement: "unplaced", assignments: [], createdAt: "2026-09-20T10:00:00.000Z", updatedAt: "2026-09-20T10:00:00.000Z" }) as unknown as BoardTask;
const lane = (id: string, project: string, state: Pipeline["state"]): Pipeline => ({
  id, project, state, task: id, taskIds: [], stages: [{ id: "implement", kind: "run" }], runs: [], cursor: null, createdAt: "2026-09-20T10:00:00.000Z",
}) as unknown as Pipeline;

const LOOKUP = {
  tasks: [task("t-ledger", "ledger"), task("t-atlas", "atlas")],
  pipelines: [lane("p-mesh", "mesh", "running")],
  files: [file("/sessions/mesh.jsonl", "mesh")],
};

test("the top of the stack names the project that draws it; a screen that names none belongs to the one under it", () => {
  expect(overviewStackKey([BOARD])).toBeNull();
  const task = { kind: "task" as const, id: "t-ledger" };
  const lane = { kind: "pipeline" as const, id: "p-mesh" };
  const draft = { kind: "chat" as const, id: "draft::d-1" };
  /* The key a reader subscribes to round-trips, a path with a colon in it included. */
  const stack = [BOARD, task, { kind: "chat" as const, id: "/sessions/a:b.jsonl" }, { kind: "accounts" as const }];
  expect(overviewStackScreens(overviewStackKey(stack))).toEqual(stack.slice(1));

  expect(overviewLiftProject(overviewStackScreens(overviewStackKey([BOARD, task])), LOOKUP)).toBe("ledger");
  /* A lane of another project opened from the ledger task: the lane's own. */
  expect(overviewLiftProject([task, lane], LOOKUP)).toBe("mesh");
  /* An agent draft and the accounts screen name nothing: the task under them does. */
  expect(overviewLiftProject([task, draft, { kind: "accounts" }], LOOKUP)).toBe("ledger");
  expect(overviewLiftProject([{ kind: "chat", id: "/sessions/mesh.jsonl" }], LOOKUP)).toBe("mesh");
  /* What the payload no longer carries names nothing. */
  expect(overviewLiftProject([{ kind: "task", id: "t-gone" }], LOOKUP)).toBeNull();
  expect(overviewLiftProject([], LOOKUP)).toBeNull();
  expect(overviewScreenProject(BOARD, LOOKUP)).toBeNull();
  /* A conversation opened over the Overview before the poll carries its file
     names the project the open recorded. */
  const unscanned = { kind: "chat" as const, id: "/sessions/beyond-the-window.jsonl" };
  expect(overviewLiftProject([unscanned], LOOKUP)).toBeNull();
  expect(overviewLiftProject([unscanned], { ...LOOKUP, conversationProjects: new Map([[unscanned.id, "atlas"]]) })).toBe("atlas");
});

test("the Overview pins in the queue's order over every project: conversations, then lanes parked on the operator", () => {
  const files = [asking("/sessions/late.jsonl", "atlas", 60), asking("/sessions/early.jsonl", "ledger", 900)];
  const pipelines = [lane("p-running", "mesh", "running"), lane("p-decide", "mesh", "needs_decision"), lane("p-closing", "atlas", "needs_decision")];
  expect(overviewAttention(files, pipelines, NOW, ["p-closing"])).toEqual([
    attentionKey.conversation("/sessions/early.jsonl"),
    attentionKey.conversation("/sessions/late.jsonl"),
    attentionKey.pipeline("p-decide"),
  ]);
});
