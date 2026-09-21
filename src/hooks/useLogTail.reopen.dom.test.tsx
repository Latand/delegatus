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
const { flushTailSnapshots, resetTailStoreForTests, restoreTailSnapshot } = await import("./logTailStore");

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

/** Drive one conversation to a stored tail, then throw this document away:
    the tab's memory is gone, the browser's storage is not. Returns the
    transcript bytes that were on screen. */
async function storeTailThenReload(file: FileEntry, lines: string[]): Promise<string> {
  const body = transcript(lines);
  mount(file);
  const first = await waitForSubscriber(file.path);
  deliver(first, { data: body, offset: bytes(body), size: bytes(body), start: 0 });
  expect(text()).toContain(lines.at(-1)!.slice(0, 20));
  /* The page is hidden — the phone's last moment — so the tail is stored. */
  flushTailSnapshots();
  flushSync(() => roots.pop()!.unmount());
  subscribers.clear();
  resetLogTailCacheForTests();
  commits.length = 0;
  return body;
}

test("a new document paints the persisted tail on its first commit and appends the fresh records to it", async () => {
  const lines = [record(0, "first"), record(1, "second")];
  const file = entry("/sessions/alpha/reopen.jsonl", bytes(transcript(lines)));
  const body = await storeTailThenReload(file, lines);

  mount(file);
  /* The very first commit already carries the rows, and never claims to be
     loading: that is what removes the blank pane and the skeleton flash. */
  expect(commits[0]).toEqual({ lines: 2, loading: false });
  expect(commits.every((commit) => !commit.loading)).toBe(true);
  expect(commits.every((commit) => commit.lines === 2)).toBe(true);
  expect(text()).toContain("first");
  expect(text()).toContain("second");

  /* Revalidation resumes one ANCHOR before the stored tail ends — here the
     whole two-record window, which is under the anchor budget — and replays
     exactly those bytes. Nothing is appended for them: the rows they describe
     are already on screen, and the window is now proved to be this file's. */
  const resumed = await waitForSubscriber(file.path);
  expect(resumed.getOffset()).toBe(0);
  deliver(resumed, { data: body, offset: bytes(body), size: bytes(body), start: 0 });
  expect(text()).toBe(lines.join("|"));
  expect(commits.every((commit) => commit.lines === 2)).toBe(true);

  /* And the fresh record lands on the end of the window that was restored. */
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

test("a transcript replaced at the SAME length does not keep the rows it no longer holds", async () => {
  const lines = [record(0, "first"), record(1, "second, and a longer tail of prose after it")];
  const file = entry("/sessions/alpha/rewritten.jsonl", bytes(transcript(lines)));
  const body = await storeTailThenReload(file, lines);

  /* The catalog reports the same size — a rewrite in place, a compaction that
     regrew to the same length — so nothing about the LENGTH is wrong. The
     bytes are another transcript's. */
  const head = record(7, "rewritten one");
  const padding = bytes(body) - bytes(transcript([head, record(8, "rewritten two")]));
  const replacementLines = [head, record(8, "rewritten two" + "x".repeat(padding))];
  const replacement = transcript(replacementLines);
  expect(bytes(replacement)).toBe(bytes(body));

  mount(file);
  expect(commits[0]!.lines).toBe(2);
  const resumed = await waitForSubscriber(file.path);
  deliver(resumed, { data: replacement, offset: bytes(replacement), size: bytes(replacement), start: 0 });

  /* Only the current transcript's rows remain, each once. */
  expect(text()).toBe(replacementLines.join("|"));
  expect(text()).not.toContain("a longer tail of prose");
  expect(dom.document.querySelector("output")?.getAttribute("data-start")).toBe("0");
  /* And what the store keeps for this path — written in idle time, or at the
     next page hide — is the transcript that is actually there, so the next
     document does not start from the old rows again. */
  flushTailSnapshots();
  expect(restoreTailSnapshot(file.path, bytes(replacement))?.win.lines).toEqual(replacementLines);
});

test("a transcript compacted and regrown past its old length is replaced, not appended to", async () => {
  const lines = [record(0, "first"), record(1, "second")];
  const file = entry("/sessions/alpha/compacted.jsonl", bytes(transcript(lines)));
  await storeTailThenReload(file, lines);

  /* Compacted to a summary and written forward again: LONGER than it was, and
     the bytes at the stored offset belong to records that never existed when
     the tail was cached. */
  const regrown = transcript([record(20, "summary of the compacted history"), record(21, "and what came after it"), record(22, "and more")]);
  mount(entry(file.path, bytes(regrown)));
  const resumed = await waitForSubscriber(file.path);
  deliver(resumed, { data: regrown, offset: bytes(regrown), size: bytes(regrown), start: 0 });

  expect(text()).not.toContain("second");
  expect(text()).toContain("summary of the compacted history");
  expect(text().split("|").length).toBe(3);
});

test("a transcript truncated to nothing is not painted from the store at all", async () => {
  const lines = [record(0, "first"), record(1, "second")];
  const file = entry("/sessions/alpha/emptied.jsonl", bytes(transcript(lines)));
  await storeTailThenReload(file, lines);

  mount(entry(file.path, 0));
  expect(commits[0]).toEqual({ lines: 0, loading: true });
  expect(text()).toBe("");
  expect((await waitForSubscriber(file.path)).getOffset()).toBe(0);
});

test("an anchor split across two chunks is matched as far as each one goes", async () => {
  const lines = [record(0, "first"), record(1, "second")];
  const file = entry("/sessions/alpha/split.jsonl", bytes(transcript(lines)));
  const body = await storeTailThenReload(file, lines);

  mount(file);
  const resumed = await waitForSubscriber(file.path);
  /* A batch that ran out of byte budget hands over part of the window. It
     settles nothing either way, and no row is duplicated by it. */
  const half = Math.floor(body.length / 2);
  deliver(resumed, { data: body.slice(0, half), offset: bytes(body.slice(0, half)), size: bytes(body), start: 0 });
  expect(text()).toBe(lines.join("|"));
  deliver(resumed, { data: body.slice(half), offset: bytes(body), size: bytes(body), start: bytes(body.slice(0, half)) });
  expect(text()).toBe(lines.join("|"));

  const fresh = record(2, "third");
  deliver(resumed, { data: fresh + "\n", offset: bytes(body) + bytes(fresh + "\n"), size: bytes(body) + bytes(fresh + "\n"), start: bytes(body) });
  expect(text()).toBe([...lines, fresh].join("|"));
});

test("a reopen inside the SAME document keeps the in-memory fast path: no anchor, no re-read", async () => {
  const lines = [record(0, "first"), record(1, "second")];
  const body = transcript(lines);
  const file = entry("/sessions/alpha/in-memory.jsonl", bytes(body));
  mount(file);
  const first = await waitForSubscriber(file.path);
  deliver(first, { data: body, offset: bytes(body), size: bytes(body), start: 0 });

  /* The pane is unmounted and mounted again — a board relayout, a switch away
     and back — with this tab's memory intact. */
  flushSync(() => roots.pop()!.unmount());
  subscribers.clear();
  commits.length = 0;
  mount(file);

  expect(commits[0]).toEqual({ lines: 2, loading: false });
  /* Straight back to the live end: nothing is replayed, because nothing about
     this window came off disk. */
  const resumed = await waitForSubscriber(file.path);
  expect(resumed.getOffset()).toBe(bytes(body));
  const fresh = record(2, "third");
  deliver(resumed, { data: fresh + "\n", offset: bytes(body) + bytes(fresh + "\n"), size: bytes(body) + bytes(fresh + "\n"), start: bytes(body) });
  expect(text()).toBe([...lines, fresh].join("|"));
});
