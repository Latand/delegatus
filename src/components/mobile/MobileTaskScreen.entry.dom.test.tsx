import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";
import { applyBoardMutations, type BoardMutationV1 } from "@/lib/board/mutations";
import type { BoardProjectStateV1 } from "@/lib/view/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

/*
 * Every phone door into a task opens the task screen (#2072 slice 5,
 * docs/design/phone-kanban.md §3.5, §3.7), mounted through the real dashboard:
 *
 *   - a card in the columns, and a card pinned because its pipeline waits on
 *     the operator;
 *   - the ⋯ › Tasks list, which is still there after ‹ from the task;
 *   - a pipeline screen's linked tasks;
 *   - a task link a conversation carries (`llv:mcp-navigate`).
 *
 * And from the task screen: a pipeline block's head opens the pipeline
 * screen, a stage pill its conversation, an agent row its conversation full
 * screen, and ‹ from each lands back on the task. No door opens the old task
 * editor (its status chips, raw assignment rows, send-to checklist).
 */

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualConversationCatalogHooks = await import("@/hooks/useConversationCatalog");
const inertRuntime = { enabled: false, connection: "live" as const, resyncedAt: null, store: emptyStore(), structuredHostsEnabled: false, lastEventAt: null };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => inertRuntime,
  useRuntime: () => inertRuntime,
  useRuntimeSelector: (selector: (state: typeof inertRuntime) => unknown) => selector(inertRuntime),
  useRuntimeSession: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));
mock.module("@/hooks/useConversationCatalog", () => ({
  useConversationCatalog: () => ({
    items: [], nextCursor: null, total: 0, loading: false, error: false, loadMore: () => {}, retry: () => {},
  }),
}));

const { ProjectDashboard } = await import("@/components/ProjectDashboard");
const { MobileSheet } = await import("@/components/mobile/MobileSheet");
const { getMobileNav, topScreen } = await import("@/components/mobile/mobileNav");
const { receipts } = await import("@/components/mobile/MobileReceipt");
type MobileShellHost = NonNullable<React.ComponentProps<typeof ProjectDashboard>["mobileShell"]>;

const dom = new Window({ url: "http://localhost/", width: 390, height: 844 });
const G = globalThis as Record<string, unknown>;
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: /max-width|pointer: coarse/.test(String(query)),
  media: String(query), onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
});
const jsonResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
/* The board route, answered through the product's own reducer, so a write the
   dashboard sends lands and is not sent again. */
const emptyBoard = (): BoardProjectStateV1 => ({
  schemaVersion: 1, revision: 1, updatedAt: new Date(0).toISOString(), pathAliases: {}, explicitManual: [],
  prefs: { manual: [], hidden: [], expanded: [], favorites: [], foldedEngineChildIds: [], expandedEngineTrayParentIds: [], viewMode: null, taskPanelOpen: false },
} as unknown as BoardProjectStateV1);
let storedBoard = emptyBoard();
const OVERRIDES: Record<string, unknown> = {
  window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement, Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent, sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/board") && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as { mutations?: BoardMutationV1[] };
      const reduced = applyBoardMutations(storedBoard, body.mutations ?? []);
      storedBoard = { ...reduced, schemaVersion: 1, revision: storedBoard.revision + 1, pathAliases: reduced.pathAliases ?? {} } as BoardProjectStateV1;
      return jsonResponse({ ok: true, applied: true, board: storedBoard });
    }
    if (url.startsWith("/api/board")) return jsonResponse({ board: storedBoard });
    if (url.startsWith("/api/conversations")) return jsonResponse({ items: [], nextCursor: null });
    if (url.startsWith("/api/limits")) return { ok: false, status: 503, json: async () => ({}), text: async () => "" };
    return jsonResponse({});
  }) as unknown as typeof fetch,
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };
const waitFor = async (pred: () => boolean, timeoutMs = 4000): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return pred();
};

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
  (dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
});
afterAll(async () => {
  await settle();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useConversationCatalog", () => actualConversationCatalogHooks);
});

const PROJECT = "phone-task-screen";
const NOW = Math.floor(Date.now() / 1000);
const iso = (ago: number) => new Date((NOW - ago) * 1000).toISOString();

function conversation(name: string, title: string, over: Record<string, unknown> = {}): FileEntry {
  return {
    path: `/repo/${name}.jsonl`, root: "claude-projects", name: `${name}.jsonl`, project: PROJECT, title,
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: NOW - 600, size: 4_096,
    activity: "recent", proc: null, pid: null, model: "claude-opus-5-5", conversationId: `conversation_${name}`,
    pendingQuestion: null, waitingInput: null, lastAgentWorkAt: (NOW - 600) * 1000, ...over,
  } as unknown as FileEntry;
}

const stageFile = conversation("stage-implement", "Stop repeated full-board downloads · implement", { mtime: NOW - 2_460, lastAgentWorkAt: (NOW - 2_460) * 1000 });
const agentFile = conversation("agent-profile", "Profile the board payload");
const otherFile = conversation("agent-systemd", "Retire the systemd install path");

const role = { roleId: "builder", access: "read-write", promptScaffold: null };
const parked = {
  id: "lane-parked", task: "Stop repeated full-board downloads", taskIds: ["t-data"], project: PROJECT,
  repoDir: "/repo", worktreeDir: "/repo-lane", branch: "lane/parked", baseBranch: "main", baseRef: "main", lastPassedCommit: "",
  state: "needs_decision", pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null, createdAt: iso(7_200), closedAt: null,
  cursor: { stageId: "implement", state: "needs_decision", input: null, activatedBy: null },
  stages: [
    { id: "implement", kind: "run", effectiveRole: role, next: "review" },
    { id: "review", kind: "run", effectiveRole: { ...role, roleId: "reviewer" }, next: null },
  ],
  runs: [{ stageId: "implement", attempts: [{
    n: 1, state: "needs_decision", startedAt: iso(2_760), completedAt: iso(2_460), agentPath: stageFile.path, conversationId: stageFile.conversationId,
    activatedBy: null, effectiveRole: role, verdict: { status: "fail", findings: ["The delta chain is rebuilt on the request thread."] },
  }] }],
} as unknown as Pipeline;

const task = (id: string, status: string, text: string, paths: string[] = []) => ({
  id, project: PROJECT, status, text, placement: "unplaced", revision: `r-${id}-1`,
  assignments: paths.map((path) => ({ path, conversationId: `conversation_${path.split("/").pop()!.replace(".jsonl", "")}`, panePid: null, state: "delivered", error: null, at: iso(3_600) })),
  createdAt: iso(86_400), updatedAt: iso(3_600),
}) as unknown as BoardTask;

const tasks = [
  task("t-data", "assigned", "Mobile data: stop repeated full-board downloads and hidden-tab traffic", [agentFile.path]),
  task("t-systemd", "inbox", "Retire the systemd install path", [otherFile.path]),
];

const host: MobileShellHost = {
  attentionCount: 1,
  arrival: null,
  renderSheet: (name, close) => (
    <MobileSheet name={name} title={name} onClose={close}>
      <div data-testid={`${name}-sheet-stub`} />
    </MobileSheet>
  ),
};

let roots: Root[] = [];
beforeEach(() => {
  roots = [];
  storedBoard = emptyBoard();
  dom.document.body.replaceChildren();
  dom.sessionStorage.clear();
  dom.localStorage.clear();
  dom.location.hash = "#p=" + encodeURIComponent(PROJECT);
  getMobileNav().home();
  receipts.dismiss();
});
afterEach(async () => {
  /* Back to the board through the history, so no test leaves entries above it. */
  const nav = getMobileNav();
  for (let i = 0; i < 6 && nav.getState().stack.length > 1; i += 1) {
    nav.back();
    await waitFor(() => false, 30);
  }
  for (const root of roots) flushSync(() => root.unmount());
  roots = [];
  receipts.dismiss();
  await settle();
});

function mount(): HTMLElement {
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  flushSync(() => root.render(
    <ProjectDashboard
      files={[stageFile, agentFile, otherFile]} flows={[]} pipelines={[parked]} workflows={[]} tasks={tasks}
      project={PROJECT} loaded openNonce={0} archived={false} catalogKnown catalogConversationCount={3}
      projectCwd="/repo" onArchive={() => {}} onUnarchive={() => {}} mobileShell={host}
    />,
  ));
  roots.push(root);
  return container as unknown as HTMLElement;
}

const q = (root: HTMLElement, selector: string) => root.querySelector(selector) as unknown as HTMLElement | null;
const click = (el: HTMLElement | null) => { expect(el).not.toBeNull(); flushSync(() => el!.click()); };
const onTask = (root: HTMLElement, id: string) => q(root, `[data-mobile2-task="${id}"] [data-phone-task-body="${id}"]`) !== null;
const top = () => topScreen(getMobileNav().getState());
const noOldEditor = (root: HTMLElement) => {
  /* The old editor's pieces: status chips, raw assignment rows, send-to checkboxes. */
  expect(q(root, "[data-task-sheet-retry]")).toBeNull();
  expect(q(root, 'input[type="checkbox"]')).toBeNull();
  expect(root.textContent ?? "").not.toContain(".jsonl");
};
async function board(): Promise<HTMLElement> {
  const root = mount();
  expect(await waitFor(() => q(root, '[data-phone-card="task:t-data"]') !== null)).toBe(true);
  return root;
}
async function back(root: HTMLElement): Promise<void> {
  click(q(root, "[data-mobile2-back]"));
  await settle();
}

test("a column card opens the task screen, and a card pinned by its pipeline's decision does too; ‹ returns to the board", async () => {
  const root = await board();
  /* The decision pins t-data first in Assigned, with the warning edge. */
  const pinned = q(root, '[data-phone-card="task:t-data"]')!;
  expect(pinned.getAttribute("data-needs")).toBe("1");
  click(pinned);
  expect(await waitFor(() => onTask(root, "t-data"))).toBe(true);
  expect(top()).toEqual({ kind: "task", id: "t-data" });
  noOldEditor(root);
  expect(q(root, '[data-phone-task-lane="lane-parked"]')).not.toBeNull();
  await back(root);
  expect(await waitFor(() => q(root, "[data-phone-kanban]") !== null)).toBe(true);

  click(q(root, "[data-phone-kanban-tab=inbox]"));
  click(q(root, '[data-phone-card="task:t-systemd"]'));
  expect(await waitFor(() => onTask(root, "t-systemd"))).toBe(true);
  noOldEditor(root);
});

test("the ⋯ › Tasks list opens the task screen, and ‹ from the task finds the list again", async () => {
  const root = await board();
  click(q(root, '[data-mobile2-open="menu"]'));
  await settle();
  click(q(root, '[data-mobile2-menu-row="tasks"]'));
  expect(await waitFor(() => q(root, '[data-task-sheet-row="t-systemd"]') !== null)).toBe(true);
  click(q(root, '[data-task-sheet-row="t-systemd"]'));
  expect(await waitFor(() => onTask(root, "t-systemd"))).toBe(true);
  /* The list does not stand over the task it opened. */
  expect(q(root, "[data-task-sheet-row]")).toBeNull();
  noOldEditor(root);
  await back(root);
  expect(await waitFor(() => q(root, '[data-task-sheet-row="t-systemd"]') !== null)).toBe(true);
});

test("a pipeline screen's linked task opens the task screen", async () => {
  const root = await board();
  click(q(root, '[data-mobile2-open="menu"]'));
  await settle();
  click(q(root, '[data-mobile2-menu-row="pipelines"]'));
  expect(await waitFor(() => q(root, '[data-mobile2-pipeline-row="lane-parked"]') !== null)).toBe(true);
  click(q(root, '[data-mobile2-pipeline-row="lane-parked"]'));
  expect(await waitFor(() => q(root, '[data-mobile2-linked-task="t-data"]') !== null)).toBe(true);
  click(q(root, '[data-mobile2-linked-task="t-data"]'));
  expect(await waitFor(() => onTask(root, "t-data"))).toBe(true);
  expect(getMobileNav().getState().stack.map((screen) => screen.kind)).toEqual(["board", "pipelines", "pipeline", "task"]);
});

test("a task link a conversation carries opens the task screen", async () => {
  const root = await board();
  flushSync(() => { dom.dispatchEvent(new dom.CustomEvent("llv:mcp-navigate", { detail: { kind: "task", id: "t-systemd" } })); });
  expect(await waitFor(() => onTask(root, "t-systemd"))).toBe(true);
  noOldEditor(root);
});

test("from the task: the block's head opens the pipeline screen, a stage pill and an agent row open their conversations full screen, and ‹ returns to the task", async () => {
  const root = await board();
  click(q(root, '[data-phone-card="task:t-data"]'));
  expect(await waitFor(() => onTask(root, "t-data"))).toBe(true);

  /* The block's head: the pipeline screen, which does not list this task again. */
  click(q(root, '[data-phone-task-lane="lane-parked"] [data-open-stages="lane-parked"]'));
  expect(await waitFor(() => q(root, '[data-mobile2-pipeline="lane-parked"]') !== null)).toBe(true);
  expect(q(root, '[data-mobile2-linked-task="t-data"]')).toBeNull();
  await back(root);
  expect(await waitFor(() => onTask(root, "t-data"))).toBe(true);

  /* A stage pill: that stage's conversation. */
  click(q(root, '[data-phone-task-lane="lane-parked"] button.pb-pill[data-stage="implement"]'));
  expect(await waitFor(() => top().kind === "chat")).toBe(true);
  expect(top()).toEqual({ kind: "chat", id: stageFile.path });
  expect(q(root, "[data-phone-task-body]")).toBeNull();
  await back(root);
  expect(await waitFor(() => onTask(root, "t-data"))).toBe(true);

  /* An agent row: its conversation. */
  const agents = q(root, "[data-phone-task-agents]")!;
  expect(agents.getAttribute("data-phone-task-agents")).toBe("2");
  click(q(root, `[data-phone-task-agent="${agentFile.path}"] [data-mobile2-row="conversation"]`));
  expect(await waitFor(() => top().kind === "chat")).toBe(true);
  expect(top()).toEqual({ kind: "chat", id: agentFile.path });
  await back(root);
  expect(await waitFor(() => onTask(root, "t-data"))).toBe(true);
  expect(getMobileNav().getState().stack.map((screen) => screen.kind)).toEqual(["board", "task"]);
});

test("a conversation's task strip opens the task screen above the conversation, and ‹ returns to it", async () => {
  const root = await board();
  /* The agent's conversation, opened from its task's screen. */
  click(q(root, '[data-phone-card="task:t-data"]'));
  expect(await waitFor(() => onTask(root, "t-data"))).toBe(true);
  click(q(root, `[data-phone-task-agent="${agentFile.path}"] [data-mobile2-row="conversation"]`));
  expect(await waitFor(() => q(root, '[data-task-relation="t-data"]') !== null)).toBe(true);
  click(q(root, '[data-task-relation="t-data"]'));
  expect(await waitFor(() => top().kind === "task")).toBe(true);
  expect(getMobileNav().getState().stack.map((screen) => screen.kind)).toEqual(["board", "task", "chat", "task"]);
  expect(await waitFor(() => onTask(root, "t-data"))).toBe(true);
  noOldEditor(root);
  await back(root);
  expect(await waitFor(() => top().kind === "chat")).toBe(true);
  /* The whole stack, not only its top: the task is still under the conversation. */
  expect(getMobileNav().getState().stack).toEqual([{ kind: "board" }, { kind: "task", id: "t-data" }, { kind: "chat", id: agentFile.path }]);
  await back(root);
  expect(await waitFor(() => onTask(root, "t-data"))).toBe(true);
  expect(getMobileNav().getState().stack.map((screen) => screen.kind)).toEqual(["board", "task"]);
});

/* Last in the file: the reset below leaves history entries above the board,
   as a real deep link would, and no later test may inherit them. */
test("the Tasks list goes with a navigation that sends the stack home, and does not come back over the board", async () => {
  const root = await board();
  click(q(root, '[data-mobile2-open="menu"]'));
  await settle();
  click(q(root, '[data-mobile2-menu-row="tasks"]'));
  expect(await waitFor(() => q(root, '[data-task-sheet-row="t-systemd"]') !== null)).toBe(true);
  click(q(root, '[data-task-sheet-row="t-systemd"]'));
  expect(await waitFor(() => onTask(root, "t-systemd"))).toBe(true);
  /* A search result or a deep link: the Viewer sends the phone home and pushes the conversation. */
  flushSync(() => {
    getMobileNav().home();
    getMobileNav().push({ kind: "chat", id: agentFile.path });
  });
  await settle();
  expect(top()).toEqual({ kind: "chat", id: agentFile.path });
  /* Back on the board, where the list was opened: it stays gone. */
  flushSync(() => getMobileNav().home());
  expect(await waitFor(() => q(root, "[data-phone-kanban]") !== null)).toBe(true);
  await settle();
  expect(q(root, "[data-task-sheet-row]")).toBeNull();
});
