/**
 * #1821: a conversation that was on screen in the PREVIOUS document paints its
 * cached tail on the first commit of the next one — a reload, a phone tab the
 * browser evicted, the Viewer reopened after a respawn — and the live
 * subscription then continues forward from where that tail ends.
 *
 * The in-memory cache (#1432) is cleared between the two mounts here, which is
 * exactly what a new document is: same browser, same storage, nothing else.
 */
import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import type { LogSubscriber } from "./logBus";
import type { FileEntry, LogChunk } from "@/lib/types";

const actualLogBus = await import("./logBus");
const subscribers = new Map<string, LogSubscriber>();
mock.module("@/hooks/logBus", () => ({
  subscribeLog(subscriber: LogSubscriber) {
    subscribers.set(subscriber.path, subscriber);
    return () => {
      if (subscribers.get(subscriber.path) === subscriber) subscribers.delete(subscriber.path);
    };
  },
}));

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  requestAnimationFrame: (callback: (time: number) => void) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) {
    HAS[key] = key in G;
    SAVED[key] = G[key];
    G[key] = OVERRIDES[key];
  }
});
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const key of Object.keys(OVERRIDES)) {
    if (HAS[key]) G[key] = SAVED[key];
    else delete G[key];
  }
  mock.module("@/hooks/logBus", () => actualLogBus);
});

const { useLogTail, resetLogTailCacheForTests } = await import("./useLogTail");
const { flushTailSnapshots, resetTailStoreForTests } = await import("./logTailStore");

let roots: Root[] = [];
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots = [];
  subscribers.clear();
  resetLogTailCacheForTests();
  resetTailStoreForTests();
  dom.document.body.replaceChildren();
});

const entry = (path: string, size: number): FileEntry => ({
  path,
  root: "claude-projects",
  name: path.split("/").at(-1) ?? "session.jsonl",
  project: "alpha",
  cwd: "/repo",
  title: path,
  engine: "claude",
  kind: "session",
  fmt: "claude",
  parent: null,
  mtime: 1,
  size,
  activity: "recent",
  proc: null,
  pid: null,
  model: null,
  pendingQuestion: null,
  waitingInput: null,
} as FileEntry);

/** Every commit this pane produced, so a flash between them is visible. */
const commits: Array<{ lines: number; loading: boolean }> = [];
function Probe({ file }: { file: FileEntry }) {
  const tail = useLogTail(file);
  commits.push({ lines: tail.lines.length, loading: tail.loading });
  return <output data-loading={String(tail.loading)} data-start={tail.linesStart}>{tail.lines.join("|")}</output>;
}

function mount(file: FileEntry): Root {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(<Probe file={file} />));
  roots.push(root);
  return root;
}

const waitForSubscriber = async (path: string) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const subscriber = subscribers.get(path);
    if (subscriber) return subscriber;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`missing log subscriber for ${path}`);
};

const deliver = (subscriber: LogSubscriber, chunk: LogChunk) => flushSync(() => subscriber.onChunk(chunk));

const record = (index: number, text: string) => JSON.stringify({ type: "assistant", uuid: `r-${index}`, message: { role: "assistant", content: [{ type: "text", text }] } });
const transcript = (lines: string[]) => lines.join("\n") + "\n";
const bytes = (text: string) => new TextEncoder().encode(text).length;

const text = () => dom.document.querySelector("output")?.textContent ?? "";

test("a new document paints the persisted tail on its first commit and appends the fresh records to it", async () => {
  const lines = [record(0, "first"), record(1, "second")];
  const body = transcript(lines);
  const file = entry("/sessions/alpha/reopen.jsonl", bytes(body));

  mount(file);
  const first = await waitForSubscriber(file.path);
  deliver(first, { data: body, offset: bytes(body), size: bytes(body), start: 0 });
  expect(text()).toContain("second");
  /* The page is hidden — the phone's last moment — so the tail is stored. */
  flushTailSnapshots();

  /* A NEW document: this tab's memory is gone, the store is not. */
  flushSync(() => roots.pop()!.unmount());
  subscribers.clear();
  resetLogTailCacheForTests();
  commits.length = 0;

  mount(file);
  /* The very first commit already carries the rows, and never claims to be
     loading: that is what removes the blank pane and the skeleton flash. */
  expect(commits[0]).toEqual({ lines: 2, loading: false });
  expect(commits.every((commit) => !commit.loading)).toBe(true);
  expect(commits.every((commit) => commit.lines === 2)).toBe(true);
  expect(text()).toContain("first");
  expect(text()).toContain("second");

  /* Revalidation continues from where the stored tail ends: the window is not
     re-read, and the fresh record is appended to the rows already on screen. */
  const resumed = await waitForSubscriber(file.path);
  expect(resumed.getOffset()).toBe(bytes(body));
  const fresh = record(2, "third");
  deliver(resumed, { data: fresh + "\n", offset: bytes(body) + bytes(fresh + "\n"), size: bytes(body) + bytes(fresh + "\n"), start: bytes(body) });
  expect(text()).toBe([...lines, fresh].join("|"));
  /* No row was replaced or re-ordered: the window only grew at its end. */
  expect(dom.document.querySelector("output")?.getAttribute("data-start")).toBe("0");
});

test("the persisted tail is dropped when the transcript is no longer the one it came from", async () => {
  const lines = [record(0, "first"), record(1, "second")];
  const body = transcript(lines);
  const file = entry("/sessions/alpha/rotated.jsonl", bytes(body));
  mount(file);
  const first = await waitForSubscriber(file.path);
  deliver(first, { data: body, offset: bytes(body), size: bytes(body), start: 0 });
  flushTailSnapshots();

  flushSync(() => roots.pop()!.unmount());
  subscribers.clear();
  resetLogTailCacheForTests();
  commits.length = 0;

  /* The catalog now reports a SHORTER file: rotated, or rewritten. Painting
     the stored suffix would show rows this transcript does not contain. */
  mount(entry(file.path, 12));
  expect(commits[0]).toEqual({ lines: 0, loading: true });
  expect(text()).toBe("");
  const resumed = await waitForSubscriber(file.path);
  expect(resumed.getOffset()).toBe(0);
});
