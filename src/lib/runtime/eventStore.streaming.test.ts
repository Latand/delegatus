import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, spyOn, test } from "bun:test";
import { captureRuntimeEventPosition, FileRuntimeEventStore, readRuntimeEventPage } from "./eventStore";
import type { RuntimeEvent } from "./engineHost";
import { wakeResponseEvidenceFromEvents, wakeResponseRecoveryKey } from "@/lib/monitor/seatWakeResponse";

const event = (seq: number): RuntimeEvent => ({ kind: "delta", turnId: "turn", text: "дані 🌱", seq });
function fixture(contents: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "event-stream-"));
  const filename = path.join(directory, "thread.jsonl");
  fs.writeFileSync(filename, contents);
  return { filename, store: new FileRuntimeEventStore(directory), directory };
}
const line = (seq: number) => JSON.stringify(event(seq));

test.each([
  ["malformed JSON", "{broken}"],
  ["invalid event", JSON.stringify({ kind: "unknown", seq: 1 })],
  ["empty record", ""],
  ["sequence gap after 1", `${line(1)}\n${line(3)}`],
  ["sequence gap after 1", `${line(1)}\n${line(1)}`],
])("stream validates discarded prefix: %s", async (reason, prefix) => {
  const f = fixture(`${prefix}\n${Array.from({ length: 2100 }, (_, i) => line(i + 4)).join("\n")}\n`);
  await expect(f.store.scan("thread", () => {})).rejects.toThrow(reason);
});

test.each(["{partial", JSON.stringify({ kind: "unknown", seq: 3 }), ""])("stream preserves partial final record semantics: %s", async tail => {
  const f = fixture(`${line(1)}\n${line(2)}\n${tail}`);
  const seen: RuntimeEvent[] = [];
  expect(await f.store.scan("thread", e => seen.push(e))).toBe(2);
  expect(seen).toEqual(f.store.load("thread"));
  expect(fs.readFileSync(f.filename, "utf8")).toBe(`${line(1)}\n${line(2)}\n${tail}`);
});

test("valid unterminated tail is included and its sequence is checked", async () => {
  const f = fixture(`${line(41)}\n${line(42)}`);
  const seen: RuntimeEvent[] = [];
  expect(await f.store.scan("thread", e => seen.push(e))).toBe(42);
  expect(seen).toEqual([event(41), event(42)]);
  fs.writeFileSync(f.filename, `${line(41)}\n${line(43)}`);
  await expect(f.store.scan("thread", () => {})).rejects.toThrow("sequence gap after 41");
});

test("stream reads writer output after reopening, including UTF-8 across chunks, without whole-file reads", async () => {
  const f = fixture(`${line(1)}\n`);
  const large = { ...event(2), text: "🌱ї".repeat(30_000) } as RuntimeEvent;
  f.store.append("thread", large);
  const reopened = new FileRuntimeEventStore(f.directory);
  const read = spyOn(fs, "readFileSync");
  const seen: RuntimeEvent[] = [];
  try {
    expect(await reopened.scan("thread", e => seen.push(e))).toBe(2);
    expect(read).not.toHaveBeenCalled();
  } finally { read.mockRestore(); }
  expect(seen).toEqual([event(1), large]);
  expect(seen).toEqual(reopened.load("thread"));
  reopened.append("thread", event(3));
  expect(await new FileRuntimeEventStore(f.directory).scan("thread", () => {})).toBe(3);
});

test("stream propagates visitor failures and can reopen afterwards", async () => {
  const f = fixture(`${line(1)}\n`);
  await expect(f.store.scan("thread", () => { throw new Error("consumer failed"); })).rejects.toThrow("consumer failed");
  expect(await f.store.scan("thread", () => {})).toBe(1);
  expect(await f.store.scan("missing", () => {})).toBe(0);
  const empty = fixture("");
  await expect(empty.store.scan("thread", () => {})).rejects.toThrow("empty record");
});

test("a replaced or truncated prefix refuses the read; concurrent append stays outside the snapshot", async () => {
  for (const change of ["replace", "truncate", "append"]) {
    const f = fixture(`${line(1)}\n${line(2)}\n`);
    const seen: RuntimeEvent[] = [];
    const pending = f.store.scan("thread", e => {
      seen.push(e);
      if (e.seq !== 1) return;
      if (change === "replace") {
        const replacement = path.join(f.directory, "replacement.jsonl");
        fs.writeFileSync(replacement, `${line(1)}\n`);
        fs.renameSync(replacement, f.filename);
      } else if (change === "truncate") fs.truncateSync(f.filename, 0);
      else f.store.append("thread", event(3));
    });
    if (change === "append") {
      expect(await pending).toBe(2);
      expect(seen).toEqual([event(1), event(2)]);
    } else await expect(pending).rejects.toThrow("changed during window refill");
  }
});


test("stream read errors and the refill deadline reject without stranding the descriptor", async () => {
  const f = fixture(`${line(1)}\n`);
  const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
  try { await expect(f.store.scan("thread", () => {})).rejects.toThrow("window refill exceeded its read deadline"); }
  finally { timeout.mockRestore(); }
  const duringRead = new AbortController();
  const readTimeout = spyOn(AbortSignal, "timeout").mockReturnValue(duringRead.signal);
  try {
    await expect(f.store.scan("thread", () => { duringRead.abort(); })).rejects.toThrow("window refill exceeded its read deadline");
  } finally { readTimeout.mockRestore(); }
  fs.mkdirSync(path.join(f.directory, "directory.jsonl"));
  await expect(f.store.scan("directory", () => {})).rejects.toThrow();
  expect(await f.store.scan("thread", () => {})).toBe(1);
});

test("a page can stop at historical proof with a 100 MiB suffix and resume at its next line", async () => {
  const f = fixture(line(1) + "\n" + line(2) + "\n");
  try {
    fs.truncateSync(f.filename, 100 * 1024 * 1024);
    const seen: number[] = [];
    const read = await readRuntimeEventPage("thread", undefined, e => {
      seen.push(e.seq);
      return true;
    }, undefined, f.directory);
    expect(seen).toEqual([1]);
    expect(read).toMatchObject({ state: "more", position: { offset: Buffer.byteLength(line(1) + "\n"), seq: 1 } });
    const second = await readRuntimeEventPage("thread", read!.position, e => {
      seen.push(e.seq);
      return true;
    }, undefined, f.directory);
    expect(second?.position.seq).toBe(2);
    expect(seen).toEqual([1, 2]);
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("a complete final event without LF supplies terminal proof at stable EOF", async () => {
  const terminal: RuntimeEvent = { kind: "turn-ended", turnId: "wake-turn", status: "completed", seq: 1 };
  const f = fixture(JSON.stringify(terminal));
  try {
    const seen: RuntimeEvent[] = [];
    const page = await readRuntimeEventPage("thread", undefined, e => { seen.push(e); }, undefined, f.directory);
    expect(seen).toEqual([terminal]);
    expect(page).toMatchObject({ state: "current", position: { offset: Buffer.byteLength(JSON.stringify(terminal)), seq: 1 } });
    fs.writeFileSync(f.filename, '{"kind":"turn-ended"');
    const pending: RuntimeEvent[] = [];
    expect(await readRuntimeEventPage("thread", undefined, e => { pending.push(e); }, undefined, f.directory))
      .toMatchObject({ state: "incomplete", position: { offset: 0 } });
    expect(pending).toEqual([]);
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test.each(["wake-turn", "nudge-turn"])("visitor termination preserves completed %s proof before an unrelated unterminated suffix", async turnId => {
  const proof: RuntimeEvent = { kind: "turn-ended", turnId, status: "completed", seq: 1 };
  const unrelated: RuntimeEvent = { kind: "turn-ended", turnId: "other-turn", status: "completed", seq: 2 };
  const f = fixture(`${JSON.stringify(proof)}\n${JSON.stringify(unrelated)}`);
  try {
    const seen: RuntimeEvent[] = [];
    let answered = false;
    const page = await readRuntimeEventPage("thread", undefined, event => {
      seen.push(event);
      answered = event.kind === "turn-ended" && event.turnId === turnId && event.status === "completed";
      return answered;
    }, undefined, f.directory);
    expect(seen).toEqual([proof]);
    expect(answered).toBe(true);
    expect(page).toMatchObject({ state: "more", position: { seq: 1, offset: Buffer.byteLength(`${JSON.stringify(proof)}\n`) } });
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test.each(["wake", "nudge"] as const)("oversized records are skipped with bounded cursors before %s proof", async action => {
  const f = fixture("");
  const base = { clientMessageId: "wake", operationId: "operation", conversationId: "conversation_fixture", seatEpoch: 7,
    deliveredAt: "2026-11-01T00:00:00Z", progressAt: "2026-11-01T00:00:00Z", boundMs: 900_000 };
  const row = action === "nudge" ? { ...base, action: "nudged" as const,
    recovery: { text: "continue", origin: { kind: "agent" as const, role: "seat-tick" as const, project: "fixture" } } }
    : { ...base, action: "pending" as const };
  const operationId = action === "nudge" ? wakeResponseRecoveryKey(row) : row.operationId;
  const turnId = action === "nudge" ? "nudge-turn" : "wake-turn";
  try {
    const store = new FileRuntimeEventStore(f.directory);
    store.append("thread", { kind: "delta", turnId: "unrelated", text: "x".repeat(9 * 1024 * 1024), seq: 1 });
    store.append("thread", { kind: "turn-started", turnId, seq: 2 });
    store.append("thread", { kind: "item", turnId, phase: "completed",
      deliveryEcho: { operationId, at: row.deliveredAt }, item: { type: "user" }, seq: 3 });
    store.append("thread", { kind: "delta", turnId, text: "answered", seq: 4 });
    store.append("thread", { kind: "turn-ended", turnId, status: "completed", seq: 5 });
    let position;
    const replayed: Record<string, unknown>[] = [];
    let calls = 0;
    do {
      const priorSkip = position?.skip ?? 0;
      const page = await readRuntimeEventPage("thread", position, event => { replayed.push(event); }, undefined, f.directory);
      if (!page) throw new Error("event page position was refused");
      calls++;
      expect(JSON.stringify(page.position).length).toBeLessThan(500);
      if (page.position.skip !== undefined) expect(page.position.skip - priorSkip).toBeLessThanOrEqual(4 * 1024 * 1024);
      expect(page.position.pending).toBeUndefined();
      position = JSON.parse(JSON.stringify(page.position));
      if (page.state === "current") break;
    } while (true);
    expect(calls).toBeGreaterThan(2);
    expect(wakeResponseEvidenceFromEvents(row, replayed, action === "nudge" ? [operationId] : [])).toMatchObject({ answered: true, turnId });
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test.each(["wake", "nudge"] as const)("consecutive large records advance monotonically and release the %s proof", async action => {
  const f = fixture("");
  const base = { clientMessageId: "wake", operationId: "operation", conversationId: "conversation_fixture", seatEpoch: 7,
    deliveredAt: "2026-11-01T00:00:00Z", progressAt: "2026-11-01T00:00:00Z", boundMs: 900_000 };
  const row = action === "nudge" ? { ...base, action: "nudged" as const,
    recovery: { text: "continue", origin: { kind: "agent" as const, role: "seat-tick" as const, project: "fixture" } } }
    : { ...base, action: "pending" as const };
  const operationId = action === "nudge" ? wakeResponseRecoveryKey(row) : row.operationId;
  try {
    const store = new FileRuntimeEventStore(f.directory);
    store.append("thread", { kind: "item", turnId: "wake-turn", phase: "completed", item: { type: "reasoning", text: "p".repeat(5 * 1024 * 1024) }, seq: 1 });
    store.append("thread", { kind: "item", turnId: "other-turn", phase: "completed", item: { type: "reasoning", text: "q".repeat(5 * 1024 * 1024) }, seq: 2 });
    store.append("thread", { kind: "turn-started", turnId: "wake-turn", seq: 3 });
    store.append("thread", { kind: "item", turnId: "wake-turn", phase: "completed", deliveryEcho: { operationId, at: row.deliveredAt }, item: { type: "user" }, seq: 4 });
    store.append("thread", { kind: "delta", turnId: "wake-turn", text: "answer", seq: 5 });
    store.append("thread", { kind: "turn-ended", turnId: "wake-turn", status: "completed", seq: 6 });
    let position;
    const replayed: Record<string, unknown>[] = [];
    let priorOffset = -1;
    for (let calls = 0; calls < 10; calls++) {
      const page = await readRuntimeEventPage("thread", position, e => { replayed.push(e); }, undefined, f.directory);
      if (!page) throw new Error("event page position was refused");
      const progress = page.position.offset + (page.position.skip ?? 0);
      expect(progress).toBeGreaterThan(priorOffset);
      priorOffset = progress;
      position = page.position;
      if (page.state === "current") break;
    }
    expect(wakeResponseEvidenceFromEvents(row, replayed, action === "nudge" ? [operationId] : []))
      .toMatchObject({ answered: true, turnId: "wake-turn" });
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test.each(["wake", "nudge"] as const)("a bounded 300 KB response record preserves %s evidence", async action => {
  const f = fixture("");
  const base = { clientMessageId: "wake", operationId: "operation", conversationId: "conversation_fixture", seatEpoch: 7,
    deliveredAt: "2026-11-01T00:00:00Z", progressAt: "2026-11-01T00:00:00Z", boundMs: 900_000 };
  const row = action === "nudge" ? { ...base, action: "nudged" as const,
    recovery: { text: "continue", origin: { kind: "agent" as const, role: "seat-tick" as const, project: "fixture" } } }
    : { ...base, action: "pending" as const };
  const operationId = action === "nudge" ? wakeResponseRecoveryKey(row) : row.operationId;
  try {
    const store = new FileRuntimeEventStore(f.directory);
    store.append("thread", { kind: "turn-started", turnId: "response-turn", seq: 1 });
    store.append("thread", { kind: "item", turnId: "response-turn", phase: "completed", deliveryEcho: { operationId, at: row.deliveredAt }, item: { type: "user" }, seq: 2 });
    store.append("thread", { kind: "delta", turnId: "response-turn", text: "answer" + "x".repeat(300_000), seq: 3 });
    store.append("thread", { kind: "turn-ended", turnId: "response-turn", status: "completed", seq: 4 });
    const replayed: Record<string, unknown>[] = [];
    const page = await readRuntimeEventPage("thread", undefined, e => { replayed.push(e); }, undefined, f.directory);
    expect(page?.state).toBe("current");
    expect(wakeResponseEvidenceFromEvents(row, replayed, action === "nudge" ? [operationId] : []))
      .toMatchObject({ answered: true, turnId: "response-turn" });
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test.each(["replace", "rewrite", "append", "torn"] as const)("prepared position detects ledger changes: %s", async change => {
  const f = fixture(line(1) + "\n");
  try {
    const position = await captureRuntimeEventPosition("thread", f.directory);
    if (!position) throw new Error("expected a complete ledger position");
    expect(position.offset).toBe(Buffer.byteLength(line(1) + "\n"));
    if (change === "replace") {
      const replacement = path.join(f.directory, "replacement.jsonl");
      fs.writeFileSync(replacement, line(1) + "\n");
      fs.renameSync(replacement, f.filename);
    } else if (change === "rewrite") fs.writeFileSync(f.filename, line(3) + "\n" + line(4) + "\n");
    else if (change === "append") f.store.append("thread", event(2));
    else fs.appendFileSync(f.filename, "{partial");

    const seen: RuntimeEvent[] = [];
    const page = await readRuntimeEventPage("thread", position, e => { seen.push(e); }, undefined, f.directory);
    if (change === "append") {
      expect(page).toMatchObject({ state: "current", position: { seq: 2 } });
      expect(seen).toEqual([event(2)]);
    } else {
      if (change === "torn") expect(page).toEqual({ state: "incomplete", position });
      else expect(page).toBeNull();
      expect(seen).toEqual([]);
    }
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});
