import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, spyOn, test } from "bun:test";

import type { RuntimeEvent } from "./engineHost";
import { durableRuntimeEventTailSeq, FileRuntimeEventStore, readHostTurnRecord, reconcileRuntimeEventCursor } from "./eventStore";
import { streamingVoiceDelivery } from "./voiceDelivery";

test("runtime event store durably replays ordered events and ignores a partial tail", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-events-"));
  const store = new FileRuntimeEventStore(directory);
  store.append("thread/unsafe", { kind: "session-status", status: "idle", seq: 1 });
  store.append("thread/unsafe", { kind: "turn-started", turnId: "turn-1", seq: 2 });
  const filename = path.join(directory, "thread%2Funsafe.jsonl");
  fs.appendFileSync(filename, "{partial");
  store.append("thread/unsafe", { kind: "turn-ended", turnId: "turn-1", status: "completed", seq: 3 });

  expect(store.load("thread/unsafe")).toEqual([
    { kind: "session-status", status: "idle", seq: 1 },
    { kind: "turn-started", turnId: "turn-1", seq: 2 },
    { kind: "turn-ended", turnId: "turn-1", status: "completed", seq: 3 },
  ]);
  expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
});

test("runtime event store durably replays realtime delivery progress and acknowledgement", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-voice-delivery-"));
  const store = new FileRuntimeEventStore(directory);
  store.append("voice-thread", {
    kind: "realtime-delivery-progress",
    deliveryId: "delivery-one",
    digest: "digest-one",
    responseIndex: 1,
    offset: 17,
    seq: 1,
  });
  store.append("voice-thread", {
    kind: "realtime-delivery-acknowledged",
    deliveryId: "delivery-one",
    digest: "digest-one",
    seq: 2,
  });

  expect(new FileRuntimeEventStore(directory).load("voice-thread")).toEqual([
    {
      kind: "realtime-delivery-progress",
      deliveryId: "delivery-one",
      digest: "digest-one",
      responseIndex: 1,
      offset: 17,
      seq: 1,
    },
    {
      kind: "realtime-delivery-acknowledged",
      deliveryId: "delivery-one",
      digest: "digest-one",
      seq: 2,
    },
  ]);
});

test("runtime event store durably replays a bounded streaming voice chunk", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-voice-chunk-"));
  const store = new FileRuntimeEventStore(directory);
  const delivery = streamingVoiceDelivery({
    sourceTurnId: "turn-voice",
    chunkIndex: 0,
    startOffset: 0,
    endOffset: 18,
    text: "A complete phrase.",
  });

  store.append("voice-thread", {
    kind: "voice-chunk",
    turnId: "turn-voice",
    delivery,
    seq: 1,
  });

  expect(new FileRuntimeEventStore(directory).load("voice-thread")).toEqual([{
    kind: "voice-chunk",
    turnId: "turn-voice",
    delivery,
    seq: 1,
  }]);
});

test("runtime event store repairs a crash tail after the production 942-record contiguous prefix", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-crash-tail-"));
  const filename = path.join(directory, "crash-tail.jsonl");
  const prefix = Array.from({ length: 942 }, (_, index) => JSON.stringify({
    kind: "session-status",
    status: "idle",
    seq: index + 1,
  })).join("\n");
  fs.writeFileSync(filename, `${prefix}\n{\"kind\":\"session-status\",\"status\":`, { mode: 0o600 });
  const store = new FileRuntimeEventStore(directory);

  store.append("crash-tail", { kind: "turn-started", turnId: "recovered-turn", seq: 943 });

  const restored = store.load("crash-tail");
  expect(restored).toHaveLength(943);
  expect(restored.slice(-2)).toEqual([
    { kind: "session-status", status: "idle", seq: 942 },
    { kind: "turn-started", turnId: "recovered-turn", seq: 943 },
  ]);
  expect(fs.readFileSync(filename, "utf8").endsWith("\n")).toBeTrue();
});

test("runtime event store fails closed on gaps, duplicates, and malformed middle records", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-event-gaps-"));
  const filename = path.join(directory, "gap-thread.jsonl");
  fs.writeFileSync(filename, [
    JSON.stringify({ kind: "session-status", status: "idle", seq: 1 }),
    JSON.stringify({ kind: "turn-ended", turnId: "turn-1", status: "completed", seq: 3 }),
    "",
  ].join("\n"));
  const store = new FileRuntimeEventStore(directory);
  expect(() => store.load("gap-thread")).toThrow("sequence gap after 1");

  fs.writeFileSync(filename, [
    JSON.stringify({ kind: "session-status", status: "idle", seq: 1 }),
    JSON.stringify({ kind: "session-status", status: "active", seq: 1 }),
    "",
  ].join("\n"));
  expect(() => store.load("gap-thread")).toThrow("sequence gap after 1");

  fs.writeFileSync(filename, `${JSON.stringify({ kind: "session-status", status: "idle", seq: 1 })}\n{broken}\n`);
  expect(() => store.load("gap-thread")).toThrow("malformed JSON");
});

test("runtime event store appends without re-reading the owned ledger (#367 live-turn starvation)", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-event-hot-"));
  const store = new FileRuntimeEventStore(directory);
  store.append("hot-thread", { kind: "session-status", status: "idle", seq: 1 });

  const reads = spyOn(fs, "readFileSync");
  try {
    for (let seq = 2; seq <= 200; seq += 1) {
      store.append("hot-thread", { kind: "delta", turnId: "turn-1", text: "streamed structured output", seq });
    }
    expect(reads.mock.calls.length).toBe(0);
  } finally {
    reads.mockRestore();
  }
  const events = store.load("hot-thread");
  expect(events).toHaveLength(200);
  expect(events.at(-1)).toEqual({ kind: "delta", turnId: "turn-1", text: "streamed structured output", seq: 200 });
});

test("runtime event store reuses a stable ledger across repeated host instances", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-event-adoption-"));
  const filename = path.join(directory, "adopted-thread.jsonl");
  fs.writeFileSync(filename, [
    JSON.stringify({ kind: "session-status", status: "idle", seq: 1 }),
    JSON.stringify({ kind: "turn-started", turnId: "turn-1", seq: 2 }),
    "",
  ].join("\n"), { mode: 0o600 });

  const reads = spyOn(fs, "readFileSync");
  try {
    expect(new FileRuntimeEventStore(directory).load("adopted-thread")).toHaveLength(2);
    expect(new FileRuntimeEventStore(directory).load("adopted-thread")).toHaveLength(2);
    new FileRuntimeEventStore(directory).append("adopted-thread", {
      kind: "turn-ended",
      turnId: "turn-1",
      status: "completed",
      seq: 3,
    });
    expect(reads.mock.calls.filter(([target]) => target === filename)).toHaveLength(1);
  } finally {
    reads.mockRestore();
  }
});

test("runtime event store derives its durable tail once and re-reconciles only on external divergence", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-event-tail-"));
  const filename = path.join(directory, "owned-thread.jsonl");
  fs.writeFileSync(filename, [
    JSON.stringify({ kind: "session-status", status: "idle", seq: 1 }),
    JSON.stringify({ kind: "turn-started", turnId: "turn-1", seq: 2 }),
    "",
  ].join("\n"), { mode: 0o600 });

  const store = new FileRuntimeEventStore(directory);
  expect(() => store.append("owned-thread", { kind: "turn-ended", turnId: "turn-1", status: "completed", seq: 4 }))
    .toThrow("sequence gap after 2");
  store.append("owned-thread", { kind: "turn-ended", turnId: "turn-1", status: "completed", seq: 3 });

  fs.writeFileSync(filename, `${JSON.stringify({ kind: "session-status", status: "idle", seq: 1 })}\n`, { mode: 0o600 });
  store.append("owned-thread", { kind: "turn-started", turnId: "turn-2", seq: 2 });

  expect(store.load("owned-thread")).toEqual([
    { kind: "session-status", status: "idle", seq: 1 },
    { kind: "turn-started", turnId: "turn-2", seq: 2 },
  ]);
});

test("runtime event store rejects a non-contiguous append", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-event-append-"));
  const store = new FileRuntimeEventStore(directory);
  store.append("append-thread", { kind: "session-status", status: "idle", seq: 1 });
  expect(() => store.append("append-thread", { kind: "turn-started", turnId: "turn-3", seq: 3 }))
    .toThrow("sequence gap after 1");
  expect(store.load("append-thread")).toEqual([{ kind: "session-status", status: "idle", seq: 1 }]);
});

test.each([2_906, 2_908])("runtime cursor recovery diagnoses registry cursor %i against durable tail 2907", (registryCursor) => {
  const diagnostics: unknown[] = [];
  const cursor = reconcileRuntimeEventCursor(
    "019f64a8-cfee-\x37b20-9a5a-259f13192ed1",
    2_907,
    registryCursor,
    (diagnostic) => diagnostics.push(diagnostic),
  );

  expect(cursor).toBe(2_907);
  expect(diagnostics).toEqual([{
    kind: "runtime-event-cursor-recovery",
    sessionId: "019f64a8-cfee-\x37b20-9a5a-259f13192ed1",
    durableTailSeq: 2_907,
    registryCursor,
    chosenNextSeq: 2_908,
    action: "use-durable-tail",
    relation: registryCursor < 2_907 ? "registry-behind" : "registry-ahead",
  }]);
});

test("runtime cursor recovery retains an established registry watermark when the durable ledger is empty", () => {
  const diagnostics: unknown[] = [];

  expect(reconcileRuntimeEventCursor("legacy-session", 0, 12, (diagnostic) => diagnostics.push(diagnostic))).toBe(12);
  expect(diagnostics).toEqual([expect.objectContaining({
    sessionId: "legacy-session",
    durableTailSeq: 0,
    registryCursor: 12,
    chosenNextSeq: 13,
    action: "use-registry-cursor",
    relation: "durable-ledger-empty",
  })]);
});

test("runtime cursor diagnostics stay bounded and cannot fail ledger recovery", () => {
  const diagnostics: Array<{ sessionId: string }> = [];
  const cursor = reconcileRuntimeEventCursor("s".repeat(500), 2_907, 2_908, (value) => {
    diagnostics.push(value);
    throw new Error("diagnostic sink unavailable");
  });

  expect(cursor).toBe(2_907);
  expect(diagnostics[0]?.sessionId).toHaveLength(160);
});

test.each([
  { durableTailSeq: Number.MAX_SAFE_INTEGER, registryCursor: Number.MAX_SAFE_INTEGER },
  { durableTailSeq: 0, registryCursor: Number.MAX_SAFE_INTEGER },
])("runtime cursor recovery rejects an exhausted authoritative cursor", ({ durableTailSeq, registryCursor }) => {
  expect(() => reconcileRuntimeEventCursor("exhausted-session", durableTailSeq, registryCursor))
    .toThrow("runtime event cursor cannot advance safely");
});

test.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "runtime cursor recovery rejects invalid registry cursor %p",
  (registryCursor) => {
    expect(() => reconcileRuntimeEventCursor("invalid-cursor", 0, registryCursor))
      .toThrow("runtime event registry cursor is invalid");
  },
);

test.each([1.5, Number.MAX_SAFE_INTEGER + 1])("runtime event store rejects unsafe append sequence %p", (seq) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-event-unsafe-append-"));
  const store = new FileRuntimeEventStore(directory);
  expect(() => store.append("unsafe-append", { kind: "session-status", status: "idle", seq } as RuntimeEvent))
    .toThrow("runtime event ledger append event is invalid");
  expect(store.load("unsafe-append")).toEqual([]);
});

test("runtime event store rejects every structurally invalid event variant", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-event-shapes-"));
  const filename = path.join(directory, "shape-thread.jsonl");
  const store = new FileRuntimeEventStore(directory);
  const invalid = [
    { kind: "unknown", seq: 1 },
    { kind: "turn-started", seq: 1 },
    { kind: "turn-started", turnId: "", seq: 1 },
    { kind: "delta", turnId: "turn-1", seq: 1 },
    { kind: "delta", turnId: "", text: "chunk", seq: 1 },
    { kind: "item", turnId: "turn-1", phase: "completed", seq: 1 },
    { kind: "item", turnId: "", item: {}, phase: "completed", seq: 1 },
    { kind: "voice-chunk", turnId: "turn-1", delivery: {}, seq: 1 },
    {
      kind: "voice-chunk",
      turnId: "turn-other",
      delivery: streamingVoiceDelivery({
        sourceTurnId: "turn-1",
        chunkIndex: 0,
        startOffset: 0,
        endOffset: 5,
        text: "hello",
      }),
      seq: 1,
    },
    { kind: "turn-ended", turnId: "turn-1", status: "success", seq: 1 },
    { kind: "attention", id: "approval-1", attention: {}, seq: 1 },
    { kind: "attention", id: "", method: "approval", attention: {}, seq: 1 },
    { kind: "attention-resolved", id: "approval-1", resolution: "unknown", seq: 1 },
    { kind: "limits", seq: 1 },
    { kind: "session-status", status: "active", activeFlags: [42], seq: 1 },
    { kind: "session-status", status: "active", activeFlags: [""], seq: 1 },
  ];
  for (const event of invalid) {
    fs.writeFileSync(filename, `${JSON.stringify(event)}\n`);
    expect(() => store.load("shape-thread")).toThrow("invalid event");
  }
});

test("the durable event tail reports the last complete record and separates unknown from empty", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-event-tail-"));
  const store = new FileRuntimeEventStore(directory);
  /* A ledger nobody has written is empty, and empty is a fact: a determined 0,
     never an undetermined answer. */
  expect(durableRuntimeEventTailSeq("thread-missing", directory)).toEqual({ determined: true, value: 0 });

  store.append("thread-tail", { kind: "session-status", status: "idle", seq: 1 });
  store.append("thread-tail", { kind: "turn-started", turnId: "turn-1", seq: 2 });
  expect(durableRuntimeEventTailSeq("thread-tail", directory)).toEqual({ determined: true, value: 2 });

  /* A torn append is not durable, so the tail is the last complete record. */
  fs.appendFileSync(path.join(directory, "thread-tail.jsonl"), '{"kind":"delta","turnId":"turn-1"');
  expect(durableRuntimeEventTailSeq("thread-tail", directory)).toEqual({ determined: true, value: 2 });

  /* A tail that is not an event at all is undetermined, and a caller deciding
     whether a host may be retired must not read that as nothing. */
  fs.writeFileSync(path.join(directory, "thread-broken.jsonl"), "not json\n");
  expect(durableRuntimeEventTailSeq("thread-broken", directory)).toMatchObject({ determined: false });

  /* A file holding only an unterminated append holds no complete record, and
     that too is a fact rather than an unknown. */
  fs.writeFileSync(path.join(directory, "thread-torn-only.jsonl"), '{"kind":"delta"');
  expect(durableRuntimeEventTailSeq("thread-torn-only", directory)).toEqual({ determined: true, value: 0 });
});

test("a final record larger than the probe's read step is still read, not reported unknown", () => {
  /* #747 round 3: the probe read a fixed 64 KiB window and gave up when it held
     no complete line, so a WELL-FORMED ledger whose last record was bigger than
     the window answered "unknown" — and unknown is an input the retirement
     predicate has to refuse on, permanently, for that ledger. The scan steps
     backwards to the record boundary instead, so record size is not a limit. */
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-event-tail-large-"));
  const store = new FileRuntimeEventStore(directory);
  store.append("thread-large", { kind: "session-status", status: "idle", seq: 1 });
  store.append("thread-large", {
    kind: "delta",
    turnId: "turn-1",
    /* 200 KiB, past the old window by more than three times. */
    text: "x".repeat(200 * 1024),
    seq: 2,
  });
  expect(fs.statSync(path.join(directory, "thread-large.jsonl")).size).toBeGreaterThan(200 * 1024);
  expect(durableRuntimeEventTailSeq("thread-large", directory)).toEqual({ determined: true, value: 2 });

  /* And when the big record is the only one, so the scan runs off the front of
     the file rather than finding a preceding boundary. */
  store.append("thread-only-large", { kind: "delta", turnId: "turn-1", text: "y".repeat(200 * 1024), seq: 1 });
  expect(durableRuntimeEventTailSeq("thread-only-large", directory)).toEqual({ determined: true, value: 1 });
});

/* The host's own turn record, as restart cut recognition reads it
   (docs/design/restart-cut-recognition.md). */
function turnLedger(events: Array<Record<string, unknown>>): { directory: string; filename: string; store: FileRuntimeEventStore } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-host-turn-record-"));
  const store = new FileRuntimeEventStore(directory);
  events.forEach((event, index) => store.append("session", { ...event, seq: index + 1 } as RuntimeEvent));
  return { directory, filename: path.join(directory, "session.jsonl"), store };
}

function frame(uuid: string, type: "user" | "assistant", turnId: string | null): Record<string, unknown> {
  return { kind: "item", turnId, phase: "completed", item: { type, uuid, timestamp: "2026-10-07T00:00:00.000Z", message: { content: "x" } } };
}

test("the host turn record of a session with no ledger is absent", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-host-turn-record-"));
  expect(readHostTurnRecord("session", { directory })).toEqual({ state: "absent" });
});

test.each([
  { closed: "a turn-ended for it", events: [{ kind: "turn-ended", turnId: "T1", status: "completed" }], by: "turn-ended", status: "completed" },
  { closed: "an adopting host's error end", events: [{ kind: "turn-ended", turnId: "T1", status: "error" }], by: "turn-ended", status: "error" },
  { closed: "the host stopping hosting", events: [{ kind: "session-status", status: "unhosted" }], by: "session-status", status: null },
  { closed: "the host dying", events: [{ kind: "session-status", status: "dead" }], by: "session-status", status: null },
] as const)("the host turn record reads a turn closed by $closed", ({ events, by, status }) => {
  const { directory } = turnLedger([{ kind: "turn-started", turnId: "T1" }, ...events]);
  expect(readHostTurnRecord("session", { directory })).toMatchObject({
    state: "read", turn: { turnId: "T1", closed: { by, status } },
  });
});

test("the host turn record reads the newest turn open, with the frames recorded before and after its start", () => {
  const { directory, filename } = turnLedger([
    { kind: "turn-started", turnId: "T1" },
    frame("u1", "user", "T1"),
    { kind: "delta", turnId: "T1", text: "thinking" },
    frame("a1", "assistant", "T1"),
    { kind: "turn-ended", turnId: "T1", status: "completed" },
    { kind: "session-status", status: "idle" },
    frame("a2", "assistant", null),
    { kind: "turn-started", turnId: "T2" },
    frame("u3", "user", "T2"),
  ]);
  const read = readHostTurnRecord("session", { directory });
  expect(read).toMatchObject({
    state: "read",
    turn: { turnId: "T2", closed: null },
    framesBefore: [
      { uuid: "u1", type: "user", turnId: "T1" },
      { uuid: "a1", type: "assistant", turnId: "T1" },
      { uuid: "a2", type: "assistant", turnId: null },
    ],
    framesAfter: [{ uuid: "u3", type: "user", turnId: "T2" }],
  });
  if (read.state !== "read") throw new Error("the ledger was not read");
  expect(read.mtimeMs).toBe(fs.statSync(filename).mtimeMs);
});

test("a host turn record read without frames stops at the newest turn's start", () => {
  const { directory } = turnLedger([
    { kind: "turn-started", turnId: "T1" },
    frame("a1", "assistant", "T1"),
    { kind: "turn-ended", turnId: "T1", status: "completed" },
    { kind: "turn-started", turnId: "T2" },
    { kind: "delta", turnId: "T2", text: "thinking" },
  ]);
  expect(readHostTurnRecord("session", { directory, frames: false })).toMatchObject({
    state: "read", turn: { turnId: "T2", closed: null }, framesBefore: [], framesAfter: [],
  });
});

test("the host turn record splits frames at the event that closed the turn, and reads a ledger with no turn", () => {
  const closed = turnLedger([
    { kind: "turn-started", turnId: "T1" },
    frame("a1", "assistant", "T1"),
    { kind: "turn-ended", turnId: "T1", status: "completed" },
    frame("a2", "assistant", null),
  ]);
  expect(readHostTurnRecord("session", { directory: closed.directory })).toMatchObject({
    state: "read", turn: { turnId: "T1", closed: { by: "turn-ended", status: "completed" } },
    framesBefore: [{ uuid: "a1" }], framesAfter: [{ uuid: "a2", turnId: null }],
  });
  const none = turnLedger([{ kind: "session-status", status: "idle" }]);
  expect(readHostTurnRecord("session", { directory: none.directory })).toMatchObject({ state: "read", turn: null });
});

test("the host turn record ignores a torn final line and refuses a malformed complete record", () => {
  const torn = turnLedger([{ kind: "turn-started", turnId: "T1" }]);
  fs.appendFileSync(torn.filename, '{"kind":"turn-ended","turnId":"T1","sta');
  expect(readHostTurnRecord("session", { directory: torn.directory })).toMatchObject({
    state: "read", turn: { turnId: "T1", closed: null },
  });
  const malformed = turnLedger([{ kind: "turn-started", turnId: "T1" }]);
  fs.appendFileSync(malformed.filename, '{"kind":"turn-ended","turnId":\n');
  expect(readHostTurnRecord("session", { directory: malformed.directory }).state).toBe("unreadable");
});

test.each([
  { shape: "a gap where the turn's end could be", seqs: [1, 3], events: [{ kind: "turn-started", turnId: "T1" }, { kind: "session-status", status: "idle" }] },
  { shape: "a repeated sequence", seqs: [1, 2, 2], events: [{ kind: "turn-started", turnId: "T1" }, { kind: "session-status", status: "idle" }, { kind: "session-status", status: "idle" }] },
  { shape: "a gap among the skipped deltas", seqs: [1, 2, 4, 5], events: [{ kind: "turn-started", turnId: "T1" }, { kind: "delta", turnId: "T1", text: "a" }, { kind: "delta", turnId: "T1", text: "\"seq\":3}" }, { kind: "session-status", status: "idle" }] },
  { shape: "an invalid event", seqs: [1, 2], events: [{ kind: "turn-started", turnId: "T1" }, { kind: "session-status", status: "asleep" }] },
  { shape: "a record with no sequence", seqs: [1, null], events: [{ kind: "turn-started", turnId: "T1" }, { kind: "session-status", status: "idle" }] },
] as const)("a host turn record holding $shape is unreadable, as the store's own load refuses it", ({ seqs, events }) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-host-turn-record-"));
  const filename = path.join(directory, "session.jsonl");
  fs.writeFileSync(filename, events.map((event, index) =>
    `${JSON.stringify(seqs[index] === null ? event : { ...event, seq: seqs[index] })}\n`).join(""));
  expect(readHostTurnRecord("session", { directory }).state).toBe("unreadable");
  expect(() => new FileRuntimeEventStore(directory).load("session")).toThrow();
  /* Repaired, the same file decides. */
  fs.writeFileSync(filename, events.slice(0, 1).map((event) => `${JSON.stringify({ ...event, seq: 1 })}\n`).join(""));
  expect(readHostTurnRecord("session", { directory })).toMatchObject({ state: "read", turn: { turnId: "T1", closed: null } });
});

test.each([
  { shape: "names no turn", line: '{"kind":"delta","text":"lost turn id","seq":2}' },
  { shape: "carries no text", line: '{"kind":"delta","turnId":"T1","text":27,"seq":2}' },
  { shape: "is not JSON", line: '{"kind":"delta","turnId":"T1","text":BROKEN,"seq":2}' },
] as const)("a host turn record holding a delta that $shape is unreadable, as the store's own load refuses it", ({ line }) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-host-turn-record-"));
  fs.writeFileSync(path.join(directory, "session.jsonl"), [
    JSON.stringify({ kind: "turn-started", turnId: "T1", seq: 1 }),
    line,
    JSON.stringify({ kind: "session-status", status: "active", seq: 3 }),
  ].map((text) => `${text}\n`).join(""));
  expect(readHostTurnRecord("session", { directory }).state).toBe("unreadable");
  expect(() => new FileRuntimeEventStore(directory).load("session")).toThrow();
});

test("a host turn record checks the sequence of the deltas it skips, whatever their text holds", () => {
  const { directory } = turnLedger([
    { kind: "turn-started", turnId: "T1" },
    { kind: "delta", turnId: "T1", text: "quoted \"seq\":99} inside" },
    { kind: "delta", turnId: "T1", text: "more" },
  ]);
  expect(readHostTurnRecord("session", { directory })).toMatchObject({ state: "read", turn: { turnId: "T1", closed: null } });
});

test("a host turn record whose file was appended to or replaced between the read and the stat is unreadable", () => {
  const appended = turnLedger([
    { kind: "turn-started", turnId: "T1" },
    { kind: "turn-ended", turnId: "T1", status: "completed" },
  ]);
  expect(readHostTurnRecord("session", {
    directory: appended.directory,
    afterRead: () => appended.store.append("session", { kind: "turn-started", turnId: "T2", seq: 3 }),
  }).state).toBe("unreadable");
  /* The file reads still afterwards, and shows the turn the first read missed. */
  expect(readHostTurnRecord("session", { directory: appended.directory })).toMatchObject({
    state: "read", turn: { turnId: "T2", closed: null },
  });

  const replaced = turnLedger([{ kind: "turn-started", turnId: "T1" }]);
  expect(readHostTurnRecord("session", {
    directory: replaced.directory,
    afterRead: () => {
      const contents = fs.readFileSync(replaced.filename);
      fs.rmSync(replaced.filename);
      fs.writeFileSync(replaced.filename, contents);
    },
  }).state).toBe("unreadable");
});


test("the host turn record exposes an idle checkpoint and its closing sequence without accepting a torn suffix", () => {
  const { directory, filename } = turnLedger([
    { kind: "turn-started", turnId: "closed-turn" },
    frame("last-tool-result", "user", "closed-turn"),
    { kind: "turn-ended", turnId: "closed-turn", status: "error" },
    { kind: "session-status", status: "idle" },
  ]);
  expect(readHostTurnRecord("session", { directory })).toMatchObject({
    state: "read", complete: true, lastSeq: 4, lastActivitySeq: 3, latestStatus: { status: "idle", seq: 4 },
    turn: { turnId: "closed-turn", closed: { by: "turn-ended", status: "error", seq: 3 } },
  });
  fs.appendFileSync(filename, '{"kind":"turn-started"');
  // Existing restart/drain callers still read the stable prefix; progression
  // can now distinguish it from a complete current-writer checkpoint.
  expect(readHostTurnRecord("session", { directory })).toMatchObject({
    state: "read", complete: false, lastSeq: 4, turn: { closed: { status: "error", seq: 3 } },
  });
});
