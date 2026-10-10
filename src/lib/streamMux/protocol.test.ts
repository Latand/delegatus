import { expect, test } from "bun:test";

import { createSseParser, decodeMuxEvent, encodeMuxEvent, parseMuxOps } from "./protocol";

test("events are read as an EventSource reads them", () => {
  const parser = createSseParser();
  const events = [
    ...parser.push(": a comment an EventSource never shows\n"),
    ...parser.push("id: 7\ndata: {\"seq\":7}\n\n"),
    ...parser.push("event: chunk\ndata: first line\ndata: second line\n\n"),
    /* An event with no data line is dropped; the id it set stays. */
    ...parser.push("event: lonely\nid: 9\n\n"),
    ...parser.push("event: heartbeat\r\ndata: {}\r\n\r\n"),
    /* A data line that is empty still makes an event. */
    ...parser.push("data:\n\n"),
  ];
  expect(events).toEqual([
    { event: "message", data: "{\"seq\":7}", id: "7" },
    { event: "chunk", data: "first line\nsecond line", id: "7" },
    { event: "heartbeat", data: "{}", id: "9" },
    { event: "message", data: "", id: "9" },
  ]);
});

test("an event split across reads arrives whole, once", () => {
  const parser = createSseParser();
  const text = "event: state\ndata: {\"version\":\"1.2.3\"}\n\nid: 4\ndata: tail\n\n";
  const events = [];
  for (const character of text) events.push(...parser.push(character));
  expect(events).toEqual([
    { event: "state", data: "{\"version\":\"1.2.3\"}", id: "" },
    { event: "message", data: "tail", id: "4" },
  ]);
});

test("a frame carries the source event's name, id and data lines unchanged", () => {
  const source = { event: "chunk", data: "{\"id\":\"0\"}\nsecond \"line\"\n", id: "41" };
  const frame = encodeMuxEvent("3", source);
  /* What the reader's EventSource hands over is the frame's data lines joined by newlines. */
  const [carried] = createSseParser().push(frame);
  expect(carried!.event).toBe("e");
  expect(decodeMuxEvent(carried!.data)).toEqual({ channel: "3", ...source });

  expect(decodeMuxEvent("no header line")).toBeNull();
  expect(decodeMuxEvent("[\"3\",7,\"\"]\npayload")).toBeNull();
});

test("a control request names its connection and its channels, or it is not one", () => {
  const c = "abcdefghijklmnop";
  expect(parseMuxOps({ c, ops: [{ op: "open", id: "1", url: "/api/runtime/stream?after=4" }, { op: "close", id: "2" }] })).toEqual({
    connection: c,
    ops: [{ op: "open", id: "1", url: "/api/runtime/stream?after=4" }, { op: "close", id: "2" }],
  });
  for (const body of [
    null,
    { c: "short", ops: [{ op: "close", id: "1" }] },
    { c, ops: [] },
    { c, ops: [{ op: "open", id: "1" }] },
    { c, ops: [{ op: "open", id: "has space", url: "/api/runtime/stream" }] },
    { c, ops: [{ op: "steal", id: "1" }] },
    { c, ops: Array.from({ length: 33 }, () => ({ op: "close", id: "1" })) },
    { c, ops: [{ op: "open", id: "1", url: "/api/runtime/stream", lastEventId: 41 }] },
    { c, ops: [{ op: "open", id: "1", url: "/api/runtime/stream", lastEventId: "" }] },
    { c, ops: [{ op: "open", id: "1", url: "/api/runtime/stream", lastEventId: "41\r\nx-injected: 1" }] },
    { c, ops: [{ op: "open", id: "1", url: "/api/runtime/stream", lastEventId: "4\u00001" }] },
    { c, ops: [{ op: "open", id: "1", url: "/api/runtime/stream", lastEventId: "4".repeat(1025) }] },
  ]) expect(parseMuxOps(body)).toBeNull();
});

test("a channel reopened with its last event id carries it, and the stream continues from it", () => {
  const c = "abcdefghijklmnop";
  expect(parseMuxOps({ c, ops: [{ op: "open", id: "1", url: "/api/runtime/stream?after=40", lastEventId: "41" }] })).toEqual({
    connection: c,
    ops: [{ op: "open", id: "1", url: "/api/runtime/stream?after=40", lastEventId: "41" }],
  });
  const parser = createSseParser("41");
  expect(parser.push("data: same stream\n\nid: 42\ndata: next\n\nid:\ndata: reset\n\n")).toEqual([
    { event: "message", data: "same stream", id: "41" },
    { event: "message", data: "next", id: "42" },
    { event: "message", data: "reset", id: "" },
  ]);
});
