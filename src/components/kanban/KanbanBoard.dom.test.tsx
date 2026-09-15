import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { BoardTask, TaskStatus } from "@/lib/tasks/types";

import { KanbanBoard, kanbanLayoutMode } from "./KanbanBoard";
import type { TaskMutationPorts } from "./useTaskMutations";

/* The board rendered by React against invented tasks and scripted task ports.
   No route, no store, no state directory is touched. */

const dom = new Window({ url: "http://localhost/" });
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
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();
});

const REV = (n: number) => `task-v1:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function task(id: string, status: TaskStatus, text: string, extra: Partial<BoardTask> & { revision?: string } = {}): BoardTask {
  return {
    id,
    project: "fixture",
    text,
    status,
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-09-14T10:00:00.000Z",
    updatedAt: "2026-09-14T10:00:00.000Z",
    revision: REV(1),
    ...extra,
  } as BoardTask;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function mount(tasks: BoardTask[], ports: TaskMutationPorts) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const render = (next: BoardTask[]) => flushSync(() => root.render(
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
      mutationPorts={ports}
    />,
  ));
  render(tasks);
  return { host, render };
}

const columnOf = (host: HTMLElement, id: string) => host.querySelector(`.card[data-id="task:${id}"]`)?.closest<HTMLElement>(".column")?.dataset.status ?? null;
const receiptTexts = (host: HTMLElement) => [...host.querySelectorAll("[data-kanban-receipt] .msg")].map((node) => node.textContent);
const click = (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  flushSync(() => (element as HTMLElement).click());
};

test("the layout mode follows the board's own width, tabbed from 640 px up to 767 px", () => {
  expect(kanbanLayoutMode(640)).toBe("tabs");
  expect(kanbanLayoutMode(767)).toBe("tabs");
  expect(kanbanLayoutMode(768)).toBe("scroll");
  expect(kanbanLayoutMode(1199)).toBe("scroll");
  expect(kanbanLayoutMode(1200)).toBe("narrow");
  expect(kanbanLayoutMode(1399)).toBe("narrow");
  expect(kanbanLayoutMode(1400)).toBe("wide");
});

test("four columns hold every task; an empty task taken off the board is counted, never dropped", () => {
  const { host } = mount([
    task("a", "inbox", "Write the release notes"),
    task("b", "assigned", "Repair old links"),
    task("c", "done", "Merge the approved queue adapter"),
    task("d", "done", "An old empty task", { board: "hidden" }),
  ], { patch: async () => ({ ok: false, status: 500, error: "unused" }), read: async () => null, changed: () => {} });
  expect([...host.querySelectorAll(".column")].map((column) => (column as HTMLElement).dataset.status)).toEqual(["inbox", "assigned", "blocked", "done"]);
  expect(columnOf(host, "a")).toBe("inbox");
  expect(columnOf(host, "b")).toBe("assigned");
  expect(columnOf(host, "c")).toBe("done");
  expect(columnOf(host, "d")).toBeNull();
  expect(host.querySelector("[data-hidden-pill]")?.getAttribute("data-count")).toBe("1");
  expect(host.querySelector(".column[data-status=blocked] .empty")?.textContent).toContain("Nothing blocked");
});

test("choosing a status moves the card at once, writes it with the guard, and offers Undo", async () => {
  const patches: unknown[] = [];
  let answer!: (value: Awaited<ReturnType<TaskMutationPorts["patch"]>>) => void;
  const ports: TaskMutationPorts = {
    patch: (id, body) => {
      patches.push({ id, body });
      return new Promise((resolve) => { answer = resolve; });
    },
    read: async () => null,
    changed: () => {},
  };
  const { host } = mount([task("a", "inbox", "Write the release notes")], ports);
  click(host.querySelector('.card[data-id="task:a"] .pill'));
  const done = [...host.querySelectorAll('.menu [role="menuitemradio"]')].find((item) => item.textContent?.includes("Done"));
  click(done);
  expect(columnOf(host, "a")).toBe("done");
  expect(host.querySelector('.card[data-id="task:a"]')?.getAttribute("data-pending")).toBe("1");
  expect(receiptTexts(host)).toContain("Moved «Write the release notes» to Done");
  await tick();
  /* Focus follows the card into its new column. */
  expect(document.activeElement?.closest(".column")?.getAttribute("data-status")).toBe("done");
  expect(document.activeElement?.classList.contains("pill")).toBe(true);
  expect(patches).toEqual([{ id: "a", body: { status: "done", expectedProject: "fixture", expectedRevision: REV(1) } }]);
  answer({ ok: true, task: task("a", "done", "Write the release notes", { revision: REV(2) }) });
  await tick();
  expect(columnOf(host, "a")).toBe("done");
  expect(host.querySelector('.card[data-id="task:a"]')?.getAttribute("data-pending")).toBe("0");
  expect([...host.querySelectorAll("[data-kanban-receipt] .act")].map((node) => node.textContent)).toContain("Undo");
});

test("a refused write returns the card to its column with an error receipt and Retry", async () => {
  const ports: TaskMutationPorts = {
    patch: async () => ({ ok: false, status: 500, error: "disk full" }),
    read: async () => null,
    changed: () => {},
  };
  const { host } = mount([task("a", "assigned", "Repair old links")], ports);
  const card = host.querySelector<HTMLElement>('.card[data-id="task:a"]')!;
  card.focus();
  flushSync(() => card.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "]", bubbles: true }) as unknown as Event));
  expect(columnOf(host, "a")).toBe("blocked");
  await tick();
  await tick();
  expect(columnOf(host, "a")).toBe("assigned");
  expect(receiptTexts(host)).toContain("Couldn't save the status of «Repair old links»: disk full");
  expect(receiptTexts(host)).not.toContain("Moved «Repair old links» to Blocked");
  expect([...host.querySelectorAll("[data-kanban-receipt].error .act")].map((node) => node.textContent)).toEqual(["Retry"]);
});

test("a status changed elsewhere puts the card where the server has it and offers Move anyway", async () => {
  const ports: TaskMutationPorts = {
    patch: async () => ({ ok: false, status: 409, error: "expectedRevision is stale" }),
    read: async () => task("a", "blocked", "Repair old links", { revision: REV(5) }),
    changed: () => {},
  };
  const { host } = mount([task("a", "inbox", "Repair old links")], ports);
  click(host.querySelector('.card[data-id="task:a"] .pill'));
  click([...host.querySelectorAll('.menu [role="menuitemradio"]')].find((item) => item.textContent?.includes("Assigned")));
  await tick();
  await tick();
  expect(columnOf(host, "a")).toBe("blocked");
  expect(receiptTexts(host)).toContain("«Repair old links» was changed elsewhere to Blocked");
  expect([...host.querySelectorAll("[data-kanban-receipt] .act")].map((node) => node.textContent)).toContain("Move anyway");
});

test("find narrows each column and says how many of how many it shows", () => {
  const { host } = mount([
    task("a", "inbox", "Write the release notes"),
    task("b", "inbox", "Repair old links"),
  ], { patch: async () => ({ ok: false, status: 500, error: "unused" }), read: async () => null, changed: () => {} });
  const input = host.querySelector<HTMLInputElement>("[data-kanban-search]")!;
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(input, "links");
    input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
    input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "s", bubbles: true }) as unknown as Event);
  });
  expect(host.querySelector(".column[data-status=inbox] .col-head .n")?.textContent).toBe("1 of 2");
  expect(columnOf(host, "a")).toBeNull();
  expect(columnOf(host, "b")).toBe("inbox");
});

test("/ inside the board finds a task and never reaches the Viewer's global search; outside the board it is left alone", () => {
  const { host } = mount([task("a", "inbox", "Write the release notes")], { patch: async () => ({ ok: false, status: 500, error: "unused" }), read: async () => null, changed: () => {} });
  let globalSearch = 0;
  const viewerListener = (event: Event) => { if ((event as KeyboardEvent).key === "/") globalSearch += 1; };
  window.addEventListener("keydown", viewerListener);
  try {
    const card = host.querySelector<HTMLElement>('.card[data-id="task:a"]')!;
    card.focus();
    flushSync(() => card.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "/", bubbles: true }) as unknown as Event));
    expect(document.activeElement?.hasAttribute("data-kanban-search")).toBe(true);
    expect(globalSearch).toBe(0);
    (document.activeElement as HTMLElement).blur();
    const outside = new dom.KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
    document.body.dispatchEvent(outside as unknown as Event);
    expect(globalSearch).toBe(1);
    expect(outside.defaultPrevented).toBe(false);
  } finally {
    window.removeEventListener("keydown", viewerListener);
  }
});

test("U undoes only while the move's receipt is on screen", async () => {
  const patches: unknown[] = [];
  const ports: TaskMutationPorts = {
    patch: async (id, body) => {
      patches.push({ id, body });
      return { ok: true, task: task(id, (body as { status: TaskStatus }).status, "Write the release notes", { revision: REV(patches.length + 1) }) };
    },
    read: async () => null,
    changed: () => {},
  };
  const { host } = mount([task("a", "inbox", "Write the release notes")], ports);
  const card = host.querySelector<HTMLElement>('.card[data-id="task:a"]')!;
  card.focus();
  flushSync(() => card.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "]", bubbles: true }) as unknown as Event));
  await tick();
  expect(columnOf(host, "a")).toBe("assigned");
  /* The receipt is closed by hand: its Undo goes with it. */
  click([...host.querySelectorAll("[data-kanban-receipt] .close")].at(-1));
  expect(host.querySelector("[data-kanban-receipt]")).toBeNull();
  flushSync(() => document.body.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "u", bubbles: true }) as unknown as Event));
  await tick();
  expect(patches).toHaveLength(1);
  expect(columnOf(host, "a")).toBe("assigned");
});
