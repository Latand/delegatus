import {
  createSseParser,
  encodeMuxControl,
  encodeMuxEvent,
  MUX_MAX_CHANNELS,
  MUX_PING_MS,
  MUX_STREAM_PATHS,
  type MuxOp,
} from "./protocol";

/** Answers a channel's URL with the response its own route gives, resuming after `lastEventId` when there is one. */
export type MuxStreamOpener = (url: URL, signal: AbortSignal, lastEventId: string) => Response | Promise<Response>;

interface Channel {
  abort: AbortController;
}

interface Connection {
  channels: Map<string, Channel>;
  write(text: string): void;
  shutdown(): void;
}

/* Bytes the reader has not taken yet. A reader on the same machine takes
   megabytes at once; a connection holding this much is one nobody reads. */
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;

/* The control request and the connection it addresses are two requests, and the
   server bundles routes apart: the registry lives on globalThis so both reach
   the same one. */
const globals = globalThis as unknown as { __llvStreamMux?: Map<string, Connection> };
const connections = (globals.__llvStreamMux ??= new Map<string, Connection>());

const encoder = new TextEncoder();

/**
 * The connection itself: registers under `id`, says `ready`, and carries every
 * channel opened on it until the reader leaves.
 *
 * An abandoned response can outlive its browser connection under the
 * production adapter (the log tail stream guards against the same thing), and
 * here the channels would keep tailing files for nobody. So the connection
 * watches its own queue: a ping still waiting when the next one is due, with
 * nothing read in between, means the reader is gone, and the connection ends.
 * A reader that is only slow reconnects and every channel resumes from its own
 * cursor, as it does after any other break.
 */
export function openMuxConnection(id: string, signal: AbortSignal, pingMs = MUX_PING_MS): ReadableStream<Uint8Array> {
  connections.get(id)?.shutdown();

  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  let drains = 0;
  let stalledAt: number | null = null;

  const connection: Connection = {
    channels: new Map(),
    write(text) {
      if (closed || !controller) return;
      try {
        controller.enqueue(encoder.encode(text));
      } catch {
        connection.shutdown();
        return;
      }
      if ((controller.desiredSize ?? 1) <= -MAX_QUEUED_BYTES) connection.shutdown();
    },
    shutdown() {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      timer = null;
      signal.removeEventListener("abort", connection.shutdown);
      for (const channel of connection.channels.values()) channel.abort.abort();
      connection.channels.clear();
      if (connections.get(id) === connection) connections.delete(id);
      try { controller?.close(); } catch { /* the response is already closed */ }
    },
  };

  return new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      if (signal.aborted) {
        connection.shutdown();
        return;
      }
      signal.addEventListener("abort", connection.shutdown, { once: true });
      connections.set(id, connection);
      connection.write(encodeMuxControl("ready", {}));
      timer = setInterval(() => {
        const waiting = (controller?.desiredSize ?? 1) <= 0;
        if (waiting && stalledAt === drains) {
          connection.shutdown();
          return;
        }
        stalledAt = waiting ? drains : null;
        connection.write(encodeMuxControl("ping", {}));
      }, pingMs);
    },
    /* Called when the reader has emptied the queue: the proof that somebody reads. */
    pull() {
      drains += 1;
    },
    cancel() {
      connection.shutdown();
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: 1 }));
}

function allowed(url: URL, base: URL): boolean {
  return url.origin === base.origin && (MUX_STREAM_PATHS as readonly string[]).includes(url.pathname);
}

async function run(connection: Connection, id: string, channel: Channel, url: URL, lastEventId: string, open: MuxStreamOpener): Promise<void> {
  const current = () => connection.channels.get(id) === channel;
  /* What the reader is told when the channel ends: 0 for a stream that ended or broke, the route's own
     status when it refused, 500 when it threw before answering. */
  let status = 500;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  /* A source that does not watch its signal is not waited for: the read in flight is cancelled with it. */
  const release = () => { void reader?.cancel().catch(() => undefined); };
  channel.abort.signal.addEventListener("abort", release, { once: true });
  try {
    const response = await open(url, channel.abort.signal, lastEventId);
    const stream = response.ok && (response.headers.get("content-type") ?? "").includes("text/event-stream") ? response.body : null;
    if (!stream) {
      status = response.ok ? 502 : response.status;
      void response.body?.cancel().catch(() => undefined);
      return;
    }
    status = 0;
    if (!current()) {
      void stream.cancel().catch(() => undefined);
      return;
    }
    reader = stream.getReader();
    connection.write(encodeMuxControl("up", id));
    const parser = createSseParser(lastEventId);
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !current()) break;
      let frames = "";
      for (const event of parser.push(decoder.decode(value, { stream: true }))) frames += encodeMuxEvent(id, event);
      if (frames) connection.write(frames);
    }
  } catch {
    /* The route threw, or its stream broke: either way the channel is over. */
  } finally {
    channel.abort.signal.removeEventListener("abort", release);
    release();
    if (current()) {
      connection.channels.delete(id);
      connection.write(encodeMuxControl("end", [id, status]));
    }
  }
}

/**
 * Opens and closes channels on a connection, in the order given. An `open`
 * for a channel that is already open replaces it. A URL outside the stream
 * routes, or one channel too many, ends that channel with a status and leaves
 * the rest alone.
 */
export function applyMuxOps(connectionId: string, ops: readonly MuxOp[], base: URL, open: MuxStreamOpener): "ok" | "unknown-connection" {
  const connection = connections.get(connectionId);
  if (!connection) return "unknown-connection";
  for (const op of ops) {
    const previous = connection.channels.get(op.id);
    if (previous) {
      connection.channels.delete(op.id);
      previous.abort.abort();
    }
    if (op.op === "close") continue;
    let url: URL | null = null;
    try { url = new URL(op.url, base); } catch { url = null; }
    if (!url || !allowed(url, base)) {
      connection.write(encodeMuxControl("end", [op.id, 400]));
      continue;
    }
    if (connection.channels.size >= MUX_MAX_CHANNELS) {
      connection.write(encodeMuxControl("end", [op.id, 429]));
      continue;
    }
    const channel: Channel = { abort: new AbortController() };
    connection.channels.set(op.id, channel);
    void run(connection, op.id, channel, url, op.lastEventId ?? "", open);
  }
  return "ok";
}

/** Channels open on a connection, for tests and for nothing else. */
export function muxChannelsForTests(connectionId: string): string[] | null {
  const connection = connections.get(connectionId);
  return connection ? [...connection.channels.keys()] : null;
}
