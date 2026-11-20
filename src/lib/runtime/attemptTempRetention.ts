import { attemptTempRemaining, checkAttemptTempDeadline, sweepMonotonicNow, withAttemptTempDeadline, ATTEMPT_TEMP_REPLY_MARGIN_MS } from "./attemptTempDeadline";
import fs from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { statePath } from "@/lib/configDir";
import { declaredIndexes } from "@/lib/state/declaredIndexes";
import { withFileTransactionAsync, FileTransactionBusyError } from "@/lib/state/fileTransaction";
import { attemptTempJournalPath, sweepStaleTempDirs, resolvePhysicalPath, type ProcessScan } from "@/lib/tempSweep";
import { allocatedAttemptBytes, attemptReferencesClear, attemptProcessReferencesClear, blockedSubtrees, inspectAttemptTree, measureAttemptAllocation,
  privilegedCleanupUnavailable, snapshotAttemptProtection, closedAttemptProtection, removeAttemptTree, RepositoryLinkInventory, ledgerLinkedEvidence,
  type BlockedSubtree, type RetainedCheckoutReads, type AttemptNamespaceProtection, type AttemptProtection } from "./attemptTempFilesystem";
import { AttemptTempBudgetDeferred, attemptTempFailureDetail } from "./attemptTempDiagnostics";
import { preserveAttemptEvidence, type AttemptEvidenceSelection } from "./attemptTempEvidence";
import { recordedRootHeld, recordRootRetirement, expireRecordedRootHolds, type CheckRow } from "@/lib/recordedChecks/store";
import { trackSqliteMemory } from "@/lib/sqliteMemoryDiagnostics";
import { AttemptRetentionReporting } from "./attemptRetentionReporting";
import { FINISHED_LANE_RETENTION_MS } from "@/lib/pipelines/laneFinish";
import { claimAttemptRetirement } from "@/lib/pipelines/store";
import { hasAttemptRetirementClaim, restoreRefusedAttemptTrash } from "@/lib/pipelines/retirementClaim";
import { AttemptTrashRecovery } from "./attemptTrashRecovery";
import { attemptMutationCurrent, attemptPathWatches } from "./attemptMutationFence";
import { assertStateStartupMutation } from "@/lib/stateOwnership";
import { pipelineRecordReader } from "@/lib/pipelines/store";
import { laneFinish } from "@/lib/pipelines/laneFinish";
import { stateDatabaseBusy } from "@/lib/state/lockWait";
import { AttemptProtectionInventory, forgetAttemptProtection } from "./attemptProtectionInventory";
import { ATTEMPT_SCRATCH_EXPIRY_OFFSET_MS } from "./attemptScratchPolicy";

export type AttemptTempState = "live" | "settled" | "closed" | "expired" | "orphan" | "unknown";
export type AttemptTempAuthority = { state: AttemptTempState; expiresAt?: number | null; revision: string; isCurrent: () => boolean };
const authorityDisposition = (state: AttemptTempState): "live" | "held" => state === "live" ? "live" : "held";
function attemptEvidenceLane(pipelineId: string | null) {
  if (!pipelineId) return {};
  try {
    const reader = pipelineRecordReader(pipelineId), version = reader.version();
    const repoDir = reader.read()?.repoDir;
    return { repoDir, repoCurrent: () => reader.version() === version };
  } catch { return {}; } // Repository provenance is optional for preservation.
}

export type AttemptTempOwner = {
  directory: string;
  pipelineId: string | null;
  launchId: string;
  retainUntilClose: boolean;
  createdAt: number;
};
type Row = AttemptTempOwner & { identity: string; released: number; checkedAt: number; bytes: number };
export type EvidenceCopy = { destination: string; pipelineId: string | null; launchId: string; kind: "lane" | "agent" | "unattributed";
  createdAt: number; expiresAt: number | null; checkedAt: number; bytes: number };
export const DEFAULT_ATTEMPT_TEMP_CAP_BYTES = 100 * 1024 ** 3;
export const ATTEMPT_TEMP_LOW_SPACE_BYTES = 20 * 1024 ** 3;
export const ATTEMPT_TEMP_ROOT_BUDGET_MS = 5_000;
/** Large roots of repository copies can need longer to prove and remove.
 * Their window grows by one second per recorded GiB, up to this bound and
 * the remaining tick. */
export const ATTEMPT_TEMP_LARGE_ROOT_BUDGET_MS = 30_000;
/** A proof belongs to one visited root. Revalidate its directory stamps on
 * every use, and rebuild it after this age or after quarantine renames it. */
export const ATTEMPT_TEMP_PROTECTION_MAX_AGE_MS = 30_000;
const PRESSURE_SEARCH_ROOTS = 1024;
/** Visits that may resume one root's interrupted removal within a pass. */
const PASS_RESUMES_PER_ROOT = 8;
export function attemptTempRootWindow(bytes: number) {
  return Math.min(ATTEMPT_TEMP_LARGE_ROOT_BUDGET_MS, ATTEMPT_TEMP_ROOT_BUDGET_MS + Math.floor(Math.max(0, bytes) / 1024 ** 3) * 1000);
}
/** One pressure pass: an inventory fixed when the pass starts, ordered by
 * recorded size and age, and a durable position.
 * Order and position grant nothing; every visit repeats every proof. */
export type PressurePass = { startedAt: number; total: number; totalBytes: number; position: number; ticks: number;
  visited: number; removed: number; removedBytes: number; resumeSeq: number; resumes: number; cutSeq: number };
export type CompletedPressurePass = { startedAt: number; endedAt: number; durationMs: number; ended: "complete" | "pressure-cleared";
  total: number; ticks: number; visited: number; removed: number; removedBytes: number };
/** How long a root held past its lane's retention waits for its next visit. */
export const EXPIRED_HOLD_RETRY_MS = 30 * 60_000;
/** How long a root waits for the operator to remove what this user cannot. */
export const BLOCKED_SUBTREE_RETRY_MS = 60 * 60_000;
/** An unchanged leaf inode cannot authorize a rebound parent or evidence. */
function attemptTempPathAdmitted(directory: string): boolean {
  try {
    const physical = resolvePhysicalPath(directory), evidence = resolvePhysicalPath(statePath("evidence"));
    return physical !== evidence && !physical.startsWith(evidence + path.sep);
  } catch { return false; }
}
/** Roots whose blocked subtrees one report lists in full. */
const BLOCKED_REPORT_ROOTS = 32;
export type BlockedRoot = { directory: string; bytes: number; count: number; entries: BlockedSubtree[]; at: number };

const attemptTempIndexes = declaredIndexes([
  "CREATE INDEX IF NOT EXISTS trash_recovery_due ON trash_recovery(checkedAt,turn,directory) WHERE restored=0",
  "CREATE INDEX IF NOT EXISTS roots_launch ON roots(launchId,pipelineId,directory)",
  "CREATE INDEX IF NOT EXISTS roots_due ON roots(checkedAt,createdAt,directory)",
  "CREATE INDEX IF NOT EXISTS roots_age ON roots(createdAt,directory)",
  "CREATE INDEX IF NOT EXISTS roots_size ON roots(bytes DESC,createdAt,directory)",
  "CREATE INDEX IF NOT EXISTS copies_due ON copies(checkedAt,destination) WHERE kind<>'unattributed'",
  "CREATE INDEX IF NOT EXISTS copies_inspection ON copies(destination) WHERE kind<>'unattributed'",
  "CREATE INDEX IF NOT EXISTS copies_expiry ON copies(expiresAt,destination)",
  "CREATE INDEX IF NOT EXISTS roots_retention_expiry ON root_retention(expiresAt)",
]);

/** A separate, small ledger: selecting a tick never reads pipeline history or
 * walks all roots. The due index also prevents live roots starving old ones. */
export class AttemptTempStore {
  private db: Database;
  private releaseMemoryTracking: (() => void) | undefined;
  private recovery!: AttemptTrashRecovery;
  private reporting!: AttemptRetentionReporting;
  constructor(readonly filename = statePath("attempt-temp.sqlite")) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
    if (!sqlite) throw new Error("Attempt temp retention requires Bun");
    this.db = new sqlite.Database(filename, { create: true });
    this.releaseMemoryTracking = trackSqliteMemory(this.db);
    try {
      attemptTempIndexes.assertRepairAuthority(this.db, path.dirname(filename));
      this.db.exec("PRAGMA busy_timeout=0");
      this.db.exec("PRAGMA journal_mode=WAL");
      this.db.exec(`CREATE TABLE IF NOT EXISTS roots (
        directory TEXT PRIMARY KEY, pipelineId TEXT, launchId TEXT NOT NULL,
        retainUntilClose INTEGER NOT NULL, createdAt REAL NOT NULL,
        identity TEXT NOT NULL, released INTEGER NOT NULL DEFAULT 0,
        checkedAt REAL NOT NULL DEFAULT 0, bytes REAL NOT NULL DEFAULT 0)`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS copies (
        destination TEXT PRIMARY KEY, pipelineId TEXT, launchId TEXT NOT NULL, kind TEXT NOT NULL,
        createdAt REAL NOT NULL, expiresAt REAL, checkedAt REAL NOT NULL DEFAULT 0, bytes REAL NOT NULL DEFAULT 0)`);
      this.db.exec("CREATE TABLE IF NOT EXISTS root_retention(directory TEXT PRIMARY KEY, expiresAt REAL, failure TEXT)");
      if (!this.db.query("SELECT 1 FROM sqlite_master WHERE name='retention_cursor' AND type='table'").get()) {
        assertStateStartupMutation(path.dirname(filename), "attempt temp retention backfill cursor");
        this.db.exec("CREATE TABLE retention_cursor(id INTEGER PRIMARY KEY CHECK(id=1), directory TEXT NOT NULL)");
      }
      this.db.exec("CREATE TABLE IF NOT EXISTS root_expiry_admission(directory TEXT PRIMARY KEY, expiresAt REAL NOT NULL)");
      this.db.exec("CREATE TABLE IF NOT EXISTS root_blocked(directory TEXT PRIMARY KEY, count INTEGER NOT NULL, entries TEXT NOT NULL, at REAL NOT NULL)");
      this.db.exec("CREATE TABLE IF NOT EXISTS copy_retention_failures(destination TEXT PRIMARY KEY, failure TEXT NOT NULL)");
      this.db.exec("CREATE TABLE IF NOT EXISTS copy_adoption(id INTEGER PRIMARY KEY CHECK(id=1), cursor TEXT NOT NULL, done INTEGER NOT NULL)");
      this.db.exec("CREATE TABLE IF NOT EXISTS copy_inspection(id INTEGER PRIMARY KEY CHECK(id=1), cursor TEXT NOT NULL)");
      this.recovery = new AttemptTrashRecovery(this.db, path.join(path.dirname(filename), "scratch"));
      attemptTempIndexes.install(this.db, path.dirname(filename));
      this.db.exec("CREATE TABLE IF NOT EXISTS totals (id INTEGER PRIMARY KEY CHECK(id=1), bytes REAL NOT NULL)");
      this.db.exec("INSERT OR IGNORE INTO totals VALUES (1,0)");
      this.db.exec("CREATE TRIGGER IF NOT EXISTS roots_bytes_update AFTER UPDATE OF bytes ON roots BEGIN UPDATE totals SET bytes=bytes+NEW.bytes-OLD.bytes WHERE id=1; END");
      this.db.exec("CREATE TRIGGER IF NOT EXISTS roots_bytes_delete AFTER DELETE ON roots BEGIN UPDATE totals SET bytes=bytes-OLD.bytes WHERE id=1; END");
      this.db.exec("CREATE TABLE IF NOT EXISTS adoption (id INTEGER PRIMARY KEY CHECK(id=1), cursor TEXT NOT NULL)");
      if (!this.db.query("SELECT 1 FROM sqlite_master WHERE name='pressure_pass_last' AND type='table'").get()) {
        assertStateStartupMutation(path.dirname(filename), "attempt temp pressure pass");
        this.db.transaction(() => {
          this.db.exec(`CREATE TABLE IF NOT EXISTS pressure_pass(id INTEGER PRIMARY KEY CHECK(id=1), startedAt REAL NOT NULL,
            total INTEGER NOT NULL, totalBytes REAL NOT NULL, position INTEGER NOT NULL, ticks INTEGER NOT NULL, visited INTEGER NOT NULL,
            removed INTEGER NOT NULL, removedBytes REAL NOT NULL, resumeSeq INTEGER NOT NULL, resumes INTEGER NOT NULL, cutSeq INTEGER NOT NULL)`);
          this.db.exec("CREATE TABLE IF NOT EXISTS pressure_pass_roots(seq INTEGER PRIMARY KEY, directory TEXT NOT NULL, identity TEXT NOT NULL)");
          this.db.exec(`CREATE TABLE pressure_pass_last(id INTEGER PRIMARY KEY CHECK(id=1), startedAt REAL NOT NULL, endedAt REAL NOT NULL,
            ended TEXT NOT NULL, total INTEGER NOT NULL, ticks INTEGER NOT NULL, visited INTEGER NOT NULL, removed INTEGER NOT NULL, removedBytes REAL NOT NULL)`);
          this.db.exec("CREATE TABLE pressure_pass_complete AS SELECT * FROM pressure_pass_last WHERE 0");
        })();
      }
      this.reporting = new AttemptRetentionReporting(this.db, path.dirname(filename));
      // Fresh ledgers already use the new writer policy. Existing ledgers are
      // upgraded once by the ordinary owner before selecting its next page.
      if (!this.db.query("SELECT 1 FROM roots LIMIT 1").get() && this.scratchRetentionVersion() === 0)
        this.db.exec("PRAGMA user_version=1");
      fs.chmodSync(filename, 0o600);
    } catch (error) { this.db.close(); this.releaseMemoryTracking(); this.releaseMemoryTracking = undefined; throw error; }
  }
  register(owner: AttemptTempOwner) {
    const evidence = statePath("evidence");
    if ([path.resolve(owner.directory), fs.realpathSync(owner.directory)].some(directory => directory === evidence || directory.startsWith(evidence + path.sep)))
      throw new Error("Evidence is never attempt temp");
    const stat = fs.lstatSync(owner.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !/^llv-(?:read-only-stage|stage|stage-config)-/.test(path.basename(owner.directory)))
      throw new Error("Attempt temp root is not an owned directory");
    this.db.query("INSERT INTO roots(directory,pipelineId,launchId,retainUntilClose,createdAt,identity,checkedAt) VALUES(?,?,?,?,?,?,?)")
      .run(path.resolve(owner.directory), owner.pipelineId, owner.launchId, Number(owner.retainUntilClose), owner.createdAt, `${stat.dev}:${stat.ino}`, owner.createdAt);
    fs.writeFileSync(path.join(owner.directory, ".delegatus-attempt-owner"), "attempt-temp.sqlite\n", { mode: 0o600, flag: "wx" });
  }
  /** Only the private scratch container created by the access builder is a
   * legacy creation record. Shared OS temp roots are never candidates. */
  adopt(now: number, scratch = path.join(path.dirname(this.filename), "scratch"), limit = 32): { adopted: number; errors: number } {
    let parent: fs.Stats | undefined;
    let names: string[];
    try { parent = fs.lstatSync(scratch, { throwIfNoEntry: false }); names = parent ? fs.readdirSync(scratch).sort() : []; }
    catch { return { adopted: 0, errors: 1 }; }
    if (!parent?.isDirectory() || parent.isSymbolicLink() || fs.realpathSync(scratch) !== path.resolve(scratch)) return { adopted: 0, errors: 0 };
    const cursor = this.db.query<{ cursor: string }, []>("SELECT cursor FROM adoption WHERE id=1").get()?.cursor ?? "";
    const selected = names.filter(name => name > cursor).slice(0, limit);
    let adopted = 0, errors = 0;
    for (const name of selected) {
      // Checkpoint even a refused name so it cannot starve the next root.
      this.db.query("INSERT OR REPLACE INTO adoption VALUES(1,?)").run(name);
      try {
        if (!/^llv-(?:read-only-stage|stage)-[A-Za-z0-9]{6}$/.test(name)) continue;
        const directory = path.join(scratch, name);
        if (this.has(directory)) continue;
        const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
        if (!stat?.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
          || (process.getuid && stat.uid !== process.getuid())) continue;
        const marker = path.join(directory, ".delegatus-attempt-owner");
        const prior = fs.lstatSync(marker, { throwIfNoEntry: false });
        if (prior && (!prior.isFile() || prior.nlink !== 1 || prior.size !== 20
          || fs.readFileSync(marker, "utf8") !== "attempt-temp.sqlite\n")) continue;
        if (!prior) fs.writeFileSync(marker, "attempt-temp.sqlite\n", { mode: 0o600, flag: "wx" });
        this.db.query("INSERT OR IGNORE INTO roots(directory,pipelineId,launchId,retainUntilClose,createdAt,identity,checkedAt) VALUES(?,NULL,'adopted',0,?,?,?)")
          .run(directory, now, `${stat.dev}:${stat.ino}`, now);
        adopted++;
      } catch { errors++; }
    }
    if (selected.length < limit) this.db.query("INSERT OR REPLACE INTO adoption VALUES(1,'')").run();
    return { adopted, errors };
  }
  recoverTrash(now: () => number, deadline: number, budgetNow: () => number) { return this.recovery.page(now, deadline, budgetNow); }
  refreshTrashRecovery(directory: string) { this.recovery.refresh(directory); }
  trashRecoveryWatches(directory: string) { return this.recovery.watches(directory); }
  recoveredTrashCurrent(directory: string) { return this.recovery.current(directory); }
  recoveredTrash(directory: string) { return this.recovery.restored(directory); }
  has(directory: string) { return !!this.db.query("SELECT 1 FROM roots WHERE directory=?").get(directory); }
  owner(directory: string): Row | null { return this.db.query<Row, [string]>("SELECT * FROM roots WHERE directory=?").get(directory); }
  release(directory: string) {
    this.upgradeScratchRetention();
    this.db.query("UPDATE roots SET released=1,checkedAt=0 WHERE directory=?").run(directory);
    const owner = this.owner(directory);
    if (owner?.pipelineId) {
      const pipeline = pipelineRecordReader(owner.pipelineId).read();
      const finish = pipeline && laneFinish(pipeline, ATTEMPT_SCRATCH_EXPIRY_OFFSET_MS);
      if (finish && finish.finished) this.retainRoot(directory, finish.expiresAt);
      else this.retainRoot(directory, null);
    }
  }
  scratchRetentionVersion() { return this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version; }
  /** Convert only legacy scratch scheduling projections. Every deletion still
   * reads authoritative completion again; evidence copies and required expiry
   * admissions retain their existing lifetimes. The transaction is replay-safe. */
  upgradeScratchRetention() {
    const version = this.scratchRetentionVersion();
    if (version === 1) return;
    if (version !== 0) throw new Error("unsupported scratch retention policy version");
    this.db.transaction(() => {
      const current = this.scratchRetentionVersion();
      if (current === 1) return;
      if (current !== 0) throw new Error("unsupported scratch retention policy version");
      this.db.query("UPDATE root_retention SET expiresAt=expiresAt-?+? WHERE expiresAt IS NOT NULL")
        .run(FINISHED_LANE_RETENTION_MS, ATTEMPT_SCRATCH_EXPIRY_OFFSET_MS);
      this.db.exec("UPDATE roots SET checkedAt=0; DELETE FROM retention_cursor; PRAGMA user_version=1");
    })();
  }
  /** Indexed, durable rotation independent of expensive filesystem visits.
   * Revisit open lanes too: a later close must supply their missing clock. */
  retentionPage(limit = 128): Row[] {
    const cursor = this.db.query<{ directory: string }, []>("SELECT directory FROM retention_cursor WHERE id=1").get()?.directory ?? "";
    const rows = this.db.query<Row, [string, number]>("SELECT * FROM roots WHERE directory>? ORDER BY directory LIMIT ?").all(cursor, limit);
    if (!rows.length) this.checkpointRetention("");
    return rows;
  }
  checkpointRetention(directory: string) {
    this.db.query("INSERT OR REPLACE INTO retention_cursor VALUES(1,?)").run(directory);
  }
  /** Take the inventory once, largest then oldest by ledger measurements.
   * A finished lane without backfilled expiry still has its place in size
   * order. Ownership is checked when the cursor reaches each root. */
  pressurePass(now: number): PressurePass {
    const current = this.db.query<PressurePass, []>("SELECT * FROM pressure_pass WHERE id=1").get();
    if (current) return current;
    this.db.transaction(() => {
      this.db.exec("DELETE FROM pressure_pass_roots");
      this.db.exec(`INSERT INTO pressure_pass_roots(directory,identity) SELECT directory,identity FROM roots
        ORDER BY bytes DESC, createdAt, directory`);
      const totals = this.db.query<{ total: number; bytes: number | null }, []>("SELECT count(*) AS total, sum(bytes) AS bytes FROM roots").get()!;
      this.db.query("INSERT INTO pressure_pass VALUES(1,?,?,?,0,0,0,0,0,0,0,0)").run(now, totals.total, totals.bytes ?? 0);
    })();
    return this.db.query<PressurePass, []>("SELECT * FROM pressure_pass WHERE id=1").get()!;
  }
  /** The next root of the pass after `position`, with its inventory sequence. */
  pressurePassRoot(position: number): { seq: number; directory: string; identity: string } | null {
    return this.db.query<{ seq: number; directory: string; identity: string }, [number]>("SELECT seq,directory,identity FROM pressure_pass_roots WHERE seq>? ORDER BY seq LIMIT 1").get(position);
  }
  savePressurePass(pass: PressurePass) {
    this.db.query(`UPDATE pressure_pass SET position=?,ticks=?,visited=?,removed=?,removedBytes=?,resumeSeq=?,resumes=?,cutSeq=? WHERE id=1`)
      .run(pass.position, pass.ticks, pass.visited, pass.removed, pass.removedBytes, pass.resumeSeq, pass.resumes, pass.cutSeq);
  }
  /** Ends the pass, recording it as the last one. A pass that ended because
   * pressure cleared is recorded as such and never as a full pass. */
  endPressurePass(now: number, ended: CompletedPressurePass["ended"]) {
    this.db.transaction(() => {
      const pass = this.db.query<PressurePass, []>("SELECT * FROM pressure_pass WHERE id=1").get();
      if (pass) this.db.query("INSERT OR REPLACE INTO pressure_pass_last VALUES(1,?,?,?,?,?,?,?,?)")
        .run(pass.startedAt, now, ended, pass.total, pass.ticks, pass.visited, pass.removed, pass.removedBytes);
      if (pass && ended === "complete") {
        this.db.exec("DELETE FROM pressure_pass_complete");
        this.db.exec("INSERT INTO pressure_pass_complete SELECT * FROM pressure_pass_last");
      }
      this.db.exec("DELETE FROM pressure_pass");
      this.db.exec("DELETE FROM pressure_pass_roots");
    })();
  }
  activePressurePass(): PressurePass | null { return this.db.query<PressurePass, []>("SELECT * FROM pressure_pass WHERE id=1").get(); }
  lastPressurePass(): CompletedPressurePass | null {
    const row = this.db.query<Omit<CompletedPressurePass, "durationMs">, []>("SELECT startedAt,endedAt,ended,total,ticks,visited,removed,removedBytes FROM pressure_pass_last WHERE id=1").get();
    return row ? { ...row, durationMs: Math.max(0, row.endedAt - row.startedAt) } : null;
  }
  lastFullPressurePass(): CompletedPressurePass | null {
    const row = this.db.query<Omit<CompletedPressurePass, "durationMs">, []>("SELECT startedAt,endedAt,ended,total,ticks,visited,removed,removedBytes FROM pressure_pass_complete WHERE id=1").get();
    return row ? { ...row, durationMs: Math.max(0, row.endedAt - row.startedAt) } : null;
  }
  due(now: number, limit: number): Row[] {
    // A root whose lane retention ended has the first claim on every page,
    // across the whole ledger and largest allocation first. Up to half of the
    // page, so a run of held expired roots cannot starve the other visits; a
    // held one is moved back by `EXPIRED_HOLD_RETRY_MS` after its visit.
    const expired = this.db.query<Row, [number, number, number]>(`SELECT r.* FROM root_retention t JOIN roots r ON r.directory=t.directory
      WHERE t.expiresAt IS NOT NULL AND t.expiresAt<=? AND r.checkedAt<=? ORDER BY r.bytes DESC,t.expiresAt,r.createdAt,r.directory LIMIT ?`)
      .all(now, now, Math.ceil(limit / 2));
    const selected = new Set(expired.map(row => row.directory));
    const rest = (query: string, count: number) => count <= 0 ? [] : this.db.query<Row, [number, number]>(query)
      .all(now, count + selected.size).filter(row => !selected.has(row.directory)).slice(0, count);
    return [...expired, ...rest("SELECT * FROM roots WHERE checkedAt<=? ORDER BY bytes DESC,checkedAt,createdAt,directory LIMIT ?", limit - expired.length)]
      .sort((a, b) => b.bytes - a.bytes);
  }
  /** Subtrees of a root that this user cannot remove, as last observed. */
  recordBlocked(directory: string, blocked: { count: number; entries: BlockedSubtree[] } | null, at: number) {
    if (!blocked?.count) this.db.query("DELETE FROM root_blocked WHERE directory=?").run(directory);
    else this.db.query("INSERT OR REPLACE INTO root_blocked VALUES(?,?,?,?)").run(directory, blocked.count, JSON.stringify(blocked.entries), at);
  }
  /** Every root held for the operator, the largest first, with its subtrees. */
  blockedRoots(limit = BLOCKED_REPORT_ROOTS): { roots: number; bytes: number; listed: BlockedRoot[] } {
    const totals = this.db.query<{ roots: number; bytes: number | null }, []>(`SELECT count(*) AS roots, sum(r.bytes) AS bytes
      FROM root_blocked b JOIN roots r ON r.directory=b.directory`).get()!;
    const listed = this.db.query<{ directory: string; bytes: number; count: number; entries: string; at: number }, [number]>(`SELECT b.directory,r.bytes,b.count,b.entries,b.at
      FROM root_blocked b JOIN roots r ON r.directory=b.directory ORDER BY r.bytes DESC,b.directory LIMIT ?`).all(limit)
      .map(row => ({ ...row, entries: JSON.parse(row.entries) as BlockedSubtree[] }));
    return { roots: totals.roots, bytes: totals.bytes ?? 0, listed };
  }
  /** The recorded end of the root's lane retention, or null when none is known. */
  retentionExpiry(directory: string): number | null {
    return this.db.query<{ expiresAt: number | null }, [string]>("SELECT expiresAt FROM root_retention WHERE directory=?").get(directory)?.expiresAt ?? null;
  }
  defer(directory: string, until: number) { this.db.query("UPDATE roots SET checkedAt=? WHERE directory=?").run(until, directory); }
  forget(directory: string) {
    forgetAttemptProtection(directory);
    this.db.transaction(() => {
      this.db.query("DELETE FROM root_retention WHERE directory=?").run(directory);
      this.db.query("DELETE FROM root_expiry_admission WHERE directory=?").run(directory);
      this.db.query("DELETE FROM root_blocked WHERE directory=?").run(directory);
      this.db.query("DELETE FROM roots WHERE directory=?").run(directory);
      this.recovery.forget(directory);
    })();
  }
  retainRoot(directory: string, expiresAt: number | null) {
    this.db.query("INSERT INTO root_retention(directory,expiresAt) VALUES(?,?) ON CONFLICT(directory) DO UPDATE SET expiresAt=excluded.expiresAt").run(directory, expiresAt);
  }
  /** A preservation hold changes the forecast, never the owner's finish
   * clock. Eligibility is only a projection; removal always repeats proofs. */
  rootEligible(directory: string, eligible: boolean) {
    this.db.query("UPDATE retention_sources SET eligible=? WHERE source='root' AND entry=? AND eligible<>?")
      .run(Number(eligible), directory, Number(eligible));
  }
  /** Records when a finished lane's retention ends as soon as an authority
   * read knows it, whatever holds the root afterwards, so once that time
   * passes every page finds the root first. Preservation holds independently
   * suppress its forecast without erasing the owner's clock. */
  noteRetentionEnd(directory: string, authority: Pick<AttemptTempAuthority, "state" | "expiresAt">) {
    if ((authority.state !== "closed" && authority.state !== "expired") || authority.expiresAt == null || !this.has(directory)) return;
    if (this.retentionExpiry(directory) !== authority.expiresAt) this.retainRoot(directory, authority.expiresAt);
  }
  requireRootExpiry(directory: string, expiresAt: number) {
    this.db.query(`INSERT INTO root_expiry_admission VALUES(?,?) ON CONFLICT(directory)
      DO UPDATE SET expiresAt=max(expiresAt,excluded.expiresAt)`).run(directory, expiresAt);
  }
  requiredRootExpiry(directory: string): number | null {
    return this.db.query<{ expiresAt: number }, [string]>("SELECT expiresAt FROM root_expiry_admission WHERE directory=?").get(directory)?.expiresAt ?? null;
  }
  requireRecordedRootExpiry(row: CheckRow, expiresAt: number | null): () => boolean {
    const rootsCurrent = () => row.descriptor.manifest.roots.every(root => {
      const owner = this.owner(root.directory);
      return owner?.identity === root.identity && owner.pipelineId === row.binding.pipeline && owner.launchId === row.binding.launch;
    });
    this.db.transaction(() => {
      if (!rootsCurrent()) throw new Error("recorded root creation binding mismatch");
      if (expiresAt !== null) for (const root of row.descriptor.manifest.roots) this.requireRootExpiry(root.directory, expiresAt);
    })();
    return () => rootsCurrent() && (expiresAt === null || row.descriptor.manifest.roots.every(root =>
      (this.requiredRootExpiry(root.directory) ?? -Infinity) >= expiresAt));
  }
  rootFailure(directory: string, failure: string | null) {
    const prior = this.db.query<{ failure: string | null }, [string]>("SELECT failure FROM root_retention WHERE directory=?").get(directory)?.failure;
    this.db.query("INSERT INTO root_retention(directory,failure) VALUES(?,?) ON CONFLICT(directory) DO UPDATE SET failure=excluded.failure").run(directory, failure);
    return failure !== null && prior !== failure;
  }
  copy(destination: string): EvidenceCopy | null { return this.db.query<EvidenceCopy, [string]>("SELECT * FROM copies WHERE destination=?").get(destination); }
  registerCopy(row: EvidenceCopy) {
    this.db.query(`INSERT INTO copies VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(destination) DO UPDATE SET
      expiresAt=excluded.expiresAt,checkedAt=excluded.checkedAt,bytes=excluded.bytes`)
      .run(row.destination, row.pipelineId, row.launchId, row.kind, row.createdAt, row.expiresAt, row.checkedAt, row.bytes);
  }
  dueCopies(now: number, limit: number): EvidenceCopy[] {
    return this.db.query<EvidenceCopy, [number, number]>("SELECT * FROM copies WHERE checkedAt<=? AND kind<>'unattributed' ORDER BY checkedAt,destination LIMIT ?").all(now, limit);
  }
  copiesToInspect(limit: number): EvidenceCopy[] {
    const cursor = this.db.query<{ cursor: string }, []>("SELECT cursor FROM copy_inspection WHERE id=1").get()?.cursor ?? "";
    const page = (after: string) => this.db.query<EvidenceCopy, [string, number]>(
      "SELECT * FROM copies WHERE destination>? AND kind<>'unattributed' ORDER BY destination LIMIT ?").all(after, limit);
    const rows = page(cursor);
    return rows.length || !cursor ? rows : page("");
  }
  checkpointCopyInspection(destination: string) {
    this.db.query("INSERT OR REPLACE INTO copy_inspection VALUES(1,?)").run(destination);
  }
  forgetCopy(destination: string) {
    this.db.transaction(() => {
      this.db.query("DELETE FROM copies WHERE destination=?").run(destination);
      this.db.query("DELETE FROM copy_eligibility WHERE destination=?").run(destination);
      this.db.query("DELETE FROM copy_retention_failures WHERE destination=?").run(destination);
    })();
  }
  copyFailure(destination: string, failure: string | null) {
    const prior = this.db.query<{ failure: string }, [string]>("SELECT failure FROM copy_retention_failures WHERE destination=?").get(destination)?.failure;
    if (failure === null) this.db.query("DELETE FROM copy_retention_failures WHERE destination=?").run(destination);
    else this.db.query("INSERT OR REPLACE INTO copy_retention_failures VALUES(?,?)").run(destination, failure);
    return failure !== null && prior !== failure;
  }
  copyCursor() { return this.db.query<{ cursor: string; done: number }, []>("SELECT * FROM copy_adoption WHERE id=1").get() ?? { cursor: "", done: 0 }; }
  checkpointCopies(cursor: string, done = false) { this.db.query("INSERT OR REPLACE INTO copy_adoption VALUES(1,?,?)").run(cursor, Number(done)); }
  refreshReporting(now: () => number = Date.now, deadline = now() + 10000) { this.reporting.backfill(now, deadline); }
  retention(now: number, retentionMs = FINISHED_LANE_RETENTION_MS) {
    return this.reporting.retention(now, retentionMs);
  }
  unattributedCopies() { return this.reporting.unattributed(); }
  copyEligible(destination: string, eligible: boolean) {
    this.db.query("INSERT INTO copy_eligibility VALUES(?,?) ON CONFLICT(destination) DO UPDATE SET eligible=excluded.eligible").run(destination, Number(eligible));
  }
  measure(directory: string, bytes: number) { this.db.query("UPDATE roots SET bytes=? WHERE directory=?").run(bytes, directory); }
  bytes() { return this.db.query<{ bytes: number }, []>("SELECT bytes FROM totals WHERE id=1").get()!.bytes; }
  close() { this.db.close(); this.releaseMemoryTracking?.(); this.releaseMemoryTracking = undefined; }
}

export type AttemptTempSweepOptions = {
  now?: () => number;
  state: (owner: AttemptTempOwner, inventory: RepositoryLinkInventory) => Promise<AttemptTempState>;
  authority?: (owner: AttemptTempOwner, inventory: RepositoryLinkInventory) => Promise<AttemptTempAuthority>;
  evidenceAuthority?: (owner: AttemptTempOwner, inventory: RepositoryLinkInventory) => Promise<AttemptTempAuthority>;
  /** Production scratch requires a confirmed completion older than 24h,
   * including under pressure. Creation age grants no deletion authority. */
  requireExpired?: true;
  scan: (directories: readonly string[]) => ProcessScan;
  references?: (original: string, current: string, scan: ProcessScan) => Promise<boolean>;
  maxRoots?: number;
  maxAgeMs?: number;
  runBudgetMs?: number;
  /** Monotonic clock for tick-budget accounting when `now` is calendar time. */
  budgetNow?: () => number;
  capBytes?: number;
  retentionMs?: number;
  remove?: (directory: string, guard: () => Promise<boolean>, dispatch: () => boolean, mutationStarted: () => void) => Promise<void>;
  mode?: "on" | "dry-run";
  onRetired?: (count: number, bytes: number) => void;
  /** Checkout reads kept by a caller that lives across ticks. Passing it also
   * lets one reference observation reuse a validation of the last seconds. */
  checkoutReads?: RetainedCheckoutReads;
  availableBytes?: (scratch: string) => number;
  /** An independently verified operator manifest. This path performs no
   * discovery, global recovery, evidence copying or pressure-cursor writes. */
  selection?: { directories: readonly string[]; current: (owner: AttemptTempOwner & { identity: string; released: number }) => boolean;
    watches: string[] };
};
export async function sweepAttemptTemps(store: AttemptTempStore, options: AttemptTempSweepOptions) {
  // Serving generations may overlap. One process-shared owner must retain the
  // journal through every await; the existing async lock recovers dead owners.
  return withFileTransactionAsync(store.filename + ".sweep", "attempt-temp sweep admission", () => sweepOwnedAttemptTemps(store, options),
    { waitMs: attemptTempRemaining(options.runBudgetMs ?? 40_000) });
}

async function sweepOwnedAttemptTemps(store: AttemptTempStore, options: AttemptTempSweepOptions) {
  if (options.requireExpired) {
    if (options.selection && store.scratchRetentionVersion() !== 1) throw new Error("ordinary attempt-temp owner must upgrade scratch retention before exact-list execution");
    if (!options.selection) store.upgradeScratchRetention();
  }
  const now = options.now ?? Date.now;
  const retentionMs = options.retentionMs ?? FINISHED_LANE_RETENTION_MS;
  const observeOwner = async (owner: AttemptTempOwner): Promise<AttemptTempAuthority> => options.authority
    ? options.authority(owner, inventory) : { state: await options.state(owner, inventory), revision: "", isCurrent: () => true };
  const budgetNow = options.budgetNow ?? options.now ?? sweepMonotonicNow;
  const deadline = budgetNow() + attemptTempRemaining(options.runBudgetMs ?? 40_000);
  const remaining = () => attemptTempRemaining(deadline - budgetNow());
  const checkBudget = () => { checkAttemptTempDeadline(); if (remaining() <= 0) throw new AttemptTempBudgetDeferred("run budget exhausted"); };
  // A continuation already owns its fixed inventory. Discover legacy roots
  // once at the next pass boundary, rather than sorting scratch every tick.
  const adoption = options.selection || store.activePressurePass() ? { adopted: 0, errors: 0 } : store.adopt(now());
  const configuredCapBytes = options.capBytes ?? DEFAULT_ATTEMPT_TEMP_CAP_BYTES;
  const scratch = path.join(path.dirname(store.filename), "scratch");
  let freeBytes: number | null = null, spaceError: string | null = null;
  try {
    freeBytes = options.availableBytes ? options.availableBytes(scratch) : (() => {
      const stat = fs.statfsSync(fs.existsSync(scratch) ? scratch : path.dirname(store.filename));
      return stat.bavail * stat.bsize;
    })();
    if (!Number.isFinite(freeBytes) || freeBytes < 0) throw new Error("invalid scratch free-space observation");
  } catch (error) { freeBytes = null; spaceError = attemptTempFailureDetail(error); }
  const lowSpace = freeBytes !== null && freeBytes < ATTEMPT_TEMP_LOW_SPACE_BYTES;
  // Keep at least as much free space as scratch occupies, plus the absolute
  // working reserve on small filesystems. A fixed cap alone reacts too late.
  const capBytes = freeBytes === null ? configuredCapBytes : Math.min(configuredCapBytes,
    Math.max(0, Math.floor(Math.min((store.bytes() + freeBytes) / 2, store.bytes() + freeBytes - ATTEMPT_TEMP_LOW_SPACE_BYTES))));
  const pressure = !!options.selection || lowSpace || store.bytes() > capBytes;
  type Outcome = { directory: string; disposition: "deferred" | "live" | "evidence" | "held" | "operator" | "failed" | "removed"; bytes: number; reason: string;
    /** Part of the tree could not be read; `bytes` counts the rest. */
    unreadable?: true; allocation?: "recorded" };
  const report = { adopted: adoption.adopted, checked: 0, removed: 0, removedBytes: 0,
    deferred: 0, deferredBytes: 0, held: 0, liveHeld: 0, liveHeldBytes: 0,
    evidenceHeld: 0, evidenceHeldBytes: 0, operatorHeld: 0, operatorHeldBytes: 0, otherHeldBytes: 0,
    errors: adoption.errors, failedBytes: 0, unexaminedBytes: 0,
    evidenceSelections: {} as Record<string, AttemptEvidenceSelection>,
    bytes: store.bytes(), capBytes, configuredCapBytes, overCapBytes: 0, inventoryWalks: 0, outcomes: [] as Outcome[],
    pressure, lowSpace, freeBytes, lowSpaceThresholdBytes: ATTEMPT_TEMP_LOW_SPACE_BYTES, spaceError,
    rootBudgetMs: pressure ? ATTEMPT_TEMP_ROOT_BUDGET_MS : null,
    /** Every root the ledger holds for the operator, not only this page's. */
    blocked: { roots: 0, bytes: 0, listed: [] as BlockedRoot[] } };
  const partiallyRead = new Set<string>();
  const recordedAllocation = new Set<string>();
  const outcome = (directory: string, disposition: Outcome["disposition"], bytes: number, reason: string) => {
    report.outcomes.push({ directory, disposition, bytes, reason, ...(partiallyRead.has(directory) ? { unreadable: true as const } : {}),
      ...(recordedAllocation.has(directory) ? { allocation: "recorded" as const } : {}) });
    if (disposition === "deferred") { report.deferred++; report.deferredBytes += bytes; }
    else if (disposition === "failed") { report.failedBytes += bytes; }
    else if (disposition !== "removed") {
      report.held++;
      if (disposition === "live") { report.liveHeld++; report.liveHeldBytes += bytes; }
      else if (disposition === "evidence") { report.evidenceHeld++; report.evidenceHeldBytes += bytes; }
      else if (disposition === "operator") { report.operatorHeld++; report.operatorHeldBytes += bytes; }
      else report.otherHeldBytes += bytes;
    }
  };
  // An ordinary page; under pressure `maxRoots` limits the visits of one tick.
  const budget = Math.max(1, Math.min(32, options.maxRoots ?? 4));
  // A caller that lives across ticks keeps completed checkout reads, and its
  // repeated validations inside one reference observation reuse a result of
  // the last few seconds. Each destructive step below still waits for
  // `unchangedAll`, which reads every inventoried directory again.
  const inventory = new RepositoryLinkInventory({ now, budgetMs: Math.min(30_000, remaining()),
    retained: options.checkoutReads, validationReuseMs: options.checkoutReads ? 5_000 : 0 });
  const references = options.references
    ?? ((original: string, current: string, scan: ProcessScan) => attemptReferencesClear(original, current, scan, undefined, inventory));
  const recovery = options.selection ? { entries: 0, manifestEntries: 0, checks: 0, restored: 0, outcomes: [] }
    : store.recoverTrash(now, deadline, budgetNow);
  for (const row of recovery.outcomes) outcome(row.directory, row.disposition, row.bytes, row.reason);
  const visit = async (owner: Row) => {
    report.checked++;
    let bytes = owner.bytes;
    let disposition: "live" | "evidence" | "held" | "operator" = "held";
    let reason = "identity changed";
    // Persist fairness before the first await; a killed helper resumes elsewhere.
    const retirement: { release?: () => void } = {};
    let recoveredTrash = false;
    let currentDirectory = owner.directory;
    let requiredExpiry: number | null = null;
    const finished = (state: AttemptTempState) => owner.pipelineId !== null && (state === "closed" || state === "expired");
    const disposableClosed = (state: AttemptTempState) => pressure && finished(state);
    const noteFailure = (detail: string | null) => {
      try { return store.rootFailure(owner.directory, detail); }
      catch (error) {
        if (!stateDatabaseBusy(error)) throw error;
        console.error("[attempt temp] root note deferred: database is locked"); return false;
      }
    };
    const expiryCurrent = (state: AttemptTempState | undefined) => requiredExpiry === null
      || state === "expired" && now() >= requiredExpiry;
    const claim = async () => {
      if (!retirement.release && owner.pipelineId && options.mode !== "dry-run")
        retirement.release = await claimAttemptRetirement(owner.pipelineId, owner.directory, remaining());
    };
    // The cleanup container is the path for what this user cannot read or
    // remove. When it cannot run at all, retrying does not help: the whole root
    // stays, and the report names each such directory for the operator.
    const holdForOperator = async (bytes: number, detail: string) => {
      let target = owner.directory;
      if (!fs.existsSync(target)) {
        try { target = JSON.parse(fs.readFileSync(attemptTempJournalPath(owner.directory), "utf8")).trash ?? target; }
        catch { /* No quarantine to read; the original path stands. */ }
      }
      const blocked = await blockedSubtrees(target).catch(() => ({ count: 0, entries: [] }));
      try {
        store.recordBlocked(owner.directory, blocked, now());
        store.defer(owner.directory, Math.max(store.owner(owner.directory)?.checkedAt ?? 0, now() + BLOCKED_SUBTREE_RETRY_MS));
        if (noteFailure(detail)) console.error("[attempt temp] root held for the operator", detail);
        outcome(owner.directory, "operator", bytes, (`${blocked.count} director${blocked.count === 1 ? "y" : "ies"} this user cannot remove; `
          + `operator action (${detail})`).slice(0, 512));
      } catch (error) {
        if (!stateDatabaseBusy(error) && !(error instanceof FileTransactionBusyError)) throw error;
        outcome(owner.directory, "deferred", bytes, `operator hold bookkeeping is busy; retry next pass: ${detail}`.slice(0, 512));
      }
    };
    try {
      if (options.selection && !options.selection.current(owner)) {
        outcome(owner.directory, "held", bytes, "approved manifest binding or root identity changed"); return;
      }
      store.defer(owner.directory, now() + 60_000);
      recoveredTrash = store.recoveredTrash(owner.directory);
      requiredExpiry = store.requiredRootExpiry(owner.directory);
      const stat = fs.lstatSync(owner.directory, { throwIfNoEntry: false });
      // Stable aliases are valid (including platform temp-directory aliases).
      // Bind the physical parent and its inode throughout this visit, rather
      // than assuming an unchanged leaf still has its admitted ancestry.
      const parent = path.dirname(owner.directory), parentPhysical = resolvePhysicalPath(parent);
      const parentStat = fs.statSync(parent, { throwIfNoEntry: false });
      const pathCurrent = (directory: string) => {
        const current = fs.statSync(parent, { throwIfNoEntry: false });
        return current?.dev === parentStat?.dev && current?.ino === parentStat?.ino
          && resolvePhysicalPath(parent) === parentPhysical && attemptTempPathAdmitted(directory);
      };
      if (!pathCurrent(owner.directory)) { outcome(owner.directory, "held", bytes, "physical ancestry changed or protected"); return; }
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || `${stat.dev}:${stat.ino}` !== owner.identity)) { outcome(owner.directory, disposition, bytes, reason); return; }
      // Custody survives a missing namespace with zero allocation. A pending
      // quarantine retains its allocation projection until replay resolves.
      const pendingJournal = fs.existsSync(attemptTempJournalPath(owner.directory));
      const pendingTrash = !stat && pendingJournal;
      if (recoveredTrash) {
        if (!store.recoveredTrashCurrent(owner.directory)) {
          store.refreshTrashRecovery(owner.directory);
          outcome(owner.directory, "held", bytes, "owner-unknown"); return;
        }
        const state = await options.state(owner, inventory);
        const authority = await observeOwner(owner);
        checkBudget();
        if (state !== "expired" || authority.state !== "expired" || !authority.isCurrent()) {
          disposition = authorityDisposition(authority.state);
          outcome(owner.directory, disposition, bytes, `ownership ${authority.state}; recovered trash requires current expired lane`);
          return;
        }
        if (authority.expiresAt != null) store.requireRootExpiry(owner.directory, authority.expiresAt);
        requiredExpiry = store.requiredRootExpiry(owner.directory);
      }
      if (pendingJournal) {
        if (owner.pipelineId && hasAttemptRetirementClaim(owner.pipelineId)) await claim();
        if (stat && options.mode !== "dry-run") restoreRefusedAttemptTrash(owner.directory, owner.identity);
      }
      if (stat) {
        const initialState = owner.pipelineId && pressure ? await options.state(owner, inventory) : null;
        // Under pressure, use the last measurement for a known hold. Roots
        // with no recorded allocation still get their first measurement.
        if (owner.bytes > 0 && (initialState === "live" || initialState === "unknown")
          && !recordedRootHeld(owner.directory)) {
          recordedAllocation.add(owner.directory);
          outcome(owner.directory, initialState === "live" ? "live" : "held", bytes, `ownership ${initialState}; allocation retained`);
          return;
        }
        const recordedOnly = owner.bytes > 0 && initialState !== null && finished(initialState)
          && !fs.existsSync(path.join(owner.directory, ".delegatus-keep")) && !recordedRootHeld(owner.directory)
          && ledgerLinkedEvidence(owner.directory).length === 0;
        const measured = await measureAttemptAllocation(owner.directory, { budgetMs: remaining(), bytes: owner.bytes, recordedOnly });
        if (recordedOnly) recordedAllocation.add(owner.directory);
        // An unreadable walk reports only a lower bound. Losing visibility
        // cannot release pressure without a complete measurement or removal.
        bytes = measured.unreadable ? Math.max(owner.bytes, measured.bytes) : measured.bytes;
        if (measured.unreadable) partiallyRead.add(owner.directory);
      } else bytes = pendingTrash ? owner.bytes : 0;
      if (!stat && !pendingTrash) store.measure(owner.directory, 0);
      if (stat) {
        const measured = fs.lstatSync(owner.directory, { throwIfNoEntry: false });
        if (!measured?.isDirectory() || measured.isSymbolicLink() || `${measured.dev}:${measured.ino}` !== owner.identity) { outcome(owner.directory, disposition, owner.bytes, reason); return; }
        store.measure(owner.directory, bytes);
      }
      checkBudget();
      // An evidence hold blocks retirement, while its late files still count
      // toward pressure within this pass's existing root budget.
      let retentionExpiry: number | null = null;
      if (recordedRootHeld(owner.directory)) {
        // Expiring one check releases its other roots as a cascade. Exact-list
        // execution leaves that shared transition to the ordinary owner.
        if (options.selection) { outcome(owner.directory, "evidence", bytes, "recorded check evidence hold; exact selection cannot release shared holds"); return; }
        const initialAuthority = await observeOwner(owner);
        retentionExpiry = initialAuthority.expiresAt ?? null;
        let custodyExpiry = retentionExpiry;
        let custodyCurrent = () => true;
        if (options.evidenceAuthority) {
          const custody = await options.evidenceAuthority(owner, inventory);
          checkBudget();
          if (custody.state !== "expired" || !custody.isCurrent()) {
            store.retainRoot(owner.directory, retentionExpiry); store.rootEligible(owner.directory, false);
            outcome(owner.directory, "evidence", bytes, "recorded check retains its independent evidence lifetime"); return;
          }
          custodyExpiry = custody.expiresAt ?? null;
          custodyCurrent = custody.isCurrent;
        }
        checkBudget();
        if (initialAuthority.state === "expired") await claim();
        const observedAt = now();
        const protection = stat && initialAuthority.state === "expired"
          ? await snapshotAttemptProtection(owner.directory, remaining(), true, bytes) : { current: () => true };
        const unpinned = !stat || await inspectAttemptTree(owner.directory, owner.directory, { budgetMs: remaining(), bytes });
        checkBudget();
        store.retainRoot(owner.directory, retentionExpiry);
        store.rootEligible(owner.directory, unpinned);
        if (unpinned && initialAuthority.state === "expired" && owner.pipelineId && initialAuthority.isCurrent() && options.mode !== "dry-run") {
          // The CAS releases the whole check, including roots outside this
          // page. Persist their prerequisites together before that await.
          await expireRecordedRootHolds(owner.directory, owner.pipelineId, now(), () => initialAuthority.isCurrent() && custodyCurrent()
            && now() >= observedAt && now() - observedAt < ATTEMPT_TEMP_PROTECTION_MAX_AGE_MS && protection.current(),
            row => store.requireRecordedRootExpiry(row, custodyExpiry), remaining);
          requiredExpiry = store.requiredRootExpiry(owner.directory);
        }
        if (recordedRootHeld(owner.directory) && !(options.mode === "dry-run" && initialAuthority.state === "expired")) {
          if (pendingTrash && !recoveredTrash && options.mode !== "dry-run") restoreRefusedAttemptTrash(owner.directory, owner.identity);
          if (initialAuthority.expiresAt && initialAuthority.expiresAt > now()) store.defer(owner.directory, initialAuthority.expiresAt);
          outcome(owner.directory, "evidence", bytes, "recorded check evidence hold"); return;
        }
      }
      let namespaceOnly = false;
      let namespaceProtection: AttemptNamespaceProtection | undefined;
      let dispatchAuthority: AttemptTempAuthority | undefined;
      let dispatchState: AttemptTempState | undefined;
      let dispatchEvidence: AttemptProtection | undefined;
      const ownerAuthorityCurrent = () => {
        const binding = store.owner(owner.directory);
        requiredExpiry = store.requiredRootExpiry(owner.directory);
        return binding?.identity === owner.identity && binding.pipelineId === owner.pipelineId && binding.launchId === owner.launchId
          && (!options.selection || options.selection.current(binding))
          && binding.createdAt === owner.createdAt && binding.retainUntilClose === owner.retainUntilClose
          && !recordedRootHeld(owner.directory)
          && (!pressure || ledgerLinkedEvidence(owner.directory).length === 0)
          && (!recoveredTrash || store.recoveredTrashCurrent(owner.directory))
          && (dispatchAuthority?.isCurrent() ?? true)
          && (dispatchAuthority?.state ?? dispatchState) === dispatchState
          && (dispatchState !== undefined)
          && (!options.requireExpired || dispatchState === "expired")
          && expiryCurrent(dispatchState);
      };
      const retirementAuthorityCurrent = (directory: string, validateCheckouts = true) => {
        const current = fs.lstatSync(directory, { throwIfNoEntry: false });
        return pathCurrent(directory) && !!current?.isDirectory() && !current.isSymbolicLink() && `${current.dev}:${current.ino}` === owner.identity
          && (!validateCheckouts || inventory.unchangedAll()) && ownerAuthorityCurrent();
      };
      // The evidence snapshot must match until content deletion dispatches.
      // Its directory metadata and entries change during our own cleanup;
      // the final empty-root fence retains the independent authority checks.
      const authorityWatches = () => [...attemptPathWatches(options.selection?.watches ?? [], "authority"), ...attemptPathWatches([store.filename, store.filename + "-wal", statePath("state.sqlite"),
        statePath("state.sqlite-wal")], "authority"), ...attemptPathWatches([statePath("project-aliases.json")]),
        ...(!owner.pipelineId ? attemptPathWatches([statePath("agent-registry.json"), statePath("agent-registry.sqlite"),
          statePath("agent-registry.sqlite-wal")], "authority") : []),
        ...(recoveredTrash ? store.trashRecoveryWatches(owner.directory) : [])];
      // Opaque contents are validated inside the namespace. Watching their
      // accessible parent pins the root name and notices mode/rebinding changes
      // without requiring read permission on the root itself.
      const rootWatches = (directory: string) => [...(namespaceProtection ? [] : [directory]), ...attemptPathWatches([directory], false)];
      const mutationDirectories = (directory: string) => [...rootWatches(directory), ...authorityWatches(),
        ...(dispatchEvidence?.mutationDirectories ?? []), ...inventory.mutationDirectories()];
      const processInputsClear = (directory: string) => (!pressure && (dispatchState === undefined || !finished(dispatchState)))
        || attemptProcessReferencesClear(owner.directory, directory, options.scan([owner.directory, directory]));
      const dispatchEligible = (directory: string) => attemptMutationCurrent(
        mutationDirectories(directory),
        () => retirementAuthorityCurrent(directory) && processInputsClear(directory) && dispatchEvidence?.current() === true, remaining(), ownerAuthorityCurrent);
      const emptyRootEligible = (directory: string) => attemptMutationCurrent(
        [...rootWatches(directory), ...authorityWatches(), ...inventory.mutationDirectories()],
        () => retirementAuthorityCurrent(directory) && processInputsClear(directory), remaining(), ownerAuthorityCurrent);
      const scan = () => options.scan([owner.directory, currentDirectory]);
      const observeReferences = async (directory: string) => {
        try {
          const clear = await references(owner.directory, directory, scan());
          if (!clear) {
            disposition = "live";
            reason = "live process, socket, checkout link or container mount";
          }
          return clear;
        }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "EACCES" || code === "EPERM") {
            disposition = "operator";
            // The detail names what vanished or refused: a process cwd or a
            // consumer checkout whose process is still alive.
            reason = `consumer checkout became unreadable during retirement: ${attemptTempFailureDetail(error)}`.slice(0, 512);
            return false;
          }
          throw error;
        }
      };
      // Build the expensive tree protection lazily when its cursor reaches
      // this root. Repeated eligibility checks validate the same snapshot;
      // they do not enumerate the tree again. Only this root is retained,
      // and a renamed quarantine or an aged snapshot needs a fresh proof.
      let treeProof: { directory: string; at: number; protection: AttemptProtection; unpinned: boolean } | undefined;
      const protectedTree = async (directory: string) => {
        if (treeProof?.directory === directory && now() >= treeProof.at
          && now() - treeProof.at < ATTEMPT_TEMP_PROTECTION_MAX_AGE_MS
          && treeProof.protection.current()) return treeProof;
        treeProof = undefined;
        const at = now();
        const snapshot = await snapshotAttemptProtection(directory, remaining(), true, bytes, owner.directory);
        const protection: AttemptProtection = { ...snapshot, current: () => now() >= at
          && now() - at < ATTEMPT_TEMP_PROTECTION_MAX_AGE_MS && snapshot.current() };
        const unpinned = await inspectAttemptTree(directory, owner.directory, { budgetMs: remaining(), bytes });
        treeProof = { directory, at, protection, unpinned };
        return treeProof;
      };
      const eligible = async (directory = owner.directory) => {
        currentDirectory = directory;
        checkBudget();
        if (options.selection && !options.selection.current(owner)) { reason = "approved manifest authority changed"; return false; }
        const state = await options.state(owner, inventory);
        if (options.requireExpired && state !== "expired") {
          disposition = state === "live" ? "live" : "held";
          reason = "scratch requires confirmed completion strictly older than 24 hours"; return false;
        }
        if (recoveredTrash && state !== "expired") {
          disposition = authorityDisposition(state); reason = `ownership ${state}; recovered trash requires expired lane`; return false;
        }
        if (!expiryCurrent(state)) {
          disposition = "evidence"; reason = "previously held root awaits lane expiry";
          store.rootEligible(owner.directory, false);
          if (requiredExpiry !== null && requiredExpiry > now()) store.defer(owner.directory, requiredExpiry);
          return false;
        }
        if (options.selection && !options.selection.current(owner)) { reason = "approved manifest authority changed after owner observation"; return false; }
        if (recordedRootHeld(owner.directory) && !(options.mode === "dry-run" && state === "expired")) { disposition = "evidence"; reason = "recorded check evidence hold"; return false; }
        checkBudget();
        disposition = state === "live" ? "live" : state === "settled" && owner.retainUntilClose ? "evidence" : "held";
        reason = state === "live" ? "live lane or checkout dependency" : state === "settled" && owner.retainUntilClose
          ? "declared evidence until lane close" : `ownership ${state}`;
        const current = fs.lstatSync(directory, { throwIfNoEntry: false });
        if (!pathCurrent(directory) || !current?.isDirectory() || current.isSymbolicLink() || `${current.dev}:${current.ino}` !== owner.identity) { reason = "physical ancestry or identity changed during authority read"; return false; }
        const settled = state === "closed" || state === "expired" || state === "settled" && !owner.retainUntilClose
          || state === "orphan" && now() - owner.createdAt >= (options.maxAgeMs ?? 86400000);
        if (!settled) return false;
        if (pressure && ledgerLinkedEvidence(owner.directory).length) {
          disposition = "evidence"; reason = "linked report evidence hold"; return false;
        }
        const proof = pressure || state === "expired" || options.mode === "dry-run" ? await protectedTree(directory) : null;
        const protection: AttemptProtection = proof?.protection ?? { current: () => true };
        namespaceProtection = protection.namespace;
        const unpinned = proof?.unpinned ?? await inspectAttemptTree(directory, owner.directory, { budgetMs: remaining(), bytes });
        store.rootEligible(owner.directory, unpinned);
        if (!unpinned) { disposition = "evidence"; reason = "tree evidence, mount or Git boundary"; return false; }
        checkBudget();
        if (!await observeReferences(directory)) return false;
        checkBudget();
        const evidence = pressure || options.mode === "dry-run" || state === "expired"
          ? { current: protection.current, namespaceOnly: false, destination: undefined, selection: undefined }
          : await preserveAttemptEvidence(directory, owner.directory, owner.identity, {
            pipelineId: owner.pipelineId, launchId: owner.launchId, ...attemptEvidenceLane(owner.pipelineId), register: destination => {
              const prior = store.copy(destination);
              const createdAt = prior?.createdAt ?? now();
              const expiresAt = owner.pipelineId ? retentionExpiry : createdAt + retentionMs;
              store.registerCopy({ destination, pipelineId: owner.pipelineId, launchId: owner.launchId,
                kind: owner.pipelineId ? "lane" : "agent", createdAt, expiresAt,
                checkedAt: expiresAt ?? now() + 3600000, bytes: prior?.bytes ?? 0 });
            },
          });
        if (evidence.selection?.skippedTracked.count || evidence.selection?.selectionFallback)
          report.evidenceSelections[owner.directory] = evidence.selection;
        if (evidence.destination) {
          const copy = store.copy(evidence.destination)!;
          store.registerCopy({ ...copy, bytes: await allocatedAttemptBytes(evidence.destination) });
        }
        namespaceOnly = evidence.namespaceOnly;
        // Native/container observations can await I/O. Ownership must still
        // agree after them, at the same dispatch boundary.
        const authorityObservation = options.authority
          ? await options.authority(owner, inventory)
          : await options.state(owner, inventory);
        const authority = typeof authorityObservation === "string" ? authorityObservation : authorityObservation.state;
        retentionExpiry = typeof authorityObservation === "string" ? null : authorityObservation.expiresAt ?? null;
        store.retainRoot(owner.directory, retentionExpiry);
        if (evidence.destination) {
          const copy = store.copy(evidence.destination)!;
          if (copy.kind === "lane") store.registerCopy({ ...copy, expiresAt: retentionExpiry, checkedAt: retentionExpiry ?? now() + 3600000 });
        }
        checkBudget();
        const final = fs.lstatSync(directory, { throwIfNoEntry: false });
        if (recordedRootHeld(owner.directory) && !(options.mode === "dry-run" && state === "expired")) { disposition = "evidence"; reason = "recorded check evidence hold"; return false; }
        if (authority !== state) { reason = `authority changed from ${state} to ${authority}`; return false; }
        if (!expiryCurrent(authority)) { disposition = "evidence"; reason = "lane expiry revoked after observations"; return false; }
        if (!final?.isDirectory() || final.isSymbolicLink() || `${final.dev}:${final.ino}` !== owner.identity) { reason = "identity changed after observations"; return false; }
        if (!protection.current() || !evidence.current()) { disposition = "evidence"; reason = "evidence changed after preservation"; return false; }
        // Checkout state can change while evidence and producer authority are
        // awaited. Repeat every process/socket/container reference observation
        // at the last eligibility boundary before quarantine or removal.
        if (!await observeReferences(directory)) return false;
        checkBudget();
        // All awaited authority and consumer observations are complete.
        // Activation may revoke the observations above. Once admitted here,
        // every lane-owned deletion holds the writer fence until its owned
        // remover and journal cleanup settle, including pressure retirement.
        await claim();
        checkBudget();
        // Decide from their synchronous snapshots so nothing can yield between
        // the final consumer-reference validation and dispatch.
        const dispatchRoot = fs.lstatSync(directory, { throwIfNoEntry: false });
        if (recordedRootHeld(owner.directory) && !(options.mode === "dry-run" && state === "expired")) { disposition = "evidence"; reason = "recorded check evidence hold"; return false; }
        if (authority !== state) { disposition = authorityDisposition(authority); reason = `authority changed from ${state} to ${authority} before dispatch`; return false; }
        if (!expiryCurrent(authority)) { disposition = "evidence"; reason = "lane expiry revoked before dispatch"; return false; }
        if (typeof authorityObservation !== "string" && !authorityObservation.isCurrent()) {
          disposition = "live";
          reason = `authority revision ${authorityObservation.revision} changed before dispatch`;
          return false;
        }
        if (!dispatchRoot?.isDirectory() || dispatchRoot.isSymbolicLink() || `${dispatchRoot.dev}:${dispatchRoot.ino}` !== owner.identity) {
          reason = "identity changed before dispatch";
          return false;
        }
        if (!protection.current() || !evidence.current()) { disposition = "evidence"; reason = "evidence changed before dispatch"; return false; }
        // The final synchronous validation includes negative checkout
        // discoveries and physical symlink destinations from the inventory.
        if (!inventory.unchangedAll()) {
          disposition = "live";
          reason = "checkout changed during final authority read";
          return false;
        }
        dispatchAuthority = typeof authorityObservation === "string" ? undefined : authorityObservation;
        dispatchState = authority;
        dispatchEvidence = { current: () => protection.current() && evidence.current(),
          mutationDirectories: protection.mutationDirectories, permissionChange: protection.permissionChange };
        return true;
      };
      if (stat && !await eligible()) { outcome(owner.directory, disposition, bytes, reason); return; }
      if (options.mode !== "dry-run") await recordRootRetirement(owner.directory, owner.identity, attemptTempJournalPath(owner.directory),
        stat ? "admitted" : "missing-unexplained", stat ? "acknowledged owned-root retirement admitted" : "missing-unexplained; no removal outcome observed", remaining);
      const result = await sweepStaleTempDirs({
        roots: [{ path: path.dirname(owner.directory), via: "" }], onlyDirectories: [owner.directory],
        eligible, maxAgeMs: 0, maxRemovals: 1, mode: options.mode, disposable: true, keepRefusedTrash: recoveredTrash,
        dispatchGuard: dispatchEligible,
        remove: (directory, mutationStarted) => {
          if (options.remove) return options.remove(directory, () => eligible(directory), () => dispatchEligible(directory), mutationStarted);
          const closedRoot = dispatchState !== undefined && disposableClosed(dispatchState);
          // Permission repair proves the pinned directory it changes.
          // Recursive deletion still uses the full tree proof.
          const permissionProof = closedRoot && !namespaceProtection ? closedAttemptProtection(directory) : dispatchEvidence;
          return removeAttemptTree(directory, owner.directory, () => eligible(directory), namespaceOnly,
            () => dispatchEligible(directory), () => emptyRootEligible(directory), pressure || dispatchState === "expired", namespaceProtection,
            { budgetMs: remaining(), bytes,
              closedRoot,
              permissionAuthority: () => retirementAuthorityCurrent(directory, false),
              // Permission repair adds owner bits to pinned directory inodes.
              // Consumer/checkout observations bracket this synchronous walk;
              // every data deletion still uses the full dispatch guard above.
              permissionDispatchGuard: closedRoot ? binding => attemptMutationCurrent(
                [...rootWatches(directory), ...authorityWatches(), ...(permissionProof?.mutationDirectories ?? [])],
                () => retirementAuthorityCurrent(directory, false) && permissionProof?.current() === true && (binding?.() ?? true),
                remaining(), ownerAuthorityCurrent) : undefined,
              mutationStarted,
              permissionChange: (file, mode, apply) => {
                const proof = closedRoot ? permissionProof : dispatchEvidence;
                if (!proof?.permissionChange) throw new AttemptTempBudgetDeferred("permission protection unavailable");
                proof.permissionChange(file, mode, apply);
              } });
        },
        measure: async () => bytes,
        // Settlement owns freshness. Preserve the full mount/Git/readability
        // inspection, including the reinspection after quarantine.
        inspect: (_directory, settings) => ({ entries: 0, newestMs: 0, hold: settings?.mounts?.length ? "mount-boundary" : null }),
        currentScan: scan, now,
      });
      // No removal is in flight once the sweep returns. Cancel a refused
      // replay before releasing its claim so a permanent pin cannot fence
      // retry/reopen forever. Uncertain removals keep their recovery journal.
      if (!recoveredTrash && !result.removed.length && !result.trashFinished && !result.errors.length && options.mode !== "dry-run")
        restoreRefusedAttemptTrash(owner.directory, owner.identity);
      report.removed += result.removed.length + (result.trashFinished ?? 0);
      report.removedBytes += result.removedBytes + (result.trashFinished ? owner.bytes : 0);
      // Sweeper errors carry a deferred refusal after their candidate path.
      // A separate acquired-path failure may include that refusal as context;
      // only classify the deferred prefix itself as non-failing.
      const failures = result.errors.filter(error => !/(?:^|: )attempt temp deferred:/.test(error));
      if (failures.length && failures.every(privilegedCleanupUnavailable) && !result.removed.length && !result.trashFinished) {
        await holdForOperator(bytes, failures.join("; "));
        return;
      }
      const deferred = result.errors.length > 0 && failures.length === 0;
      report.errors += failures.length;
      const failure = failures.join("; ").slice(0, 1024) || null;
      if (noteFailure(failure)) console.error("[attempt temp] retirement retained", failure);
      if (recoveredTrash && !result.removed.length && !result.trashFinished && !store.recoveredTrashCurrent(owner.directory)) {
        reason = "owner-unknown"; store.refreshTrashRecovery(owner.directory);
      }
      if (!result.removed.length && !result.trashFinished) outcome(owner.directory,
        deferred ? "deferred" : result.errors.length ? "failed" : disposition, bytes,
        result.errors.join("; ") || (!stat && !fs.existsSync(attemptTempJournalPath(owner.directory)) ? "absent; forgotten" : reason));
      if (result.removed.length || result.trashFinished) outcome(owner.directory, "removed", result.removedBytes, "retirement completed");
      if ((result.removed.length || result.trashFinished) && options.mode !== "dry-run") {
        // Physical accounting does not depend on the subsequent custody
        // receipt succeeding. Keep the row for recovery if that write fails.
        store.measure(owner.directory, 0);
        bytes = 0;
        forgetAttemptProtection(currentDirectory, owner.directory);
        await recordRootRetirement(owner.directory, owner.identity, attemptTempJournalPath(owner.directory), "completed", "acknowledged owned-root retirement completed", remaining);
        store.forget(owner.directory);
        options.onRetired?.(result.removed.length + (result.trashFinished ?? 0), result.removedBytes + (result.trashFinished ? owner.bytes : 0));
      }
      // A process may have died before starting quarantine. A missing original
      // with no recoverable intent can be forgotten only after replay ran.
      if (!stat && !result.errors.length && !result.trashFinished) {
        const pending = fs.existsSync(attemptTempJournalPath(owner.directory));
        if (!pending && !fs.existsSync(owner.directory) && !recordedRootHeld(owner.directory)) {
          store.forget(owner.directory);
        }
      }
    } catch (error) {
      if (error instanceof AttemptTempBudgetDeferred || stateDatabaseBusy(error) || error instanceof FileTransactionBusyError) {
        outcome(owner.directory, "deferred", bytes, error instanceof AttemptTempBudgetDeferred ? error.message
          : stateDatabaseBusy(error) ? "root database is locked; retry next pass" : "root state admission is busy; retry next pass");
        return;
      }
      if (privilegedCleanupUnavailable(error)) { await holdForOperator(bytes, attemptTempFailureDetail(error)); return; }
      report.errors++;
      const detail = attemptTempFailureDetail(error);
      outcome(owner.directory, "failed", bytes, detail);
      if (noteFailure(detail)) console.error("[attempt temp] root retained", detail);
    } finally {
      // A pre-delete refusal restores the original namespace. Its temporary
      // quarantine inventory cannot be resumed under that now-missing name.
      try {
        if (currentDirectory !== owner.directory && !fs.existsSync(currentDirectory)) forgetAttemptProtection(currentDirectory, owner.directory);
        retirement.release?.();
      }
      catch (error) {
        report.errors++;
        const detail = attemptTempFailureDetail(error);
        if (noteFailure(detail)) console.error("[attempt temp] retirement claim retained", detail);
      }
      // A root no longer held for the operator leaves the blocked listing.
      try { if (!(report.outcomes.at(-1)?.directory === owner.directory && report.outcomes.at(-1)?.disposition === "operator"))
        store.recordBlocked(owner.directory, null, now());
      // A root still held after its retention ended steps back from the
      // expired share of the page, so the next oldest gets its visit.
      const last = report.outcomes.at(-1), ended = store.retentionExpiry(owner.directory);
      if (ended !== null && ended <= now() && store.has(owner.directory)
        && !(last?.directory === owner.directory && last.disposition === "deferred"))
        store.defer(owner.directory, Math.max(store.owner(owner.directory)?.checkedAt ?? 0, now() + EXPIRED_HOLD_RETRY_MS));
      } catch (error) {
        if (!stateDatabaseBusy(error)) throw error;
        const last = report.outcomes.at(-1);
        if (last?.directory === owner.directory) last.reason += "; root bookkeeping database is locked; retry next pass";
        else outcome(owner.directory, "deferred", bytes, "root bookkeeping database is locked; retry next pass");
      }
    }
  };
  let pass: PressurePass | null = null, passEnded: CompletedPressurePass["ended"] | null = null;
  if (options.selection) {
    // Exact input order, bounded to one page. Neither a missing row nor a
    // deferred row admits another directory from the ordinary sweep.
    for (const directory of options.selection.directories.slice(0, 32)) {
      const owner = store.owner(directory);
      if (!owner) { outcome(directory, "held", 0, "approved root absent from registry"); continue; }
      if (remaining() <= 0) { outcome(directory, "deferred", owner.bytes, "run budget exhausted; retry selected root"); continue; }
      const window = Math.min(ATTEMPT_TEMP_LARGE_ROOT_BUDGET_MS, remaining());
      await withAttemptTempDeadline(sweepMonotonicNow() + window + ATTEMPT_TEMP_REPLY_MARGIN_MS, () => visit(owner));
    }
  } else if (!pressure) {
    for (const owner of store.due(now(), budget)) {
      if (remaining() <= 0) { outcome(owner.directory, "deferred", owner.bytes, "run budget exhausted; retry next tick"); continue; }
      await visit(owner);
    }
  } else {
    // One pass walks an inventory fixed at its start, from a durable
    // position. The position moves past a root before its first await, so a
    // root that kills the helper cannot hold the next one; each tick resumes
    // where the last stopped and never repeats the roots before it. A root is
    // removed during its own visit, as soon as every proof admits it.
    pass = store.pressurePass(now());
    pass.ticks++;
    store.savePressurePass(pass);
    let visitedThisTick = 0;
    for (;;) {
      if (!lowSpace && store.bytes() <= capBytes) break;
      if (visitedThisTick >= (options.maxRoots === undefined ? PRESSURE_SEARCH_ROOTS : budget)
        || options.maxRoots === undefined && report.removed > 0 && visitedThisTick >= 32) break;
      if (remaining() <= 0) break;
      const next = store.pressurePassRoot(pass.position);
      if (!next) { store.endPressurePass(now(), "complete"); passEnded = "complete"; pass.position = pass.total; break; }
      const previous = pass.position;
      pass.position = next.seq;
      visitedThisTick++;
      const owner = store.owner(next.directory);
      // Forgotten since the inventory: retired by its owner or another pass.
      if (!owner || owner.identity !== next.identity) { store.savePressurePass(pass); continue; }
      pass.visited++;
      store.savePressurePass(pass);
      const rootWindow = AttemptProtectionInventory.exists(owner.directory)
        ? ATTEMPT_TEMP_LARGE_ROOT_BUDGET_MS : attemptTempRootWindow(owner.bytes);
      const window = Math.min(rootWindow, remaining());
      const removedBefore = report.removed, removedBytesBefore = report.removedBytes, deferredBefore = report.deferred;
      await withAttemptTempDeadline(sweepMonotonicNow() + window + ATTEMPT_TEMP_REPLY_MARGIN_MS, () => visit(owner));
      pass.removed += report.removed - removedBefore;
      pass.removedBytes += report.removedBytes - removedBytesBefore;
      const deferred = report.deferred > deferredBefore;
      // A removal that started and was cut by its window left its tree in
      // recorded quarantine. Resume it first, a bounded number of times per
      // pass: each visit repeats every proof and removes more of the tree.
      const quarantined = deferred && options.mode !== "dry-run" && store.has(owner.directory)
        && !fs.existsSync(owner.directory) && fs.existsSync(attemptTempJournalPath(owner.directory));
      if (quarantined && (pass.resumeSeq !== next.seq || pass.resumes < PASS_RESUMES_PER_ROOT)) {
        pass.resumes = pass.resumeSeq === next.seq ? pass.resumes + 1 : 1;
        pass.resumeSeq = next.seq;
        pass.position = previous;
      } else if (deferred && remaining() <= 0 && window < rootWindow && pass.cutSeq !== next.seq) {
        // The end of the tick, not the root's own window, cut this visit.
        // It goes first next tick, once, with a complete window.
        pass.cutSeq = next.seq;
        pass.position = previous;
      }
      store.savePressurePass(pass);
    }
    if (!passEnded && !store.pressurePassRoot(pass.position)) {
      store.endPressurePass(now(), "complete"); passEnded = "complete"; pass.position = pass.total;
    }
  }
  report.inventoryWalks = inventory.walks.length;
  const blocked = store.blockedRoots();
  report.blocked = { roots: blocked.roots, bytes: blocked.bytes, listed: blocked.listed };
  report.bytes = store.bytes();
  report.unexaminedBytes = Math.max(0, report.bytes - report.outcomes.filter(row => options.mode === "dry-run" || row.disposition !== "removed").reduce((sum, row) => sum + row.bytes, 0));
  report.overCapBytes = Math.max(0, report.bytes - capBytes);
  // A cleared pressure episode ends its pass; the next episode starts a new
  // inventory, with the largest roots first.
  if (!options.selection && !lowSpace && report.overCapBytes === 0 && store.activePressurePass()) {
    pass ??= store.activePressurePass();
    store.endPressurePass(now(), "pressure-cleared"); passEnded = "pressure-cleared";
  }
  // Inventory sequences run from one to `total`, so the position counts the
  // roots this pass has passed. `ended` is null while the pass continues.
  return { ...report, pass: pass ? { startedAt: pass.startedAt, ticks: pass.ticks, position: pass.position, total: pass.total,
    totalBytes: pass.totalBytes, visited: pass.visited, removed: pass.removed, removedBytes: pass.removedBytes,
    elapsedMs: Math.max(0, now() - pass.startedAt), ended: passEnded } : null,
    lastPass: store.lastPressurePass(), lastFullPass: store.lastFullPressurePass(),
  recovery: { entries: recovery.entries, manifestEntries: recovery.manifestEntries, checks: recovery.checks, restored: recovery.restored } };
}
