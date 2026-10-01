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
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});

const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { KanbanBoard } = await import("./KanbanBoard");
const { readTaskChips, removeTaskChip, resetTaskChipsForTests, onOrchestratorFocusRequest } = await import("@/components/orchestrator/taskChips");

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

function flushSyncClick(element: Element | null) {
  expect(element).toBeTruthy();
  flushSync(() => (element as HTMLElement).click());
}
