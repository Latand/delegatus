import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

import type { SeatRefs } from "@/lib/tasks/groupHide";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import type { AssignmentPorts } from "./kanbanAssignments";
import type { PatchBody, PatchResult, TaskMutationPorts } from "./useTaskMutations";

/* Task editing on the kanban board (#1695 K4b), rendered by React against
   invented tasks and scripted task ports: inline title and description,
   colour, the group hide with Undo, column bulk hides, the seat's group and
   the Hidden tray. No route, store or state directory is touched. */

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

/* React reads the DOM it runs in when it loads, so it loads after the window
   above exists; fields then change through React's own input events. */
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

function conversation(index: number): FileEntry {
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
    size: 0,
    activity: "idle",
    proc: null,
    pid: null,
    parent: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    name: `conversation-${index}`,
  } as FileEntry;
}

const assignment = (index: number) => ({ path: `/fixture/conversation-${index}.jsonl`, conversationId: `conversation_fixture_${index}`, panePid: null, state: "delivered" as const, error: null, at: "2026-09-14T10:00:00.000Z" });

interface Scripted {
  ports: TaskMutationPorts;
  patches: Array<{ id: string; body: PatchBody }>;
  /** The next answers, in order; an empty queue answers with the stored row changed as asked. */
  answers: Array<PatchResult | Promise<PatchResult>>;
}

function scripted(rows: () => readonly BoardTask[]): Scripted {
  const patches: Scripted["patches"] = [];
  const answers: Scripted["answers"] = [];
  let revision = 10;
  return {
    patches,
    answers,
    ports: {
      patch: async (id, body) => {
        patches.push({ id, body });
        const next = answers.shift();
        if (next) return next;
        const row = rows().find((candidate) => candidate.id === id)!;
        const { expectedProject: _project, expectedRevision: _revision, ...change } = body as PatchBody & Record<string, unknown>;
        const saved = { ...row, ...change, revision: REV((revision += 1)) } as BoardTask & Record<string, unknown>;
        if ("hide" in change) {
          delete saved.hide;
          if (change.hide) saved.groupHidden = { at: "2026-09-14T12:00:00.000Z", by: "operator", admitted: [] };
          else delete saved.groupHidden;
        }
        return { ok: true, task: saved };
      },
      read: async (id) => rows().find((candidate) => candidate.id === id) ?? null,
      changed: () => {},
    },
  };
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(tasks: BoardTask[], options: { ports?: TaskMutationPorts; seat?: SeatRefs | null; files?: FileEntry[]; manual?: FileEntry[]; closed?: string[]; onRestore?: (file: FileEntry) => void; assignments?: AssignmentPorts } = {}) {
  let current = tasks;
  let seat = options.seat ?? null;
  const server = scripted(() => current);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const render = (next?: BoardTask[], nextSeat?: SeatRefs | null) => {
    if (next) current = next;
    if (nextSeat !== undefined) seat = nextSeat;
    flushSync(() => root.render(
      <KanbanBoard
        project="fixture"
        groups={[]}
        manual={options.manual ?? []}
        files={options.files ?? []}
        flows={[]}
        pipelines={[]}
        tasks={[]}
        allTasks={current}
        drafts={[]}
        now={NOW}
        loaded
        catalogFailures={0}
        selection={new Set()}
        onOpenCatalog={() => {}}
        onOpenOnBoard={() => {}}
        seatRefs={seat}
        closedPaths={options.closed}
        {...(options.onRestore ? { onRestoreConversation: options.onRestore } : {})}
        {...(options.assignments ? { assignmentPorts: options.assignments } : {})}
        mutationPorts={options.ports ?? server.ports}
      />,
    ));
  };
  render();
  return { host, render, server };
}

const cardEl = (host: HTMLElement, id: string) => [...host.querySelectorAll<HTMLElement>(".card")].find((card) => card.getAttribute("data-id") === `task:${id}`) ?? null;
const columnOf = (host: HTMLElement, id: string) => cardEl(host, id)?.closest<HTMLElement>(".column")?.dataset.status ?? null;
const receiptTexts = (host: HTMLElement) => [...host.querySelectorAll("[data-kanban-receipt] .msg")].map((node) => node.textContent);
const receiptAction = (host: HTMLElement, text: string) => [...host.querySelectorAll("[data-kanban-receipt]")].find((receipt) => receipt.querySelector(".msg")?.textContent === text)?.querySelector<HTMLElement>(".act") ?? null;
const click = (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  flushSync(() => (element as HTMLElement).click());
};
const key = (element: Element | null | undefined, name: string) => {
  expect(element).toBeTruthy();
  flushSync(() => element!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }) as unknown as Event));
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
const menuItem = (host: HTMLElement, label: string) => [...host.querySelectorAll<HTMLElement>('.menu [role^="menuitem"]')].find((item) => item.querySelector(".lbl")?.firstChild?.textContent === label || item.getAttribute("aria-label") === label) ?? null;

test("a title is renamed in place: Enter saves the whole text with the guard, the card shows it at once, and focus stays on the card", async () => {
  const view = mount([task("a", "assigned", "Repair old links\nKeep the anchors stable")]);
  click(cardEl(view.host, "a")?.querySelector("[data-rename]"));
  const field = editor(view.host, "a")!;
  expect(field.value).toBe("Repair old links");
  expect(document.activeElement).toBe(field);
  type(field, "Repair every old link");
  key(field, "Enter");
  expect(cardEl(view.host, "a")?.querySelector(".title")?.textContent).toBe("Repair every old link");
  expect(cardEl(view.host, "a")?.getAttribute("data-pending")).toBe("1");
  expect(document.activeElement).toBe(cardEl(view.host, "a"));
  await tick();
  expect(view.server.patches).toEqual([{ id: "a", body: { text: "Repair every old link\nKeep the anchors stable", expectedProject: "fixture", expectedRevision: REV(1) } }]);
});

test("Esc cancels without a write; E edits the description and leaving the field saves it", async () => {
  const view = mount([task("a", "assigned", "Repair old links"), task("b", "assigned", "Write the release notes")]);
  const card = cardEl(view.host, "a")!;
  card.focus();
  key(card, "Enter");
  type(editor(view.host, "a")!, "Something else");
  key(editor(view.host, "a"), "Escape");
  expect(editor(view.host, "a")).toBeNull();
  expect(cardEl(view.host, "a")?.querySelector(".title")?.textContent).toBe("Repair old links");
  expect(document.activeElement).toBe(cardEl(view.host, "a"));

  key(cardEl(view.host, "a"), "e");
  const field = editor(view.host, "a")!;
  expect(field.tagName).toBe("TEXTAREA");
  type(field, "Keep the anchors stable");
  /* ⌘/Ctrl+Enter saves a description; a plain Enter is a new line. */
  key(field, "Enter");
  expect(editor(view.host, "a")).toBeTruthy();
  flushSync(() => cardEl(view.host, "b")!.focus());
  await tick();
  expect(editor(view.host, "a")).toBeNull();
  expect(view.server.patches.map((patch) => patch.body)).toEqual([{ text: "Repair old links\nKeep the anchors stable", expectedProject: "fixture", expectedRevision: REV(1) }]);
  /* Focus stays where the operator put it. */
  expect(document.activeElement).toBe(cardEl(view.host, "b"));
  expect(view.server.patches).toHaveLength(1);
});

test("a refused save keeps the draft with Retry and Discard, and the card shows the stored title again", async () => {
  const view = mount([task("a", "assigned", "Repair old links")]);
  view.server.answers.push({ ok: false, status: 500, error: "disk full" });
  click(cardEl(view.host, "a")?.querySelector("[data-rename]"));
  type(editor(view.host, "a")!, "Repair every old link");
  key(editor(view.host, "a"), "Enter");
  await tick();
  await tick();
  const notice = cardEl(view.host, "a")?.querySelector("[data-edit-failed]");
  expect(notice?.querySelector(".msg")?.textContent).toBe("Not saved: disk full. Your text is kept.");
  expect(cardEl(view.host, "a")?.querySelector(".title")?.textContent).toBe("Repair old links");
  expect([...notice!.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Retry", "Discard"]);
  click([...notice!.querySelectorAll("button")][0]);
  await tick();
  await tick();
  expect(view.server.patches.map((patch) => (patch.body as { text: string }).text)).toEqual(["Repair every old link", "Repair every old link"]);
  expect(cardEl(view.host, "a")?.querySelector("[data-edit-failed]")).toBeNull();
  expect(cardEl(view.host, "a")?.querySelector(".title")?.textContent).toBe("Repair every old link");

  /* An empty title is refused on the card before anything is sent. */
  click(cardEl(view.host, "a")?.querySelector("[data-rename]"));
  type(editor(view.host, "a")!, "   ");
  key(editor(view.host, "a"), "Enter");
  expect(cardEl(view.host, "a")?.querySelector("[data-edit-failed] .msg")?.textContent).toBe("Not saved: A task needs a title. Your text is kept.");
  click([...cardEl(view.host, "a")!.querySelectorAll("[data-edit-failed] button")][1]);
  expect(cardEl(view.host, "a")?.querySelector("[data-edit-failed]")).toBeNull();
  expect(view.server.patches).toHaveLength(2);
});

test("text an agent writes into the field being edited is offered beside the draft, never over it", async () => {
  const view = mount([task("a", "assigned", "Repair old links")]);
  click(cardEl(view.host, "a")?.querySelector("[data-rename]"));
  type(editor(view.host, "a")!, "Operator title");
  view.render([task("a", "assigned", "Agent title", { revision: REV(2) })]);
  await tick();
  expect(editor(view.host, "a")?.value).toBe("Operator title");
  const notice = cardEl(view.host, "a")?.querySelector("[data-edit-incoming]");
  expect(notice?.querySelector(".msg")?.textContent).toBe("An agent changed the title while you edit: «Agent title»");
  click([...notice!.querySelectorAll("button")].find((button) => button.textContent === "Use theirs"));
  expect(editor(view.host, "a")?.value).toBe("Agent title");
  expect(cardEl(view.host, "a")?.querySelector("[data-edit-incoming]")).toBeNull();
  expect(view.server.patches).toHaveLength(0);
});

test("a poll older than this device's own rename is not mistaken for an agent's title", async () => {
  const original = task("a", "assigned", "Repair old links");
  const view = mount([original]);
  click(cardEl(view.host, "a")?.querySelector("[data-rename]"));
  type(editor(view.host, "a")!, "Repair every old link");
  key(editor(view.host, "a"), "Enter");
  await tick();
  click(cardEl(view.host, "a")?.querySelector("[data-rename]"));
  expect(editor(view.host, "a")?.value).toBe("Repair every old link");
  /* A poll that left before the save lands with the old title. */
  view.render([{ ...original }]);
  await tick();
  expect(cardEl(view.host, "a")?.querySelector("[data-edit-incoming]")).toBeNull();
  expect(editor(view.host, "a")?.value).toBe("Repair every old link");
});

test("a save that meets an agent's newer title is a conflict: the editor returns with the draft and their title", async () => {
  let stored = task("a", "assigned", "Repair old links");
  const patches: PatchBody[] = [];
  const ports: TaskMutationPorts = {
    patch: async (_id, body) => {
      patches.push(body);
      stored = task("a", "assigned", "Agent title", { revision: REV(3) });
      return { ok: false, status: 409, code: "TASK_REVISION_MISMATCH", error: "expectedRevision is stale" };
    },
    read: async () => stored,
    changed: () => {},
  };
  const view = mount([task("a", "assigned", "Repair old links")], { ports });
  click(cardEl(view.host, "a")?.querySelector("[data-rename]"));
  type(editor(view.host, "a")!, "Operator title");
  key(editor(view.host, "a"), "Enter");
  await tick();
  await tick();
  expect(editor(view.host, "a")?.value).toBe("Operator title");
  expect(cardEl(view.host, "a")?.querySelector("[data-edit-incoming] .msg")?.textContent).toBe("An agent changed the title while you edit: «Agent title»");
  expect(patches).toHaveLength(1);
});

test("× hides the group at once with a receipt and Undo, focus moves to the next card, and no assignment port is called", async () => {
  const calls: string[] = [];
  const assignments: AssignmentPorts = {
    link: async () => { calls.push("link"); return { ok: true }; },
    unlink: async () => { calls.push("unlink"); return { ok: true }; },
  } as unknown as AssignmentPorts;
  const tasks = [task("a", "done", "Merge the approved queue adapter", { updatedAt: "2026-09-14T11:00:00.000Z" }), task("b", "done", "Compact board stages")];
  const view = mount(tasks, { assignments });
  cardEl(view.host, "a")!.focus();
  key(cardEl(view.host, "a"), "h");
  expect(columnOf(view.host, "a")).toBeNull();
  expect(receiptTexts(view.host)).toContain("Hidden «Merge the approved queue adapter»");
  expect(view.host.querySelector("[data-hidden-pill]")?.getAttribute("data-count")).toBe("1");
  expect(document.activeElement).toBe(cardEl(view.host, "b"));
  await tick();
  expect(view.server.patches).toEqual([{ id: "a", body: { hide: true, expectedProject: "fixture", expectedRevision: REV(1) } }]);

  click(receiptAction(view.host, "Hidden «Merge the approved queue adapter»"));
  expect(columnOf(view.host, "a")).toBe("done");
  await tick();
  expect(view.server.patches.map((patch) => (patch.body as { hide: boolean }).hide)).toEqual([true, false]);
  expect(receiptTexts(view.host)).toContain("«Merge the approved queue adapter» is back on the board");
  expect(calls).toEqual([]);
});

test("the group holding the seat has a lock instead of ×, H explains, and a stored hide cannot keep it off the board", async () => {
  const seat: SeatRefs = { conversationIds: ["conversation_fixture_1"], paths: [] };
  const view = mount([
    task("a", "assigned", "Keep the project moving", { assignments: [assignment(1)], groupHidden: { at: "2026-09-14T09:00:00.000Z", by: "agent", admitted: [] } }),
    task("b", "assigned", "Repair old links"),
  ], { seat });
  const card = cardEl(view.host, "a")!;
  expect(columnOf(view.host, "a")).toBe("assigned");
  expect(card.querySelector("[data-lock]")).toBeTruthy();
  expect(card.querySelector("[data-hide]")).toBeNull();
  expect(card.querySelector("[data-resurfaced=seat] .msg")?.textContent).toBe("Back on the board: it holds the orchestrator's conversation");
  expect(card.querySelector("[data-resurfaced=seat] button")).toBeNull();
  card.focus();
  key(card, "H");
  expect(receiptTexts(view.host)).toContain("«Keep the project moving» holds the orchestrator's conversation, so it stays on the board");
  click(card.querySelector("[data-menu]"));
  const hide = menuItem(view.host, "Hide from board");
  expect(hide?.getAttribute("aria-disabled")).toBe("true");
  expect(hide?.querySelector(".why")?.textContent).toBe("Holds the orchestrator's conversation, so it stays on the board");
  await tick();
  expect(view.server.patches).toHaveLength(0);
});

test("learning the seat on its first read shows its hidden group without announcing a return; a later designation announces it", async () => {
  const seat: SeatRefs = { conversationIds: ["conversation_fixture_1"], paths: [] };
  const hidden = { groupHidden: { at: "2026-09-14T09:00:00.000Z", by: "agent" as const, admitted: ["/fixture/conversation-1.jsonl", "conversation_fixture_1", "/fixture/conversation-2.jsonl", "conversation_fixture_2"] } };
  const tasks = [task("a", "assigned", "Keep the project moving", { assignments: [assignment(1)], ...hidden }), task("b", "assigned", "Repair old links", { assignments: [assignment(2)], ...hidden })];
  const view = mount(tasks, { seat: null });
  expect(columnOf(view.host, "a")).toBeNull();
  view.render(undefined, seat);
  await tick();
  expect(columnOf(view.host, "a")).toBe("assigned");
  expect(receiptTexts(view.host)).toEqual([]);
  /* The seat moves to b's conversation while the board is open. */
  view.render(undefined, { conversationIds: ["conversation_fixture_2"], paths: [] });
  await tick();
  expect(columnOf(view.host, "b")).toBe("assigned");
  expect(columnOf(view.host, "a")).toBeNull();
  expect(receiptTexts(view.host)).toEqual(["«Repair old links» is back on the board: it holds the orchestrator's conversation"]);
});

test("a hide the server refuses for the seat returns the card with the reason, and withdraws its Undo", async () => {
  const view = mount([task("a", "assigned", "Keep the project moving")]);
  view.server.answers.push({ ok: false, status: 409, code: "TASK_HIDE_PROTECTED", error: "holds the seat" });
  click(cardEl(view.host, "a")?.querySelector("[data-hide]"));
  expect(columnOf(view.host, "a")).toBeNull();
  await tick();
  await tick();
  expect(columnOf(view.host, "a")).toBe("assigned");
  expect(receiptTexts(view.host)).toEqual(["«Keep the project moving» holds the orchestrator's conversation, so it stays on the board"]);
});

test("Hide finished tasks keeps working and seat groups, writes one task at a time, reports each refusal, and one Undo brings the rest back", async () => {
  const seat: SeatRefs = { conversationIds: ["conversation_fixture_9"], paths: [] };
  const working = { ...conversation(2), activity: "live", proc: "running", pid: 4_401, mtime: NOW - 30 } as unknown as FileEntry;
  const tasks = [
    task("a", "done", "Merge the approved queue adapter"),
    task("b", "done", "Compact board stages"),
    task("c", "done", "Universal interrupt"),
    task("w", "done", "Finish responsive attachments", { assignments: [assignment(2)] }),
    task("s", "done", "Seat group", { assignments: [assignment(9)] }),
  ];
  const answers: Array<(result: PatchResult) => void> = [];
  const patches: Array<{ id: string; body: PatchBody }> = [];
  const ports: TaskMutationPorts = {
    patch: (id, body) => {
      patches.push({ id, body });
      return new Promise((resolve) => answers.push(resolve));
    },
    read: async () => null,
    changed: () => {},
  };
  const view = mount(tasks, { ports, seat, files: [working], manual: [working] });
  expect(cardEl(view.host, "w")?.querySelector(".activity .working")?.textContent).toBe("1 working");
  click(view.host.querySelector('[data-colmenu="done"]'));
  const item = menuItem(view.host, "Hide finished tasks (3)");
  expect(item?.querySelector(".why")?.textContent).toBe("Keeps 1 task whose agent is still working.");
  click(item);
  expect(["a", "b", "c"].map((id) => columnOf(view.host, id))).toEqual([null, null, null]);
  expect(columnOf(view.host, "w")).toBe("done");
  expect(columnOf(view.host, "s")).toBe("done");
  const text = "Hidden 3 finished tasks · kept 1 with a working agent";
  expect(receiptTexts(view.host)).toContain(text);
  await tick();
  expect(patches.map((patch) => patch.id)).toHaveLength(1);
  const first = patches[0]!.id;
  answers[0]!({ ok: false, status: 409, code: "TASK_HIDE_PROTECTED", error: "holds the seat" });
  await tick();
  expect(patches).toHaveLength(2);
  answers[1]!({ ok: true, task: task(patches[1]!.id, "done", "x", { revision: REV(2), groupHidden: { at: "2026-09-14T12:00:00.000Z", by: "operator" } }) });
  await tick();
  expect(patches).toHaveLength(3);
  answers[2]!({ ok: true, task: task(patches[2]!.id, "done", "x", { revision: REV(2), groupHidden: { at: "2026-09-14T12:00:00.000Z", by: "operator" } }) });
  await tick();
  expect(columnOf(view.host, first)).toBe("done");
  expect(receiptTexts(view.host).some((text) => text?.endsWith("holds the orchestrator's conversation, so it stays on the board"))).toBe(true);

  click(receiptAction(view.host, text));
  await tick();
  expect(patches.slice(3).map((patch) => [patch.id, (patch.body as { hide: boolean }).hide])).toEqual([[patches[1]!.id, false]]);
  /* The server keeps the first group hidden: it gets its own receipt with
     Retry, the next unhide still goes out, and the count leaves it out. */
  answers[3]!({ ok: false, status: 500, error: "disk full" });
  await tick();
  expect(patches.slice(4).map((patch) => [patch.id, (patch.body as { hide: boolean }).hide])).toEqual([[patches[2]!.id, false]]);
  answers[4]!({ ok: true, task: task(patches[2]!.id, "done", "x", { revision: REV(3) }) });
  await tick();
  await tick();
  const titles: Record<string, string> = { a: "Merge the approved queue adapter", b: "Compact board stages", c: "Universal interrupt" };
  const refusedText = `Couldn't show «${titles[patches[1]!.id]}»: disk full`;
  expect(receiptTexts(view.host)).toContain(refusedText);
  expect(receiptAction(view.host, refusedText)?.textContent).toBe("Retry");
  expect(receiptTexts(view.host)).toContain("1 task is back on the board");
  expect(receiptTexts(view.host).some((line) => line?.startsWith("2 tasks"))).toBe(false);
  expect(columnOf(view.host, patches[1]!.id)).toBeNull();
  expect(columnOf(view.host, patches[2]!.id)).toBe("done");
});

test("colour comes from the card menu or C, shows at once, and is written on its own", async () => {
  const view = mount([task("a", "inbox", "Write the release notes")]);
  click(cardEl(view.host, "a")?.querySelector("[data-menu]"));
  const swatches = [...view.host.querySelectorAll<HTMLElement>(".menu .swatch")];
  expect(swatches.map((swatch) => swatch.getAttribute("aria-label"))).toEqual(["No colour", "Coral", "Amber", "Lime", "Teal", "Sky", "Violet", "Pink", "Slate"]);
  expect(swatches[0]!.getAttribute("aria-checked")).toBe("true");
  click(swatches.find((swatch) => swatch.dataset.swatch === "sky"));
  expect(cardEl(view.host, "a")?.getAttribute("data-color")).toBe("sky");
  await tick();
  expect(view.server.patches.map((patch) => patch.body)).toEqual([{ color: "sky", expectedProject: "fixture", expectedRevision: REV(1) }]);

  cardEl(view.host, "a")!.focus();
  key(cardEl(view.host, "a"), "c");
  expect(view.host.querySelector('.menu[aria-label="Colour"] .swatch[aria-checked="true"]')?.getAttribute("data-swatch")).toBe("sky");
  click(view.host.querySelector('.menu .swatch[data-swatch="none"]'));
  expect(cardEl(view.host, "a")?.getAttribute("data-color")).toBe("none");
  await tick();
  expect((view.server.patches[1]!.body as { color: string }).color).toBe("none");
});

test("the Hidden tray lists hidden groups, empty tasks and closed conversations, and each comes back from it", async () => {
  const closed = conversation(7);
  const restored: string[] = [];
  const view = mount([
    task("a", "done", "Merge the approved queue adapter", { assignments: [assignment(3)], groupHidden: { at: "2026-09-14T09:00:00.000Z", by: "agent", admitted: ["/fixture/conversation-3.jsonl", "conversation_fixture_3"] } }),
    task("b", "done", "An old empty task", { board: "hidden" }),
    task("c", "inbox", "Write the release notes"),
  ], { files: [closed], closed: [closed.path, "/fixture/not-on-this-board.jsonl"], onRestore: (file) => restored.push(file.path) });
  expect(view.host.querySelector("[data-hidden-pill]")?.getAttribute("data-count")).toBe("3");
  click(view.host.querySelector("[data-hidden-pill]"));
  const tray = view.host.querySelector(".popover.hidden-tray")!;
  expect([...tray.querySelectorAll(".sec-label")].map((node) => node.textContent)).toEqual(["Hidden groups", "Empty tasks off the board", "Closed conversations"]);
  expect(tray.querySelector("[data-hidden-group=a] .meta")?.textContent).toContain("Hidden by an agent");
  expect(tray.querySelector("[data-hidden-task=b] .title")?.textContent).toBe("An old empty task");
  expect(tray.querySelector(`[data-closed-conversation="${closed.path}"] .title`)?.textContent).toBe("Conversation 7");

  click(tray.querySelector("[data-hidden-group=a] .show"));
  expect(columnOf(view.host, "a")).toBe("done");
  await tick();
  expect(view.server.patches).toEqual([{ id: "a", body: { hide: false, expectedProject: "fixture", expectedRevision: REV(1) } }]);

  click(view.host.querySelector("[data-hidden-pill]"));
  click(view.host.querySelector(`.hidden-tray [data-closed-conversation="${closed.path}"] .show`));
  expect(restored).toEqual([closed.path]);
  expect(receiptTexts(view.host)).toContain("«Conversation 7» is back on the board");
});

test("a hidden group that admits a new conversation comes back with a receipt saying why, and Hide again hides it anew", async () => {
  const hidden = task("a", "assigned", "Repair old links", { assignments: [assignment(1)], groupHidden: { at: "2026-09-14T09:00:00.000Z", by: "operator", admitted: ["/fixture/conversation-1.jsonl", "conversation_fixture_1"] } });
  const view = mount([hidden]);
  expect(columnOf(view.host, "a")).toBeNull();
  const joined = { ...hidden, assignments: [assignment(1), assignment(2)], revision: REV(2) } as BoardTask;
  view.render([joined]);
  await tick();
  expect(columnOf(view.host, "a")).toBe("assigned");
  expect(receiptTexts(view.host)).toContain("«Repair old links» is back on the board: a conversation joined the task");
  const notice = cardEl(view.host, "a")?.querySelector("[data-resurfaced=admitted]");
  expect(notice?.querySelector(".msg")?.textContent).toBe("Back on the board: a conversation joined the task");
  click(notice?.querySelector("button"));
  expect(columnOf(view.host, "a")).toBeNull();
  await tick();
  expect(view.server.patches).toEqual([{ id: "a", body: { hide: true, expectedProject: "fixture", expectedRevision: REV(2) } }]);
});

/* ── Review follow-ups (#1695 K4b) ───────────────────────────────────────── */

test("pressing Use theirs or Keep mine stays inside the edit: no save, however long the press, and leaving both saves the draft", async () => {
  const view = mount([task("a", "assigned", "Repair old links"), task("b", "assigned", "Write the release notes")]);
  click(cardEl(view.host, "a")?.querySelector("[data-rename]"));
  type(editor(view.host, "a")!, "Operator title");
  view.render([task("a", "assigned", "Agent title", { revision: REV(2) }), task("b", "assigned", "Write the release notes")]);
  await tick();
  const buttons = () => [...cardEl(view.host, "a")!.querySelectorAll<HTMLElement>("[data-edit-incoming] button")];
  /* A mouse press does not take focus from the field. */
  const press = new dom.MouseEvent("mousedown", { bubbles: true, cancelable: true });
  buttons()[0]!.dispatchEvent(press as unknown as Event);
  expect(press.defaultPrevented).toBe(true);
  /* Where focus does move to a notice button (keyboard, touch), that is still the edit. */
  flushSync(() => buttons()[1]!.focus());
  await tick(20);
  expect(editor(view.host, "a")?.value).toBe("Operator title");
  click(buttons()[1]);
  await tick(20);
  expect(editor(view.host, "a")?.value).toBe("Operator title");
  expect(cardEl(view.host, "a")?.querySelector("[data-edit-incoming]")).toBeNull();
  expect(view.server.patches).toHaveLength(0);

  view.render([task("a", "assigned", "Agent title 2", { revision: REV(3) }), task("b", "assigned", "Write the release notes")]);
  await tick();
  flushSync(() => buttons()[0]!.focus());
  await tick(20);
  click(buttons()[0]);
  await tick(20);
  expect(editor(view.host, "a")?.value).toBe("Agent title 2");
  expect(view.server.patches).toHaveLength(0);

  /* Keep mine, then leave for another card: the draft is saved once. */
  type(editor(view.host, "a")!, "Operator title again");
  view.render([task("a", "assigned", "Agent title 3", { revision: REV(4) }), task("b", "assigned", "Write the release notes")]);
  await tick();
  flushSync(() => buttons()[1]!.focus());
  await tick(20);
  expect(view.server.patches).toHaveLength(0);
  flushSync(() => cardEl(view.host, "b")!.focus());
  await tick(20);
  expect(view.server.patches.map((patch) => (patch.body as { text: string }).text)).toEqual(["Operator title again"]);
});

test("a title saved while an agent rewrote only the description keeps both, is sent once more, and raises no notice", async () => {
  let stored = task("a", "assigned", "Repair old links\nOld description");
  const patches: PatchBody[] = [];
  const ports: TaskMutationPorts = {
    patch: async (_id, body) => {
      patches.push(body);
      if (patches.length === 1) {
        stored = task("a", "assigned", "Repair old links\nAgent description", { revision: REV(3) });
        return { ok: false, status: 409, code: "TASK_REVISION_MISMATCH", error: "expectedRevision is stale" };
      }
      stored = task("a", "assigned", (body as { text: string }).text, { revision: REV(4) });
      return { ok: true, task: stored };
    },
    read: async () => stored,
    changed: () => {},
  };
  const view = mount([task("a", "assigned", "Repair old links\nOld description")], { ports });
  click(cardEl(view.host, "a")?.querySelector("[data-rename]"));
  type(editor(view.host, "a")!, "Repair every old link");
  key(editor(view.host, "a"), "Enter");
  await tick();
  await tick();
  expect(patches.map((body) => (body as { text: string }).text)).toEqual(["Repair every old link\nOld description", "Repair every old link\nAgent description"]);
  expect(stored.text).toBe("Repair every old link\nAgent description");
  expect(cardEl(view.host, "a")?.querySelector("[data-edit-incoming]")).toBeNull();
  expect(editor(view.host, "a")).toBeNull();
  expect(cardEl(view.host, "a")?.querySelector(".title")?.textContent).toBe("Repair every old link");
  expect(cardEl(view.host, "a")?.querySelector(".desc")?.textContent).toBe("Agent description");
});

test("reopening a field after a refused save starts from the kept draft", async () => {
  const view = mount([task("a", "assigned", "Repair old links")]);
  view.server.answers.push({ ok: false, status: 500, error: "disk full" });
  click(cardEl(view.host, "a")?.querySelector("[data-rename]"));
  type(editor(view.host, "a")!, "Repair every old link");
  key(editor(view.host, "a"), "Enter");
  await tick();
  await tick();
  expect(cardEl(view.host, "a")?.querySelector("[data-edit-failed]")).toBeTruthy();
  click(cardEl(view.host, "a")?.querySelector("[data-rename]"));
  expect(editor(view.host, "a")?.value).toBe("Repair every old link");
  expect(cardEl(view.host, "a")?.querySelector("[data-edit-failed]")).toBeNull();
  key(editor(view.host, "a"), "Enter");
  await tick();
  expect(view.server.patches.map((patch) => (patch.body as { text: string }).text)).toEqual(["Repair every old link", "Repair every old link"]);
});

test("after hide and Undo, a poll that left before the Undo keeps the card on the board and focused", async () => {
  const original = task("a", "done", "Merge the approved queue adapter");
  const view = mount([original, task("b", "done", "Compact board stages")]);
  click(cardEl(view.host, "a")?.querySelector("[data-hide]"));
  await tick();
  const hiddenRow = view.server.patches.length === 1 ? { ...original, revision: REV(11), groupHidden: { at: "2026-09-14T12:00:00.000Z", by: "operator" as const, admitted: [] } } : null;
  expect(hiddenRow).toBeTruthy();
  click(receiptAction(view.host, "Hidden «Merge the approved queue adapter»"));
  await tick();
  expect(view.server.patches.map((patch) => (patch.body as { hide: boolean }).hide)).toEqual([true, false]);
  expect(document.activeElement).toBe(cardEl(view.host, "a"));
  /* The poll carrying the hide's own revision arrives after the Undo landed. */
  view.render([hiddenRow as BoardTask, task("b", "done", "Compact board stages")]);
  await tick();
  expect(columnOf(view.host, "a")).toBe("done");
  expect(document.activeElement).toBe(cardEl(view.host, "a"));
});

test("an Undo the server refuses takes back its success receipt and offers Retry", async () => {
  const view = mount([task("a", "done", "Merge the approved queue adapter")]);
  click(cardEl(view.host, "a")?.querySelector("[data-hide]"));
  await tick();
  view.server.answers.push({ ok: false, status: 500, error: "disk full" });
  click(receiptAction(view.host, "Hidden «Merge the approved queue adapter»"));
  expect(columnOf(view.host, "a")).toBe("done");
  await tick();
  await tick();
  expect(columnOf(view.host, "a")).toBeNull();
  expect(receiptTexts(view.host)).not.toContain("«Merge the approved queue adapter» is back on the board");
  expect(receiptAction(view.host, "Couldn't show «Merge the approved queue adapter»: disk full")?.textContent).toBe("Retry");
});
