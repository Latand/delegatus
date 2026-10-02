import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { memo, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { BoardTask, TaskStatus } from "@/lib/tasks/types";

import type { KanbanBoardProps } from "./KanbanBoard";
import type { TaskMutationPorts } from "./useTaskMutations";

/* How many cards render when the catalog answers (#2218). Every runtime event
   that touches the catalog ends in one answer, and each answer used to render
   every card on the board; this pins what it renders now. No route, no store,
   no state directory is touched. */

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const dom = new Window({ url: "http://localhost/", width: 1440, height: 900 });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  PointerEvent: dom.PointerEvent ?? dom.MouseEvent,
  CustomEvent: dom.CustomEvent,
  IntersectionObserver: undefined,
  ResizeObserver: TestResizeObserver,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(dom.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });

/* The board's card, counted: the wrapper compares props exactly as the real
   card's own memo does, so it runs once for each render the real card would. */
const actualCards = await import("./KanbanCard");
/* `mock.module` rewrites the module's live bindings, so the real card is held here before it does. */
const RealCard = actualCards.KanbanCard;
const rendered: string[] = [];
const CountedCard = memo(function CountedCard(props: ComponentProps<typeof actualCards.KanbanCard>) {
  rendered.push(props.card.id);
  return <RealCard {...props} />;
});
mock.module("./KanbanCard", () => ({ ...actualCards, KanbanCard: CountedCard }));
afterAll(() => mock.module("./KanbanCard", () => actualCards));

const { KanbanBoard } = await import("./KanbanBoard");

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();
  rendered.length = 0;
});

const NO_PORTS: TaskMutationPorts = { patch: async () => ({ ok: false, status: 500, error: "unused" }), read: async () => null, changed: () => {} };
const STATUSES: TaskStatus[] = ["inbox", "assigned", "assigned", "blocked", "done"];

function task(index: number, extra: Partial<BoardTask> = {}): BoardTask {
  return {
    id: `t${index}`,
    project: "fixture",
    text: `Task ${index}\nWhat ${index} is about`,
    status: STATUSES[index % STATUSES.length]!,
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-09-14T10:00:00.000Z",
    updatedAt: "2026-09-14T10:00:00.000Z",
    revision: `task-v1:00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    ...(STATUSES[index % STATUSES.length] === "done" ? { doneAt: "2026-09-14T10:00:00.000Z" } : {}),
    ...extra,
  } as BoardTask;
}

/** What the catalog's next answer is: a new array of new rows, equal content. */
const answer = (tasks: readonly BoardTask[]): BoardTask[] => tasks.map((row) => ({ ...row, assignments: [...row.assignments] }));

function mount(tasks: BoardTask[]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const render = (next: BoardTask[], extra: Partial<KanbanBoardProps> = {}) => flushSync(() => root.render(
    <KanbanBoard
      project="fixture"
      groups={[]}
      manual={[]}
      files={[]}
      flows={[]}
      pipelines={[]}
      tasks={[]}
      allTasks={next}
      drafts={[]}
      now={1_800_000_000}
      loaded
      catalogFailures={0}
      selection={new Set()}
      onOpenConversations={() => {}}
      seatRefs={null}
      mutationPorts={NO_PORTS}
      {...extra}
    />,
  ));
  render(tasks);
  return { host, render };
}

test("a catalog answer with nothing new renders no card, however many the board holds", () => {
  const tasks = Array.from({ length: 40 }, (_, index) => task(index));
  const { host, render } = mount(tasks);
  /* The eight finished tasks are old enough to sit behind the Done column's own fold. */
  const shown = host.querySelectorAll(".card[data-id]").length;
  expect(shown).toBe(32);
  expect(new Set(rendered).size).toBe(shown);
  rendered.length = 0;
  /* Five answers in a row, each one new rows, new arrays, a fresh handler from the page above. */
  for (let answers = 0; answers < 5; answers += 1) render(answer(tasks), { onOpenConversations: () => {}, files: [], pipelines: [] });
  expect(rendered).toEqual([]);
});

test("a catalog answer that changes one task renders that card and no other", () => {
  const tasks = Array.from({ length: 40 }, (_, index) => task(index));
  const { host, render } = mount(tasks);
  rendered.length = 0;
  const next = answer(tasks);
  next[12] = { ...next[12]!, text: "Task 12, rewritten\nWhat 12 is about now", updatedAt: "2026-09-14T11:00:00.000Z" };
  render(next);
  expect(rendered).toEqual(["task:t12"]);
  expect(host.querySelector('.card[data-id="task:t12"]')?.textContent).toContain("Task 12, rewritten");
});

test("a task that moves to another column renders as the one card that changed", () => {
  const tasks = Array.from({ length: 40 }, (_, index) => task(index));
  const { host, render } = mount(tasks);
  rendered.length = 0;
  const next = answer(tasks);
  next[1] = { ...next[1]!, status: "blocked", updatedAt: "2026-09-14T11:00:00.000Z" };
  render(next);
  expect(rendered).toEqual(["task:t1"]);
  expect(host.querySelector('.card[data-id="task:t1"]')?.closest<HTMLElement>(".column")?.dataset.status).toBe("blocked");
});

/* The cards' boxes, counted. The board used to read every card's rectangle after
   every render to learn which cards had changed column, a forced layout of the
   whole board for each catalog answer. */
function countCardMeasures() {
  const proto = dom.HTMLElement.prototype as unknown as { getBoundingClientRect(): unknown };
  const original = proto.getBoundingClientRect;
  const measured: string[] = [];
  proto.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList?.contains("card")) measured.push(this.dataset.id ?? "");
    return { x: 0, y: 0, left: 10, top: 10, right: 110, bottom: 60, width: 100, height: 50, toJSON: () => ({}) };
  };
  return { measured, restore: () => { proto.getBoundingClientRect = original; } };
}

test("a catalog answer that moves no card measures no card", () => {
  const tasks = Array.from({ length: 40 }, (_, index) => task(index));
  const { render } = mount(tasks);
  const spy = countCardMeasures();
  try {
    render(answer(tasks));
    const next = answer(tasks);
    next[12] = { ...next[12]!, text: "Task 12, rewritten\nWhat 12 is about now", updatedAt: "2026-09-14T11:00:00.000Z" };
    render(next);
    expect(spy.measured).toEqual([]);
  } finally {
    spy.restore();
  }
});

test("a task that moves to another column still flies there, and only that card is measured", () => {
  const tasks = Array.from({ length: 40 }, (_, index) => task(index));
  const { host, render } = mount(tasks);
  const spy = countCardMeasures();
  try {
    const next = answer(tasks);
    next[1] = { ...next[1]!, status: "blocked", updatedAt: "2026-09-14T11:00:00.000Z" };
    render(next);
    expect(new Set(spy.measured)).toEqual(new Set(["task:t1"]));
    expect(host.querySelector('.card[data-id="task:t1"]')?.classList.contains("landing")).toBe(true);
    expect(host.querySelectorAll(".card.flying")).toHaveLength(1);
    expect(host.querySelectorAll(".card.landing")).toHaveLength(1);
  } finally {
    spy.restore();
  }
});
