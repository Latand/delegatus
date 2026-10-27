"use client";

import { backoffDelayMs } from "../deadline";

import { decodeMuxEvent, MUX_ENDPOINT, MUX_PING_MS, type MuxOp } from "./protocol";

/** The event a stream hands its listeners: what the readers here use of a MessageEvent. */
export interface StreamEvent {
  data: string;
  lastEventId?: string;
}

type StreamListener = (event: StreamEvent) => void;

/** What the readers here use of an EventSource; an EventSource is one. */
export interface EventStream {
  onopen: ((event: StreamEvent) => void) | null;
  onerror: ((event: StreamEvent) => void) | null;
  onmessage: ((event: StreamEvent) => void) | null;
  addEventListener(type: string, listener: StreamListener): void;
  close(): void;
}

/** The seams a test drives: the transports, the clock and the connection's name. */
export interface StreamMuxDeps {
  createEventSource(url: string): EventStream;
  fetch(url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<{ ok: boolean; status: number }>;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
  randomId(): string;
  /** The page came back (see `resume`), before its streams hear that they were cut. */
  resumed?(): void;
}

/** The streams of a page, and what the page's lifecycle does to them. */
export interface StreamMux {
  open(url: string): EventStream;
  /** The page went into the back/forward cache, was unloaded or was frozen: its connection is let go. */
  suspend(): void;
  /** The page is back: every stream it still has is told it was cut, and is opened again. */
  resume(): void;
}

/* What an EventSource waits before it reopens a stream that ended. */
const RETRY_MS = 3_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8_000;
/* Three pings missed, and a little over: the connection is open and carries nothing. */
const QUIET_MS = MUX_PING_MS * 3 + 5_000;
/* A reader that closes one stream to open another in the next moment keeps its connection. */
const LINGER_MS = 2_000;
/* The connection failed this many times in a row: the page asks the route whether it is there at all (see
   `probe`), and only a route that is gone or refused gives each stream its own connection. */
const GIVE_UP_AFTER = 3;
const CONTROL_RETRY_MS = 1_000;
const CONTROL_ATTEMPTS = 3;

const OWN_EVENTS = new Set(["open", "error"]);

/**
 * Every stream of the page over one connection (see `protocol.ts` for why).
 * `open(url)` answers with what `new EventSource(url)` would have been for the
 * reader: it opens, hands over the route's events under their own names, says
 * `error` when the stream breaks, and reopens a stream that merely ended, as
 * an EventSource does. A stream the route refused stays closed, as it would.
 *
 * Where the connection cannot be had at all (a server without the route, a
 * reader the control request is refused to), each stream becomes a plain
 * EventSource: the page works as it did before, on its own connections.
 */
export function createStreamMux(deps: StreamMuxDeps): StreamMux {
  let physical: EventStream | null = null;
  let connectionId = "";
  let ready = false;
  let failures = 0;
  let probing = false;
  let direct = false;
  let suspended = false;
  let nextChannel = 0;
  let outbox: MuxOp[] = [];
  let sending = false;
  let flushQueued = false;
  let reconnectTimer: unknown = null;
  let quietTimer: unknown = null;
  let lingerTimer: unknown = null;
  const channels = new Map<string, Channel>();

  class Channel implements EventStream {
    onopen: ((event: StreamEvent) => void) | null = null;
    onerror: ((event: StreamEvent) => void) | null = null;
    onmessage: ((event: StreamEvent) => void) | null = null;
    native: EventStream | null = null;
    /** The route refused the stream: it is over until the reader opens another. */
    refused = false;
    /** The stream's last event id, sent back when the channel is reopened, as an EventSource sends it. */
    lastEventId = "";
    private closed = false;
    private retryTimer: unknown = null;
    private readonly listeners = new Map<string, StreamListener[]>();

    constructor(readonly id: string, readonly url: string) {}

    addEventListener(type: string, listener: StreamListener): void {
      const known = this.listeners.get(type);
      if (known) known.push(listener);
      else {
        this.listeners.set(type, [listener]);
        if (this.native && !OWN_EVENTS.has(type) && type !== "message") this.forward(this.native, type);
      }
    }

    close(): void {
      if (this.closed) return;
      this.closed = true;
      this.clearRetry();
      channels.delete(this.id);
      if (this.native) this.native.close();
      else if (ready && !this.refused) send({ op: "close", id: this.id });
      this.native = null;
      if (channels.size === 0) linger();
    }

    emit(type: string, data: string, lastEventId: string): void {
      if (this.closed) return;
      const event: StreamEvent = { data, lastEventId };
      const handler = type === "open" ? this.onopen : type === "error" ? this.onerror : type === "message" ? this.onmessage : null;
      /* A reader that throws breaks its own stream, never the connection every other reader shares. */
      try { handler?.(event); } catch { /* the reader's own failure */ }
      for (const listener of [...(this.listeners.get(type) ?? [])]) {
        try { listener(event); } catch { /* the reader's own failure */ }
      }
    }

    /** The connection broke under the stream: it is reopened when the connection is back. */
    interrupted(): void {
      this.clearRetry();
      this.emit("error", "", "");
    }

    /** The server ended the channel: a stream that ended reopens after a pause, a refused one does not. */
    ended(status: number): void {
      this.clearRetry();
      this.refused = status !== 0;
      this.emit("error", "", "");
      if (this.closed || this.refused) return;
      this.retryTimer = deps.setTimeout(() => {
        this.retryTimer = null;
        if (!this.closed && ready && !this.native) send(this.openOp());
      }, RETRY_MS);
    }

    openOp(): MuxOp {
      return this.lastEventId ? { op: "open", id: this.id, url: this.url, lastEventId: this.lastEventId } : { op: "open", id: this.id, url: this.url };
    }

    /** The page let its connections go: this stream holds none, and waits for the page to come back. */
    release(): void {
      this.clearRetry();
      this.native?.close();
      this.native = null;
    }

    /** The stream on a connection of its own. */
    attach(): void {
      if (this.closed || this.native || suspended) return;
      this.clearRetry();
      const native = deps.createEventSource(this.url);
      this.native = native;
      native.onopen = () => this.emit("open", "", "");
      native.onerror = () => this.emit("error", "", "");
      native.onmessage = (event) => this.emit("message", event.data, event.lastEventId ?? "");
      for (const type of this.listeners.keys()) if (!OWN_EVENTS.has(type) && type !== "message") this.forward(native, type);
    }

    private forward(native: EventStream, type: string): void {
      native.addEventListener(type, (event) => this.emit(type, event.data, event.lastEventId ?? ""));
    }

    private clearRetry(): void {
      if (this.retryTimer !== null) deps.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  const clear = (timer: unknown): null => {
    if (timer !== null) deps.clearTimeout(timer);
    return null;
  };

  function touch(): void {
    quietTimer = clear(quietTimer);
    quietTimer = deps.setTimeout(() => {
      quietTimer = null;
      lost();
    }, QUIET_MS);
  }

  function send(op: MuxOp): void {
    outbox.push(op);
    if (flushQueued) return;
    flushQueued = true;
    /* One request for everything asked in this turn: a reader that closes a stream and opens the next one
       does both in a single round trip, in that order. */
    queueMicrotask(() => {
      flushQueued = false;
      void flush();
    });
  }

  async function flush(): Promise<void> {
    if (!ready || sending || outbox.length === 0) return;
    const id = connectionId;
    /* The connection this request is for. Once it is dropped, whatever the request comes back with is about
       a connection that is gone, and its streams have already been told. */
    const connection = physical;
    const gone = () => physical !== connection;
    const ops = outbox;
    outbox = [];
    sending = true;
    let status = 0;
    for (let attempt = 0; attempt < CONTROL_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await new Promise<void>((resolve) => { deps.setTimeout(resolve, CONTROL_RETRY_MS); });
        if (gone()) return;
      }
      try {
        const response = await deps.fetch(MUX_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ c: id, ops }),
        });
        status = response.status;
      } catch {
        status = 0;
      }
      if (gone()) return;
      if ((status >= 200 && status < 300) || status === 401 || status === 403 || status === 404) break;
    }
    sending = false;
    if (status >= 200 && status < 300) {
      void flush();
      return;
    }
    /* Refused outright: this reader may read the streams and may not ask for them here. */
    if (status === 401 || status === 403) goDirect();
    else lost();
  }

  function connect(): void {
    reconnectTimer = clear(reconnectTimer);
    connectionId = deps.randomId();
    ready = false;
    sending = false;
    outbox = [];
    let source: EventStream;
    try {
      source = deps.createEventSource(`${MUX_ENDPOINT}?c=${connectionId}`);
    } catch {
      lost();
      return;
    }
    physical = source;
    const mine = () => source === physical;
    source.addEventListener("ready", () => {
      if (!mine()) return;
      ready = true;
      failures = 0;
      outbox = [];
      for (const channel of channels.values()) if (!channel.native && !channel.refused) outbox.push(channel.openOp());
      touch();
      void flush();
    });
    source.addEventListener("up", (event) => {
      if (!mine()) return;
      touch();
      try { channels.get(JSON.parse(event.data) as string)?.emit("open", "", ""); } catch { /* not a frame of ours */ }
    });
    source.addEventListener("end", (event) => {
      if (!mine()) return;
      touch();
      try {
        const [id, status] = JSON.parse(event.data) as [string, number];
        channels.get(id)?.ended(typeof status === "number" ? status : 0);
      } catch { /* not a frame of ours */ }
    });
    source.addEventListener("e", (event) => {
      if (!mine()) return;
      touch();
      const frame = decodeMuxEvent(event.data);
      const channel = frame ? channels.get(frame.channel) : undefined;
      if (!frame || !channel) return;
      channel.lastEventId = frame.id;
      channel.emit(frame.event, frame.data, frame.id);
    });
    source.addEventListener("ping", () => { if (mine()) touch(); });
    source.onerror = () => { if (mine()) lost(); };
    /* A connection that neither comes up nor fails is given the same patience as one that went quiet. */
    touch();
  }

  function drop(): void {
    quietTimer = clear(quietTimer);
    physical?.close();
    physical = null;
    ready = false;
    sending = false;
    outbox = [];
  }

  /** Brings the connection up for the streams that wait for it: at once the first time, after a growing
      pause once it has failed, so a reader that reopens its stream from the error cannot spin. */
  function scheduleConnect(): void {
    if (direct || suspended || physical || reconnectTimer !== null || channels.size === 0) return;
    if (failures === 0) {
      connect();
      return;
    }
    const delay = backoffDelayMs(failures, { baseMs: RECONNECT_BASE_MS, maxMs: RECONNECT_MAX_MS, jitter: 0 });
    reconnectTimer = deps.setTimeout(() => {
      reconnectTimer = null;
      if (!direct && !physical && channels.size > 0) connect();
    }, delay);
  }

  /** The connection broke, or never came up. */
  function lost(): void {
    drop();
    if (direct) return;
    failures += 1;
    for (const channel of [...channels.values()]) if (!channel.native) channel.interrupted();
    if (failures >= GIVE_UP_AFTER) void probe();
    scheduleConnect();
  }

  /** The connection keeps failing, whether the page ever had it or not: either the server is down for a
      while (a restart, a 503), and the connection comes back with it, or the server it reaches has no
      route (`LLV_STREAM_MUX=0`, an older release, a rollback), and only plain streams will ever work.
      The route itself tells the two apart: without a connection id it answers 400 when it is there.
      Giving up on anything less would put every stream of the tab back on a connection of its own. */
  async function probe(): Promise<void> {
    if (probing || direct) return;
    probing = true;
    let status = 0;
    try {
      status = (await deps.fetch(MUX_ENDPOINT, { method: "GET", headers: { accept: "application/json" } })).status;
    } catch {
      status = 0;
    }
    probing = false;
    if (direct || ready) return;
    if (status === 404 || status === 401 || status === 403) goDirect();
  }

  function goDirect(): void {
    direct = true;
    reconnectTimer = clear(reconnectTimer);
    lingerTimer = clear(lingerTimer);
    drop();
    for (const channel of [...channels.values()]) {
      channel.refused = false;
      channel.attach();
    }
  }

  function linger(): void {
    if (lingerTimer !== null || !physical) return;
    lingerTimer = deps.setTimeout(() => {
      lingerTimer = null;
      if (channels.size > 0) return;
      reconnectTimer = clear(reconnectTimer);
      drop();
    }, LINGER_MS);
  }

  /* A page the browser keeps in its back/forward cache, or freezes, still holds whatever it had open, and
     on plain HTTP that is one of the six connections every tab of the host shares: a few pages left that
     way and the next document waits behind them (#1958). So the page lets its connection go as it leaves,
     and only the streams' readers and their state stay. */
  function suspend(): void {
    if (suspended) return;
    suspended = true;
    reconnectTimer = clear(reconnectTimer);
    lingerTimer = clear(lingerTimer);
    drop();
    for (const channel of channels.values()) channel.release();
  }

  /* Back from the cache: whatever happened while the page was away was not read, so every stream says
     `error`, as one whose connection broke does, and is opened again on a new connection. */
  function resume(): void {
    if (!suspended) return;
    suspended = false;
    failures = 0;
    try { deps.resumed?.(); } catch { /* a listener's own failure */ }
    for (const channel of [...channels.values()]) channel.interrupted();
    if (direct) for (const channel of [...channels.values()]) channel.attach();
    else scheduleConnect();
  }

  return {
    suspend,
    resume,
    open(url) {
      const channel = new Channel(String(++nextChannel), url);
      channels.set(channel.id, channel);
      lingerTimer = clear(lingerTimer);
      if (direct) channel.attach();
      else if (!physical) scheduleConnect();
      else if (ready) send({ op: "open", id: channel.id, url });
      return channel;
    },
  };
}

function randomConnectionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

let shared: StreamMux | null = null;
const resumeListeners = new Set<() => void>();

/**
 * Called when a page that let its streams go comes back, before those streams
 * are told they were cut: a reader that would rather open its stream afresh
 * than hear `error` closes it here.
 */
export function onStreamsResume(listener: () => void): () => void {
  resumeListeners.add(listener);
  return () => { resumeListeners.delete(listener); };
}

/** Runs the listeners of `onStreamsResume`; the page's mux calls it as it resumes. */
export function streamsResumed(): void {
  for (const listener of [...resumeListeners]) {
    try { listener(); } catch { /* a listener's own failure */ }
  }
}

/**
 * The page's lifecycle, as the mux needs it. `pagehide` comes before the
 * back/forward cache and before an unload; `pageshow` with `persisted` is the
 * page restored from that cache. `freeze` and `resume` (on the document) are
 * a page the browser stops and starts again. A tab that is merely hidden
 * keeps its streams: a desktop board in the background still chimes from
 * them (src/lib/client/hiddenTraffic.ts).
 */
export function followPageLifecycle(mux: Pick<StreamMux, "suspend" | "resume">, page: EventTarget, doc: EventTarget): void {
  page.addEventListener("pagehide", () => mux.suspend());
  page.addEventListener("pageshow", (event) => {
    if ((event as Event & { persisted?: boolean }).persisted) mux.resume();
  });
  doc.addEventListener("freeze", () => mux.suspend());
  doc.addEventListener("resume", () => mux.resume());
}

/**
 * Whether this page takes its streams over one connection. Only the app's own
 * document says so (its layout carries the mark; a fixture's or a test's page
 * does not), and only over plain HTTP: HTTPS is HTTP/2 here, where streams
 * already share a connection and there is nothing to gain.
 */
function multiplexed(): boolean {
  if (typeof document === "undefined" || typeof location === "undefined" || location.protocol !== "http:") return false;
  return document.querySelector('meta[name="llv-stream-mux"][content="1"]') !== null;
}

/** A server-sent event stream of this app: `new EventSource(url)` to its reader, whatever carries it. */
export function openEventStream(url: string): EventStream {
  if (!multiplexed()) return new EventSource(url) as unknown as EventStream;
  if (!shared) {
    shared = createStreamMux({
      createEventSource: (target) => new EventSource(target) as unknown as EventStream,
      fetch: (target, init) => fetch(target, { ...init, cache: "no-store" }),
      setTimeout: (run, ms) => setTimeout(run, ms),
      clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      randomId: randomConnectionId,
      resumed: streamsResumed,
    });
    followPageLifecycle(shared, window, document);
  }
  return shared.open(url);
}
