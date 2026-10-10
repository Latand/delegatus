import { expect, test } from "bun:test";

import { createStreamMux, type EventStream, type StreamEvent, type StreamMuxDeps } from "./client";
import { encodeMuxEvent, createSseParser, type MuxOp } from "./protocol";

/** An EventSource under the test's hand. */
class FakeSource implements EventStream {
  onopen: ((event: StreamEvent) => void) | null = null;
  onerror: ((event: StreamEvent) => void) | null = null;
  onmessage: ((event: StreamEvent) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, Array<(event: StreamEvent) => void>>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: StreamEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void { this.closed = true; }
  /** The server sends an event of this name. */
  say(type: string, data: string, lastEventId = ""): void {
    if (type === "message") this.onmessage?.({ data, lastEventId });
    for (const listener of this.listeners.get(type) ?? []) listener({ data, lastEventId });
  }
  /** A source event of a channel, as the server frames it. */
  carry(channel: string, event: string, data: string, id = ""): void {
    const [frame] = createSseParser().push(encodeMuxEvent(channel, { event, data, id }));
    this.say("e", frame!.data);
  }
  fail(): void { this.onerror?.({ data: "" }); }
}

function harness() {
  const sources: FakeSource[] = [];
  const posts: Array<{ c: string; ops: MuxOp[] }> = [];
  const timers: Array<{ id: number; run: () => void; at: number }> = [];
  let now = 0;
  let nextTimer = 0;
  let nextId = 0;
  /* What the control route answers, in order; 200 once the list is empty. "later" leaves the request in
     flight until the test answers it. */
  const answers: Array<number | "later"> = [];
  const inFlight: Array<(status: number) => void> = [];
  /* What the route answers a bodiless GET that names no connection: 400 while it is there. */
  const probeAnswers: number[] = [];
  let probes = 0;
  const deps: StreamMuxDeps = {
    createEventSource: (url) => {
      const source = new FakeSource(url);
      sources.push(source);
      return source;
    },
    fetch: async (_url, init) => {
      if (init.method === "GET") {
        probes += 1;
        const status = probeAnswers.shift() ?? 400;
        if (status === 0) throw new Error("network");
        return { ok: false, status };
      }
      posts.push(JSON.parse(init.body!) as { c: string; ops: MuxOp[] });
      const answer = answers.shift() ?? 200;
      const status = answer === "later" ? await new Promise<number>((resolve) => { inFlight.push(resolve); }) : answer;
      if (status === 0) throw new Error("network");
      return { ok: status >= 200 && status < 300, status };
    },
    setTimeout: (run, ms) => {
      const id = ++nextTimer;
      timers.push({ id, run, at: now + ms });
      return id;
    },
    clearTimeout: (timer) => {
      const index = timers.findIndex((entry) => entry.id === timer);
      if (index !== -1) timers.splice(index, 1);
    },
    randomId: () => `connection-${String(++nextId).padStart(8, "0")}`,
  };
  const settle = async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  };
  return {
    mux: createStreamMux(deps),
    sources,
    posts,
    answers,
    inFlight,
    probeAnswers,
    probes: () => probes,
    settle,
    /** Lets time pass, running what came due in order. */
    advance: async (ms: number) => {
      const until = now + ms;
      for (;;) {
        const due = timers.filter((entry) => entry.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        now = due.at;
        due.run();
        await settle();
      }
      now = until;
    },
    /** The connections to the multiplexer, and the streams opened on connections of their own. */
    physical: () => sources.filter((source) => source.url.startsWith("/api/streams?c=")),
    plain: () => sources.filter((source) => !source.url.startsWith("/api/streams?c=")),
  };
}

/** What a reader saw of its stream. */
function watch(stream: EventStream, named: string[] = []) {
  const seen: string[] = [];
  stream.onopen = () => seen.push("open");
  stream.onerror = () => seen.push("error");
  stream.onmessage = (event) => seen.push(`message ${event.data} #${event.lastEventId}`);
  for (const name of named) stream.addEventListener(name, (event) => seen.push(`${name} ${event.data}`));
  return seen;
}

test("three streams of a page hold one connection, and each reads its own route", async () => {
  const h = harness();
  const logs = watch(h.mux.open("/api/logs/stream?subs=x"), ["chunk"]);
  const runtime = watch(h.mux.open("/api/runtime/stream?after=40"), ["heartbeat"]);
  const update = watch(h.mux.open("/api/self-update/events?work=0"), ["state"]);

  expect(h.sources).toHaveLength(1);
  const connection = h.physical()[0]!;
  expect(connection.url).toBe("/api/streams?c=connection-00000001");
  /* Nothing is asked of a connection before it says it is there. */
  expect(h.posts).toEqual([]);

  connection.say("ready", "{}");
  await h.settle();
  expect(h.posts).toEqual([{
    c: "connection-00000001",
    ops: [
      { op: "open", id: "1", url: "/api/logs/stream?subs=x" },
      { op: "open", id: "2", url: "/api/runtime/stream?after=40" },
      { op: "open", id: "3", url: "/api/self-update/events?work=0" },
    ],
  }]);

  for (const id of ["1", "2", "3"]) connection.say("up", JSON.stringify(id));
  connection.carry("1", "chunk", "{\"id\":\"0\"}");
  connection.carry("2", "message", "{\"seq\":41}", "41");
  connection.carry("2", "heartbeat", "{}");
  connection.carry("3", "state", "{\"version\":\"1\"}");
  expect(logs).toEqual(["open", "chunk {\"id\":\"0\"}"]);
  expect(runtime).toEqual(["open", "message {\"seq\":41} #41", "heartbeat {}"]);
  expect(update).toEqual(["open", "state {\"version\":\"1\"}"]);
  expect(h.sources).toHaveLength(1);
});

test("a reader that closes one stream and opens the next asks for both in one request", async () => {
  const h = harness();
  const first = h.mux.open("/api/logs/stream?subs=a");
  h.physical()[0]!.say("ready", "{}");
  await h.settle();
  h.posts.length = 0;

  first.close();
  const seen = watch(h.mux.open("/api/logs/stream?subs=b"), ["chunk"]);
  await h.settle();
  expect(h.posts).toEqual([{ c: "connection-00000001", ops: [{ op: "close", id: "1" }, { op: "open", id: "2", url: "/api/logs/stream?subs=b" }] }]);

  /* A frame still on its way for the closed stream reaches nobody. */
  h.physical()[0]!.carry("1", "chunk", "stale");
  h.physical()[0]!.carry("2", "chunk", "fresh");
  expect(seen).toEqual(["chunk fresh"]);
});

test("a stream that ended reopens after a pause; one the route refused stays closed", async () => {
  const h = harness();
  const ended = watch(h.mux.open("/api/self-update/events"));
  const refused = watch(h.mux.open("/api/runtime/stream?after=0"));
  const connection = h.physical()[0]!;
  connection.say("ready", "{}");
  await h.settle();
  h.posts.length = 0;

  connection.say("end", JSON.stringify(["1", 0]));
  connection.say("end", JSON.stringify(["2", 503]));
  expect(ended).toEqual(["error"]);
  expect(refused).toEqual(["error"]);

  await h.advance(3_000);
  expect(h.posts).toEqual([{ c: "connection-00000001", ops: [{ op: "open", id: "1", url: "/api/self-update/events" }] }]);
});

test("a connection that breaks says so to every stream and brings them back on the next one", async () => {
  const h = harness();
  const kept = watch(h.mux.open("/api/self-update/events"), ["state"]);
  const dropped = h.mux.open("/api/logs/stream?subs=x");
  /* This reader gives up its stream on the first error, as the log bus does. */
  dropped.onerror = () => dropped.close();
  h.physical()[0]!.say("ready", "{}");
  await h.settle();
  h.posts.length = 0;

  h.physical()[0]!.fail();
  expect(h.physical()[0]!.closed).toBe(true);
  expect(kept).toEqual(["error"]);

  await h.advance(500);
  expect(h.physical()).toHaveLength(2);
  expect(h.physical()[1]!.url).toBe("/api/streams?c=connection-00000002");
  h.physical()[1]!.say("ready", "{}");
  await h.settle();
  /* Only the stream its reader kept is asked for again, on the new connection. */
  expect(h.posts).toEqual([{ c: "connection-00000002", ops: [{ op: "open", id: "1", url: "/api/self-update/events" }] }]);
  h.physical()[1]!.carry("1", "state", "back");
  expect(kept).toEqual(["error", "state back"]);
});

test("a connection the server no longer knows, or one gone quiet, is replaced", async () => {
  const h = harness();
  const seen = watch(h.mux.open("/api/self-update/events"));
  h.answers.push(404);
  h.physical()[0]!.say("ready", "{}");
  await h.settle();
  expect(h.physical()[0]!.closed).toBe(true);
  expect(seen).toEqual(["error"]);

  await h.advance(500);
  h.physical()[1]!.say("ready", "{}");
  await h.settle();
  expect(h.posts.at(-1)).toEqual({ c: "connection-00000002", ops: [{ op: "open", id: "1", url: "/api/self-update/events" }] });

  /* Pings keep it; three missed and it is taken for dead. */
  await h.advance(30_000);
  h.physical()[1]!.say("ping", "{}");
  await h.advance(30_000);
  expect(h.physical()[1]!.closed).toBe(false);
  await h.advance(5_000);
  expect(h.physical()[1]!.closed).toBe(true);
  expect(seen).toEqual(["error", "error"]);
});

test("a server with no stream route gives each stream a connection of its own", async () => {
  const h = harness();
  const seen = watch(h.mux.open("/api/runtime/stream?after=0"), ["heartbeat"]);
  /* The route answers 404: the connection fails before it ever says ready. */
  h.physical()[0]!.fail();
  await h.advance(500);
  h.physical()[1]!.fail();
  await h.advance(1_000);
  h.physical()[2]!.fail();

  expect(h.physical().every((source) => source.closed)).toBe(true);
  expect(h.plain().map((source) => source.url)).toEqual(["/api/runtime/stream?after=0"]);
  const own = h.plain()[0]!;
  own.onopen?.({ data: "" });
  own.say("message", "{\"seq\":1}", "1");
  own.say("heartbeat", "{}");
  expect(seen.slice(2)).toEqual(["open", "message {\"seq\":1} #1", "heartbeat {}"]);

  /* From then on the page asks for no connection at all. */
  const later = h.mux.open("/api/logs/stream?subs=x");
  expect(h.physical()).toHaveLength(3);
  expect(h.plain().map((source) => source.url)).toEqual(["/api/runtime/stream?after=0", "/api/logs/stream?subs=x"]);
  later.close();
  expect(h.plain()[1]!.closed).toBe(true);
});

test("a reader the control request is refused to reads its streams the plain way", async () => {
  const h = harness();
  const seen = watch(h.mux.open("/api/self-update/events"), ["state"]);
  h.answers.push(401);
  h.physical()[0]!.say("ready", "{}");
  await h.settle();
  expect(h.physical()[0]!.closed).toBe(true);
  expect(h.plain().map((source) => source.url)).toEqual(["/api/self-update/events"]);
  h.plain()[0]!.say("state", "{}");
  expect(seen).toEqual(["state {}"]);
});

test("a control request that fails is tried again before the connection is given up", async () => {
  const h = harness();
  h.mux.open("/api/self-update/events");
  h.answers.push(503, 0);
  h.physical()[0]!.say("ready", "{}");
  await h.settle();
  await h.advance(2_000);
  expect(h.posts).toHaveLength(3);
  expect(h.physical()[0]!.closed).toBe(false);
});

test("a connection that breaks while a control request is in flight is reported once", async () => {
  const h = harness();
  const seen = watch(h.mux.open("/api/self-update/events"));
  h.answers.push("later");
  h.physical()[0]!.say("ready", "{}");
  await h.settle();
  expect(h.inFlight).toHaveLength(1);

  h.physical()[0]!.fail();
  expect(seen).toEqual(["error"]);
  /* The request comes back about a connection that is gone: the server no longer knows it. */
  h.inFlight[0]!(404);
  await h.settle();
  expect(seen).toEqual(["error"]);

  await h.advance(500);
  expect(h.physical()).toHaveLength(2);
  h.physical()[1]!.say("ready", "{}");
  await h.settle();
  expect(h.posts.at(-1)).toEqual({ c: "connection-00000002", ops: [{ op: "open", id: "1", url: "/api/self-update/events" }] });
});

test("the connection closes once no stream needs it", async () => {
  const h = harness();
  const only = h.mux.open("/api/self-update/events");
  h.physical()[0]!.say("ready", "{}");
  await h.settle();
  only.close();
  await h.settle();
  expect(h.physical()[0]!.closed).toBe(false);
  await h.advance(2_000);
  expect(h.physical()[0]!.closed).toBe(true);

  h.mux.open("/api/self-update/events");
  expect(h.physical()).toHaveLength(2);
});

test("a reader that throws breaks only its own stream", async () => {
  const h = harness();
  const broken = h.mux.open("/api/logs/stream?subs=x");
  broken.addEventListener("chunk", () => { throw new Error("reader bug"); });
  const seen = watch(h.mux.open("/api/self-update/events"), ["state"]);
  h.physical()[0]!.say("ready", "{}");
  await h.settle();
  h.physical()[0]!.carry("1", "chunk", "x");
  h.physical()[0]!.carry("2", "state", "fine");
  expect(seen).toEqual(["state fine"]);
});

test("a reopened channel resumes from its own last event id, on a new connection and after its stream ended", async () => {
  const h = harness();
  const runtime = watch(h.mux.open("/api/runtime/stream?after=40"));
  const logs = watch(h.mux.open("/api/logs/stream?subs=x"), ["chunk"]);
  const update = h.mux.open("/api/self-update/events");
  h.physical()[0]!.say("ready", "{}");
  await h.settle();
  h.physical()[0]!.carry("1", "message", "{\"seq\":41}", "41");
  h.physical()[0]!.carry("2", "chunk", "a", "log-7");
  /* The update feed set an id and then cleared it: an EventSource sends none after that. */
  h.physical()[0]!.carry("3", "state", "{}", "3");
  h.physical()[0]!.carry("3", "state", "{}", "");
  expect(runtime).toEqual(["message {\"seq\":41} #41"]);
  expect(logs).toEqual(["chunk a"]);
  void update;

  h.physical()[0]!.fail();
  await h.advance(500);
  h.physical()[1]!.say("ready", "{}");
  await h.settle();
  expect(h.posts.at(-1)).toEqual({
    c: "connection-00000002",
    ops: [
      { op: "open", id: "1", url: "/api/runtime/stream?after=40", lastEventId: "41" },
      { op: "open", id: "2", url: "/api/logs/stream?subs=x", lastEventId: "log-7" },
      { op: "open", id: "3", url: "/api/self-update/events" },
    ],
  });

  h.physical()[1]!.carry("1", "message", "{\"seq\":42}", "42");
  h.physical()[1]!.say("end", JSON.stringify(["1", 0]));
  await h.advance(3_000);
  expect(h.posts.at(-1)).toEqual({ c: "connection-00000002", ops: [{ op: "open", id: "1", url: "/api/runtime/stream?after=40", lastEventId: "42" }] });
});

test("a page whose connection worked falls back to plain streams once the route is gone", async () => {
  const h = harness();
  const seen = watch(h.mux.open("/api/runtime/stream?after=0"), ["heartbeat"]);
  h.physical()[0]!.say("ready", "{}");
  await h.settle();
  h.physical()[0]!.carry("1", "heartbeat", "{}");

  /* A rollback to LLV_STREAM_MUX=0: every later connection fails, and the route answers 404. */
  h.probeAnswers.push(404, 404, 404);
  h.physical()[0]!.fail();
  await h.advance(500);
  h.physical()[1]!.fail();
  await h.advance(1_000);
  expect(h.plain()).toHaveLength(0);
  h.physical()[2]!.fail();
  await h.settle();

  expect(h.probes()).toBe(1);
  expect(h.physical().every((source) => source.closed)).toBe(true);
  expect(h.plain().map((source) => source.url)).toEqual(["/api/runtime/stream?after=0"]);
  h.plain()[0]!.say("heartbeat", "{}");
  expect(seen.at(-1)).toBe("heartbeat {}");
  await h.advance(60_000);
  expect(h.physical()).toHaveLength(3);
});

test("a page whose connection worked keeps reconnecting while the route is still there", async () => {
  const h = harness();
  const seen = watch(h.mux.open("/api/self-update/events"), ["state"]);
  h.physical()[0]!.say("ready", "{}");
  await h.settle();

  /* A restart: connections fail for a while; the route, when it answers at all, is there. */
  h.probeAnswers.push(0, 502, 400, 400);
  h.physical()[0]!.fail();
  for (let index = 1; index <= 5; index += 1) {
    await h.advance(8_000);
    h.physical()[index]!.fail();
    await h.settle();
  }
  expect(h.probes()).toBeGreaterThanOrEqual(3);
  expect(h.plain()).toHaveLength(0);

  await h.advance(8_000);
  h.physical()[6]!.say("ready", "{}");
  await h.settle();
  expect(h.posts.at(-1)).toEqual({ c: "connection-00000007", ops: [{ op: "open", id: "1", url: "/api/self-update/events" }] });
  h.physical()[6]!.carry("1", "state", "back");
  expect(seen.at(-1)).toBe("state back");
});
