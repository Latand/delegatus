import type { Database } from "bun:sqlite";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import {
  ANTIGRAVITY_DEFAULT_ACCOUNT_ID,
  antigravityDefaultHome,
  readAntigravityAuthState,
  recordAntigravityAuthState,
} from "@/lib/accounts/antigravity";
import type { DurableQuotaObservation } from "@/lib/accounts/migration/contracts";
import {
  antigravityModelsFromAcp,
  resolveAntigravityModelAndEffort,
  writeAntigravityModelCatalog,
} from "@/lib/agent/antigravityModels";
import { grantedMcpServers } from "@/lib/agent/mcpAllowlist";
import { agentRegistry, type ProcessIdentity } from "@/lib/agent/registry";
import {
  antigravityLimitsFromExhaustion,
  parseAntigravityQuotaError,
  type AntigravityQuotaExhaustion,
} from "@/lib/limits/antigravityQuota";
import { noteAntigravitySessionActivity } from "@/lib/limits/antigravityTranscriptLimits";
import {
  resolveClaudeMcpServers,
  viewerMcpHttpUrl,
  viewerMcpServerEntry,
  viewerMcpTransportForLaunch,
  VIEWER_SPAWN_CAPABILITY_ENV,
  VIEWER_SPAWN_CAPABILITY_HEADER,
  type ViewerMcpServerEntry,
} from "@/lib/agent/spawnPolicy";
import type { NativePromptAnchor } from "@/lib/agentState/model";
import { readNativePromptAnchor } from "@/lib/agentState/transcript";
import { repositoryPublicationSource } from "@/lib/git/repositoryCommitIdentity";
import { heapAttribution } from "@/lib/heapAttribution";
import { mcpHttpAccessToken, MCP_HTTP_ACCESS_HEADER } from "@/lib/mcp/httpAccess";
import { procBackend } from "@/lib/proc";
import { signalDetachedProcessGroup, type ProcessSignal } from "@/lib/processGroup";
import { STRUCTURED_HOST_STAMP_ENV, structuredHostStamp } from "@/lib/scanner/process";

import type { AgentMemoryCell } from "./agentMemory";
import { agentConfigSandboxRoot, withAgentConfigSandbox } from "./agentConfigSandbox";
import { memoryField, memoryKillText } from "./agentMemoryState";
import { nativeProcessId, signalAgentDomain, signalBoundaryOff, signalDomain, spawnManagedEngine } from "./agentSignalSandbox";
import type {
  DeliveryAcceptanceObservation,
  DeliveryReceipt,
  EngineHost,
  HostState,
  QueueEntry,
  RuntimeEvent,
  SessionMaterializationEvidence,
} from "./engineHost";
import { normalizeQueueEntry, StructuredHostAdoptionCleanupError } from "./engineHost";
import {
  FileRuntimeEventStore,
  nextRuntimeEventSequence,
  reconcileRuntimeEventCursor,
  type RuntimeEventCursorRecoveryReporter,
  type RuntimeEventStore,
} from "./eventStore";
import { attachRuntimeEvents, boundMap, HostEventWindow, type RuntimeEventSubscriber } from "./hostEventWindow";
import { hostExitProcess, observeHostExit, recordHostStop, withHostStopOrigin } from "./hostExit";
import { releaseIdleHostEventWindow } from "./idleHostEventWindow";
import { MAX_STRUCTURED_IMAGE_ENCODED_BYTES, runtimeImageStore } from "./runtimeImageStore";
import { STRUCTURED_IMAGE_CAPABILITY, type StructuredImageRef } from "./structuredContent";
import { TURN_SILENCE_REASON, TurnSilence, type TurnSilenceOptions } from "./turnSilence";

/**
 * Antigravity CLI (`agy`) hosted over ACP (Agent Client Protocol) on stdio
 * (docs/design/antigravity-engine.md §3.3).
 *
 * One `agy acp` child per conversation. Model and `thought_level` are applied
 * through `session/set_config_option` on both fresh start (`session/new`) and
 * resume (`session/resume`), because `agy 1.5.13` resets `currentModelId` to
 * the account default across restarts.
 *
 * `AntigravityAcpHost` writes its own append-only NDJSON transcript
 * (`<antigravityHome>/sessions/<sessionId>/events.jsonl`) through one verified
 * open file descriptor directly from structured ACP events so Delegatus never
 * decodes `agy`'s internal protobuf SQLite tables.
 *
 * Write confinement (all paths remain under Delegatus-managed roots):
 * - Transcript NDJSON: `<antigravityHome>/sessions/<sessionId>/events.jsonl`
 *   (single verified `O_NOFOLLOW` descriptor, opened once after `sessionId` validation).
 * - Native `agy` CLI state: `<antigravityHome>/native-home/.gemini/`
 *   (confined via child `HOME` so `agy` never writes into the operator's `~/.gemini/`,
 *   while preserving per-account native session DBs for `session/resume`).
 * - Agent sandbox XDG/state roots: `<sandboxRoot>/{config,cache,data,state}`
 *   (`XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`,
 *   and `LLV_STATE_DIR` via `withAgentConfigSandbox`).
 * - Runtime event ledger: `<LLV_STATE_DIR>/structured-host-events/<sessionId>.jsonl`
 *   via `FileRuntimeEventStore` (shared schema with Claude/Codex/Copilot hosts
 *   and read by `structuredHostRetirement`).
 * - Non-sensitive metadata: `<LLV_STATE_DIR>/antigravity-auth-state.json` and
 *   `<LLV_STATE_DIR>/antigravity-models.json`.
 *
 * ACP has no documented steer semantics: concurrent `send()` is refused as
 * `stale-turn`, and mid-turn delivery routes through `session/cancel` ->
 * bounded wait -> `session/prompt` (`steerFallback = "interrupt"`), reporting
 * `interrupt-then-turn-started` and never `steered`.
 */

type JsonObject = Record<string, unknown>;
type Subscriber = RuntimeEventSubscriber;
const ANTIGRAVITY_SENT_ENTRY_MEMORY = 4096;
const ANTIGRAVITY_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
type UnsequencedEvent = RuntimeEvent extends infer Event
  ? Event extends RuntimeEvent ? Omit<Event, "seq"> : never
  : never;
type PendingRequest = {
  method: string;
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | null;
};
type RunningPrompt = {
  turnId: string;
  entryId: string;
  promptText: string;
  imageCount: number;
  accepted: boolean;
  settled: Promise<void>;
  confirmation: Promise<DeliveryAcceptanceObservation>;
  confirmationResult: DeliveryAcceptanceObservation | null;
  resolveConfirmation: (result: DeliveryAcceptanceObservation) => void;
};
type DeliveryAcceptanceRecord =
  | { state: "pending"; turnId: string }
  | { state: "accepted"; turnId: string; acceptedAt: string }
  | { state: "failed"; turnId: string; reason: string }
  | { state: "unavailable"; turnId: string; reason: string };

/** Reduces durable runtime ledger events into delivery acceptance state for one
    or all delivery ids. Each new `antigravity.delivery_dispatched` attempt
    supersedes an earlier failed attempt by its `turnId`, and only a matching
    `turnId` failure can finalize that attempt to `failed`. Once a `deliveryEcho`
    is recorded for an id, `accepted` is permanent. */
function reduceDeliveryAcceptanceEvent(
  current: DeliveryAcceptanceRecord | undefined,
  event: RuntimeEvent,
  targetEntryId: string,
): DeliveryAcceptanceRecord | undefined {
  if (event.kind !== "item") return current;
  if (event.deliveryEcho?.operationId === targetEntryId) {
    const turnId = event.turnId || current?.turnId || `restored:${targetEntryId}`;
    return {
      state: "accepted",
      turnId,
      acceptedAt: event.deliveryEcho.at,
    };
  }
  const itemObj = record(event.item);
  const itemType = stringField(itemObj, "type");
  const itemEntryId = stringField(itemObj, "entryId");
  if (itemEntryId !== targetEntryId) return current;
  if (current?.state === "accepted") return current;
  if (itemType === "antigravity.delivery_dispatched") {
    const turnId = event.turnId ?? stringField(itemObj, "turnId") ?? "";
    return {
      state: "unavailable",
      turnId,
      reason: `Antigravity delivery ${targetEntryId} acceptance could not be verified after an interrupted host or ledger failure`,
    };
  }
  if (itemType === "antigravity.delivery_failed") {
    const failedTurnId = event.turnId ?? stringField(itemObj, "turnId") ?? "";
    if (current && current.turnId && failedTurnId !== current.turnId) return current;
    return {
      state: "failed",
      turnId: failedTurnId,
      reason: stringField(itemObj, "reason") ?? `Antigravity rejected delivery ${targetEntryId}`,
    };
  }
  return current;
}

function extractDeliveryEventIds(event: RuntimeEvent): string[] {
  if (event.kind !== "item") return [];
  const ids: string[] = [];
  const echoId = event.deliveryEcho?.operationId;
  if (echoId) ids.push(echoId);
  const itemObj = record(event.item);
  const itemType = stringField(itemObj, "type");
  const itemEntryId = stringField(itemObj, "entryId");
  if (
    itemEntryId
    && itemEntryId !== echoId
    && (itemType === "antigravity.delivery_dispatched" || itemType === "antigravity.delivery_failed")
  ) {
    ids.push(itemEntryId);
  }
  return ids;
}

function reduceDeliveryAcceptanceIntoMap(
  map: Map<string, { record: DeliveryAcceptanceRecord; seq: number }>,
  event: RuntimeEvent,
): boolean {
  const ids = extractDeliveryEventIds(event);
  if (ids.length === 0) return false;
  let updated = false;
  for (const id of ids) {
    const prev = map.get(id);
    const next = reduceDeliveryAcceptanceEvent(prev?.record, event, id);
    if (next) {
      map.delete(id);
      map.set(id, { record: next, seq: event.seq });
      updated = true;
    }
  }
  return updated;
}

interface DeliveryAcceptanceRow {
  state: string;
  turn_id: string;
  accepted_at: string | null;
  reason: string | null;
}

interface LedgerFileFingerprint {
  ledgerPath: string;
  dev: string;
  ino: string;
  fileSize: string;
  mtimeNs: string;
  ctimeNs: string;
  tailSha256: string;
}

const MAX_LEDGER_HOME_REGISTRY = 256;
const LEDGER_CONTENT_SAMPLE_BYTES = 4096;
const ledgerHomeRegistry = new Map<string, string>();

function canonicalizeFilePath(pathname: string): string {
  const resolved = path.resolve(pathname);
  try {
    return fs.realpathSync(resolved);
  } catch {
    const dir = path.dirname(resolved);
    try {
      return path.join(fs.realpathSync(dir), path.basename(resolved));
    } catch {
      return resolved;
    }
  }
}

/** Hashes head, middle, and tail samples (or full contents when <= 16 KiB) plus
 * byte length so same-length replacements at any region are detected in O(1) I/O. */
function readContentSampleSha256(filePath: string, size: number): string {
  const hash = crypto.createHash("sha256");
  hash.update(`v2:${size}:`);
  if (size <= 0) return hash.digest("hex");
  const fd = fs.openSync(filePath, "r");
  try {
    if (size <= LEDGER_CONTENT_SAMPLE_BYTES * 4) {
      const buf = Buffer.allocUnsafe(size);
      const bytesRead = fs.readSync(fd, buf, 0, size, 0);
      hash.update(buf.subarray(0, bytesRead));
      return hash.digest("hex");
    }
    const buf = Buffer.allocUnsafe(LEDGER_CONTENT_SAMPLE_BYTES);
    const offsets = [
      0,
      Math.max(0, Math.floor((size - LEDGER_CONTENT_SAMPLE_BYTES) / 2)),
      Math.max(0, size - LEDGER_CONTENT_SAMPLE_BYTES),
    ];
    for (const offset of offsets) {
      const bytesRead = fs.readSync(fd, buf, 0, LEDGER_CONTENT_SAMPLE_BYTES, offset);
      hash.update(buf.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

function statLedgerFingerprint(
  ledgerPath: string,
): { exists: true; fingerprint: LedgerFileFingerprint } | { exists: false; enoent: boolean; error?: string } {
  try {
    const canonical = canonicalizeFilePath(ledgerPath);
    const stat = fs.statSync(canonical, { bigint: true });
    if (!stat.isFile()) return { exists: false, enoent: false, error: "runtime event ledger path is not a regular file" };
    const sizeNumber = Number(stat.size);
    return {
      exists: true,
      fingerprint: {
        ledgerPath: canonical,
        dev: String(stat.dev),
        ino: String(stat.ino),
        fileSize: String(stat.size),
        mtimeNs: String(stat.mtimeNs),
        ctimeNs: String(stat.ctimeNs),
        tailSha256: readContentSampleSha256(canonical, sizeNumber),
      },
    };
  } catch (error) {
    const enoent = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { exists: false, enoent, ...(enoent ? {} : { error: safeError(error) }) };
  }
}

function sameLedgerFingerprint(left: LedgerFileFingerprint | null, right: LedgerFileFingerprint | null): boolean {
  if (!left || !right) return false;
  return left.ledgerPath === right.ledgerPath
    && left.dev === right.dev
    && left.ino === right.ino
    && left.fileSize === right.fileSize
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.tailSha256 === right.tailSha256;
}

function rememberLedgerAntigravityHome(ledgerPath: string, antigravityHome: string): void {
  const canonicalLedger = canonicalizeFilePath(ledgerPath);
  const canonicalHome = canonicalizeFilePath(antigravityHome);
  ledgerHomeRegistry.delete(canonicalLedger);
  ledgerHomeRegistry.set(canonicalLedger, canonicalHome);
  while (ledgerHomeRegistry.size > MAX_LEDGER_HOME_REGISTRY) {
    const oldest = ledgerHomeRegistry.keys().next().value;
    if (oldest === undefined) break;
    ledgerHomeRegistry.delete(oldest);
  }
}

function antigravityHomeFromArtifactPath(artifactPath: string | null | undefined): string | null {
  if (!artifactPath || typeof artifactPath !== "string") return null;
  if (path.basename(artifactPath) !== "events.jsonl") return null;
  const sessionDir = path.dirname(artifactPath);
  const sessionsDir = path.dirname(sessionDir);
  if (path.basename(sessionsDir) !== "sessions") return null;
  return path.dirname(sessionsDir);
}

function deliveryRecordFromRow(row: DeliveryAcceptanceRow | null | undefined): DeliveryAcceptanceRecord | null {
  if (!row) return null;
  if (row.state === "accepted") {
    return { state: "accepted", turnId: row.turn_id, acceptedAt: row.accepted_at ?? "" };
  }
  if (row.state === "failed") {
    return { state: "failed", turnId: row.turn_id, reason: row.reason ?? "Antigravity rejected delivery" };
  }
  if (row.state === "unavailable") {
    return { state: "unavailable", turnId: row.turn_id, reason: row.reason ?? "Antigravity delivery acceptance is unavailable" };
  }
  return null;
}

/** Durable O(1) keyed index of Antigravity delivery acceptance facts by
    `(session_id, delivery_id)`, confined inside `<antigravityHome>`.
    All SQL uses SQLite 3.39-safe syntax (macOS system SQLite compatible). */
class AntigravityDeliveryIndex {
  private readonly db: Database;

  private constructor(db: Database) {
    this.db = db;
  }

  static open(antigravityHome: string, readonly = false): AntigravityDeliveryIndex | null {
    const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
    if (!sqlite) return null;
    const resolvedHome = path.resolve(antigravityHome);
    if (!readonly) fs.mkdirSync(resolvedHome, { recursive: true, mode: 0o700 });
    const homeStat = fs.lstatSync(resolvedHome);
    if (homeStat.isSymbolicLink() || !homeStat.isDirectory()) {
      throw new Error("Antigravity home root must be a real directory");
    }
    const canonicalHome = fs.realpathSync(resolvedHome);
    const dbPath = path.join(canonicalHome, "delivery-acceptance.sqlite");
    try {
      const dbStat = fs.lstatSync(dbPath);
      if (dbStat.isSymbolicLink() || !dbStat.isFile()) {
        throw new Error("Antigravity delivery index path must be a regular file");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (readonly) return null;
    }
    const db = new sqlite.Database(dbPath, readonly ? { readonly: true } : { create: true });
    try {
      // Never block the event loop waiting on another process's write lock:
      // fail fast on SQLITE_BUSY and fall back cleanly to the JSONL ledger.
      db.exec("PRAGMA busy_timeout=0;");
      if (!readonly) {
        try { fs.chmodSync(dbPath, 0o600); } catch { /* best effort */ }
        const existingTables = db.query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('antigravity_delivery_acceptance', 'antigravity_delivery_ledger_sync', 'antigravity_delivery_ledger_fingerprint')",
        ).get()?.count ?? 0;
        if (existingTables < 3) {
          db.exec(
            "PRAGMA journal_mode=WAL;"
            + "PRAGMA synchronous=NORMAL;"
            + "CREATE TABLE IF NOT EXISTS antigravity_delivery_acceptance ("
            + "  session_id TEXT NOT NULL,"
            + "  delivery_id TEXT NOT NULL,"
            + "  state TEXT NOT NULL,"
            + "  turn_id TEXT NOT NULL,"
            + "  accepted_at TEXT,"
            + "  reason TEXT,"
            + "  seq INTEGER NOT NULL,"
            + "  PRIMARY KEY (session_id, delivery_id)"
            + ");"
            + "CREATE TABLE IF NOT EXISTS antigravity_delivery_ledger_sync ("
            + "  session_id TEXT PRIMARY KEY,"
            + "  synced_seq INTEGER NOT NULL,"
            + "  synced_count INTEGER NOT NULL,"
            + "  max_delivery_seq INTEGER NOT NULL"
            + ");"
            + "CREATE TABLE IF NOT EXISTS antigravity_delivery_ledger_fingerprint ("
            + "  session_id TEXT PRIMARY KEY,"
            + "  ledger_path TEXT NOT NULL,"
            + "  dev TEXT NOT NULL,"
            + "  ino TEXT NOT NULL,"
            + "  file_size TEXT NOT NULL,"
            + "  mtime_ns TEXT NOT NULL,"
            + "  ctime_ns TEXT NOT NULL,"
            + "  tail_sha256 TEXT NOT NULL DEFAULT ''"
            + ");",
          );
        }
        const fpColumns = db.query<{ name: string }, []>(
          "PRAGMA table_info(antigravity_delivery_ledger_fingerprint)",
        ).all();
        if (fpColumns.length > 0 && !fpColumns.some((col) => col.name === "tail_sha256")) {
          db.exec("ALTER TABLE antigravity_delivery_ledger_fingerprint ADD COLUMN tail_sha256 TEXT NOT NULL DEFAULT '';");
        }
      }
      return new AntigravityDeliveryIndex(db);
    } catch (error) {
      try { db.close(); } catch { /* ignore */ }
      throw error;
    }
  }

  get(sessionId: string, deliveryId: string): DeliveryAcceptanceRecord | null {
    const row = this.db.query<DeliveryAcceptanceRow, [string, string]>(
      "SELECT state, turn_id, accepted_at, reason FROM antigravity_delivery_acceptance WHERE session_id = ? AND delivery_id = ?",
    ).get(sessionId, deliveryId);
    return deliveryRecordFromRow(row);
  }

  matchesFingerprint(sessionId: string, expected: LedgerFileFingerprint): boolean {
    try {
      const row = this.db.query<{
        ledger_path: string;
        dev: string;
        ino: string;
        file_size: string;
        mtime_ns: string;
        ctime_ns: string;
        tail_sha256: string;
      }, [string]>(
        "SELECT ledger_path, dev, ino, file_size, mtime_ns, ctime_ns, tail_sha256 FROM antigravity_delivery_ledger_fingerprint WHERE session_id = ?",
      ).get(sessionId);
      if (!row) return false;
      return row.ledger_path === expected.ledgerPath
        && row.dev === expected.dev
        && row.ino === expected.ino
        && row.file_size === expected.fileSize
        && row.mtime_ns === expected.mtimeNs
        && row.ctime_ns === expected.ctimeNs
        && row.tail_sha256 === expected.tailSha256;
    } catch {
      return false;
    }
  }

  syncSession(
    sessionId: string,
    ledgerTailSeq: number,
    entries: ReadonlyMap<string, { record: DeliveryAcceptanceRecord; seq: number }>,
    maxDeliverySeq: number,
    fingerprint?: LedgerFileFingerprint | null,
  ): void {
    const syncRow = this.db.query<
      { synced_seq: number; synced_count: number; max_delivery_seq: number },
      [string]
    >(
      "SELECT synced_seq, synced_count, max_delivery_seq FROM antigravity_delivery_ledger_sync WHERE session_id = ?",
    ).get(sessionId);
    const hasRows = this.db.query<{ found: number }, [string]>(
      "SELECT 1 AS found FROM antigravity_delivery_acceptance WHERE session_id = ? LIMIT 1",
    ).get(sessionId) !== null;

    if (entries.size === 0 && !syncRow && !hasRows && !fingerprint) {
      return;
    }

    // Reconcile the entire session atomically against the canonical ledger
    // snapshot already loaded by `restore()`. An incremental skip based on
    // seq/count alone can leave stale entries behind or miss altered middle
    // entries when an older backup of the JSONL ledger is restored and extended.
    const upsert = this.db.query(
      "INSERT OR REPLACE INTO antigravity_delivery_acceptance (session_id, delivery_id, state, turn_id, accepted_at, reason, seq) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const updateSync = this.db.query(
      "INSERT OR REPLACE INTO antigravity_delivery_ledger_sync (session_id, synced_seq, synced_count, max_delivery_seq) VALUES (?, ?, ?, ?)",
    );
    const deleteSession = this.db.query(
      "DELETE FROM antigravity_delivery_acceptance WHERE session_id = ?",
    );
    const deleteSync = this.db.query(
      "DELETE FROM antigravity_delivery_ledger_sync WHERE session_id = ?",
    );
    const upsertFingerprint = this.db.query(
      "INSERT OR REPLACE INTO antigravity_delivery_ledger_fingerprint (session_id, ledger_path, dev, ino, file_size, mtime_ns, ctime_ns, tail_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const deleteFingerprint = this.db.query(
      "DELETE FROM antigravity_delivery_ledger_fingerprint WHERE session_id = ?",
    );

    this.db.transaction(() => {
      deleteSession.run(sessionId);
      if (entries.size === 0) {
        deleteSync.run(sessionId);
      } else {
        for (const [deliveryId, entry] of entries) {
          const rec = entry.record;
          upsert.run(
            sessionId,
            deliveryId,
            rec.state,
            rec.turnId,
            rec.state === "accepted" ? rec.acceptedAt : null,
            rec.state === "failed" || rec.state === "unavailable" ? rec.reason : null,
            entry.seq,
          );
        }
        updateSync.run(sessionId, ledgerTailSeq, entries.size, maxDeliverySeq);
      }
      if (fingerprint) {
        upsertFingerprint.run(
          sessionId,
          fingerprint.ledgerPath,
          fingerprint.dev,
          fingerprint.ino,
          fingerprint.fileSize,
          fingerprint.mtimeNs,
          fingerprint.ctimeNs,
          fingerprint.tailSha256,
        );
      } else {
        deleteFingerprint.run(sessionId);
      }
    })();
  }

  applyEvent(sessionId: string, event: RuntimeEvent, fingerprint?: LedgerFileFingerprint | null): void {
    const ids = extractDeliveryEventIds(event);
    if (ids.length === 0) {
      if (!fingerprint) return;
      this.db.query(
        "INSERT OR REPLACE INTO antigravity_delivery_ledger_fingerprint (session_id, ledger_path, dev, ino, file_size, mtime_ns, ctime_ns, tail_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        sessionId,
        fingerprint.ledgerPath,
        fingerprint.dev,
        fingerprint.ino,
        fingerprint.fileSize,
        fingerprint.mtimeNs,
        fingerprint.ctimeNs,
        fingerprint.tailSha256,
      );
      return;
    }
    const selectRow = this.db.query<DeliveryAcceptanceRow, [string, string]>(
      "SELECT state, turn_id, accepted_at, reason FROM antigravity_delivery_acceptance WHERE session_id = ? AND delivery_id = ?",
    );
    const upsert = this.db.query(
      "INSERT OR REPLACE INTO antigravity_delivery_acceptance (session_id, delivery_id, state, turn_id, accepted_at, reason, seq) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const selectSync = this.db.query<
      { synced_seq: number; synced_count: number; max_delivery_seq: number },
      [string]
    >(
      "SELECT synced_seq, synced_count, max_delivery_seq FROM antigravity_delivery_ledger_sync WHERE session_id = ?",
    );
    const updateSync = this.db.query(
      "INSERT OR REPLACE INTO antigravity_delivery_ledger_sync (session_id, synced_seq, synced_count, max_delivery_seq) VALUES (?, ?, ?, ?)",
    );
    const upsertFingerprint = this.db.query(
      "INSERT OR REPLACE INTO antigravity_delivery_ledger_fingerprint (session_id, ledger_path, dev, ino, file_size, mtime_ns, ctime_ns, tail_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );

    this.db.transaction(() => {
      let inserted = 0;
      for (const deliveryId of ids) {
        const existingRow = selectRow.get(sessionId, deliveryId);
        const existing = deliveryRecordFromRow(existingRow) ?? undefined;
        const next = reduceDeliveryAcceptanceEvent(existing, event, deliveryId);
        if (!next) continue;
        if (!existingRow) inserted += 1;
        upsert.run(
          sessionId,
          deliveryId,
          next.state,
          next.turnId,
          next.state === "accepted" ? next.acceptedAt : null,
          next.state === "failed" || next.state === "unavailable" ? next.reason : null,
          event.seq,
        );
      }
      const syncRow = selectSync.get(sessionId);
      updateSync.run(
        sessionId,
        Math.max(syncRow?.synced_seq ?? 0, event.seq),
        (syncRow?.synced_count ?? 0) + inserted,
        Math.max(syncRow?.max_delivery_seq ?? 0, event.seq),
      );
      if (fingerprint) {
        upsertFingerprint.run(
          sessionId,
          fingerprint.ledgerPath,
          fingerprint.dev,
          fingerprint.ino,
          fingerprint.fileSize,
          fingerprint.mtimeNs,
          fingerprint.ctimeNs,
          fingerprint.tailSha256,
        );
      }
    })();
  }

  clearFingerprint(sessionId: string): void {
    try {
      this.db.query("DELETE FROM antigravity_delivery_ledger_fingerprint WHERE session_id = ?").run(sessionId);
    } catch { /* best effort */ }
  }

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }
}

export interface AntigravitySessionIdentity {
  sessionId: string;
  /** `<antigravityHome>/sessions/<id>/events.jsonl`, owned by this host. */
  path: string;
}

export type AntigravityViewerMcpServer = ViewerMcpServerEntry | { url: string; headers?: Record<string, string> };

export interface AntigravityAcpHostOptions {
  turnSilence?: TurnSilenceOptions;
  assertCurrent?: () => void;
  cwd: string;
  /** Delegatus-owned account home whose `sessions/<id>/events.jsonl` holds transcripts. */
  antigravityHome: string;
  accountId?: string;
  /** Base model id (`gemini-4-neon`) or combined `agy models` id (`gemini-4-neon-xhigh`). */
  model?: string;
  /** Reasoning effort (`low`..`max`); overrides any effort suffix on `model`. */
  effort?: string;
  /** Bypass launch profiles pass `--dangerously-skip-permissions`. */
  allowAll?: boolean;
  /** Additional workspace directories passed via `--add-dir` and `additionalDirectories`. */
  additionalDirectories?: readonly string[];
  /** Appended to system instructions via `_meta.antigravity.systemPrompt.append`. */
  appendSystemPrompt?: string | null;
  /** Granted MCP servers from the launch profile; attached natively in `session/new` and `session/resume`. */
  mcpServers?: readonly string[];
  binary?: string;
  env?: NodeJS.ProcessEnv;
  viewerMcpServer?: AntigravityViewerMcpServer | null;
  releaseCleanup?: () => void;
  requestTimeoutMs?: number;
  interruptTimeoutMs?: number;
  shutdownGraceMs?: number;
  initialEventCursor?: number;
  onEventCursorRecovery?: RuntimeEventCursorRecoveryReporter;
  memoryCell?: AgentMemoryCell | null;
  spawnProcess?: (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
  signalProcess?: ProcessSignal;
  processIdentity?: (pid: number) => string | null;
  eventStore?: RuntimeEventStore;
  readImage?: (ref: StructuredImageRef) => Buffer;
  /** Optional sink for durable quota exhaustion observations; defaults to agentRegistry(). */
  recordQuotaObservation?: (observation: DurableQuotaObservation) => void;
}

export const ANTIGRAVITY_TRANSCRIPT_SCHEMA_VERSION = 1;
/** Measured `session/cancel` return latency is ~14 ms; keep a 10 s bound so load cannot trip it. */
export const ANTIGRAVITY_INTERRUPT_TIMEOUT_MS = 10_000;

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 1_000;
const SESSION_CLOSE_TIMEOUT_MS = 1_000;
const MAX_LINE_BYTES = MAX_STRUCTURED_IMAGE_ENCODED_BYTES + 256 * 1024;
const ACP_PROTOCOL_VERSION = 1;

/** Allowlisted environment variables inherited by `agy acp`. Strips other
    engines' provider keys, GitHub tokens, and `LLV_SPAWN_CAPABILITY`. */
const CHILD_ENV_ALLOWLIST = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG",
  "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR", "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "LLV_EVIDENCE_DIR", "LLV_STATE_DIR", "LLV_VIEWER_DEPLOY_TARGET", "LLV_VIEWER_PORT",
] as const;

export function validateAntigravitySessionId(sessionId: string): string {
  if (
    typeof sessionId !== "string"
    || !ANTIGRAVITY_SESSION_ID_PATTERN.test(sessionId)
    || sessionId.includes("..")
  ) {
    throw new Error("Antigravity session id is invalid");
  }
  return sessionId;
}

/** Reads durable owner-verified acceptance evidence for one Antigravity delivery
    from the structured runtime event ledger. Uses an O(1) SQLite point read when
    the derived index is proven consistent with the canonical JSONL ledger file
    (`dev`, `ino`, `size`, `mtimeNs`, `ctimeNs`), and falls back cleanly to the
    canonical JSONL ledger on busy DB, missing index, or modified history. */
export async function readAntigravityConfirmedDelivery(
  sessionId: string,
  deliveryId: string,
  options?: { eventStore?: RuntimeEventStore; antigravityHome?: string; artifactPath?: string },
): Promise<{ turnId: string; acceptedAt: string } | null> {
  if (!ANTIGRAVITY_SESSION_ID_PATTERN.test(sessionId) || sessionId.includes("..") || !deliveryId) return null;
  const store = options?.eventStore ?? new FileRuntimeEventStore();
  const ledgerFile = typeof store.ledgerPath === "function" ? store.ledgerPath(sessionId) : null;
  if (ledgerFile) {
    const stat = statLedgerFingerprint(ledgerFile);
    if (!stat.exists && stat.enoent) return null;
    if (stat.exists) {
      const candidateHomes = new Set<string>();
      if (options?.antigravityHome) candidateHomes.add(options.antigravityHome);
      const fromArtifact = antigravityHomeFromArtifactPath(options?.artifactPath);
      if (fromArtifact) candidateHomes.add(fromArtifact);
      const remembered = ledgerHomeRegistry.get(stat.fingerprint.ledgerPath);
      if (remembered) candidateHomes.add(remembered);
      candidateHomes.add(antigravityDefaultHome());
      for (const home of candidateHomes) {
        let index: AntigravityDeliveryIndex | null = null;
        try {
          index = AntigravityDeliveryIndex.open(home, true);
          if (index && index.matchesFingerprint(sessionId, stat.fingerprint)) {
            const rec = index.get(sessionId, deliveryId);
            return rec?.state === "accepted"
              ? { turnId: rec.turnId, acceptedAt: rec.acceptedAt }
              : null;
          }
        } catch {
          // Busy DB or unreadable index: fall through to next candidate or canonical JSONL ledger.
        } finally {
          index?.close();
        }
      }
    }
  }
  let current: DeliveryAcceptanceRecord | undefined;
  if (store.scan) {
    await store.scan(sessionId, (event) => {
      current = reduceDeliveryAcceptanceEvent(current, event, deliveryId);
    });
  } else {
    for (const event of store.load(sessionId)) {
      current = reduceDeliveryAcceptanceEvent(current, event, deliveryId);
    }
  }
  return current?.state === "accepted"
    ? { turnId: current.turnId, acceptedAt: current.acceptedAt }
    : null;
}

export function antigravityNativeHome(antigravityHome: string): string {
  return path.join(antigravityHome, "native-home");
}

export function antigravityTranscriptPath(antigravityHome: string, sessionId: string): string {
  const valid = validateAntigravitySessionId(sessionId);
  const sessionsDir = path.resolve(antigravityHome, "sessions");
  const transcriptPath = path.resolve(sessionsDir, valid, "events.jsonl");
  if (!transcriptPath.startsWith(sessionsDir + path.sep)) {
    throw new Error("Antigravity transcript path escapes sessions directory");
  }
  return transcriptPath;
}

/** Builds the filtered, confined child environment for `agy acp`.
    Applies `withAgentConfigSandbox` (matching Claude/Codex/Copilot hosts) and
    confines `HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, and `XDG_STATE_HOME`
    so native `agy` state stays under Delegatus's managed directories instead
    of writing into the operator's `~/.gemini/` or XDG roots. */
export function antigravityChildEnv(
  source: NodeJS.ProcessEnv,
  antigravityHome?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: source.NODE_ENV };
  for (const name of CHILD_ENV_ALLOWLIST) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  /* Never leak the spawn capability into the child environment; it travels
     strictly inside the Viewer MCP server descriptor. */
  delete env[VIEWER_SPAWN_CAPABILITY_ENV];
  withAgentConfigSandbox(env, source, antigravityHome);
  const sandboxRoot = agentConfigSandboxRoot(source, antigravityHome);
  const cacheHome = path.join(sandboxRoot, "cache");
  const dataHome = path.join(sandboxRoot, "data");
  const stateHome = path.join(sandboxRoot, "state");
  env.XDG_CACHE_HOME = cacheHome;
  env.XDG_DATA_HOME = dataHome;
  env.XDG_STATE_HOME = stateHome;
  const dirs = [cacheHome, dataHome, stateHome];
  if (antigravityHome) {
    const nativeHome = antigravityNativeHome(antigravityHome);
    env.HOME = nativeHome;
    dirs.unshift(nativeHome);
  }
  for (const dir of dirs) {
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* best effort */ }
  }
  env[STRUCTURED_HOST_STAMP_ENV] = structuredHostStamp();
  return env;
}

export function antigravityViewerMcpServer(
  launchEnv: Readonly<Record<string, string | undefined>>,
): AntigravityViewerMcpServer {
  const access = mcpHttpAccessToken();
  return viewerMcpTransportForLaunch(launchEnv) === "http"
    ? { url: viewerMcpHttpUrl(), ...(access ? { headers: { [MCP_HTTP_ACCESS_HEADER]: access } } : {}) }
    : viewerMcpServerEntry();
}

/** Builds the ACP `mcpServers` array passed directly to `session/new` and
    `session/resume`. `agy 1.5.13` natively accepts both stdio and HTTP servers. */
export function antigravityMcpServers(
  viewer: AntigravityViewerMcpServer | null,
  capability: string | null,
  registered: Record<string, unknown> = {},
  allowlist: readonly string[] = ["viewer"],
): JsonObject[] {
  const granted = new Set(grantedMcpServers(allowlist));
  const servers: JsonObject[] = [];

  for (const [name, raw] of Object.entries(registered)) {
    if (!granted.has(name) || name === "viewer") continue;
    const definition = record(raw);
    if (!definition) continue;
    const type = definition.type;
    if (type === "stdio" || type === "local" || (type === undefined && typeof definition.command === "string")) {
      if (typeof definition.command !== "string") continue;
      const envObj = record(definition.env);
      const env = envObj
        ? Object.entries(envObj)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string")
          .map(([k, v]) => ({ name: k, value: v }))
        : [];
      servers.push({
        name,
        command: definition.command,
        args: Array.isArray(definition.args) ? definition.args.filter((arg): arg is string => typeof arg === "string") : [],
        env,
      });
    } else if ((type === "http" || type === "sse") && typeof definition.url === "string") {
      const rawHeaders = record(definition.headers);
      const headers = rawHeaders
        ? Object.entries(rawHeaders)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string")
          .map(([k, v]) => ({ name: k, value: v }))
        : [];
      servers.push({ type, name, url: definition.url, headers });
    }
  }

  if (!viewer || !granted.has("viewer")) return servers;
  if ("url" in viewer) {
    const headersMap: Record<string, string> = {
      ...(viewer.headers ?? {}),
      ...(capability ? { [VIEWER_SPAWN_CAPABILITY_HEADER]: capability } : {}),
    };
    servers.push({
      type: "http",
      name: "viewer",
      url: viewer.url,
      headers: Object.entries(headersMap).map(([name, value]) => ({ name, value })),
    });
  } else {
    const envMap: Record<string, string> = {
      ...viewer.env,
      ...(capability ? { [VIEWER_SPAWN_CAPABILITY_ENV]: capability } : {}),
    };
    servers.push({
      name: "viewer",
      command: viewer.command,
      args: [...viewer.args],
      env: Object.entries(envMap).map(([name, value]) => ({ name, value })),
    });
  }
  return servers;
}

/** Pure launch argv for `agy acp`. */
export function antigravityLaunchArgs(
  options: Pick<AntigravityAcpHostOptions, "allowAll" | "additionalDirectories">,
): string[] {
  const args = ["acp", "--disable-telemetry"];
  if (options.allowAll) args.push("--dangerously-skip-permissions");
  for (const dir of options.additionalDirectories ?? []) {
    if (typeof dir === "string" && dir.trim()) args.push("--add-dir", dir.trim());
  }
  return args;
}

function record(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function stringField(value: unknown, key: string): string | null {
  const object = record(value);
  return object && typeof object[key] === "string" ? object[key] as string : null;
}

const EMAIL_PATTERN = new RegExp("\\b[A-Za-z0-9._%+-]+\\x40[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b", "g");

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(EMAIL_PATTERN, "[redacted-email]")
    .replace(/(ya29\.[A-Za-z0-9._-]+|AIza[0-9A-Za-z_-]{20,}|Bearer\s+[A-Za-z0-9._-]+)/gi, "[redacted]")
    .slice(0, 500);
}

function extractToolOutputText(update: JsonObject): string {
  const rawOutput = record(update.rawOutput);
  if (typeof rawOutput?.output === "string") return rawOutput.output;
  if (typeof update.rawOutput === "string") return update.rawOutput;
  if (Array.isArray(update.content)) {
    const parts: string[] = [];
    for (const item of update.content) {
      const entry = record(item);
      const inner = record(entry?.content);
      if (typeof inner?.text === "string") parts.push(inner.text);
      else if (typeof entry?.text === "string") parts.push(entry.text);
    }
    if (parts.length) return parts.join("\n");
  }
  return "";
}

export class AntigravityAcpHost implements EngineHost {
  readonly supportsSteer = false;
  /** ACP has no documented steer: mid-turn messages route through interrupt-and-resend. */
  readonly steerFallback = "interrupt" as const;
  identity: AntigravitySessionIdentity;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly options: AntigravityAcpHostOptions;
  private readonly mcpServersPayload: JsonObject[];
  private readonly eventStore: RuntimeEventStore;
  private readonly turnSilence: TurnSilence;
  private readonly readImage: (ref: StructuredImageRef) => Buffer;
  private readonly requestTimeoutMs: number;
  private readonly interruptTimeoutMs: number;
  private readonly shutdownGraceMs: number;
  private readonly signalProcess: ProcessSignal;
  private readonly processIdentity: (pid: number) => string | null;
  private readonly childStartIdentity: string | null;
  private readonly exitProcess: import("@/lib/processIdentity").ProcessIdentity | null;

  heapAttribution() {
    let queuedEvents = 0;
    for (const subscriber of this.subscribers) queuedEvents += subscriber.queue.length;
    return {
      engine: "antigravity",
      events: this.events.length,
      ...this.eventWindow.heapAttribution(),
      eventSubscribers: this.subscribers.size,
      stateSubscribers: this.stateListeners.size,
      queuedEvents,
    };
  }

  private readonly subscribers = new Set<Subscriber>();
  private readonly eventWindow = new HostEventWindow();
  private readonly events = this.eventWindow.events;
  private eventWindowReleased = false;
  private eventWindowRevision = 0;
  private outstandingPrompt: RunningPrompt | null = null;

  releaseIdleEventWindow(canRelease: () => boolean): Promise<boolean> {
    const transcriptPath = this.identity.path;
    return releaseIdleHostEventWindow({
      events: this.events,
      revision: () => this.eventWindowRevision,
      transcriptPath,
      eligible: () => this.identity.path === transcriptPath && !this.dead && !this.releasing && !this.released
        && this.outstandingPrompt === null && canRelease(),
      onRelease: () => { this.eventWindow.release(); this.eventWindowReleased = true; },
    });
  }

  private eventWindowRefill: Promise<void> | undefined;

  private refillEventWindow(): Promise<void> | undefined {
    if (!this.eventWindowReleased) return;
    return this.eventWindowRefill ??= this.eventWindow.refill(this.eventStore, this.identity.sessionId).then(() => {
      this.eventWindowReleased = false;
    }).finally(() => { this.eventWindowRefill = undefined; });
  }

  private readonly pending = new Map<number, PendingRequest>();
  private readonly attentions = new Map<string, { rpcId: number | string; request: JsonObject }>();
  private readonly cancelledTurns = new Set<string>();
  private readonly failedInterrupts = new Map<string, number>();
  private readonly sentEntries = new Map<string, string>();
  private readonly deliveryAcceptance = new Map<string, DeliveryAcceptanceRecord>();
  private deliveryAcceptanceEvicted = false;
  private deliveryMutationSeq = 0;
  private deliveryIndex: AntigravityDeliveryIndex | null = null;
  private deliveryIndexHealthy = false;
  private lastLedgerFingerprint: LedgerFileFingerprint | null = null;
  private ledgerReconciliationPending = false;
  private readonly stateListeners = new Set<(state: HostState) => void>();
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private readonly launchFlags: readonly string[];
  private transcriptFd: number | null = null;
  private stdoutBuffer = "";
  private nextRequestId = 1;
  private turnCounter = 0;
  private confirmedPromptOrdinal = 0;
  private running: RunningPrompt | null = null;
  private pendingAssistantText = "";
  private currentModel: string | null = null;
  private currentBaseModel: string | null = null;
  private currentEffort: string | null = null;
  private tierName: string | null = null;
  private cursor: number;
  private protocolVersion: string | null = null;
  private replaying = false;
  private dead = false;
  private readonly memoryCell: AgentMemoryCell | null;
  private releasing = false;
  private released = false;
  private reaped = false;
  private ledgerFailed = false;
  private writerFence: (() => boolean) | null = null;
  private releasePromise: Promise<void> | null = null;
  private releaseCleanup: (() => void) | null;
  private terminationTimer: ReturnType<typeof setTimeout> | null = null;
  private terminationStarted = false;
  private releaseFence: Readonly<ProcessIdentity> | null = null;
  private readonly reapedPromise: Promise<void>;
  private resolveReaped!: () => void;
  private agentStateTurnStartedAt: number | null = null;
  private agentStateNativePromptAnchor: NativePromptAnchor | null = null;

  private constructor(
    child: ChildProcessWithoutNullStreams,
    options: AntigravityAcpHostOptions,
    mcpServersPayload: JsonObject[],
  ) {
    heapAttribution.hosts.add(this, null);
    this.child = child;
    this.mcpServersPayload = mcpServersPayload;
    this.memoryCell = options.memoryCell ?? null;
    this.memoryCell?.onChange(() => this.notifyStateListeners());
    this.options = options;
    this.identity = { sessionId: "pending", path: "" };
    this.eventStore = options.eventStore ?? new FileRuntimeEventStore();
    this.turnSilence = new TurnSilence({
      engine: "antigravity",
      artifactPath: () => this.identity.path || null,
      state: () => this.currentState(),
      current: () => !this.dead && !this.releasing && !this.released && this.writerFence?.() !== false,
      expire: (turnId) => {
        this.emit({
          kind: "item",
          turnId,
          phase: "completed",
          item: {
            type: "system",
            reason: TURN_SILENCE_REASON,
            text: "The turn ended after 15 minutes without model output or tool activity. Owned process cleanup uses the existing host termination fence.",
          },
        });
        this.fail(new Error(TURN_SILENCE_REASON));
      },
      hold: (turnId, reason) => this.emit({
        kind: "item",
        turnId,
        phase: "completed",
        item: {
          type: "system",
          reason: "turn-silence-held",
          wait: reason,
          text: `Turn silence recovery is held: ${reason}.`,
          nextCheckAt: new Date(Date.now() + 30_000).toISOString(),
        },
      }),
    }, options.turnSilence);
    this.readImage = options.readImage ?? ((ref) => runtimeImageStore().read(ref));
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.interruptTimeoutMs = options.interruptTimeoutMs ?? ANTIGRAVITY_INTERRUPT_TIMEOUT_MS;
    this.shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    this.signalProcess = options.signalProcess ?? process.kill;
    this.processIdentity = options.processIdentity ?? ((pid) => procBackend.processIdentity(pid));
    this.childStartIdentity = nativeProcessId(child) ? this.processIdentity(nativeProcessId(child)!) : null;
    this.exitProcess = signalDomain(child)?.native ?? hostExitProcess(nativeProcessId(child), this.childStartIdentity);
    this.memoryCell?.setExitProcess(this.exitProcess);
    if (!signalDomain(child)) observeHostExit(child, this.exitProcess);
    this.releaseCleanup = options.releaseCleanup ?? null;
    this.cursor = options.initialEventCursor ?? 0;
    this.launchFlags = [STRUCTURED_IMAGE_CAPABILITY];
    this.reapedPromise = new Promise((resolve) => { this.resolveReaped = resolve; });

    child.stdout.on("data", (chunk: Buffer | string) => {
      this.acceptStdout(typeof chunk === "string" ? chunk : this.stdoutDecoder.write(chunk));
    });
    child.stdout.on("end", () => {
      const tail = this.stdoutDecoder.end();
      if (tail) this.acceptStdout(tail);
    });
    /* Never retain raw CLI stderr: it may contain account banners or emails. */
    child.stderr.on("data", () => {});
    child.stdin.on("error", (error) => {
      if (!this.releasing && !this.released) this.fail(new Error(`Antigravity ACP stdin failed: ${safeError(error)}`));
    });
    child.on("error", (error) => this.fail(new Error(`Antigravity child failed: ${safeError(error)}`)));
    child.on("exit", () => {
      const kill = this.memoryCell?.settleExit({ expected: this.releasing || this.released });
      if (kill?.fatal && !this.releasing && !this.released) this.fail(new Error(memoryKillText(kill)));
    });
    child.on("close", () => {
      this.memoryCell?.settleExit({ expected: this.releasing || this.released });
      this.reaped = true;
      if (this.terminationTimer) {
        clearTimeout(this.terminationTimer);
        this.terminationTimer = null;
      }
      this.resolveReaped();
      if (this.releasing) this.finishRelease();
      else if (this.dead) this.notifyStateListeners();
      else if (!this.released) this.fail(new Error(this.memoryCell?.launchFailure() ?? "Antigravity child exited"));
    });
  }

  static async start(options: AntigravityAcpHostOptions): Promise<AntigravityAcpHost> {
    return this.open(null, options);
  }

  /** Resumes a persisted session in a fresh `agy acp` process using
      `session/resume` (zero replay notifications) and re-applies model and
      `thought_level` via `session/set_config_option`. */
  static async adopt(sessionId: string, options: AntigravityAcpHostOptions): Promise<AntigravityAcpHost> {
    if (!sessionId) throw new Error("Antigravity session id is required for adoption");
    return this.open(validateAntigravitySessionId(sessionId), options);
  }

  private static async open(
    resumeSessionId: string | null,
    options: AntigravityAcpHostOptions,
  ): Promise<AntigravityAcpHost> {
    const binary = options.binary ?? process.env.LLV_ANTIGRAVITY_BIN ?? "agy";
    const cleanups: Array<() => void> = [];
    if (options.releaseCleanup) cleanups.push(options.releaseCleanup);
    const releaseCleanup = () => {
      for (const cleanup of cleanups.splice(0)) {
        try { cleanup(); } catch { /* best effort */ }
      }
    };
    let child: ChildProcessWithoutNullStreams;
    let mcpServersPayload: JsonObject[] = [];
    try {
      options = { ...options, env: await repositoryPublicationSource(options.cwd, options.env ?? process.env) };
      const env = antigravityChildEnv(options.env ?? process.env, options.antigravityHome);
      const viewer = options.viewerMcpServer === undefined
        ? (options.mcpServers ?? ["viewer"]).includes("viewer") ? antigravityViewerMcpServer(options.env ?? {}) : null
        : options.viewerMcpServer;
      const lookupHome = options.env?.HOME?.trim() || os.homedir();
      const registered = resolveClaudeMcpServers(lookupHome, options.cwd, path.join(lookupHome, ".claude.json"));
      const capability = options.env?.[VIEWER_SPAWN_CAPABILITY_ENV] ?? null;
      mcpServersPayload = antigravityMcpServers(viewer, capability, registered, options.mcpServers ?? ["viewer"]);
      child = await spawnManagedEngine(binary, antigravityLaunchArgs(options), {
        cwd: options.cwd,
        env,
        detached: true,
      }, options.memoryCell, options.spawnProcess, options.env ?? process.env, undefined, options.assertCurrent);
    } catch (error) {
      releaseCleanup();
      throw error;
    }
    const host = new AntigravityAcpHost(child, { ...options, releaseCleanup }, mcpServersPayload);
    try {
      await host.handshake(resumeSessionId);
      return host;
    } catch (error) {
      try {
        await withHostStopOrigin({ path: "antigravity-startup-cleanup", operationId: host.identity.sessionId }, () => host.release());
      } catch (cleanupError) {
        host.closeTranscriptFd();
        host.closeDeliveryIndex();
        throw new StructuredHostAdoptionCleanupError(safeError(error), host, { cause: cleanupError });
      }
      host.closeTranscriptFd();
      host.closeDeliveryIndex();
      throw new Error(safeError(error));
    }
  }

  private async handshake(resumeSessionId: string | null): Promise<void> {
    const initialized = record(await this.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {},
    }));
    const agentInfo = record(initialized?.agentInfo);
    this.protocolVersion = stringField(agentInfo, "version")
      ?? (initialized?.protocolVersion !== undefined ? String(initialized.protocolVersion) : null);

    let sessionId: string;
    let sessionPayload: JsonObject | null = null;
    if (resumeSessionId) {
      const expectedSessionId = validateAntigravitySessionId(resumeSessionId);
      this.replaying = true;
      try {
        sessionPayload = record(await this.request("session/resume", {
          sessionId: expectedSessionId,
          cwd: this.options.cwd,
          mcpServers: this.mcpServersPayload,
        }));
      } finally {
        this.replaying = false;
      }
      const returned = stringField(sessionPayload, "sessionId");
      if (returned !== null && returned !== expectedSessionId) {
        throw new Error("Antigravity session/resume returned a different session id");
      }
      sessionId = expectedSessionId;
    } else {
      const params: JsonObject = {
        cwd: this.options.cwd,
        mcpServers: this.mcpServersPayload,
      };
      if (this.options.additionalDirectories?.length) {
        params.additionalDirectories = [...this.options.additionalDirectories];
      }
      if (this.options.appendSystemPrompt?.trim()) {
        params._meta = {
          antigravity: {
            systemPrompt: { append: this.options.appendSystemPrompt },
          },
        };
      }
      sessionPayload = record(await this.request("session/new", params));
      const minted = stringField(sessionPayload, "sessionId");
      if (!minted) throw new Error("Antigravity session/new returned no session id");
      sessionId = validateAntigravitySessionId(minted);
    }

    const tier = record(record(record(sessionPayload?._meta)?.antigravity)?.tier);
    this.tierName = stringField(tier, "name");
    try {
      recordAntigravityAuthState({
        authenticated: true,
        tierName: this.tierName,
        tierId: stringField(tier, "id"),
        checkedAt: new Date().toISOString(),
      });
    } catch { /* best-effort metadata update */ }

    const availableModels = record(sessionPayload?.models)?.availableModels;
    this.captureModelCatalog(sessionPayload?.configOptions, availableModels);

    const currentModelId = stringField(record(sessionPayload?.models), "currentModelId");
    const defaultResolved = resolveAntigravityModelAndEffort(currentModelId, null);
    this.currentModel = currentModelId ?? defaultResolved.combinedId;
    this.currentBaseModel = defaultResolved.baseModel;
    this.currentEffort = defaultResolved.thoughtLevel;

    const transcriptPath = this.openVerifiedTranscript(sessionId);
    this.identity = { sessionId, path: transcriptPath };
    await this.applyModelAndEffort(sessionId, this.options.model, this.options.effort, false);

    this.appendTranscriptRecord(resumeSessionId ? "session.resume" : "session.start", {
      sessionId,
      cwd: this.options.cwd,
      model: this.currentModel,
      baseModel: this.currentBaseModel,
      effort: this.currentEffort,
      agyVersion: this.protocolVersion,
      ...(this.tierName ? { tier: this.tierName } : {}),
    });

    this.agentStateNativePromptAnchor = await readNativePromptAnchor(this.identity.path, !resumeSessionId);
    this.confirmedPromptOrdinal = 0;
    this.options.assertCurrent?.();
    this.restore();
    this.emit({ kind: "session-status", status: "idle" });
  }

  private captureModelCatalog(configOptions: unknown, availableModels?: unknown): void {
    const models = antigravityModelsFromAcp(configOptions, availableModels);
    if (!models.length) return;
    try {
      writeAntigravityModelCatalog(this.options.accountId ?? "default", models, "acp-config");
    } catch (error) {
      console.warn("[antigravity] model catalog could not be persisted", safeError(error));
    }
  }

  private async applyModelAndEffort(
    sessionId: string,
    model: string | null | undefined,
    effort: string | null | undefined,
    recordChange: boolean,
  ): Promise<void> {
    const resolved = resolveAntigravityModelAndEffort(model, effort);
    const previousBaseModel = this.currentBaseModel;
    const previousEffort = this.currentEffort;
    const previousModel = this.currentModel;
    let modelChanged = false;
    if (resolved.baseModel) {
      const modelResult = record(await this.request("session/set_config_option", {
        sessionId,
        configId: "model",
        value: resolved.baseModel,
      }));
      this.captureModelCatalog(modelResult?.configOptions);
      modelChanged = resolved.baseModel !== previousBaseModel;
      this.currentBaseModel = resolved.baseModel;
      this.currentModel = resolved.combinedId ?? resolved.baseModel;
    }
    if (resolved.thoughtLevel) {
      try {
        const effortResult = record(await this.request("session/set_config_option", {
          sessionId,
          configId: "thought_level",
          value: resolved.thoughtLevel,
        }));
        this.captureModelCatalog(effortResult?.configOptions);
        this.currentEffort = resolved.thoughtLevel;
        if (this.currentBaseModel) this.currentModel = `${this.currentBaseModel}-${resolved.thoughtLevel}`;
      } catch (effortError) {
        if (modelChanged) {
          if (previousBaseModel) {
            try {
              const restored = record(await this.request("session/set_config_option", {
                sessionId,
                configId: "model",
                value: previousBaseModel,
              }));
              this.captureModelCatalog(restored?.configOptions);
              if (previousEffort) {
                const restoredEffort = record(await this.request("session/set_config_option", {
                  sessionId,
                  configId: "thought_level",
                  value: previousEffort,
                }));
                this.captureModelCatalog(restoredEffort?.configOptions);
              }
              this.currentBaseModel = previousBaseModel;
              this.currentEffort = previousEffort;
              this.currentModel = previousModel;
            } catch {
              const failure = effortError instanceof Error ? effortError : new Error(String(effortError));
              (failure as Error & { rollbackFailed?: boolean }).rollbackFailed = true;
              throw failure;
            }
          } else {
            const failure = effortError instanceof Error ? effortError : new Error(String(effortError));
            (failure as Error & { rollbackFailed?: boolean }).rollbackFailed = true;
            throw failure;
          }
        }
        throw effortError;
      }
    }
    if (recordChange && (resolved.baseModel || resolved.thoughtLevel) && this.identity.path) {
      this.appendTranscriptRecord("session.model_change", {
        model: this.currentModel,
        baseModel: this.currentBaseModel,
        effort: this.currentEffort,
      });
    }
  }

  /** Applies a live model/effort change when idle via `session/set_config_option`. */
  async reconfigure(settings: { model?: string | null; effort?: string | null }): Promise<void> {
    if (this.unavailable()) throw new Error("Antigravity host is unavailable");
    if (this.running || this.outstandingPrompt) throw new Error("Antigravity host cannot reconfigure during an active turn");
    await this.applyModelAndEffort(this.identity.sessionId, settings.model, settings.effort, true);
  }

  private openVerifiedTranscript(sessionId: string): string {
    const valid = validateAntigravitySessionId(sessionId);
    const sessionsDir = path.resolve(this.options.antigravityHome, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
    const sessionsStat = fs.lstatSync(sessionsDir);
    if (sessionsStat.isSymbolicLink() || !sessionsStat.isDirectory()) {
      throw new Error("Antigravity sessions root must be a real directory");
    }
    const canonicalSessionsDir = fs.realpathSync(sessionsDir);
    const sessionDir = path.join(canonicalSessionsDir, valid);
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const sessionStat = fs.lstatSync(sessionDir);
    if (sessionStat.isSymbolicLink() || !sessionStat.isDirectory()) {
      throw new Error("Antigravity session directory must be a real directory");
    }
    const canonicalSessionDir = fs.realpathSync(sessionDir);
    if (!canonicalSessionDir.startsWith(canonicalSessionsDir + path.sep)) {
      throw new Error("Antigravity session directory escapes sessions root");
    }
    const canonicalTranscriptPath = path.join(canonicalSessionDir, "events.jsonl");
    const nofollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | nofollow;
    const fd = fs.openSync(canonicalTranscriptPath, flags, 0o600);
    try {
      if (!fs.fstatSync(fd).isFile()) {
        throw new Error("Antigravity transcript target is not a regular file");
      }
      this.closeTranscriptFd();
      this.transcriptFd = fd;
      return antigravityTranscriptPath(this.options.antigravityHome, valid);
    } catch (error) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
      throw error;
    }
  }

  private closeTranscriptFd(): void {
    if (this.transcriptFd === null) return;
    const fd = this.transcriptFd;
    this.transcriptFd = null;
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }

  private appendTranscriptRecord(type: string, data: JsonObject): boolean {
    if (this.transcriptFd === null) return false;
    try {
      const line = JSON.stringify({
        schemaVersion: ANTIGRAVITY_TRANSCRIPT_SCHEMA_VERSION,
        type,
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        data,
      });
      fs.writeSync(this.transcriptFd, `${line}\n`, undefined, "utf8");
      return true;
    } catch (error) {
      console.warn("[antigravity] failed to append transcript record", safeError(error));
      return false;
    }
  }

  private closeDeliveryIndex(): void {
    if (!this.deliveryIndex) return;
    const index = this.deliveryIndex;
    this.deliveryIndex = null;
    index.close();
  }

  private recordSentEntry(entryId: string, turnId: string): void {
    this.sentEntries.delete(entryId);
    this.sentEntries.set(entryId, turnId);
    if (this.sentEntries.size > ANTIGRAVITY_SENT_ENTRY_MEMORY) {
      this.deliveryAcceptanceEvicted = true;
      boundMap(this.sentEntries, ANTIGRAVITY_SENT_ENTRY_MEMORY);
    }
  }

  private recordDeliveryAcceptance(entryId: string, record: DeliveryAcceptanceRecord, liveMutation = true): void {
    if (liveMutation) this.deliveryMutationSeq += 1;
    this.deliveryAcceptance.delete(entryId);
    this.deliveryAcceptance.set(entryId, record);
    if (this.deliveryAcceptance.size > ANTIGRAVITY_SENT_ENTRY_MEMORY) {
      this.deliveryAcceptanceEvicted = true;
      boundMap(this.deliveryAcceptance, ANTIGRAVITY_SENT_ENTRY_MEMORY);
    }
  }

  /** Point-reads durable delivery state by `(sessionId, deliveryId)` after
      in-memory LRU eviction so older accepted or uncertain delivery ids are
      never forgotten or blindly re-sent, without scanning the JSONL ledger. */
  private async lookupDurableDeliveryAcceptance(entryId: string): Promise<DeliveryAcceptanceRecord | null> {
    if (this.identity.sessionId === "pending") return null;
    const mutationBefore = this.deliveryMutationSeq;
    try {
      let current: DeliveryAcceptanceRecord | undefined;
      if (this.deliveryIndexHealthy) {
        if (this.deliveryIndex) {
          current = this.deliveryIndex.get(this.identity.sessionId, entryId) ?? undefined;
        } else {
          const readonlyIndex = AntigravityDeliveryIndex.open(this.options.antigravityHome, true);
          try {
            current = readonlyIndex?.get(this.identity.sessionId, entryId) ?? undefined;
          } finally {
            readonlyIndex?.close();
          }
        }
      } else if (this.eventStore.scan) {
        await this.eventStore.scan(this.identity.sessionId, (event) => {
          current = reduceDeliveryAcceptanceEvent(current, event, entryId);
        });
      } else {
        for (const event of this.eventStore.load(this.identity.sessionId)) {
          current = reduceDeliveryAcceptanceEvent(current, event, entryId);
        }
      }
      if (this.deliveryMutationSeq !== mutationBefore) {
        // Never overwrite fresher live state with an older durable snapshot.
        return this.deliveryAcceptance.get(entryId) ?? current ?? null;
      }
      if (!current) return null;
      if (!this.deliveryAcceptance.has(entryId)) {
        this.recordDeliveryAcceptance(entryId, current, false);
      }
      if (current.state === "accepted" && !this.sentEntries.has(entryId)) {
        this.recordSentEntry(entryId, current.turnId || `restored:${entryId}`);
      }
      return current;
    } catch (error) {
      return {
        state: "unavailable",
        turnId: "",
        reason: `Antigravity runtime event ledger could not be read for delivery ${entryId}: ${safeError(error)}`,
      };
    }
  }

  /** Records owner-verified ACP acceptance for one specific delivery id.
      Persists the durable `deliveryEcho` to the runtime event ledger BEFORE
      publishing in-memory `materialized` or writing `user.message`, so a
      ledger write failure reports explicit uncertainty (`unavailable`) on both
      this host and any successor after `adopt()`. */
  private confirmDeliveryAcceptance(running: RunningPrompt): boolean {
    if (running.accepted) return this.deliveryAcceptance.get(running.entryId)?.state === "accepted";
    running.accepted = true;
    const acceptedAt = new Date().toISOString();
    const persisted = this.emit({
      kind: "item",
      turnId: running.turnId,
      phase: "completed",
      item: {
        type: "user.message",
        entryId: running.entryId,
        turnId: running.turnId,
      },
      deliveryEcho: {
        operationId: running.entryId,
        at: acceptedAt,
      },
    });
    if (!persisted) {
      const reason = `Antigravity runtime event ledger failed while persisting acceptance for delivery ${running.entryId}`;
      this.recordDeliveryAcceptance(running.entryId, {
        state: "unavailable",
        turnId: running.turnId,
        reason,
      });
      running.resolveConfirmation({ outcome: "uncertain", reason });
      return false;
    }
    const wroteUserMessage = this.appendTranscriptRecord("user.message", {
      turnId: running.turnId,
      entryId: running.entryId,
      content: running.promptText,
      imageCount: running.imageCount,
      acceptedAt,
    });
    if (wroteUserMessage) this.confirmedPromptOrdinal += 1;
    this.appendTranscriptRecord("assistant.turn_start", {
      turnId: running.turnId,
      entryId: running.entryId,
    });
    this.recordSentEntry(running.entryId, running.turnId);
    this.recordDeliveryAcceptance(running.entryId, {
      state: "accepted",
      turnId: running.turnId,
      acceptedAt,
    });
    running.resolveConfirmation({ outcome: "accepted", turnId: running.turnId });
    this.notifyStateListeners();
    return true;
  }

  private flushPendingAssistantText(turnId: string | null): void {
    if (!this.pendingAssistantText) return;
    const content = this.pendingAssistantText;
    this.pendingAssistantText = "";
    this.appendTranscriptRecord("assistant.message", {
      ...(turnId ? { turnId } : {}),
      messageId: crypto.randomUUID(),
      content,
      model: this.currentModel,
      effort: this.currentEffort,
    });
  }

  attach(afterSeq: number): AsyncIterable<RuntimeEvent> {
    this.eventWindowRevision += 1;
    return attachRuntimeEvents(afterSeq, {
      window: () => this.events,
      ledger: () => this.eventStore.load(this.identity.sessionId),
      subscribers: this.subscribers,
    }, () => this.refillEventWindow());
  }

  async send(entry: QueueEntry): Promise<DeliveryReceipt> {
    const mutationAtEntry = this.deliveryMutationSeq;
    const refill = this.dead || this.releasing || this.released ? undefined : this.refillEventWindow();
    if (refill) await refill;
    if (this.unavailable()) return { outcome: "rejected", reason: "dead-host" };
    const normalized = normalizeQueueEntry(entry);

    let priorAcceptance: DeliveryAcceptanceRecord | undefined;
    let sawConcurrentMutation = this.deliveryMutationSeq !== mutationAtEntry;
    for (;;) {
      // Reconcile against canonical JSONL before deciding from memory or SQLite
      // if the ledger file was replaced or rewritten out-of-band. Never serve a
      // cached decision when reconciliation hits an I/O error.
      const continuity = this.ensureLedgerContinuityBeforeRead();
      if (!continuity.ok) {
        return { outcome: "rejected", reason: "stale-turn", refusal: continuity.reason };
      }
      const mutationBefore = this.deliveryMutationSeq;
      const already = this.sentEntries.get(normalized.id);
      if (already) return { outcome: "turn-started", turnId: already };
      const cached = this.deliveryAcceptance.get(normalized.id);
      if (cached) {
        priorAcceptance = cached;
        break;
      }
      if (!this.deliveryAcceptanceEvicted) {
        priorAcceptance = undefined;
        break;
      }
      const durable = await this.lookupDurableDeliveryAcceptance(normalized.id);
      if (this.unavailable()) return { outcome: "rejected", reason: "dead-host" };
      if (this.deliveryMutationSeq !== mutationBefore) {
        sawConcurrentMutation = true;
        continue;
      }
      priorAcceptance = durable ?? undefined;
      break;
    }

    if (priorAcceptance?.state === "accepted") {
      const restoredTurnId = priorAcceptance.turnId || `restored:${normalized.id}`;
      this.recordSentEntry(normalized.id, restoredTurnId);
      return { outcome: "turn-started", turnId: restoredTurnId };
    }
    if (priorAcceptance?.state === "pending") {
      const inFlight = this.running?.entryId === normalized.id
        ? this.running
        : this.outstandingPrompt?.entryId === normalized.id
          ? this.outstandingPrompt
          : null;
      return {
        outcome: "turn-started",
        turnId: priorAcceptance.turnId,
        ...(inFlight
          ? { observeAcceptance: () => inFlight.confirmation }
          : {
            observeAcceptance: async () => ({
              outcome: "uncertain" as const,
              reason: `Antigravity delivery ${normalized.id} is pending without an active ACP prompt`,
            }),
          }),
      };
    }
    if (priorAcceptance?.state === "unavailable") {
      return { outcome: "rejected", reason: "stale-turn", refusal: priorAcceptance.reason };
    }
    if (priorAcceptance?.state === "failed" && sawConcurrentMutation) {
      return { outcome: "rejected", reason: "stale-turn", refusal: priorAcceptance.reason };
    }
    if (this.running || this.outstandingPrompt) return { outcome: "rejected", reason: "stale-turn" };
    if (typeof normalized.expectedTurnId === "string") return { outcome: "rejected", reason: "stale-turn" };

    const prompt: JsonObject[] = [];
    if (normalized.content.text) prompt.push({ type: "text", text: normalized.content.text });
    for (const image of normalized.content.images) {
      prompt.push({ type: "image", mimeType: image.mime, data: this.readImage(image).toString("base64") });
    }
    if (prompt.length === 0) prompt.push({ type: "text", text: "" });

    this.turnCounter += 1;
    const turnId = `antigravity:${this.turnCounter}-${crypto.randomBytes(4).toString("hex")}`;

    let settle!: () => void;
    let resolveConfirmationRaw!: (result: DeliveryAcceptanceObservation) => void;
    const confirmation = new Promise<DeliveryAcceptanceObservation>((resolve) => { resolveConfirmationRaw = resolve; });
    const running: RunningPrompt = {
      turnId,
      entryId: normalized.id,
      promptText: normalized.content.text,
      imageCount: normalized.content.images.length,
      accepted: false,
      settled: new Promise((resolve) => { settle = resolve; }),
      confirmation,
      confirmationResult: null,
      resolveConfirmation: (result) => {
        if (running.confirmationResult !== null) return;
        running.confirmationResult = result;
        resolveConfirmationRaw(result);
      },
    };
    this.recordDeliveryAcceptance(normalized.id, { state: "pending", turnId });
    this.agentStateTurnStartedAt = Date.now();
    this.pendingAssistantText = "";
    this.running = running;
    this.outstandingPrompt = running;

    const startedPersisted = this.emit({ kind: "turn-started", turnId });
    const dispatchedPersisted = startedPersisted && this.emit({
      kind: "item",
      turnId,
      phase: "started",
      item: {
        type: "antigravity.delivery_dispatched",
        entryId: normalized.id,
        turnId,
      },
    });
    if (!dispatchedPersisted) {
      if (this.running === running) this.running = null;
      if (this.outstandingPrompt === running) this.outstandingPrompt = null;
      this.sentEntries.delete(normalized.id);
      this.deliveryAcceptance.delete(normalized.id);
      this.deliveryMutationSeq += 1;
      settle();
      return { outcome: "rejected", reason: "dead-host", refusal: "Antigravity runtime event ledger failed before prompt dispatch" };
    }

    const request = this.request("session/prompt", { sessionId: this.identity.sessionId, prompt }, null);
    void request.then(
      (result) => {
        const stopReason = stringField(result, "stopReason");
        const usage = record(record(result)?.usage);
        // Base acceptance on ACP's actual response, separate from any local
        // interrupt request: if ACP raced and answered `end_turn` (not
        // `cancelled`), ACP executed the prompt and it MUST be marked accepted.
        const acpCancelled = stopReason === "cancelled";
        if (!acpCancelled || running.accepted) {
          if (!this.confirmDeliveryAcceptance(running)) {
            if (this.outstandingPrompt === running) this.outstandingPrompt = null;
            settle();
            return;
          }
        } else {
          const reason = `Antigravity cancelled delivery ${running.entryId} before ACP confirmed acceptance`;
          const failedPersisted = this.emit({
            kind: "item",
            turnId,
            phase: "completed",
            item: { type: "antigravity.delivery_failed", entryId: running.entryId, turnId, reason },
          });
          const unpersistedReason = `Antigravity runtime event ledger failed while recording cancellation for delivery ${running.entryId}`;
          this.recordDeliveryAcceptance(
            running.entryId,
            failedPersisted
              ? { state: "failed", turnId, reason }
              : { state: "unavailable", turnId, reason: unpersistedReason },
          );
          running.resolveConfirmation(
            failedPersisted
              ? { outcome: "rejected", reason }
              : { outcome: "uncertain", reason: unpersistedReason },
          );
        }
        this.flushPendingAssistantText(turnId);
        const status = acpCancelled
          ? "interrupted"
          : stopReason === "end_turn" || stopReason === "max_tokens" || stopReason === "max_turn_requests"
            ? "completed"
            : "error";
        if (acpCancelled) {
          this.appendTranscriptRecord("abort", { turnId, reason: "user_initiated" });
        } else if (status === "completed") {
          this.appendTranscriptRecord("assistant.turn_end", {
            turnId,
            stopReason: stopReason ?? "end_turn",
            ...(usage ? { usage } : {}),
          });
        } else {
          this.appendTranscriptRecord("session.error", {
            turnId,
            code: stopReason ?? "unknown",
            message: `Antigravity turn ended with stopReason: ${stopReason ?? "unknown"}`,
          });
        }
        this.finishTurn(running, status);
        if (this.outstandingPrompt === running) this.outstandingPrompt = null;
        settle();
      },
      (error) => {
        this.flushPendingAssistantText(turnId);
        const message = safeError(error);
        const interrupted = this.cancelledTurns.has(turnId);
        const rpcCode = (error as Error & { rpcCode?: unknown }).rpcCode;
        const explicitAcpRejection = typeof rpcCode === "number";
        if (!running.accepted) {
          if (explicitAcpRejection) {
            const reason = interrupted
              ? `Antigravity cancelled delivery ${running.entryId} before ACP confirmed acceptance`
              : `Antigravity rejected delivery ${running.entryId}: ${message}`;
            const failedPersisted = this.emit({
              kind: "item",
              turnId,
              phase: "completed",
              item: { type: "antigravity.delivery_failed", entryId: running.entryId, turnId, reason },
            });
            const unpersistedReason = `Antigravity runtime event ledger failed while recording outcome for delivery ${running.entryId}`;
            this.recordDeliveryAcceptance(
              running.entryId,
              failedPersisted
                ? { state: "failed", turnId, reason }
                : { state: "unavailable", turnId, reason: unpersistedReason },
            );
            running.resolveConfirmation(
              failedPersisted
                ? { outcome: "rejected", reason }
                : { outcome: "uncertain", reason: unpersistedReason },
            );
          } else {
            // Lost ACP reply (disconnect, crash, timeout, or host release after
            // prompt dispatch): never emit `delivery_failed`; leave the attempt
            // `unavailable` so a successor cannot blindly re-send.
            const reason = `Antigravity lost the ACP reply for delivery ${running.entryId}: ${message}`;
            this.recordDeliveryAcceptance(running.entryId, {
              state: "unavailable",
              turnId,
              reason,
            });
            running.resolveConfirmation({ outcome: "uncertain", reason });
          }
        }
        if (interrupted) {
          this.appendTranscriptRecord("abort", { turnId, reason: "user_initiated" });
        } else {
          const quota = parseAntigravityQuotaError(message, Date.now());
          if (quota) {
            this.appendTranscriptRecord("session.quota_exhausted", {
              turnId,
              code: typeof rpcCode === "number" ? String(rpcCode) : "RESOURCE_EXHAUSTED",
              message: quota.message,
              resetsAt: quota.resetsAt,
              windowMinutes: quota.windowMinutes,
              usedPercent: quota.usedPercent,
              observedAt: quota.observedAt,
            });
            this.emit({
              kind: "limits",
              snapshot: {
                engine: "antigravity",
                exhausted: true,
                windowMinutes: quota.windowMinutes,
                resetsAt: quota.resetsAt,
                observedAt: quota.observedAt,
                message: quota.message,
              },
            });
            this.recordQuotaExhaustion(quota);
            noteAntigravitySessionActivity(path.join(this.options.antigravityHome, "sessions"), this.identity.path);
          } else {
            this.appendTranscriptRecord("session.error", {
              turnId,
              code: typeof rpcCode === "number" ? String(rpcCode) : "error",
              message,
            });
          }
        }
        this.finishTurn(running, interrupted ? "interrupted" : "error");
        if (this.outstandingPrompt === running) this.outstandingPrompt = null;
        settle();
      },
    );
    if (running.confirmationResult?.outcome === "accepted") {
      return { outcome: "turn-started", turnId };
    }
    return {
      outcome: "turn-started",
      turnId,
      observeAcceptance: () => running.confirmation,
    };
  }

  async interrupt(turnRef: string): Promise<void> {
    const running = this.running;
    if (!running || running.turnId !== turnRef) return;
    if (this.unavailable()) throw new Error("Antigravity host is unavailable");
    this.cancelledTurns.add(running.turnId);
    this.notify("session/cancel", { sessionId: this.identity.sessionId });
    for (const [attentionId, open] of this.attentions) {
      this.write({ jsonrpc: "2.0", id: open.rpcId, result: { outcome: { outcome: "cancelled" } } });
      this.emit({ kind: "attention-resolved", id: attentionId, resolution: "turn-ended" });
    }
    this.attentions.clear();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = await Promise.race([
      running.settled.then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), this.interruptTimeoutMs); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    if (!stopped) {
      const failures = (this.failedInterrupts.get(running.turnId) ?? 0) + 1;
      this.failedInterrupts.set(running.turnId, failures);
      if (failures >= 3) {
        const error = new Error(`Antigravity turn did not stop after ${failures} session/cancel requests; host released`);
        this.fail(error);
        await this.release();
        throw error;
      }
      throw new Error(`Antigravity turn did not stop within ${this.interruptTimeoutMs}ms of session/cancel`);
    }
    this.failedInterrupts.delete(running.turnId);
  }

  async answer(attentionRef: string, value: unknown): Promise<void> {
    const open = this.attentions.get(attentionRef);
    if (!open) throw new Error("Antigravity attention is not open");
    const optionId = typeof value === "string"
      ? value
      : stringField(value, "optionId") ?? stringField(record(record(value)?.outcome), "optionId");
    const options = Array.isArray(open.request.options)
      ? open.request.options.map(record).filter((item): item is JsonObject => item !== null)
      : [];
    const decision = stringField(value, "decision");
    const chosen = optionId
      ?? (decision === "accept" || decision === "approve" || decision === "allow"
        ? stringField(options.find((option) => stringField(option, "kind") === "allow_once"), "optionId")
        : decision === "decline" || decision === "deny" || decision === "reject"
          ? stringField(options.find((option) => stringField(option, "kind") === "reject_once"), "optionId")
          : null);
    if (!chosen) throw new Error("Antigravity permission answer names no option");
    if (options.length > 0 && !options.some((option) => stringField(option, "optionId") === chosen)) {
      throw new Error("Antigravity permission answer names an option the request did not offer");
    }
    this.write({ jsonrpc: "2.0", id: open.rpcId, result: { outcome: { outcome: "selected", optionId: chosen } } });
    this.attentions.delete(attentionRef);
    this.emit({ kind: "attention-resolved", id: attentionRef, resolution: "answered" });
  }

  async health(): Promise<HostState> { return this.currentState(); }

  onStateChange(listener: (state: HostState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.currentState());
    return () => this.stateListeners.delete(listener);
  }

  setWriterFence(fence: () => boolean): void { this.writerFence = fence; }

  async sessionMaterializationEvidence(clientMessageId: string): Promise<SessionMaterializationEvidence> {
    const deliveryId = typeof clientMessageId === "string" ? clientMessageId.trim() : "";
    if (!deliveryId) {
      return { state: "absent", reason: "Antigravity delivery id is empty" };
    }
    const continuity = this.ensureLedgerContinuityBeforeRead();
    if (!continuity.ok) {
      return { state: "unavailable", reason: continuity.reason };
    }
    let acceptance = this.deliveryAcceptance.get(deliveryId);
    if (!acceptance && this.deliveryAcceptanceEvicted) {
      const lookedUp = await this.lookupDurableDeliveryAcceptance(deliveryId);
      acceptance = this.deliveryAcceptance.get(deliveryId) ?? lookedUp ?? undefined;
    }
    if (acceptance?.state === "accepted") return { state: "materialized" };
    if (acceptance?.state === "unavailable") return { state: "unavailable", reason: acceptance.reason };
    if (acceptance?.state === "failed") return { state: "failed", reason: acceptance.reason };
    if (this.dead || this.released) {
      if (acceptance?.state === "pending") {
        return {
          state: "unavailable",
          reason: `the Antigravity host exited before confirming delivery ${deliveryId}`,
        };
      }
      return {
        state: "failed",
        reason: `the Antigravity host is unavailable and never accepted delivery ${deliveryId}`,
      };
    }
    return {
      state: "absent",
      reason: acceptance
        ? `Antigravity ACP has not confirmed acceptance of delivery ${deliveryId} yet`
        : `Antigravity host has no acceptance fact for delivery ${deliveryId}`,
    };
  }

  async release(): Promise<void> {
    this.turnSilence.stop();
    if (this.released) return;
    if (!this.releasePromise) {
      const attempt = this.releaseAndReap();
      this.releasePromise = attempt;
      void attempt.catch(() => {
        if (this.releasePromise === attempt) this.releasePromise = null;
      });
    }
    return this.releasePromise;
  }

  async releaseIfOwned(expected: Readonly<ProcessIdentity>): Promise<boolean> {
    const pid = nativeProcessId(this.child);
    if (this.released || this.releasing || this.releasePromise !== null
      || !pid || expected.startIdentity === null
      || pid !== expected.pid
      || this.childStartIdentity !== expected.startIdentity
      || this.processIdentity(pid) !== expected.startIdentity) return false;
    this.releaseFence = expected;
    try {
      await this.release();
      return true;
    } finally {
      if (this.releaseFence === expected) this.releaseFence = null;
    }
  }

  private finishTurn(running: RunningPrompt, status: "completed" | "interrupted" | "error"): void {
    if (this.running !== running) return;
    this.running = null;
    this.cancelledTurns.delete(running.turnId);
    this.failedInterrupts.delete(running.turnId);
    if (this.dead || this.released) return;
    if (this.releasing) {
      this.emit({ kind: "turn-ended", turnId: running.turnId, status: "interrupted" });
      return;
    }
    this.emit({ kind: "turn-ended", turnId: running.turnId, status });
    for (const attentionId of this.attentions.keys()) {
      this.emit({ kind: "attention-resolved", id: attentionId, resolution: "turn-ended" });
    }
    this.attentions.clear();
    this.emit({ kind: "session-status", status: "idle" });
  }

  private unavailable(): boolean {
    if (this.dead || this.releasing || this.released) return true;
    try { return this.writerFence?.() === false; } catch { return true; }
  }

  reconcileAgentStateTerminal(
    turnRef: string,
    _nativeId: string | null,
    _at: number,
    outcome: "completed" | "interrupted" | "error" = "completed",
  ): boolean {
    const running = this.running;
    if (!running || running.turnId !== turnRef || this.writerFence?.() === false) return false;
    this.finishTurn(running, outcome);
    return this.running !== running;
  }

  agentStateMemory() {
    return {
      activeTurnRef: this.running?.turnId ?? null,
      pendingAttention: [...this.attentions.keys()],
      eventCursor: this.cursor,
      promptOrdinal: this.agentStateNativePromptAnchor === null ? null : this.confirmedPromptOrdinal,
      startedAt: this.agentStateTurnStartedAt,
    };
  }

  private currentState(): HostState {
    const pid = this.reaped || this.released ? null : nativeProcessId(this.child) ?? null;
    const status: HostState["status"] = this.dead ? "dead"
      : this.released ? "unhosted"
      : this.attentions.size ? "attention"
      : this.running ? "active"
      : "idle";
    return {
      status,
      sessionKey: this.identity.sessionId,
      endpoint: pid ? `stdio:${pid}` : "stdio:released",
      pid,
      processStartIdentity: pid ? this.processIdentity(pid) : null,
      ...(this.exitProcess ? { exitProcess: this.exitProcess } : {}),
      ...(signalDomain(this.child) ? { signalDomain: signalDomain(this.child) } : {}),
      ...(signalBoundaryOff(this.child) ? { signalBoundary: signalBoundaryOff(this.child) } : {}),
      eventCursor: this.cursor,
      protocolVersion: this.protocolVersion,
      activeTurnRef: this.running?.turnId ?? null,
      agentStateTurnStartedAt: this.agentStateTurnStartedAt,
      agentStateNativePromptAnchor: this.agentStateNativePromptAnchor,
      agentStateNativePromptOrdinal: this.agentStateNativePromptAnchor === null ? null : this.confirmedPromptOrdinal,
      agentStateAttention: { pending: [...this.attentions.keys()], unverified: false },
      pendingAttention: [...this.attentions.keys()],
      ...memoryField(this.memoryCell),
      activeFlags: [...this.launchFlags],
      account: this.tierName ? { type: "google", planType: this.tierName } : null,
    };
  }

  private restore(): void {
    const stored = this.eventStore.load(this.identity.sessionId);
    this.eventWindow.restore(stored);
    const durableTailSeq = stored.at(-1)?.seq ?? 0;
    this.cursor = reconcileRuntimeEventCursor(
      this.identity.sessionId,
      durableTailSeq,
      this.cursor,
      this.options.onEventCursorRecovery,
    );
    let restoredTurn: string | null = null;
    const restoredAttention = new Set<string>();
    const restoredAcceptance = new Map<string, { record: DeliveryAcceptanceRecord; seq: number }>();
    let maxDeliverySeq = 0;
    for (const event of stored) {
      if (event.kind === "item" && reduceDeliveryAcceptanceIntoMap(restoredAcceptance, event)) {
        maxDeliverySeq = event.seq;
      }
      if (event.kind === "turn-started") restoredTurn = event.turnId;
      if (event.kind === "turn-ended" && event.turnId === restoredTurn) restoredTurn = null;
      if (event.kind === "attention") restoredAttention.add(event.id);
      if (event.kind === "attention-resolved") restoredAttention.delete(event.id);
      if (event.kind === "session-status" && (event.status === "dead" || event.status === "unhosted")) {
        restoredTurn = null;
        restoredAttention.clear();
      }
    }
    try {
      this.closeDeliveryIndex();
      this.deliveryIndex = AntigravityDeliveryIndex.open(this.options.antigravityHome);
      if (this.deliveryIndex) {
        const ledgerFp = this.currentLedgerFingerprint();
        this.deliveryIndex.syncSession(this.identity.sessionId, durableTailSeq, restoredAcceptance, maxDeliverySeq, ledgerFp);
        if (ledgerFp) rememberLedgerAntigravityHome(ledgerFp.ledgerPath, this.options.antigravityHome);
        this.lastLedgerFingerprint = ledgerFp;
        this.deliveryIndexHealthy = true;
      } else {
        this.lastLedgerFingerprint = this.currentLedgerFingerprint();
        this.deliveryIndexHealthy = false;
      }
    } catch (error) {
      this.deliveryIndexHealthy = false;
      this.lastLedgerFingerprint = this.currentLedgerFingerprint();
      this.closeDeliveryIndex();
      console.warn("[antigravity] delivery acceptance index unavailable; falling back to ledger lookup", safeError(error));
    }
    if (restoredAcceptance.size > ANTIGRAVITY_SENT_ENTRY_MEMORY) {
      this.deliveryAcceptanceEvicted = true;
    }
    for (const [entryId, entry] of restoredAcceptance) {
      this.recordDeliveryAcceptance(entryId, entry.record, false);
      if (entry.record.state === "accepted") {
        this.recordSentEntry(entryId, entry.record.turnId || `restored:${entryId}`);
      }
    }
    if (restoredTurn) this.emit({ kind: "turn-ended", turnId: restoredTurn, status: "error" });
    for (const attentionId of restoredAttention) {
      this.emit({ kind: "attention-resolved", id: attentionId, resolution: "host-restarted" });
    }
  }

  private currentLedgerFingerprint(): LedgerFileFingerprint | null {
    const probed = this.probeLedgerFingerprint();
    return probed.ok ? probed.fingerprint : null;
  }

  private probeLedgerFingerprint(): { ok: true; fingerprint: LedgerFileFingerprint | null } | { ok: false; reason: string } {
    if (typeof this.eventStore.ledgerPath !== "function" || this.identity.sessionId === "pending") {
      return { ok: true, fingerprint: null };
    }
    const stat = statLedgerFingerprint(this.eventStore.ledgerPath(this.identity.sessionId));
    if (stat.exists) return { ok: true, fingerprint: stat.fingerprint };
    if (stat.enoent) return { ok: true, fingerprint: null };
    return {
      ok: false,
      reason: `Antigravity runtime event ledger cannot be verified: ${stat.error ?? "stat failed"}`,
    };
  }

  private clearCachedDeliveryState(): void {
    this.deliveryIndex?.clearFingerprint(this.identity.sessionId);
    this.eventStore.invalidate?.(this.identity.sessionId);
    this.deliveryAcceptance.clear();
    this.sentEntries.clear();
    this.deliveryAcceptanceEvicted = false;
    this.deliveryIndexHealthy = false;
    this.lastLedgerFingerprint = null;
    this.ledgerReconciliationPending = true;
    this.deliveryMutationSeq += 1;
  }

  private ensureLedgerContinuityBeforeRead(): { ok: true } | { ok: false; reason: string } {
    if (this.identity.sessionId === "pending" || typeof this.eventStore.ledgerPath !== "function") {
      return { ok: true };
    }
    const probed = this.probeLedgerFingerprint();
    if (!probed.ok) {
      this.clearCachedDeliveryState();
      return { ok: false, reason: probed.reason };
    }
    const currentFp = probed.fingerprint;
    if (this.ledgerReconciliationPending) {
      return this.reconcileExternallyModifiedLedger(currentFp);
    }
    if (this.lastLedgerFingerprint === null) {
      if (currentFp !== null) return this.reconcileExternallyModifiedLedger(currentFp);
      return { ok: true };
    }
    if (!sameLedgerFingerprint(this.lastLedgerFingerprint, currentFp)) {
      return this.reconcileExternallyModifiedLedger(currentFp);
    }
    return { ok: true };
  }

  private reconcileExternallyModifiedLedger(afterFp: LedgerFileFingerprint | null): { ok: true } | { ok: false; reason: string } {
    // Discard cached delivery decisions BEFORE reading disk so a transient I/O
    // failure (e.g. EIO) can never fall through to stale pre-replacement state.
    this.clearCachedDeliveryState();
    try {
      const canonical = this.eventStore.load(this.identity.sessionId);
      const rebuilt = new Map<string, { record: DeliveryAcceptanceRecord; seq: number }>();
      let maxDeliverySeq = 0;
      for (const ev of canonical) {
        if (ev.kind === "item" && reduceDeliveryAcceptanceIntoMap(rebuilt, ev)) {
          maxDeliverySeq = ev.seq;
        }
      }
      this.deliveryAcceptanceEvicted = rebuilt.size > ANTIGRAVITY_SENT_ENTRY_MEMORY;
      for (const [entryId, entry] of rebuilt) {
        this.recordDeliveryAcceptance(entryId, entry.record, false);
        if (entry.record.state === "accepted") {
          this.recordSentEntry(entryId, entry.record.turnId || `restored:${entryId}`);
        }
      }
      if (this.running && !this.running.accepted && !rebuilt.has(this.running.entryId)) {
        this.recordDeliveryAcceptance(this.running.entryId, { state: "pending", turnId: this.running.turnId }, false);
      }
      this.deliveryMutationSeq += 1;
      const tailSeq = canonical.at(-1)?.seq ?? 0;
      this.cursor = tailSeq;
      this.eventWindow.restore(canonical);
      this.eventWindowRevision += 1;
      if (this.deliveryIndex) {
        this.deliveryIndex.syncSession(this.identity.sessionId, tailSeq, rebuilt, maxDeliverySeq, afterFp);
        if (afterFp) rememberLedgerAntigravityHome(afterFp.ledgerPath, this.options.antigravityHome);
        this.deliveryIndexHealthy = true;
      } else {
        this.deliveryIndexHealthy = false;
      }
      this.lastLedgerFingerprint = afterFp;
      this.ledgerReconciliationPending = false;
      return { ok: true };
    } catch (error) {
      this.clearCachedDeliveryState();
      const reason = `Antigravity runtime event ledger reconciliation failed: ${safeError(error)}`;
      console.warn("[antigravity] externally modified ledger reconciliation failed; withholding cached delivery state", safeError(error));
      return { ok: false, reason };
    }
  }

  private emit(event: UnsequencedEvent): boolean {
    this.turnSilence?.observe(event);
    if (this.ledgerFailed || this.identity.sessionId === "pending") return false;
    const before = this.probeLedgerFingerprint();
    const needsReconcile = this.ledgerReconciliationPending
      || !before.ok
      || (this.lastLedgerFingerprint !== null && !sameLedgerFingerprint(this.lastLedgerFingerprint, before.fingerprint));
    if (needsReconcile) {
      // Reconcile cached state, sequence cursor, and SQLite delivery rows against
      // the replaced canonical file BEFORE appending, so neither sequence numbers
      // nor index rows drift from disk — and never clear pending reconciliation on I/O failure.
      if (!before.ok) {
        this.clearCachedDeliveryState();
      } else {
        this.reconcileExternallyModifiedLedger(before.fingerprint);
      }
    }
    let nextCursor: number;
    try {
      nextCursor = nextRuntimeEventSequence(this.cursor);
    } catch (error) {
      this.ledgerFailed = true;
      this.fail(new Error(safeError(error)));
      return false;
    }
    this.cursor = nextCursor;
    const sequenced = { ...event, seq: nextCursor } as RuntimeEvent;
    try {
      this.eventStore.append(this.identity.sessionId, sequenced);
    } catch (error) {
      this.cursor = this.events.at(-1)?.seq ?? Math.max(0, this.cursor - 1);
      this.ledgerFailed = true;
      this.fail(new Error(`runtime event ledger failed: ${safeError(error)}`));
      return false;
    }
    if (!this.ledgerReconciliationPending) {
      const afterFp = this.currentLedgerFingerprint();
      if (this.deliveryIndex && this.deliveryIndexHealthy) {
        try {
          this.deliveryIndex.applyEvent(this.identity.sessionId, sequenced, afterFp);
          if (afterFp) rememberLedgerAntigravityHome(afterFp.ledgerPath, this.options.antigravityHome);
          this.lastLedgerFingerprint = afterFp;
        } catch (error) {
          this.deliveryIndex.clearFingerprint(this.identity.sessionId);
          this.deliveryIndexHealthy = false;
          this.lastLedgerFingerprint = null;
          console.warn("[antigravity] delivery acceptance index update failed; falling back to ledger lookup", safeError(error));
        }
      } else {
        this.lastLedgerFingerprint = afterFp;
      }
    }
    this.eventWindowRevision += 1;
    this.eventWindow.append(sequenced);
    for (const subscriber of this.subscribers) {
      subscriber.queue.push(sequenced);
      subscriber.wake?.();
    }
    this.notifyStateListeners();
    return true;
  }

  private request(
    method: string,
    params: JsonObject,
    timeoutMs: number | null = this.requestTimeoutMs,
  ): Promise<unknown> {
    if (this.dead || this.released) return Promise.reject(new Error("Antigravity host is unavailable"));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === null ? null : setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Antigravity ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params: JsonObject): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: JsonObject): void {
    try { this.child.stdin.write(`${JSON.stringify(message)}\n`); }
    catch (error) {
      const failure = new Error(`Antigravity ACP stdin failed: ${safeError(error)}`);
      this.fail(failure);
      throw failure;
    }
  }

  private acceptStdout(chunk: string): void {
    if (this.dead || this.released) return;
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) return this.fail(new Error("Antigravity emitted an oversized ACP frame"));
      if (line.trim()) this.acceptMessage(line);
      if (this.dead) return;
      newline = this.stdoutBuffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.stdoutBuffer) > MAX_LINE_BYTES) this.fail(new Error("Antigravity emitted an oversized ACP frame"));
  }

  private acceptMessage(line: string): void {
    let message: JsonObject | null = null;
    try { message = record(JSON.parse(line)); } catch { /* stray non-JSON diagnostic */ }
    if (!message) return;
    const method = stringField(message, "method");
    const id = message.id as number | string | undefined;
    if (!method && id !== undefined) {
      const pending = typeof id === "number" ? this.pending.get(id) : undefined;
      if (!pending) return;
      this.pending.delete(id as number);
      if (pending.timer) clearTimeout(pending.timer);
      const error = record(message.error);
      if (error) {
        const failure = new Error(`Antigravity ${pending.method} failed: ${stringField(error, "message") ?? "error"}`) as Error & { rpcCode?: unknown };
        failure.rpcCode = error.code;
        pending.reject(failure);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (!method) return;
    if (method === "session/update") return this.acceptUpdate(record(message.params));
    if (method === "session/request_permission" && id !== undefined) {
      const params = record(message.params) ?? {};
      if (this.writerFence?.() === false) return;
      if (this.replaying || !this.running || params.sessionId !== this.identity.sessionId) {
        this.write({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
        return;
      }
      if (!this.confirmDeliveryAcceptance(this.running)) {
        this.write({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
        return;
      }
      const attentionId = `antigravity-permission:${String(id)}`;
      this.attentions.set(attentionId, { rpcId: id, request: params });
      const toolCall = record(params.toolCall);
      this.emit({
        kind: "attention",
        id: attentionId,
        method: "session/request_permission",
        attention: {
          ...(stringField(toolCall, "title") ? { title: stringField(toolCall, "title") } : {}),
          ...(stringField(toolCall, "kind") ? { tool: stringField(toolCall, "kind") } : {}),
          toolCall: params.toolCall ?? null,
          options: params.options ?? [],
          turnId: this.running.turnId,
        },
      });
      return;
    }
    if (id !== undefined) {
      this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not supported: ${method}` } });
    }
  }

  private acceptUpdate(params: JsonObject | null): void {
    if (this.replaying || params?.sessionId !== this.identity.sessionId || this.writerFence?.() === false) return;
    const update = record(params?.update);
    const kind = stringField(update, "sessionUpdate");
    if (!update || !kind) return;
    const running = this.running;
    const turnId = running?.turnId ?? null;
    if (kind === "config_option_update") {
      this.captureModelCatalog(update.configOptions);
      return;
    }
    if (running && (
      kind === "user_message_chunk"
      || kind === "agent_thought_chunk"
      || kind === "agent_message_chunk"
      || kind === "tool_call"
      || kind === "tool_call_update"
      || kind === "usage_update"
    )) {
      if (!this.confirmDeliveryAcceptance(running)) return;
    }
    if (kind === "agent_thought_chunk") {
      const text = stringField(record(update.content), "text");
      if (turnId && text?.trim()) {
        this.emit({ kind: "item", turnId, item: update, phase: "started" });
      }
      return;
    }
    if (kind === "agent_message_chunk") {
      const text = stringField(record(update.content), "text");
      if (text && turnId) {
        this.pendingAssistantText += text;
        this.emit({ kind: "delta", turnId, text });
      }
      return;
    }
    if (kind === "tool_call") {
      this.flushPendingAssistantText(turnId);
      const toolCallId = stringField(update, "toolCallId") ?? crypto.randomUUID();
      const toolName = stringField(update, "name") ?? stringField(update, "kind") ?? "tool";
      this.appendTranscriptRecord("tool.execution_start", {
        ...(turnId ? { turnId } : {}),
        toolCallId,
        toolName,
        kind: stringField(update, "kind"),
        title: stringField(update, "title"),
        arguments: update.args ?? update.rawInput ?? {},
      });
      this.emit({ kind: "item", turnId, item: update, phase: "started" });
      return;
    }
    if (kind === "tool_call_update") {
      const status = stringField(update, "status");
      const done = status === "completed" || status === "failed";
      if (done) {
        const rawOutput = record(update.rawOutput);
        const exitCode = typeof rawOutput?.exit_code === "number" ? rawOutput.exit_code : null;
        const isError = status === "failed" || (exitCode !== null && exitCode !== 0);
        this.appendTranscriptRecord("tool.execution_complete", {
          ...(turnId ? { turnId } : {}),
          toolCallId: stringField(update, "toolCallId") ?? "",
          toolName: stringField(update, "name") ?? stringField(update, "kind") ?? "tool",
          status: status ?? "completed",
          exitCode,
          isError,
          output: extractToolOutputText(update),
        });
      }
      this.emit({ kind: "item", turnId, item: update, phase: done ? "completed" : "started" });
    }
  }

  private async releaseAndReap(): Promise<void> {
    if (!this.dead && !this.reaped && this.identity.sessionId !== "pending") {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.request("session/close", { sessionId: this.identity.sessionId }, SESSION_CLOSE_TIMEOUT_MS).catch(() => {}),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, SESSION_CLOSE_TIMEOUT_MS); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
    }
    this.releasing = true;
    this.rejectPending(new Error("Antigravity ACP host released"));
    if (!this.startTermination() && this.releaseFence) {
      this.releasing = false;
      throw new Error("Antigravity child identity changed before signalling");
    }
    if (!await this.waitForReap(this.shutdownGraceMs * 2)) {
      if (!this.signalReleaseGroup("SIGKILL") && this.releaseFence) {
        this.releasing = false;
        throw new Error("Antigravity child identity changed before signalling");
      }
      if (!await this.waitForReap(this.shutdownGraceMs)) {
        const leaderExited = nativeProcessId(this.child) === undefined
          || (this.child.exitCode ?? null) !== null
          || (this.child.signalCode ?? null) !== null;
        if (!leaderExited) throw new Error("Antigravity child could not be reaped");
        for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
          try { stream?.destroy(); } catch { /* pipe already closed */ }
        }
        this.reaped = true;
        this.resolveReaped();
      }
    }
    this.finishRelease();
  }

  private recordQuotaExhaustion(quota: AntigravityQuotaExhaustion): void {
    try {
      const tierName = readAntigravityAuthState()?.tierName ?? null;
      const observedMs = quota.observedAt * 1000;
      const mapped = antigravityLimitsFromExhaustion(quota, { nowMs: observedMs, tierName });
      const observation: DurableQuotaObservation = {
        engine: "antigravity",
        accountId: this.options.accountId?.trim() || ANTIGRAVITY_DEFAULT_ACCOUNT_ID,
        authenticated: true,
        authCheckedAt: new Date(observedMs).toISOString(),
        limits: mapped.limits,
        provenance: { source: "transcript", reason: null, staleSince: null },
        observedAt: new Date(observedMs).toISOString(),
        bootId: "antigravity-acp-host",
        resetCredits: null,
        limitReached: true,
      };
      if (this.options.recordQuotaObservation) {
        this.options.recordQuotaObservation(observation);
      } else {
        agentRegistry().recordQuotaObservations([observation]);
      }
    } catch {
      /* Best-effort durable quota recording; transcript and limits event remain authoritative. */
    }
  }

  private finishRelease(): void {
    if (this.released) return;
    const running = this.running;
    this.running = null;
    this.outstandingPrompt = null;
    this.attentions.clear();
    if (running && !this.dead) {
      if (!running.accepted) {
        // Do NOT emit `antigravity.delivery_failed` on host release: ACP
        // already received `session/prompt` after durable `delivery_dispatched`,
        // so release without an explicit ACP rejection leaves delivery `unavailable`.
        const reason = `Antigravity host released before ACP confirmed delivery ${running.entryId}`;
        this.recordDeliveryAcceptance(running.entryId, {
          state: "unavailable",
          turnId: running.turnId,
          reason,
        });
        running.resolveConfirmation({ outcome: "uncertain", reason });
      }
      this.flushPendingAssistantText(running.turnId);
      this.appendTranscriptRecord("abort", { turnId: running.turnId, reason: "host_release" });
      this.emit({ kind: "turn-ended", turnId: running.turnId, status: "interrupted" });
    }
    if (this.transcriptFd !== null) {
      this.appendTranscriptRecord("session.shutdown", { reason: "released" });
      this.closeTranscriptFd();
    }
    this.released = true;
    this.releasing = false;
    this.emit({ kind: "session-status", status: "unhosted" });
    this.closeDeliveryIndex();
    this.closeSubscribers();
    this.memoryCell?.close();
    const cleanup = this.releaseCleanup;
    this.releaseCleanup = null;
    cleanup?.();
  }

  private async waitForReap(timeoutMs: number): Promise<boolean> {
    if (this.reaped) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.reapedPromise.then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private fail(error: Error): void {
    if (this.dead || this.released) return;
    const running = this.running;
    this.running = null;
    this.attentions.clear();
    this.rejectPending(error);
    if (running) {
      if (!running.accepted) {
        // The prompt was already dispatched after durable `delivery_dispatched`;
        // a host exit/fault without an explicit ACP JSON-RPC error cannot prove
        // the peer never started it, so leave it `unavailable` (never emit
        // `antigravity.delivery_failed`).
        const reason = this.ledgerFailed
          ? `Antigravity runtime event ledger failed while tracking delivery ${running.entryId}: ${safeError(error)}`
          : `Antigravity host exited before confirming delivery ${running.entryId}: ${safeError(error)}`;
        this.recordDeliveryAcceptance(running.entryId, {
          state: "unavailable",
          turnId: running.turnId,
          reason,
        });
        running.resolveConfirmation({ outcome: "uncertain", reason });
      }
      this.flushPendingAssistantText(running.turnId);
      this.appendTranscriptRecord("session.error", {
        turnId: running.turnId,
        code: "host_fault",
        message: safeError(error),
      });
      this.emit({ kind: "turn-ended", turnId: running.turnId, status: "error" });
    }
    this.closeTranscriptFd();
    this.dead = true;
    this.emit({ kind: "session-status", status: "dead" });
    this.notifyStateListeners();
    this.closeSubscribers();
    this.startTermination();
  }

  private signalReleaseGroup(signal: NodeJS.Signals): boolean {
    if (this.memoryCell?.fatalMemoryExit) return true;
    const expected = this.releaseFence;
    if (expected) {
      const pid = nativeProcessId(this.child);
      if (!pid || expected.startIdentity === null
        || pid !== expected.pid
        || this.childStartIdentity !== expected.startIdentity
        || this.processIdentity(pid) !== expected.startIdentity) return false;
    }
    const record = () => recordHostStop(this.exitProcess, signal, this.dead ? "antigravity-host-fault" : "antigravity-host-release");
    const protectedSignal = signalAgentDomain(this.child, signal, record);
    if (protectedSignal !== undefined) return protectedSignal;
    const withdraw = record();
    if (expected && this.processIdentity(expected.pid) !== expected.startIdentity) { withdraw?.(); return false; }
    const signalled = signalDetachedProcessGroup(this.child, signal, this.signalProcess);
    if (!signalled) withdraw?.();
    return signalled;
  }

  private startTermination(): boolean {
    if (this.memoryCell?.fatalMemoryExit) {
      if (this.terminationTimer) clearTimeout(this.terminationTimer);
      this.terminationTimer = null;
      for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) stream.destroy();
      this.reaped = true;
      this.resolveReaped();
      this.terminationStarted = true;
      return true;
    }
    if (this.terminationStarted || this.reaped) return true;
    let withdrawEof: (() => void) | undefined;
    const pid = nativeProcessId(this.child);
    if (!this.reaped && pid && this.childStartIdentity !== null && this.processIdentity(pid) === this.childStartIdentity
      && !procBackend.processExited(pid)) {
      withdrawEof = recordHostStop(this.exitProcess, "EOF", "antigravity-host-release");
    }
    try { this.child.stdin.end(); } catch { withdrawEof?.(); }
    if (!this.signalReleaseGroup("SIGTERM")) return false;
    this.terminationStarted = true;
    this.terminationTimer = setTimeout(() => {
      this.terminationTimer = null;
      if (this.reaped) return;
      this.signalReleaseGroup("SIGKILL");
    }, this.shutdownGraceMs);
    return true;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error(safeError(error)));
    }
    this.pending.clear();
  }

  private closeSubscribers(): void {
    for (const subscriber of this.subscribers) {
      subscriber.closed = true;
      subscriber.wake?.();
    }
  }

  private notifyStateListeners(): void {
    const state = this.currentState();
    for (const listener of this.stateListeners) listener(state);
  }
}
