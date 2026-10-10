import { expect, test } from "bun:test";

import { createSseParser, decodeMuxEvent, MUX_MAX_CHANNELS, type SseEvent } from "./protocol";
import { applyMuxOps, muxChannelsForTests, openMuxConnection, type MuxStreamOpener } from "./server";

const BASE = new URL("http://127.0.0.1:8898/api/streams");
let serial = 0;
const connectionId = () => `connection-${String(++serial).padStart(8, "0")}`;

/** What the browser's EventSource would have dispatched off the connection so far. */
function reading(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const parser = createSseParser();
  const decoder = new TextDecoder();
  const seen: SseEvent[] = [];
  let over = false;
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen.push(...parser.push(decoder.decode(value, { stream: true })));
    }
    over = true;
  })().catch(() => { over = true; });
  return {
    /** The frames as `name data` lines, pings left out; a source event as `e channel name data`. */
    frames: () => seen.filter((event) => event.event !== "ping").map((event) => {
      if (event.event !== "e") return `${event.event} ${event.data}`;
      const frame = decodeMuxEvent(event.data)!;
      return `e ${frame.channel} ${frame.event} ${frame.data}`;
    }),
    pings: () => seen.filter((event) => event.event === "ping").length,
    over: () => over,
    leave: () => reader.cancel(),
  };
}

const settle = async (turns = 6) => {
  for (let index = 0; index < turns; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** A stream route under the test's hand: it says what the test writes, and records how it was left. */
function source() {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const state = { opened: [] as string[], aborted: false, cancelled: false };
  const open = (url: URL, signal: AbortSignal): Response => {
    state.opened.push(url.pathname + url.search);
    signal.addEventListener("abort", () => { state.aborted = true; });
    return new Response(new ReadableStream<Uint8Array>({
      start(streamController) { controller = streamController; },
      cancel() { state.cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } });
  };
  return {
    open,
    state,
    say: (text: string) => controller!.enqueue(encoder.encode(text)),
    end: () => controller!.close(),
  };
}

test("channels of one connection carry their routes' events, each under its own name", async () => {
  const id = connectionId();
  const reader = reading(openMuxConnection(id, new AbortController().signal));
  const logs = source();
  const runtime = source();
  const opener: MuxStreamOpener = (url, signal) => (url.pathname === "/api/logs/stream" ? logs : runtime).open(url, signal);

  expect(applyMuxOps(id, [
    { op: "open", id: "1", url: "/api/logs/stream?subs=%5B%5D" },
    { op: "open", id: "2", url: "/api/runtime/stream?after=40" },
  ], BASE, opener)).toBe("ok");
  await settle();
  logs.say("event: chunk\ndata: {\"id\":\"0\",\"chunk\":{}}\n\n");
  runtime.say("id: 41\ndata: {\"seq\":41}\n\n: heartbeat published=41\nevent: heartbeat\ndata: {\"publishedSeq\":41}\n\n");
  await settle();

  expect(logs.state.opened).toEqual(["/api/logs/stream?subs=%5B%5D"]);
  expect(runtime.state.opened).toEqual(["/api/runtime/stream?after=40"]);
  expect(reader.frames()).toEqual([
    "ready {}",
    "up \"1\"",
    "up \"2\"",
    "e 1 chunk {\"id\":\"0\",\"chunk\":{}}",
    "e 2 message {\"seq\":41}",
    "e 2 heartbeat {\"publishedSeq\":41}",
  ]);
  await reader.leave();
});

test("a closed channel stops its route, and a stream that ends says so", async () => {
  const id = connectionId();
  const reader = reading(openMuxConnection(id, new AbortController().signal));
  const first = source();
  const second = source();
  let opened = 0;
  const opener: MuxStreamOpener = (url, signal) => (opened++ === 0 ? first : second).open(url, signal);

  applyMuxOps(id, [{ op: "open", id: "1", url: "/api/logs/stream?subs=a" }], BASE, opener);
  await settle();
  /* The reader resubscribes: the same turn closes one stream and opens the next. */
  applyMuxOps(id, [{ op: "close", id: "1" }, { op: "open", id: "2", url: "/api/logs/stream?subs=b" }], BASE, opener);
  await settle();
  expect(first.state.aborted).toBe(true);
  expect(first.state.cancelled).toBe(true);
  expect(muxChannelsForTests(id)).toEqual(["2"]);

  second.say("event: chunk\ndata: late\n\n");
  second.end();
  await settle();
  /* A channel the reader closed ends without a word; one whose stream ended is reported, status 0. */
  expect(reader.frames()).toEqual(["ready {}", "up \"1\"", "up \"2\"", "e 2 chunk late", "end [\"2\",0]"]);
  expect(muxChannelsForTests(id)).toEqual([]);
  await reader.leave();
});

test("a route that refuses is reported with its status, and only stream routes are reachable", async () => {
  const id = connectionId();
  const reader = reading(openMuxConnection(id, new AbortController().signal));
  const asked: string[] = [];
  const opener: MuxStreamOpener = (url) => {
    asked.push(url.pathname);
    if (url.pathname === "/api/runtime/stream") return Response.json({ error: "runtime events are disabled" }, { status: 503 });
    if (url.pathname === "/api/logs/stream") throw new Error("the route broke");
    return Response.json({ ok: true });
  };
  applyMuxOps(id, [
    { op: "open", id: "1", url: "/api/runtime/stream?after=0" },
    { op: "open", id: "2", url: "/api/logs/stream?subs=x" },
    /* A stream route that answers with something that is not a stream. */
    { op: "open", id: "3", url: "/api/self-update/events" },
    { op: "open", id: "4", url: "/api/board?project=p" },
    { op: "open", id: "5", url: "http://elsewhere.example/api/logs/stream" },
    { op: "open", id: "6", url: "/api/logs/stream/../../tasks" },
  ], BASE, opener);
  await settle();
  expect(asked).toEqual(["/api/runtime/stream", "/api/logs/stream", "/api/self-update/events"]);
  expect(reader.frames().sort()).toEqual([
    "end [\"1\",503]",
    "end [\"2\",500]",
    "end [\"3\",502]",
    "end [\"4\",400]",
    "end [\"5\",400]",
    "end [\"6\",400]",
    "ready {}",
  ]);
  expect(muxChannelsForTests(id)).toEqual([]);
  await reader.leave();
});

test("a connection takes a bounded number of channels", async () => {
  const id = connectionId();
  const reader = reading(openMuxConnection(id, new AbortController().signal));
  const sources = Array.from({ length: MUX_MAX_CHANNELS + 1 }, source);
  let next = 0;
  applyMuxOps(id, sources.map((_, index) => ({ op: "open" as const, id: String(index), url: "/api/logs/stream?subs=x" })), BASE, (url, signal) => sources[next++]!.open(url, signal));
  await settle();
  expect(muxChannelsForTests(id)).toHaveLength(MUX_MAX_CHANNELS);
  expect(reader.frames()).toContain(`end ["${MUX_MAX_CHANNELS}",429]`);
  await reader.leave();
});

test("a reader that leaves takes every channel's route with it", async () => {
  const id = connectionId();
  const left = new AbortController();
  const reader = reading(openMuxConnection(id, left.signal));
  const logs = source();
  applyMuxOps(id, [{ op: "open", id: "1", url: "/api/logs/stream?subs=x" }], BASE, logs.open);
  await settle();

  left.abort();
  await settle();
  expect(logs.state.aborted).toBe(true);
  expect(logs.state.cancelled).toBe(true);
  expect(reader.over()).toBe(true);
  expect(muxChannelsForTests(id)).toBeNull();
  /* The connection is gone: a control request for it finds none, and the page opens another. */
  expect(applyMuxOps(id, [{ op: "close", id: "1" }], BASE, logs.open)).toBe("unknown-connection");
});

test("a connection nobody reads ends by itself, and one that is read does not", async () => {
  /* The reader is gone without the server being told: nothing takes the frames off the queue. */
  const abandoned = connectionId();
  const stream = openMuxConnection(abandoned, new AbortController().signal, 15);
  const logs = source();
  applyMuxOps(abandoned, [{ op: "open", id: "1", url: "/api/logs/stream?subs=x" }], BASE, logs.open);
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(muxChannelsForTests(abandoned)).toBeNull();
  expect(logs.state.aborted).toBe(true);
  void stream.cancel().catch(() => undefined);

  const read = connectionId();
  const reader = reading(openMuxConnection(read, new AbortController().signal, 15));
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(muxChannelsForTests(read)).toEqual([]);
  expect(reader.pings()).toBeGreaterThan(3);
  await reader.leave();
});

test("a channel reopened with its last event id hands it to its route and carries it until the route sets another", async () => {
  const id = connectionId();
  const stream = openMuxConnection(id, new AbortController().signal);
  const reader = stream.getReader();
  const parser = createSseParser();
  const decoder = new TextDecoder();
  const runtime = source();
  const resumedFrom: string[] = [];
  applyMuxOps(id, [{ op: "open", id: "1", url: "/api/runtime/stream?after=40", lastEventId: "41" }], BASE, (url, signal, lastEventId) => {
    resumedFrom.push(lastEventId);
    return runtime.open(url, signal);
  });
  await settle();
  runtime.say("event: heartbeat\ndata: {}\n\nid: 42\ndata: {\"seq\":42}\n\n");
  await settle();
  const events: SseEvent[] = [];
  while (events.filter((event) => event.event === "e").length < 2) {
    const { value } = await reader.read();
    events.push(...parser.push(decoder.decode(value, { stream: true })));
  }
  expect(resumedFrom).toEqual(["41"]);
  expect(events.filter((event) => event.event === "e").map((event) => decodeMuxEvent(event.data))).toEqual([
    { channel: "1", event: "heartbeat", id: "41", data: "{}" },
    { channel: "1", event: "message", id: "42", data: "{\"seq\":42}" },
  ]);
  await reader.cancel();
});
