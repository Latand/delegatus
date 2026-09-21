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
import { useRef } from "react";

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
const { createFeedSession } = await import("@/components/feed/parse");
const { createToolCueScanner } = await import("@/lib/audio/toolCues");
const { flushTailSnapshots, resetTailStoreForTests, restoreTailSnapshot } = await import("./logTailStore");

let roots: Root[] = [];
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots = [];
  subscribers.clear();
  resetLogTailCacheForTests();
  resetTailStoreForTests();
  commits.length = 0;
  cues.length = 0;
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
/** Tool cues the pane's feed earned, the way `LogFeed` earns them: the real
    parse session and the real scanner over every loaded commit, so a replaced
    row that reads as a freshly appended one would ring. */
const cues: string[] = [];
function Probe({ file }: { file: FileEntry }) {
  const tail = useLogTail(file);
  commits.push({ lines: tail.lines.length, loading: tail.loading });
  const feed = useRef<{ session: ReturnType<typeof createFeedSession>; scanner: ReturnType<typeof createToolCueScanner> } | null>(null);
  feed.current ??= { session: createFeedSession({ engine: "claude", fmt: "claude", showSvc: false, lineFilter: "" }), scanner: createToolCueScanner(file.path) };
  if (!tail.loading) {
    const items = feed.current.session.feed(tail.lines, tail.linesStart, true).items;
    for (const request of feed.current.scanner.scan(items, tail.linesStart + tail.lines.length)) cues.push(request.eventId);
  }
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

/* ── the SAME document: the in-memory cache is validated too ──────────────── */

/** Answer a subscriber the way `readTailChunk` does, from the offset it asked
    for: an offset past the end of the file is read from the start. */
function serve(subscriber: LogSubscriber, body: string): void {
  const size = bytes(body);
  const asked = subscriber.getOffset();
  const from = asked > size ? 0 : asked;
  deliver(subscriber, { data: new TextDecoder().decode(new TextEncoder().encode(body).slice(from)), offset: size, size, start: from });
}

const toolUse = (id: string) => JSON.stringify({ type: "assistant", uuid: `u-${id}`, message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command: `echo ${id}` } }] } });
const toolResult = (id: string) => JSON.stringify({ type: "user", uuid: `t-${id}`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: id }] }] } });
const call = (id: string) => [toolUse(id), toolResult(id)];

/** Read `lines` into a pane, then take the pane away with this tab's memory
    intact — a board relayout, a switch away and back. Returns the body. */
async function readThenUnmount(file: FileEntry, lines: string[]): Promise<string> {
  const body = transcript(lines);
  mount(file);
  serve(await waitForSubscriber(file.path), body);
  expect(text()).toBe(lines.join("|"));
  flushSync(() => roots.pop()!.unmount());
  subscribers.clear();
  commits.length = 0;
  cues.length = 0;
  return body;
}

test("a reopen inside the SAME document paints from memory at once, then replays its anchor and appends", async () => {
  const lines = [...call("old-a"), ...call("old-b")];
  const file = entry("/sessions/alpha/in-memory.jsonl", bytes(transcript(lines)));
  const body = await readThenUnmount(file, lines);
  mount(file);

  /* The cached rows are on the very first commit: memory is still the fast
     path for the paint. */
  expect(commits[0]).toEqual({ lines: 4, loading: false });
  /* What it is NOT any more is trusted as it stands: the read resumes one
     anchor before the window ends, like a window restored from storage. */
  const resumed = await waitForSubscriber(file.path);
  expect(resumed.getOffset()).toBeLessThan(bytes(body));
  serve(resumed, body);
  expect(text()).toBe(lines.join("|"));
  expect(cues).toEqual([]);

  const grown = transcript([...lines, ...call("fresh")]);
  serve(resumed, grown);
  expect(text()).toBe([...lines, ...call("fresh")].join("|"));
  /* A call that really was appended does ring, so the silence above means
     something. */
  expect(cues).toEqual([`tool:${file.path}:fresh`]);
});

test("a transcript replaced at the SAME length in the same document keeps none of the old rows", async () => {
  const lines = [...call("old-a"), ...call("old-b")];
  const file = entry("/sessions/alpha/in-memory-rewritten.jsonl", bytes(transcript(lines)));
  const body = await readThenUnmount(file, lines);

  const replacementLines = [...call("new-a"), ...call("new-b")];
  const replacement = transcript(replacementLines);
  expect(bytes(replacement)).toBe(bytes(body));

  mount(file);
  expect(commits[0]).toEqual({ lines: 4, loading: false });
  serve(await waitForSubscriber(file.path), replacement);

  expect(text()).toBe(replacementLines.join("|"));
  expect(text()).not.toContain("old-");
  /* Rows that replaced others are not new rows: nothing rings for them. */
  expect(cues).toEqual([]);
});

test("a transcript regrown past its old length in the same document shows only its own rows", async () => {
  const lines = [...call("old-a"), ...call("old-b")];
  const file = entry("/sessions/alpha/in-memory-regrown.jsonl", bytes(transcript(lines)));
  await readThenUnmount(file, lines);

  const regrownLines = [...call("new-a"), ...call("new-b"), ...call("new-c")];
  const regrown = transcript(regrownLines);
  mount(entry(file.path, bytes(regrown)));
  expect(commits[0]).toEqual({ lines: 4, loading: false });
  const resumed = await waitForSubscriber(file.path);
  serve(resumed, regrown);

  /* new-A, new-B, new-C, each once — never new-C appended to old-A/old-B. */
  expect(text()).toBe(regrownLines.join("|"));
  expect(cues).toEqual([]);

  const after = transcript([...regrownLines, ...call("new-d")]);
  serve(resumed, after);
  expect(text()).toBe([...regrownLines, ...call("new-d")].join("|"));
  expect(cues).toEqual([`tool:${file.path}:new-d`]);
});

test("a transcript truncated in the same document is not painted from memory, and a truncation the catalog missed clears on the first answer", async () => {
  const lines = [...call("old-a"), ...call("old-b")];
  const file = entry("/sessions/alpha/in-memory-truncated.jsonl", bytes(transcript(lines)));
  await readThenUnmount(file, lines);

  /* The catalog already reports the shorter file: nothing old is painted. */
  const shortLines = call("new-a");
  const short = transcript(shortLines);
  mount(entry(file.path, bytes(short)));
  expect(commits[0]).toEqual({ lines: 0, loading: true });
  expect(text()).toBe("");
  const first = await waitForSubscriber(file.path);
  expect(first.getOffset()).toBe(0);
  serve(first, short);
  expect(text()).toBe(shortLines.join("|"));
  expect(cues).toEqual([]);

  /* The catalog still reports the OLD length: the first answer settles it. */
  flushSync(() => roots.pop()!.unmount());
  subscribers.clear();
  commits.length = 0;
  const other = entry("/sessions/alpha/in-memory-truncated-late.jsonl", bytes(transcript(lines)));
  await readThenUnmount(other, lines);
  mount(other);
  expect(commits[0]).toEqual({ lines: 4, loading: false });
  serve(await waitForSubscriber(other.path), short);
  expect(text()).toBe(shortLines.join("|"));
  expect(text()).not.toContain("old-");
  expect(cues).toEqual([]);
});

/** Reopen `file` and take the pane away again before any answer arrives: the
    tab now holds a snapshot already armed with its anchor. Returns the offset
    that reopen asked for. */
async function reopenThenLeaveUnanswered(file: FileEntry): Promise<number> {
  mount(file);
  expect(commits[0]).toEqual({ lines: 4, loading: false });
  const asked = (await waitForSubscriber(file.path)).getOffset();
  flushSync(() => roots.pop()!.unmount());
  subscribers.clear();
  commits.length = 0;
  cues.length = 0;
  return asked;
}

test("a reopen interrupted before its first answer is validated again on the next one, against what the catalog now says", async () => {
  const lines = [...call("old-a"), ...call("old-b")];
  const file = entry("/sessions/alpha/interrupted-truncated.jsonl", bytes(transcript(lines)));
  await readThenUnmount(file, lines);
  await reopenThenLeaveUnanswered(file);

  /* Truncated while the pane was away the second time, and the catalog knows. */
  mount(entry(file.path, 0));
  expect(commits[0]).toEqual({ lines: 0, loading: true });
  expect(text()).toBe("");
  const first = await waitForSubscriber(file.path);
  expect(first.getOffset()).toBe(0);
  const shortLines = call("new-a");
  serve(first, transcript(shortLines));
  expect(text()).toBe(shortLines.join("|"));
  expect(cues).toEqual([]);

  /* A file that ran further ahead than one live read can catch up is loaded
     fresh too, rather than painted with a hole after it. */
  flushSync(() => roots.pop()!.unmount());
  subscribers.clear();
  commits.length = 0;
  const far = entry("/sessions/alpha/interrupted-far.jsonl", bytes(transcript(lines)));
  await readThenUnmount(far, lines);
  await reopenThenLeaveUnanswered(far);
  mount(entry(far.path, bytes(transcript(lines)) + 2 * 1024 * 1024));
  expect(commits[0]).toEqual({ lines: 0, loading: true });
});

test("a reopen interrupted before its first answer still paints at once next time, resumes where it did, and a replacement clears", async () => {
  const lines = [...call("old-a"), ...call("old-b")];
  const file = entry("/sessions/alpha/interrupted-valid.jsonl", bytes(transcript(lines)));
  const body = await readThenUnmount(file, lines);
  const asked = await reopenThenLeaveUnanswered(file);

  /* Nothing disproves the snapshot: the paint is immediate, and the anchor is
     not rewound a second time. */
  mount(file);
  expect(commits[0]).toEqual({ lines: 4, loading: false });
  const resumed = await waitForSubscriber(file.path);
  expect(resumed.getOffset()).toBe(asked);
  serve(resumed, body);
  expect(text()).toBe(lines.join("|"));
  expect(cues).toEqual([]);

  /* The same interruption over a transcript replaced at the same length. */
  flushSync(() => roots.pop()!.unmount());
  subscribers.clear();
  commits.length = 0;
  const other = entry("/sessions/alpha/interrupted-replaced.jsonl", bytes(transcript(lines)));
  await readThenUnmount(other, lines);
  await reopenThenLeaveUnanswered(other);
  const replacementLines = [...call("new-a"), ...call("new-b")];
  const replacement = transcript(replacementLines);
  expect(bytes(replacement)).toBe(bytes(body));
  mount(other);
  expect(commits[0]).toEqual({ lines: 4, loading: false });
  serve(await waitForSubscriber(other.path), replacement);
  expect(text()).toBe(replacementLines.join("|"));
  expect(text()).not.toContain("old-");
  expect(cues).toEqual([]);
});
