import { expect, test } from "bun:test";

import { buildSchemeLayout } from "@/components/scheme/layout";
import { buildTaskBands } from "@/components/scheme/taskBands";
import { projectTaskWorkflows } from "@/components/tasks/taskWorkflowModel";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { buildKanbanModel, KANBAN_STATUSES, type KanbanModel } from "./kanbanModel";
import { reuseKanbanModel, structurallyEqual } from "./reuseKanbanModel";

/* A catalog update rebuilds the model; a card whose content did not change must
   stay the object it was, so a memoized card does not render again (#2218). */

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
    assignments: paths.map((path, index) => ({ path, conversationId: `conversation_fixture_${path.match(/(\d+)/)![1]}`, panePid: null, state: "delivered", error: null, at: `2026-09-14T10:0${index}:00.000Z` })),
    createdAt: "2026-09-14T10:00:00.000Z",
    updatedAt: "2026-09-14T10:00:00.000Z",
    ...extra,
  } as BoardTask;
}

function modelOf(tasks: readonly BoardTask[], files: readonly FileEntry[]): KanbanModel {
  const nodes = files.map((entry, index) => ({ file: entry, x: index * 648, y: 100, w: 600, h: 680, isRoot: true, tasks: [], under: [], lineageOrderKey: String(index).padStart(5, "0") }));
  const layout = { nodes, groups: [], stacks: [], decks: [], drafts: [], slots: [], regionTasks: [], edges: [], links: [], loops: [], byPath: new Map(nodes.map((node) => [node.file.path, node])), width: files.length * 648, height: 880 } as unknown as ReturnType<typeof buildSchemeLayout>;
  const projection = projectTaskWorkflows([...tasks], [], [], [...files]);
  const bands = buildTaskBands(layout, { tasks, projection, untitled: "Untitled task", deferDoneVisibility: true });
  return buildKanbanModel({ bands, tasks, pipelines: [], projection, files, now: NOW });
}

/** A board of forty tasks, each in a column, thirty of them holding a conversation. */
function board() {
  const files = Array.from({ length: 30 }, (_, index) => file(index));
  const statuses: TaskStatus[] = ["inbox", "assigned", "assigned", "blocked", "done"];
  const tasks = Array.from({ length: 40 }, (_, index) => task(`t${index}`, statuses[index % statuses.length]!, index < 30 ? [files[index]!.path] : []));
  return { files, tasks };
}

/** What the catalog's next answer is: every row a fresh object, equal content. */
const refetched = <T extends object>(rows: readonly T[]): T[] => rows.map((row) => JSON.parse(JSON.stringify(row)) as T);

function cardsOf(model: KanbanModel) {
  return KANBAN_STATUSES.flatMap((status) => model.columns[status].cards);
}

test("a catalog answer with the same content leaves every card, column and the model as they were", () => {
  const { files, tasks } = board();
  const first = reuseKanbanModel(null, modelOf(tasks, files));
  const second = reuseKanbanModel(first, modelOf(refetched(tasks), refetched(files)));
  expect(cardsOf(first).length).toBeGreaterThanOrEqual(30);
  expect(second).toBe(first);
});

test("one changed row replaces only the card that holds it", () => {
  const { files, tasks } = board();
  const first = reuseKanbanModel(null, modelOf(tasks, files));
  const changed = refetched(files);
  changed[7] = { ...changed[7]!, title: "Conversation 7, renamed" };
  const second = reuseKanbanModel(first, modelOf(refetched(tasks), changed));
  const before = new Map(cardsOf(first).map((card) => [card.id, card]));
  const replaced = cardsOf(second).filter((card) => before.get(card.id) !== card).map((card) => card.id);
  expect(replaced).toEqual(["task:t7"]);
  expect(second).not.toBe(first);
  /* The columns that held no changed card keep their arrays as they were. */
  const untouched = KANBAN_STATUSES.filter((status) => status !== second.columns.assigned.status && !second.columns[status].cards.some((card) => card.id === "task:t7"));
  for (const status of untouched) expect(second.columns[status]).toBe(first.columns[status]);
});

test("a task that moves to another column is a new card there and leaves the rest alone", () => {
  const { files, tasks } = board();
  const first = reuseKanbanModel(null, modelOf(tasks, files));
  const moved = refetched(tasks);
  moved[1] = { ...moved[1]!, status: "done", doneAt: new Date(NOW * 1000).toISOString() } as BoardTask;
  const second = reuseKanbanModel(first, modelOf(moved, refetched(files)));
  const before = new Map(cardsOf(first).map((card) => [card.id, card]));
  const replaced = cardsOf(second).filter((card) => before.get(card.id) !== card).map((card) => card.id);
  expect(replaced).toEqual(["task:t1"]);
  expect(second.columns.done.cards.some((card) => card.id === "task:t1")).toBe(true);
});

test("structural equality compares maps and sets by content and everything else by reference", () => {
  expect(structurallyEqual({ a: [1, { b: new Map([["k", { n: 1 }]]) }] }, { a: [1, { b: new Map([["k", { n: 1 }]]) }] })).toBe(true);
  expect(structurallyEqual({ b: new Map([["k", 1]]) }, { b: new Map([["k", 2]]) })).toBe(false);
  expect(structurallyEqual(new Set(["x"]), new Set(["x"]))).toBe(true);
  expect(structurallyEqual(new Set(["x"]), new Set(["y"]))).toBe(false);
  expect(structurallyEqual([1, 2], [1, 2, 3])).toBe(false);
  expect(structurallyEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  expect(structurallyEqual(new Date(0), new Date(0))).toBe(false);
  const shared = new Date(0);
  expect(structurallyEqual({ at: shared }, { at: shared })).toBe(true);
});
