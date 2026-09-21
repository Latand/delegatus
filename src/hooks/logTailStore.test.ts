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
  tailStoreMemoryForTests,
  TAIL_STORE_BOUNDS_FOR_TESTS: BOUNDS,
} = store;
type TailSnapshot = import("./logTailStore").TailSnapshot;

beforeEach(() => resetTailStoreForTests());
afterEach(() => resetTailStoreForTests());

const encoder = new TextEncoder();
const bytesOf = (lines: string[]) => lines.reduce((total, line) => total + encoder.encode(line).length + 1, 0);

/** A window whose transport state is self-consistent: the lines end exactly
    at `offset`, which is what a real forward read always leaves behind. */
function snapshot(lines: string[], overrides: Partial<TailSnapshot> = {}): TailSnapshot {
  const historyStart = overrides.historyStart ?? 0;
  const bytes = bytesOf(lines);
  return {
    win: { lines, start: 0 },
    size: historyStart + bytes,
    offset: historyStart + bytes,
    historyStart,
    partial: "",
    first: false,
    hasMore: false,
    tickTime: null,
    ...overrides,
  };
}

/** What the store rewinds a restored read by: the tail's last records, up to
    the anchor budget, which the next forward chunk has to replay. */
function anchorBytesOf(lines: string[]): number {
  let bytes = 0;
  let kept = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const cost = encoder.encode(lines[index]!).length + 1;
    if (kept > 0 && bytes + cost > BOUNDS.ANCHOR_BYTES) break;
    bytes += cost;
    kept += 1;
    if (bytes >= BOUNDS.ANCHOR_BYTES) break;
  }
  return bytes;
}

const record = (index: number, text: string) => JSON.stringify({ type: "assistant", uuid: `r-${index}`, message: { role: "assistant", content: [{ type: "text", text }] } });

/* Credential- and attachment-SHAPED values, all assembled at runtime from
   parts: what these cases need is the SHAPE the filter has to recognise, and a
   key-with-a-value literal in a published file is itself a privacy violation.
   `SENTINEL` is what must never appear anywhere in the store afterwards. */
const credentialShaped = (key: string) => `${key}${"="} ${"z".repeat(24)}`;
const SENTINEL = ["sentinel", "value", "z".repeat(28)].join("-");
const PAYLOAD = "QUFB".repeat(64);
const keyNamed = (...parts: string[]) => parts.join("_");

/** Every byte the store holds, values and index alike. */
function storedText(): string {
  const all: string[] = [];
  for (let index = 0; index < dom.localStorage.length; index += 1) {
    const key = dom.localStorage.key(index)!;
    all.push(key, dom.localStorage.getItem(key) ?? "");
  }
  return all.join("\n");
}

/* `persistTailSnapshot` never writes in the caller's call stack — see the
   paint-path test below — so a test that wants a stored tail flushes. */
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
  /* The read resumes one anchor BEFORE the window ends, and the anchor is the
     bytes that window ends with: the next chunk replays them or the window is
     not this file's tail. */
  expect(restored?.resumeAnchor).toBe(lines.join("\n") + "\n");
  expect(restored?.offset).toBe(860 - anchorBytesOf(lines));
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
  expect((restored?.offset ?? 0) + anchorBytesOf(lines)).toBe(bytesOf(lines));
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

  const fat = Array.from({ length: 200 }, (_, index) => record(index, `paragraph ${index} `.repeat(120)));
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

test("a transcript that shrank, was emptied, or grew past the live tail window is not restored", () => {
  const lines = [record(0, "one")];
  write("/sessions/rotated.jsonl", snapshot(lines, { size: 5_000, offset: 5_000 }));
  /* Rotated or rewritten: what is stored is not this file's suffix. */
  expect(restoreTailSnapshot("/sessions/rotated.jsonl", 900)).toBeNull();

  /* Truncated to nothing. A zero the catalog reports is a size like any
     other, and the shortest possible proof that the tail is gone. */
  write("/sessions/emptied.jsonl", snapshot(lines, { size: 5_000, offset: 5_000 }));
  expect(restoreTailSnapshot("/sessions/emptied.jsonl", 0)).toBeNull();

  /* A forward read that far behind is bounded to the live window and would
     skip whole records, leaving a hole between the restored rows and the new
     ones; so it loads fresh instead. The distance is measured from where the
     read RESUMES, one anchor before the window ends, because that is the
     offset the server is asked for. */
  const resumeFrom = 5_000 - anchorBytesOf(lines);
  write("/sessions/grown.jsonl", snapshot(lines, { size: 5_000, offset: 5_000 }));
  expect(restoreTailSnapshot("/sessions/grown.jsonl", resumeFrom + BOUNDS.MAX_BEHIND_BYTES + 1)).toBeNull();
  write("/sessions/grown.jsonl", snapshot(lines, { size: 5_000, offset: 5_000 }));
  expect(restoreTailSnapshot("/sessions/grown.jsonl", resumeFrom + BOUNDS.MAX_BEHIND_BYTES)?.win.lines).toEqual(lines);
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

test("recording a tail writes nothing in the caller's call stack", () => {
  /* The caller is the chunk handler of a pane the reader is waiting on. Every
     byte of the writing — inspecting the window, serialising it, handing a
     synchronous store ninety kilobytes — happens in idle time or at page hide,
     never between the bytes arriving and the frame that shows them. */
  const lines = Array.from({ length: 300 }, (_, index) => record(index, `line ${index} ${"prose ".repeat(20)}`));
  persistTailSnapshot("/sessions/paint-path.jsonl", snapshot(lines));
  expect(persistedTailPathsForTests()).toEqual([]);
  expect(restoreTailSnapshot("/sessions/paint-path.jsonl", 10_000_000)).toBeNull();
  /* It is queued, and bounded, and the flush is what commits it. */
  expect(tailStoreMemoryForTests().pending).toBe(1);
  flushTailSnapshots();
  expect(persistedTailPathsForTests()).toEqual(["/sessions/paint-path.jsonl"]);
});

test("pagehide writes what is waiting — the last moment a page going away gets", () => {
  const first = snapshot([record(0, "one")]);
  const second = snapshot([record(0, "one"), record(1, "two")]);
  persistTailSnapshot("/sessions/hidden.jsonl", first);
  persistTailSnapshot("/sessions/hidden.jsonl", second);
  expect(restoreTailSnapshot("/sessions/hidden.jsonl", 10_000)).toBeNull();

  dom.dispatchEvent(new dom.Event("pagehide"));
  expect(restoreTailSnapshot("/sessions/hidden.jsonl", 10_000)?.win.lines.length).toBe(2);
});

test("the hidden transition writes too — the last moment a phone tab gets", () => {
  persistTailSnapshot("/sessions/frozen.jsonl", snapshot([record(0, "one"), record(1, "two")]));
  expect(restoreTailSnapshot("/sessions/frozen.jsonl", 10_000)).toBeNull();

  /* A document that is merely re-rendered must not spend the queue. */
  dom.document.dispatchEvent(new dom.Event("visibilitychange"));
  expect(restoreTailSnapshot("/sessions/frozen.jsonl", 10_000)).toBeNull();

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
  /* More panes than the store keeps, each recorded twice, and then the page
     goes away: the flush spends its budget on the ones last looked at. */
  const paths = Array.from({ length: BOUNDS.MAX_PATHS + 4 }, (_, index) => `/sessions/burst${index}.jsonl`);
  for (const [index, path] of paths.entries()) persistTailSnapshot(path, snapshot([record(index, `first ${index}`)]));
  for (const [index, path] of paths.entries()) persistTailSnapshot(path, snapshot([record(index, `pending ${index}`)]));

  const newest = paths.at(-1)!;
  const newestIndex = paths.length - 1;
  expect(tailStoreMemoryForTests().pending).toBeLessThanOrEqual(BOUNDS.MAX_PENDING_PATHS);

  flushTailSnapshots();
  const stored = persistedTailPathsForTests();
  expect(stored.length).toBeLessThanOrEqual(BOUNDS.MAX_PATHS);
  /* The conversation last looked at carries its newest tail, and the older
     panes in the same burst did not evict it. */
  expect(restoreTailSnapshot(newest, 10_000)?.win.lines).toEqual([record(newestIndex, `pending ${newestIndex}`)]);
  expect(stored).not.toContain(paths[0]!);
});

test("a credential value is refused however it is written, and never reaches the store", () => {
  /* The keys a transcript writes are QUOTED, which is what a text redactor
     alone cannot see; and one record routinely carries another JSON document
     as an escaped string, which puts the same field one level further down. */
  const quoted = JSON.stringify({ type: "user", [keyNamed("api", "key")]: SENTINEL });
  const escaped = JSON.stringify({ type: "user", message: { content: JSON.stringify({ [["pass", "word"].join("")]: SENTINEL }) } });
  const nested = JSON.stringify({ type: "user", tool: { input: { headers: { [keyNamed("access", "token")]: SENTINEL } } } });
  const bearer = record(0, `and then it answered with ${"Bear" + "er"} ${SENTINEL}`);
  const inline = JSON.stringify({ message: { content: `export ${credentialShaped(keyNamed("API", "KEY"))}` } });
  for (const line of [quoted, escaped, nested, bearer, inline]) expect(persistableLine(line)).toBe(false);

  /* A record that only COUNTS tokens is ordinary prose about a number, and
     the cache would be useless if it refused those. */
  expect(persistableLine(JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 512, cache_read_input_tokens: 20_480 } } }))).toBe(true);

  write("/sessions/credentials.jsonl", snapshot([quoted, escaped, nested, bearer, inline, record(9, "and then ordinary prose")]));
  expect(restoreTailSnapshot("/sessions/credentials.jsonl", 10_000)?.win.lines).toEqual([record(9, "and then ordinary prose")]);
  expect(storedText()).not.toContain(SENTINEL);
});

test("an attachment's bytes are refused in every shape a transcript writes them", () => {
  const document_ = JSON.stringify({ type: "user", message: { content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: PAYLOAD } }] } });
  const image = JSON.stringify({ type: "user", message: { content: [{ type: "image", source: { type: "base64", data: PAYLOAD } }] } });
  const audio = JSON.stringify({ type: "user", message: { content: [{ type: "input_audio", input_audio: { format: "wav", data: PAYLOAD } }] } });
  const uri = JSON.stringify({ type: "user", message: { content: `see ${"data:image/png;base64,"}${PAYLOAD}` } });
  const loose = JSON.stringify({ type: "tool_result", output: { [keyNamed("b64", "json")]: PAYLOAD } });
  for (const line of [document_, image, audio, uri, loose]) expect(persistableLine(line)).toBe(false);

  /* A short `data` field is a field, not a payload. */
  expect(persistableLine(JSON.stringify({ type: "custom", data: "ok" }))).toBe(true);

  write("/sessions/attachments.jsonl", snapshot([document_, image, audio, uri, loose, record(9, "and then ordinary prose")]));
  expect(restoreTailSnapshot("/sessions/attachments.jsonl", 10_000)?.win.lines).toEqual([record(9, "and then ordinary prose")]);
  expect(storedText()).not.toContain(PAYLOAD);
});

test("a structure this cannot finish reading is refused rather than assumed safe", () => {
  /* Wider and deeper than the inspection budget: "not inspected" is not
     "safe", so the line stays out. */
  let deep: unknown = SENTINEL;
  for (let level = 0; level < 40; level += 1) deep = { level, child: deep };
  expect(persistableLine(JSON.stringify({ type: "user", deep }))).toBe(false);
  const wide = Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`field${index}`, `value ${index}`]));
  expect(persistableLine(JSON.stringify({ type: "user", wide }))).toBe(false);
});

test("the throttle's own memory is bounded, before a flush as well as after", () => {
  /* Big windows, many conversations, twice each: the second round is what
     waits on the throttle, and what the review found unbounded. */
  const window_ = (index: number) => Array.from({ length: 600 }, (_, line) => record(line, `conversation ${index} line ${line} ${"prose ".repeat(30)}`));
  const paths = Array.from({ length: 20 }, (_, index) => `/sessions/stress${index}.jsonl`);
  for (const [index, path] of paths.entries()) persistTailSnapshot(path, snapshot(window_(index)));
  for (const [index, path] of paths.entries()) persistTailSnapshot(path, snapshot(window_(index)));

  const queued = tailStoreMemoryForTests();
  expect(queued.pending).toBeLessThanOrEqual(BOUNDS.MAX_PENDING_PATHS);
  expect(queued.pendingBytes).toBeLessThanOrEqual(BOUNDS.MAX_BYTES_TOTAL);
  expect(queued.writeMarks).toBeLessThanOrEqual(BOUNDS.MAX_WRITE_MARKS);
  expect(queued.stored).toBeLessThanOrEqual(BOUNDS.MAX_PATHS);
  expect(queued.storedBytes).toBeLessThanOrEqual(BOUNDS.MAX_BYTES_TOTAL);

  flushTailSnapshots();
  const flushed = tailStoreMemoryForTests();
  expect(flushed.pending).toBe(0);
  expect(flushed.pendingBytes).toBe(0);
  expect(flushed.stored).toBeLessThanOrEqual(BOUNDS.MAX_PATHS);
  expect(flushed.storedBytes).toBeLessThanOrEqual(BOUNDS.MAX_BYTES_TOTAL);
  expect(flushed.writeMarks).toBeLessThanOrEqual(BOUNDS.MAX_WRITE_MARKS);
  /* Every entry is a real, restorable tail — the bound is not an empty store.
     Each is read against the size its own window was written at. */
  for (const path of persistedTailPathsForTests()) {
    const index = Number(path.match(/stress(\d+)/)![1]);
    expect(restoreTailSnapshot(path, bytesOf(window_(index)))?.win.lines.length ?? 0).toBeGreaterThan(0);
  }
});
