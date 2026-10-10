/*
 * One connection for every live stream of a tab.
 *
 * A browser opens at most six HTTP/1.1 connections to one host, shared by every
 * tab on that host. Each tab of the board held three of them for as long as it
 * was open: the log tails, the runtime events and the update feed, one
 * EventSource each. Two tabs took all six, and from then on every ordinary
 * request of every tab (the board, a transcript, a launch, a sent message)
 * waited in the browser's queue behind streams that never end. Over HTTPS the
 * browser speaks HTTP/2 and the streams share one connection, which is why
 * only the plain-HTTP loopback address showed it.
 *
 * The multiplexer carries those streams as channels of a single connection:
 * `GET /api/streams?c=<id>` is the connection, and `POST /api/streams` opens
 * and closes channels on it. A channel is one of the existing stream routes,
 * answered by that route's own handler, so what a channel carries and who may
 * read it is decided where it always was.
 *
 * Frames on the connection:
 *   ready            the connection is registered and takes channels
 *   up     <channel> the channel's route answered with a stream (not `open`:
 *                    an EventSource fires that name for the connection itself)
 *   end    [channel, status]  the channel is over (its stream ended, or the
 *                    route refused it with that HTTP status; 0 for a stream)
 *   e      [channel, event, lastEventId] on the first data line, then the
 *                    source event's own data lines, untouched
 *   ping             every {@link MUX_PING_MS}, so a reader can tell a quiet
 *                    connection from a dead one
 */

export const MUX_ENDPOINT = "/api/streams";

/** The routes a channel may name. Anything else is refused. */
export const MUX_STREAM_PATHS = ["/api/logs/stream", "/api/runtime/stream", "/api/self-update/events"] as const;
export type MuxStreamPath = (typeof MUX_STREAM_PATHS)[number];

/** Three streams exist today; the bound leaves room without leaving it open. */
export const MUX_MAX_CHANNELS = 8;
export const MUX_PING_MS = 10_000;
/** A tab opens and closes a handful of channels at a time. */
export const MUX_MAX_OPS = 32;
export const MUX_MAX_BODY_BYTES = 256 * 1024;

export const MUX_CONNECTION_ID = /^[A-Za-z0-9_-]{16,64}$/;
export const MUX_CHANNEL_ID = /^[A-Za-z0-9_-]{1,32}$/;

export type MuxOp = { op: "open"; id: string; url: string } | { op: "close"; id: string };

export interface SseEvent {
  /** The event's type; "message" when the source named none. */
  event: string;
  data: string;
  /** The stream's last event id as of this event, "" while it has set none. */
  id: string;
}

/**
 * Server-sent events out of a text stream, by the rules an EventSource reads
 * them with: `data` lines join with a newline, a blank line dispatches, an
 * event with no data line is dropped, comments are skipped, and an id stays
 * until another replaces it. Lines end with LF or CRLF, which is what every
 * stream here writes.
 */
export function createSseParser(): { push(text: string): SseEvent[] } {
  let buffer = "";
  let event = "";
  let data: string[] = [];
  let id = "";
  return {
    push(text) {
      buffer += text;
      const events: SseEvent[] = [];
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end === -1) break;
        const line = buffer.charCodeAt(end - 1) === 13 ? buffer.slice(0, end - 1) : buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line === "") {
          if (data.length) events.push({ event: event || "message", data: data.join("\n"), id });
          event = "";
          data = [];
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "data") data.push(value);
        else if (field === "event") event = value;
        else if (field === "id" && !value.includes("\0")) id = value;
      }
      return events;
    },
  };
}

/** A source event as a frame of the connection: its data lines travel as they are. */
export function encodeMuxEvent(channel: string, event: SseEvent): string {
  const lines = event.data.split("\n").map((line) => `data: ${line}`).join("\n");
  return `event: e\ndata: ${JSON.stringify([channel, event.event, event.id])}\n${lines}\n\n`;
}

/** The reverse of {@link encodeMuxEvent}, from the data an EventSource hands over. */
export function decodeMuxEvent(data: string): { channel: string; event: string; id: string; data: string } | null {
  const cut = data.indexOf("\n");
  if (cut === -1) return null;
  try {
    const head = JSON.parse(data.slice(0, cut)) as unknown;
    if (!Array.isArray(head) || typeof head[0] !== "string" || typeof head[1] !== "string" || typeof head[2] !== "string") return null;
    return { channel: head[0], event: head[1], id: head[2], data: data.slice(cut + 1) };
  } catch {
    return null;
  }
}

export function encodeMuxControl(event: "ready" | "up" | "end" | "ping", data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The body of a control request, or null when it is not one. */
export function parseMuxOps(body: unknown): { connection: string; ops: MuxOp[] } | null {
  const record = body as { c?: unknown; ops?: unknown } | null;
  if (!record || typeof record.c !== "string" || !MUX_CONNECTION_ID.test(record.c)) return null;
  if (!Array.isArray(record.ops) || record.ops.length === 0 || record.ops.length > MUX_MAX_OPS) return null;
  const ops: MuxOp[] = [];
  for (const entry of record.ops as Array<{ op?: unknown; id?: unknown; url?: unknown } | null>) {
    if (!entry || typeof entry.id !== "string" || !MUX_CHANNEL_ID.test(entry.id)) return null;
    if (entry.op === "close") ops.push({ op: "close", id: entry.id });
    else if (entry.op === "open" && typeof entry.url === "string" && entry.url.length <= 64 * 1024) ops.push({ op: "open", id: entry.id, url: entry.url });
    else return null;
  }
  return { connection: record.c, ops };
}
