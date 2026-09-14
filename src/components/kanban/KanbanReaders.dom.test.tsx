import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import type { AssignmentPorts } from "./kanbanAssignments";
import type { TaskMutationPorts } from "./useTaskMutations";

/* Conversations open inside kanban cards (#1695 K3), rendered by React with
   the real conversation pane over invented transcripts. Fetches answer from a
   stub, storage is the test window's, and no route or state directory is
   touched. */

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  PointerEvent: dom.PointerEvent ?? dom.MouseEvent,
  File: dom.File,
  FileReader: dom.FileReader,
  IntersectionObserver: undefined,
  ResizeObserver: TestResizeObserver,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});
/* Every read the pane makes answers "nothing here": each transcript is empty,
   except the paths a test marks as failing to read. */
const failingReads = new Set<string>();
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  let body: unknown = {};
  if (url.startsWith("/api/logs")) {
    const { reqs } = JSON.parse(String(init?.body ?? "{}")) as { reqs: Array<{ id: string; path: string }> };
    body = { chunks: Object.fromEntries(reqs.map((req) => [req.id, failingReads.has(req.path) ? { error: "transcript read failed" } : { data: "", start: 0, offset: 0, size: 0 }])) };
  }
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

/* React reads the DOM it runs in when it loads, so it loads after the window
   above exists; fields then change through React's own input events. */
const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { focusHandoffBus } = await import("@/components/attention/focusHandoffBus");
const { KanbanBoard } = await import("./KanbanBoard");
const { READER_STORAGE_PREFIX } = await import("./readerMemory");

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
});

const NOW = 1_800_000_000;
const REV = (n: number) => ["task-v1:00000000", "0000", "4000", "8000", String(n).padStart(12, "0")].join("-");

function conversation(index: number, extra: Partial<FileEntry> = {}): FileEntry {
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
    model: "claude-opus",
    effort: "high",
    pendingQuestion: null,
    waitingInput: null,
    name: `conversation-${index}`,
    ...extra,
  } as FileEntry;
}

function task(id: string, status: TaskStatus, text: string, files: readonly FileEntry[] = []): BoardTask {
  return {
    id,
    project: "fixture",
    text,
    status,
    placement: "unplaced",
    assignments: files.map((file) => ({ path: file.path, conversationId: file.conversationId, panePid: null, state: "handoff", error: null, at: "2026-09-14T10:00:00.000Z" })),
    createdAt: "2026-09-14T10:00:00.000Z",
    updatedAt: "2026-09-14T10:00:00.000Z",
    revision: REV(1),
  } as BoardTask;
}

const idlePorts: TaskMutationPorts = { patch: async () => ({ ok: false, status: 500, error: "unused" }), read: async () => null, changed: () => {} };
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(options: { tasks: BoardTask[]; files: FileEntry[]; assignments?: AssignmentPorts; focus?: string | null; readerStorage?: Pick<Storage, "getItem" | "setItem"> }) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const render = (next: { tasks?: BoardTask[]; focus?: string | null } = {}) => flushSync(() => root.render(
    <KanbanBoard
      project="fixture"
      groups={[]}
      manual={options.files}
      files={options.files}
      flows={[]}
      pipelines={[]}
      tasks={[]}
      allTasks={next.tasks ?? options.tasks}
      drafts={[]}
      now={NOW}
      loaded
      catalogFailures={0}
      selection={new Set()}
      focus={next.focus ?? options.focus ?? null}
      onOpenCatalog={() => {}}
      onOpenOnBoard={() => {}}
      mutationPorts={idlePorts}
      {...(options.assignments ? { assignmentPorts: options.assignments } : {})}
      {...(options.readerStorage ? { readerStorage: options.readerStorage } : {})}
    />,
  ));
  render();
  return { host, render, unmount: () => flushSync(() => root.unmount()) };
}

const click = (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  flushSync(() => (element as HTMLElement).click());
};
/* Attribute selectors over a tree holding a whole conversation pane are slow
   in happy-dom, so cards are read by walking them. */
const cardIds = (host: HTMLElement) => [...host.querySelectorAll(".card")].map((card) => card.getAttribute("data-id"));
const cardEl = (host: HTMLElement, id: string) => [...host.querySelectorAll<HTMLElement>(".card")].find((card) => card.getAttribute("data-id") === id) ?? null;
const columnOf = (host: HTMLElement, element: Element | null) => element?.closest<HTMLElement>(".column")?.dataset.status ?? null;
const readerIn = (host: HTMLElement) => host.querySelector<HTMLElement>(".card [data-kanban-reader]");
const composerIn = (reader: HTMLElement | null) => reader?.querySelector<HTMLTextAreaElement>("textarea") ?? null;
const remembered = () => JSON.parse(localStorage.getItem(`${READER_STORAGE_PREFIX}fixture`) ?? "[]") as Array<{ key: string; folded: boolean }>;

test("a tile opens its conversation as a reader in the card, in the prototype's anatomy, and this device remembers it", async () => {
  const file = conversation(1);
  const tasks = [task("a", "assigned", "Repair old links", [file])];
  const first = mount({ tasks, files: [file] });
  click(cardEl(first.host, "task:a")?.querySelector(".tile"));
  const reader = readerIn(first.host);
  expect(reader).toBeTruthy();
  expect(reader?.closest(".card")?.getAttribute("data-id")).toBe("task:a");
  expect(reader?.querySelector(".conv-head .ch-title")?.textContent).toBe("Conversation 1");
  expect(reader?.querySelector(".ch-meta .ch-engine")?.textContent).toBe("Claude");
  expect(reader?.querySelector(".ch-meta .ch-model")?.textContent).toBe("claude-opus · high");
  expect(reader?.querySelector("[data-reader-close]")).toBeTruthy();
  expect(cardEl(first.host, "task:a")?.querySelector(".tile")).toBeNull();
  expect(remembered()).toEqual([{ key: "conversation_fixture_1", path: file.path, folded: false } as never]);
  first.unmount();

  const again = mount({ tasks, files: [file] });
  await tick();
  expect(readerIn(again.host)?.closest(".card")?.getAttribute("data-id")).toBe("task:a");
});

test("a draft, its caret and its focus survive the card moving to another column and re-ranking", async () => {
  const file = conversation(1);
  const other = conversation(2);
  const tasks = [task("a", "assigned", "Repair old links", [file]), task("b", "blocked", "Passkey sign-in", [other])];
  const view = mount({ tasks, files: [file, other] });
  click(view.host.querySelector(".tile"));
  await tick();
  const reader = readerIn(view.host);
  const field = composerIn(reader);
  expect(field).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(field, "Keep the old index live until the new one answers");
    field!.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
  field!.focus();
  field!.setSelectionRange(9, 12);
  expect(document.activeElement).toBe(field);

  /* The task moves to Blocked on a poll: the card is a new element in another
     column, and the reader inside it is the same one. */
  view.render({ tasks: [task("a", "blocked", "Repair old links", [file]), task("b", "blocked", "Passkey sign-in", [other])] });
  await tick();
  const moved = readerIn(view.host);
  expect(columnOf(view.host, moved)).toBe("blocked");
  expect(moved).toBe(reader);
  expect(composerIn(moved)).toBe(field);
  expect(field!.value).toBe("Keep the old index live until the new one answers");
  expect(document.activeElement).toBe(field);
  expect([field!.selectionStart, field!.selectionEnd]).toEqual([9, 12]);
});

test("folding keeps the conversation mounted; closing it gives the card its tile back", async () => {
  const file = conversation(1);
  const view = mount({ tasks: [task("a", "inbox", "Write the release notes", [file])], files: [file] });
  click(view.host.querySelector(".tile"));
  await tick();
  const reader = readerIn(view.host)!;
  const field = composerIn(reader);
  click(reader.querySelector("[data-reader-fold]"));
  expect(reader.getAttribute("data-folded")).toBe("1");
  expect(reader.querySelector(".rlatest")?.textContent).toBe("No messages yet");
  expect(composerIn(reader)).toBe(field);
  expect(remembered()[0]?.folded).toBe(true);
  click(reader.querySelector("[data-reader-close]"));
  expect(readerIn(view.host)).toBeNull();
  expect(view.host.querySelector(".tile")?.getAttribute("data-member")).toBe(file.path);
  expect(remembered()).toEqual([]);
});

test("a search that hides the card parks its reader, and the same reader comes back with the card", async () => {
  const file = conversation(1);
  const view = mount({ tasks: [task("a", "inbox", "Write the release notes", [file]), task("b", "inbox", "Repair old links")], files: [file] });
  click(view.host.querySelector(".tile"));
  await tick();
  const reader = readerIn(view.host)!;
  const input = view.host.querySelector<HTMLInputElement>("[data-kanban-search]")!;
  const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!;
  const search = (value: string) => flushSync(() => {
    setter.call(input, value);
    input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
  input.focus();
  search("links");
  expect(cardIds(view.host)).toEqual(["task:b"]);
  expect(reader.isConnected).toBe(true);
  expect(reader.closest(".reader-park")).toBeTruthy();
  search("");
  expect(readerIn(view.host)).toBe(reader);
});

test("Unlink removes the assignment by its strongest handle and says nothing stopped; the conversation's only task is refused in plain words", async () => {
  const file = conversation(1);
  const calls: unknown[] = [];
  let answer: Awaited<ReturnType<AssignmentPorts["unlink"]>> = { ok: true, task: null };
  const ports: AssignmentPorts = {
    link: async () => ({ ok: true, task: null }),
    unlink: async (taskId, ref) => { calls.push({ taskId, ref }); return answer; },
  };
  const view = mount({ tasks: [task("a", "assigned", "Repair old links", [file])], files: [file], assignments: ports });
  click(view.host.querySelector(".tile"));
  await tick();
  const unlink = () => {
    click(readerIn(view.host)!.querySelector("[data-reader-menu]"));
    const item = [...view.host.querySelectorAll('.menu [role="menuitem"]')].find((node) => node.textContent?.startsWith("Unlink from this task"));
    expect(item?.textContent).toContain("Nothing stops. With no other task it gets an untitled task of its own");
    click(item);
  };
  unlink();
  await tick();
  expect(calls).toEqual([{ taskId: "a", ref: { conversationId: "conversation_fixture_1" } }]);
  expect([...view.host.querySelectorAll("[data-kanban-receipt] .msg")].map((node) => node.textContent)).toContain("Unlinked «Conversation 1» from «Repair old links». Nothing stopped.");

  answer = { ok: false, status: 409, error: "this task is the conversation's own membership" };
  unlink();
  await tick();
  expect([...view.host.querySelectorAll("[data-kanban-receipt].error .msg")].map((node) => node.textContent))
    .toContain("«Repair old links» is the only task «Conversation 1» has. Link it to another task first.");
});

test("Link to another task lists the project's other tasks and records the link without sending anything", async () => {
  const file = conversation(1);
  const calls: unknown[] = [];
  const ports: AssignmentPorts = {
    link: async (taskId, path) => { calls.push({ taskId, path }); return { ok: true, task: null }; },
    unlink: async () => ({ ok: true, task: null }),
  };
  const view = mount({
    tasks: [task("a", "assigned", "Repair old links", [file]), task("b", "inbox", "Write the release notes"), task("c", "done", "Merge the queue adapter")],
    files: [file],
    assignments: ports,
  });
  click(view.host.querySelector(".tile"));
  await tick();
  click(readerIn(view.host)!.querySelector("[data-reader-menu]"));
  click([...view.host.querySelectorAll('.menu [role="menuitem"]')].find((node) => node.textContent?.startsWith("Link to another task")));
  await tick();
  const picker = view.host.querySelector(".popover.link-picker");
  expect(picker?.textContent).toContain("Nothing is sent to the agent. If the task has no open pipeline, a draft pipeline that has not started is created for it.");
  expect([...view.host.querySelectorAll("[data-link-task]")].map((node) => node.getAttribute("data-link-task")).sort()).toEqual(["b", "c"]);
  click([...view.host.querySelectorAll("[data-link-task]")].find((row) => row.getAttribute("data-link-task") === "b"));
  await tick();
  expect(calls).toEqual([{ taskId: "b", path: file.path }]);
  expect([...view.host.querySelectorAll("[data-kanban-receipt] .msg")].map((node) => node.textContent)).toContain("Linked «Conversation 1» to «Write the release notes». Nothing was sent.");
});

test("an open handoff opens the reader through the board's controller, arrives only once it is on screen and settled, and Return closes it", async () => {
  /* A transcript no earlier test has read, so its first read is still out. */
  const file = conversation(7);
  const view = mount({ tasks: [task("a", "blocked", "Show the account limit", [file])], files: [file] });
  const board = focusHandoffBus.board();
  expect(board?.project).toBe("fixture");
  expect(board?.index.rectFor(file.path)).not.toBeNull();
  const destination = { rect: board!.index.rectFor(file.path)!, zoom: "inspect" as const, anchorKeys: [file.path], intent: "open" as const, path: file.path };

  /* Nothing is on screen before the move. */
  expect(board!.arrival!(destination)).toBeNull();
  flushSync(() => { expect(board!.moveTo(destination)).toBe(true); });
  await tick();
  const reader = readerIn(view.host);
  expect(reader).toBeTruthy();
  /* While the transcript is still being read, nothing has arrived. */
  expect(reader?.querySelector("[data-feed-state]")?.getAttribute("data-feed-state")).toBe("loading");
  for (let waited = 0; waited < 4000 && reader?.querySelector("[data-feed-state]")?.getAttribute("data-feed-state") !== "empty"; waited += 50) await tick(50);

  /* happy-dom lays nothing out: every box is empty, so the reader is not seen. */
  expect(focusHandoffBus.board()!.arrival!(destination)).toBeNull();

  /* Laid out on screen, the empty transcript's settled feed is an arrival. */
  const onScreen = { top: 100, bottom: 700, left: 0, right: 600, width: 600, height: 600, x: 0, y: 100, toJSON() {} };
  const original = dom.HTMLElement.prototype.getBoundingClientRect;
  const prototype = dom.HTMLElement.prototype as unknown as { getBoundingClientRect: (this: HTMLElement) => unknown };
  prototype.getBoundingClientRect = function () { return onScreen; };
  try {
    expect(reader?.querySelector("[data-feed-state]")?.getAttribute("data-feed-state")).toBe("empty");
    expect(focusHandoffBus.board()!.arrival!(destination)).toBe("reader");
    /* The same reader scrolled out of its column's box is not. */
    prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.classList.contains("col-body")) return { ...onScreen, top: 100, bottom: 400, height: 300 };
      if (this.hasAttribute("data-kanban-reader")) return { ...onScreen, top: 420, bottom: 900, height: 480 };
      return onScreen;
    };
    expect(focusHandoffBus.board()!.arrival!(destination)).toBe("visible");
  } finally {
    prototype.getBoundingClientRect = original as never;
  }

  /* Another request's Return is not this one's. */
  flushSync(() => focusHandoffBus.board()!.returnFromHandoff!("attention_other"));
  expect(readerIn(view.host)).toBeTruthy();
  flushSync(() => focusHandoffBus.board()!.returnFromHandoff!());
  expect(readerIn(view.host)).toBeNull();
});

const openDestination = (file: FileEntry, requestId: string) => {
  const board = focusHandoffBus.board()!;
  return { rect: board.index.rectFor(file.path)!, zoom: "inspect" as const, anchorKeys: [file.path], intent: "open" as const, path: file.path, requestId };
};
const readerByKey = (host: HTMLElement, key: string) => [...host.querySelectorAll<HTMLElement>("[data-kanban-reader]")].find((reader) => reader.dataset.kanbanReader === key) ?? null;

test("Return undoes only what its own request opened: an operator's folded reader is folded again, and B's Return leaves A's reader open", async () => {
  const mine = conversation(11);
  const a = conversation(12);
  const b = conversation(13);
  const view = mount({ tasks: [task("t", "assigned", "Three conversations", [mine, a, b])], files: [mine, a, b] });

  /* The operator opened and folded this one; a handoff unfolds it. */
  click([...view.host.querySelectorAll<HTMLElement>(".tile")].find((tile) => tile.dataset.member === mine.path));
  click(readerByKey(view.host, "conversation_fixture_11")!.querySelector("[data-reader-fold]"));
  flushSync(() => { focusHandoffBus.board()!.moveTo(openDestination(mine, "attention_unfold")); });
  expect(readerByKey(view.host, "conversation_fixture_11")?.dataset.folded).toBe("0");
  flushSync(() => focusHandoffBus.board()!.returnFromHandoff!("attention_unfold"));
  expect(readerByKey(view.host, "conversation_fixture_11")?.dataset.folded).toBe("1");
  expect(remembered().find((reader) => reader.key === "conversation_fixture_11")?.folded).toBe(true);

  /* Handoff A ends without a Return; B's Return closes B's reader alone. */
  flushSync(() => { focusHandoffBus.board()!.moveTo(openDestination(a, "attention_a")); });
  flushSync(() => { focusHandoffBus.board()!.moveTo(openDestination(b, "attention_b")); });
  expect(readerByKey(view.host, "conversation_fixture_12")).toBeTruthy();
  expect(readerByKey(view.host, "conversation_fixture_13")).toBeTruthy();
  flushSync(() => focusHandoffBus.board()!.returnFromHandoff!("attention_b"));
  expect(readerByKey(view.host, "conversation_fixture_13")).toBeNull();
  expect(readerByKey(view.host, "conversation_fixture_12")).toBeTruthy();
  expect(readerByKey(view.host, "conversation_fixture_11")).toBeTruthy();

  /* Once the operator touches A's reader it is theirs: A's Return leaves it. */
  click(readerByKey(view.host, "conversation_fixture_12")!.querySelector("[data-reader-fold]"));
  flushSync(() => focusHandoffBus.board()!.returnFromHandoff!("attention_a"));
  expect(readerByKey(view.host, "conversation_fixture_12")?.dataset.folded).toBe("1");
});

test("a transcript that failed to read settles as an error, never as an arrival", async () => {
  const file = conversation(14);
  failingReads.add(file.path);
  try {
    const view = mount({ tasks: [task("a", "inbox", "Unreadable", [file])], files: [file] });
    flushSync(() => { focusHandoffBus.board()!.moveTo(openDestination(file, "attention_error")); });
    const reader = readerByKey(view.host, "conversation_fixture_14")!;
    for (let waited = 0; waited < 4000 && reader.querySelector("[data-feed-state]")?.getAttribute("data-feed-state") !== "error"; waited += 50) await tick(50);
    expect(reader.querySelector("[data-feed-state]")?.getAttribute("data-feed-state")).toBe("error");
    expect(reader.textContent).toContain("Couldn't read this conversation");
    const prototype = dom.HTMLElement.prototype as unknown as { getBoundingClientRect: (this: HTMLElement) => unknown };
    const original = prototype.getBoundingClientRect;
    prototype.getBoundingClientRect = function () { return { top: 100, bottom: 700, left: 0, right: 600, width: 600, height: 600, x: 0, y: 100 }; };
    try {
      /* On screen and expanded, but its feed never settled: the card is seen, the conversation is not. */
      expect(focusHandoffBus.board()!.arrival!(openDestination(file, "attention_error"))).toBe("visible");
    } finally {
      prototype.getBoundingClientRect = original;
    }
  } finally {
    failingReads.delete(file.path);
  }
});

test("seventy open readers all stay mounted and remembered; a refused write keeps them open and says so", async () => {
  const files = Array.from({ length: 70 }, (_, index) => conversation(100 + index));
  const seeded = new Map<string, string>([[`${READER_STORAGE_PREFIX}fixture`, JSON.stringify(files.map((file) => ({ key: file.conversationId, path: file.path, folded: true })))]]);
  const storage = { getItem: (key: string) => seeded.get(key) ?? null, setItem: (key: string, value: string) => void seeded.set(key, value) };
  const view = mount({ tasks: [task("many", "assigned", "Seventy conversations", files)], files, readerStorage: storage });
  await tick();
  expect(view.host.querySelectorAll("[data-kanban-reader]")).toHaveLength(70);
  click([...view.host.querySelectorAll<HTMLElement>("[data-reader-fold]")][0]);
  expect((JSON.parse(seeded.get(`${READER_STORAGE_PREFIX}fixture`)!) as unknown[]).length).toBe(70);
  view.unmount();

  const refusing = { getItem: () => null, setItem: () => { throw new Error("quota exceeded"); } };
  const second = mount({ tasks: [task("a", "assigned", "One conversation", [files[0]!])], files: [files[0]!], readerStorage: refusing });
  click(second.host.querySelector(".tile"));
  await tick();
  expect(readerIn(second.host)).toBeTruthy();
  expect([...second.host.querySelectorAll("[data-kanban-receipt].error .msg")].map((node) => node.textContent))
    .toContain("This browser refused to store the open conversation, so it won't reopen after a reload. It stays open on this page.");
});

test("the reader header keeps its title: no PID or Stop host in it, and the full-window control stays", async () => {
  const file = conversation(15, { proc: "running", pid: 4401, activity: "live" });
  const view = mount({ tasks: [task("a", "assigned", "Running", [file])], files: [file] });
  click(view.host.querySelector(".tile"));
  const reader = readerIn(view.host)!;
  const head = reader.querySelector(".conv-head")!;
  expect(head.textContent).not.toContain("PID");
  expect(head.textContent).not.toContain("Stop host");
  expect(head.querySelector("[data-reader-full-toggle]")).toBeTruthy();
  click(head.querySelector("[data-reader-menu]"));
  const items = [...view.host.querySelectorAll('.menu [role="menuitem"]')].map((node) => node.textContent ?? "");
  expect(items.some((text) => text.startsWith("Open as a full pane"))).toBe(true);
  /* Without a host this surface can stop, the menu offers none; the rendered
     browser evidence opens the item on a live host. */
  expect(items.some((text) => text.startsWith("Stop host"))).toBe(false);
});

test("a conversation the Viewer is asked to open while the kanban shows opens as its card's reader", async () => {
  const file = conversation(1);
  const tasks = [task("a", "done", "Merge the queue adapter", [file])];
  const view = mount({ tasks, files: [file] });
  expect(readerIn(view.host)).toBeNull();
  view.render({ focus: file.path });
  await tick();
  expect(readerIn(view.host)?.closest(".card")?.getAttribute("data-id")).toBe("task:a");
});
