import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { BoardTask, TaskStatus } from "@/lib/tasks/types";

import { KanbanBoard, kanbanColumnTracks, kanbanLayoutMode, kanbanLayoutModeBeside, type KanbanBoardProps } from "./KanbanBoard";
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

function mount(tasks: BoardTask[], ports: TaskMutationPorts, extra: Partial<KanbanBoardProps> = {}) {
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
      {...extra}
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

test("a seat docked at the side never costs the columns: what it leaves scrolls instead of folding into tabs (#1841)", () => {
  /* 1280 window: 1032 px of board, a 380 px seat leaves 652. */
  expect(kanbanLayoutModeBeside(1032, 380)).toBe("scroll");
  expect(kanbanLayoutModeBeside(1192, 380)).toBe("scroll");
  expect(kanbanLayoutModeBeside(1880, 380)).toBe("wide");
  expect(kanbanLayoutModeBeside(1032, 0)).toBe("scroll");
  /* A board already too narrow for columns stays tabbed. */
  expect(kanbanLayoutModeBeside(700, 380)).toBe("tabs");
  expect(kanbanLayoutModeBeside(700, 0)).toBe("tabs");
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

/* ── #1841: a column can take the wide share; `O` folds the seat ─────────── */

const NO_PORTS: TaskMutationPorts = { patch: async () => ({ ok: false, status: 500, error: "unused" }), read: async () => null, changed: () => {} };
const column = (host: HTMLElement, status: TaskStatus) => host.querySelector<HTMLElement>(`.column[data-status="${status}"]`)!;
const widthButton = (host: HTMLElement, status: TaskStatus) => host.querySelector<HTMLElement>(`[data-col-width="${status}"]`);
const wideColumns = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('.column[data-wide="1"]')].map((node) => node.dataset.status);

/* happy-dom lays nothing out; the board is given a 1440 px desktop so it
   takes its four-column grid instead of tabs. */
function atBoardWidth<T>(width: number, run: () => T): T {
  const prototype = dom.HTMLElement.prototype as unknown as { getBoundingClientRect: () => DOMRect };
  const original = prototype.getBoundingClientRect;
  prototype.getBoundingClientRect = function (this: HTMLElement) {
    const board = this.classList?.contains("kb");
    return { x: 0, y: 0, top: 0, left: 0, bottom: 900, right: board ? width : 0, width: board ? width : 0, height: 900, toJSON() {} } as DOMRect;
  };
  try { return run(); } finally { prototype.getBoundingClientRect = original; }
}
const atDesktopWidth = <T,>(run: () => T): T => atBoardWidth(1440, run);

test("a shelf takes the wide share, one at a time, and gives it back when work resumes in Assigned unless pinned", () => atDesktopWidth(() => {
  localStorage.clear();
  const tasks = [task("a", "assigned", "Repair old links"), task("d", "done", "Merge the approved queue adapter"), task("b", "blocked", "Waiting on a review")];
  const { host } = mount(tasks, NO_PORTS);
  /* Assigned already is the wide one: no button draws on it. */
  expect(widthButton(host, "assigned")).toBeNull();
  expect(wideColumns(host)).toEqual(["assigned"]);
  expect(widthButton(host, "done")?.getAttribute("aria-label")).toBe("Widen Done");

  click(widthButton(host, "done"));
  expect(wideColumns(host)).toEqual(["done"]);
  expect(column(host, "done").className).toContain("wide");
  expect(column(host, "assigned").className).toContain("shelf");
  expect(host.querySelector<HTMLElement>("[data-board]")!.style.getPropertyValue("--c-done")).toContain("1fr");
  expect(widthButton(host, "done")?.getAttribute("aria-label")).toBe("Back to narrow");
  expect(widthButton(host, "assigned")?.getAttribute("data-col-width-action")).toBe("widen");

  /* Widening another narrows the previous one. */
  click(widthButton(host, "blocked"));
  expect(wideColumns(host)).toEqual(["blocked"]);

  /* Reading inside the wide column keeps it wide; a focus on a card in Assigned gives the space back. */
  flushSync(() => host.querySelector<HTMLElement>('.card[data-id="task:b"]')!.dispatchEvent(new dom.FocusEvent("focusin", { bubbles: true }) as unknown as Event));
  expect(wideColumns(host)).toEqual(["blocked"]);
  flushSync(() => host.querySelector<HTMLElement>('.card[data-id="task:a"]')!.dispatchEvent(new dom.FocusEvent("focusin", { bubbles: true }) as unknown as Event));
  expect(wideColumns(host)).toEqual(["assigned"]);

  /* Pinned, it stays wide through work in Assigned and across a remount. */
  click(widthButton(host, "done"));
  const pin = () => host.querySelector<HTMLElement>('[data-col-pin="done"]');
  expect(pin()?.getAttribute("aria-pressed")).toBe("false");
  click(pin());
  expect(pin()?.getAttribute("aria-pressed")).toBe("true");
  expect(localStorage.getItem("llv:kanban-wide:v1")).toBe("done");
  flushSync(() => host.querySelector<HTMLElement>('.card[data-id="task:a"]')!.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true }) as unknown as Event));
  expect(wideColumns(host)).toEqual(["done"]);

  const again = mount(tasks, NO_PORTS);
  expect(wideColumns(again.host)).toEqual(["done"]);

  /* Back to narrow unpins. */
  click(widthButton(again.host, "done"));
  expect(localStorage.getItem("llv:kanban-wide:v1")).toBeNull();
  expect(wideColumns(again.host)).toEqual(["assigned"]);
  localStorage.clear();
}));

test("the Overview keeps its fixed shares: no width control and no read of a project's pin", () => atDesktopWidth(() => {
  localStorage.clear();
  localStorage.setItem("llv:kanban-wide:v1", "blocked");
  const tasks = [task("a", "assigned", "Repair old links"), task("b", "blocked", "Waiting on a review")];
  const { host } = mount(tasks, NO_PORTS, { project: "__overview__", overview: { names: { fixture: "fixture" }, onOpenProject: () => {}, keep: () => true } });
  expect(host.querySelector("[data-board]")?.getAttribute("data-mode")).toBe("wide");
  expect(host.querySelector("[data-col-width], [data-col-pin]")).toBeNull();
  expect(host.querySelector('.column[data-wide]')).toBeNull();
  /* Its shelves keep the 264 px cap a project board gave up on large screens. */
  expect(host.querySelector<HTMLElement>("[data-board]")!.style.getPropertyValue("--c-blocked")).toBe("minmax(232px, var(--shelf-w))");
  /* The project board still reads the pin. */
  const project = mount(tasks, NO_PORTS);
  expect(wideColumns(project.host)).toEqual(["blocked"]);
  localStorage.clear();
}));

/* The board's own column template, as the board writes it in each mode. The
   balanced shelf track is `--shelf-balanced`, a third of 35 % of Assigned's
   old width on top of 264 px; the browser driver measures what it resolves to. */
const tracks = (host: HTMLElement) => {
  const style = host.querySelector<HTMLElement>("[data-board]")!.style;
  return Object.fromEntries(STATUSES.map((status) => [status, style.getPropertyValue(`--c-${status}`)]));
};
const STATUSES: TaskStatus[] = ["inbox", "assigned", "blocked", "done"];
const BALANCED = "minmax(232px, var(--shelf-balanced))";
const CAPPED = "minmax(232px, var(--shelf-w))";
const WORK = "minmax(var(--work-min), 1fr)";

test("on a large screen a project board balances its columns; narrow, scroll, tabs and the Overview keep theirs", () => {
  localStorage.clear();
  const tasks = [task("a", "assigned", "Repair old links"), task("b", "blocked", "Waiting on a review")];
  const overview = { project: "__overview__", overview: { names: { fixture: "fixture" }, onOpenProject: () => {}, keep: () => true } };
  const at = (width: number, extra: Partial<KanbanBoardProps> = {}) => atBoardWidth(width, () => {
    const { host } = mount(tasks, NO_PORTS, extra);
    return { mode: host.querySelector("[data-board]")?.getAttribute("data-mode"), tracks: tracks(host), host };
  });

  for (const width of [1440, 1920, 2560]) {
    const wide = at(width);
    expect(wide.mode).toBe("wide");
    expect(wide.tracks).toEqual({ inbox: BALANCED, assigned: WORK, blocked: BALANCED, done: BALANCED });
    /* The Overview keeps the capped shelves it had. */
    const cross = at(width, overview);
    expect(cross.mode).toBe("wide");
    expect(cross.tracks).toEqual({ inbox: CAPPED, assigned: WORK, blocked: CAPPED, done: CAPPED });
  }
  /* 1200–1399: 220 px shelves and a 440 px floor, on a project board and the Overview alike. */
  for (const extra of [{}, overview]) {
    const narrow = at(1300, extra);
    expect(narrow.mode).toBe("narrow");
    expect(narrow.tracks).toEqual({ inbox: "220px", assigned: "minmax(440px, 1fr)", blocked: "220px", done: "220px" });
  }
  /* The scroller and the tabs are flex rows: no grid tracks at all. */
  for (const [width, mode] of [[1000, "scroll"], [700, "tabs"]] as const) {
    const flex = at(width);
    expect(flex.mode).toBe(mode);
    expect(flex.tracks).toEqual({ inbox: "", assigned: "", blocked: "", done: "" });
  }

  /* The wide share (#1841) swaps onto the widened shelf, and Assigned takes a balanced shelf's track. */
  atBoardWidth(1920, () => {
    const { host } = mount(tasks, NO_PORTS);
    click(widthButton(host, "done"));
    expect(tracks(host)).toEqual({ inbox: BALANCED, assigned: BALANCED, blocked: BALANCED, done: WORK });
  });
  localStorage.clear();
});

test("the column template function holds the reading width and the wide share in every grid mode", () => {
  const none = new Set<TaskStatus>();
  const reading = new Set<TaskStatus>(["blocked"]);
  expect(kanbanColumnTracks("scroll", { overview: false, wide: null, reading })).toBeNull();
  expect(kanbanColumnTracks("tabs", { overview: false, wide: "done", reading: none })).toBeNull();
  /* Reading: at least 420–460 px, never narrower than a balanced shelf beside it. */
  expect(kanbanColumnTracks("wide", { overview: false, wide: null, reading })).toEqual({
    "--c-inbox": BALANCED, "--c-assigned": "minmax(440px, 1fr)", "--c-blocked": "minmax(420px, max(460px, var(--shelf-balanced)))", "--c-done": BALANCED,
  });
  /* Narrow and the Overview read exactly as before. */
  expect(kanbanColumnTracks("narrow", { overview: false, wide: null, reading })).toEqual({
    "--c-inbox": "220px", "--c-assigned": "minmax(440px, 1fr)", "--c-blocked": "minmax(420px, 460px)", "--c-done": "220px",
  });
  expect(kanbanColumnTracks("wide", { overview: true, wide: null, reading })).toEqual({
    "--c-inbox": CAPPED, "--c-assigned": "minmax(440px, 1fr)", "--c-blocked": "minmax(420px, 460px)", "--c-done": CAPPED,
  });
  expect(kanbanColumnTracks("narrow", { overview: false, wide: "inbox", reading: none })).toEqual({
    "--c-inbox": "minmax(440px, 1fr)", "--c-assigned": "220px", "--c-blocked": "220px", "--c-done": "220px",
  });
  /* A widened shelf that also holds reading keeps the wide share. */
  expect(kanbanColumnTracks("wide", { overview: false, wide: "blocked", reading })).toEqual({
    "--c-inbox": BALANCED, "--c-assigned": BALANCED, "--c-blocked": WORK, "--c-done": BALANCED,
  });
});

test("in tabs every column is already full width, so no column draws the control", () => {
  const { host } = mount([task("d", "done", "Merge the approved queue adapter")], NO_PORTS);
  expect(host.querySelector("[data-board]")?.getAttribute("data-mode")).toBe("tabs");
  expect(host.querySelector("[data-col-width]")).toBeNull();
});

test("O folds and unfolds the orchestrator seat while no field holds the keys", () => {
  localStorage.clear();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  flushSync(() => root.render(
    <KanbanBoard
      project="fixture" groups={[]} manual={[]} files={[]} flows={[]} pipelines={[]} tasks={[]} allTasks={[]} drafts={[]}
      now={1_800_000_000} loaded catalogFailures={0} selection={new Set()} onOpenConversations={() => {}}
      seatRefs={null} mutationPorts={NO_PORTS}
      seat={() => <section data-fake-seat="" />}
    />,
  ));
  const folded = () => JSON.parse(localStorage.getItem("llv:kanban-seat:v2") ?? "{}").collapsed?.fixture;
  const press = (target: EventTarget) => flushSync(() => target.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "o", bubbles: true }) as unknown as Event));
  /* A short test window starts the seat folded; each press flips it. */
  press(document.body);
  const first = folded();
  expect(typeof first).toBe("boolean");
  press(document.body);
  expect(folded()).toBe(!first);
  /* Typing an «o» into the find field is typing. */
  press(host.querySelector("[data-kanban-search]")!);
  expect(folded()).toBe(!first);
  localStorage.clear();
});
