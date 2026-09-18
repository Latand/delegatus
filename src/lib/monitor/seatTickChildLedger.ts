import fs from "node:fs";

/**
 * Resumable, line-framed reader for a child's runtime event ledger (#1465).
 *
 * The ledger is the structured host's own JSONL file: one event per line,
 * every line terminated, sequence numbers contiguous. Real ledgers are large —
 * measured on one machine at a median of 0.7 MB, a p90 of 2.7 MB and a maximum
 * of 80 MB, growing by hundreds of megabytes a day — and almost every byte of
 * them is `delta` text the tick has no use for. So the reader never parses a
 * byte it does not need: it frames by newline, decides with one substring test
 * whether a line could be a turn boundary, reads the sequence number off the
 * line's tail, and hands only the turn-started and turn-ended lines to
 * `JSON.parse`. Everything else is skipped at buffer speed.
 *
 * The cursor is what persists between two visits: the byte offset the next
 * read starts at, the last sequence seen, the open turn, and the newest
 * settled sequence. A visit reads whole lines only. A line the byte budget cut
 * in half is left for the next visit, which starts at that line's first byte
 * — unless it is the first line of the visit, in which case it is read whole
 * regardless of the budget so a single long record can never stop the cursor
 * for good. A record longer than {@link LINE_LIMIT} is a malformed record: it
 * is skipped to its newline and the gap says so.
 */
export interface LedgerCursor {
  /** First unread byte. Always a line boundary. */
  offset: number;
  /** `dev:ino` of the file the cursor belongs to; a different file resets it. */
  identity: string | null;
  /** The newest sequence number read, for the contiguity check. */
  seq: number;
  /** The turn a `turn-started` opened and no `turn-ended` has closed. */
  activeTurn: string | null;
  /** The sequence of the newest `turn-ended` that closed the open turn. */
  settledThrough: number;
  /** The last read reached the file's end as it stood. */
  atEnd: boolean;
  /** The file's size when this cursor first saw it, for the legacy boundary. */
  initialSize: number;
  /** The newest evidence gap, or null. A gap never clears a cursor: the
      outcomes read before and after it stand, and the gap is reported. */
  gap: string | null;
  /** Set after a record nobody could read: the next readable record re-bases
      the sequence instead of reporting the gap the unreadable one already is. */
  resync?: boolean;
}
export interface LedgerOutcome { turnId: string; status: "completed" | "interrupted" | "error"; seq: number; endOffset: number }
export const emptyLedgerCursor = (): LedgerCursor => ({ offset: 0, identity: null, seq: 0, activeTurn: null, settledThrough: 0, atEnd: false, initialSize: 0, gap: null });

/** The largest single record the reader will assemble. The writer's own
    records top out around a megabyte; anything past this is not a record. */
export const LINE_LIMIT = 16 * 1024 * 1024;
/** The most a single visit may be asked to read. */
export const LEDGER_READ_LIMIT = 64 * 1024 * 1024;
/** Terminal outcomes one visit hands back. The caller writes each one as
    rows inside one bounded transaction, so the visit stops at this many and
    leaves the cursor on the next line. */
export const OUTCOME_LIMIT = 256;
const CHUNK = 256 * 1024;
const TURN_MARKER = Buffer.from('"turn-');
const NEWLINE = 0x0a;
const TAIL = 48;
const TERMINAL_STATUS = new Set(["completed", "interrupted", "error"]);

/** The sequence number of a record read off its tail, where the writer puts
    it, or null when the tail does not carry it. */
function tailSeq(line: Buffer): number | null {
  const tail = line.subarray(Math.max(0, line.length - TAIL)).toString("latin1").trimEnd();
  const match = /"seq":(\d{1,15})\}$/.exec(tail);
  return match ? Number(match[1]) : null;
}

function parsedRecord(line: Buffer): { kind: string; seq: number; turnId?: unknown; status?: unknown } | null {
  let parsed: unknown;
  try { parsed = JSON.parse(line.toString("utf8")); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.kind !== "string" || !Number.isSafeInteger(record.seq) || (record.seq as number) <= 0) return null;
  return { kind: record.kind, seq: record.seq as number, turnId: record.turnId, status: record.status };
}

/** Apply one complete line to the cursor. */
function consumeLine(cursor: LedgerCursor, line: Buffer, endOffset: number, outcomes: LedgerOutcome[]): void {
  const candidate = line.indexOf(TURN_MARKER) >= 0;
  /* A line with no turn marker cannot be a turn boundary: only its sequence
     matters, and the tail carries it. A tail that does not is parsed whole. */
  let record: { kind: string; seq: number; turnId?: unknown; status?: unknown } | null;
  if (!candidate) {
    const seq = tailSeq(line);
    record = seq !== null ? { kind: "", seq } : parsedRecord(line);
  } else record = parsedRecord(line);
  if (!record) { cursor.gap = "malformed-record"; cursor.resync = true; return; }
  if (cursor.resync) delete cursor.resync;
  else if (record.seq !== cursor.seq + 1) cursor.gap = "sequence-gap";
  cursor.seq = record.seq;
  if (record.kind === "turn-started") {
    if (typeof record.turnId === "string" && record.turnId) cursor.activeTurn = record.turnId;
    else cursor.gap = "invalid-turn-start";
  } else if (record.kind === "turn-ended") {
    if (typeof record.turnId === "string" && record.turnId.length > 0 && TERMINAL_STATUS.has(String(record.status))) {
      if (cursor.activeTurn === null || cursor.activeTurn === record.turnId) { cursor.activeTurn = null; cursor.settledThrough = record.seq; }
      outcomes.push({ turnId: record.turnId, status: record.status as LedgerOutcome["status"], seq: record.seq, endOffset });
    } else cursor.gap = "invalid-terminal";
  }
}

/**
 * Read the ledger forward from the cursor within `byteLimit` bytes.
 *
 * Returns the advanced cursor, the terminal outcomes it read, and the bytes it
 * actually fetched. `bytes` may exceed `byteLimit` by at most one record when
 * the visit's first record is longer than the budget, which is the progress
 * guarantee described above.
 */
export function readChildLedger(filename: string, previous: LedgerCursor, byteLimit: number, outcomeLimit = OUTCOME_LIMIT): {
  cursor: LedgerCursor; outcomes: LedgerOutcome[]; bytes: number; records: number;
} {
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 1 || byteLimit > LEDGER_READ_LIMIT) throw new Error("invalid ledger budget");
  if (!Number.isSafeInteger(outcomeLimit) || outcomeLimit < 1 || outcomeLimit > OUTCOME_LIMIT) throw new Error("invalid ledger outcome budget");
  let cursor: LedgerCursor = { ...previous };
  const outcomes: LedgerOutcome[] = [];
  let fd: number | undefined;
  let bytes = 0;
  let records = 0;
  try {
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("ledger is not a regular file");
    const identity = `${stat.dev}:${stat.ino}`;
    if (cursor.identity !== identity || stat.size < cursor.offset) {
      cursor = { ...emptyLedgerCursor(), identity, initialSize: stat.size, gap: previous.identity ? "ledger-replaced" : previous.gap };
    }
    if (cursor.gap === "ledger-unreadable") cursor.gap = null;
    const chunk = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(byteLimit, 1)));
    /* The unterminated remainder of the last chunk, always the start of one
       line. `oversized` means the current line has passed LINE_LIMIT and is
       being skipped to its newline rather than assembled. */
    let carry: Buffer[] = [];
    let carried = 0;
    let oversized = false;
    let position = cursor.offset;
    let stop = false;
    while (!stop && position < stat.size) {
      /* The budget is a bound on whole lines: reading stops once it is spent
         and a line is complete. The first line of a visit is read to its end
         whatever the budget says, or a long record would stall the cursor. */
      if (bytes >= byteLimit && (records > 0 || (carried === 0 && !oversized))) break;
      const length = fs.readSync(fd, chunk, 0, chunk.length, position);
      if (!length) break;
      bytes += length;
      position += length;
      let start = 0;
      while (start < length) {
        const newline = chunk.indexOf(NEWLINE, start);
        if (newline < 0) {
          const rest = chunk.subarray(start, length);
          if (!oversized) {
            carried += rest.length;
            if (carried > LINE_LIMIT) { oversized = true; carry = []; carried = 0; }
            else carry.push(Buffer.from(rest));
          }
          break;
        }
        const lineEnd = position - length + newline + 1;
        if (oversized) {
          cursor.gap = "malformed-record";
          cursor.resync = true;
          oversized = false;
        } else {
          const piece = chunk.subarray(start, newline);
          const line = carry.length ? Buffer.concat([...carry, piece]) : piece;
          if (line.length > LINE_LIMIT) cursor.gap = "malformed-record";
          else consumeLine(cursor, line, lineEnd, outcomes);
        }
        carry = [];
        carried = 0;
        cursor.offset = lineEnd;
        records++;
        start = newline + 1;
        if (outcomes.length >= outcomeLimit) {
          /* Whole lines only: what follows this newline is left for the next
             visit, which resumes exactly here. Every complete line already
             fetched is consumed before a spent budget stops the next fetch. */
          stop = true;
          break;
        }
      }
    }
    /* An unterminated tail is the writer mid-record, or a torn crash tail the
       writer repairs on its next open. Either way it is not a record yet. */
    cursor.atEnd = cursor.offset === stat.size;
  } catch (error) {
    /* A ledger that does not exist YET is a host that has written no event,
       which is no evidence gap — every child starts that way. A ledger the
       cursor had already read that is gone is one: its outcomes past the
       cursor can no longer be read. */
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    cursor.gap = missing ? (cursor.identity ? "ledger-missing" : cursor.gap) : "ledger-unreadable";
    cursor.atEnd = false;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  return { cursor, outcomes, bytes, records };
}
