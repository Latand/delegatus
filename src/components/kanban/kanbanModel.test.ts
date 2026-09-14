import { expect, test } from "bun:test";

import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import type { SchemeLayout } from "@/components/scheme/layout";
import { buildTaskBands } from "@/components/scheme/taskBands";
import { projectTaskWorkflows } from "@/components/tasks/taskWorkflowModel";

import { buildKanbanModel, KANBAN_STATUSES, summarizePipeline } from "./kanbanModel";

/* Pure projection tests: invented tasks, transcripts and pipelines, a layout
   built the way the scheme builds it, and the real band projection on top. */

const NOW = 1_800_000_000;

function file(index: number, extra: Partial<FileEntry> = {}): FileEntry {
  return {
    path: `/fixture/conversation-${index}.jsonl`,
    conversationId: `conversation_fixture_${index}`,
    title: `Conversation ${index}`,
    project: "fixture",
    root: "claude-projects",
    kind: "session",
    fmt: "claude",
    engine: "claude",
    mtime: NOW - 600,
    size: 100,
    activity: "idle",
    proc: null,
    pid: null,
    parent: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    name: `conversation-${index}`,
    ...extra,
  } as FileEntry;
}

function task(id: string, status: TaskStatus, paths: readonly string[] = [], extra: Partial<BoardTask> = {}): BoardTask {
  return {
    id,
    project: "fixture",
    text: `Task ${id}\nWhat ${id} is about`,
    status,
    placement: "unplaced",
    assignments: paths.map((path, index) => ({ path, conversationId: path.startsWith("/fixture/conversation-") ? `conversation_fixture_${path.match(/(\d+)/)![1]}` : `conversation_elided_${id}_${index}`, panePid: null, state: "delivered", error: null, at: "2026-09-14T10:00:00.000Z" })),
    createdAt: `2026-09-14T10:${String(Number(id.replace(/\D/g, "")) % 60).padStart(2, "0")}:00.000Z`,
    updatedAt: "2026-09-14T10:00:00.000Z",
    ...extra,
  } as BoardTask;
}

function layout(files: readonly FileEntry[]): SchemeLayout {
  const nodes = files.map((entry, index) => ({ file: entry, x: index * 648, y: 100, w: 600, h: 680, isRoot: true, tasks: [], under: [], lineageOrderKey: String(index).padStart(5, "0") }));
  return {
    nodes,
    groups: [],
    stacks: [],
    decks: [],
    drafts: [],
    slots: [],
    regionTasks: [],
    edges: [],
    links: [],
    loops: [],
    byPath: new Map(nodes.map((node) => [node.file.path, node])),
    width: files.length * 648,
    height: 880,
  } as unknown as SchemeLayout;
}

function model(tasks: readonly BoardTask[], files: readonly FileEntry[], options: { pipelines?: Pipeline[]; query?: string; overrides?: Map<string, TaskStatus> } = {}) {
  const pipelines = options.pipelines ?? [];
  const projection = projectTaskWorkflows([...tasks], pipelines, [], [...files]);
  const bands = buildTaskBands(layout(files), { tasks, projection, untitled: "Untitled task" });
  return buildKanbanModel({ bands, tasks, pipelines, projection, query: options.query, statusOverrides: options.overrides, now: NOW });
}

test("every stored task is a card in exactly one column or counted off the board, at a thousand tasks", () => {
  const files: FileEntry[] = [];
  const tasks: BoardTask[] = [];
  let conversation = 0;
  const statuses: Array<[TaskStatus, number]> = [["done", 420], ["assigned", 300], ["inbox", 180], ["blocked", 100]];
  let n = 0;
  for (const [status, count] of statuses) {
    for (let i = 0; i < count; i += 1) {
      n += 1;
      if (status === "assigned") {
        const member = file(conversation++);
        files.push(member);
        /* Every fifth assigned task also names a conversation the scheme window elided. */
        const paths = i % 5 === 0 ? [member.path, `/elided/conversation-${n}.jsonl`] : [member.path];
        tasks.push(task(`t${n}`, status, paths));
      } else if (status === "done" && i < 25) {
        tasks.push(task(`t${n}`, status, [], { board: "hidden" }));
      } else {
        tasks.push(task(`t${n}`, status));
      }
    }
  }
  /* Twelve conversations belong to two tasks; forty run with no task at all. */
  for (let i = 0; i < 12; i += 1) {
    tasks.push(task(`shared${i}`, "blocked", [files[i]!.path]));
  }
  for (let i = 0; i < 40; i += 1) files.push(file(conversation++));

  const started = performance.now();
  const result = model(tasks, files);
  const elapsed = performance.now() - started;

  const placed = new Map<string, TaskStatus>();
  for (const status of KANBAN_STATUSES) {
    for (const card of result.columns[status].cards) {
      expect(card.task).not.toBeNull();
      expect(placed.has(card.task!.id)).toBe(false);
      placed.set(card.task!.id, status);
    }
  }
  const offBoard = new Set(result.offBoard.map((entry) => entry.id));
  for (const entry of tasks) expect(placed.has(entry.id) !== offBoard.has(entry.id)).toBe(true);
  expect(placed.size + offBoard.size).toBe(1012);
  expect(offBoard.size).toBe(25);
  expect(result.columns.done.cards).toHaveLength(395);
  expect(result.columns.assigned.cards).toHaveLength(300);
  expect(result.columns.inbox.cards).toHaveLength(180);
  expect(result.columns.blocked.cards).toHaveLength(112);
  expect(result.totals).toMatchObject({ tasks: 1012, onBoard: 987 });

  /* Each conversation is one member somewhere, plus a mirror where it is shared. */
  const members = new Map<string, number>();
  for (const status of KANBAN_STATUSES) for (const card of result.columns[status].cards) for (const member of card.members) members.set(member.file.path, (members.get(member.file.path) ?? 0) + 1);
  for (const card of result.unlinked) for (const member of card.members) members.set(member.file.path, (members.get(member.file.path) ?? 0) + 1);
  expect(members.size).toBe(340);
  expect([...members.values()].every((count) => count === 1)).toBe(true);
  const mirrors = KANBAN_STATUSES.flatMap((status) => result.columns[status].cards.flatMap((card) => card.mirrors));
  expect(mirrors).toHaveLength(12);
  expect(result.unlinked).toHaveLength(40);

  /* An elided conversation still counts on its card. */
  const withElided = result.columns.assigned.cards.find((card) => card.task!.id === "t421")!;
  expect(withElided.conversations).toBe(2);
  expect(withElided.notLoaded).toBe(1);

  /* Bands plus projection for the whole corpus; the projection alone has its own budget below. */
  expect(elapsed).toBeLessThan(2_000);
});

test("the projection alone stays inside its budget at a thousand tasks", () => {
  const files = Array.from({ length: 300 }, (_, index) => file(index));
  const tasks = Array.from({ length: 1000 }, (_, index) => task(`t${index}`, KANBAN_STATUSES[index % 4]!, index < 300 ? [files[index]!.path] : []));
  const projection = projectTaskWorkflows(tasks, [], [], files);
  const bands = buildTaskBands(layout(files), { tasks, projection, untitled: "Untitled task" });
  buildKanbanModel({ bands, tasks, pipelines: [], projection, now: NOW });
  const started = performance.now();
  buildKanbanModel({ bands, tasks, pipelines: [], projection, now: NOW, query: "task" });
  expect(performance.now() - started).toBeLessThan(160);
});

test("cards order by needs-you, then activity, then the most recent update", () => {
  const working = file(1, { authoritativeTurn: { state: "busy", source: "lifecycle", terminalAt: null }, activity: "live" } as Partial<FileEntry>);
  const waiting = file(2, { waitingInput: { since: NOW - 60 } } as Partial<FileEntry>);
  const quiet = file(3);
  const tasks = [
    task("old", "assigned", [], { updatedAt: "2026-09-14T09:00:00.000Z" }),
    task("recent", "assigned", [], { updatedAt: "2026-09-14T11:00:00.000Z" }),
    task("busy", "assigned", [working.path]),
    task("owed", "assigned", [waiting.path]),
    task("still", "assigned", [quiet.path]),
  ];
  const result = model(tasks, [working, waiting, quiet]);
  const order = result.columns.assigned.cards.map((card) => card.task!.id);
  expect(order[0]).toBe("owed");
  expect(order[1]).toBe("busy");
  expect(order.indexOf("recent")).toBeLessThan(order.indexOf("old"));
  const busy = result.columns.assigned.cards.find((card) => card.task!.id === "busy")!;
  expect(busy.working).toBe(1);
  const idle = result.columns.assigned.cards.filter((card) => card.idle).map((card) => card.task!.id);
  expect(idle.sort()).toEqual(["old", "recent"]);
});

test("search narrows what is shown and never what is counted", () => {
  const tasks = [task("alpha", "inbox"), task("beta", "inbox"), task("gamma", "done")];
  const result = model(tasks, [], { query: "BETA" });
  expect(result.columns.inbox.cards).toHaveLength(2);
  expect(result.columns.inbox.shown.map((card) => card.task!.id)).toEqual(["beta"]);
  expect(result.columns.done.shown).toHaveLength(0);
  expect(result.totals.onBoard).toBe(3);
});

test("an optimistic status puts the card in its new column before the server answers", () => {
  const tasks = [task("a", "inbox"), task("b", "inbox")];
  const result = model(tasks, [], { overrides: new Map([["a", "done"]]) });
  expect(result.columns.inbox.cards.map((card) => card.task!.id)).toEqual(["b"]);
  expect(result.columns.done.cards.map((card) => card.task!.id)).toEqual(["a"]);
  expect(result.columns.done.cards[0]!.status).toBe("done");
});

test("the title is the first line of the text and the description the rest", () => {
  const result = model([task("a", "inbox", [], { text: "Restore search results\nAfter the index rebuild the results page is empty.\nSecond line." })], []);
  const card = result.columns.inbox.cards[0]!;
  expect(card.title).toBe("Restore search results");
  expect(card.description).toBe("After the index rebuild the results page is empty.\nSecond line.");
});

function pipeline(): Pipeline {
  const attempt = (n: number, state: string, activatedBy: unknown = null) => ({ n, state, activatedBy, agentPath: null, conversationId: null, launchId: null, sessionId: null, paneId: null, flowId: null, effectiveRole: {}, output: null, verdict: null, error: null });
  return {
    id: "pipeline-fixture",
    task: "Restore search results",
    project: "fixture",
    state: "running",
    cursor: { stageId: "verify", state: "running", input: null, activatedBy: null },
    stages: [
      { id: "plan", kind: "run", prompt: "", next: "build", effectiveRole: {} },
      { id: "build", kind: "run", prompt: "", next: "review", onFail: null, effectiveRole: {} },
      { id: "review", kind: "review-loop", prompt: "", next: "verify", effectiveRole: {} },
      { id: "verify", kind: "run", prompt: "", next: null, onFail: { to: "build", maxRounds: 2 }, effectiveRole: {} },
      { id: "diagnose", kind: "run", prompt: "", next: null, effectiveRole: {} },
      { id: "merge", kind: "run", prompt: "", next: null, effectiveRole: {} },
    ],
    runs: [
      { stageId: "plan", attempts: [attempt(1, "passed")] },
      { stageId: "build", attempts: [attempt(1, "passed"), attempt(2, "passed", { stageId: "verify", attempt: 1, edge: "fail" })] },
      { stageId: "review", attempts: [{ ...attempt(1, "passed"), reviewFlowSync: { roundCount: 2 } }] },
      { stageId: "verify", attempts: [attempt(1, "failed"), attempt(2, "running")] },
    ],
    taskIds: [],
    createdAt: "2026-09-14T10:00:00.000Z",
  } as unknown as Pipeline;
}

test("a pipeline summary follows the pass path, counts fail-edge rounds from provenance, and names waiting stages", () => {
  const withBranch = pipeline();
  withBranch.stages.find((stage) => stage.id === "build")!.onFail = { to: "diagnose", maxRounds: 1 };
  const summary = summarizePipeline(withBranch);
  expect(summary.chips.map((chip) => chip.stage.id)).toEqual(["plan", "build", "review", "verify", "merge", "diagnose"]);
  expect(summary.chips.find((chip) => chip.stage.id === "diagnose")!.branch).toBe(true);
  expect(summary.chips.find((chip) => chip.stage.id === "review")!.rounds).toBe(2);
  expect(summary.chips.find((chip) => chip.stage.id === "verify")!.state).toBe("running");
  /* Every fail edge is named, the retry loop and the forward branch alike, each
     with the rounds its attempts' provenance records. */
  expect(summary.loops.map((loop) => [loop.from.id, loop.to.id, loop.fired, loop.max])).toEqual([["build", "diagnose", 0, 1], ["verify", "build", 1, 2]]);
  expect(summary.waiting).toBe(2);
});

test("a conversation with no recorded task is a card of its own under Not on a task", () => {
  const loose = file(7);
  const result = model([task("a", "inbox")], [loose]);
  expect(result.unlinked).toHaveLength(1);
  expect(result.unlinked[0]!.task).toBeNull();
  expect(result.unlinked[0]!.origin).toBe("conversation");
  expect(result.unlinked[0]!.members.map((member) => member.file.path)).toEqual([loose.path]);
  expect(KANBAN_STATUSES.flatMap((status) => result.columns[status].cards)).toHaveLength(1);
});
