import fs from "node:fs";
import path from "node:path";

import type { Database as BunDatabase } from "bun:sqlite";

import { statePath } from "@/lib/configDir";

import { isDeliveryWaitReason, type DeliveryWaitReason } from "./deliveryWaitReason";

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
  originalKey?: string | null;
  kind?: string;
  admittedAt?: string | null;
  executorId?: string | null;
}

/** The queue's view of the store; tests pass their own. */
export interface DeliveryProgressSink {
  note(operationId: string, conversationId: string, note: DeliveryProgressNote): void;
  stalled(operationId: string): void;
  deadline(operationId: string, deadlineAt: string | null, policy: DeliveryProgressRecord["deadlinePolicy"]): void;
  settle(operationId: string, state: DeliveryProgressTerminalState, reason: string | null): void;
  get(operationId: string): DeliveryProgressRecord | null;
  open(): DeliveryProgressRecord[];
}

export const DELIVERY_PROGRESS_TERMINAL_RETENTION_MS = 14 * 24 * 60 * 60_000;
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

function parseRecord(json: string): DeliveryProgressRecord | null {
  try {
    const value = JSON.parse(json) as DeliveryProgressRecord;
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
`;

export class DeliveryProgressStore implements DeliveryProgressSink {
  private readonly records = new Map<string, DeliveryProgressRecord>();
  private readonly dirty = new Set<string>();
  private db: Database | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPruneAt = 0;
  private loaded = false;

  /** `filename` null keeps the records in memory only. */
  constructor(
    private readonly filename: string | null,
    private readonly now: () => number = Date.now,
    private readonly schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout> = setTimeout,
  ) {}

  note(operationId: string, conversationId: string, note: DeliveryProgressNote): void {
    this.load();
    const at = new Date(this.now()).toISOString();
    const current = this.records.get(operationId);
    /* A detail belongs to the reason it was written with. */
    const detail = note.detail !== undefined ? boundedDetail(note.detail)
      : current && current.waitReason === note.waitReason ? current.detail : null;
    const nextWakeAt = note.nextWakeMs === undefined
      ? current?.nextWakeAt ?? null
      : note.nextWakeMs === null ? null : new Date(this.now() + Math.max(0, note.nextWakeMs)).toISOString();
    if (!current) {
      this.put({
        operationId,
        conversationId,
        originalKey: note.originalKey ?? null,
        kind: note.kind ?? "send",
        waitReason: note.waitReason,
        detail,
        attempt: note.attempted ? 1 : 0,
        admittedAt: note.admittedAt ?? null,
        phaseSince: at,
        lastProgressAt: at,
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
      conversationId,
      originalKey: note.originalKey ?? current.originalKey,
      kind: note.kind ?? current.kind,
      waitReason: note.waitReason,
      detail,
      attempt: current.attempt + (note.attempted ? 1 : 0),
      admittedAt: note.admittedAt ?? current.admittedAt,
      phaseSince: reasonChanged ? at : current.phaseSince,
      lastProgressAt: advanced ? at : current.lastProgressAt,
      nextWakeAt,
      stalledSince: advanced ? null : current.stalledSince,
      wakeLostAt: note.waitReason === "wake-lost" ? at : current.wakeLostAt ?? null,
      executorId: note.executorId ?? current.executorId,
      updatedAt: at,
    });
  }

  stalled(operationId: string): void {
    this.load();
    const current = this.records.get(operationId);
    if (!current || current.terminal || current.stalledSince) return;
    const at = new Date(this.now()).toISOString();
    this.put({ ...current, stalledSince: at, updatedAt: at });
  }

  deadline(operationId: string, deadlineAt: string | null, policy: DeliveryProgressRecord["deadlinePolicy"]): void {
    this.load();
    const current = this.records.get(operationId);
    if (!current || current.terminal || (current.deadlineAt === deadlineAt && current.deadlinePolicy === policy)) return;
    this.put({ ...current, deadlineAt, deadlinePolicy: policy, updatedAt: new Date(this.now()).toISOString() });
  }

  settle(operationId: string, state: DeliveryProgressTerminalState, reason: string | null): void {
    this.load();
    const current = this.records.get(operationId);
    if (!current || current.terminal) return;
    const at = new Date(this.now()).toISOString();
    this.put({
      ...current,
      nextWakeAt: null,
      stalledSince: null,
      lastProgressAt: at,
      terminal: { state, at, reason: boundedDetail(reason) },
      updatedAt: at,
    });
  }

  get(operationId: string): DeliveryProgressRecord | null {
    this.load();
    return this.records.get(operationId) ?? null;
  }

  open(): DeliveryProgressRecord[] {
    this.load();
    return [...this.records.values()].filter((record) => !record.terminal);
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
    if (this.dirty.size === 0 || this.filename === null) {
      this.dirty.clear();
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
        if (this.now() - this.lastPruneAt >= PRUNE_INTERVAL_MS) this.prune(db);
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* never opened */ }
        throw error;
      }
      for (const operationId of pending) this.dirty.delete(operationId);
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
    const db = new Database(this.filename!, { create: true, strict: true });
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
    this.lastPruneAt = this.now();
    const cutoff = this.now() - DELIVERY_PROGRESS_TERMINAL_RETENTION_MS;
    db.query("DELETE FROM delivery_progress WHERE terminal = 1 AND updated_at < ?").run(cutoff);
    db.query(`
      DELETE FROM delivery_progress WHERE terminal = 1 AND operation_id IN (
        SELECT operation_id FROM delivery_progress WHERE terminal = 1
        ORDER BY updated_at DESC LIMIT -1 OFFSET ?
      )
    `).run(TERMINAL_ROW_LIMIT);
    /* An open record nobody has touched past the retention belongs to an
       operation that left through a path that never said so. */
    db.query("DELETE FROM delivery_progress WHERE terminal = 0 AND updated_at < ?").run(cutoff);
    for (const [operationId, record] of this.records) {
      if (Date.parse(record.updatedAt) < cutoff && !this.dirty.has(operationId)) this.records.delete(operationId);
    }
  }

  /** The records already on disk, read once, so a restarted Viewer continues
      the ones its predecessor wrote. */
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (this.filename === null || !fs.existsSync(this.filename)) return;
    try {
      const rows = this.connection().query<{ record_json: string }, [number, number]>(`
        SELECT record_json FROM delivery_progress
        WHERE terminal = 0 OR updated_at >= ?
        ORDER BY updated_at DESC LIMIT ?
      `).all(this.now() - DELIVERY_PROGRESS_TERMINAL_RETENTION_MS, TERMINAL_ROW_LIMIT + OPEN_ROW_LIMIT);
      for (const row of rows) {
        const record = parseRecord(row.record_json);
        if (record && !this.records.has(record.operationId)) this.records.set(record.operationId, record);
      }
    } catch (error) {
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
    db = new Database(filename, { readonly: true, strict: true });
    db.exec("PRAGMA busy_timeout = 0");
    const read = db.query<{ record_json: string }, [string]>("SELECT record_json FROM delivery_progress WHERE operation_id = ?");
    for (const operationId of operationIds.slice(0, 200)) {
      const row = read.get(operationId);
      const record = row ? parseRecord(row.record_json) : null;
      if (record) found.set(operationId, record);
    }
  } catch {
    return found;
  } finally {
    db?.close();
  }
  return found;
}
