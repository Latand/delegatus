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
 * Three bounds, all deliberate:
 *
 * - **Size.** A few conversations, a bounded slice each, a bounded total.
 *   `localStorage` is a synchronous store shared with everything else in the
 *   origin, and a tail cache that fills it is a bug in every other feature.
 * - **Recency.** Least recently written is evicted first, and a snapshot older
 *   than a week is not "just on screen" — it is dropped on read.
 * - **Content.** A line that carries a credential value or an attachment's
 *   bytes is never written. The slice is cut FORWARD past it rather than
 *   having the line rewritten, so what is restored is byte-identical to the
 *   file and the reader never sees a row mutate on revalidation.
 */
import { redactSecrets } from "@/lib/review";

/** What one conversation's tail costs at most, in line bytes. */
const MAX_BYTES_PER_PATH = 96 * 1024;
/** Lines per snapshot: a first paint needs a screenful, not a window. */
const MAX_LINES_PER_PATH = 400;
/** How many conversations keep a persisted tail. The byte budget below is the
    binding bound for large tails; this one keeps a board full of small panes
    from filling the store with conversations nobody reopens. */
const MAX_PATHS = 8;
/** The whole store's line-byte budget. */
const MAX_BYTES_TOTAL = 384 * 1024;
/** A line this long is an attachment, a pasted frame or a dumped payload. */
const MAX_LINE_BYTES = 8 * 1024;
/** Older than this is not a conversation that "was just on screen". */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * How far behind the live end of the file a snapshot may sit and still be a
 * TAIL. It is the server's own live tail window (`MAX_CHUNK` in
 * `scanner/roots.ts`, which a client module cannot import): a forward read
 * that has to catch up by more than that is bounded to the live window and
 * skips whole records, so the restored rows would be painted with a hole
 * between them and what came next. A conversation that grew by more than this
 * since it was on screen is simply loaded fresh.
 */
const MAX_BEHIND_BYTES = 768 * 1024;
/** At most one write per path per window; a flush ignores it. A desktop board
    keeps many panes live at once and each one's tail moves on every poll tick,
    so this is what keeps a synchronous store off the critical path. */
const WRITE_INTERVAL_MS = 5_000;

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

/** Markers of bytes that belong to an attachment rather than to a message. */
const ATTACHMENT_MARKER_RE = /"type"\s*:\s*"image"|data:[a-z]+\/[a-z0-9.+-]+;base64,|"(?:base64|base64_data|image_url)"\s*:/i;

/**
 * Whether one transcript line may be written to the store. A line carrying a
 * credential value (the repository's own redactor is the judge: it changes a
 * line exactly when one is present), an attachment's bytes, or simply more
 * bytes than a message ever needs, stays out.
 */
export function persistableLine(line: string): boolean {
  if (line.length > MAX_LINE_BYTES) return false;
  if (utf8len(line) > MAX_LINE_BYTES) return false;
  if (ATTACHMENT_MARKER_RE.test(line)) return false;
  return redactSecrets(line) === line;
}

/**
 * The longest contiguous SUFFIX of the window that fits the bounds and holds
 * nothing unwritable, with the transport state moved to match it.
 *
 * Cutting forward rather than dropping lines in place is what keeps the
 * snapshot faithful: `historyStart` still names the byte offset of the first
 * retained line, so `loadOlder` reads real history and revalidation appends to
 * a window whose bytes are the file's own.
 *
 * The decoder's partial line is dropped and `offset` rewound to where that
 * record starts, so the next forward read begins on a record boundary and no
 * half record is ever restored.
 */
export function persistableSnapshot(snapshot: TailSnapshot): StoredTail | null {
  const lines = snapshot.win.lines;
  let kept = 0;
  let bytes = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!persistableLine(line)) break;
    const cost = lineBytes(line);
    if (bytes + cost > MAX_BYTES_PER_PATH || kept + 1 > MAX_LINES_PER_PATH) break;
    bytes += cost;
    kept += 1;
  }
  if (kept === 0) return null;
  const from = lines.length - kept;
  const droppedBytes = lines.slice(0, from).reduce((total, line) => total + lineBytes(line), 0);
  const partialBytes = utf8len(snapshot.partial);
  return {
    v: 1,
    lines: lines.slice(from),
    start: snapshot.win.start + from,
    size: snapshot.size,
    offset: Math.max(0, snapshot.offset - partialBytes),
    historyStart: snapshot.historyStart + droppedBytes,
    hasMore: snapshot.hasMore || droppedBytes > 0,
    tickTime: snapshot.tickTime ? snapshot.tickTime.getTime() : null,
    savedAt: Date.now(),
    bytes,
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
const pending = new Map<string, TailSnapshot>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let listenersAttached = false;

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
  lastWriteAt.set(path, stored.savedAt);
}

/**
 * Record one conversation's tail for a later document. Throttled per path —
 * the tail moves on every poll tick, and a synchronous store must not be
 * written that often — with {@link flushTailSnapshots} as the escape for the
 * moments that matter: the page being hidden or going away.
 */
export function persistTailSnapshot(path: string, snapshot: TailSnapshot): void {
  if (disabled || typeof window === "undefined") return;
  attachListeners();
  const last = lastWriteAt.get(path) ?? 0;
  if (Date.now() - last >= WRITE_INTERVAL_MS) {
    pending.delete(path);
    writeNow(path, snapshot);
    return;
  }
  /* Re-inserted at the end, so the pending map is ordered by recency and a
     flush can spend its budget on the conversations last looked at. */
  pending.delete(path);
  pending.set(path, snapshot);
  if (flushTimer === null) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushTailSnapshots();
    }, WRITE_INTERVAL_MS);
  }
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
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pending.size === 0) return;
  const entries = [...pending.entries()].slice(-MAX_PATHS);
  pending.clear();
  for (const [path, snapshot] of entries) writeNow(path, snapshot);
}

/* ── reads ──────────────────────────────────────────────────────────────── */

/**
 * The persisted tail for `path`, or null when there is none to trust.
 *
 * `fileSize` is what the catalog says the transcript is now: a file SHORTER
 * than the snapshot was rotated or rewritten, so the stored suffix is not this
 * file's suffix any more and is dropped rather than painted.
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
  const stale = Date.now() - stored.savedAt > MAX_AGE_MS;
  const shrunk = typeof fileSize === "number" && fileSize > 0 && fileSize < stored.size;
  const behind = typeof fileSize === "number" && fileSize - stored.offset > MAX_BEHIND_BYTES;
  if (stale || shrunk || behind) {
    forgetTailSnapshot(path);
    return null;
  }
  return {
    win: { lines: stored.lines, start: stored.start },
    size: stored.size,
    offset: stored.offset,
    historyStart: stored.historyStart,
    partial: "",
    /* Not a first read: the window below is already this transcript's tail,
       and the next forward chunk appends to it instead of replacing it. */
    first: false,
    hasMore: stored.hasMore,
    tickTime: stored.tickTime === null ? null : new Date(stored.tickTime),
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
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
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

export const TAIL_STORE_BOUNDS_FOR_TESTS = {
  MAX_BEHIND_BYTES,
  MAX_BYTES_PER_PATH,
  MAX_LINES_PER_PATH,
  MAX_PATHS,
  MAX_BYTES_TOTAL,
  MAX_LINE_BYTES,
  MAX_AGE_MS,
  WRITE_INTERVAL_MS,
};
