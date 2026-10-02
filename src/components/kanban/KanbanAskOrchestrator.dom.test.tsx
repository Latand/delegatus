import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

import type { BoardTask, TaskStatus } from "@/lib/tasks/types";

import type { TaskMutationPorts } from "./useTaskMutations";

/* The card's one «Ask the orchestrator» button: it puts a reference to THIS
   task into its project's orchestrator composer as a chip, and changes nothing
   else on the card — no text in any input, no navigation. Rendered by React
   against invented tasks; no route, store or state directory is touched. */

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  localStorage: dom.localStorage,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  FocusEvent: dom.FocusEvent,
  PointerEvent: dom.PointerEvent ?? dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});

const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { KanbanBoard } = await import("./KanbanBoard");
const { addTaskChip, MAX_TASK_CHIPS, readTaskChips, reloadTaskChipsForTests, removeTaskChip, resetTaskChipsForTests, onOrchestratorFocusRequest } = await import("@/components/orchestrator/taskChips");

const roots: Root[] = [];
beforeEach(() => resetTaskChipsForTests());
afterEach(() => {
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();
  resetTaskChipsForTests();
});

const REV = (n: number) => ["task-v1:00000000", "0000", "4000", "8000", String(n).padStart(12, "0")].join("-");
const NOW = 1_800_000_000;

function task(id: string, status: TaskStatus, text: string, extra: Partial<BoardTask> = {}): BoardTask {
  return {
    id,
    project: "fixture",
    text,
    status,
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-09-19T10:00:00.000Z",
    updatedAt: "2026-09-19T10:00:00.000Z",
    revision: REV(1),
    ...extra,
  } as BoardTask;
}

const ports: TaskMutationPorts = {
  patch: async () => ({ ok: false, error: "unused" }) as never,
  read: async () => null,
  changed: () => {},
};

function mount(tasks: BoardTask[]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  flushSync(() => root.render(
    <KanbanBoard
      project="fixture"
      groups={[]}
      manual={[]}
      files={[]}
      flows={[]}
      pipelines={[]}
      tasks={[]}
      allTasks={tasks}
      drafts={[]}
      now={NOW}
      loaded
      catalogFailures={0}
      selection={new Set()}
      onOpenConversations={() => {}}
      seatRefs={null}
      mutationPorts={ports}
    />,
  ));
  return host;
}

const cardEl = (host: HTMLElement, id: string) => [...host.querySelectorAll<HTMLElement>(".card")].find((card) => card.getAttribute("data-id") === `task:${id}`) ?? null;
const askButton = (host: HTMLElement, id: string) => cardEl(host, id)?.querySelector<HTMLElement>("[data-ask-orchestrator]") ?? null;

test("every task card has one ask button, in its foot", () => {
  const host = mount([task("a", "assigned", "Fix the mobile board\nSecond line"), task("b", "inbox", "Write the changelog")]);
  for (const id of ["a", "b"]) {
    const buttons = cardEl(host, id)!.querySelectorAll("[data-ask-orchestrator]");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.closest(".foot")).not.toBeNull();
    expect(buttons[0]!.getAttribute("aria-label")).toBeTruthy();
  }
});

test("pressing it adds this task's chip to the project's orchestrator, and changes nothing else on the card", () => {
  const host = mount([task("a", "assigned", "Fix the mobile board\nSecond line", { color: "teal" })]);
  const withoutButton = () => {
    const clone = cardEl(host, "a")!.cloneNode(true) as HTMLElement;
    clone.querySelector("[data-ask-orchestrator]")!.remove();
    return clone.innerHTML.replace(/\s+/g, " ");
  };
  const before = withoutButton();
  expect(askButton(host, "a")!.getAttribute("aria-pressed")).toBe("false");
  flushSyncClick(askButton(host, "a"));
  expect(readTaskChips("fixture")).toMatchObject([{ id: "a", title: "Fix the mobile board", color: "teal" }]);
  /* No input anywhere was written to, and the rest of the card is exactly as it was. */
  expect([...host.querySelectorAll("input, textarea")].every((input) => (input as HTMLInputElement).value === "")).toBe(true);
  expect(withoutButton()).toBe(before);
  /* The button itself says it took, wherever the composer is. */
  expect(askButton(host, "a")!.getAttribute("aria-pressed")).toBe("true");
});

test("several cards add several chips; pressing a pressed button takes its chip back off", () => {
  const host = mount([task("a", "assigned", "First"), task("b", "inbox", "Second")]);
  flushSyncClick(askButton(host, "a"));
  flushSyncClick(askButton(host, "b"));
  expect(readTaskChips("fixture").map((chip) => chip.id)).toEqual(["a", "b"]);
  flushSyncClick(askButton(host, "a"));
  expect(readTaskChips("fixture").map((chip) => chip.id)).toEqual(["b"]);
  expect(askButton(host, "a")!.getAttribute("aria-pressed")).toBe("false");
  expect(askButton(host, "b")!.getAttribute("aria-pressed")).toBe("true");
});

test("a chip removed in the composer releases the card's button", () => {
  const host = mount([task("a", "assigned", "First")]);
  flushSyncClick(askButton(host, "a"));
  flushSync(() => removeTaskChip("fixture", "a"));
  expect(askButton(host, "a")!.getAttribute("aria-pressed")).toBe("false");
});

test("the press asks the shell to open the orchestrator and does not move focus off the card's button", () => {
  const host = mount([task("a", "assigned", "First")]);
  const asked: string[] = [];
  const off = onOrchestratorFocusRequest((project) => asked.push(project));
  const button = askButton(host, "a")!;
  button.focus();
  flushSyncClick(button);
  off();
  expect(asked).toEqual(["fixture"]);
  expect(document.activeElement).toBe(button);
});

test("after a page reload the chip is back and the card's button is pressed again", () => {
  const host = mount([task("a", "assigned", "First"), task("b", "inbox", "Second")]);
  flushSyncClick(askButton(host, "a"));
  flushSync(() => reloadTaskChipsForTests());
  expect(readTaskChips("fixture").map((chip) => chip.id)).toEqual(["a"]);
  expect(askButton(host, "a")!.getAttribute("aria-pressed")).toBe("true");
  expect(askButton(host, "b")!.getAttribute("aria-pressed")).toBe("false");
});

test("with the cap reached, a card not yet attached cannot add; an attached one can still be taken off", () => {
  const tasks = Array.from({ length: MAX_TASK_CHIPS + 1 }, (_, n) => task(`c${n}`, "assigned", `Task ${n}`));
  const host = mount(tasks);
  for (let n = 0; n < MAX_TASK_CHIPS; n += 1) flushSync(() => { addTaskChip("fixture", { id: `c${n}`, title: `Task ${n}` }); });
  const extra = askButton(host, `c${MAX_TASK_CHIPS}`) as HTMLButtonElement;
  expect(extra.disabled).toBe(true);
  flushSyncClick(extra);
  expect(readTaskChips("fixture")).toHaveLength(MAX_TASK_CHIPS);
  expect(readTaskChips("fixture").some((chip) => chip.id === `c${MAX_TASK_CHIPS}`)).toBe(false);
  expect((askButton(host, "c0") as HTMLButtonElement).disabled).toBe(false);
  flushSyncClick(askButton(host, "c0"));
  expect(extra.disabled).toBe(false);
});

const receiptsIn = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("[data-kanban-receipt]")];

test("a press says so on the board with a receipt naming the task; taking it off adds no second one", () => {
  const host = mount([task("a", "assigned", "Fix the mobile board\nSecond line")]);
  expect(receiptsIn(host)).toHaveLength(0);
  flushSyncClick(askButton(host, "a"));
  const [receipt] = receiptsIn(host);
  expect(receiptsIn(host)).toHaveLength(1);
  expect(receipt!.querySelector(".msg")!.textContent).toContain("Fix the mobile board");
  expect(receipt!.querySelector(".act")!.textContent).toBe("Show");
  flushSyncClick(askButton(host, "a"));
  expect(receiptsIn(host)).toHaveLength(1);
});

test("a refused press (the cap) leaves no receipt behind", () => {
  const tasks = Array.from({ length: MAX_TASK_CHIPS + 1 }, (_, n) => task(`c${n}`, "assigned", `Task ${n}`));
  const host = mount(tasks);
  for (let n = 0; n < MAX_TASK_CHIPS; n += 1) flushSync(() => { addTaskChip("fixture", { id: `c${n}`, title: `Task ${n}` }); });
  flushSyncClick(askButton(host, `c${MAX_TASK_CHIPS}`));
  expect(receiptsIn(host)).toHaveLength(0);
});

test("the receipt's Show brings the seat's composer into focus", () => {
  const host = mount([task("a", "assigned", "First")]);
  const seat = document.createElement("section");
  seat.setAttribute("data-kanban-seat", "fixture");
  const input = document.createElement("textarea");
  let scrolled = 0;
  (input as unknown as { scrollIntoView: () => void }).scrollIntoView = () => { scrolled += 1; };
  seat.appendChild(input);
  document.body.appendChild(seat);
  flushSyncClick(askButton(host, "a"));
  flushSyncClick(receiptsIn(host)[0]!.querySelector(".act"));
  expect(scrolled).toBe(1);
  expect(document.activeElement).toBe(input);
  expect(receiptsIn(host)).toHaveLength(0);
});

function flushSyncClick(element: Element | null) {
  expect(element).toBeTruthy();
  flushSync(() => (element as HTMLElement).click());
}
