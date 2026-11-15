import { RuntimeReplayGapError, type RuntimeEvent } from "./engineHost";

/**
 * How many of its newest events an engine host keeps in memory. Every event
 * is in the host's ledger before it enters this window, so an older one is
 * read back from the ledger when a reader asks for it.
 *
 * The window used to be the whole history: each host the Viewer held kept
 * every delta, item, tool output and message it had produced since it started
 * or was adopted, and an orchestrator never idles long enough to be retired,
 * so the arrays grew with the ledgers for as long as the process lived.
 *
 * 2048 covers what the in-memory readers ask for:
 * - the delivery controller attaches at the runtime host's acknowledged
 *   producer cursor, which trails the newest event by the few events still on
 *   their way to the journal; a cursor further back is served from the ledger;
 * - the native queue proof reads the newest 128 events;
 * - the realtime voice context keeps the last 8 KiB of the latest assistant
 *   message, and Codex streams that message in deltas of a few characters.
 */
export const HOST_EVENT_WINDOW = 2048;
/** Serialized UTF-8 bytes retained by one host, separate from the ledger. */
export const HOST_EVENT_WINDOW_BYTES = 6 * 1024 * 1024;
export const HOST_EVENT_PREVIEW_BYTES = 4096;

// Keep the latest observed sequence even when byte eviction removes every
// payload. Weak keys give the watermark the same lifetime as its window.
const windowWatermarks = new WeakMap<readonly RuntimeEvent[], number>();

/** Count-only arrays keep their existing append contract. Hosts use HostEventWindow. */
export function trimHostEventWindow(events: RuntimeEvent[]): void {
  if (events.length > HOST_EVENT_WINDOW * 1.25) events.splice(0, events.length - HOST_EVENT_WINDOW);
}

export function hostEventWindowByteLimit(value = process.env.LLV_HOST_EVENT_WINDOW_BYTES): number {
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : HOST_EVENT_WINDOW_BYTES;
}

const payloadFields = new Set(["aggregatedOutput", "output", "stdout", "stderr", "content", "contentItems", "diff", "patch", "text", "input", "arguments", "rawInput", "rawOutput", "changes", "result"]);
const toolTypes = new Set(["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "imageView", "imageGeneration", "tool_call", "tool_call_update", "tool_use", "tool_result"]);

/** Copy only changed payload paths. User echoes, prose, identities, outcomes,
 * callback receipts and voice/delivery evidence stay exact. In particular a
 * tool result's JSON text is an opaque display preview; protocol readers run
 * on the original before append, or on the full ledger during restoration. */
function previewItem(value: unknown, payload = false): { value: unknown; trimmed: boolean } {
  if (typeof value === "string") {
    if (!payload || value.length <= HOST_EVENT_PREVIEW_BYTES / 3) return { value, trimmed: false };
    const bytes = Buffer.byteLength(value);
    if (bytes <= HOST_EVENT_PREVIEW_BYTES) return { value, trimmed: false };
    // Decode a new buffer so a substring cannot retain the original backing store.
    const buffer = Buffer.from(value.slice(0, HOST_EVENT_PREVIEW_BYTES));
    let end = HOST_EVENT_PREVIEW_BYTES;
    while ((buffer[end]! & 0xc0) === 0x80) end--;
    return { value: buffer.subarray(0, end).toString("utf8")
      + `\n[truncated; original UTF-8 bytes: ${bytes}; full text in transcript]`, trimmed: true };
  }
  if (!value || typeof value !== "object") return { value, trimmed: false };
  if (Array.isArray(value)) {
    const children = value.map(child => previewItem(child, payload));
    const trimmed = children.some(child => child.trimmed);
    return { value: trimmed ? children.map(child => child.value) : value, trimmed };
  }
  const row = value as Record<string, unknown>;
  // Codex userMessage content is used as exact delivery proof.
  if (row.type === "userMessage" || row.type === "agentMessage") return { value, trimmed: false };
  const type = row.sessionUpdate ?? row.type;
  const tool = typeof type === "string" && toolTypes.has(type);
  let copy: Record<string, unknown> | undefined;
  for (const [key, child] of Object.entries(row)) {
    const next = previewItem(child, payload || tool && payloadFields.has(key));
    if (next.trimmed) { copy ??= { ...row }; copy[key] = next.value; }
  }
  return { value: copy ?? value, trimmed: !!copy };
}

/** One owner per host. Sizes are computed at insertion, never on diagnostic
 * reads or eviction. The array is a contiguous suffix, including when one
 * unpreviewable event exceeds the entire budget (then the suffix is empty).
 * Restored Codex history is handed here only AFTER exact reconciliation. */
export class HostEventWindow {
  readonly events: RuntimeEvent[] = [];
  private readonly sizes: { bytes: number; trimmed: boolean }[] = [];
  private bytes = 0;
  private trimmed = 0;
  readonly byteLimit: number;

  constructor(byteLimit = hostEventWindowByteLimit()) {
    if (!Number.isSafeInteger(byteLimit) || byteLimit <= 0) throw new Error("host event byte limit must be a positive safe integer");
    this.byteLimit = byteLimit;
    windowWatermarks.set(this.events, 0);
  }

  append(event: RuntimeEvent): void {
    windowWatermarks.set(this.events, Math.max(windowWatermarks.get(this.events) ?? 0, event.seq));
    const preview = event.kind === "item" ? previewItem(event.item) : { value: null, trimmed: false };
    const retained = preview.trimmed && event.kind === "item" ? { ...event, item: preview.value } : event;
    const bytes = Buffer.byteLength(JSON.stringify(retained));
    this.events.push(retained);
    this.sizes.push({ bytes, trimmed: preview.trimmed });
    this.bytes += bytes;
    this.trimmed += Number(preview.trimmed);
    let remove = 0;
    while (this.events.length - remove > HOST_EVENT_WINDOW || this.bytes > this.byteLimit) {
      const oldest = this.sizes[remove++]!;
      this.bytes -= oldest.bytes;
      this.trimmed -= Number(oldest.trimmed);
    }
    if (remove) { this.events.splice(0, remove); this.sizes.splice(0, remove); }
  }

  restore(events: readonly RuntimeEvent[]): void {
    // Copy first: callers may be relinquishing this very array after adoption.
    const newest = events.slice(-HOST_EVENT_WINDOW);
    this.events.length = 0;
    this.sizes.length = 0;
    this.bytes = 0;
    this.trimmed = 0;
    windowWatermarks.set(this.events, 0);
    for (const event of newest) this.append(event);
  }

  release(): void {
    releaseHostEventWindow(this.events);
    this.sizes.length = 0;
    this.bytes = 0;
    this.trimmed = 0;
  }

  heapAttribution() {
    return { windowBytes: this.bytes, windowByteLimit: this.byteLimit, trimmedEvents: this.trimmed };
  }
}

// A released payload array still remembers the sequence its ledger owes.

export function releaseHostEventWindow(events: RuntimeEvent[]): void {
  windowWatermarks.set(events, Math.max(events.at(-1)?.seq ?? 0, windowWatermarks.get(events) ?? 0));
  events.length = 0;
}

/** A shortened or missing ledger cannot replace a released window. Leave
 * it released so a later reader can retry after the ledger is available. */
export function assertReleasedHostEventLedger(window: readonly RuntimeEvent[], ledger: readonly RuntimeEvent[]): void {
  const tail = windowWatermarks.get(window) ?? 0;
  if ((ledger.at(-1)?.seq ?? 0) < tail) throw new RuntimeReplayGapError(0, tail);
}

/**
 * Every event after `afterSeq`: the in-memory window, preceded by the ledger's
 * events older than it when the window begins later. The ledger is read only
 * then. A request older than both is a replay gap, as it always was.
 */
export function runtimeEventsAfter(
  window: readonly RuntimeEvent[],
  afterSeq: number,
  ledger: () => readonly RuntimeEvent[],
): RuntimeEvent[] {
  const newer = window.filter(event => event.seq > afterSeq);
  const first = window[0]?.seq;
  if (first === undefined) {
    const available = ledger().filter(event => event.seq > afterSeq);
    if (available[0] && available[0].seq > afterSeq + 1) throw new RuntimeReplayGapError(afterSeq, available[0].seq);
    const watermark = windowWatermarks.get(window) ?? 0;
    const lastAvailable = available.at(-1)?.seq ?? afterSeq;
    if (lastAvailable < watermark) {
      throw new RuntimeReplayGapError(afterSeq, lastAvailable + 1);
    }
    return available;
  }
  if (afterSeq + 1 >= first) return newer;
  const older = ledger().filter(event => event.seq > afterSeq && event.seq < first);
  const available = older[0]?.seq ?? first;
  if (afterSeq + 1 < available) throw new RuntimeReplayGapError(afterSeq, available);
  if (older.at(-1)!.seq !== first - 1) throw new RuntimeReplayGapError(afterSeq, first);
  return [...older, ...newer];
}

export interface RuntimeEventSubscriber {
  afterSeq: number;
  queue: RuntimeEvent[];
  wake: (() => void) | null;
  closed: boolean;
}

/** What `attach` reads from its host. */
export interface RuntimeEventSource {
  window(): readonly RuntimeEvent[];
  ledger(): readonly RuntimeEvent[];
  readonly subscribers: Set<RuntimeEventSubscriber>;
}

type Seat = { subscriber: RuntimeEventSubscriber; subscribers: Set<RuntimeEventSubscriber> };
function leaveSeat({ subscriber, subscribers }: Seat): void {
  subscriber.closed = true;
  subscribers.delete(subscriber);
  subscriber.wake?.();
}
/* A stream its reader dropped without returning it gives its seat back once
   it is collected. */
const abandonedStreams = new FinalizationRegistry<Seat>(leaveSeat);

/**
 * A host's event stream after `afterSeq`, subscribed at once so it misses
 * nothing the host emits before its first read. Returning the stream leaves
 * the host at once, also before the first read: an async generator returned
 * before it starts never runs its `finally`, and such a stream stayed
 * subscribed for the host's life, collecting every later event. A stream
 * dropped unread gives its seat back when it is collected.
 */
export function attachRuntimeEvents(afterSeq: number, source: RuntimeEventSource): AsyncIterable<RuntimeEvent> {
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error("afterSeq must be a non-negative integer");
  const subscriber: RuntimeEventSubscriber = {
    afterSeq,
    queue: runtimeEventsAfter(source.window(), afterSeq, () => source.ledger()),
    wake: null,
    closed: false,
  };
  source.subscribers.add(subscriber);
  const seat: Seat = { subscriber, subscribers: source.subscribers };
  async function* read(): AsyncGenerator<RuntimeEvent> {
    try {
      while (true) {
        const event = subscriber.queue.shift();
        if (event) {
          if (event.seq > subscriber.afterSeq) {
            subscriber.afterSeq = event.seq;
            yield event;
          }
          continue;
        }
        if (subscriber.closed) break;
        await new Promise<void>((resolve) => { subscriber.wake = resolve; });
        subscriber.wake = null;
      }
    } finally {
      leaveSeat(seat);
    }
  }
  const stream: AsyncIterable<RuntimeEvent> = {
    [Symbol.asyncIterator]() {
      const generator = read();
      return {
        /* Keeps the stream, and with it the seat, while the reader holds this. */
        stream,
        next: () => generator.next(),
        return: (value?: unknown) => {
          leaveSeat(seat);
          return generator.return(value as never);
        },
        throw: (error?: unknown) => generator.throw(error),
        [Symbol.asyncIterator]() { return this; },
      } as AsyncIterableIterator<RuntimeEvent> & { stream: AsyncIterable<RuntimeEvent> };
    },
  };
  abandonedStreams.register(stream, seat);
  return stream;
}

/**
 * Bound a map kept in insertion order: once it holds more than `limit`
 * entries, drop the oldest ones `evictable` allows. Entries it refuses (work
 * still open) are kept whatever their age.
 */
export function boundMap<K, V>(map: Map<K, V>, limit: number, evictable: (value: V) => boolean = () => true): void {
  if (map.size <= limit) return;
  let excess = map.size - limit;
  for (const [key, value] of map) {
    if (excess <= 0) break;
    if (!evictable(value)) continue;
    map.delete(key);
    excess -= 1;
  }
}
