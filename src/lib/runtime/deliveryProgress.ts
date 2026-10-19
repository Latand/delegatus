import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { observeSqlite, parseSqliteJson } from "@/lib/sqliteReadAttribution";
import fs from "node:fs";
import path from "node:path";

import type { Database as BunDatabase } from "bun:sqlite";

import { statePath } from "@/lib/configDir";

import { isDeliveryWaitReason, type DeliveryWaitReason } from "./deliveryWaitReason";

/** Access failures leave the file's existence unknown and must reach the
    caller's read-failure handling instead of authorizing a replacement. */
function progressFileExists(filename: string): boolean {
  try {
    fs.statSync(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * What each accepted message is waiting on, kept where the delivery queue can
 * always write it: `<state>/delivery-progress.sqlite`.
 *
 * Incident 2026-10-06: two operator messages waited 409 s and 515 s before
 * host dispatch and nothing recorded why. Every phase of an original-key
 * delivery now leaves its current wait reason, the internal attempt, when it
 * last made progress, its settlement deadline and when the queue looks at it
 * next. A terminal record is kept for {@link DELIVERY_PROGRESS_TERMINAL_RETENTION_MS}
 * so the next incident can be read off it.
 *
 * The store is the queue's own, beside the registry and the runtime journal:
 * the waits it explains include the ones where those two are slow or cannot
 * be reached, so recording one must never queue behind either. The Viewer
 * holds the records in memory and writes changed ones in one short
 * transaction a few milliseconds later; a busy database keeps them for the
 * next write and never holds the event loop. Readers in other processes (the
 * MCP receipt tool) open the file read-only.
 *
 * A record carries ids, codes and times. Message text never enters it.
 */

export type DeliveryProgressTerminalState = "delivered" | "failed" | "uncertain";

export interface DeliveryPhase {
  phase: DeliveryWaitReason | DeliveryProgressTerminalState | "ingress" | "engine-echo";
  reason: string | null;
  at: string;
}

export interface DeliveryProgressRecord {
  operationId: string;
  conversationId: string;
  /** The idempotency key the message was admitted under, when known. */
  originalKey: string | null;
  kind: string;
  waitReason: DeliveryWaitReason;
  /** A short machine detail; message content stays out of it. */
  detail: string | null;
  /** Dispatch attempts this delivery has made: each `delivering` write and each
      reconciliation counts one. */
  attempt: number;
  admittedAt: string | null;
  /** When the current wait reason began. */
  phaseSince: string;
  /** When this delivery last advanced. */
  lastProgressAt: string;
  /** When the background settlement will end it if nothing else does. */
  deadlineAt: string | null;
  deadlinePolicy: "settlement-window" | "in-turn-ceiling" | null;
  /** When the queue looks at it next; the watchdog runs a pass once this is overdue. */
  nextWakeAt: string | null;
  /** Set when an active phase ran past the stall bound. */
  stalledSince: string | null;
  /** When a watchdog pass found this message after the wake meant to bring it
      never came. Kept after the reason moves on: it is incident evidence. */
  wakeLostAt: string | null;
  /** The executor instance that wrote the record last. */
  executorId: string | null;
  terminal: { state: DeliveryProgressTerminalState; at: string; reason: string | null } | null;
  updatedAt: string;
  /** Absent on records written before phase history was introduced. */
  phaseHistory?: DeliveryPhase[];
  /** Leading entries dropped by the per-send bound. */
  phaseHistoryDropped?: number;
  /** First server handler entry, before validation and the request ledger. */
  ingressAt?: string | null;
  /** First live engine user echo; replayed history supplies no arrival time. */
  engineEchoAt?: string | null;
}

export interface DeliveryProgressNote {
  waitReason: DeliveryWaitReason;
  detail?: string | null;
  /** The queue looks again within this many milliseconds. */
  nextWakeMs?: number | null;
  /** Count one more dispatch attempt. */
  attempted?: boolean;
  /** The delivery advanced even though its reason did not change. */
  progressed?: boolean;
  /** When this wait began, for one recorded after it started: the phase and
      the last progress are dated from here. */
  sinceMs?: number;
  originalKey?: string | null;
  kind?: string;
  admittedAt?: string | null;
  executorId?: string | null;
}

/** The queue's view of the store; tests pass their own. */
export interface DeliveryProgressSink {
  timing?(operationId: string, times: { ingressAt?: string; engineEchoAt?: string }): void;
  note(operationId: string, conversationId: string, note: DeliveryProgressNote): void;
  stalled(operationId: string): void;
  deadline(operationId: string, deadlineAt: string | null, policy: DeliveryProgressRecord["deadlinePolicy"]): void;
  settle(operationId: string, state: DeliveryProgressTerminalState, reason: string | null): void;
  get(operationId: string): DeliveryProgressRecord | null;
  open(): DeliveryProgressRecord[];
}

export const DELIVERY_PROGRESS_TERMINAL_RETENTION_MS = 14 * 24 * 60 * 60_000;
export const DELIVERY_PROGRESS_MIN_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const DELIVERY_PHASE_HISTORY_LIMIT = 128;
const TERMINAL_ROW_LIMIT = 5_000;
const OPEN_ROW_LIMIT = 5_000;
const FLUSH_DELAY_MS = 20;
const FLUSH_RETRY_MS = 250;
const PRUNE_INTERVAL_MS = 10 * 60_000;
const DETAIL_LIMIT = 240;

type Database = BunDatabase;

function sqliteDatabase(): typeof import("bun:sqlite").Database {
  const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
  if (!sqlite) throw new Error("The delivery progress store requires the Bun runtime");
  return sqlite.Database;
}

export function deliveryProgressPath(): string {
  return statePath("delivery-progress.sqlite");
}

function boundedDetail(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, DETAIL_LIMIT) : null;
}

function withPhase(current: Pick<DeliveryProgressRecord, "phaseHistory" | "phaseHistoryDropped"> | null, phase: DeliveryPhase): Pick<DeliveryProgressRecord, "phaseHistory" | "phaseHistoryDropped"> {
  const history = [...current?.phaseHistory ?? [], phase].sort((left, right) => left.at.localeCompare(right.at));
  const dropped = Math.max(0, history.length - DELIVERY_PHASE_HISTORY_LIMIT);
  return { phaseHistory: history.slice(dropped), phaseHistoryDropped: (current?.phaseHistoryDropped ?? 0) + dropped };
}

function parseRecord(json: string, db: BunDatabase): DeliveryProgressRecord | null {
  try {
    const value = parseSqliteJson(json, db) as DeliveryProgressRecord;
    if (!value || typeof value.operationId !== "string" || !isDeliveryWaitReason(value.waitReason)) return null;
    return value;
  } catch {
    return null;
  }
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS delivery_progress (
    operation_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    original_key TEXT,
    terminal INTEGER NOT NULL CHECK(terminal IN (0, 1)),
    updated_at INTEGER NOT NULL,
    record_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS delivery_progress_conversation ON delivery_progress(conversation_id, updated_at);
  CREATE INDEX IF NOT EXISTS delivery_progress_original_key ON delivery_progress(original_key);
  CREATE INDEX IF NOT EXISTS delivery_progress_terminal ON delivery_progress(terminal, updated_at);
  CREATE TABLE IF NOT EXISTS delivery_progress_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

/** The meta row of the completeness checkpoint (A3). */
const CHECKED_THROUGH = "checked_through";

export class DeliveryProgressStore implements DeliveryProgressSink {
  private readonly records = new Map<string, DeliveryProgressRecord>();
  private readonly dirty = new Set<string>();
  private db: Database | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPruneAt = 0;
  private loaded = false;
  /** When a read that failed may be tried again. */
  private loadRetryAt = 0;
  /** Every ending whose owner row settled before this has a record in the
      file. Null when the file holds no checkpoint (A3). */
  private checkedThrough: number | null = null;
  /** A checkpoint taken by a sweep, written only in a flush, in the same
      transaction as every record still owed when it is written. */
  private pendingCheckpoint: number | null = null;

  /** `filename` null keeps the records in memory only. */
  constructor(
    private readonly filename: string | null,
    private readonly now: () => number = Date.now,
    private readonly schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout> = setTimeout,
  ) {}

  note(operationId: string, conversationId: string, note: DeliveryProgressNote): void {
    const current = this.record(operationId);
    if (current === undefined) return;
    const at = new Date(this.now()).toISOString();
    const since = note.sinceMs !== undefined ? new Date(Math.min(note.sinceMs, this.now())).toISOString() : at;
    /* A detail belongs to the reason it was written with. */
    const detail = note.detail !== undefined ? boundedDetail(note.detail)
      : current && current.waitReason === note.waitReason ? current.detail : null;
    const nextWakeAt = note.nextWakeMs === undefined
      ? current?.nextWakeAt ?? null
      : note.nextWakeMs === null ? null : new Date(this.now() + Math.max(0, note.nextWakeMs)).toISOString();
    if (!current) {
      this.put({
        ...withPhase(null, { phase: note.waitReason, reason: detail, at: since }),
        operationId,
        conversationId,
        originalKey: note.originalKey ?? null,
        kind: note.kind ?? "send",
        waitReason: note.waitReason,
        detail,
        attempt: note.attempted ? 1 : 0,
        admittedAt: note.admittedAt ?? null,
        phaseSince: since,
        lastProgressAt: since,
        deadlineAt: null,
        deadlinePolicy: null,
        nextWakeAt,
        stalledSince: null,
        wakeLostAt: note.waitReason === "wake-lost" ? at : null,
        executorId: note.executorId ?? null,
        terminal: null,
        updatedAt: at,
      });
      return;
    }
    if (current.terminal) return;
    const reasonChanged = current.waitReason !== note.waitReason;
    const changed = reasonChanged
      || note.attempted === true
      || note.progressed === true
      || detail !== current.detail
      || nextWakeAt !== current.nextWakeAt
      || (note.originalKey != null && note.originalKey !== current.originalKey)
      || (note.admittedAt != null && note.admittedAt !== current.admittedAt)
      || (note.executorId != null && note.executorId !== current.executorId);
    if (!changed) return;
    const advanced = reasonChanged || note.attempted === true || note.progressed === true;
    this.put({
      ...current,
      ...(advanced || detail !== current.detail ? withPhase(current, { phase: note.waitReason, reason: detail, at: since }) : {}),
      conversationId,
      originalKey: note.originalKey ?? current.originalKey,
      kind: note.kind ?? current.kind,
      waitReason: note.waitReason,
      detail,
      attempt: current.attempt + (note.attempted ? 1 : 0),
      admittedAt: note.admittedAt ?? current.admittedAt,
      phaseSince: reasonChanged ? since : current.phaseSince,
      lastProgressAt: advanced && since > current.lastProgressAt ? since : current.lastProgressAt,
      nextWakeAt,
      stalledSince: advanced ? null : current.stalledSince,
      wakeLostAt: note.waitReason === "wake-lost" ? at : current.wakeLostAt ?? null,
      executorId: note.executorId ?? current.executorId,
      updatedAt: at,
    });
  }

  /**
   * Reopens the record of an operation the operator explicitly retried under
   * the same identity, once the journal re-armed it (docs/design/
   * delivery-progress-and-drain.md, A2, P13): the ending is cleared, the
   * attempt counted, the phase and progress dated now, and a lost wake kept as
   * evidence. Creates the record when there is none.
   */
  rearm(operationId: string, conversationId: string, note: DeliveryProgressNote): void {
    const current = this.record(operationId);
    if (current === undefined) return;
    if (!current) {
      this.note(operationId, conversationId, { ...note, attempted: true });
      return;
    }
    const at = new Date(this.now()).toISOString();
    this.put({
      ...current,
      ...withPhase(current, { phase: note.waitReason, reason: boundedDetail(note.detail), at }),
      conversationId,
      originalKey: note.originalKey ?? current.originalKey,
      kind: note.kind ?? current.kind,
      waitReason: note.waitReason,
      detail: boundedDetail(note.detail),
      attempt: current.attempt + 1,
      admittedAt: note.admittedAt ?? current.admittedAt,
      phaseSince: at,
      lastProgressAt: at,
      nextWakeAt: note.nextWakeMs === undefined || note.nextWakeMs === null ? null : new Date(this.now() + Math.max(0, note.nextWakeMs)).toISOString(),
      stalledSince: null,
      executorId: note.executorId ?? null,
      terminal: null,
      updatedAt: at,
    });
  }

  stalled(operationId: string): void {
    const current = this.record(operationId);
    if (!current || current.terminal || current.stalledSince) return;
    const at = new Date(this.now()).toISOString();
    this.put({ ...current, stalledSince: at, updatedAt: at });
  }

  deadline(operationId: string, deadlineAt: string | null, policy: DeliveryProgressRecord["deadlinePolicy"]): void {
    const current = this.record(operationId);
    if (!current || current.terminal || (current.deadlineAt === deadlineAt && current.deadlinePolicy === policy)) return;
    this.put({ ...current, deadlineAt, deadlinePolicy: policy, updatedAt: new Date(this.now()).toISOString() });
  }

  settle(operationId: string, state: DeliveryProgressTerminalState, reason: string | null): void {
    const current = this.record(operationId);
    /* An ending stands, with one exception: a message recorded as possibly
       delivered that later evidence shows arrived. A discard and a proven loss
       end `failed` and are never promoted. */
    if (!current || (current.terminal && !(state === "delivered" && current.terminal.state === "uncertain"))) return;
    const at = new Date(this.now()).toISOString();
    this.put({
      ...current,
      nextWakeAt: null,
      stalledSince: null,
      lastProgressAt: at,
      terminal: { state, at, reason: boundedDetail(reason) },
      ...withPhase(current, { phase: state, reason: boundedDetail(reason), at }),
      updatedAt: at,
    });
  }

  /** Add observation times without advancing delivery, rearming it or changing
      the executor's current phase. Retries and event replay write each once. */
  timing(operationId: string, times: { ingressAt?: string; engineEchoAt?: string }): void {
    let current = this.record(operationId);
    if (!current) return;
    for (const field of ["ingressAt", "engineEchoAt"] as const) {
      const value = times[field];
      if (current[field] || !value || !Number.isFinite(Date.parse(value))) continue;
      const at = new Date(value).toISOString();
      current = { ...current, [field]: at,
        ...withPhase(current, { phase: field === "ingressAt" ? "ingress" : "engine-echo", reason: null, at }) };
      this.put(current);
    }
  }

  get(operationId: string): DeliveryProgressRecord | null {
    return this.record(operationId) ?? null;
  }

  /** A cold record still owns its fields and history. Null proves absence;
      undefined means unreadable, so an update must leave the saved row alone. */
  private record(operationId: string): DeliveryProgressRecord | null | undefined {
    this.load();
    const current = this.records.get(operationId);
    if (current) return current;
    if (!this.loaded) return undefined;
    if (this.filename === null) return null;
    try {
      if (!progressFileExists(this.filename)) return null;
      const row = this.connection().query<{ record_json: string }, [string]>(
        "SELECT record_json FROM delivery_progress WHERE operation_id = ?",
      ).get(operationId);
      if (!row) return null;
      const record = parseRecord(row.record_json, this.connection());
      if (!record) return undefined;
      this.records.set(operationId, record);
      this.trimMemory();
      return record;
    } catch (error) {
      console.error("[delivery progress] read failed", { error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }

  /** Whether the store holds a record of the operation, in memory or only on
      disk (a terminal record trimmed from memory): `unknown` when the file
      could not be read, which proves neither. */
  presence(operationId: string): "present" | "absent" | "unknown" {
    this.load();
    if (this.records.has(operationId)) return "present";
    if (this.filename === null) return "absent";
    if (!this.loaded) return "unknown";
    try {
      if (!progressFileExists(this.filename)) return "absent";
      return this.connection().query<{ found: number }, [string]>("SELECT 1 AS found FROM delivery_progress WHERE operation_id = ?").get(operationId) !== null
        ? "present" : "absent";
    } catch {
      return "unknown";
    }
  }

  /** {@link presence}, with an unreadable file taken as holding it, so
      nothing is written over a record that may be there. */
  knows(operationId: string): boolean {
    return this.presence(operationId) !== "absent";
  }

  /**
   * Writes the ending of a send the store never recorded (A3): its original
   * key, admission time, kind and the ending the delivery record holds, with
   * the existing retention and nothing else: no rearm, no wake, no dispatch.
   * Answers whether a record was written.
   */
  backfillEnded(ended: {
    operationId: string;
    conversationId: string;
    originalKey: string | null;
    kind: string;
    admittedAt: string | null;
    settledAt: string | null;
    state: DeliveryProgressTerminalState;
    reason: string | null;
  }): boolean {
    if (this.knows(ended.operationId)) return false;
    const at = ended.settledAt ?? new Date(this.now()).toISOString();
    this.put({
      operationId: ended.operationId,
      conversationId: ended.conversationId,
      originalKey: ended.originalKey,
      kind: ended.kind,
      waitReason: "queued",
      detail: "recorded from the delivery record",
      attempt: 0,
      admittedAt: ended.admittedAt,
      phaseSince: ended.admittedAt ?? at,
      lastProgressAt: at,
      deadlineAt: null,
      deadlinePolicy: null,
      nextWakeAt: null,
      stalledSince: null,
      wakeLostAt: null,
      executorId: null,
      terminal: { state: ended.state, at, reason: boundedDetail(ended.reason) },
      updatedAt: new Date(this.now()).toISOString(),
    });
    return true;
  }

  /** How far back an ending may be missing from this store: the persisted
      checkpoint, or the whole record retention when there is none. */
  completenessMark(): number {
    this.load();
    return this.checkedThrough ?? this.now() - DELIVERY_PROGRESS_TERMINAL_RETENTION_MS;
  }

  /** Takes a checkpoint after a sweep restored every ending up to it; it is
      persisted with the next flush. */
  checkpoint(throughMs: number): void {
    this.load();
    if (!Number.isFinite(throughMs)) return;
    this.pendingCheckpoint = Math.max(throughMs, this.pendingCheckpoint ?? throughMs);
    this.scheduleFlush(FLUSH_DELAY_MS);
  }

  open(): DeliveryProgressRecord[] {
    this.load();
    return [...this.records.values()].filter((record) => !record.terminal);
  }

  /** Records that ended `uncertain`: the ones a later acknowledgement can still correct. */
  uncertain(): DeliveryProgressRecord[] {
    this.load();
    const uncertain = new Map<string, DeliveryProgressRecord>();
    /* Retention can outgrow the completion cache. An evicted ending still
       needs the sweep that can carry its late acknowledgement into history. */
    if (this.filename !== null) {
      try {
        if (progressFileExists(this.filename)) {
          const rows = this.connection().query<{ record_json: string }, [number]>(`
            SELECT record_json FROM delivery_progress
            WHERE terminal = 1 AND updated_at >= ?
              AND CASE WHEN json_valid(record_json)
                THEN json_extract(record_json, '$.terminal.state') END = 'uncertain'
          `).all(this.now() - DELIVERY_PROGRESS_TERMINAL_RETENTION_MS);
          for (const row of rows) {
            const record = parseRecord(row.record_json, this.connection());
            if (record) uncertain.set(record.operationId, record);
          }
        }
      } catch (error) {
        console.error("[delivery progress] read failed", { error: error instanceof Error ? error.message : String(error) });
      }
    }
    /* The owner can have confirmed or rearmed a saved uncertain row since
       its last flush. Those pending transitions win over the file. */
    for (const record of this.records.values()) {
      if (record.terminal?.state === "uncertain") uncertain.set(record.operationId, record);
      else uncertain.delete(record.operationId);
    }
    return [...uncertain.values()];
  }

  forConversation(conversationIds: readonly string[]): DeliveryProgressRecord[] {
    this.load();
    const wanted = new Set(conversationIds);
    return [...this.records.values()].filter((record) => wanted.has(record.conversationId));
  }

  /** Writes every changed record now. Answers whether nothing is left owed. */
  flush(): boolean {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const checkpoint = this.pendingCheckpoint;
    if ((this.dirty.size === 0 && checkpoint === null) || this.filename === null) {
      this.dirty.clear();
      if (checkpoint !== null) this.checkedThrough = Math.max(checkpoint, this.checkedThrough ?? checkpoint);
      this.pendingCheckpoint = null;
      return true;
    }
    const pending = [...this.dirty];
    try {
      const db = this.connection();
      db.exec("BEGIN IMMEDIATE");
      try {
        const upsert = db.query(`
          INSERT INTO delivery_progress(operation_id, conversation_id, original_key, terminal, updated_at, record_json)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(operation_id) DO UPDATE SET conversation_id = excluded.conversation_id,
            original_key = excluded.original_key, terminal = excluded.terminal,
            updated_at = excluded.updated_at, record_json = excluded.record_json
        `);
        for (const operationId of pending) {
          const record = this.records.get(operationId);
          if (!record) continue;
          upsert.run(record.operationId, record.conversationId, record.originalKey, record.terminal ? 1 : 0,
            Date.parse(record.updatedAt), JSON.stringify(record));
        }
        /* The checkpoint lands with every record still owed, so a file can
           never claim an ending it does not hold. */
        if (checkpoint !== null) {
          db.query("INSERT INTO delivery_progress_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .run(CHECKED_THROUGH, String(checkpoint));
        }
        if (this.now() - this.lastPruneAt >= PRUNE_INTERVAL_MS) this.prune(db);
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* never opened */ }
        throw error;
      }
      for (const operationId of pending) this.dirty.delete(operationId);
      if (checkpoint !== null) {
        this.checkedThrough = Math.max(checkpoint, this.checkedThrough ?? checkpoint);
        if (this.pendingCheckpoint === checkpoint) this.pendingCheckpoint = null;
      }
      return true;
    } catch (error) {
      /* Busy or unwritable: the records stay owed and in memory, and the next
         write tries again. A store that cannot be written never fails delivery. */
      if (!/locked|busy/i.test(String(error))) {
        console.error("[delivery progress] write failed", { error: error instanceof Error ? error.message : String(error) });
      }
      this.scheduleFlush(FLUSH_RETRY_MS);
      return false;
    }
  }

  close(): void {
    this.flush();
    this.db?.close();
    this.db = null;
  }

  private put(record: DeliveryProgressRecord): void {
    this.records.set(record.operationId, record);
    this.dirty.add(record.operationId);
    this.trimMemory();
    this.scheduleFlush(FLUSH_DELAY_MS);
  }

  private trimMemory(): void {
    if (this.records.size <= TERMINAL_ROW_LIMIT + OPEN_ROW_LIMIT) return;
    /* Oldest terminal records leave memory first; they stay on disk until the
       prune retires them. */
    const terminal = [...this.records.values()].filter((record) => record.terminal && !this.dirty.has(record.operationId))
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    for (const record of terminal) {
      if (this.records.size <= TERMINAL_ROW_LIMIT + OPEN_ROW_LIMIT) break;
      this.records.delete(record.operationId);
    }
  }

  private scheduleFlush(delayMs: number): void {
    if (this.flushTimer || this.filename === null) return;
    const timer = this.schedule(() => {
      this.flushTimer = null;
      this.flush();
    }, delayMs);
    (timer as { unref?: () => void }).unref?.();
    this.flushTimer = timer;
  }

  private connection(): Database {
    if (this.db) return this.db;
    fs.mkdirSync(path.dirname(this.filename!), { recursive: true, mode: 0o700 });
    const Database = sqliteDatabase();
    const db = observeSqlite(new Database(this.filename!, { create: true, strict: true }), "delivery-progress");
    try {
      db.exec("PRAGMA busy_timeout = 0; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
      db.exec(SCHEMA);
      for (const candidate of [this.filename!, `${this.filename}-wal`, `${this.filename}-shm`]) {
        try { fs.chmodSync(candidate, 0o600); } catch { /* not created yet */ }
      }
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;
    return db;
  }

  private prune(db: Database): void {
    return withViewerOperation("delivery-progress.prune", () => {
    this.lastPruneAt = this.now();
    const cutoff = this.now() - DELIVERY_PROGRESS_TERMINAL_RETENTION_MS;
    db.query("DELETE FROM delivery_progress WHERE terminal = 1 AND updated_at < ?").run(cutoff);
    db.query(`
      DELETE FROM delivery_progress WHERE terminal = 1 AND updated_at < ? AND operation_id IN (
        SELECT operation_id FROM delivery_progress WHERE terminal = 1
        ORDER BY updated_at DESC LIMIT -1 OFFSET ?
      )
    `).run(this.now() - DELIVERY_PROGRESS_MIN_RETENTION_MS, TERMINAL_ROW_LIMIT);
    /* An open record nobody has touched past the retention belongs to an
       operation that left through a path that never said so. */
    db.query("DELETE FROM delivery_progress WHERE terminal = 0 AND updated_at < ?").run(cutoff);
    for (const [operationId, record] of this.records) {
      if (Date.parse(record.updatedAt) < cutoff && !this.dirty.has(operationId)) this.records.delete(operationId);
    }
    });
  }

  /** The records already on disk, read once, so a restarted Viewer continues
      the ones its predecessor wrote. */
  private load(): void {
    if (this.loaded) return;
    /* A read that failed is tried again, at most once per retry interval:
       the store counts as loaded only once a read succeeded. */
    if (this.now() < this.loadRetryAt) return;
    if (this.filename === null) { this.loaded = true; return; }
    try {
      if (!progressFileExists(this.filename)) { this.loaded = true; return; }
      /* Retained completions can outgrow the cache. Every open send must still
         be loaded; cold completed sends are read by operation id on demand. */
      const rows = this.connection().query<{ record_json: string }, [number, number]>(`
        SELECT record_json FROM delivery_progress WHERE terminal = 0
        UNION ALL
        SELECT record_json FROM (
          SELECT record_json FROM delivery_progress
          WHERE terminal = 1 AND updated_at >= ?
          ORDER BY updated_at DESC LIMIT ?
        )
      `).all(this.now() - DELIVERY_PROGRESS_TERMINAL_RETENTION_MS, TERMINAL_ROW_LIMIT + OPEN_ROW_LIMIT);
      for (const row of rows) {
        const record = parseRecord(row.record_json, this.connection());
        if (record && !this.records.has(record.operationId)) this.records.set(record.operationId, record);
      }
      this.trimMemory();
      /* A file written by an earlier build has no meta table: no checkpoint. */
      try {
        const stored = this.connection().query<{ value: string }, [string]>("SELECT value FROM delivery_progress_meta WHERE key = ?").get(CHECKED_THROUGH);
        const through = stored ? Number(stored.value) : NaN;
        this.checkedThrough = Number.isFinite(through) ? through : null;
      } catch {
        this.checkedThrough = null;
      }
      this.loaded = true;
    } catch (error) {
      this.loadRetryAt = this.now() + FLUSH_RETRY_MS;
      this.db?.close();
      this.db = null;
      console.error("[delivery progress] read failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

const processStore = process as typeof process & {
  __llvDeliveryProgressStore?: DeliveryProgressStore;
  __llvDeliveryProgressPath?: string;
};

/** The Viewer's store, shared by every module realm in the process, and
    reopened if the state directory it belongs to changes. */
export function deliveryProgressStore(): DeliveryProgressStore {
  const filename = deliveryProgressPath();
  if (!processStore.__llvDeliveryProgressStore || processStore.__llvDeliveryProgressPath !== filename) {
    processStore.__llvDeliveryProgressStore?.close();
    processStore.__llvDeliveryProgressStore = new DeliveryProgressStore(filename);
    processStore.__llvDeliveryProgressPath = filename;
  }
  return processStore.__llvDeliveryProgressStore;
}

/** The Viewer's store when this process already holds it for the current state
    directory, and null in a process that holds none (an MCP server): a
    process that does not own the records never writes them. */
export function ownedDeliveryProgressStore(): DeliveryProgressStore | null {
  const owned = processStore.__llvDeliveryProgressStore;
  return owned && processStore.__llvDeliveryProgressPath === deliveryProgressPath() ? owned : null;
}

/** Observations are optional for ports that do not own the progress store. */
export function recordDeliveryIngress(operationId: string | undefined, ingressAt: string,
  progress?: Pick<DeliveryProgressSink, "timing"> | null): void {
  if (!operationId) return;
  try { (progress === undefined ? ownedDeliveryProgressStore() : progress)?.timing?.(operationId, { ingressAt }); }
  catch { /* Observation never changes a delivery's outcome. */ }
}

/** Tests only. */
export function setDeliveryProgressStoreForTests(store: DeliveryProgressStore | null): void {
  processStore.__llvDeliveryProgressStore = store ?? undefined;
  processStore.__llvDeliveryProgressPath = store ? deliveryProgressPath() : undefined;
}

/**
 * One record read from the file, for a process that does not own the store
 * (the MCP receipt tool). Missing, unreadable or busy answers null: progress is
 * an explanation beside a receipt and decides nothing about it.
 */
export function readDeliveryProgress(
  operationIds: readonly string[],
  file?: string,
): Map<string, DeliveryProgressRecord> {
  const found = new Map<string, DeliveryProgressRecord>();
  const owned = processStore.__llvDeliveryProgressStore;
  if (owned && (file === undefined || path.resolve(file) === path.resolve(processStore.__llvDeliveryProgressPath ?? ""))) {
    for (const operationId of operationIds) {
      const record = owned.get(operationId);
      if (record) found.set(operationId, record);
    }
    return found;
  }
  if (operationIds.length === 0) return found;
  let db: Database | null = null;
  try {
    const filename = file ?? deliveryProgressPath();
    if (!fs.existsSync(filename)) return found;
    const Database = sqliteDatabase();
    db = observeSqlite(new Database(filename, { readonly: true, strict: true }), "delivery-progress");
    db.exec("PRAGMA busy_timeout = 0");
    const read = db.query<{ record_json: string }, [string]>("SELECT record_json FROM delivery_progress WHERE operation_id = ?");
    for (const operationId of operationIds.slice(0, 200)) {
      const row = read.get(operationId);
      const record = row ? parseRecord(row.record_json, db) : null;
      if (record) found.set(operationId, record);
    }
  } catch {
    return found;
  } finally {
    db?.close();
  }
  return found;
}
