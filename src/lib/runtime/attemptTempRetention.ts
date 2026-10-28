import fs from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { statePath } from "@/lib/configDir";
import { declaredIndexes } from "@/lib/state/declaredIndexes";
import { withFileTransactionAsync } from "@/lib/state/fileTransaction";
import { attemptTempJournalPath, sweepStaleTempDirs, type ProcessScan } from "@/lib/tempSweep";
import { allocatedAttemptBytes, attemptReferencesClear, inspectAttemptTree, removeAttemptTree, RepositoryLinkInventory } from "./attemptTempFilesystem";

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
  release(directory: string) { this.db.query("UPDATE roots SET released=1,checkedAt=0 WHERE directory=?").run(directory); }
  due(now: number, limit: number): Row[] {
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
  state: (owner: AttemptTempOwner) => Promise<AttemptTempState>;
  scan: (directories: readonly string[]) => ProcessScan;
  references?: (original: string, current: string, scan: ProcessScan) => Promise<boolean>;
  maxRoots?: number;
  maxAgeMs?: number;
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
  const adoption = store.adopt(now());
  const capBytes = options.capBytes ?? DEFAULT_ATTEMPT_TEMP_CAP_BYTES;
  const report = { adopted: adoption.adopted, checked: 0, removed: 0, removedBytes: 0, held: 0, liveHeldBytes: 0, errors: adoption.errors, bytes: store.bytes(), capBytes, overCapBytes: 0 };
  const budget = Math.max(1, Math.min(32, options.maxRoots ?? (store.bytes() > capBytes ? 32 : 4)));
  const inventory = new RepositoryLinkInventory({ now });
  const references = options.references
    ?? ((original: string, current: string, scan: ProcessScan) => attemptReferencesClear(original, current, scan, undefined, inventory));
  for (const owner of store.due(now(), budget)) {
    report.checked++;
    // Persist fairness before the first await; a killed helper resumes elsewhere.
    store.defer(owner.directory, now() + 60_000);
    try {
      const stat = fs.lstatSync(owner.directory, { throwIfNoEntry: false });
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || `${stat.dev}:${stat.ino}` !== owner.identity)) { report.held++; continue; }
      const bytes = stat ? await allocatedAttemptBytes(owner.directory) : owner.bytes;
      if (stat) store.measure(owner.directory, bytes);
      let currentDirectory = owner.directory;
      let liveHold = false;
      const scan = () => options.scan([owner.directory, currentDirectory]);
      const eligible = async (directory = owner.directory) => {
        currentDirectory = directory;
        const state = await options.state(owner);
        if (state === "live") liveHold = true;
        const current = fs.lstatSync(directory, { throwIfNoEntry: false });
        if (!current?.isDirectory() || current.isSymbolicLink() || `${current.dev}:${current.ino}` !== owner.identity) return false;
        const settled = state === "closed" || state === "settled" && !owner.retainUntilClose
          || state === "orphan" && now() - owner.createdAt >= (options.maxAgeMs ?? 86400000);
        if (!settled || !await inspectAttemptTree(directory, owner.directory)) return false;
        if (!await references(owner.directory, directory, scan())) { liveHold = true; return false; }
        // Native/container observations can await I/O. Ownership must still
        // agree after them, at the same dispatch boundary.
        const authority = await options.state(owner);
        const final = fs.lstatSync(directory, { throwIfNoEntry: false });
        return authority === state && !!final?.isDirectory() && !final.isSymbolicLink()
          && `${final.dev}:${final.ino}` === owner.identity;
      };
      if (stat && !await eligible()) { report.held++; if (liveHold) report.liveHeldBytes += bytes; continue; }
      const result = await sweepStaleTempDirs({
        roots: [{ path: path.dirname(owner.directory), via: "" }], onlyDirectories: [owner.directory],
        eligible, maxAgeMs: 0, maxRemovals: 1, mode: options.mode, disposable: true,
        remove: directory => removeAttemptTree(directory, owner.directory, () => eligible(directory)),
        measure: async () => bytes,
        // Settlement owns freshness. Preserve the full mount/Git/readability
        // inspection, including the reinspection after quarantine.
        inspect: (_directory, settings) => ({ entries: 0, newestMs: 0, hold: settings?.mounts?.length ? "mount-boundary" : null }),
        currentScan: scan, now,
      });
      report.removed += result.removed.length + (result.trashFinished ?? 0);
      report.removedBytes += result.removedBytes + (result.trashFinished ? owner.bytes : 0);
      report.errors += result.errors.length;
      for (const error of result.errors) console.error("[attempt temp] retirement retained", error.slice(0, 1024));
      if (!result.removed.length && !result.trashFinished) { report.held++; if (liveHold) report.liveHeldBytes += bytes; }
      if ((result.removed.length || result.trashFinished) && options.mode !== "dry-run") {
        store.forget(owner.directory);
        options.onRetired?.(result.removed.length + (result.trashFinished ?? 0), result.removedBytes + (result.trashFinished ? owner.bytes : 0));
      }
      // A process may have died before starting quarantine. A missing original
      // with no recoverable intent can be forgotten only after replay ran.
      if (!stat && !result.errors.length && !result.trashFinished) {
        const pending = fs.existsSync(attemptTempJournalPath(owner.directory));
        if (!pending) store.forget(owner.directory);
      }
    } catch (error) {
      report.errors++;
      const detail = (error as { stderr?: string })?.stderr || (error instanceof Error ? error.message : "unknown");
      console.error("[attempt temp] root retained", detail.slice(0, 512));
    }
  }
  report.bytes = store.bytes();
  report.overCapBytes = Math.max(0, report.bytes - capBytes);
  return report;
}
