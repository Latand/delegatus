import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { statePath } from "@/lib/configDir";

import { determined, undetermined, type Determinable } from "./determinable";
import type { RuntimeEvent } from "./engineHost";
import { normalizeVoiceDeliveries } from "./voiceDelivery";

export interface RuntimeEventStore {
  load(threadId: string): RuntimeEvent[];
  append(threadId: string, event: RuntimeEvent): void;
}

export interface RuntimeEventCursorRecoveryDiagnostic {
  kind: "runtime-event-cursor-recovery";
  sessionId: string;
  durableTailSeq: number;
  registryCursor: number;
  chosenNextSeq: number;
  action: "use-durable-tail" | "use-registry-cursor";
  relation: "registry-behind" | "registry-ahead" | "durable-ledger-empty";
}

export type RuntimeEventCursorRecoveryReporter = (diagnostic: RuntimeEventCursorRecoveryDiagnostic) => void;

type LedgerIdentity = Pick<fs.Stats, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs">;
type CachedLedger = { identity: LedgerIdentity; events: RuntimeEvent[] };

const MAX_CACHED_LEDGER_BYTES = 64 * 1024 * 1024;
const MAX_CACHED_LEDGERS = 64;
const eventStoreGlobals = globalThis as typeof globalThis & {
  __llvRuntimeEventLedgers?: Map<string, CachedLedger>;
};

function ledgerCache(): Map<string, CachedLedger> {
  eventStoreGlobals.__llvRuntimeEventLedgers ??= new Map();
  return eventStoreGlobals.__llvRuntimeEventLedgers;
}

function ledgerIdentity(stats: fs.Stats): LedgerIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  };
}

function sameLedgerIdentity(left: LedgerIdentity, right: LedgerIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function cachedLedger(filename: string, identity: LedgerIdentity): RuntimeEvent[] | null {
  const cache = ledgerCache();
  const cached = cache.get(filename);
  if (!cached || !sameLedgerIdentity(cached.identity, identity)) return null;
  cache.delete(filename);
  cache.set(filename, cached);
  return cached.events.slice();
}

function rememberLedger(filename: string, identity: LedgerIdentity, events: RuntimeEvent[]): void {
  const cache = ledgerCache();
  cache.delete(filename);
  cache.set(filename, { identity, events: events.slice() });
  let bytes = 0;
  for (const entry of cache.values()) bytes += entry.identity.size;
  while (cache.size > MAX_CACHED_LEDGERS || bytes > MAX_CACHED_LEDGER_BYTES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    const removed = cache.get(oldest);
    cache.delete(oldest);
    bytes -= removed?.identity.size ?? 0;
  }
}

function forgetLedger(filename: string): void {
  ledgerCache().delete(filename);
}

const MAX_DIAGNOSTIC_SESSION_ID_LENGTH = 160;

function reportRuntimeEventCursorRecovery(diagnostic: RuntimeEventCursorRecoveryDiagnostic): void {
  console.warn("[structured host] runtime event cursor recovered", diagnostic);
}

export function nextRuntimeEventSequence(cursor: number): number {
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new Error("runtime event cursor is invalid");
  }
  const next = cursor + 1;
  if (!Number.isSafeInteger(next)) {
    throw new Error("runtime event cursor cannot advance safely");
  }
  return next;
}

export function reconcileRuntimeEventCursor(
  sessionId: string,
  durableTailSeq: number,
  registryCursor: number,
  report: RuntimeEventCursorRecoveryReporter = reportRuntimeEventCursorRecovery,
): number {
  if (!Number.isSafeInteger(durableTailSeq) || durableTailSeq < 0) {
    throw new Error("runtime event durable tail sequence is invalid");
  }
  if (!Number.isSafeInteger(registryCursor) || registryCursor < 0) {
    throw new Error("runtime event registry cursor is invalid");
  }
  const useRegistryCursor = durableTailSeq === 0 && registryCursor > 0;
  const cursor = useRegistryCursor ? registryCursor : durableTailSeq;
  const chosenNextSeq = nextRuntimeEventSequence(cursor);
  if (registryCursor !== durableTailSeq) {
    try {
      report({
        kind: "runtime-event-cursor-recovery",
        sessionId: sessionId.slice(0, MAX_DIAGNOSTIC_SESSION_ID_LENGTH),
        durableTailSeq,
        registryCursor,
        chosenNextSeq,
        action: useRegistryCursor ? "use-registry-cursor" : "use-durable-tail",
        relation: useRegistryCursor
          ? "durable-ledger-empty"
          : registryCursor < durableTailSeq ? "registry-behind" : "registry-ahead",
      });
    } catch { /* diagnostics never fence durable recovery */ }
  }
  return cursor;
}

function validEvent(value: unknown): value is RuntimeEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (!Number.isSafeInteger(event.seq) || (event.seq as number) <= 0) return false;
  const nonEmptyString = (field: unknown): field is string => typeof field === "string" && field.length > 0;
  switch (event.kind) {
    case "native-queue-changed":
      return nonEmptyString(event.threadId);
    case "turn-started":
      return nonEmptyString(event.turnId);
    case "delta":
      return nonEmptyString(event.turnId) && typeof event.text === "string";
    case "item":
      return (nonEmptyString(event.turnId) || event.turnId === null)
        && (event.phase === "started" || event.phase === "completed")
        && Object.hasOwn(event, "item");
    case "voice-transcript":
      return nonEmptyString(event.segmentId)
        && (event.role === "user" || event.role === "assistant")
        && typeof event.text === "string"
        && typeof event.final === "boolean"
        && typeof event.realtimeSessionId === "string";
    case "voice-chunk": {
      if (!nonEmptyString(event.turnId)) return false;
      const delivery = normalizeVoiceDeliveries([event.delivery])[0];
      return delivery?.ready === true
        && delivery.sourceTurnId === event.turnId
        && delivery.streamChunk !== undefined
        && isDeepStrictEqual(delivery, event.delivery);
    }
    case "turn-ended":
      return nonEmptyString(event.turnId)
        && (event.status === "completed" || event.status === "interrupted" || event.status === "error");
    case "attention":
      return nonEmptyString(event.id) && nonEmptyString(event.method) && Object.hasOwn(event, "attention");
    case "attention-resolved":
      return nonEmptyString(event.id)
        && (event.resolution === "answered" || event.resolution === "host-restarted" || event.resolution === "server-resolved" || event.resolution === "turn-ended");
    case "limits":
      return Object.hasOwn(event, "snapshot");
    case "realtime-delivery-progress":
      return nonEmptyString(event.deliveryId)
        && nonEmptyString(event.digest)
        && Number.isSafeInteger(event.responseIndex)
        && (event.responseIndex as number) >= 0
        && Number.isSafeInteger(event.offset)
        && (event.offset as number) >= 0;
    case "realtime-delivery-acknowledged":
      return nonEmptyString(event.deliveryId) && nonEmptyString(event.digest);
    case "session-status":
      return (event.status === "active" || event.status === "idle" || event.status === "unhosted" || event.status === "dead")
        && (event.activeFlags === undefined
          || (Array.isArray(event.activeFlags) && event.activeFlags.every(nonEmptyString)));
    default:
      return false;
  }
}

/** Bytes per backwards step while looking for a record boundary. This bounds
    the read, never the record: the scan keeps stepping until it finds the
    newline, so a record larger than one step is found rather than missed. */
const EVENT_TAIL_STEP_BYTES = 64 * 1024;
/**
 * The largest final record this will reassemble to read its sequence. It exists
 * so a corrupt length cannot make the probe allocate the machine's memory, and
 * a record past it is reported as UNDETERMINED — the one thing a size limit
 * here must never do is answer "nothing pending" for a ledger it declined to
 * read. A single runtime event is kilobytes; the whole-ledger cache above caps
 * at 64 MiB, so nothing legitimate comes close.
 */
const EVENT_TAIL_MAX_RECORD_BYTES = 32 * 1024 * 1024;

/**
 * Byte offset of the last `\n` strictly before `end`, or -1 when there is none.
 *
 * Stepping backwards is what makes the probe independent of record size. The
 * fixed-window version of this (#747, round 3) read the last 64 KiB and gave up
 * when it held no complete line, so a well-formed ledger whose final record was
 * larger than the window answered "unknown" — and unknown is an input the
 * retirement predicate then has to refuse on, forever, for that ledger.
 */
function lastNewlineBefore(handle: number, end: number, buffer: Buffer): number {
  let position = end;
  while (position > 0) {
    const length = Math.min(buffer.byteLength, position);
    const start = position - length;
    const read = fs.readSync(handle, buffer, 0, length, start);
    if (read <= 0) return -1;
    const index = buffer.lastIndexOf(0x0a, read - 1);
    if (index >= 0) return start + index;
    position = start;
  }
  return -1;
}

/**
 * Last sequence a thread's ledger holds *on disk*, or a determined 0 when it
 * holds nothing.
 *
 * Undetermined is not zero: a caller deciding whether a host may be retired
 * (#747) must treat a ledger it could not read as "unknown", never as "nothing
 * pending". A final record without its terminating newline is a torn append, so
 * the durable tail is the last COMPLETE record before it — which is exactly
 * what {@link FileRuntimeEventStore.load} would replay.
 */
export function durableRuntimeEventTailSeq(
  threadId: string,
  directory: string = statePath("structured-host-events"),
): Determinable<number> {
  const filename = path.join(directory, `${encodeURIComponent(threadId)}.jsonl`);
  let handle: number;
  try {
    handle = fs.openSync(filename, "r");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    /* A ledger that was never created holds nothing, and that is an answer. */
    return code === "ENOENT" ? determined(0) : undetermined(`the runtime event ledger could not be opened (${code ?? "unknown"})`);
  }
  try {
    const size = fs.fstatSync(handle).size;
    if (size === 0) return determined(0);
    const buffer = Buffer.allocUnsafe(Math.min(EVENT_TAIL_STEP_BYTES, size));
    const terminator = lastNewlineBefore(handle, size, buffer);
    /* No newline anywhere: the file holds one unterminated append and no
       complete record, so the durable tail really is nothing. */
    if (terminator < 0) return determined(0);
    const start = lastNewlineBefore(handle, terminator, buffer) + 1;
    const length = terminator - start;
    if (length === 0) return undetermined("the runtime event ledger ends with an empty record");
    if (length > EVENT_TAIL_MAX_RECORD_BYTES) {
      return undetermined(`the runtime event ledger's final record is ${length} bytes`);
    }
    const record = Buffer.allocUnsafe(length);
    const read = fs.readSync(handle, record, 0, length, start);
    if (read !== length) return undetermined("the runtime event ledger's final record could not be read whole");
    let parsed: unknown;
    try { parsed = JSON.parse(record.toString("utf8")); } catch { return undetermined("the runtime event ledger's final record is not JSON"); }
    const seq = (parsed as { seq?: unknown } | null)?.seq;
    return Number.isSafeInteger(seq) && (seq as number) > 0
      ? determined(seq as number)
      : undetermined("the runtime event ledger's final record carries no sequence");
  } catch (error) {
    return undetermined(`the runtime event ledger could not be read (${(error as NodeJS.ErrnoException).code ?? "unknown"})`);
  } finally {
    fs.closeSync(handle);
  }
}

/** A transcript frame the Claude host recorded: the `uuid` is the one the CLI
    gives the same record in the transcript. */
export interface HostTurnFrame {
  uuid: string;
  type: "user" | "assistant";
  /** The turn the host had open when it recorded the frame, or null. */
  turnId: string | null;
  /** Native frame clock, retained when a large frame falls outside the tail. */
  timestamp?: string;
}

/**
 * What a host's own ledger says about its newest turn, for the restart cut
 * decision (docs/design/restart-cut-recognition.md).
 *
 * `turn` is the newest turn the host started and how the host closed it: a
 * `turn-ended` for it, or a `session-status` of `dead` or `unhosted`. The
 * frames are split at that boundary, the turn's start while it is open and
 * the closing event once it is closed, so a reader can tie the transcript to
 * the turn by identity. `identity` names the file as it was read.
 */
export type HostTurnRecord =
  | { state: "absent" }
  | { state: "unreadable"; reason: string }
  | {
    state: "read";
    identity: string;
    mtimeMs: number;
    /** Sequence/status evidence for current-writer liveness; older injected readings omit it. */
    lastSeq?: number;
    /** Newest activity other than status, limits or attention cleanup. */
    lastActivitySeq?: number;
    complete?: boolean;
    latestStatus?: { status: string; seq: number } | null;
    turn: {
      turnId: string;
      closed: { by: "turn-ended" | "session-status"; status: "completed" | "interrupted" | "error" | null; seq?: number } | null;
    } | null;
    framesBefore: HostTurnFrame[];
    framesAfter: HostTurnFrame[];
  };

const HOST_TURN_RECORD_STEP_BYTES = 1024 * 1024;
/** Frames kept from before the boundary, newest first. The ledger records
    frames in the transcript's order, so the anchor is the newest of them the
    transcript tail holds; only frames that never reached the transcript stand
    between it and the boundary. */
const HOST_TURN_RECORD_FRAMES_BEFORE = 256;

function hostLedgerFilename(threadId: string, directory: string): string {
  return path.join(directory, `${encodeURIComponent(threadId)}.jsonl`);
}

function ledgerIdentityStamp(identity: LedgerIdentity): string {
  return `${identity.dev}:${identity.ino}:${identity.size}:${identity.mtimeMs}:${identity.ctimeMs}`;
}

/** The identity of a session's ledger file as it is now, without reading it. */
export function hostTurnRecordIdentity(
  threadId: string,
  directory: string = statePath("structured-host-events"),
): string {
  try {
    return ledgerIdentityStamp(ledgerIdentity(fs.statSync(hostLedgerFilename(threadId, directory))));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
  }
}

/** When a session's ledger file was last written, without reading it:
    `absent` when there is no file, `unknown` when it cannot be stat'ed. */
export function hostTurnRecordModifiedAt(
  threadId: string,
  directory: string = statePath("structured-host-events"),
): number | "absent" | "unknown" {
  try {
    return fs.statSync(hostLedgerFilename(threadId, directory)).mtimeMs;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown";
  }
}

/**
 * One stable read of a session's ledger: one descriptor, a stat before the
 * read and one after, and a stat of the path. A file that was appended to or
 * replaced under the read is `unreadable`, never an answer from its old
 * prefix, which is what {@link FileRuntimeEventStore.load} hands back. Every
 * record read is parsed and validated as that load validates it, newest first,
 * deltas included; a delta is then skipped by its kind. An unterminated final
 * line is a write the crash cut short.
 */
export function readHostTurnRecord(
  threadId: string,
  options: {
    directory?: string;
    /** False for an engine whose ledger holds no transcript frames (Codex):
        the read then stops at the newest turn's start. */
    frames?: boolean;
    /** Runs between the read and the closing stats. */
    afterRead?: () => void;
  } = {},
): HostTurnRecord {
  const framesBefore = options.frames === false ? 0 : HOST_TURN_RECORD_FRAMES_BEFORE;
  const filename = hostLedgerFilename(threadId, options.directory ?? statePath("structured-host-events"));
  let handle: number;
  try {
    handle = fs.openSync(filename, "r");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? { state: "absent" } : { state: "unreadable", reason: `the host ledger could not be opened (${code ?? "unknown"})` };
  }
  try {
    const before = ledgerIdentity(fs.fstatSync(handle));
    type Boundary = { seq: number; kind: "turn-ended"; turnId: string; status: "completed" | "interrupted" | "error" }
      | { seq: number; kind: "session-status" };
    /* Newest first: what follows the newest turn's start, then the frames
       recorded before it. */
    const newer: Array<Boundary | { kind: "frame"; frame: HostTurnFrame }> = [];
    const olderFrames: HostTurnFrame[] = [];
    let started: string | null = null;
    let malformed: string | null = null;
    /* Every record read, skipped deltas included, carries the sequence one
       below the record after it. A gap or a repeat means a record is missing
       or doubled, and the missing one could be the turn's end. */
    let expectedSeq: number | null = null;
    let lastSeq = 0;
    let lastActivitySeq = 0;
    let latestStatus: { status: string; seq: number } | null = null;
    let complete = true;
    const sequenced = (seq: unknown): boolean => {
      if (!Number.isSafeInteger(seq) || (seq as number) <= 0 || (expectedSeq !== null && seq !== expectedSeq)) {
        malformed = expectedSeq === null
          ? "the host ledger holds a record with no sequence"
          : `the host ledger's sequence breaks before ${expectedSeq + 1}`;
        return false;
      }
      if (lastSeq === 0) lastSeq = seq as number;
      expectedSeq = (seq as number) - 1;
      return true;
    };
    const visit = (line: string): void => {
      let event: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) event = parsed as Record<string, unknown>;
      } catch { /* reported below */ }
      if (!event) {
        malformed = "the host ledger holds a record that is not JSON";
        return;
      }
      if (!validEvent(event)) {
        malformed = "the host ledger holds an invalid event";
        return;
      }
      if (!sequenced(event.seq)) return;
      if (lastActivitySeq === 0 && event.kind !== "session-status" && event.kind !== "limits" && event.kind !== "attention-resolved") {
        lastActivitySeq = event.seq as number;
      }
      if (event.kind === "delta") return;
      if (event.kind === "session-status" && latestStatus === null) {
        latestStatus = { status: event.status as string, seq: event.seq as number };
      }
      if (event.kind === "item") {
        const item = event.item as Record<string, unknown> | null;
        if (!item || typeof item !== "object" || typeof item.uuid !== "string") return;
        if (item.type !== "user" && item.type !== "assistant") return;
        const frame: HostTurnFrame = {
          uuid: item.uuid, type: item.type, turnId: typeof event.turnId === "string" ? event.turnId : null,
          ...(typeof item.timestamp === "string" ? { timestamp: item.timestamp } : {}),
        };
        if (started === null) newer.push({ kind: "frame", frame });
        else olderFrames.push(frame);
        return;
      }
      if (started !== null) return;
      if (event.kind === "turn-started") {
        if (typeof event.turnId !== "string" || !event.turnId) malformed = "the host ledger holds a turn start that names no turn";
        else started = event.turnId;
      } else if (event.kind === "turn-ended") {
        if (typeof event.turnId !== "string" || (event.status !== "completed" && event.status !== "interrupted" && event.status !== "error")) {
          malformed = "the host ledger holds a turn end it cannot name";
        } else newer.push({ kind: "turn-ended", turnId: event.turnId, status: event.status, seq: event.seq as number });
      } else if (event.kind === "session-status" && (event.status === "dead" || event.status === "unhosted")) {
        newer.push({ kind: "session-status", seq: event.seq as number });
      }
    };
    let position = before.size;
    let carry: Buffer = Buffer.alloc(0);
    let newest = true;
    while (position > 0 && malformed === null && !(started !== null && olderFrames.length >= framesBefore)) {
      const length = Math.min(HOST_TURN_RECORD_STEP_BYTES, position);
      const start = position - length;
      const chunk = Buffer.allocUnsafe(length);
      let offset = 0;
      while (offset < length) {
        const read = fs.readSync(handle, chunk, offset, length - offset, start + offset);
        if (read <= 0) return { state: "unreadable", reason: "the host ledger shrank under the read" };
        offset += read;
      }
      const data = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
      position = start;
      const firstNewline = start === 0 ? -1 : data.indexOf(0x0a);
      if (start > 0 && firstNewline < 0) {
        carry = data;
        continue;
      }
      const lines = data.subarray(firstNewline + 1).toString("utf8").split("\n");
      carry = start === 0 ? Buffer.alloc(0) : data.subarray(0, firstNewline + 1);
      /* The text after the last newline of the file is a torn append. */
      const torn = lines.pop();
      if (newest && torn) complete = false;
      if (!newest && torn) malformed = "the host ledger could not be split into records";
      newest = false;
      for (let index = lines.length - 1; index >= 0 && malformed === null; index -= 1) {
        if (!lines[index]) malformed = "the host ledger holds an empty record";
        else visit(lines[index]!);
        if (started !== null && olderFrames.length >= framesBefore) break;
      }
    }
    options.afterRead?.();
    const after = ledgerIdentity(fs.fstatSync(handle));
    let onPath: LedgerIdentity;
    try {
      onPath = ledgerIdentity(fs.statSync(filename));
    } catch {
      return { state: "unreadable", reason: "the host ledger was replaced under the read" };
    }
    if (!sameLedgerIdentity(before, after) || !sameLedgerIdentity(after, onPath)) {
      return { state: "unreadable", reason: "the host ledger moved under the read" };
    }
    if (malformed !== null) return { state: "unreadable", reason: malformed };
    const identity = ledgerIdentityStamp(before);
    newer.reverse();
    olderFrames.reverse();
    const framesOf = (items: typeof newer) => items.flatMap((item) => item.kind === "frame" ? [item.frame] : []);
    if (started === null) {
      return { state: "read", identity, mtimeMs: before.mtimeMs, lastSeq, lastActivitySeq, latestStatus, complete, turn: null, framesBefore: framesOf(newer), framesAfter: [] };
    }
    const turnId: string = started;
    const closedAt = newer.findIndex((item) =>
      item.kind === "session-status" || (item.kind === "turn-ended" && item.turnId === turnId));
    const closing = closedAt < 0 ? null : newer[closedAt] as Boundary;
    return {
      state: "read",
      identity,
      mtimeMs: before.mtimeMs,
      lastSeq, lastActivitySeq, latestStatus, complete,
      turn: {
        turnId,
        closed: closing ? { by: closing.kind, status: closing.kind === "turn-ended" ? closing.status : null, seq: closing.seq } : null,
      },
      framesBefore: closedAt < 0 ? olderFrames : [...olderFrames, ...framesOf(newer.slice(0, closedAt))],
      framesAfter: closedAt < 0 ? framesOf(newer) : framesOf(newer.slice(closedAt + 1)),
    };
  } catch (error) {
    return { state: "unreadable", reason: `the host ledger could not be read (${(error as NodeJS.ErrnoException).code ?? "unknown"})` };
  } finally {
    fs.closeSync(handle);
  }
}

export class FileRuntimeEventStore implements RuntimeEventStore {
  /* The structured host claim makes this store the single writer of its
     ledger, so the durable tail (last sequence and byte length) is owned in
     memory. Production #367: deriving the tail by replaying the whole file on
     every append made each streamed delta O(ledger) on the shared event loop,
     starving snapshot and concurrent admission for the length of a turn. */
  private readonly tails = new Map<string, { lastSeq: number; bytes: number }>();

  constructor(private readonly directory = statePath("structured-host-events")) {}

  load(threadId: string): RuntimeEvent[] {
    const filename = this.filename(threadId);
    let before: fs.Stats;
    try { before = fs.statSync(filename); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        forgetLedger(filename);
        return [];
      }
      throw error;
    }
    const identity = ledgerIdentity(before);
    const cached = cachedLedger(filename, identity);
    if (cached) return cached;
    let contents: string;
    try { contents = fs.readFileSync(filename, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const events: RuntimeEvent[] = [];
    const lines = contents.split("\n");
    const hasTerminatingNewline = contents.endsWith("\n");
    for (const [index, line] of lines.entries()) {
      if (!line && index === lines.length - 1 && hasTerminatingNewline) continue;
      if (!line) throw new Error("runtime event ledger contains an empty record");
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch {
        if (index === lines.length - 1 && !hasTerminatingNewline) break;
        throw new Error("runtime event ledger contains malformed JSON");
      }
      if (!validEvent(parsed)) {
        if (index === lines.length - 1 && !hasTerminatingNewline) break;
        throw new Error("runtime event ledger contains an invalid event");
      }
      const previous = events.at(-1);
      if (previous && parsed.seq !== previous.seq + 1) {
        throw new Error(`runtime event ledger sequence gap after ${previous.seq}`);
      }
      events.push(parsed);
    }
    try {
      const after = ledgerIdentity(fs.statSync(filename));
      if (sameLedgerIdentity(identity, after)) rememberLedger(filename, after, events);
    } catch { /* a concurrent replacement stays uncached */ }
    return events;
  }

  append(threadId: string, event: RuntimeEvent): void {
    if (!validEvent(event)) throw new Error("runtime event ledger append event is invalid");
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const filename = this.filename(threadId);
    const fd = fs.openSync(filename, "a+", 0o600);
    try {
      if ((fs.fstatSync(fd).mode & 0o777) !== 0o600) fs.fchmodSync(fd, 0o600);
      let tail = this.tails.get(threadId);
      if (!tail || fs.fstatSync(fd).size !== tail.bytes) {
        tail = this.reconcileTail(threadId, filename, fd);
      }
      if (tail.lastSeq > 0 && event.seq !== tail.lastSeq + 1) {
        throw new Error(`runtime event ledger sequence gap after ${tail.lastSeq}`);
      }
      const line = `${JSON.stringify(event)}\n`;
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
      const nextTail = { lastSeq: event.seq, bytes: tail.bytes + Buffer.byteLength(line) };
      this.tails.set(threadId, nextTail);
      const cached = ledgerCache().get(filename);
      const current = fs.fstatSync(fd);
      if (cached && cached.identity.size === tail.bytes && (cached.events.at(-1)?.seq ?? 0) === tail.lastSeq) {
        rememberLedger(filename, ledgerIdentity(current), [...cached.events, event]);
      } else {
        forgetLedger(filename);
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  /* First touch of a ledger, or any on-disk divergence from the owned tail
     (a torn crash tail, external truncation), replays the file once to
     re-establish the durable tail and repair an unterminated final record. */
  private reconcileTail(threadId: string, filename: string, fd: number): { lastSeq: number; bytes: number } {
    if (fs.fstatSync(fd).size === 0) {
      const empty = { lastSeq: 0, bytes: 0 };
      this.tails.set(threadId, empty);
      return empty;
    }
    const events = this.load(threadId);
    const size = fs.fstatSync(fd).size;
    const trailingByte = Buffer.allocUnsafe(1);
    const terminated = size > 0 && fs.readSync(fd, trailingByte, 0, 1, size - 1) === 1 && trailingByte[0] === 0x0a;
    if (!terminated) {
      const contents = fs.readFileSync(filename, "utf8");
      const boundary = contents.lastIndexOf("\n") + 1;
      const tailRecord = contents.slice(boundary);
      let parsed: unknown;
      try { parsed = JSON.parse(tailRecord); } catch { parsed = null; }
      if (validEvent(parsed)) fs.writeSync(fd, "\n");
      else fs.ftruncateSync(fd, Buffer.byteLength(contents.slice(0, boundary)));
    }
    const current = fs.fstatSync(fd);
    const tail = { lastSeq: events.at(-1)?.seq ?? 0, bytes: current.size };
    this.tails.set(threadId, tail);
    rememberLedger(filename, ledgerIdentity(current), events);
    return tail;
  }

  private filename(threadId: string): string {
    return path.join(this.directory, `${encodeURIComponent(threadId)}.jsonl`);
  }
}
