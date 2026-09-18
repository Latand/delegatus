import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyLedgerCursor, LINE_LIMIT, readChildLedger } from "./seatTickChildLedger";

/**
 * The child ledger reader (#1465), against ledgers shaped like the real ones:
 * mostly `delta` text, a few `item` bodies up to a megabyte, and a handful of
 * turn boundaries. What the reader owes is that every turn boundary is found,
 * every byte budget is honoured to the line, and a whole production-sized
 * ledger is read within one visit rather than over hours of them.
 */

const MINUTE_MS = 60_000;
void MINUTE_MS;

function record(event: Record<string, unknown>): string {
  return `${JSON.stringify(event)}\n`;
}

/** A ledger the size of a real one: `bytes` of delta records around `turns`
    completed turns, every record shaped as the runtime host writes it. */
function realisticLedger(file: string, bytes: number, turns: number): { seqs: number[]; size: number } {
  const chunks: string[] = [];
  let seq = 0;
  let written = 0;
  const seqs: number[] = [];
  const perTurn = Math.floor(bytes / turns);
  for (let turn = 1; turn <= turns; turn++) {
    const turnId = `turn-${String(turn).padStart(4, "0")}`;
    chunks.push(record({ kind: "turn-started", turnId, seq: ++seq }));
    let turnBytes = 0;
    while (turnBytes < perTurn) {
      /* Real delta lines average a few hundred bytes; some carry the words
         "turn-ended" in their text, which must not be read as a boundary. */
      const text = turn % 7 === 0 && turnBytes === 0 ? 'the host wrote "kind":"turn-ended" into its own transcript ' : "x".repeat(180 + (seq % 90));
      const line = record({ kind: "delta", turnId, text, seq: ++seq });
      chunks.push(line);
      turnBytes += line.length;
    }
    if (turn % 5 === 0) chunks.push(record({ kind: "item", turnId, phase: "completed", item: { text: "y".repeat(600_000) }, seq: ++seq }));
    chunks.push(record({ kind: "turn-ended", turnId, status: turn % 3 === 0 ? "interrupted" : "completed", seq: ++seq }));
    seqs.push(seq);
    written += turnBytes;
  }
  void written;
  const body = chunks.join("");
  fs.writeFileSync(file, body);
  return { seqs, size: Buffer.byteLength(body) };
}

test("a production-sized ledger of delta records is read whole within one visit, and every turn boundary is found", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seat-ledger-real-"));
  try {
    const file = path.join(dir, "events.jsonl");
    const ledger = realisticLedger(file, 10 * 1024 * 1024, 40);
    expect(ledger.size).toBeGreaterThan(10 * 1024 * 1024);
    const started = performance.now();
    const read = readChildLedger(file, emptyLedgerCursor(), 16 * 1024 * 1024);
    const elapsed = performance.now() - started;
    expect(read.outcomes.map((outcome) => outcome.seq)).toEqual(ledger.seqs);
    expect(read.outcomes.filter((outcome) => outcome.status === "interrupted")).toHaveLength(13);
    expect(read.cursor).toMatchObject({ atEnd: true, gap: null, activeTurn: null, settledThrough: ledger.seqs.at(-1), offset: ledger.size });
    expect(read.bytes).toBe(ledger.size);
    /* The bound this reader exists for: a 10 MB ledger inside one check's
       budget in well under a second, where the byte-at-a-time parser it
       replaces needed the better part of an hour of visits. */
    expect(elapsed).toBeLessThan(1_500);
    console.log(`[ledger] ${ledger.size} bytes, ${read.records} records in ${elapsed.toFixed(0)} ms`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the byte budget is honoured to the line, the cursor resumes exactly where it stopped, and nothing is read twice", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seat-ledger-budget-"));
  try {
    const file = path.join(dir, "events.jsonl");
    const ledger = realisticLedger(file, 2 * 1024 * 1024, 12);
    let cursor = emptyLedgerCursor();
    const outcomes: number[] = [];
    const budget = 256 * 1024;
    let visits = 0;
    let total = 0;
    while (!cursor.atEnd && visits < 100) {
      const read = readChildLedger(file, cursor, budget);
      /* A visit fetches at most one chunk past the budget, plus one whole
         record when the record it opened on is longer than the budget (the
         600 KB items here); the cursor never rests mid-line. */
      expect(read.bytes).toBeLessThanOrEqual(budget + 256 * 1024 + 620 * 1024);
      expect(read.cursor.offset).toBeGreaterThanOrEqual(cursor.offset);
      total += read.bytes;
      cursor = read.cursor;
      outcomes.push(...read.outcomes.map((outcome) => outcome.seq));
      visits++;
    }
    expect(outcomes).toEqual(ledger.seqs);
    expect(cursor.gap).toBeNull();
    /* Re-reading the unfinished tail of each visit is the only overhead. */
    expect(total).toBeLessThan(ledger.size * 1.6);
    expect(JSON.stringify(cursor).length).toBeLessThan(400);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a record longer than the budget is still read whole when it opens a visit, so a long item never stalls the cursor", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seat-ledger-long-"));
  try {
    const file = path.join(dir, "events.jsonl");
    fs.writeFileSync(file, [
      { kind: "turn-started", turnId: "first", seq: 1 },
      { kind: "item", item: { nested: { kind: "turn-ended", turnId: "fake" }, text: "x".repeat(3_000_000) }, seq: 2 },
      { kind: "turn-ended", turnId: "first", status: "completed", seq: 3 },
      { kind: "turn-started", turnId: "second", seq: 4 },
      { kind: "turn-ended", turnId: "second", status: "error", seq: 5 },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");
    let cursor = emptyLedgerCursor();
    const outcomes: string[] = [];
    let visits = 0;
    while (!cursor.atEnd && visits < 20) {
      const read = readChildLedger(file, cursor, 1024);
      cursor = read.cursor;
      outcomes.push(...read.outcomes.map((event) => event.turnId));
      visits++;
    }
    /* The nested "turn-ended" inside the item body is never an outcome. */
    expect(outcomes).toEqual(["first", "second"]);
    expect(cursor.gap).toBeNull();
    expect(visits).toBeLessThanOrEqual(6);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("partial tails, malformed records, missing sequences and replacement keep explicit evidence gaps", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seat-ledger-gap-"));
  try {
    const file = path.join(dir, "events.jsonl");
    const terminal = JSON.stringify({ kind: "turn-ended", turnId: "turn", status: "completed", seq: 1 });
    fs.writeFileSync(file, terminal.slice(0, 20));
    const partial = readChildLedger(file, emptyLedgerCursor(), 1000);
    expect(partial.outcomes).toEqual([]);
    expect(partial.cursor).toMatchObject({ offset: 0, atEnd: false, gap: null });
    fs.appendFileSync(file, terminal.slice(20) + "\n");
    const complete = readChildLedger(file, partial.cursor, 1000);
    expect(complete.outcomes).toHaveLength(1);
    expect(complete.cursor.atEnd).toBe(true);
    fs.appendFileSync(file, '{"bad":,}\n' + JSON.stringify({ kind: "turn-ended", turnId: "later", status: "error", seq: 4 }) + "\n");
    const gap = readChildLedger(file, complete.cursor, 1000);
    /* The unreadable record is the gap; the record after it re-bases the
       sequence rather than reporting the same hole a second time. */
    expect(gap.cursor.gap).toBe("malformed-record");
    expect(gap.cursor.seq).toBe(4);
    expect(gap.cursor).not.toHaveProperty("resync");
    expect(gap.outcomes[0]?.turnId).toBe("later");
    fs.renameSync(file, file + ".old");
    fs.writeFileSync(file, terminal + "\n");
    const replaced = readChildLedger(file, gap.cursor, 1000);
    expect(replaced.cursor.gap).toBe("ledger-replaced");
    expect(replaced.outcomes[0]?.turnId).toBe("turn");
    /* A sequence number that is not at the tail is still found, by parsing. */
    fs.appendFileSync(file, '{"seq":2,"kind":"turn-started","turnId":"odd"}\n{"seq":3,"kind":"turn-ended","turnId":"odd","status":"completed"}\n');
    const reordered = readChildLedger(file, replaced.cursor, 1000);
    expect(reordered.outcomes.map((outcome) => outcome.turnId)).toEqual(["odd"]);
    expect(reordered.cursor).toMatchObject({ seq: 3, gap: "ledger-replaced" });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a ledger not written yet is no gap, and one that vanished after being read is", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seat-ledger-absent-"));
  try {
    const file = path.join(dir, "events.jsonl");
    const fresh = readChildLedger(file, emptyLedgerCursor(), 1000);
    expect(fresh.cursor).toMatchObject({ gap: null, atEnd: false, offset: 0 });
    fs.writeFileSync(file, JSON.stringify({ kind: "turn-started", turnId: "t", seq: 1 }) + "\n");
    const seen = readChildLedger(file, fresh.cursor, 1000);
    expect(seen.cursor.identity).not.toBeNull();
    fs.unlinkSync(file);
    expect(readChildLedger(file, seen.cursor, 1000).cursor.gap).toBe("ledger-missing");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a record past the line limit is skipped to its newline as a malformed record, and reading continues", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seat-ledger-oversized-"));
  try {
    const file = path.join(dir, "events.jsonl");
    const fd = fs.openSync(file, "w");
    fs.writeSync(fd, JSON.stringify({ kind: "turn-started", turnId: "big", seq: 1 }) + "\n");
    fs.writeSync(fd, '{"kind":"delta","turnId":"big","text":"');
    const filler = Buffer.alloc(1024 * 1024, 0x7a);
    for (let i = 0; i < Math.ceil(LINE_LIMIT / filler.length) + 1; i++) fs.writeSync(fd, filler);
    fs.writeSync(fd, '","seq":2}\n');
    fs.writeSync(fd, JSON.stringify({ kind: "turn-ended", turnId: "big", status: "completed", seq: 3 }) + "\n");
    fs.closeSync(fd);
    let cursor = emptyLedgerCursor();
    const outcomes: string[] = [];
    const gaps: (string | null)[] = [];
    for (let visit = 0; visit < 10 && !cursor.atEnd; visit++) {
      const read = readChildLedger(file, cursor, 64 * 1024);
      cursor = read.cursor;
      gaps.push(cursor.gap);
      outcomes.push(...read.outcomes.map((outcome) => outcome.turnId));
    }
    expect(outcomes).toEqual(["big"]);
    /* The skipped record is the gap; the record after it re-bases the sequence. */
    expect(gaps.at(-1)).toBe("malformed-record");
    expect(cursor).toMatchObject({ gap: "malformed-record", atEnd: true, seq: 3, settledThrough: 3 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
