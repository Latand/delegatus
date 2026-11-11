import fs from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { statePath } from "@/lib/configDir";
import { declaredIndexes } from "@/lib/state/declaredIndexes";
import { withFileTransactionAsync } from "@/lib/state/fileTransaction";
import { attemptTempJournalPath, sweepStaleTempDirs, type ProcessScan } from "@/lib/tempSweep";
import { allocatedAttemptBytes, attemptReferencesClear, inspectAttemptTree, snapshotAttemptProtection, removeAttemptTree, RepositoryLinkInventory, type RetainedCheckoutReads, type AttemptNamespaceProtection, type AttemptProtection } from "./attemptTempFilesystem";
import { AttemptTempBudgetDeferred, attemptTempFailureDetail } from "./attemptTempDiagnostics";
import { preserveAttemptEvidence } from "./attemptTempEvidence";
import { recordedRootHeld, recordRootRetirement, expireRecordedRootHolds, type CheckRow } from "@/lib/recordedChecks/store";
import { AttemptRetentionReporting } from "./attemptRetentionReporting";
import { FINISHED_LANE_RETENTION_MS } from "@/lib/pipelines/laneFinish";
import { claimAttemptRetirement } from "@/lib/pipelines/store";
import { hasAttemptRetirementClaim, restoreRefusedAttemptTrash } from "@/lib/pipelines/retirementClaim";

export type AttemptTempState = "live" | "settled" | "closed" | "expired" | "orphan" | "unknown";
export type AttemptTempAuthority = { state: AttemptTempState; expiresAt?: number | null; revision: string; isCurrent: () => boolean };
const authorityDisposition = (state: AttemptTempState): "live" | "held" => state === "live" ? "live" : "held";
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

const attemptTempIndexes = declaredIndexes([
  "CREATE INDEX IF NOT EXISTS roots_due ON roots(checkedAt,createdAt,directory)",
  "CREATE INDEX IF NOT EXISTS copies_due ON copies(checkedAt,destination) WHERE kind<>'unattributed'",
  "CREATE INDEX IF NOT EXISTS copies_inspection ON copies(destination) WHERE kind<>'unattributed'",
  "CREATE INDEX IF NOT EXISTS copies_expiry ON copies(expiresAt,destination)",
  "CREATE INDEX IF NOT EXISTS roots_retention_expiry ON root_retention(expiresAt)",
]);

/** A separate, small ledger: selecting a tick never reads pipeline history or
 * walks all roots. The due index also prevents live roots starving old ones. */
export class AttemptTempStore {
  private db: Database;
  private reporting!: AttemptRetentionReporting;
  constructor(readonly filename = statePath("attempt-temp.sqlite")) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
    if (!sqlite) throw new Error("Attempt temp retention requires Bun");
    this.db = new sqlite.Database(filename, { create: true });
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
      this.db.exec("CREATE TABLE IF NOT EXISTS root_expiry_admission(directory TEXT PRIMARY KEY, expiresAt REAL NOT NULL)");
      this.db.exec("CREATE TABLE IF NOT EXISTS copy_retention_failures(destination TEXT PRIMARY KEY, failure TEXT NOT NULL)");
      this.db.exec("CREATE TABLE IF NOT EXISTS copy_adoption(id INTEGER PRIMARY KEY CHECK(id=1), cursor TEXT NOT NULL, done INTEGER NOT NULL)");
      this.db.exec("CREATE TABLE IF NOT EXISTS copy_inspection(id INTEGER PRIMARY KEY CHECK(id=1), cursor TEXT NOT NULL)");
      attemptTempIndexes.install(this.db, path.dirname(filename));
      this.db.exec("CREATE TABLE IF NOT EXISTS totals (id INTEGER PRIMARY KEY CHECK(id=1), bytes REAL NOT NULL)");
      this.db.exec("INSERT OR IGNORE INTO totals VALUES (1,0)");
      this.db.exec("CREATE TRIGGER IF NOT EXISTS roots_bytes_update AFTER UPDATE OF bytes ON roots BEGIN UPDATE totals SET bytes=bytes+NEW.bytes-OLD.bytes WHERE id=1; END");
      this.db.exec("CREATE TRIGGER IF NOT EXISTS roots_bytes_delete AFTER DELETE ON roots BEGIN UPDATE totals SET bytes=bytes-OLD.bytes WHERE id=1; END");
      this.db.exec("CREATE TABLE IF NOT EXISTS adoption (id INTEGER PRIMARY KEY CHECK(id=1), cursor TEXT NOT NULL)");
      this.reporting = new AttemptRetentionReporting(this.db, path.dirname(filename));
      fs.chmodSync(filename, 0o600);
    } catch (error) { this.db.close(); throw error; }
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
  has(directory: string) { return !!this.db.query("SELECT 1 FROM roots WHERE directory=?").get(directory); }
  owner(directory: string): Row | null { return this.db.query<Row, [string]>("SELECT * FROM roots WHERE directory=?").get(directory); }
  release(directory: string) { this.db.query("UPDATE roots SET released=1,checkedAt=0 WHERE directory=?").run(directory); }
  due(now: number, limit: number, pressure = false): Row[] {
    if (pressure) {
      // Release is a scheduling hint, never deletion authority. Reserve a
      // quarter of each page for the oldest observations, including unreleased
      // and refused roots. checkedAt persists this progress through restarts.
      const priority = this.db.query<Row, [number, number]>("SELECT * FROM roots WHERE released=1 AND checkedAt<=? ORDER BY checkedAt,bytes DESC,createdAt,directory LIMIT ?")
        .all(now, Math.max(1, limit - Math.ceil(limit / 4)));
      const selected = new Set(priority.map(row => row.directory));
      const fair = this.db.query<Row, [number, number]>("SELECT * FROM roots WHERE checkedAt<=? ORDER BY CASE WHEN checkedAt=0 THEN createdAt ELSE checkedAt END,createdAt,directory LIMIT ?")
        .all(now, limit + priority.length).filter(row => !selected.has(row.directory));
      return [...priority, ...fair.slice(0, limit - priority.length)];
    }
    return this.db.query<Row, [number, number]>("SELECT * FROM roots WHERE checkedAt<=? ORDER BY checkedAt,createdAt,directory LIMIT ?").all(now, limit);
  }
  defer(directory: string, until: number) { this.db.query("UPDATE roots SET checkedAt=? WHERE directory=?").run(until, directory); }
  forget(directory: string) {
    this.db.transaction(() => {
      this.db.query("DELETE FROM root_retention WHERE directory=?").run(directory);
      this.db.query("DELETE FROM root_expiry_admission WHERE directory=?").run(directory);
      this.db.query("DELETE FROM roots WHERE directory=?").run(directory);
    })();
  }
  retainRoot(directory: string, expiresAt: number | null) {
    this.db.query("INSERT INTO root_retention(directory,expiresAt) VALUES(?,?) ON CONFLICT(directory) DO UPDATE SET expiresAt=excluded.expiresAt").run(directory, expiresAt);
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
  close() { this.db.close(); }
}

export type AttemptTempSweepOptions = {
  now?: () => number;
  state: (owner: AttemptTempOwner, inventory: RepositoryLinkInventory) => Promise<AttemptTempState>;
  authority?: (owner: AttemptTempOwner, inventory: RepositoryLinkInventory) => Promise<AttemptTempAuthority>;
  scan: (directories: readonly string[]) => ProcessScan;
  references?: (original: string, current: string, scan: ProcessScan) => Promise<boolean>;
  maxRoots?: number;
  maxAgeMs?: number;
  runBudgetMs?: number;
  capBytes?: number;
  retentionMs?: number;
  remove?: (directory: string, guard: () => Promise<boolean>, dispatch: () => boolean) => Promise<void>;
  mode?: "on" | "dry-run";
  onRetired?: (count: number, bytes: number) => void;
  /** Checkout reads kept by a caller that lives across ticks. Passing it also
   * lets one reference observation reuse a validation of the last seconds. */
  checkoutReads?: RetainedCheckoutReads;
};
export async function sweepAttemptTemps(store: AttemptTempStore, options: AttemptTempSweepOptions) {
  // Serving generations may overlap. One process-shared owner must retain the
  // journal through every await; the existing async lock recovers dead owners.
  return withFileTransactionAsync(store.filename + ".sweep", "attempt-temp sweep admission", () => sweepOwnedAttemptTemps(store, options));
}

async function sweepOwnedAttemptTemps(store: AttemptTempStore, options: AttemptTempSweepOptions) {
  const now = options.now ?? Date.now;
  const retentionMs = options.retentionMs ?? FINISHED_LANE_RETENTION_MS;
  const observeOwner = async (owner: AttemptTempOwner): Promise<AttemptTempAuthority> => options.authority
    ? options.authority(owner, inventory) : { state: await options.state(owner, inventory), revision: "", isCurrent: () => true };
  const deadline = now() + (options.runBudgetMs ?? 40_000);
  const checkBudget = () => { if (now() >= deadline) throw new AttemptTempBudgetDeferred("run budget exhausted"); };
  const adoption = store.adopt(now());
  const capBytes = options.capBytes ?? DEFAULT_ATTEMPT_TEMP_CAP_BYTES;
  type Outcome = { directory: string; disposition: "deferred" | "live" | "evidence" | "held" | "failed" | "removed"; bytes: number; reason: string };
  const report = { adopted: adoption.adopted, checked: 0, removed: 0, removedBytes: 0,
    deferred: 0, deferredBytes: 0, held: 0, liveHeld: 0, liveHeldBytes: 0,
    evidenceHeld: 0, evidenceHeldBytes: 0, otherHeldBytes: 0,
    errors: adoption.errors, failedBytes: 0, unexaminedBytes: 0,
    bytes: store.bytes(), capBytes, overCapBytes: 0, inventoryWalks: 0, outcomes: [] as Outcome[] };
  const outcome = (directory: string, disposition: Outcome["disposition"], bytes: number, reason: string) => {
    report.outcomes.push({ directory, disposition, bytes, reason });
    if (disposition === "deferred") { report.deferred++; report.deferredBytes += bytes; }
    else if (disposition === "failed") { report.failedBytes += bytes; }
    else if (disposition !== "removed") {
      report.held++;
      if (disposition === "live") { report.liveHeld++; report.liveHeldBytes += bytes; }
      else if (disposition === "evidence") { report.evidenceHeld++; report.evidenceHeldBytes += bytes; }
      else report.otherHeldBytes += bytes;
    }
  };
  const budget = Math.max(1, Math.min(32, options.maxRoots ?? (store.bytes() > capBytes ? 32 : 4)));
  // A caller that lives across ticks keeps completed checkout reads, and its
  // repeated validations inside one reference observation reuse a result of
  // the last few seconds. Each destructive step below still waits for
  // `unchangedAll`, which reads every inventoried directory again.
  const inventory = new RepositoryLinkInventory({ now, budgetMs: Math.min(30_000, options.runBudgetMs ?? 40_000),
    retained: options.checkoutReads, validationReuseMs: options.checkoutReads ? 5_000 : 0 });
  const references = options.references
    ?? ((original: string, current: string, scan: ProcessScan) => attemptReferencesClear(original, current, scan, undefined, inventory));
  const pressure = store.bytes() > capBytes;
  const selected = store.due(now(), budget, pressure);
  // Rank only this bounded page. Release is merely the cheap persistent hint
  // used to find candidates; current lane authority decides their actual rank
  // and is read again at every destructive boundary below.
  if (pressure) {
    const states = new Map<string, AttemptTempState>();
    for (const owner of selected) {
      if (now() >= deadline) break;
      store.defer(owner.directory, now() + 60_000);
      try { states.set(owner.directory, await options.state(owner, inventory)); }
      catch { /* The root path below preserves and classifies the real cause. */ }
    }
    const rank = (owner: Row) => states.get(owner.directory) === "closed" || states.get(owner.directory) === "expired"
      || states.get(owner.directory) === "settled" && !owner.retainUntilClose ? 0 : 1;
    selected.sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? b.bytes - a.bytes : 0));
  }
  for (const owner of selected) {
    if (now() >= deadline) { outcome(owner.directory, "deferred", owner.bytes, "run budget exhausted; retry next tick"); continue; }
    report.checked++;
    let bytes = owner.bytes;
    let disposition: "live" | "evidence" | "held" = "held";
    let reason = "identity changed";
    // Persist fairness before the first await; a killed helper resumes elsewhere.
    store.defer(owner.directory, now() + 60_000);
    const retirement: { release?: () => void } = {};
    let requiredExpiry = store.requiredRootExpiry(owner.directory);
    const expiryCurrent = (state: AttemptTempState | undefined) => requiredExpiry === null
      || state === "expired" && now() >= requiredExpiry;
    const claim = async () => {
      if (!retirement.release && owner.pipelineId && options.mode !== "dry-run")
        retirement.release = await claimAttemptRetirement(owner.pipelineId, owner.directory);
    };
    try {
      const stat = fs.lstatSync(owner.directory, { throwIfNoEntry: false });
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || `${stat.dev}:${stat.ino}` !== owner.identity)) { outcome(owner.directory, disposition, bytes, reason); continue; }
      // Custody survives a missing namespace with zero allocation. A pending
      // quarantine retains its allocation projection until replay resolves.
      const pendingJournal = fs.existsSync(attemptTempJournalPath(owner.directory));
      const pendingTrash = !stat && pendingJournal;
      if (pendingJournal) {
        if (owner.pipelineId && hasAttemptRetirementClaim(owner.pipelineId)) await claim();
        if (stat && options.mode !== "dry-run") restoreRefusedAttemptTrash(owner.directory, owner.identity);
      }
      bytes = stat ? await allocatedAttemptBytes(owner.directory, { budgetMs: deadline - now(), bytes: owner.bytes }) : pendingTrash ? owner.bytes : 0;
      if (!stat && !pendingTrash) store.measure(owner.directory, 0);
      if (stat) {
        const measured = fs.lstatSync(owner.directory, { throwIfNoEntry: false });
        if (!measured?.isDirectory() || measured.isSymbolicLink() || `${measured.dev}:${measured.ino}` !== owner.identity) { outcome(owner.directory, disposition, owner.bytes, reason); continue; }
        store.measure(owner.directory, bytes);
      }
      checkBudget();
      // An evidence hold blocks retirement, while its late files still count
      // toward pressure within this pass's existing root budget.
      let retentionExpiry: number | null = null;
      if (recordedRootHeld(owner.directory)) {
        const initialAuthority = await observeOwner(owner);
        retentionExpiry = initialAuthority.expiresAt ?? null;
        checkBudget();
        if (initialAuthority.state === "expired") await claim();
        const protection = stat && initialAuthority.state === "expired" ? await snapshotAttemptProtection(owner.directory, deadline - now(), true, bytes) : { current: () => true };
        const unpinned = !stat || await inspectAttemptTree(owner.directory, owner.directory, { budgetMs: deadline - now(), bytes });
        checkBudget();
        store.retainRoot(owner.directory, unpinned ? retentionExpiry : null);
        if (unpinned && initialAuthority.state === "expired" && owner.pipelineId && initialAuthority.isCurrent() && options.mode !== "dry-run") {
          // The CAS releases the whole check, including roots outside this
          // page. Persist their prerequisites together before that await.
          await expireRecordedRootHolds(owner.directory, owner.pipelineId, now(), () => initialAuthority.isCurrent() && protection.current(),
            row => store.requireRecordedRootExpiry(row, retentionExpiry));
          requiredExpiry = store.requiredRootExpiry(owner.directory);
        }
        if (recordedRootHeld(owner.directory) && !(options.mode === "dry-run" && initialAuthority.state === "expired")) {
          if (pendingTrash && options.mode !== "dry-run") restoreRefusedAttemptTrash(owner.directory, owner.identity);
          if (initialAuthority.expiresAt && initialAuthority.expiresAt > now()) store.defer(owner.directory, initialAuthority.expiresAt);
          outcome(owner.directory, "evidence", bytes, "recorded check evidence hold"); continue;
        }
      }
      let currentDirectory = owner.directory;
      let namespaceOnly = false;
      let namespaceProtection: AttemptNamespaceProtection | undefined;
      let dispatchAuthority: AttemptTempAuthority | undefined;
      let dispatchState: AttemptTempState | undefined;
      let dispatchEvidence: AttemptProtection | undefined;
      const retirementAuthorityCurrent = (directory: string, validateCheckouts = true) => {
        const current = fs.lstatSync(directory, { throwIfNoEntry: false });
        return !recordedRootHeld(owner.directory)
          && !!current?.isDirectory() && !current.isSymbolicLink() && `${current.dev}:${current.ino}` === owner.identity
          && (dispatchAuthority?.isCurrent() ?? true)
          && (dispatchAuthority?.state ?? dispatchState) === dispatchState
          && (dispatchState !== undefined)
          && expiryCurrent(dispatchState)
          && (!validateCheckouts || inventory.unchangedAll());
      };
      // The evidence snapshot must match until content deletion dispatches.
      // Its directory metadata and entries change during our own cleanup;
      // the final empty-root fence retains the independent authority checks.
      const dispatchEligible = (directory: string) => retirementAuthorityCurrent(directory)
        && dispatchEvidence?.current() === true;
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
            disposition = "live";
            reason = "consumer checkout became unreadable during retirement";
            return false;
          }
          throw error;
        }
      };
      const eligible = async (directory = owner.directory) => {
        currentDirectory = directory;
        checkBudget();
        const state = await options.state(owner, inventory);
        if (!expiryCurrent(state)) {
          disposition = "evidence"; reason = "previously held root awaits lane expiry";
          if (requiredExpiry !== null && requiredExpiry > now()) store.defer(owner.directory, requiredExpiry);
          return false;
        }
        if (recordedRootHeld(owner.directory) && !(options.mode === "dry-run" && state === "expired")) { disposition = "evidence"; reason = "recorded check evidence hold"; return false; }
        checkBudget();
        disposition = state === "live" ? "live" : state === "settled" && owner.retainUntilClose ? "evidence" : "held";
        reason = state === "live" ? "live lane or checkout dependency" : state === "settled" && owner.retainUntilClose
          ? "declared evidence until lane close" : `ownership ${state}`;
        const current = fs.lstatSync(directory, { throwIfNoEntry: false });
        if (!current?.isDirectory() || current.isSymbolicLink() || `${current.dev}:${current.ino}` !== owner.identity) { reason = "identity changed during authority read"; return false; }
        const settled = state === "closed" || state === "expired" || state === "settled" && !owner.retainUntilClose
          || state === "orphan" && now() - owner.createdAt >= (options.maxAgeMs ?? 86400000);
        if (!settled) return false;
        if (state === "expired") await claim();
        const protection: AttemptProtection = state === "expired" || options.mode === "dry-run" ? await snapshotAttemptProtection(directory, deadline - now(), true, bytes) : { current: () => true };
        namespaceProtection = protection.namespace;
        if (!await inspectAttemptTree(directory, owner.directory, { budgetMs: deadline - now(), bytes })) { store.retainRoot(owner.directory, null); disposition = "evidence"; reason = "tree evidence, mount or Git boundary"; return false; }
        checkBudget();
        if (!await observeReferences(directory)) return false;
        checkBudget();
        const evidence = options.mode === "dry-run" || state === "expired" ? { current: protection.current, namespaceOnly: false, destination: undefined }
          : await preserveAttemptEvidence(directory, owner.directory, owner.identity, {
            pipelineId: owner.pipelineId, launchId: owner.launchId, register: destination => {
              const prior = store.copy(destination);
              const createdAt = prior?.createdAt ?? now();
              const expiresAt = owner.pipelineId ? retentionExpiry : createdAt + retentionMs;
              store.registerCopy({ destination, pipelineId: owner.pipelineId, launchId: owner.launchId,
                kind: owner.pipelineId ? "lane" : "agent", createdAt, expiresAt,
                checkedAt: expiresAt ?? now() + 3600000, bytes: prior?.bytes ?? 0 });
            },
          });
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
        dispatchEvidence = { current: () => protection.current() && evidence.current(), permissionChange: protection.permissionChange };
        return true;
      };
      if (stat && !await eligible()) { outcome(owner.directory, disposition, bytes, reason); continue; }
      if (options.mode !== "dry-run") await recordRootRetirement(owner.directory, owner.identity, attemptTempJournalPath(owner.directory),
        stat ? "admitted" : "missing-unexplained", stat ? "acknowledged owned-root retirement admitted" : "missing-unexplained; no removal outcome observed");
      const result = await sweepStaleTempDirs({
        roots: [{ path: path.dirname(owner.directory), via: "" }], onlyDirectories: [owner.directory],
        eligible, maxAgeMs: 0, maxRemovals: 1, mode: options.mode, disposable: true,
        dispatchGuard: dispatchEligible,
        remove: directory => options.remove
          ? options.remove(directory, () => eligible(directory), () => dispatchEligible(directory))
          : removeAttemptTree(directory, owner.directory, () => eligible(directory), namespaceOnly,
            () => dispatchEligible(directory), () => retirementAuthorityCurrent(directory), dispatchState === "expired", namespaceProtection,
            { budgetMs: deadline - now(), bytes,
              permissionAuthority: () => retirementAuthorityCurrent(directory, false),
              permissionChange: (file, mode, apply) => {
                if (!dispatchEvidence?.permissionChange) throw new AttemptTempBudgetDeferred("permission protection unavailable");
                dispatchEvidence.permissionChange(file, mode, apply);
              } }),
        measure: async () => bytes,
        // Settlement owns freshness. Preserve the full mount/Git/readability
        // inspection, including the reinspection after quarantine.
        inspect: (_directory, settings) => ({ entries: 0, newestMs: 0, hold: settings?.mounts?.length ? "mount-boundary" : null }),
        currentScan: scan, now,
      });
      // No removal is in flight once the sweep returns. Cancel a refused
      // replay before releasing its claim so a permanent pin cannot fence
      // retry/reopen forever. Uncertain removals keep their recovery journal.
      if (!result.removed.length && !result.trashFinished && !result.errors.length && options.mode !== "dry-run")
        restoreRefusedAttemptTrash(owner.directory, owner.identity);
      report.removed += result.removed.length + (result.trashFinished ?? 0);
      report.removedBytes += result.removedBytes + (result.trashFinished ? owner.bytes : 0);
      const failures = result.errors.filter(error => !error.includes("attempt temp deferred:"));
      const deferred = result.errors.length > 0 && failures.length === 0;
      report.errors += failures.length;
      const failure = failures.join("; ").slice(0, 1024) || null;
      if (store.rootFailure(owner.directory, failure)) console.error("[attempt temp] retirement retained", failure);
      if (!result.removed.length && !result.trashFinished) outcome(owner.directory,
        deferred ? "deferred" : result.errors.length ? "failed" : disposition, bytes,
        result.errors.join("; ") || (!stat && !fs.existsSync(attemptTempJournalPath(owner.directory)) ? "absent; forgotten" : reason));
      if (result.removed.length || result.trashFinished) outcome(owner.directory, "removed", result.removedBytes, "retirement completed");
      if ((result.removed.length || result.trashFinished) && options.mode !== "dry-run") {
        // Physical accounting does not depend on the subsequent custody
        // receipt succeeding. Keep the row for recovery if that write fails.
        store.measure(owner.directory, 0);
        bytes = 0;
        await recordRootRetirement(owner.directory, owner.identity, attemptTempJournalPath(owner.directory), "completed", "acknowledged owned-root retirement completed");
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
      if (error instanceof AttemptTempBudgetDeferred) {
        outcome(owner.directory, "deferred", bytes, error.message);
        continue;
      }
      report.errors++;
      const detail = attemptTempFailureDetail(error);
      outcome(owner.directory, "failed", bytes, detail);
      if (store.rootFailure(owner.directory, detail)) console.error("[attempt temp] root retained", detail);
    } finally {
      try { retirement.release?.(); }
      catch (error) {
        report.errors++;
        const detail = attemptTempFailureDetail(error);
        if (store.rootFailure(owner.directory, detail)) console.error("[attempt temp] retirement claim retained", detail);
      }
    }
  }
  report.inventoryWalks = inventory.walks.length;
  report.bytes = store.bytes();
  report.unexaminedBytes = Math.max(0, report.bytes - report.outcomes.filter(row => options.mode === "dry-run" || row.disposition !== "removed").reduce((sum, row) => sum + row.bytes, 0));
  report.overCapBytes = Math.max(0, report.bytes - capBytes);
  return report;
}
