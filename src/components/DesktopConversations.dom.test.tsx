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
const observers: { callback: (entries: { isIntersecting: boolean }[]) => void; targets: HTMLElement[] }[] = [];
class TestIntersectionObserver {
  private entry: { callback: (entries: { isIntersecting: boolean }[]) => void; targets: HTMLElement[] };
  constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
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

function mount(onOpen: (file: FileEntry) => void = () => {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => root.render(<DesktopConversations project="repo-board" enabled onOpen={onOpen} />));
  return host;
}

const rowPaths = (host: HTMLElement) => Array.from(host.querySelectorAll<HTMLElement>("[data-desktop-conversations-row]")).map((row) => row.getAttribute("data-desktop-conversations-row"));
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
  expect(served.urls[0]).toBe(`/api/conversations?limit=${DESKTOP_CONVERSATIONS_PAGE_SIZE}&project=repo-board`);
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
  for (let page = 0; page < 6; page += 1) await reachEnd();
  const paths = rowPaths(host);
  expect(new Set(paths).size).toBe(paths.length);
  expect(paths).toHaveLength(120);
  expect(tail(host).querySelector('[data-desktop-conversations-state="end"]')?.textContent).toBe("End of the list · all 120 conversations");
});

test("a page that fails keeps the rows, says so, and Retry reads that page again", async () => {
  let failing = true;
  const served = serveCatalog(160, { fail: (cursor) => (cursor === "50" && failing ? 503 : null) });
  const host = mount();
  await settle();
  await reachEnd();
  expect(rowPaths(host)).toHaveLength(50);
  expect(tail(host).querySelector('[data-desktop-conversations-state="failed"]')?.textContent).toBe("Could not load conversations");
  /* Failure does not page on by itself. */
  const asked = served.urls.length;
  await reachEnd();
  expect(served.urls.length).toBe(asked);

  failing = false;
  flushSync(() => (tail(host).querySelector('[data-desktop-conversations-retry="retry"]') as HTMLButtonElement).click());
  await settle();
  expect(served.urls.at(-1)).toContain("cursor=50");
  expect(rowPaths(host)).toHaveLength(100);
});

test("an expired snapshot keeps the rows, says the list changed, and Reload starts the chain again from the top", async () => {
  let expired = true;
  const served = serveCatalog(160, { fail: (cursor) => (cursor === "50" && expired ? 409 : null) });
  const host = mount();
  await settle();
  await reachEnd();
  expect(rowPaths(host)).toHaveLength(50);
  expect(tail(host).querySelector('[data-desktop-conversations-state="expired"]')).not.toBeNull();

  expired = false;
  flushSync(() => (tail(host).querySelector('[data-desktop-conversations-retry="reload"]') as HTMLButtonElement).click());
  await settle();
  expect(served.urls.at(-1)).not.toContain("cursor=");
  expect(rowPaths(host)).toHaveLength(50);
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
