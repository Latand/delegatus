import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import type { TaskMutationPorts } from "./useTaskMutations";

/* The agent window's list of open agents and the header's pill
   (docs/design/agent-window.md), rendered by React over the real board with
   invented conversations. Fetches answer from a stub, storage is the test
   window's, and no route or state directory is touched. */

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
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  let body: unknown = {};
  if (url.startsWith("/api/logs")) {
    const { reqs } = JSON.parse(String(init?.body ?? "{}")) as { reqs: Array<{ id: string; path: string }> };
    body = { chunks: Object.fromEntries(reqs.map((req) => [req.id, { data: "", start: 0, offset: 0, size: 0 }])) };
  }
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

/* happy-dom lays nothing out, so the board's root is given the width a
   desktop window gives it. Every element brought into view is recorded: the
   board under the window never moves. */
let boardWidth = 1672;
const rect = dom.HTMLElement.prototype.getBoundingClientRect;
dom.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
  if (this.classList.contains("kb")) return { x: 0, y: 0, left: 0, top: 0, right: boardWidth, bottom: 900, width: boardWidth, height: 900, toJSON() {} } as DOMRect;
  return rect.call(this);
} as typeof rect;
const scrolledTo: HTMLElement[] = [];
dom.HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
  scrolledTo.push(this);
} as typeof dom.HTMLElement.prototype.scrollIntoView;

const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { KanbanBoard } = await import("./KanbanBoard");
const { READER_STORAGE_PREFIX } = await import("./readerMemory");
const { cycleOpenAgent } = await import("./openAgents");
const { setLocale } = await import("@/lib/i18n");

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();
  localStorage.clear();
  scrolledTo.length = 0;
  boardWidth = 1672;
  setLocale("en");
});

const NOW = 1_800_000_000;
const REV = (n: number) => ["task-v1:00000000", "0000", "4000", "8000", String(n).padStart(12, "0")].join("-");
const iso = (secondsAgo: number) => new Date((NOW - secondsAgo) * 1000).toISOString();

function conversation(name: string, title: string, extra: Partial<FileEntry> = {}): FileEntry {
  return {
    path: `/fixture/${name}.jsonl`, conversationId: `conversation_${name}`, title, project: "fixture", root: "claude-projects", kind: "session", fmt: "claude",
    engine: "claude", mtime: NOW - 600, size: 0, activity: "idle", proc: null, pid: null, parent: null, model: "opus", effort: "high", pendingQuestion: null, waitingInput: null, name,
    ...extra,
  } as FileEntry;
}
const working = { activity: "live", proc: "running", pid: 4_401, mtime: NOW - 20, authoritativeTurn: { state: "busy", source: "lifecycle", terminalAt: null }, lastTurn: { startedAt: (NOW - 400) * 1_000, endedAt: null } } as unknown as Partial<FileEntry>;

const role = (roleId: string) => ({ roleId, engine: "claude", model: "opus", effort: "high", access: "read-write", promptScaffold: null });
const stage = (id: string, roleId: string, next: string | null) => ({ id, kind: roleId === "reviewer" ? "review-loop" : "run", role: { roleId }, prompt: `Stage ${id}.`, next, onFail: null, effectiveRole: role(roleId) });
const attempt = (n: number, state: string, file: FileEntry, startedAgo: number) => ({
  n, state, effectiveRole: role("builder"), launchId: null, conversationId: file.conversationId, sessionId: null, agentPath: file.path, paneId: null, flowId: null,
  startedAt: iso(startedAgo), completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null,
});

const implement = conversation("implement-1", "Keep the old index serving");
const review = conversation("review-1", "Review the warm-up gate");
const verify1 = conversation("verify-1", "Results empty after the swap");
const verify2 = conversation("verify-2", "Re-running the rebuild with traffic", working);
const plain = conversation("plain-1", "Explorer: list every export toggle and the preset each one belongs to");

function searchPipeline(): Pipeline {
  return {
    id: "p-search", task: "Restore search results", taskIds: ["t-search"], project: "fixture", state: "running",
    stages: [stage("implement", "builder", "review"), stage("review", "reviewer", "verify"), stage("verify", "verifier", null)],
    runs: [
      { stageId: "implement", attempts: [attempt(1, "passed", implement, 7200)] },
      { stageId: "review", attempts: [attempt(1, "passed", review, 3600)] },
      { stageId: "verify", attempts: [attempt(1, "failed", verify1, 5000), attempt(2, "running", verify2, 1200)] },
    ],
    cursor: { stageId: "verify", state: "running", input: null, activatedBy: null },
    worktreeDir: "/fixture/worktree", createdAt: iso(9000),
  } as unknown as Pipeline;
}

function task(id: string, status: TaskStatus, text: string, files: readonly FileEntry[] = []): BoardTask {
  return {
    id, project: "fixture", text, status, placement: "unplaced",
    assignments: files.map((file) => ({ path: file.path, conversationId: file.conversationId, panePid: null, state: "handoff", error: null, at: iso(9000) })),
    createdAt: iso(9000), updatedAt: iso(600), revision: REV(1),
  } as BoardTask;
}

const idlePorts: TaskMutationPorts = { patch: async () => ({ ok: false, status: 500, error: "unused" }), read: async () => null, changed: () => {} };
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

const TASKS = [task("t-search", "assigned", "Restore search results after the index rebuild"), task("t-export", "inbox", "Simplify the export settings", [plain])];

function seed(readers: ReadonlyArray<FileEntry | [FileEntry, "folded"]>) {
  localStorage.setItem(`${READER_STORAGE_PREFIX}fixture`, JSON.stringify(readers.map((entry) => {
    const [file, folded] = Array.isArray(entry) ? entry : [entry, null];
    return { key: file.conversationId, path: file.path, folded: folded === "folded" };
  })));
}

function mount(options: { files?: FileEntry[]; drafts?: string[]; onDraftClose?: (id: string) => void } = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const render = (files: FileEntry[] = options.files ?? [implement, review, verify1, verify2, plain]) => flushSync(() => root.render(
    <KanbanBoard
      project="fixture"
      seatRefs={null}
      groups={[]}
      manual={files}
      files={files}
      flows={[]}
      pipelines={[searchPipeline()]}
      tasks={[]}
      allTasks={TASKS}
      drafts={options.drafts ?? []}
      onDraftClose={options.onDraftClose}
      now={NOW}
      loaded
      catalogFailures={0}
      selection={new Set()}
      onOpenConversations={() => {}}
      mutationPorts={idlePorts}
    />,
  ));
  render();
  return { host, render };
}

const click = (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  flushSync(() => (element as HTMLElement).click());
};
const agentWindow = (host: HTMLElement) => host.querySelector<HTMLElement>("[data-agent-window]");
const pill = (host: HTMLElement) => host.querySelector<HTMLElement>("[data-open-agents-pill]");
const segments = (scope: ParentNode) => [...scope.querySelectorAll<HTMLElement>("[data-open-agent]")];
const segmentKeys = (scope: ParentNode) => segments(scope).map((segment) => segment.dataset.openAgent);
const readerOf = (host: HTMLElement, key: string) => [...host.querySelectorAll<HTMLElement>("[data-kanban-reader]")].find((reader) => reader.dataset.kanbanReader === key) ?? null;
const jump = (scope: ParentNode, key: string) => segments(scope).find((segment) => segment.dataset.openAgent === key)?.querySelector<HTMLElement>("[data-open-agent-jump]");
/* By identity: Bun's toBe passes two distinct happy-dom elements. */
const isFocused = (element: Element | null) => element !== null && document.activeElement === element;
const remembered = () => (JSON.parse(localStorage.getItem(`${READER_STORAGE_PREFIX}fixture`) ?? "[]") as Array<{ key: string; folded: boolean }>).map((reader) => reader.key);
const altKey = (code: "KeyJ" | "KeyK", target: EventTarget = document) => flushSync(() => {
  target.dispatchEvent(new dom.KeyboardEvent("keydown", { key: code === "KeyJ" ? "j" : "k", code, altKey: true, bubbles: true, cancelable: true }) as unknown as Event);
});
/* The agent the window's reader shows, once its first read settled. */
const shown = (host: HTMLElement) => agentWindow(host)?.querySelector<HTMLElement>(".reader-slot:not([data-incoming]) [data-kanban-reader]")?.dataset.kanbanReader ?? null;
async function showing(host: HTMLElement, key: string) {
  for (let waited = 0; waited < 3000 && shown(host) !== key; waited += 10) await tick(10);
  expect(shown(host)).toBe(key);
  return readerOf(host, key)!;
}

test("the window lists exactly the open agents, in the order they were opened, each with its reader's own role, emblem and a name that is never an id", async () => {
  seed([verify2, review, plain]);
  const { host } = mount();
  await tick();
  /* Open since the last visit, behind the header's pill, which stands right after the working count. */
  expect(agentWindow(host)).toBeNull();
  expect(pill(host)?.querySelector(".pill-words")?.textContent).toBe("3 agents");
  expect(pill(host)?.closest("[data-open-agents-slot]")?.previousElementSibling?.getAttribute("data-bar-group")).toBe("status");
  click(pill(host));
  await showing(host, "conversation_verify-2");
  const list = agentWindow(host)!.querySelector<HTMLElement>(".aw-list")!;
  expect(segmentKeys(list)).toEqual(["conversation_verify-2", "conversation_review-1", "conversation_plain-1"]);
  expect(list.querySelector("[data-open-agents-count]")?.textContent).toBe("3 agents open");
  for (const segment of segments(list)) {
    const reader = readerOf(host, segment.dataset.openAgent!);
    expect(reader).toBeTruthy();
    /* One source: the row wears the role the reader's ribbon wears, and the same emblem. */
    expect(segment.dataset.role).toBe(reader!.dataset.role!);
    expect(segment.querySelector(".or-emblem svg")?.getAttribute("class")).toBe(reader!.querySelector(".role-mark-emblem svg")?.getAttribute("class") ?? "");
    expect(segment.textContent).not.toContain("conversation_");
    expect(segment.textContent).not.toContain("/fixture/");
    /* Every row closes its agent with a × of its own. */
    expect(segment.querySelector("[data-open-agent-close]")).toBeTruthy();
  }
  expect(segments(list).map((segment) => segment.dataset.role)).toEqual(["verifier", "reviewer", "neutral"]);
  expect(segments(list).map((segment) => segment.querySelector(".or-name")?.textContent)).toEqual([
    "Verify · 2",
    "Review",
    "Explorer: list every export toggle and the preset each one belongs to",
  ]);
  expect(segments(list).map((segment) => segment.querySelector(".or-card")?.textContent ?? null)).toEqual([
    "Restore search results after the index rebuild",
    "Restore search results after the index rebuild",
    "Simplify the export settings",
  ]);
  /* The reader header's dot: the running verify is live, the others idle. */
  expect(segments(list).map((segment) => segment.querySelector("[data-open-agent-dot]")?.getAttribute("data-open-agent-dot"))).toEqual(["live", "idle", "idle"]);
  expect(jump(list, "conversation_verify-2")?.getAttribute("aria-label")).toBe("Go to Verify · 2 · Restore search results after the index rebuild: Verifier, working");
  expect(jump(list, "conversation_verify-2")?.getAttribute("aria-current")).toBe("true");
  /* The list is the window's left column; the window is a dialog over the board, never in it. */
  expect(agentWindow(host)?.querySelector("[role='dialog']")?.firstElementChild).toBe(list);
  expect(agentWindow(host)?.closest(".board, .card, .column, .board-frame")).toBeNull();
  expect(pill(host)?.getAttribute("aria-expanded")).toBe("true");
});

test("no pill while nothing is open, its slot stands all the same, and uk strings when the Viewer speaks Ukrainian", async () => {
  const empty = mount();
  await tick();
  expect(pill(empty.host)).toBeNull();
  expect(empty.host.querySelector("[data-open-agents-slot]")).toBeTruthy();
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();

  setLocale("uk");
  seed([verify2, review, plain]);
  const { host } = mount();
  await tick();
  expect(pill(host)?.querySelector(".pill-words")?.textContent).toBe("3 агенти");
  expect(pill(host)?.getAttribute("aria-label")).toBe("Показати 3 відкритих агентів");
  click(pill(host));
  await showing(host, "conversation_verify-2");
  expect(host.querySelector("[data-open-agents-count]")?.textContent).toBe("3 агенти відкриті");
  expect(host.querySelector(".aw-list")?.getAttribute("aria-label")).toBe("3 відкриті агенти");
  expect(host.querySelector("[data-open-rail-close-all]")?.textContent).toBe("Закрити всі");
  expect(host.querySelector('[data-agent-window-step="next"]')?.getAttribute("aria-label")).toBe("Наступний агент (Alt+J)");
  expect(readerOf(host, "conversation_verify-2")?.querySelector("[data-reader-close]")?.getAttribute("aria-label")).toBe("Закрити вікно (Esc) — агенти лишаються відкритими");
  expect(jump(host, "conversation_review-1")?.getAttribute("aria-label")).toStartWith("Перейти до ");
});

test("an agent draft stays in its card and is not an open agent until it launches", async () => {
  seed([plain]);
  const { host } = mount({ drafts: ["draft-one"] });
  await tick();
  expect(pill(host)?.querySelector(".pill-words")?.textContent).toBe("1 agent");
  click(pill(host));
  await showing(host, "conversation_plain-1");
  expect(segmentKeys(host)).toEqual(["conversation_plain-1"]);
});

test("a row brings its agent into the same reader and focuses it; the board under the window does not move", async () => {
  seed([verify2, plain]);
  const { host } = mount();
  await tick();
  click(pill(host));
  await showing(host, "conversation_verify-2");
  const frame = host.querySelector("[data-agent-window-frame]");
  scrolledTo.length = 0;
  click(jump(host, "conversation_plain-1"));
  const reader = await showing(host, "conversation_plain-1");
  expect(host.querySelector("[data-agent-window-frame]")).toBe(frame);
  expect(isFocused(reader)).toBe(true);
  expect(jump(host, "conversation_plain-1")?.getAttribute("aria-current")).toBe("true");
  expect(jump(host, "conversation_verify-2")?.getAttribute("aria-current")).toBeNull();
  /* The one it replaced waits in the park, mounted. */
  expect(readerOf(host, "conversation_verify-2")?.closest(".reader-park")).toBeTruthy();
  expect(scrolledTo.filter((element) => !element.closest("[data-agent-window]"))).toEqual([]);
});

test("opening an agent never widens a column or scrolls the board: the cards keep their geometry", async () => {
  const wide = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('.column[data-wide="1"]')].map((node) => node.dataset.status);
  const { host } = mount();
  await tick();
  const tracks = host.querySelector<HTMLElement>("[data-board]")?.getAttribute("style");
  expect(wide(host)).toEqual(["assigned"]);
  scrolledTo.length = 0;
  /* The export agent's card sits in Inbox, a narrow shelf. */
  const exportCard = [...host.querySelectorAll<HTMLElement>(".card")].find((card) => card.getAttribute("data-id") === "task:t-export")!;
  click(exportCard.querySelector(".tile"));
  await showing(host, "conversation_plain-1");
  expect(wide(host)).toEqual(["assigned"]);
  expect(host.querySelector<HTMLElement>("[data-board]")?.getAttribute("style")).toBe(tracks);
  expect(exportCard.classList.contains("has-reader")).toBe(false);
  expect(exportCard.querySelector("[data-kanban-reader], .reader-slot, .readers")).toBeNull();
  expect(scrolledTo).toEqual([]);
  expect(localStorage.getItem("llv:kanban-wide:v1")).toBeNull();
});

test("opening, closing and finishing update the list live; the corner × closes the window, a row's × one agent, «Close all» every one", async () => {
  const { host } = mount();
  await tick();
  expect(pill(host)).toBeNull();
  /* Opened from the card's own tile. */
  const exportCard = [...host.querySelectorAll<HTMLElement>(".card")].find((card) => card.getAttribute("data-id") === "task:t-export")!;
  click(exportCard.querySelector(".tile"));
  await showing(host, "conversation_plain-1");
  expect(segmentKeys(host)).toEqual(["conversation_plain-1"]);
  expect(host.querySelector("[data-open-agents-count]")?.textContent).toBe("1 agent open");
  /* The window's corner closes the window; the agent stays open behind the pill, which takes the keyboard. */
  click(readerOf(host, "conversation_plain-1")?.querySelector("[data-reader-close]"));
  await tick();
  expect(agentWindow(host)).toBeNull();
  expect(pill(host)?.querySelector(".pill-words")?.textContent).toBe("1 agent");
  expect(isFocused(pill(host))).toBe(true);
  expect(remembered()).toEqual(["conversation_plain-1"]);

  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();
  seed([verify2, review, plain]);
  const second = mount();
  await tick();
  click(pill(second.host));
  await showing(second.host, "conversation_verify-2");
  const dot = () => segments(second.host).find((segment) => segment.dataset.openAgent === "conversation_verify-2")?.querySelector("[data-open-agent-dot]");
  expect(dot()?.getAttribute("data-open-agent-dot")).toBe("live");
  /* The verify agent finishes its turn: its dot goes quiet on the next files. */
  const finished = conversation("verify-2", "Re-running the rebuild with traffic", { mtime: NOW - 30, lastTurn: { startedAt: (NOW - 400) * 1_000, endedAt: (NOW - 30) * 1_000 } } as Partial<FileEntry>);
  second.render([implement, review, verify1, finished, plain]);
  await tick();
  expect(dot()?.getAttribute("data-open-agent-dot")).toBe("idle");
  expect(dot()?.className).not.toContain("live");

  /* A row's × closes that one agent, and focus stays in the list. */
  click(segments(second.host).find((segment) => segment.dataset.openAgent === "conversation_review-1")?.querySelector("[data-open-agent-close]"));
  await tick();
  expect(segmentKeys(second.host)).toEqual(["conversation_verify-2", "conversation_plain-1"]);
  expect(readerOf(second.host, "conversation_review-1")).toBeNull();
  expect(remembered()).toEqual(["conversation_verify-2", "conversation_plain-1"]);
  expect(document.activeElement?.getAttribute("data-open-agent-jump")).toBe("conversation_plain-1");
  expect(shown(second.host)).toBe("conversation_verify-2");

  click(second.host.querySelector("[data-open-rail-close-all]"));
  await tick();
  expect(agentWindow(second.host)).toBeNull();
  expect(pill(second.host)).toBeNull();
  expect(second.host.querySelector("[data-kanban-reader]")).toBeNull();
  expect(remembered()).toEqual([]);
  /* The cards stay: closing an agent never removes its card. */
  expect([...second.host.querySelectorAll(".card")].map((card) => card.getAttribute("data-id"))).toEqual(expect.arrayContaining(["task:t-search", "task:t-export"]));
});

test("Alt+J and Alt+K cycle through the open agents, from inside a composer too, round the ends; with the window closed Alt+J opens it", async () => {
  seed([verify2, review, plain]);
  const { host } = mount();
  await tick();
  altKey("KeyJ");
  await showing(host, "conversation_verify-2");
  altKey("KeyJ");
  await showing(host, "conversation_review-1");
  altKey("KeyK");
  await showing(host, "conversation_verify-2");
  altKey("KeyK");
  await showing(host, "conversation_plain-1");
  altKey("KeyJ");
  const verify = await showing(host, "conversation_verify-2");
  expect(isFocused(verify)).toBe(true);

  /* From the composer of the agent the operator is typing in, to the next one. */
  altKey("KeyJ");
  const review1 = await showing(host, "conversation_review-1");
  const composer = review1.querySelector<HTMLTextAreaElement>("textarea");
  expect(composer).toBeTruthy();
  composer!.focus();
  altKey("KeyJ", composer!);
  await showing(host, "conversation_plain-1");
  expect(composer!.value).toBe("");
});

test("the cycle wraps round the ends", () => {
  expect(cycleOpenAgent([], null, 1)).toBeNull();
  expect(cycleOpenAgent(["a", "b", "c"], null, 1)).toBe("a");
  expect(cycleOpenAgent(["a", "b", "c"], null, -1)).toBe("c");
  expect(cycleOpenAgent(["a", "b", "c"], "c", 1)).toBe("a");
  expect(cycleOpenAgent(["a", "b", "c"], "a", -1)).toBe("c");
  expect(cycleOpenAgent(["a", "b", "c"], "gone", 1)).toBe("a");
});
