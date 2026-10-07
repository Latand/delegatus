import { expect, test } from "bun:test";

import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import type { Workflow } from "@/lib/workflows/types";
import { buildKanbanModel, KANBAN_STATUSES, type KanbanModel } from "@/components/kanban/kanbanModel";
import { buildPhoneKanban } from "@/components/mobile/phoneKanbanModel";
import type { SchemeLayout } from "@/components/scheme/layout";
import { buildTaskBands } from "@/components/scheme/taskBands";
import { projectTaskWorkflows } from "@/components/tasks/taskWorkflowModel";

import { buildProjectSummaries, projectKey } from "./projectModel";
import { isWorkingAgent, workingAgentCount, workingAgentCounts } from "./workingAgents";

/* The sidebar said 38 while the board said 12 for the same project at the same
   moment (2026-10-07). Both now count agents whose turn is running, with one
   selector; this fleet carries every kind of row that used to split them. */

const NOW = 1_800_000_000;
const REPO = "repo-parent";
const ALIAS = "dir-parent-before-origin";
const OTHER = "repo-other";
const open = { lastTurn: { startedAt: (NOW - 60) * 1000, endedAt: null } };

function file(name: string, extra: Partial<FileEntry> = {}): FileEntry {
  return {
    path: `/fixture/${name}.jsonl`,
    conversationId: `conversation_${name}`,
    title: name,
    project: REPO,
    cwd: "/work/parent",
    root: "claude-projects",
    kind: "session",
    fmt: "claude",
    engine: "claude",
    mtime: NOW - 5,
    size: 100,
    activity: "live",
    proc: "running",
    pid: 1,
    parent: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    name,
    ...extra,
  } as FileEntry;
}

const busy = file("busy", open);
const busyCodex = file("busy-codex", { ...open, root: "codex-sessions", engine: "codex", fmt: "codex" });
/* A Claude worktree checkout groups under its parent repository (AGENTS.md):
   the scanner stamps the parent's key, and the count follows the key. */
const worktree = file("worktree", { ...open, cwd: "/work/parent/.claude/worktrees/lane-a", projectRoot: "/work/parent", worktree: "lane-a" });
/* The same layout after the checkout was deleted still carries the parent key. */
const deletedWorktree = file("deleted-worktree", { ...open, cwd: "/work/parent/worktrees/lane-b", projectRoot: null });
const waiting = file("waiting", { ...open, pendingQuestion: { kind: "question", toolUseId: "ask-1", askedAt: new Date((NOW - 30) * 1000).toISOString() } as FileEntry["pendingQuestion"] });
const idle = file("idle", { activity: "recent", mtime: NOW - 300, lastTurn: { startedAt: (NOW - 900) * 1000, endedAt: (NOW - 300) * 1000 } });
const stalled = file("stalled", { activity: "stalled", mtime: NOW - 400, lastTurn: { startedAt: (NOW - 900) * 1000, endedAt: null } });
const gone = file("gone", { ...open, proc: "killed" });
const limited = file("limited", { ...open, rateLimit: { resetAt: NOW + 600 } as FileEntry["rateLimit"] });
const subagent = file("subagent", { ...open, kind: "subagent", parent: busy.path, spawnOrigin: "engine" });
const shellTask = file("shell-task", { root: "claude-tasks", engine: "shell", kind: "task", fmt: "plain", path: "/fixture/shell-task.output" });
const elsewhere = file("elsewhere", { ...open, project: OTHER, cwd: "/work/other" });

const files = [busy, busyCodex, worktree, deletedWorktree, waiting, idle, stalled, gone, limited, subagent, shellTask, elsewhere];

/* Lanes and workflows stamped with the project's earlier key, and one with the
   current key: none of them is an agent, so none adds to either count. */
const pipelines = [
  { id: "lane-alias", project: ALIAS, state: "running", createdAt: new Date(NOW * 1000).toISOString() },
  { id: "lane-current", project: REPO, state: "provisioning", createdAt: new Date(NOW * 1000).toISOString() },
] as unknown as Pipeline[];
const workflows = [{ id: "wf-alias", project: ALIAS, state: "implementing", createdAt: new Date(NOW * 1000).toISOString() }] as unknown as Workflow[];

function task(id: string, status: TaskStatus, members: readonly FileEntry[]): BoardTask {
  return {
    id,
    project: REPO,
    text: `Task ${id}`,
    status,
    placement: "unplaced",
    assignments: members.map((member) => ({ path: member.path, conversationId: member.conversationId, panePid: null, state: "delivered", error: null, at: "2026-09-14T10:00:00.000Z" })),
    createdAt: "2026-09-14T10:00:00.000Z",
    updatedAt: "2026-09-14T10:00:00.000Z",
  } as BoardTask;
}

function layout(entries: readonly FileEntry[]): SchemeLayout {
  const nodes = entries.map((entry, index) => ({ file: entry, x: index * 648, y: 100, w: 600, h: 680, isRoot: true, tasks: [], under: [], lineageOrderKey: String(index).padStart(5, "0") }));
  return { nodes, groups: [], stacks: [], decks: [], drafts: [], slots: [], regionTasks: [], edges: [], links: [], loops: [], byPath: new Map(nodes.map((node) => [node.file.path, node])), width: entries.length * 648, height: 880 } as unknown as SchemeLayout;
}

/** The board as a project page builds it: the files the sidebar groups under the project. */
function board(entries: readonly FileEntry[], now = NOW): KanbanModel {
  const boardFiles = entries.filter((entry) => entry.engine !== "shell" && entry.kind !== "subagent");
  const tasks = [
    task("two-agents", "assigned", [busy, waiting]),
    task("worktree", "assigned", [worktree, deletedWorktree]),
    task("quiet", "inbox", [idle, stalled]),
    task("held-up", "blocked", [gone, limited]),
  ];
  const projection = projectTaskWorkflows(tasks, [], [], [...boardFiles]);
  const bands = buildTaskBands(layout(boardFiles), { tasks, projection, untitled: "Untitled task", deferDoneVisibility: true });
  return buildKanbanModel({ bands, tasks, pipelines: [], projection, files: entries, now: Math.floor(now / 15) * 15 });
}

test("the rule: only an agent whose turn runs now is working", () => {
  expect(files.filter((entry) => isWorkingAgent(entry, NOW)).map((entry) => entry.name)).toEqual(["busy", "busy-codex", "worktree", "deleted-worktree", "elsewhere"]);
});

test("the sidebar row and the board header of one project read the same number", () => {
  const rows = buildProjectSummaries(files, NOW, workflows, [], pipelines, {}, undefined, workingAgentCounts(files, NOW));
  const row = rows.find((summary) => summary.project === REPO)!;
  const projectFiles = files.filter((entry) => projectKey(entry) === REPO);
  const model = board(projectFiles);

  expect(row.liveCount).toBe(4);
  expect(model.totals.working).toBe(row.liveCount);
  expect(workingAgentCounts(files, NOW).get(REPO)).toBe(row.liveCount);

  /* A lane stamped with an earlier key opens no phantom working row. */
  expect(rows.find((summary) => summary.project === ALIAS)?.liveCount ?? 0).toBe(0);

  /* The columns count the same agents on their own cards: the waiting one,
     the idle, the stalled, the gone and the rate-limited count nowhere. The
     Codex agent is on no task, so its card is Not on a task; with it, the
     cards add up to the header. */
  expect(model.columns.assigned.working).toBe(3);
  expect(model.columns.inbox.working).toBe(0);
  expect(model.columns.blocked.working).toBe(0);
  const unlinked = model.unlinked.reduce((sum, card) => sum + card.working, 0);
  expect(unlinked).toBe(1);
  expect(KANBAN_STATUSES.reduce((sum, status) => sum + model.columns[status].working, 0) + unlinked).toBe(model.totals.working);
  /* The phone counts the Not on a task rows in Inbox, as it draws them there. */
  const phone = buildPhoneKanban({ model, now: NOW });
  expect(phone.columns.assigned.working).toBe(3);
  expect(phone.columns.inbox.working).toBe(1);
});

test("the Overview row is the sum of the rows, and the Overview board header says the same", () => {
  const rows = buildProjectSummaries(files, NOW, workflows, [], pipelines, {}, undefined, workingAgentCounts(files, NOW));
  const sum = rows.reduce((total, summary) => total + summary.liveCount, 0);
  expect(sum).toBe(5);
  expect(sum).toBe(workingAgentCount(files, NOW));
  expect(board(files).totals.working).toBe(sum);
});

test("a per-second clock and the board's 15 s clock agree at every second", () => {
  /* The rail ticks each second and the board model in 15 s steps; a stalled
     transcript that crosses the attention window must not read differently. */
  const crossing = file("crossing", { activity: "stalled", mtime: NOW - 400, lastTurn: { startedAt: (NOW - 900) * 1000, endedAt: null } });
  for (let second = 0; second < 30; second += 1) {
    const now = NOW + second;
    const entries = [...files.filter((entry) => projectKey(entry) === REPO), crossing];
    const row = buildProjectSummaries(entries, now, [], [], [], {}, undefined, workingAgentCounts(entries, now)).find((summary) => summary.project === REPO)!;
    expect(board(entries, now).totals.working).toBe(row.liveCount);
  }
});
