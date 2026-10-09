import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import type { AssignmentPorts } from "./kanbanAssignments";
import type { TaskMutationPorts } from "./useTaskMutations";

/* Conversations opened on the board (#1695 K3), in the agent window
   (docs/design/agent-window.md), rendered by React with the real conversation
   pane over invented transcripts. Fetches answer from a stub, storage is the
   test window's, and no route or state directory is touched. */

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
    ...(status === "done" ? { doneAt: new Date(NOW * 1_000).toISOString() } : {}),
    revision: REV(1),
  } as BoardTask;
}

const idlePorts: TaskMutationPorts = { patch: async () => ({ ok: false, status: 500, error: "unused" }), read: async () => null, changed: () => {} };
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(options: { tasks: BoardTask[]; files: FileEntry[]; assignments?: AssignmentPorts; focus?: string | null; readerStorage?: Pick<Storage, "getItem" | "setItem">; pipelines?: Pipeline[]; onSpawnRetry?: (file: FileEntry) => void; onCloseConversation?: (file: FileEntry) => void }) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const closedPaths: string[] = [];
  const render = (next: { tasks?: BoardTask[]; focus?: string | null } = {}) => flushSync(() => root.render(
    <KanbanBoard
      project="fixture"
      /* No seat in play here, and known to be none: the board reads none itself. */
      seatRefs={null}
      groups={[]}
      manual={options.files}
      files={options.files}
      flows={[]}
      pipelines={options.pipelines ?? []}
      tasks={[]}
      allTasks={next.tasks ?? options.tasks}
      drafts={[]}
      now={NOW}
      loaded
      catalogFailures={0}
      selection={new Set()}
      focus={next.focus ?? options.focus ?? null}
      onOpenConversations={() => {}}
      onSpawnRetry={options.onSpawnRetry}
      closedPaths={closedPaths}
      onCloseConversation={options.onCloseConversation ? (file) => {
        options.onCloseConversation!(file);
        closedPaths.push(file.path);
        render();
      } : undefined}
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
const cardEl = (host: HTMLElement, id: string) => [...host.querySelectorAll<HTMLElement>(".card")].find((card) => card.getAttribute("data-id") === id) ?? null;
/* The reader the agent window shows. */
const readerIn = (host: HTMLElement) => host.querySelector<HTMLElement>("[data-agent-window] .reader-slot:not([data-incoming]) [data-kanban-reader]");
const composerIn = (reader: HTMLElement | null) => reader?.querySelector<HTMLTextAreaElement>("textarea") ?? null;
const remembered = () => JSON.parse(localStorage.getItem(`${READER_STORAGE_PREFIX}fixture`) ?? "[]") as Array<{ key: string; folded: boolean }>;
/* The window shows an agent once its first read settled. */
async function shownIn(host: HTMLElement, key?: string): Promise<HTMLElement> {
  for (let waited = 0; waited < 3000; waited += 10) {
    const reader = readerIn(host);
    if (reader && (!key || reader.dataset.kanbanReader === key)) return reader;
    await tick(10);
  }
  throw new Error(`the agent window never showed ${key ?? "an agent"}`);
}

test("a tile opens its conversation in the agent window, in the prototype's anatomy; the card keeps its tile and this device remembers it", async () => {
  const file = conversation(1);
  const tasks = [task("a", "assigned", "Repair old links", [file])];
  const first = mount({ tasks, files: [file] });
  click(cardEl(first.host, "task:a")?.querySelector(".tile"));
  const reader = await shownIn(first.host);
  expect(reader.closest(".card")).toBeNull();
  expect(reader.querySelector(".conv-head .ch-title")?.textContent).toBe("Conversation 1");
  expect(reader.querySelector(".ch-meta .ch-engine")?.textContent).toBe("Claude");
  /* Model as text, reasoning as the shared five-step ladder beside its word (#1743). */
  expect(reader.querySelector(".ch-meta .ch-model span")?.textContent).toBe("claude-opus");
  expect(reader.querySelector(".ch-meta .ch-model [data-effort-pills]")?.getAttribute("data-effort-step")).toBe("3");
  expect(reader.querySelector(".ch-meta .ch-effort")?.textContent).toBe("high");
  /* The window's corner holds one close, and it closes the window. */
  expect(reader.querySelector("[data-reader-close]")?.getAttribute("aria-label")).toBe("Close the window (Esc) — the agents stay open");
  expect(reader.querySelector("[data-reader-fold], [data-reader-full-toggle]")).toBeNull();
  /* The card is not touched: its tile stays, marked open. */
  const tile = cardEl(first.host, "task:a")?.querySelector<HTMLElement>(".tile");
  expect(tile?.hasAttribute("data-member-open")).toBe(true);
  expect(cardEl(first.host, "task:a")?.querySelector("[data-kanban-reader], .reader-slot")).toBeNull();
  expect(remembered()).toEqual([{ key: "conversation_fixture_1", path: file.path, folded: false } as never]);
  first.unmount();

  /* After a reload the agent is still open, behind the header's pill, and the pill brings the window back. */
  const again = mount({ tasks, files: [file] });
  await tick();
  expect(readerIn(again.host)).toBeNull();
  const pill = again.host.querySelector<HTMLElement>("[data-open-agents-pill]");
  expect(pill?.querySelector(".pill-words")?.textContent).toBe("1 agent");
  click(pill);
  expect((await shownIn(again.host)).dataset.kanbanReader).toBe("conversation_fixture_1");
});

test("a draft, its caret and its focus survive a switch to another agent and back, and the card moving", async () => {
  const file = conversation(1);
  const other = conversation(2);
  const tasks = [task("a", "assigned", "Repair old links", [file]), task("b", "blocked", "Passkey sign-in", [other])];
  const view = mount({ tasks, files: [file, other] });
  click(cardEl(view.host, "task:a")?.querySelector(".tile"));
  const reader = await shownIn(view.host, "conversation_fixture_1");
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

  /* Another agent comes into the same window; the first waits in the park. */
  click(cardEl(view.host, "task:b")?.querySelector(".tile"));
  await shownIn(view.host, "conversation_fixture_2");
  expect(reader.isConnected).toBe(true);
  expect(reader.closest(".reader-park")).toBeTruthy();

  /* The task moves to Blocked on a poll; the board under the window changes, and the reader does not. */
  view.render({ tasks: [task("a", "blocked", "Repair old links", [file]), task("b", "blocked", "Passkey sign-in", [other])] });
  await tick();
  click(view.host.querySelector('[data-open-agent-jump="conversation_fixture_1"]'));
  const back = await shownIn(view.host, "conversation_fixture_1");
  expect(back).toBe(reader);
  expect(composerIn(back)).toBe(field);
  expect(field!.value).toBe("Keep the old index live until the new one answers");
  expect(document.activeElement).toBe(field);
  expect([field!.selectionStart, field!.selectionEnd]).toEqual([9, 12]);
});

test("closing the window keeps every agent open; a row's × closes that one and its neighbour takes the same reader; Close all closes all", async () => {
  const files = [conversation(1), conversation(2), conversation(3)];
  const view = mount({ tasks: [task("a", "inbox", "Write the release notes", files)], files });
  for (const file of files) click([...view.host.querySelectorAll<HTMLElement>(".tile")].find((tile) => tile.dataset.member === file.path));
  await shownIn(view.host, "conversation_fixture_3");
  const rows = () => [...view.host.querySelectorAll("[data-agent-window] [data-open-agent]")].map((row) => row.getAttribute("data-open-agent"));
  expect(rows()).toEqual(["conversation_fixture_1", "conversation_fixture_2", "conversation_fixture_3"]);
  expect(view.host.querySelector("[data-open-agents-count]")?.textContent).toBe("3 agents open");

  /* The corner × closes the window; the agents stay mounted and behind the pill. */
  click(readerIn(view.host)!.querySelector("[data-reader-close]"));
  expect(view.host.querySelector("[data-agent-window]")).toBeNull();
  expect(view.host.querySelectorAll(".reader-park [data-kanban-reader]")).toHaveLength(3);
  expect(view.host.querySelector("[data-open-agents-pill] .pill-words")?.textContent).toBe("3 agents");
  expect(remembered()).toHaveLength(3);

  /* The pill brings it back on the agent shown last. */
  click(view.host.querySelector("[data-open-agents-pill]"));
  await shownIn(view.host, "conversation_fixture_3");

  /* Closing the agent on screen brings its neighbour into the same window in the same commit. */
  click(view.host.querySelector('[data-open-agent-jump="conversation_fixture_2"]'));
  await shownIn(view.host, "conversation_fixture_2");
  const frame = view.host.querySelector("[data-agent-window-frame]");
  click(view.host.querySelector('[data-open-agent-close="conversation_fixture_2"]'));
  expect(view.host.querySelector("[data-agent-window-frame]")).toBe(frame);
  expect(readerIn(view.host)?.dataset.kanbanReader).toBe("conversation_fixture_3");
  expect(rows()).toEqual(["conversation_fixture_1", "conversation_fixture_3"]);
  /* At the end of the list, the previous one. */
  click(view.host.querySelector('[data-open-agent-close="conversation_fixture_3"]'));
  expect(readerIn(view.host)?.dataset.kanbanReader).toBe("conversation_fixture_1");
  /* One agent: nothing to step to, so no ‹ ›. */
  expect(view.host.querySelector("[data-agent-window-step]")).toBeNull();

  click(view.host.querySelector("[data-open-rail-close-all]"));
  expect(view.host.querySelector("[data-agent-window]")).toBeNull();
  expect(view.host.querySelector("[data-open-agents-pill]")).toBeNull();
  expect(view.host.querySelector("[data-open-agents-slot]")).toBeTruthy();
  expect(view.host.querySelectorAll("[data-kanban-reader]")).toHaveLength(0);
  expect(remembered()).toEqual([]);
});

test("‹ ›, Alt+J and Alt+K step round the open agents in the order they were opened; Escape closes the window and Alt+J brings it back", async () => {
  const files = [conversation(1), conversation(2), conversation(3)];
  const view = mount({ tasks: [task("a", "assigned", "Write the release notes", files)], files });
  for (const file of files) click([...view.host.querySelectorAll<HTMLElement>(".tile")].find((tile) => tile.dataset.member === file.path));
  await shownIn(view.host, "conversation_fixture_3");
  click(view.host.querySelector('[data-agent-window-step="next"]'));
  await shownIn(view.host, "conversation_fixture_1");
  click(view.host.querySelector('[data-agent-window-step="previous"]'));
  await shownIn(view.host, "conversation_fixture_3");
  const chord = (code: string) => flushSync(() => { document.dispatchEvent(new dom.KeyboardEvent("keydown", { code, key: code === "KeyJ" ? "j" : "k", altKey: true, bubbles: true }) as unknown as Event); });
  chord("KeyK");
  await shownIn(view.host, "conversation_fixture_2");
  /* Opening one that is already open shows it where it stands. */
  click([...view.host.querySelectorAll<HTMLElement>(".tile")].find((tile) => tile.dataset.member === files[0]!.path));
  await shownIn(view.host, "conversation_fixture_1");
  expect([...view.host.querySelectorAll("[data-open-agent]")].map((row) => row.getAttribute("data-open-agent"))).toEqual(["conversation_fixture_1", "conversation_fixture_2", "conversation_fixture_3"]);

  flushSync(() => { view.host.querySelector<HTMLElement>("[data-open-agent-jump]")!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event); });
  expect(view.host.querySelector("[data-agent-window]")).toBeNull();
  await tick();
  expect(document.activeElement?.hasAttribute("data-open-agents-pill")).toBe(true);
  chord("KeyJ");
  await shownIn(view.host, "conversation_fixture_1");
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
  await shownIn(view.host);
  const unlink = () => {
    click(readerIn(view.host)!.querySelector("[data-reader-menu]"));
    click(view.host.querySelector('.menu [data-cm-section="more"]'));
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
  await shownIn(view.host);
  click(readerIn(view.host)!.querySelector("[data-reader-menu]"));
  click([...view.host.querySelectorAll('.menu .cm-quick [role="menuitem"]')].find((node) => node.getAttribute("aria-label")?.startsWith("Link to another task")));
  await tick();
  const picker = view.host.querySelector(".popover.link-picker");
  expect(picker?.textContent).toContain("Nothing is sent to the agent. If the task has no open pipeline, a draft pipeline that has not started is created for it.");
  expect([...view.host.querySelectorAll("[data-link-task]")].map((node) => node.getAttribute("data-link-task")).sort()).toEqual(["b", "c"]);
  click([...view.host.querySelectorAll("[data-link-task]")].find((row) => row.getAttribute("data-link-task") === "b"));
  await tick();
  expect(calls).toEqual([{ taskId: "b", path: file.path }]);
  expect([...view.host.querySelectorAll("[data-kanban-receipt] .msg")].map((node) => node.textContent)).toContain("Linked «Conversation 1» to «Write the release notes». Nothing was sent.");
});

test("an open handoff opens the agent window through the board's controller, arrives only once it is on screen and settled, and Return closes it", async () => {
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
  /* While the transcript is still being read, the window is laid out and not drawn, and its agent reads on screen. */
  const incoming = readerByKey(view.host, "conversation_fixture_7");
  expect(incoming?.closest("[data-incoming]")).toBeTruthy();
  expect(view.host.querySelector("[data-agent-window-pending]")).toBeTruthy();
  expect(view.host.querySelector("[data-agent-window]")).toBeNull();
  expect(incoming?.querySelector("[data-feed-state]")?.getAttribute("data-feed-state")).toBe("loading");
  expect(focusHandoffBus.board()!.arrival!(destination)).toBeNull();
  const reader = await shownIn(view.host, "conversation_fixture_7");
  expect(reader.querySelector("[data-feed-state]")?.getAttribute("data-feed-state")).toBe("empty");
  /* A handoff leaves the keyboard where it was. */
  expect(reader.contains(document.activeElement)).toBe(false);

  /* happy-dom lays nothing out: every box is empty, so the reader is not seen. */
  expect(focusHandoffBus.board()!.arrival!(destination)).toBeNull();

  /* Laid out on screen, the empty transcript's settled feed is an arrival. */
  const onScreen = { top: 100, bottom: 700, left: 0, right: 600, width: 600, height: 600, x: 0, y: 100, toJSON() {} };
  const original = dom.HTMLElement.prototype.getBoundingClientRect;
  const prototype = dom.HTMLElement.prototype as unknown as { getBoundingClientRect: (this: HTMLElement) => unknown };
  prototype.getBoundingClientRect = function () { return onScreen; };
  try {
    expect(focusHandoffBus.board()!.arrival!(destination)).toBe("reader");
  } finally {
    prototype.getBoundingClientRect = original as never;
  }

  /* Another request's Return is not this one's. */
  flushSync(() => focusHandoffBus.board()!.returnFromHandoff!("attention_other"));
  expect(readerIn(view.host)).toBeTruthy();
  flushSync(() => focusHandoffBus.board()!.returnFromHandoff!());
  expect(view.host.querySelector("[data-agent-window]")).toBeNull();
  expect(readerByKey(view.host, "conversation_fixture_7")).toBeNull();
});

const openDestination = (file: FileEntry, requestId: string) => {
  const board = focusHandoffBus.board()!;
  return { rect: board.index.rectFor(file.path)!, zoom: "inspect" as const, anchorKeys: [file.path], intent: "open" as const, path: file.path, requestId };
};
const readerByKey = (host: HTMLElement, key: string) => [...host.querySelectorAll<HTMLElement>("[data-kanban-reader]")].find((reader) => reader.dataset.kanbanReader === key) ?? null;

test("Return undoes only what its own request opened: an agent the operator opened stays, and B's Return leaves A's agent open", async () => {
  const mine = conversation(11);
  const a = conversation(12);
  const b = conversation(13);
  const view = mount({ tasks: [task("t", "assigned", "Three conversations", [mine, a, b])], files: [mine, a, b] });

  /* The operator opened this one; a handoff to it leaves it theirs. */
  click([...view.host.querySelectorAll<HTMLElement>(".tile")].find((tile) => tile.dataset.member === mine.path));
  flushSync(() => { focusHandoffBus.board()!.moveTo(openDestination(mine, "attention_mine")); });
  flushSync(() => focusHandoffBus.board()!.returnFromHandoff!("attention_mine"));
  expect(readerByKey(view.host, "conversation_fixture_11")).toBeTruthy();
  expect(remembered().some((reader) => reader.key === "conversation_fixture_11")).toBe(true);

  /* Handoff A ends without a Return; B's Return closes B's agent alone. */
  flushSync(() => { focusHandoffBus.board()!.moveTo(openDestination(a, "attention_a")); });
  flushSync(() => { focusHandoffBus.board()!.moveTo(openDestination(b, "attention_b")); });
  expect(readerByKey(view.host, "conversation_fixture_12")).toBeTruthy();
  expect(readerByKey(view.host, "conversation_fixture_13")).toBeTruthy();
  flushSync(() => focusHandoffBus.board()!.returnFromHandoff!("attention_b"));
  expect(readerByKey(view.host, "conversation_fixture_13")).toBeNull();
  expect(readerByKey(view.host, "conversation_fixture_12")).toBeTruthy();
  expect(readerByKey(view.host, "conversation_fixture_11")).toBeTruthy();

  /* B's Return took the window B opened with it. Once the operator picks A in the window it is theirs: A's
     Return leaves it. */
  expect(view.host.querySelector("[data-agent-window]")).toBeNull();
  click(view.host.querySelector("[data-open-agents-pill]"));
  await shownIn(view.host);
  click(view.host.querySelector('[data-open-agent-jump="conversation_fixture_12"]'));
  flushSync(() => focusHandoffBus.board()!.returnFromHandoff!("attention_a"));
  expect(readerByKey(view.host, "conversation_fixture_12")).toBeTruthy();
});

test("a transcript that failed to read settles as an error, never as an arrival", async () => {
  const file = conversation(14);
  failingReads.add(file.path);
  try {
    const view = mount({ tasks: [task("a", "inbox", "Unreadable", [file])], files: [file] });
    flushSync(() => { focusHandoffBus.board()!.moveTo(openDestination(file, "attention_error")); });
    const reader = await shownIn(view.host, "conversation_fixture_14");
    expect(reader.querySelector("[data-feed-state]")?.getAttribute("data-feed-state")).toBe("error");
    expect(reader.textContent).toContain("Couldn't read this conversation");
    const prototype = dom.HTMLElement.prototype as unknown as { getBoundingClientRect: (this: HTMLElement) => unknown };
    const original = prototype.getBoundingClientRect;
    prototype.getBoundingClientRect = function () { return { top: 100, bottom: 700, left: 0, right: 600, width: 600, height: 600, x: 0, y: 100 }; };
    try {
      /* On screen in the window, but its feed never settled: the conversation is seen, not arrived. */
      expect(focusHandoffBus.board()!.arrival!(openDestination(file, "attention_error"))).toBe("visible");
    } finally {
      prototype.getBoundingClientRect = original;
    }
  } finally {
    failingReads.delete(file.path);
  }
});

test("seventy open agents all stay mounted and remembered; a refused write keeps them open and says so", async () => {
  const files = Array.from({ length: 70 }, (_, index) => conversation(100 + index));
  const seeded = new Map<string, string>([[`${READER_STORAGE_PREFIX}fixture`, JSON.stringify(files.map((file) => ({ key: file.conversationId, path: file.path, folded: true })))]]);
  const storage = { getItem: (key: string) => seeded.get(key) ?? null, setItem: (key: string, value: string) => void seeded.set(key, value) };
  const view = mount({ tasks: [task("many", "assigned", "Seventy conversations", files)], files, readerStorage: storage });
  await tick();
  expect(view.host.querySelectorAll("[data-kanban-reader]")).toHaveLength(70);
  expect(view.host.querySelector("[data-open-agents-pill] .pill-words")?.textContent).toBe("70 agents");
  click(view.host.querySelector("[data-open-agents-pill]"));
  await shownIn(view.host);
  expect(view.host.querySelectorAll("[data-agent-window] [data-open-agent]")).toHaveLength(70);
  expect((JSON.parse(seeded.get(`${READER_STORAGE_PREFIX}fixture`)!) as unknown[]).length).toBe(70);
  view.unmount();

  const refusing = { getItem: () => null, setItem: () => { throw new Error("quota exceeded"); } };
  const second = mount({ tasks: [task("a", "assigned", "One conversation", [files[0]!])], files: [files[0]!], readerStorage: refusing });
  click(second.host.querySelector(".tile"));
  await shownIn(second.host);
  expect([...second.host.querySelectorAll("[data-kanban-receipt].error .msg")].map((node) => node.textContent))
    .toContain("This browser refused to store the open conversation, so it won't reopen after a reload. It stays open on this page.");
});

test("the reader header keeps its title: no PID or Stop host in it, and no fold or full-pane control in the window", async () => {
  const file = conversation(15, { proc: "running", pid: 4401, activity: "live" });
  const view = mount({ tasks: [task("a", "assigned", "Running", [file])], files: [file] });
  click(view.host.querySelector(".tile"));
  const reader = await shownIn(view.host);
  const head = reader.querySelector(".conv-head")!;
  expect(head.textContent).not.toContain("PID");
  expect(head.textContent).not.toContain("Stop host");
  expect(head.querySelector("[data-reader-full-toggle], [data-reader-fold]")).toBeNull();
  click(head.querySelector("[data-reader-menu]"));
  /* The frequent actions are icon cells named by their full label; the rest is behind More. */
  expect([...view.host.querySelectorAll('.menu .cm-quick [role="menuitem"]')].some((node) => node.getAttribute("aria-label") === "Open as a full pane")).toBe(false);
  click(view.host.querySelector('.menu [data-cm-section="more"]'));
  const items = [...view.host.querySelectorAll('.menu [role="menuitem"]')].map((node) => node.textContent ?? "");
  /* Without a host this surface can stop, the menu offers none; the rendered
     browser evidence opens the item on a live host. */
  expect(items.some((text) => text.startsWith("Stop host"))).toBe(false);
});

test("a conversation the Viewer is asked to open while the kanban shows opens in the agent window", async () => {
  const file = conversation(1);
  const tasks = [task("a", "done", "Merge the queue adapter", [file])];
  const view = mount({ tasks, files: [file] });
  expect(readerIn(view.host)).toBeNull();
  view.render({ focus: file.path });
  expect((await shownIn(view.host)).dataset.kanbanReader).toBe("conversation_fixture_1");
  expect(cardEl(view.host, "task:a")?.querySelector("[data-kanban-reader]")).toBeNull();
});

function stoppedLaunch(state: Pipeline["state"], stale = false) {
  const file = conversation(70, {
    path: "spawn:launch-stopped", activityReason: "structured_spawn_failed",
    spawn: { launchId: "launch-stopped", clientAttemptId: null, accountId: null,
      state: "failed", initialMessage: "failed", retrySafe: true,
      error: "stage launch never started: runtime host recovery exhausted after 2 checks" },
    durableLineage: { kind: "spawn", role: "builder", parentConversationId: null,
      reviewsConversationId: null, memberships: [{ kind: "pipeline", containerId: "p-stopped",
        role: "builder", slot: "build", stageId: "build", stageOrder: 0, round: null, parentConversationId: null }] },
  });
  const effectiveRole = { roleId: "builder", engine: "claude", model: "opus", effort: "high", access: "read-write", promptScaffold: null };
  const pipeline = {
    id: "p-stopped", task: "Recover stopped launch", taskIds: ["stopped"], project: "fixture", state,
    stages: [{ id: "build", kind: "run", title: "Build", roleId: "builder", effectiveRole, next: null, onFail: null }],
    runs: [{ stageId: "build", attempts: [{ n: 1, effectiveRole, state: "failed", agentPath: null,
      conversationId: file.conversationId, launchId: file.spawn!.launchId, paneId: null, sessionId: null,
      startedAt: new Date(NOW * 1000).toISOString(), completedAt: new Date(NOW * 1000).toISOString() },
      ...(stale ? [{ n: 2, effectiveRole, state: "needs_decision", launchId: "launch-newer", conversationId: "conversation_newer" }] : [])] }],
    cursor: { stageId: "build", state: "needs_decision", input: null, activatedBy: null },
    worktreeDir: "/fixture/worktree", createdAt: new Date(NOW * 1000).toISOString(),
  } as unknown as Pipeline;
  return { file, pipeline };
}

test("closed never-started launch is dismissible through the task reader's normal chrome (#1972)", async () => {
  const { file, pipeline } = stoppedLaunch("closed");
  const other = conversation(71);
  const dismissed: string[] = [];
  const retried: string[] = [];
  localStorage.setItem(`${READER_STORAGE_PREFIX}fixture`, JSON.stringify([{ key: file.conversationId, path: file.path, folded: false }]));
  const view = mount({ tasks: [task("stopped", "done", "Recover stopped launch", [file, other])],
    files: [file, other], pipelines: [pipeline],
    onSpawnRetry: (entry) => retried.push(entry.path),
    onCloseConversation: (entry) => dismissed.push(entry.path) });
  await tick();
  /* Open since the last visit: behind the header's pill until the window is brought back. */
  click(view.host.querySelector("[data-open-agents-pill]"));
  const reader = await shownIn(view.host);
  expect(reader).toBeTruthy();
  expect(reader?.textContent).toContain("Launch failed");
  expect(Boolean(reader?.querySelector("[data-launch-retry]"))).toBe(false);
  expect(reader?.querySelector("textarea")).toBeNull();
  click(reader?.querySelector("[data-launch-dismiss]"));
  await tick();
  expect(dismissed).toEqual([file.path]);
  expect(retried).toEqual([]);
  expect(view.host.querySelector(`[data-reader-path="${file.path}"]`)).toBeNull();
  expect(cardEl(view.host, "task:stopped")?.textContent).toContain(other.title);
  expect(cardEl(view.host, "task:stopped")?.textContent).not.toContain("never started");
});

test.each([false, true])("a task's reader offers Retry only for its current launch (stale=%s, #1972)", async (stale) => {
  const { file, pipeline } = stoppedLaunch("needs_decision", stale);
  const retried: string[] = [];
  localStorage.setItem(`${READER_STORAGE_PREFIX}fixture`, JSON.stringify([{ key: file.conversationId, path: file.path, folded: false }]));
  const view = mount({ tasks: [task("stopped", "blocked", "Recover stopped launch", [file])],
    files: [file], pipelines: [pipeline],
    onSpawnRetry: (entry) => retried.push(entry.spawn!.launchId) });
  await tick();
  click(view.host.querySelector("[data-open-agents-pill]"));
  const retry = (await shownIn(view.host)).querySelector("[data-launch-retry]");
  if (stale) expect(Boolean(retry)).toBe(false);
  else {
    click(retry);
    expect(retried).toEqual([file.spawn!.launchId]);
  }
});
