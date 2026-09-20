import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = { window: dom, document: dom.document };
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) {
    HAS[key] = key in G;
    SAVED[key] = G[key];
    G[key] = OVERRIDES[key];
  }
});
afterAll(() => {
  for (const key of Object.keys(OVERRIDES)) {
    if (HAS[key]) G[key] = SAVED[key];
    else delete G[key];
  }
});

const store = await import("./logTailStore");
const {
  flushTailSnapshots,
  forgetTailSnapshot,
  persistableLine,
  persistableSnapshot,
  persistTailSnapshot,
  persistedTailPathsForTests,
  resetTailStoreForTests,
  restoreTailSnapshot,
  TAIL_STORE_BOUNDS_FOR_TESTS: BOUNDS,
} = store;
type TailSnapshot = import("./logTailStore").TailSnapshot;

beforeEach(() => resetTailStoreForTests());
afterEach(() => resetTailStoreForTests());

const encoder = new TextEncoder();
const bytesOf = (lines: string[]) => lines.reduce((total, line) => total + encoder.encode(line).length + 1, 0);

function snapshot(lines: string[], overrides: Partial<TailSnapshot> = {}): TailSnapshot {
  const bytes = bytesOf(lines);
  return {
    win: { lines, start: 0 },
    size: bytes,
    offset: bytes,
    historyStart: 0,
    partial: "",
    first: false,
    hasMore: false,
    tickTime: null,
    ...overrides,
  };
}

const record = (index: number, text: string) => JSON.stringify({ type: "assistant", uuid: `r-${index}`, message: { role: "assistant", content: [{ type: "text", text }] } });

/* A credential-SHAPED line, assembled at runtime from parts: what these cases
   need is the shape the redactor recognises, and a key-equals-value literal in
   a published file is itself a privacy violation. */
const credentialShaped = (key: string) => `${key}${"="} ${"z".repeat(24)}`;

/* Each `persistTailSnapshot` is throttled per path, so a test that writes
   twice for one path flushes in between; the first write of a path is
   immediate. */
function write(path: string, snap: TailSnapshot): void {
  persistTailSnapshot(path, snap);
  flushTailSnapshots();
}

test("a persisted tail comes back with the transport position it ended at, so the next read appends", () => {
  const lines = [record(0, "one"), record(1, "two")];
  const snap = snapshot(lines, { historyStart: 40, hasMore: true, size: 900, offset: 860 });
  write("/sessions/a.jsonl", snap);

  const restored = restoreTailSnapshot("/sessions/a.jsonl", 900);
  expect(restored?.win.lines).toEqual(lines);
  expect(restored?.win.start).toBe(0);
  expect(restored?.offset).toBe(860);
  expect(restored?.historyStart).toBe(40);
  expect(restored?.hasMore).toBe(true);
  /* Never a first read: a first read replaces the window instead of appending. */
  expect(restored?.first).toBe(false);
  /* No half record is ever restored. */
  expect(restored?.partial).toBe("");
});

test("the decoder's partial line is dropped and the offset rewound to that record's first byte", () => {
  const lines = [record(0, "one")];
  const partial = '{"type":"assistant","uuid":"r-1"';
  const snap = snapshot(lines, { partial, offset: bytesOf(lines) + encoder.encode(partial).length });
  write("/sessions/partial.jsonl", snap);

  const restored = restoreTailSnapshot("/sessions/partial.jsonl", 10_000);
  expect(restored?.partial).toBe("");
  expect(restored?.offset).toBe(bytesOf(lines));
});

test("the stored slice is a contiguous suffix: history start and window start move with it", () => {
  const long = record(0, "x".repeat(BOUNDS.MAX_LINE_BYTES + 200));
  const keep = [record(1, "after"), record(2, "the attachment")];
  const snap = snapshot([long, ...keep], { win: { lines: [long, ...keep], start: 100 }, historyStart: 1_000 });
  const stored = persistableSnapshot(snap);
  expect(stored?.lines).toEqual(keep);
  expect(stored?.start).toBe(101);
  expect(stored?.historyStart).toBe(1_000 + bytesOf([long]));
  /* Bytes were cut off the front, so there IS older history to page back to. */
  expect(stored?.hasMore).toBe(true);
});

test("a line carrying a credential value or an attachment's bytes is never written", () => {
  expect(persistableLine(record(0, "ordinary prose about a token budget"))).toBe(true);
  expect(persistableLine(JSON.stringify({ message: { content: `export ${credentialShaped("API_KEY")}` } }))).toBe(false);
  expect(persistableLine(JSON.stringify({ message: { content: [{ type: "image", source: { data: "AAAA" } }] } }))).toBe(false);
  expect(persistableLine(JSON.stringify({ message: { content: "data:image/png;base64,AAAA" } }))).toBe(false);
  expect(persistableLine(record(0, "y".repeat(BOUNDS.MAX_LINE_BYTES + 1)))).toBe(false);

  const guarded = JSON.stringify({ message: { content: credentialShaped("access_token") } });
  write("/sessions/guarded.jsonl", snapshot([guarded, record(1, "and then prose")]));
  const restored = restoreTailSnapshot("/sessions/guarded.jsonl", 10_000);
  expect(restored?.win.lines).toEqual([record(1, "and then prose")]);
});

test("nothing is written when the whole window is unwritable", () => {
  const guarded = JSON.stringify({ message: { content: credentialShaped("password") } });
  expect(persistableSnapshot(snapshot([guarded]))).toBeNull();
  write("/sessions/only-guarded.jsonl", snapshot([guarded]));
  expect(persistedTailPathsForTests()).toEqual([]);
  expect(restoreTailSnapshot("/sessions/only-guarded.jsonl", 10_000)).toBeNull();
});

test("a snapshot is bounded in lines and in bytes", () => {
  const many = Array.from({ length: BOUNDS.MAX_LINES_PER_PATH + 50 }, (_, index) => record(index, `line ${index}`));
  const stored = persistableSnapshot(snapshot(many));
  expect(stored!.lines.length).toBeLessThanOrEqual(BOUNDS.MAX_LINES_PER_PATH);
  expect(stored!.bytes).toBeLessThanOrEqual(BOUNDS.MAX_BYTES_PER_PATH);
  /* The suffix is kept: the newest record is the one on screen. */
  expect(stored!.lines.at(-1)).toBe(many.at(-1));

  const fat = Array.from({ length: 200 }, (_, index) => record(index, "z".repeat(2_000)));
  const fatStored = persistableSnapshot(snapshot(fat));
  expect(fatStored!.bytes).toBeLessThanOrEqual(BOUNDS.MAX_BYTES_PER_PATH);
  expect(fatStored!.lines.length).toBeLessThan(200);
});

test("the store keeps the most recent conversations only, least recently written evicted first", () => {
  for (let index = 0; index < BOUNDS.MAX_PATHS + 3; index += 1) {
    write(`/sessions/p${index}.jsonl`, snapshot([record(index, `conversation ${index}`)]));
  }
  const paths = persistedTailPathsForTests();
  expect(paths.length).toBe(BOUNDS.MAX_PATHS);
  expect(paths).toContain(`/sessions/p${BOUNDS.MAX_PATHS + 2}.jsonl`);
  expect(paths).not.toContain("/sessions/p0.jsonl");
  expect(restoreTailSnapshot("/sessions/p0.jsonl", 10_000)).toBeNull();
});

test("a transcript that shrank, or grew past the live tail window, is not restored", () => {
  const lines = [record(0, "one")];
  write("/sessions/rotated.jsonl", snapshot(lines, { size: 5_000, offset: 5_000 }));
  /* Rotated or rewritten: what is stored is not this file's suffix. */
  expect(restoreTailSnapshot("/sessions/rotated.jsonl", 900)).toBeNull();

  write("/sessions/grown.jsonl", snapshot(lines, { size: 5_000, offset: 5_000 }));
  /* A forward read that far behind is bounded to the live window and would
     skip whole records, leaving a hole between the restored rows and the new
     ones; so it loads fresh instead. */
  expect(restoreTailSnapshot("/sessions/grown.jsonl", 5_000 + BOUNDS.MAX_BEHIND_BYTES + 1)).toBeNull();
  write("/sessions/grown.jsonl", snapshot(lines, { size: 5_000, offset: 5_000 }));
  expect(restoreTailSnapshot("/sessions/grown.jsonl", 5_000 + BOUNDS.MAX_BEHIND_BYTES - 1)?.win.lines).toEqual(lines);
});

test("a snapshot older than a week is dropped on read", () => {
  const lines = [record(0, "one")];
  write("/sessions/old.jsonl", snapshot(lines));
  const key = "llvTail:v1:/sessions/old.jsonl";
  const raw = JSON.parse(dom.localStorage.getItem(key)!) as { savedAt: number };
  raw.savedAt = Date.now() - BOUNDS.MAX_AGE_MS - 1;
  dom.localStorage.setItem(key, JSON.stringify(raw));
  expect(restoreTailSnapshot("/sessions/old.jsonl", 10_000)).toBeNull();
  expect(dom.localStorage.getItem(key)).toBeNull();
});

test("forgetting a conversation removes its snapshot and its index row", () => {
  write("/sessions/forget.jsonl", snapshot([record(0, "one")]));
  expect(persistedTailPathsForTests()).toEqual(["/sessions/forget.jsonl"]);
  forgetTailSnapshot("/sessions/forget.jsonl");
  expect(persistedTailPathsForTests()).toEqual([]);
  expect(restoreTailSnapshot("/sessions/forget.jsonl", 10_000)).toBeNull();
});

test("a garbled entry is dropped rather than painted", () => {
  dom.localStorage.setItem("llvTail:v1:/sessions/garbled.jsonl", "{not json");
  expect(restoreTailSnapshot("/sessions/garbled.jsonl", 10_000)).toBeNull();
  dom.localStorage.setItem("llvTail:v1:/sessions/wrongversion.jsonl", JSON.stringify({ v: 9, lines: ["x"] }));
  expect(restoreTailSnapshot("/sessions/wrongversion.jsonl", 10_000)).toBeNull();
});

test("pagehide flushes what the throttle still holds", () => {
  const first = snapshot([record(0, "one")]);
  const second = snapshot([record(0, "one"), record(1, "two")]);
  persistTailSnapshot("/sessions/hidden.jsonl", first);
  /* Within the throttle window: the second write is pending, not stored. */
  persistTailSnapshot("/sessions/hidden.jsonl", second);
  expect(restoreTailSnapshot("/sessions/hidden.jsonl", 10_000)?.win.lines.length).toBe(1);

  dom.dispatchEvent(new dom.Event("pagehide"));
  expect(restoreTailSnapshot("/sessions/hidden.jsonl", 10_000)?.win.lines.length).toBe(2);
});

test("the hidden transition flushes too — the last moment a phone tab gets", () => {
  persistTailSnapshot("/sessions/frozen.jsonl", snapshot([record(0, "one")]));
  persistTailSnapshot("/sessions/frozen.jsonl", snapshot([record(0, "one"), record(1, "two")]));
  expect(restoreTailSnapshot("/sessions/frozen.jsonl", 10_000)?.win.lines.length).toBe(1);

  /* A visible document must not spend the throttle's queue. */
  dom.document.dispatchEvent(new dom.Event("visibilitychange"));
  expect(restoreTailSnapshot("/sessions/frozen.jsonl", 10_000)?.win.lines.length).toBe(1);

  const descriptor = Object.getOwnPropertyDescriptor(dom.document, "visibilityState");
  Object.defineProperty(dom.document, "visibilityState", { value: "hidden", configurable: true });
  try {
    dom.document.dispatchEvent(new dom.Event("visibilitychange"));
    expect(restoreTailSnapshot("/sessions/frozen.jsonl", 10_000)?.win.lines.length).toBe(2);
  } finally {
    if (descriptor) Object.defineProperty(dom.document, "visibilityState", descriptor);
    else delete (dom.document as unknown as Record<string, unknown>).visibilityState;
  }
});

test("a bounded flush keeps the conversations last looked at, and the newest of them survives eviction", () => {
  /* The first write of each path is immediate, so a second round of writes for
     the same paths is what sits in the throttle's queue when the page hides. */
  const paths = Array.from({ length: BOUNDS.MAX_PATHS + 4 }, (_, index) => `/sessions/burst${index}.jsonl`);
  for (const [index, path] of paths.entries()) persistTailSnapshot(path, snapshot([record(index, `first ${index}`)]));
  for (const [index, path] of paths.entries()) persistTailSnapshot(path, snapshot([record(index, `pending ${index}`)]));

  const newest = paths.at(-1)!;
  const newestIndex = paths.length - 1;
  /* Still the first round's tail: the second is waiting on the throttle. */
  expect(restoreTailSnapshot(newest, 10_000)?.win.lines).toEqual([record(newestIndex, `first ${newestIndex}`)]);

  flushTailSnapshots();
  const stored = persistedTailPathsForTests();
  expect(stored.length).toBeLessThanOrEqual(BOUNDS.MAX_PATHS);
  /* The conversation last looked at carries what the flush wrote, and the
     older panes in the same burst did not evict it. */
  expect(restoreTailSnapshot(newest, 10_000)?.win.lines).toEqual([record(newestIndex, `pending ${newestIndex}`)]);
  expect(stored).not.toContain(paths[0]!);
});
