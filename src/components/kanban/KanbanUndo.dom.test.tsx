import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

import type { BoardTask, TaskStatus } from "@/lib/tasks/types";

import type { PatchBody, TaskMutationPorts } from "./useTaskMutations";

/* Undo and redo on the desktop board (#1856), rendered by React against
   invented tasks and a scripted store that keeps the revision fence the real
   one keeps: a write whose expectedRevision is not the stored revision is
   answered 409 TASK_REVISION_MISMATCH. No route, store or state directory is
   touched. */

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

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();
});

const REV = (n: number) => ["task-v1:00000000", "0000", "4000", "8000", String(n).padStart(12, "0")].join("-");
const NOW = 1_800_000_000;

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

/** A store holding the rows, fenced on their revision as the real one is. */
function fencedStore(initial: BoardTask[]) {
  const rows = new Map(initial.map((row) => [row.id, row] as const));
  const patches: Array<{ id: string; body: PatchBody }> = [];
  let revision = 10;
  const ports: TaskMutationPorts = {
    patch: async (id, body) => {
      patches.push({ id, body });
      const row = rows.get(id);
      if (!row) return { ok: false, status: 404, error: "task not found" };
      if (body.expectedRevision !== (row as BoardTask & { revision?: string }).revision) return { ok: false, status: 409, error: "expectedRevision is stale", code: "TASK_REVISION_MISMATCH" };
      const { expectedProject: _project, expectedRevision: _revision, ...change } = body as PatchBody & Record<string, unknown>;
      const saved = { ...row, ...change, revision: REV((revision += 1)) } as BoardTask & Record<string, unknown>;
      if ("hide" in change) {
        delete saved.hide;
        if (change.hide) saved.groupHidden = { at: `2026-09-14T12:00:${String(revision).padStart(2, "0")}.000Z`, by: "operator", admitted: [] };
        else delete saved.groupHidden;
      }
      rows.set(id, saved);
      return { ok: true, task: saved };
    },
    read: async (id) => rows.get(id) ?? null,
    changed: () => {},
  };
  /** Someone else writes the task: a new revision the board has not seen. */
  const elsewhere = (id: string, change: Partial<BoardTask>) => {
    rows.set(id, { ...rows.get(id)!, ...change, revision: REV((revision += 1)) } as BoardTask);
  };
  return { ports, patches, rows: () => [...rows.values()], elsewhere };
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(tasks: BoardTask[]) {
  const store = fencedStore(tasks);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  let project = "fixture";
  let shown = tasks;
  const render = (options: { project?: string; poll?: boolean } = {}) => {
    if (options.project) project = options.project;
    if (options.poll) shown = store.rows();
    flushSync(() => root.render(
      <KanbanBoard
        project={project}
        groups={[]}
        manual={[]}
        files={[]}
        flows={[]}
        pipelines={[]}
        tasks={[]}
        allTasks={shown}
        drafts={[]}
        now={NOW}
        loaded
        catalogFailures={0}
        selection={new Set()}
        onOpenConversations={() => {}}
        seatRefs={null}
        mutationPorts={store.ports}
      />,
    ));
  };
  render();
  return { host, render, store };
}

const cardEl = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`.card[data-id="task:${id}"]`);
const columnOf = (host: HTMLElement, id: string) => cardEl(host, id)?.closest<HTMLElement>(".column")?.dataset.status ?? null;
const titleOf = (host: HTMLElement, id: string) => cardEl(host, id)?.querySelector(".title")?.textContent ?? null;
const receipts = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("[data-kanban-receipt]")].map((receipt) => ({
  text: receipt.querySelector(".msg")?.textContent,
  action: receipt.querySelector(".act")?.textContent ?? null,
  error: receipt.classList.contains("error"),
}));
const receiptAction = (host: HTMLElement, text: string) => [...host.querySelectorAll("[data-kanban-receipt]")].find((receipt) => receipt.querySelector(".msg")?.textContent === text)?.querySelector<HTMLElement>(".act") ?? null;
const click = (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  flushSync(() => (element as HTMLElement).click());
};
const press = (element: Element | null | undefined, key: string, modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {}) => {
  expect(element).toBeTruthy();
  const event = new dom.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers });
  flushSync(() => element!.dispatchEvent(event as unknown as Event));
  return event;
};
const type = (field: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = field.tagName === "TEXTAREA" ? dom.HTMLTextAreaElement.prototype : dom.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  flushSync(() => {
    setter.call(field, value);
    field.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
};
const editor = (host: HTMLElement, id: string) => cardEl(host, id)?.querySelector<HTMLInputElement & HTMLTextAreaElement>("[data-card-editor]") ?? null;
const ctrlZ = (target: Element | null | undefined = document.body) => press(target, "z", { ctrlKey: true });
const ctrlShiftZ = (target: Element | null | undefined = document.body) => press(target, "Z", { ctrlKey: true, shiftKey: true });
/** Moves a card one column right with its `]` key and lets the write land. */
async function shiftRight(host: HTMLElement, id: string) {
  const card = cardEl(host, id)!;
  card.focus();
  press(card, "]");
  await tick();
}
const bodies = (patches: Array<{ body: PatchBody }>) => patches.map((patch) => patch.body);

test("a move: Ctrl+Z puts the card back and Ctrl+Shift+Z moves it again, each fenced on the board's own last revision", async () => {
  const view = mount([task("a", "inbox", "Write the release notes"), task("b", "inbox", "Repair old links")]);
  await shiftRight(view.host, "a");
  expect(columnOf(view.host, "a")).toBe("assigned");
  expect(receipts(view.host)).toEqual([{ text: "Moved «Write the release notes» to Assigned", action: "Undo", error: false }]);

  const undo = ctrlZ(cardEl(view.host, "a"));
  expect(undo.defaultPrevented).toBe(true);
  expect(columnOf(view.host, "a")).toBe("inbox");
  /* One receipt that changes, never a stack of them. */
  expect(receipts(view.host)).toEqual([{ text: "«Write the release notes» is back in Inbox", action: "Redo", error: false }]);
  await tick();

  ctrlShiftZ();
  expect(columnOf(view.host, "a")).toBe("assigned");
  expect(receipts(view.host)).toEqual([{ text: "Moved «Write the release notes» to Assigned", action: "Undo", error: false }]);
  await tick();
  expect(bodies(view.store.patches)).toEqual([
    { status: "assigned", expectedProject: "fixture", expectedRevision: REV(1) },
    { status: "inbox", expectedProject: "fixture", expectedRevision: REV(11) },
    { status: "assigned", expectedProject: "fixture", expectedRevision: REV(12) },
  ]);

  /* Cmd+Z undoes on a Mac, and Ctrl+Y redoes. */
  press(document.body, "z", { metaKey: true });
  await tick();
  expect(columnOf(view.host, "a")).toBe("inbox");
  press(document.body, "y", { ctrlKey: true });
  await tick();
  expect(columnOf(view.host, "a")).toBe("assigned");
  expect(view.store.patches).toHaveLength(5);
  expect(columnOf(view.host, "b")).toBe("inbox");
});

test("a text edit: Ctrl+Z restores the previous text, Ctrl+Shift+Z puts the edit back, with a receipt for each", async () => {
  const view = mount([task("a", "assigned", "Repair old links\nKeep the anchors stable")]);
  click(cardEl(view.host, "a")?.querySelector("[data-rename]"));
  type(editor(view.host, "a")!, "Repair every old link");
  press(editor(view.host, "a"), "Enter");
  expect(receipts(view.host)).toEqual([{ text: "Edited «Repair every old link»", action: "Undo", error: false }]);
  await tick();

  ctrlZ(cardEl(view.host, "a"));
  expect(titleOf(view.host, "a")).toBe("Repair old links");
  expect(receipts(view.host)).toEqual([{ text: "Restored the previous text of «Repair every old link»", action: "Redo", error: false }]);
  await tick();
  expect(view.store.rows()[0]!.text).toBe("Repair old links\nKeep the anchors stable");

  ctrlShiftZ(cardEl(view.host, "a"));
  expect(titleOf(view.host, "a")).toBe("Repair every old link");
  expect(receipts(view.host)).toEqual([{ text: "Edited «Repair every old link»", action: "Undo", error: false }]);
  await tick();
  expect(bodies(view.store.patches)).toEqual([
    { text: "Repair every old link\nKeep the anchors stable", expectedProject: "fixture", expectedRevision: REV(1) },
    { text: "Repair old links\nKeep the anchors stable", expectedProject: "fixture", expectedRevision: REV(11) },
    { text: "Repair every old link\nKeep the anchors stable", expectedProject: "fixture", expectedRevision: REV(12) },
  ]);
});

test("a hide: Ctrl+Z brings the group back, Ctrl+Y hides it again", async () => {
  const view = mount([task("a", "done", "Merge the approved queue adapter"), task("b", "done", "Compact board stages")]);
  click(cardEl(view.host, "a")?.querySelector("[data-hide]"));
  expect(columnOf(view.host, "a")).toBeNull();
  expect(receipts(view.host)).toEqual([{ text: "Hidden «Merge the approved queue adapter»", action: "Undo", error: false }]);
  await tick();

  ctrlZ();
  expect(columnOf(view.host, "a")).toBe("done");
  expect(receipts(view.host)).toEqual([{ text: "«Merge the approved queue adapter» is back on the board", action: "Redo", error: false }]);
  await tick();
  expect(view.store.rows()[0]!.groupHidden).toBeUndefined();

  press(document.body, "y", { ctrlKey: true });
  expect(columnOf(view.host, "a")).toBeNull();
  expect(receipts(view.host)).toEqual([{ text: "Hidden «Merge the approved queue adapter»", action: "Undo", error: false }]);
  await tick();
  expect(view.store.patches.map((patch) => [(patch.body as { hide: boolean }).hide, patch.body.expectedRevision])).toEqual([
    [true, REV(1)],
    [false, REV(11)],
    [true, REV(12)],
  ]);
  expect(view.store.rows()[0]!.groupHidden).toBeTruthy();
});

test("the receipt's Undo and Redo run the same step as the keys", async () => {
  const view = mount([task("a", "inbox", "Write the release notes")]);
  await shiftRight(view.host, "a");
  click(receiptAction(view.host, "Moved «Write the release notes» to Assigned"));
  expect(columnOf(view.host, "a")).toBe("inbox");
  await tick();
  click(receiptAction(view.host, "«Write the release notes» is back in Inbox"));
  expect(columnOf(view.host, "a")).toBe("assigned");
  await tick();
  expect(bodies(view.store.patches).map((body) => [(body as { status: TaskStatus }).status, body.expectedRevision])).toEqual([
    ["assigned", REV(1)],
    ["inbox", REV(11)],
    ["assigned", REV(12)],
  ]);
  expect(receipts(view.host)).toEqual([{ text: "Moved «Write the release notes» to Assigned", action: "Undo", error: false }]);
});

test("an undo of a task someone else changed meanwhile is refused: one write, nothing overwritten, and a receipt that says so", async () => {
  const view = mount([task("a", "inbox", "Write the release notes"), task("b", "inbox", "Repair old links")]);
  await shiftRight(view.host, "b");
  await shiftRight(view.host, "a");
  /* An agent changes a's text; the poll brings its revision to the board. */
  view.store.elsewhere("a", { text: "Write the release notes for 2.0" });
  view.render({ poll: true });
  expect(titleOf(view.host, "a")).toBe("Write the release notes for 2.0");
  const before = view.store.patches.length;

  ctrlZ();
  expect(columnOf(view.host, "a")).toBe("inbox");
  await tick();
  await tick();
  expect(view.store.patches.length - before).toBe(1);
  expect(view.store.patches.at(-1)?.body).toEqual({ status: "inbox", expectedProject: "fixture", expectedRevision: REV(12) });
  /* The card is where the store has it, with the agent's text. */
  expect(columnOf(view.host, "a")).toBe("assigned");
  expect(view.store.rows().find((row) => row.id === "a")).toMatchObject({ status: "assigned", text: "Write the release notes for 2.0" });
  /* The undo's own receipt is replaced by the refusal; b's move still counts down. */
  expect(receipts(view.host)).toEqual([
    { text: "Moved «Repair old links» to Assigned", action: "Undo", error: false },
    { text: "«Write the release notes» was changed elsewhere, so nothing was undone", action: null, error: true },
  ]);

  /* The refused task leaves the history; the next Ctrl+Z undoes b's move. */
  ctrlZ();
  await tick();
  expect(view.store.patches.at(-1)?.id).toBe("b");
  expect(columnOf(view.host, "b")).toBe("inbox");
  expect(ctrlZ().defaultPrevented).toBe(false);
  await tick();
  expect(view.store.patches.length - before).toBe(2);
});

test("a text undo meeting an agent's newer text is refused and the card keeps their text", async () => {
  const view = mount([task("a", "assigned", "Repair old links\nKeep the anchors stable")]);
  click(cardEl(view.host, "a")?.querySelector("[data-rename]"));
  type(editor(view.host, "a")!, "Repair every old link");
  press(editor(view.host, "a"), "Enter");
  await tick();
  view.store.elsewhere("a", { text: "Repair every old link\nAn agent rewrote the description" });
  ctrlZ();
  await tick();
  await tick();
  expect(view.store.patches).toHaveLength(2);
  expect(view.store.rows()[0]!.text).toBe("Repair every old link\nAn agent rewrote the description");
  expect(cardEl(view.host, "a")?.textContent).toContain("An agent rewrote the description");
  expect(receipts(view.host)).toEqual([{ text: "«Repair every old link» was changed elsewhere, so nothing was undone", action: null, error: true }]);
});

test("the keys do nothing in a text field, the composer, a dialog or an open menu", async () => {
  const view = mount([task("a", "inbox", "Write the release notes")]);
  await shiftRight(view.host, "a");
  expect(view.store.patches).toHaveLength(1);

  /* The card's own inline editor. */
  click(cardEl(view.host, "a")?.querySelector("[data-rename]"));
  expect(ctrlZ(editor(view.host, "a")).defaultPrevented).toBe(false);
  expect(ctrlShiftZ(editor(view.host, "a")).defaultPrevented).toBe(false);
  press(editor(view.host, "a"), "Escape");
  /* A composer (a textarea) and a dialog, wherever they sit. */
  const composer = document.createElement("textarea");
  view.host.appendChild(composer);
  composer.focus();
  expect(ctrlZ(composer).defaultPrevented).toBe(false);
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  const inside = document.createElement("button");
  dialog.appendChild(inside);
  view.host.querySelector(".column")!.appendChild(dialog);
  expect(ctrlZ(inside).defaultPrevented).toBe(false);
  /* The card's ⋯ menu is open. */
  click(cardEl(view.host, "a")?.querySelector("[data-menu]"));
  expect(view.host.querySelector(".menu")).toBeTruthy();
  expect(ctrlZ(cardEl(view.host, "a")).defaultPrevented).toBe(false);
  await tick();
  expect(view.store.patches).toHaveLength(1);
  expect(columnOf(view.host, "a")).toBe("assigned");

  /* Out of all of them, on the card itself, the same chord undoes. */
  press(view.host.querySelector(".menu"), "Escape");
  dialog.remove();
  expect(view.host.querySelector(".menu")).toBeNull();
  expect(ctrlZ(cardEl(view.host, "a")).defaultPrevented).toBe(true);
  await tick();
  expect(view.store.patches).toHaveLength(2);
  expect(columnOf(view.host, "a")).toBe("inbox");
});

test("a project switch empties the history", async () => {
  const view = mount([task("a", "inbox", "Write the release notes")]);
  await shiftRight(view.host, "a");
  view.render({ project: "elsewhere" });
  view.render({ project: "fixture" });
  expect(ctrlZ().defaultPrevented).toBe(false);
  await tick();
  expect(view.store.patches).toHaveLength(1);
  /* What the board does after the switch is undoable again. */
  await shiftRight(view.host, "a");
  expect(ctrlZ().defaultPrevented).toBe(true);
  await tick();
  expect(view.store.patches).toHaveLength(3);
  expect(columnOf(view.host, "a")).toBe("assigned");
});

test("the history holds the last fifty edits", async () => {
  const view = mount([task("a", "inbox", "Write the release notes")]);
  for (let index = 0; index < 52; index += 1) {
    const card = cardEl(view.host, "a")!;
    card.focus();
    press(card, index % 2 ? "[" : "]");
    await tick(1);
  }
  const moves = view.store.patches.length;
  expect(moves).toBe(52);
  let taken = 0;
  while (ctrlZ().defaultPrevented) {
    taken += 1;
    await tick(1);
  }
  expect(taken).toBe(50);
  expect(view.store.patches.length - moves).toBe(50);
  /* Fifty undone from 52 moves leaves the card where the second move left it. */
  expect(columnOf(view.host, "a")).toBe("inbox");
});
