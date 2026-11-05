import fs from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { statePath } from "@/lib/configDir";
import { declaredIndexes } from "@/lib/state/declaredIndexes";
import { withFileTransactionAsync } from "@/lib/state/fileTransaction";
import { attemptTempJournalPath, sweepStaleTempDirs, type ProcessScan } from "@/lib/tempSweep";
import { allocatedAttemptBytes, attemptReferencesClear, inspectAttemptTree, removeAttemptTree, RepositoryLinkInventory } from "./attemptTempFilesystem";
import { AttemptTempBudgetDeferred, attemptTempFailureDetail } from "./attemptTempDiagnostics";
import { preserveAttemptEvidence } from "./attemptTempEvidence";
import { recordedRootHeld, recordRootRetirement } from "@/lib/recordedChecks/store";

export type AttemptTempState = "live" | "settled" | "closed" | "orphan" | "unknown";
export type AttemptTempOwner = {
  directory: string;
  pipelineId: string | null;
  launchId: string;
  retainUntilClose: boolean;
  createdAt: number;
};
type Row = AttemptTempOwner & { identity: string; released: number; checkedAt: number; bytes: number };
export const DEFAULT_ATTEMPT_TEMP_CAP_BYTES = 100 * 1024 ** 3;

const attemptTempIndexes = declaredIndexes([
  "CREATE INDEX IF NOT EXISTS roots_due ON roots(checkedAt,createdAt,directory)",
]);

/** A separate, small ledger: selecting a tick never reads pipeline history or
 * walks all roots. The due index also prevents live roots starving old ones. */
export class AttemptTempStore {
  private db: Database;
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
      attemptTempIndexes.install(this.db, path.dirname(filename));
      this.db.exec("CREATE TABLE IF NOT EXISTS totals (id INTEGER PRIMARY KEY CHECK(id=1), bytes REAL NOT NULL)");
      this.db.exec("INSERT OR IGNORE INTO totals VALUES (1,0)");
      this.db.exec("CREATE TRIGGER IF NOT EXISTS roots_bytes_update AFTER UPDATE OF bytes ON roots BEGIN UPDATE totals SET bytes=bytes+NEW.bytes-OLD.bytes WHERE id=1; END");
      this.db.exec("CREATE TRIGGER IF NOT EXISTS roots_bytes_delete AFTER DELETE ON roots BEGIN UPDATE totals SET bytes=bytes-OLD.bytes WHERE id=1; END");
      this.db.exec("CREATE TABLE IF NOT EXISTS adoption (id INTEGER PRIMARY KEY CHECK(id=1), cursor TEXT NOT NULL)");
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
  forget(directory: string) { this.db.query("DELETE FROM roots WHERE directory=?").run(directory); }
  measure(directory: string, bytes: number) { this.db.query("UPDATE roots SET bytes=? WHERE directory=?").run(bytes, directory); }
  bytes() { return this.db.query<{ bytes: number }, []>("SELECT bytes FROM totals WHERE id=1").get()!.bytes; }
  close() { this.db.close(); }
}

export type AttemptTempSweepOptions = {
  now?: () => number;
  state: (owner: AttemptTempOwner, inventory: RepositoryLinkInventory) => Promise<AttemptTempState>;
  scan: (directories: readonly string[]) => ProcessScan;
  references?: (original: string, current: string, scan: ProcessScan) => Promise<boolean>;
  maxRoots?: number;
  maxAgeMs?: number;
  runBudgetMs?: number;
  capBytes?: number;
  mode?: "on" | "dry-run";
  onRetired?: (count: number, bytes: number) => void;
};
export async function sweepAttemptTemps(store: AttemptTempStore, options: AttemptTempSweepOptions) {
  // Serving generations may overlap. One process-shared owner must retain the
  // journal through every await; the existing async lock recovers dead owners.
  return withFileTransactionAsync(store.filename + ".sweep", "attempt-temp sweep admission", () => sweepOwnedAttemptTemps(store, options));
}

async function sweepOwnedAttemptTemps(store: AttemptTempStore, options: AttemptTempSweepOptions) {
  const now = options.now ?? Date.now;
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
  const inventory = new RepositoryLinkInventory({ now, budgetMs: Math.min(30_000, options.runBudgetMs ?? 40_000) });
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
    const rank = (owner: Row) => states.get(owner.directory) === "closed"
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
    try {
      const stat = fs.lstatSync(owner.directory, { throwIfNoEntry: false });
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || `${stat.dev}:${stat.ino}` !== owner.identity)) { outcome(owner.directory, disposition, bytes, reason); continue; }
      // Custody survives a missing namespace with zero allocation. A pending
      // quarantine retains its allocation projection until replay resolves.
      const pendingTrash = !stat && fs.existsSync(attemptTempJournalPath(owner.directory));
      bytes = stat ? await allocatedAttemptBytes(owner.directory) : pendingTrash ? owner.bytes : 0;
      if (!stat && !pendingTrash) store.measure(owner.directory, 0);
      if (stat) {
        const measured = fs.lstatSync(owner.directory, { throwIfNoEntry: false });
        if (!measured?.isDirectory() || measured.isSymbolicLink() || `${measured.dev}:${measured.ino}` !== owner.identity) { outcome(owner.directory, disposition, owner.bytes, reason); continue; }
        store.measure(owner.directory, bytes);
      }
      checkBudget();
      // An evidence hold blocks retirement, while its late files still count
      // toward pressure within this pass's existing root budget.
      if (recordedRootHeld(owner.directory)) { outcome(owner.directory, "evidence", bytes, "recorded check evidence hold"); continue; }
      let currentDirectory = owner.directory;
      let namespaceOnly = false;
      const scan = () => options.scan([owner.directory, currentDirectory]);
      const eligible = async (directory = owner.directory) => {
        currentDirectory = directory;
        checkBudget();
        if (recordedRootHeld(owner.directory)) { disposition = "evidence"; reason = "recorded check evidence hold"; return false; }
        const state = await options.state(owner, inventory);
        checkBudget();
        disposition = state === "live" ? "live" : state === "settled" && owner.retainUntilClose ? "evidence" : "held";
        reason = state === "live" ? "live lane or checkout dependency" : state === "settled" && owner.retainUntilClose
          ? "declared evidence until lane close" : `ownership ${state}`;
        const current = fs.lstatSync(directory, { throwIfNoEntry: false });
        if (!current?.isDirectory() || current.isSymbolicLink() || `${current.dev}:${current.ino}` !== owner.identity) { reason = "identity changed during authority read"; return false; }
        const settled = state === "closed" || state === "settled" && !owner.retainUntilClose
          || state === "orphan" && now() - owner.createdAt >= (options.maxAgeMs ?? 86400000);
        if (!settled) return false;
        if (!await inspectAttemptTree(directory, owner.directory)) { disposition = "evidence"; reason = "tree evidence, mount or Git boundary"; return false; }
        checkBudget();
        if (!await references(owner.directory, directory, scan())) { disposition = "live"; reason = "live process, socket, checkout link or container mount"; return false; }
        checkBudget();
        const evidence = options.mode === "dry-run" ? { current: () => true, namespaceOnly: false }
          : await preserveAttemptEvidence(directory, owner.directory, owner.identity);
        namespaceOnly = evidence.namespaceOnly;
        // Native/container observations can await I/O. Ownership must still
        // agree after them, at the same dispatch boundary.
        const authority = await options.state(owner, inventory);
        checkBudget();
        if (authority === "live") { disposition = "live"; reason = "authority became live"; }
        const final = fs.lstatSync(directory, { throwIfNoEntry: false });
        if (recordedRootHeld(owner.directory)) { disposition = "evidence"; reason = "recorded check evidence hold"; return false; }
        if (authority !== state) { reason = `authority changed from ${state} to ${authority}`; return false; }
        if (!final?.isDirectory() || final.isSymbolicLink() || `${final.dev}:${final.ino}` !== owner.identity) { reason = "identity changed after observations"; return false; }
        if (!evidence.current()) { disposition = "evidence"; reason = "evidence changed after preservation"; return false; }
        // Checkout state can change while evidence and producer authority are
        // awaited. Repeat every process/socket/container reference observation
        // at the last eligibility boundary before quarantine or removal.
        if (!await references(owner.directory, directory, scan())) {
          disposition = "live";
          reason = "live process, socket, checkout link or container mount changed during retirement";
          return false;
        }
        checkBudget();
        return true;
      };
      if (stat && !await eligible()) { outcome(owner.directory, disposition, bytes, reason); continue; }
      if (options.mode !== "dry-run") await recordRootRetirement(owner.directory, owner.identity, attemptTempJournalPath(owner.directory),
        stat ? "admitted" : "missing-unexplained", stat ? "acknowledged owned-root retirement admitted" : "missing-unexplained; no removal outcome observed");
      const result = await sweepStaleTempDirs({
        roots: [{ path: path.dirname(owner.directory), via: "" }], onlyDirectories: [owner.directory],
        eligible, maxAgeMs: 0, maxRemovals: 1, mode: options.mode, disposable: true,
        remove: directory => removeAttemptTree(directory, owner.directory, () => eligible(directory), namespaceOnly),
        measure: async () => bytes,
        // Settlement owns freshness. Preserve the full mount/Git/readability
        // inspection, including the reinspection after quarantine.
        inspect: (_directory, settings) => ({ entries: 0, newestMs: 0, hold: settings?.mounts?.length ? "mount-boundary" : null }),
        currentScan: scan, now,
      });
      report.removed += result.removed.length + (result.trashFinished ?? 0);
      report.removedBytes += result.removedBytes + (result.trashFinished ? owner.bytes : 0);
      const failures = result.errors.filter(error => !error.includes("attempt temp deferred:"));
      const deferred = result.errors.length > 0 && failures.length === 0;
      report.errors += failures.length;
      for (const error of result.errors) console.error("[attempt temp] retirement retained", error.slice(0, 1024));
      if (!result.removed.length && !result.trashFinished) outcome(owner.directory,
        deferred ? "deferred" : result.errors.length ? "failed" : disposition, bytes,
        result.errors.join("; ") || reason);
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
        if (!pending && !recordedRootHeld(owner.directory)) store.forget(owner.directory);
      }
    } catch (error) {
      if (error instanceof AttemptTempBudgetDeferred) {
        outcome(owner.directory, "deferred", bytes, error.message);
        continue;
      }
      report.errors++;
      const detail = attemptTempFailureDetail(error);
      outcome(owner.directory, "failed", bytes, detail);
      console.error("[attempt temp] root retained", detail);
    }
  }
  report.inventoryWalks = inventory.walks.length;
  report.bytes = store.bytes();
  report.unexaminedBytes = Math.max(0, report.bytes - report.outcomes.filter(row => options.mode === "dry-run" || row.disposition !== "removed").reduce((sum, row) => sum + row.bytes, 0));
  report.overCapBytes = Math.max(0, report.bytes - capBytes);
  return report;
}
