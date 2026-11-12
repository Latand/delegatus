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
/* A quarter window of slack: the window is cut back to its size only once it
   holds this many more, so an append costs O(1) on average. */
const HOST_EVENT_WINDOW_SLACK = HOST_EVENT_WINDOW / 4;

/** Drop the oldest events once the window has outgrown its slack. */
export function trimHostEventWindow(events: RuntimeEvent[]): void {
  if (events.length > HOST_EVENT_WINDOW + HOST_EVENT_WINDOW_SLACK) events.splice(0, events.length - HOST_EVENT_WINDOW);
}

/** The newest window of a restored history, as a new array. */
export function hostEventWindowOf(events: readonly RuntimeEvent[]): RuntimeEvent[] {
  return events.slice(-HOST_EVENT_WINDOW);
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
  if (first === undefined || afterSeq + 1 >= first) return newer;
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
