"use client";

/**
 * Persisted tail snapshots of recently viewed conversations (#1821).
 *
 * The in-memory tail cache in `useLogTail` already makes a conversation that
 * is still in this tab reopen instantly (#1432). What it cannot survive is a
 * NEW document: a reload, a phone tab the browser evicted, the operator
 * reopening the Viewer after a respawn or a resume. Every one of those starts
 * from nothing and waits for the transcript to be read and parsed again,
 * although the same rows were on screen a moment earlier — which is exactly
 * what the operator reported.
 *
 * So the last rendered tail of the few most recently viewed conversations is
 * written to `localStorage`, and a mount paints it before any request goes
 * out. What is stored is a CONTIGUOUS SUFFIX of the transcript plus the
 * transport position that suffix ends at, so the live subscription continues
 * forward from there and appends only what is new: no re-read of the window,
 * no second parse of it, no row that changes its bytes underneath the reader.
 *
 * Four bounds, all deliberate:
 *
 * - **Size.** A few conversations, a bounded slice each, a bounded total —
 *   in the store, and in the memory the throttle holds before it writes.
 *   `localStorage` is a synchronous store shared with everything else in the
 *   origin, and a tail cache that fills it is a bug in every other feature.
 * - **Recency.** Least recently written is evicted first, and a snapshot older
 *   than a week is not "just on screen" — it is dropped on read.
 * - **Content.** A line that carries a credential value or an attachment's
 *   bytes is never written. The slice is cut FORWARD past it rather than
 *   having the line rewritten, so what is restored is byte-identical to the
 *   file and the reader never sees a row mutate on revalidation.
 * - **Identity.** A restored window is not trusted because the file is the
 *   right LENGTH. It resumes one anchor earlier than it ends, and the first
 *   forward chunk replays those bytes: they are the file's own, or the window
 *   belongs to a transcript this path no longer holds and is replaced. See
 *   {@link restoreTailSnapshot} and its consumer in `useLogTail`.
 */
import { SENSITIVE_RECORD_KEY, redactTranscriptText } from "@/components/feed/toolRedaction";

/** What one conversation's tail costs at most, in line bytes. */
const MAX_BYTES_PER_PATH = 96 * 1024;
/** Lines per snapshot: a first paint needs a screenful, not a window. */
const MAX_LINES_PER_PATH = 400;
/** How many conversations keep a persisted tail. The byte budget below is the
    binding bound for large tails; this one keeps a board full of small panes
    from filling the store with conversations nobody reopens. */
const MAX_PATHS = 8;
/** The whole store's line-byte budget — and the throttle queue's. */
const MAX_BYTES_TOTAL = 384 * 1024;
/** A line this long is an attachment, a pasted frame or a dumped payload. */
const MAX_LINE_BYTES = 8 * 1024;
/** Older than this is not a conversation that "was just on screen". */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * How far behind the live end of the file a restored read may start and still
 * be a TAIL. It is the server's own live tail window (`MAX_CHUNK` in
 * `scanner/roots.ts`, which a client module cannot import): a forward read
 * that has to catch up by more than that is bounded to the live window and
 * skips whole records, so the restored rows would be painted with a hole
 * between them and what came next — and the anchor below could never be
 * replayed. A conversation that grew by more than this since it was on screen
 * is simply loaded fresh.
 */
const MAX_BEHIND_BYTES = 768 * 1024;
/** How many bytes of the stored tail the first forward chunk must replay
    before the window is believed. One record is already a strong witness; the
    budget lets several small ones in without making the re-read matter. */
const ANCHOR_BYTES = 4 * 1024;
/** At most one write per path per window; a flush ignores it. A desktop board
    keeps many panes live at once and each one's tail moves on every poll tick,
    and `localStorage` is synchronous. */
const WRITE_INTERVAL_MS = 5_000;
/** How many paths the throttle may hold at once, and how many write stamps are
    remembered. Both are in-memory bookkeeping in a tab that can live for days:
    a bound that only the STORE has is not a bound (#1821 review). */
const MAX_PENDING_PATHS = MAX_PATHS;
const MAX_WRITE_MARKS = MAX_PATHS * 2;

const KEY_PREFIX = "llvTail:v1:";
const INDEX_KEY = "llvTail:v1:index";

/** One retained tail window plus the transport state it ends at. Shared with
    `useLogTail`, which holds the same shape in memory. */
export interface TailSnapshot {
  win: { lines: string[]; start: number };
  size: number;
  offset: number;
  historyStart: number;
  partial: string;
  first: boolean;
  hasMore: boolean;
  tickTime: Date | null;
  /** Set only on a snapshot restored from the store: the bytes the next
      forward chunk must begin with, starting at `offset`, for this window to
      be this file's tail. An in-memory snapshot never carries one. */
  resumeAnchor?: string;
}

interface StoredTail {
  v: 1;
  lines: string[];
  start: number;
  size: number;
  offset: number;
  historyStart: number;
  hasMore: boolean;
  tickTime: number | null;
  savedAt: number;
  bytes: number;
}

interface IndexEntry {
  path: string;
  bytes: number;
  savedAt: number;
}

const encoder = new TextEncoder();
const utf8len = (text: string) => encoder.encode(text).length;
const lineBytes = (line: string) => utf8len(line) + 1;

/** Set once a write failed for a reason retrying cannot fix (a browser that
    refuses storage entirely): the feature then costs nothing per call. */
let disabled = false;

function storage(): Storage | null {
  if (disabled || typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    disabled = true;
    return null;
  }
}

const keyFor = (path: string) => KEY_PREFIX + path;

/* ── content safety ─────────────────────────────────────────────────────── */

/**
 * What may never be written is decided TWICE: once on the raw line, and once
 * on the structure the line decodes to.
 *
 * The raw pass is the repository's own transcript redactor — it changes a text
 * exactly when it recognises a credential in it — plus the two shapes encoded
 * bytes take in a line. The structured pass is what the raw pass cannot do:
 * a quoted JSON key whose value is a credential, an attachment block whose
 * bytes sit under a `data` field, and the same thing one level of escaping
 * down. Anything the structured pass cannot finish reading inside its budget
 * is refused, because "not inspected" is not "safe".
 */
const DATA_URI_RE = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i;
/** A run this long with no separator in it is encoded bytes, not prose. */
const BASE64_RUN_RE = /[A-Za-z0-9+/]{192,}={0,2}/;
/** Keys whose value IS an attachment's bytes, in every engine's transcripts. */
const ATTACHMENT_VALUE_KEY_RE = /^(?:b64|b64_json|base64|base64_?data|blob|bytes|content_bytes|file_?data|image_?data|image_url|audio_?data|thumbnail)$/i;
/** The `type` an attachment content block carries; `data` under one of these
    is bytes however short it is. `file_change`, `image_generation_call` and
    the rest stay readable because the match is anchored. */
const ATTACHMENT_TYPE_RE = /^(?:image|audio|video|document|file|base64|input_image|input_audio|image_url|image_file)$/i;
/** A `data` field this short is a field; longer is a payload. */
const SHORT_DATA_CHARS = 64;
const MAX_INSPECTED_NODES = 600;
const MAX_INSPECTED_DEPTH = 12;

/** Whether a piece of TEXT may be written, judged as text. */
function safeText(text: string): boolean {
  if (DATA_URI_RE.test(text)) return false;
  if (BASE64_RUN_RE.test(text)) return false;
  return redactTranscriptText(text) === text;
}

interface Inspection {
  nodes: number;
}

/**
 * Whether one decoded value may be written. `tainted` means an ancestor key
 * named a credential or an attachment: everything below it is refused unless
 * it carries no payload at all (a number, a flag, an absent value), because a
 * value's key is the only thing that says what it is.
 */
function safeValue(value: unknown, key: string, depth: number, budget: Inspection, tainted: boolean): boolean {
  if ((budget.nodes -= 1) < 0 || depth > MAX_INSPECTED_DEPTH) return false;
  if (value === null || typeof value === "number" || typeof value === "boolean" || value === undefined) return true;
  const marked = tainted || SENSITIVE_RECORD_KEY.test(key) || ATTACHMENT_VALUE_KEY_RE.test(key);
  if (typeof value === "string") {
    if (value === "") return true;
    if (marked) return false;
    if (key.toLowerCase() === "data" && value.length > SHORT_DATA_CHARS) return false;
    if (!safeText(value)) return false;
    /* One transcript record routinely carries another JSON document as a
       string — a tool result, a relayed message, a nested envelope — and a
       credential inside it is escaped out of every text pattern's reach. */
    const trimmed = value.trimStart();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return true;
    let nested: unknown;
    try {
      nested = JSON.parse(value);
    } catch {
      return true;
    }
    return safeValue(nested, "", depth + 1, budget, marked);
  }
  if (Array.isArray(value)) {
    /* The key follows into the elements: `{"authorization": ["…"]}`. */
    return value.every((child) => safeValue(child, key, depth + 1, budget, marked));
  }
  if (typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (typeof type === "string" && ATTACHMENT_TYPE_RE.test(type)) return false;
  for (const field in record) {
    if (!Object.hasOwn(record, field)) continue;
    if (!safeValue(record[field], field, depth + 1, budget, marked)) return false;
  }
  return true;
}

/**
 * Whether one transcript line may be written to the store. A line carrying a
 * credential value, an attachment's bytes, or simply more bytes than a message
 * ever needs, stays out — and so does a line this cannot finish reading.
 */
export function persistableLine(line: string): boolean {
  if (line.length > MAX_LINE_BYTES) return false;
  if (utf8len(line) > MAX_LINE_BYTES) return false;
  if (!safeText(line)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    /* Not JSON — a plain log line. The text pass above is the whole judge. */
    return true;
  }
  return safeValue(parsed, "", 0, { nodes: MAX_INSPECTED_NODES }, false);
}

/* ── bounding one window ────────────────────────────────────────────────── */

interface BoundedTail {
  lines: string[];
  /** Window index of `lines[0]`. */
  start: number;
  /** Byte offset of `lines[0]` in the file. */
  historyStart: number;
  /** Byte offset just past the last kept line: a record boundary. */
  endsAt: number;
  hasMore: boolean;
  bytes: number;
}

/**
 * The longest contiguous SUFFIX of a window that fits the per-path bounds and
 * that `keep` admits line by line, with the transport state moved to match it.
 *
 * Cutting forward rather than dropping lines in place is what keeps the
 * snapshot faithful: `historyStart` still names the byte offset of the first
 * retained line, so `loadOlder` reads real history and revalidation appends to
 * a window whose bytes are the file's own.
 *
 * The decoder's partial line is dropped and the end rewound to where that
 * record starts, so the next forward read begins on a record boundary and no
 * half record is ever stored. When lines ARE dropped, the new history start is
 * counted back from that end — the window is contiguous, so this costs only
 * the bytes that are kept and never encodes the ones being dropped.
 */
function boundedTail(snapshot: TailSnapshot, keep: (line: string) => boolean): BoundedTail | null {
  const lines = snapshot.win.lines;
  const endsAt = Math.max(0, snapshot.offset - utf8len(snapshot.partial));
  let kept = 0;
  let bytes = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!keep(line)) break;
    const cost = lineBytes(line);
    if (bytes + cost > MAX_BYTES_PER_PATH || kept + 1 > MAX_LINES_PER_PATH) break;
    bytes += cost;
    kept += 1;
  }
  if (kept === 0) return null;
  const from = lines.length - kept;
  return {
    lines: lines.slice(from),
    start: snapshot.win.start + from,
    historyStart: from === 0 ? snapshot.historyStart : Math.max(snapshot.historyStart, endsAt - bytes),
    endsAt,
    hasMore: snapshot.hasMore || from > 0,
    bytes,
  };
}

/** What would be written for this window, or null when nothing may be. */
export function persistableSnapshot(snapshot: TailSnapshot): StoredTail | null {
  const tail = boundedTail(snapshot, persistableLine);
  if (!tail) return null;
  return {
    v: 1,
    lines: tail.lines,
    start: tail.start,
    size: snapshot.size,
    offset: tail.endsAt,
    historyStart: tail.historyStart,
    hasMore: tail.hasMore,
    tickTime: snapshot.tickTime ? snapshot.tickTime.getTime() : null,
    savedAt: Date.now(),
    bytes: tail.bytes,
  };
}

/**
 * The same bounds WITHOUT the content scan: what the throttle may retain until
 * it writes. The queue holds whole windows otherwise — a board's worth of
 * panes, each up to the hook's own six thousand lines — which is memory the
 * store's budgets never covered.
 */
function queuedSnapshot(snapshot: TailSnapshot): { snapshot: TailSnapshot; bytes: number } | null {
  const tail = boundedTail(snapshot, () => true);
  if (!tail) return null;
  return {
    bytes: tail.bytes,
    snapshot: {
      win: { lines: tail.lines, start: tail.start },
      size: snapshot.size,
      offset: tail.endsAt,
      historyStart: tail.historyStart,
      partial: "",
      first: false,
      hasMore: tail.hasMore,
      tickTime: snapshot.tickTime,
    },
  };
}

/* ── the index ──────────────────────────────────────────────────────────── */

function readIndex(store: Storage): IndexEntry[] {
  try {
    const raw = store.getItem(INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is IndexEntry =>
      !!entry && typeof entry === "object"
      && typeof (entry as IndexEntry).path === "string"
      && typeof (entry as IndexEntry).bytes === "number"
      && typeof (entry as IndexEntry).savedAt === "number");
  } catch {
    return [];
  }
}

function writeIndex(store: Storage, index: IndexEntry[]): void {
  try {
    store.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    /* The index is a bound, not the data: a failed write costs a later evict. */
  }
}

/** Drop entries until the count and byte budgets hold, least recent first. */
function evict(store: Storage, index: IndexEntry[]): IndexEntry[] {
  const ordered = [...index].sort((a, b) => a.savedAt - b.savedAt);
  let total = ordered.reduce((sum, entry) => sum + entry.bytes, 0);
  while (ordered.length > MAX_PATHS || (total > MAX_BYTES_TOTAL && ordered.length > 1)) {
    const oldest = ordered.shift();
    if (!oldest) break;
    total -= oldest.bytes;
    try {
      store.removeItem(keyFor(oldest.path));
    } catch {
      /* already gone */
    }
  }
  return ordered;
}

/* ── writes ─────────────────────────────────────────────────────────────── */

const lastWriteAt = new Map<string, number>();
const pending = new Map<string, { snapshot: TailSnapshot; bytes: number }>();
/** The one scheduled write, and when it is due, so an earlier claim can move
    it without ever queueing two. */
let scheduled: { cancel: () => void; dueAt: number } | null = null;
let listenersAttached = false;

/**
 * Remember when a path was written. A stamp older than the throttle window
 * permits the next write anyway, so it is dead weight and goes; what is left
 * is capped as well, because a tab that runs for days visits more
 * conversations than any window's worth of stamps.
 *
 * Eviction from the STORE deliberately leaves the stamp alone: a path whose
 * snapshot was just evicted is the one whose next write would evict somebody
 * else, and dropping its throttle is how a burst turns into write churn.
 */
function markWritten(path: string, at: number): void {
  const expiredBefore = at - WRITE_INTERVAL_MS;
  for (const [known, when] of lastWriteAt) {
    if (when <= expiredBefore) lastWriteAt.delete(known);
  }
  lastWriteAt.delete(path);
  lastWriteAt.set(path, at);
  while (lastWriteAt.size > MAX_WRITE_MARKS) {
    const oldest = lastWriteAt.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    lastWriteAt.delete(oldest);
  }
}

/** Keep the queue inside the same budgets the store itself holds. */
function trimPending(): void {
  let bytes = 0;
  for (const entry of pending.values()) bytes += entry.bytes;
  while (pending.size > MAX_PENDING_PATHS || (bytes > MAX_BYTES_TOTAL && pending.size > 1)) {
    const oldest = pending.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    bytes -= pending.get(oldest)?.bytes ?? 0;
    pending.delete(oldest);
  }
}

/**
 * Ask for the queue to be written, off the paint path.
 *
 * NOTHING here may run while the reader is waiting for rows. The first chunk
 * of a conversation arrives, the pane renders it, and the same call stack used
 * to inspect four hundred lines and hand `localStorage` ninety kilobytes
 * synchronously before the browser could paint — measured at +72 ms of main
 * thread between the bytes and the frame on a phone viewport, on a cold open
 * that gains nothing from the cache at all. So a write is idle-time work:
 * `requestIdleCallback` when the browser has one, a macrotask otherwise, and
 * the page-hide flush below for the moments that cannot wait.
 */
function scheduleFlush(): void {
  const now = Date.now();
  let delay = WRITE_INTERVAL_MS;
  for (const path of pending.keys()) {
    const due = Math.max(0, WRITE_INTERVAL_MS - (now - (lastWriteAt.get(path) ?? 0)));
    if (due < delay) delay = due;
  }
  const dueAt = now + delay;
  if (scheduled && scheduled.dueAt <= dueAt) return;
  scheduled?.cancel();
  const run = () => {
    scheduled = null;
    flushTailSnapshots();
  };
  const idle = (window as unknown as { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number; cancelIdleCallback?: (handle: number) => void });
  if (delay === 0 && typeof idle.requestIdleCallback === "function") {
    const handle = idle.requestIdleCallback(run, { timeout: WRITE_INTERVAL_MS });
    scheduled = { dueAt, cancel: () => idle.cancelIdleCallback?.(handle) };
    return;
  }
  const timer = setTimeout(run, delay);
  scheduled = { dueAt, cancel: () => clearTimeout(timer) };
}

function attachListeners(): void {
  if (listenersAttached || typeof window === "undefined") return;
  listenersAttached = true;
  /* A phone does not get an unload: the tab is frozen and later evicted, and
     `pagehide` plus the hidden transition are the last moments that run. */
  window.addEventListener("pagehide", () => flushTailSnapshots());
  /* On the document, which is where this one is dispatched. */
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushTailSnapshots();
  });
}

function writeNow(path: string, snapshot: TailSnapshot): void {
  const store = storage();
  if (!store) return;
  const stored = persistableSnapshot(snapshot);
  if (!stored) return;
  const payload = JSON.stringify(stored);
  const commit = (): boolean => {
    try {
      store.setItem(keyFor(path), payload);
      return true;
    } catch {
      return false;
    }
  };
  let index = readIndex(store).filter((entry) => entry.path !== path);
  if (!commit()) {
    /* Out of quota: give up every other snapshot once — this one is the tail
       the operator is looking at — and only then stop persisting at all. */
    for (const entry of index) {
      try {
        store.removeItem(keyFor(entry.path));
      } catch {
        /* already gone */
      }
    }
    index = [];
    if (!commit()) {
      disabled = true;
      try {
        store.removeItem(INDEX_KEY);
      } catch {
        /* already gone */
      }
      return;
    }
  }
  index.push({ path, bytes: stored.bytes, savedAt: stored.savedAt });
  writeIndex(store, evict(store, index));
  markWritten(path, stored.savedAt);
}

/**
 * Record one conversation's tail for a later document. Never written here:
 * the queue is bounded to one path's budget per conversation, and
 * {@link scheduleFlush} puts the writing in idle time, with
 * {@link flushTailSnapshots} as the escape for the moments that cannot wait —
 * the page being hidden or going away.
 */
export function persistTailSnapshot(path: string, snapshot: TailSnapshot): void {
  if (disabled || typeof window === "undefined") return;
  attachListeners();
  const queued = queuedSnapshot(snapshot);
  if (!queued) return;
  /* Re-inserted at the end, so the pending map is ordered by recency and a
     flush can spend its budget on the conversations last looked at. */
  pending.delete(path);
  pending.set(path, queued);
  trimPending();
  scheduleFlush();
}

/**
 * Write every snapshot still waiting on the throttle, now.
 *
 * Called on the page-hide path a phone actually takes, where the work must be
 * bounded: only as many conversations as the store would keep anyway are
 * written, and the rest are dropped rather than spending a hidden page's last
 * milliseconds on entries eviction would remove. They are written in the order
 * they were last looked at, oldest first, because eviction reads exactly that
 * order — so the conversation the operator had on screen is the one write that
 * cannot be evicted by the others in the same burst.
 */
export function flushTailSnapshots(): void {
  scheduled?.cancel();
  scheduled = null;
  if (pending.size === 0) return;
  const entries = [...pending.entries()].slice(-MAX_PATHS);
  pending.clear();
  for (const [path, entry] of entries) writeNow(path, entry.snapshot);
}

/* ── reads ──────────────────────────────────────────────────────────────── */

/** The bytes a restored window ends with: one record at least, up to the
    anchor budget. Re-derived on read rather than stored, so the store holds
    each byte once. */
function anchorOf(lines: string[]): string {
  let bytes = 0;
  let kept = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const cost = lineBytes(lines[index]!);
    if (kept > 0 && bytes + cost > ANCHOR_BYTES) break;
    bytes += cost;
    kept += 1;
    if (bytes >= ANCHOR_BYTES) break;
  }
  return lines.slice(lines.length - kept).join("\n") + "\n";
}

/**
 * The persisted tail for `path`, or null when there is none to trust.
 *
 * `fileSize` is what the catalog says the transcript is now: a file SHORTER
 * than the snapshot was rotated or rewritten, so the stored suffix is not this
 * file's suffix any more and is dropped rather than painted.
 *
 * A file of the same length or longer is NOT thereby the same file — it can
 * have been compacted and regrown, or rewritten in place record for record —
 * so the returned snapshot resumes one `resumeAnchor` BEFORE its own end. The
 * consumer must require the next forward chunk to begin with those exact
 * bytes, and replace the window when it does not.
 */
export function restoreTailSnapshot(path: string, fileSize: number | null): TailSnapshot | null {
  const store = storage();
  if (!store) return null;
  let stored: StoredTail | null = null;
  try {
    const raw = store.getItem(keyFor(path));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredTail;
    if (parsed && parsed.v === 1 && Array.isArray(parsed.lines) && parsed.lines.length > 0) stored = parsed;
  } catch {
    stored = null;
  }
  if (!stored) {
    forgetTailSnapshot(path);
    return null;
  }
  const anchor = anchorOf(stored.lines);
  const resumeFrom = stored.offset - utf8len(anchor);
  const stale = Date.now() - stored.savedAt > MAX_AGE_MS;
  /* Zero counts: a truncated file is the clearest case of "not this one". */
  const shrunk = typeof fileSize === "number" && fileSize < stored.size;
  /* Measured from the RESUME point, so replaying the anchor can never push the
     read past the server's live window and be jumped forward. */
  const behind = typeof fileSize === "number" && fileSize - resumeFrom > MAX_BEHIND_BYTES;
  if (stale || shrunk || behind || resumeFrom < 0) {
    forgetTailSnapshot(path);
    return null;
  }
  return {
    win: { lines: stored.lines, start: stored.start },
    size: stored.size,
    offset: resumeFrom,
    historyStart: stored.historyStart,
    partial: "",
    /* Not a first read: the window below is already this transcript's tail,
       and the next forward chunk appends to it instead of replacing it. */
    first: false,
    hasMore: stored.hasMore,
    tickTime: stored.tickTime === null ? null : new Date(stored.tickTime),
    resumeAnchor: anchor,
  };
}

/** Forget one conversation's tail (the reader cleared it, or it did not hold). */
export function forgetTailSnapshot(path: string): void {
  const store = storage();
  pending.delete(path);
  lastWriteAt.delete(path);
  if (!store) return;
  try {
    store.removeItem(keyFor(path));
  } catch {
    /* already gone */
  }
  writeIndex(store, readIndex(store).filter((entry) => entry.path !== path));
}

/* ── tests ──────────────────────────────────────────────────────────────── */

export function resetTailStoreForTests(): void {
  disabled = false;
  pending.clear();
  lastWriteAt.clear();
  scheduled?.cancel();
  scheduled = null;
  const store = storage();
  if (!store) return;
  for (const entry of readIndex(store)) {
    try {
      store.removeItem(keyFor(entry.path));
    } catch {
      /* already gone */
    }
  }
  try {
    store.removeItem(INDEX_KEY);
  } catch {
    /* already gone */
  }
}

export function persistedTailPathsForTests(): string[] {
  const store = storage();
  if (!store) return [];
  return readIndex(store).map((entry) => entry.path);
}

/** Everything the store is holding right now — the throttle's own memory as
    well as the written entries — so a stress test can assert the bounds BEFORE
    a flush and not only after one. */
export function tailStoreMemoryForTests(): { pending: number; pendingBytes: number; writeMarks: number; stored: number; storedBytes: number } {
  let pendingBytes = 0;
  for (const entry of pending.values()) pendingBytes += entry.bytes;
  const store = storage();
  const index = store ? readIndex(store) : [];
  return {
    pending: pending.size,
    pendingBytes,
    writeMarks: lastWriteAt.size,
    stored: index.length,
    storedBytes: index.reduce((total, entry) => total + entry.bytes, 0),
  };
}

export const TAIL_STORE_BOUNDS_FOR_TESTS = {
  ANCHOR_BYTES,
  MAX_BEHIND_BYTES,
  MAX_BYTES_PER_PATH,
  MAX_LINES_PER_PATH,
  MAX_PATHS,
  MAX_PENDING_PATHS,
  MAX_WRITE_MARKS,
  MAX_BYTES_TOTAL,
  MAX_LINE_BYTES,
  MAX_AGE_MS,
  WRITE_INTERVAL_MS,
};
