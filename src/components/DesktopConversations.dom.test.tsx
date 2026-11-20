import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";
import { clearRetainedConversationPages } from "@/hooks/useConversationCatalog";

import { DESKTOP_CONVERSATIONS_PAGE_SIZE, DesktopConversations } from "./DesktopConversations";

/**
 * Conversations, the desktop's second view (#1695): every conversation stored
 * for the project from the catalog's page chain, recent first, with no cap,
 * no embedded search, deduplicated pages, and a tail that says what is true:
 * the count, loading, a failure or an expired snapshot with its retry, and the
 * end.
 */

const dom = new Window();
/* One controllable observer: the test decides when the end of the rows is in view. */
type TestIntersection = { isIntersecting: boolean; target?: HTMLElement };
const observers: { callback: (entries: TestIntersection[]) => void; targets: HTMLElement[] }[] = [];
class TestIntersectionObserver {
  private entry: { callback: (entries: TestIntersection[]) => void; targets: HTMLElement[] };
  constructor(callback: (entries: TestIntersection[]) => void) {
    this.entry = { callback, targets: [] };
    observers.push(this.entry);
  }
  observe(target: HTMLElement) { this.entry.targets.push(target); }
  unobserve() {}
  disconnect() { const index = observers.indexOf(this.entry); if (index >= 0) observers.splice(index, 1); }
}
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = () => ({
  matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
});
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement, HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
  sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
  IntersectionObserver: TestIntersectionObserver,
  requestAnimationFrame: (callback: FrameRequestCallback) => dom.setTimeout(() => callback(0), 0),
  cancelAnimationFrame: (id: number) => dom.clearTimeout(id as never),
});

const roots = new Set<Root>();
let previousFetch: typeof fetch | null = null;
afterEach(() => {
  if (previousFetch) globalThis.fetch = previousFetch;
  previousFetch = null;
  clearRetainedConversationPages();
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  observers.length = 0;
  document.body.replaceChildren();
});

const settle = async () => {
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => undefined);
};

function entry(index: number, extra: Partial<FileEntry> = {}): FileEntry {
  return {
    path: `/catalog/conversation-${index}.jsonl`, root: "claude-projects", name: `conversation-${index}.jsonl`,
    project: "repo-board", title: `Conversation ${index}`, engine: "claude", kind: "session", fmt: "claude",
    parent: null, mtime: 10_000 - index, size: 1, activity: "idle", proc: null, pid: null, model: null,
    pendingQuestion: null, waitingInput: null, conversationId: `conversation-number-${index}`, ...extra,
  } as FileEntry;
}

interface Served { urls: string[]; fail: (cursor: string | null) => number | null; overlap: number }
/** A paged catalog of `total` entries; `fail` answers an error status for a cursor, `overlap` repeats rows across pages. */
function serveCatalog(total: number, options: Partial<Served> = {}): Served {
  previousFetch = globalThis.fetch;
  const served: Served = { urls: [], fail: options.fail ?? (() => null), overlap: options.overlap ?? 0 };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    served.urls.push(url.pathname + url.search);
    const cursor = url.searchParams.get("cursor");
    const status = served.fail(cursor);
    if (status !== null) return new Response(JSON.stringify({ error: "catalog unavailable" }), { status, headers: { "content-type": "application/json" } });
    const limit = Number(url.searchParams.get("limit") ?? "0");
    const start = Math.max(0, Number(cursor ?? "0") - (cursor ? served.overlap : 0));
    const items = Array.from({ length: Math.max(0, Math.min(limit, total - start)) }, (_, index) => entry(start + index));
    const next = start + items.length;
    return new Response(JSON.stringify({ items, nextCursor: next < total ? String(next) : null, total }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return served;
}

function mount(onOpen: (file: FileEntry) => void = () => {}, compact = false) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => root.render(<DesktopConversations project="repo-board" enabled compact={compact} onOpen={onOpen} />));
  return host;
}

const rowPaths = (host: HTMLElement) => Array.from(host.querySelectorAll<HTMLElement>("[data-desktop-conversations-row]"))
  .filter(row => !row.closest("[hidden]"))
  .map(row => row.getAttribute("data-desktop-conversations-row"));
const tail = (host: HTMLElement) => host.querySelector<HTMLElement>("[data-desktop-conversations-tail]")!;
const reachEnd = async () => {
  for (const observer of [...observers]) {
    if (observer.targets.some((target) => target.hasAttribute("data-desktop-conversations-sentinel"))) flushSync(() => observer.callback([{ isIntersecting: true }]));
  }
  await settle();
};

test("every stored conversation is listed recent first, page by page as the end comes into view, past any cap, and the end says so", async () => {
  const total = 7 * DESKTOP_CONVERSATIONS_PAGE_SIZE + 12;
  const served = serveCatalog(total);
  const host = mount();
  await settle();
  const params = new URL(served.urls[0]!, "http://localhost").searchParams;
  expect(Object.fromEntries(params)).toMatchObject({ limit: String(DESKTOP_CONVERSATIONS_PAGE_SIZE), project: "repo-board", view: "tree", branch: "roots" });
  expect(rowPaths(host)).toHaveLength(DESKTOP_CONVERSATIONS_PAGE_SIZE);
  expect(host.querySelector("[data-desktop-conversations-count]")?.textContent).toBe(String(total));
  expect(host.querySelector("input")).toBeNull();

  for (let page = 0; page < 8 && rowPaths(host).length < total; page += 1) await reachEnd();
  expect(rowPaths(host)).toHaveLength(total);
  expect(rowPaths(host)[0]).toBe(entry(0).path);
  expect(rowPaths(host).at(-1)).toBe(entry(total - 1).path);
  expect(tail(host).querySelector('[data-desktop-conversations-state="end"]')?.textContent).toBe(`End of the list · all ${total} conversations`);
  /* The chain ended: reaching the end again asks for nothing. */
  const asked = served.urls.length;
  await reachEnd();
  expect(served.urls.length).toBe(asked);
});

test("a row a later page returns again is listed once, and the end says how many were listed of the total", async () => {
  serveCatalog(120, { overlap: 5 });
  const host = mount();
  await settle();
  for (let page = 0; page < 16 && rowPaths(host).length < 120; page += 1) await reachEnd();
  const paths = rowPaths(host);
  expect(new Set(paths).size).toBe(paths.length);
  expect(paths).toHaveLength(120);
  expect(tail(host).querySelector('[data-desktop-conversations-state="end"]')?.textContent).toBe("End of the list · all 120 conversations");
});

test("a page that fails keeps the rows, says so, and Retry reads that page again", async () => {
  let failing = true;
  const served = serveCatalog(160, { fail: (cursor) => (cursor === String(DESKTOP_CONVERSATIONS_PAGE_SIZE) && failing ? 503 : null) });
  const host = mount();
  await settle();
  await reachEnd();
  expect(rowPaths(host)).toHaveLength(DESKTOP_CONVERSATIONS_PAGE_SIZE);
  expect(tail(host).querySelector('[data-desktop-conversations-state="failed"]')?.textContent).toBe("Could not load conversations");
  /* Failure does not page on by itself. */
  const asked = served.urls.length;
  await reachEnd();
  expect(served.urls.length).toBe(asked);

  failing = false;
  flushSync(() => (tail(host).querySelector('[data-desktop-conversations-retry="retry"]') as HTMLButtonElement).click());
  await settle();
  expect(served.urls.at(-1)).toContain(`cursor=${DESKTOP_CONVERSATIONS_PAGE_SIZE}`);
  expect(rowPaths(host)).toHaveLength(DESKTOP_CONVERSATIONS_PAGE_SIZE * 2);
});

test("an expired snapshot keeps the rows, says the list changed, and Reload starts the chain again from the top", async () => {
  let expired = true;
  const served = serveCatalog(160, { fail: (cursor) => (cursor === String(DESKTOP_CONVERSATIONS_PAGE_SIZE) && expired ? 409 : null) });
  const host = mount();
  await settle();
  await reachEnd();
  expect(rowPaths(host)).toHaveLength(DESKTOP_CONVERSATIONS_PAGE_SIZE);
  expect(tail(host).querySelector('[data-desktop-conversations-state="expired"]')).not.toBeNull();

  expired = false;
  flushSync(() => (tail(host).querySelector('[data-desktop-conversations-retry="reload"]') as HTMLButtonElement).click());
  await settle();
  expect(served.urls.at(-1)).not.toContain("cursor=");
  expect(rowPaths(host)).toHaveLength(DESKTOP_CONVERSATIONS_PAGE_SIZE);
  expect(tail(host).querySelector('[data-desktop-conversations-state="expired"]')).toBeNull();
});

test("a project with no stored conversations says so, and opening a row hands over that conversation", async () => {
  serveCatalog(0);
  const empty = mount();
  await settle();
  expect(tail(empty).querySelector('[data-desktop-conversations-state="end"]')?.textContent).toBe("No conversations are stored for this project.");
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  clearRetainedConversationPages();
  document.body.replaceChildren();

  serveCatalog(3);
  const opened: string[] = [];
  const host = mount((file) => opened.push(file.path));
  await settle();
  const row = host.querySelector(`[data-desktop-conversations-row="${entry(1).path}"] button`) as HTMLButtonElement | null;
  expect(row).not.toBeNull();
  flushSync(() => row!.click());
  expect(opened).toEqual([entry(1).path]);
});

test("the compact Chats list keeps its root and branch pages independent while a page is pending", async () => {
  const parent = entry(2, { title: "Main chat", directChildCount: 2 });
  const child = entry(1, { title: "Dependent chat", parent: parent.path, directChildCount: 0 });
  const fork = entry(3, { title: "Codex fork", engine: "codex", parent: parent.path, directChildCount: 0 });
  const other = entry(4, { title: "Other main chat", engine: "codex", directChildCount: 0 });
  const calls: URLSearchParams[] = [];
  let finishRoots!: (response: Response) => void;
  let finishChildren!: (response: Response) => void;
  previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname !== "/api/conversations") return Response.json({});
    const params = url.searchParams;
    calls.push(params);
    if (params.get("branch") === "children") {
      if (params.get("cursor")) return new Promise<Response>(resolve => { finishChildren = resolve; });
      return Response.json({ items: [child], total: 2, projectTotal: 4, nextCursor: "children-next" });
    }
    if (params.get("cursor")) return new Promise<Response>(resolve => { finishRoots = resolve; });
    return Response.json({ items: [parent], total: 2, projectTotal: 4, nextCursor: "roots-next" });
  }) as typeof fetch;
  let opened: FileEntry | null = null;
  const host = mount((file) => { opened = file; }, true);
  await settle();

  expect(rowPaths(host)).toEqual([parent.path]);
  const toggle = host.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!;
  const label = toggle.getAttribute("aria-label");
  expect(toggle.textContent).toContain("2");
  expect(calls).toHaveLength(1);
  const rootMore = tail(host).querySelector<HTMLButtonElement>("[data-desktop-conversations-more]")!;
  rootMore.focus();
  flushSync(() => rootMore.click());
  expect(tail(host).querySelector("[data-desktop-conversations-more]")).toBe(rootMore);
  expect(document.activeElement).toBe(rootMore);
  expect(rowPaths(host)).toEqual([parent.path]);
  finishRoots(Response.json({ items: [other], total: 2, projectTotal: 4, nextCursor: null }));
  await settle();
  expect(rowPaths(host)).toEqual([parent.path, other.path]);
  expect(document.activeElement).toBe(host.querySelector(`[data-desktop-conversations-row="${other.path}"] [data-desktop-chat-open]`));
  expect(toggle.getAttribute("aria-label")).toBe(label);

  flushSync(() => toggle.click());
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  await settle();
  expect(rowPaths(host)).toEqual([parent.path, child.path, other.path]);
  const childrenMore = host.querySelector<HTMLButtonElement>("[data-desktop-children-more]")!;
  childrenMore.focus();
  flushSync(() => childrenMore.click());
  expect(host.querySelector("[data-desktop-children-more]")).toBe(childrenMore);
  expect(document.activeElement).toBe(childrenMore);
  expect(rowPaths(host)).toEqual([parent.path, child.path, other.path]);
  finishChildren(Response.json({ items: [fork], total: 2, projectTotal: 4, nextCursor: null }));
  await settle();
  expect(rowPaths(host)).toEqual([parent.path, child.path, fork.path, other.path]);
  expect(calls.map(params => [params.get("branch"), params.get("parent"), params.get("cursor")])).toEqual([
    ["roots", null, null], ["roots", null, "roots-next"],
    ["children", parent.path, null], ["children", parent.path, "children-next"],
  ]);
  const dependent = Array.from(host.querySelectorAll("button")).find(button => button.textContent?.includes(fork.title))!;
  expect(document.activeElement).toBe(dependent);
  flushSync(() => dependent.click());
  expect(opened).toEqual(fork);
  flushSync(() => toggle.click());
  expect(rowPaths(host)).toEqual([parent.path, other.path]);
  flushSync(() => toggle.click());
  await settle();
  expect(rowPaths(host)).toEqual([parent.path, child.path, fork.path, other.path]);
  expect(calls).toHaveLength(4);
});

test("a visible cross-project Codex subagent loads its own PR badge from its source project", async () => {
  const parent = entry(1, { engine: "codex", title: "Parent thread", directChildCount: 1 });
  const child = entry(2, {
    engine: "codex", title: "Review worker", project: "source-project",
    nativeParentThreadId: "parent-thread", parent: parent.path, directChildCount: 0,
  });
  const reads: [string | null, string[]][] = [];
  previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/conversations/pull-requests") {
      reads.push([url.searchParams.get("project"), url.searchParams.getAll("transcript")]);
      return Response.json({ [child.path]: { items: [
        { url: "https://github.com/example/reports/pull/8", repository: "example/reports", number: 8, state: "merged" },
      ], partial: false } });
    }
    const items = url.searchParams.get("branch") === "children" ? [child] : [parent];
    return Response.json({ items, total: items.length, nextCursor: null });
  }) as typeof fetch;
  const host = mount(() => {}, true);
  await settle();
  flushSync(() => host.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!.click());
  await settle();
  const row = host.querySelector("[data-native-subagent]")!;
  const observed = row.firstElementChild as HTMLElement;
  observers.find(observer => observer.targets.includes(observed))!.callback([{ isIntersecting: true, target: observed }]);
  await new Promise(resolve => setTimeout(resolve, 70));
  await settle();
  expect(reads).toEqual([["source-project", [child.path]]]);
  expect(row.querySelector("[data-chat-pr-badge]")?.textContent).toBe("1");
});
