import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, type ReactElement } from "react";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { emptyStore } from "@/components/runtime/runtimeModel";
import { setLocale, translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import type { BoardTask } from "@/lib/tasks/types";

/*
 * The conversation's pinned message and background tasks on the phone (the
 * operator's call, 2026-10-02): nothing sits under the header any more. Both
 * open from the header's `⋯` menu — a row each, shown only when there is
 * something behind it — and each opens a bottom sheet. A background task's one
 * Stop is inside its own `⋯` menu, under the task's PID.
 */

const dom = new Window({ url: "http://localhost/" });
installActEnv();
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
(dom as unknown as { matchMedia(q: string): unknown }).matchMedia = (query: string) => ({
  matches: true, media: String(query), onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
});
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
  sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
  ResizeObserver: TestResizeObserver, IntersectionObserver: undefined,
});

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const inert = { enabled: false, connection: "offline" as const, resyncedAt: null, store: emptyStore() };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ ...inert, lastEventAt: null }),
  useRuntime: () => inert,
  useRuntimeEnabled: () => false,
  useRuntimeSession: () => null,
  useRuntimeSessionByArtifact: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));
/* The output feed is the feed's own business; here it only has to be mounted. */
mock.module("../LogFeed", () => ({ LogFeed: ({ file }: { file: FileEntry }) => <div data-fake-log-feed={file.path} /> }));

const { MobileConversationMenu } = await import("./MobileConversationMenu");
const { MobileBackgroundSheet, MobilePinnedSheet } = await import("./MobileChromeSheets");

const conversation = {
  path: "/repo/atlas/agent.jsonl", root: "claude-projects", name: "agent.jsonl", project: "atlas", title: "Orchestrator",
  engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 10, size: 1, activity: "live",
  proc: "running", pid: 4242, conversationId: "conversation_chrome", model: "opus", renamable: true,
  pendingQuestion: null, waitingInput: null,
} as unknown as FileEntry;

const shellTask = (index: number): FileEntry => ({
  path: `/tmp/claude/atlas/session/tasks/bg${index}.output`, root: "claude-tasks", name: `bg${index}.output`, project: "atlas",
  title: `Background task bbto8z3y${index}`, engine: "shell", kind: "background", fmt: "text", parent: conversation.path,
  mtime: Math.floor(Date.now() / 1000) - 130, size: 10, activity: "live", proc: "running", pid: 2_145_000 + index,
  cmd: `gh run watch 1823451992${index} --exit-status`, cmdDesc: `Watch CI run ${index}`,
} as unknown as FileEntry);

const task = (id: string, text: string): BoardTask => ({
  id, project: "atlas", status: "assigned", text, placement: "unplaced", board: "shown", assignments: [], createdAt: "2026-10-02T10:00:00Z", updatedAt: "2026-10-02T10:00:00Z",
} as unknown as BoardTask);

const PINNED_TEXT = "You are this project's orchestrator in Delegatus.\nKeep every lane owned and report what changed.";

const realFetch = globalThis.fetch;
let posts: Array<{ url: string; body: Record<string, unknown> }> = [];
let roots: Root[] = [];

function mount(node: ReactElement): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as Element);
  roots.push(root);
  act(() => { root.render(node); });
  return host as unknown as HTMLElement;
}

function menu(over: { hasPinned?: boolean; backgroundCount?: number; onOpenPinned?: () => void; onOpenBackground?: () => void } = {}): HTMLElement {
  return mount(
    <MobileConversationMenu
      file={conversation}
      stage={null}
      crowned={false}
      hostTaskCount={0}
      projectName="atlas"
      hasPinned={over.hasPinned}
      backgroundCount={over.backgroundCount}
      onOpenPinned={over.onOpenPinned ?? (() => undefined)}
      onOpenBackground={over.onOpenBackground ?? (() => undefined)}
      onRename={() => undefined}
      onOpenHost={() => undefined}
      onClose={() => undefined}
    />,
  );
}

const rows = (host: HTMLElement) => ({
  pinned: host.querySelector<HTMLButtonElement>('[data-mobile2-menu-row="pinned"]'),
  background: host.querySelector<HTMLButtonElement>('[data-mobile2-menu-row="background"]'),
});
const click = async (element: Element | null) => {
  await act(async () => { (element as unknown as HTMLButtonElement).click(); await Promise.resolve(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};

beforeEach(() => {
  setLocale("en");
  posts = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    posts.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return new Response(JSON.stringify({ ok: true, pid: 2_145_001 }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots = [];
  dom.document.body.replaceChildren();
});
afterAll(() => {
  globalThis.fetch = realFetch;
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
});

test("the menu carries no pinned row and no tasks row when there is neither", () => {
  const host = menu({ hasPinned: false, backgroundCount: 0 });
  expect(rows(host).pinned).toBeNull();
  expect(rows(host).background).toBeNull();
});

test("one background task and a pinned message: both rows lead the menu, the count in the label", () => {
  const host = menu({ hasPinned: true, backgroundCount: 1 });
  const { pinned, background } = rows(host);
  expect(pinned?.textContent).toContain(translate("en", "mobile2.chat.menuPinned"));
  expect(background?.textContent).toContain("Background tasks · 1");
  const all = [...host.querySelectorAll('[role="menu"] > button')];
  expect(all[0]).toBe(pinned as unknown as Element);
  expect(all[1]).toBe(background as unknown as Element);
  /* No badge or dot rides on either row; the count is the row's own words. */
  expect(host.querySelector("[data-mobile2-notice-dot]")).toBeNull();
});

test("eight tasks without a pinned message: only the tasks row, saying eight", () => {
  const host = menu({ hasPinned: false, backgroundCount: 8 });
  expect(rows(host).pinned).toBeNull();
  expect(rows(host).background?.textContent).toContain("Background tasks · 8");
});

test("a pinned message without tasks: only the pinned row", () => {
  const host = menu({ hasPinned: true, backgroundCount: 0 });
  expect(rows(host).pinned).not.toBeNull();
  expect(rows(host).background).toBeNull();
});

test("each row opens its own sheet and nothing else", async () => {
  const opened: string[] = [];
  const host = menu({ hasPinned: true, backgroundCount: 3, onOpenPinned: () => opened.push("pinned"), onOpenBackground: () => opened.push("background") });
  await click(rows(host).pinned);
  await click(rows(host).background);
  expect(opened).toEqual(["pinned", "background"]);
});

test("the rows read in Ukrainian", () => {
  setLocale("uk");
  const host = menu({ hasPinned: true, backgroundCount: 8 });
  expect(rows(host).pinned?.textContent).toContain("Закріплене повідомлення");
  expect(rows(host).background?.textContent).toContain("Фонові задачі · 8");
});

test("the pinned sheet shows the full text and opens the task card", async () => {
  const opened: string[] = [];
  let closed = 0;
  const pinned = task("task-1", PINNED_TEXT);
  const host = mount(<MobilePinnedSheet relations={[{ task: pinned, relation: "assignment" }]} onOpenTask={(value) => opened.push(value.id)} onClose={() => { closed += 1; }} />);
  expect(host.querySelector('[data-mobile2-sheet="pinned"]')).not.toBeNull();
  expect(host.querySelector("[data-mobile2-pinned-item] p")?.textContent).toBe(PINNED_TEXT);
  const open = host.querySelector('[data-mobile2-pinned-open="task-1"]')!;
  expect(open.textContent).toContain(translate("en", "mobile2.pinned.openCard"));
  await click(open);
  expect(opened).toEqual(["task-1"]);
  expect(closed).toBe(1);
});

test("the pinned sheet's button reads «Відкрити картку» in Ukrainian", () => {
  setLocale("uk");
  const host = mount(<MobilePinnedSheet relations={[{ task: task("task-1", PINNED_TEXT), relation: "source" }]} onOpenTask={() => undefined} onClose={() => undefined} />);
  expect(host.querySelector('[data-mobile2-pinned-open="task-1"]')?.textContent).toContain("Відкрити картку");
});

test("eight tasks list as eight rows with no standing Stop button: Stop lives in each task's ⋯ menu", () => {
  const tasks = Array.from({ length: 8 }, (_, index) => shellTask(index + 1));
  const host = mount(<MobileBackgroundSheet tasks={tasks} onClose={() => undefined} />);
  expect(host.querySelectorAll("[data-mobile2-task]")).toHaveLength(8);
  expect(host.querySelectorAll("[data-mobile2-task-menu]")).toHaveLength(8);
  expect(host.querySelector("[data-mobile2-task-stop]")).toBeNull();
  expect(host.textContent).not.toContain(translate("en", "task.kill"));
  expect(host.querySelector('[data-mobile2-sheet="background"]')?.getAttribute("aria-label")).toBe("Background tasks · 8");
  /* The row names the command and its last output; the id is not the headline. */
  expect(host.querySelector("[data-mobile2-task]")?.textContent).toContain("Watch CI run 1");
  expect(host.querySelector("[data-mobile2-task]")?.textContent).toContain("Last output 2m ago");
});

test("a task's ⋯ menu: the PID heads it, then Stop task, Show output and Copy command", async () => {
  const host = mount(<MobileBackgroundSheet tasks={[shellTask(1)]} onClose={() => undefined} />);
  await click(host.querySelector("[data-mobile2-task-menu]"));
  const items = host.querySelector("[data-mobile2-task-actions]")!;
  expect(items.firstElementChild?.textContent).toBe("PID 2145001");
  expect([...items.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim())).toEqual(["Stop task", "Show output", "Copy command"]);
  /* The label says what stops: a task, never a host. */
  expect(items.textContent).not.toContain("Stop host");
});

test("Stop task signals the task's own process and reports the receipt", async () => {
  const host = mount(<MobileBackgroundSheet tasks={[shellTask(1)]} onClose={() => undefined} />);
  await click(host.querySelector("[data-mobile2-task-menu]"));
  await click(host.querySelector("[data-mobile2-task-stop]"));
  expect(posts).toHaveLength(1);
  expect(posts[0]!.url).toBe("/api/proc");
  expect(posts[0]!.body).toEqual({ path: shellTask(1).path, force: false });
  expect(host.querySelector("[role=status]")?.textContent).toBe(translate("en", "task.signalSent", { signal: "SIGTERM", pid: 2_145_001 }));
});

test("Show output mounts that task's feed inline; a second tap hides it", async () => {
  const host = mount(<MobileBackgroundSheet tasks={[shellTask(1), shellTask(2)]} onClose={() => undefined} />);
  await click(host.querySelector("[data-mobile2-task-menu]"));
  await click(host.querySelector("[data-mobile2-task-output]"));
  expect(host.querySelector(`[data-fake-log-feed="${shellTask(1).path}"]`)).not.toBeNull();
  expect(host.querySelector(`[data-fake-log-feed="${shellTask(2).path}"]`)).toBeNull();
  await click(host.querySelector("[data-mobile2-task-menu]"));
  expect(host.querySelector("[data-mobile2-task-output]")?.textContent).toBe("Hide output");
});

test("Copy command puts the command that started the task on the clipboard", async () => {
  let copied = "";
  Object.defineProperty(dom.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied = text; } } });
  const host = mount(<MobileBackgroundSheet tasks={[shellTask(1)]} onClose={() => undefined} />);
  await click(host.querySelector("[data-mobile2-task-menu]"));
  await click(host.querySelector("[data-mobile2-task-copy]"));
  expect(copied).toBe("gh run watch 18234519921 --exit-status");
});

test("the task menu reads in Ukrainian", async () => {
  setLocale("uk");
  const host = mount(<MobileBackgroundSheet tasks={[shellTask(1)]} onClose={() => undefined} />);
  await click(host.querySelector("[data-mobile2-task-menu]"));
  const items = host.querySelector("[data-mobile2-task-actions]")!;
  expect([...items.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim())).toEqual(["Зупинити задачу", "Показати вивід", "Копіювати команду"]);
});
