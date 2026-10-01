import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { isCardHandle } from "./cardDrag";
import { KanbanBoard } from "./KanbanBoard";
import type { TaskMutationPorts } from "./useTaskMutations";

/* The whole card is the drag handle (operator, 2026-10-02). Mounted over the
   real board, driven with pointer events. happy-dom lays nothing out and has no
   frame clock, so the columns are given rectangles and `requestAnimationFrame`
   is a queue the test runs by hand: what a browser makes of the movement
   (frame times, layouts) is `kanbanBoard.browser.test.tsx`'s whole-card-drag
   case; this suite holds the contract of the gesture. */

const dom = new Window({ url: "http://localhost/" });
const frames: FrameRequestCallback[] = [];
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  localStorage: dom.localStorage,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  PointerEvent: dom.PointerEvent ?? dom.MouseEvent,
  requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback),
  cancelAnimationFrame: () => {},
});
const runFrames = () => { for (const callback of frames.splice(0)) callback(0); };

const COLUMN_X: Record<TaskStatus, number> = { inbox: 0, assigned: 300, blocked: 600, done: 900 };
const prototype = dom.HTMLElement.prototype as unknown as { getBoundingClientRect: () => DOMRect };
const originalRect = prototype.getBoundingClientRect;
let rectReads = 0;
beforeEach(() => {
  rectReads = 0;
  prototype.getBoundingClientRect = function (this: HTMLElement) {
    rectReads += 1;
    const status = this.classList?.contains("column") ? (this.dataset.status as TaskStatus) : null;
    const board = this.classList?.contains("kb");
    const x = status ? COLUMN_X[status] : 0;
    const width = board ? 1440 : status ? 290 : 100;
    return { x, y: 0, top: 0, left: x, bottom: 900, right: x + width, width, height: board || status ? 900 : 120, toJSON() {} } as DOMRect;
  };
});

const roots: Root[] = [];
afterEach(() => {
  /* A test that stops mid-gesture must not leave its listeners on the document for the next. */
  document.dispatchEvent(new dom.PointerEvent("pointercancel", { pointerId: 1, bubbles: true }) as unknown as Event);
  prototype.getBoundingClientRect = originalRect;
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();
  frames.length = 0;
});

const REV = (n: number) => `task-v1:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const worker = {
  path: "/fixture/worker.jsonl", conversationId: "conversation_worker", title: "Worker", project: "fixture", root: "claude-projects", kind: "session", fmt: "claude",
  engine: "claude", mtime: 1_799_999_000, size: 10, activity: "idle", proc: null, pid: null, parent: null, model: "opus", pendingQuestion: null, waitingInput: null, name: "worker.jsonl",
} as unknown as FileEntry;

function task(id: string, status: TaskStatus, text: string, extra: Partial<BoardTask> = {}): BoardTask {
  return {
    id, project: "fixture", text, status, placement: "unplaced", assignments: [], createdAt: "2026-09-14T10:00:00.000Z", updatedAt: "2026-09-14T10:00:00.000Z", revision: REV(1), ...extra,
  } as BoardTask;
}

const patches: Array<{ id: string; status: TaskStatus }> = [];
const ports: TaskMutationPorts = {
  patch: async (id, body) => {
    patches.push({ id, status: (body as { status: TaskStatus }).status });
    return { ok: true, task: { ...task(id, (body as { status: TaskStatus }).status, "Repair old links"), revision: REV(2) } };
  },
  read: async () => null,
  changed: () => {},
};

function mount() {
  patches.length = 0;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const allTasks = [
    task("a", "assigned", "Repair old links in the release notes\nTwo anchors point at pages that moved.", {
      assignments: [{ path: worker.path, conversationId: worker.conversationId, panePid: null, state: "delivered", error: null, at: "2026-09-14T10:00:00.000Z" }],
    } as Partial<BoardTask>),
    task("b", "blocked", "Waiting on a review"),
  ];
  flushSync(() => root.render(
    <KanbanBoard project="fixture" groups={[]} manual={[worker]} files={[worker]} flows={[]} pipelines={[]} tasks={[]} allTasks={allTasks} drafts={[]}
      now={1_800_000_000} loaded catalogFailures={0} selection={new Set()} onOpenConversations={() => {}} seatRefs={null} mutationPorts={ports} />,
  ));
  return host;
}

const point = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
  new dom.PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, ...extra }) as unknown as Event;
const fire = (target: Element, event: Event) => flushSync(() => { target.dispatchEvent(event); });
const cardOf = (host: HTMLElement) => host.querySelector<HTMLElement>('.card[data-id="task:a"]')!;
const ghost = (host: HTMLElement) => host.querySelector<HTMLElement>(".card.ghost");
const nudge = (target: Element, from: [number, number], to: [number, number]) => {
  fire(target, point("pointerdown", ...from));
  fire(target, point("pointermove", ...to));
  runFrames();
};

/** The handles a hand lands on, none of which is the card's padding. */
const handles = (card: HTMLElement) => ({
  "title button": card.querySelector<HTMLElement>("[data-rename]")!,
  "description button": card.querySelector<HTMLElement>("[data-describe]")!,
  "conversation tile": card.querySelector<HTMLElement>(".tile")!,
  "card itself": card,
});

test("a click without movement renames the task, and so does one that moves less than 8 px", () => {
  const host = mount();
  const title = cardOf(host).querySelector<HTMLElement>("[data-rename]")!;
  fire(title, point("pointerdown", 100, 40));
  fire(title, point("pointerup", 100, 40));
  fire(title, new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event);
  expect(host.querySelector('[data-kanban-board] textarea, [data-kanban-board] input[type="text"]')).not.toBeNull();
  expect(ghost(host)).toBeNull();

  const second = mount();
  const again = cardOf(second).querySelector<HTMLElement>("[data-rename]")!;
  fire(again, point("pointerdown", 100, 40));
  fire(again, point("pointermove", 105, 44));
  runFrames();
  expect(ghost(second)).toBeNull();
  fire(again, point("pointerup", 105, 44));
  fire(again, new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event);
  expect(second.querySelector('[data-kanban-board] textarea, [data-kanban-board] input[type="text"]')).not.toBeNull();
});

test("8 px of movement starts the drag from the title, the description, a conversation tile or the card itself", () => {
  for (const [name] of Object.entries(handles(cardOf(mount())))) {
    const host = mount();
    const target = handles(cardOf(host))[name as keyof ReturnType<typeof handles>];
    expect(target, `${name} exists`).toBeTruthy();
    fire(target, point("pointerdown", 100, 40));
    fire(target, point("pointermove", 106, 40));
    runFrames();
    expect(ghost(host), `${name}: 6 px is not a drag`).toBeNull();
    fire(target, point("pointermove", 108, 40));
    runFrames();
    expect(ghost(host), `${name}: 8 px is`).not.toBeNull();
    expect(cardOf(host).classList.contains("dragging")).toBe(true);
    fire(target, point("pointerup", 108, 40));
    expect(ghost(host)).toBeNull();
    expect(cardOf(host).classList.contains("dragging")).toBe(false);
  }
});

test("the click that ends a drag is swallowed, and the next one is not", async () => {
  const host = mount();
  const title = cardOf(host).querySelector<HTMLElement>("[data-rename]")!;
  /* Released over no column, so the card stays where it is. */
  nudge(title, [400, 40], [1300, 90]);
  fire(title, point("pointerup", 1300, 90));
  fire(title, new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event);
  expect(host.querySelector('[data-kanban-board] textarea, [data-kanban-board] input[type="text"]')).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 5));
  fire(title, point("pointerdown", 100, 40));
  fire(title, point("pointerup", 100, 40));
  fire(title, new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event);
  expect(host.querySelector('[data-kanban-board] textarea, [data-kanban-board] input[type="text"]')).not.toBeNull();
});

test("nothing is selected while a card is dragged, and selecting works again afterwards", () => {
  const host = mount();
  const card = cardOf(host);
  const title = card.querySelector<HTMLElement>("[data-rename]")!;
  const selectstart = () => { const event = new dom.Event("selectstart", { bubbles: true, cancelable: true }) as unknown as Event; title.dispatchEvent(event); return event.defaultPrevented; };
  expect(selectstart()).toBe(false);
  nudge(title, [100, 40], [160, 90]);
  expect(selectstart()).toBe(true);
  expect(host.querySelector(".kb")!.hasAttribute("data-card-drag")).toBe(true);
  expect(dom.getSelection()?.toString() ?? "").toBe("");
  fire(title, point("pointerup", 160, 90));
  expect(selectstart()).toBe(false);
  expect(host.querySelector(".kb")!.hasAttribute("data-card-drag")).toBe(false);
});

test("the move path writes one transform per frame: no layout read, no left/top, no hit test", () => {
  const host = mount();
  const title = cardOf(host).querySelector<HTMLElement>("[data-rename]")!;
  nudge(title, [100, 40], [130, 40]);
  const moving = ghost(host)!;
  const left = moving.style.left;
  const top = moving.style.top;
  let hitTests = 0;
  const hit = dom.document.elementFromPoint.bind(dom.document);
  (dom.document as unknown as { elementFromPoint: unknown }).elementFromPoint = (x: number, y: number) => { hitTests += 1; return hit(x, y); };
  const reads = rectReads;
  const queued = frames.length;
  for (let step = 1; step <= 20; step += 1) fire(title, point("pointermove", 130 + step * 10, 40 + step * 2));
  expect(frames.length - queued, "twenty moves in one frame ask for one frame").toBeLessThanOrEqual(1);
  runFrames();
  expect(moving.style.transform).toContain("translate3d(");
  expect(moving.style.transform).toContain("translate3d(230px, 40px, 0)");
  expect(moving.style.left).toBe(left);
  expect(moving.style.top).toBe(top);
  expect(rectReads, "no getBoundingClientRect between pointer start and the last frame").toBe(reads);
  expect(hitTests, "no elementFromPoint").toBe(0);
});

test("dropping over another column moves the task; over nothing, or after Escape, moves nothing", async () => {
  const host = mount();
  const title = cardOf(host).querySelector<HTMLElement>("[data-rename]")!;
  nudge(title, [400, 40], [700, 90]);
  expect(host.querySelector('.column[data-status="blocked"]')!.classList.contains("drop")).toBe(true);
  expect(host.querySelector('.column[data-status="assigned"]')!.classList.contains("drop")).toBe(false);
  fire(title, point("pointerup", 700, 90));
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(patches).toEqual([{ id: "a", status: "blocked" }]);
  expect(host.querySelector(".column.drop")).toBeNull();

  const other = mount();
  const handle = cardOf(other).querySelector<HTMLElement>("[data-rename]")!;
  nudge(handle, [400, 40], [700, 90]);
  flushSync(() => { document.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event); });
  fire(handle, point("pointerup", 700, 90));
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(patches).toEqual([]);
  expect(ghost(other)).toBeNull();
});

test("a text field is never a drag handle", () => {
  const host = mount();
  const card = cardOf(host);
  fire(card.querySelector<HTMLElement>("[data-rename]")!, new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event);
  const field = host.querySelector<HTMLElement>('[data-kanban-board] textarea, [data-kanban-board] input[type="text"]')!;
  expect(field).toBeTruthy();
  nudge(field, [100, 40], [200, 90]);
  expect(ghost(host)).toBeNull();
});

test("a press on a scrollbar belongs to the scroller, and a press beside it does not", () => {
  const scroller = document.createElement("button");
  Object.defineProperties(scroller, { scrollHeight: { value: 400 }, clientHeight: { value: 120 }, clientWidth: { value: 90 } });
  expect(isCardHandle({ target: scroller, offsetX: 95 })).toBe(false);
  expect(isCardHandle({ target: scroller, offsetX: 40 })).toBe(true);
  const flat = document.createElement("button");
  Object.defineProperties(flat, { scrollHeight: { value: 120 }, clientHeight: { value: 120 }, clientWidth: { value: 90 } });
  expect(isCardHandle({ target: flat, offsetX: 95 })).toBe(true);
});
