import fs from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { statePath } from "@/lib/configDir";
import { attemptTempJournalPath, readAttemptTempTrash } from "@/lib/tempSweep";
import { readRecorded } from "@/lib/recordedChecks/store";
import { discoverAttemptCopies } from "./attemptCopyDiscovery";
import { attemptPathWatches, type AttemptMutationWatch } from "./attemptMutationFence";
import { readAttemptEvidenceBinding } from "./attemptEvidenceBinding";

type Binding = { pipelineId: string; launchId: string };
type Recovery = { directory: string; identity: string; cursor: string; binding: string | null; conflict: number; matches: string };
const same = (a: Binding, b: Binding) => a.pipelineId === b.pipelineId && a.launchId === b.launchId;

/** One journal-directory page and one candidate's manifest page per tick.
 * Directory cookies, consensus and scheduling survive helper restarts. The
 * normal retention path owns all authority, reference checks and removal. */
export class AttemptTrashRecovery {
  constructor(private db: Database, private scratch: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS trash_recovery (
      directory TEXT PRIMARY KEY, identity TEXT NOT NULL, cursor TEXT NOT NULL DEFAULT '',
      binding TEXT, conflict INTEGER NOT NULL DEFAULT 0, matches TEXT NOT NULL DEFAULT '[]',
      restored INTEGER NOT NULL DEFAULT 0, checkedAt REAL NOT NULL DEFAULT 0, turn INTEGER NOT NULL DEFAULT 0)`);
    db.exec("CREATE TABLE IF NOT EXISTS trash_recovery_scan(id INTEGER PRIMARY KEY CHECK(id=1),cursor TEXT NOT NULL,turn INTEGER NOT NULL)");
    db.exec("INSERT OR IGNORE INTO trash_recovery_scan VALUES(1,'',0)");
  }
  restored(directory: string) { return !!this.db.query("SELECT 1 FROM trash_recovery WHERE directory=?").get(directory); }
  refresh(directory: string) {
    this.db.query("UPDATE trash_recovery SET restored=0,cursor='',binding=NULL,conflict=0,matches='[]',checkedAt=0 WHERE directory=? AND restored=1").run(directory);
  }
  watches(directory: string): AttemptMutationWatch[] {
    const row = this.db.query<{ matches: string }, [string]>("SELECT matches FROM trash_recovery WHERE directory=? AND restored=1").get(directory);
    const files: string[] = row ? JSON.parse(row.matches) : [];
    const parent = statePath("evidence", "attempt-temp");
    return [...(fs.lstatSync(parent, { throwIfNoEntry: false })?.isDirectory() ? [parent] : []),
      ...attemptPathWatches([parent, ...files]), ...files.map(file => ({ file }))];
  }
  /** Revalidate the bounded proof at dispatch, including new conflicting
   * recorded roots or a changed evidence namespace after restoration. */
  current(directory: string) {
    const row = this.db.query<Recovery, [string]>("SELECT directory,identity,cursor,binding,conflict,matches FROM trash_recovery WHERE directory=? AND restored=1").get(directory);
    if (!row?.binding) return false;
    try {
      const binding: Binding = JSON.parse(row.binding), matches: string[] = JSON.parse(row.matches);
      const parent = statePath("evidence", "attempt-temp"), stat = fs.lstatSync(parent, { bigint: true, throwIfNoEntry: false });
      if (row.cursor) {
        if (!stat?.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(parent) !== parent
          || JSON.parse(row.cursor).generation !== [stat.dev, stat.ino, stat.mtimeNs, stat.ctimeNs].join(":")) return false;
      } else if (stat) return false;
      for (const file of matches) {
        if (fs.realpathSync(path.dirname(file)) !== path.dirname(file)) return false;
        const value = readAttemptEvidenceBinding(file);
        if (value.original !== directory || value.identity !== row.identity
          || value.pipelineId !== binding.pipelineId || value.launchId !== binding.launchId) return false;
      }
      const recorded = readRecorded(store => store.rootBindings(directory, row.identity), { bindings: [], read: 0, overflow: false });
      return !recorded.overflow && matches.length + recorded.bindings.length > 0 && recorded.bindings.every(value => same(binding, value));
    } catch { return false; }
  }
  forget(directory: string) { this.db.query("DELETE FROM trash_recovery WHERE directory=?").run(directory); }
  page(now: () => number, deadline: number) {
    const result = { entries: 0, manifestEntries: 0, checks: 0, restored: 0,
      outcomes: [] as Array<{ directory: string; disposition: "held" | "deferred"; bytes: number; reason: string }> };
    if (now() >= deadline) return result;
    const scan = this.db.query<{ cursor: string; turn: number }, []>("SELECT cursor,turn FROM trash_recovery_scan WHERE id=1").get()!;
    try {
      const parent = fs.lstatSync(this.scratch, { throwIfNoEntry: false });
      if (!parent) return result;
      if (!parent.isDirectory() || parent.isSymbolicLink() || fs.realpathSync(this.scratch) !== this.scratch
        || process.getuid && parent.uid !== process.getuid()) throw new Error("owner-unknown: indirect scratch parent");
      const page = discoverAttemptCopies(this.scratch, scan.cursor, now, deadline, "identity");
      result.entries = page.read;
      for (const name of page.names) {
        if (now() >= deadline) return result; // Revisit this bounded page after interruption.
        if (!/^\.delegatus-sweep-[a-f0-9]{64}\.json$/.test(name)) continue;
        const journal = readAttemptTempTrash(path.join(this.scratch, name), this.scratch);
        if (!journal) { result.outcomes.push({ directory: path.join(this.scratch, name), disposition: "held", bytes: 0, reason: "owner-unknown" }); continue; }
        if (this.db.query("SELECT 1 FROM roots WHERE directory=?").get(journal.directory)) continue;
        this.db.query(`INSERT INTO trash_recovery(directory,identity) VALUES(?,?) ON CONFLICT(directory) DO UPDATE SET
          identity=excluded.identity,cursor='',binding=NULL,conflict=0,matches='[]',restored=0,checkedAt=0
          WHERE identity<>excluded.identity`).run(journal.directory, journal.identity);
      }
      this.db.query("UPDATE trash_recovery_scan SET cursor=? WHERE id=1").run(page.done ? "" : page.cursor);
    } catch (error) {
      this.db.query("UPDATE trash_recovery_scan SET cursor='' WHERE id=1").run();
      result.outcomes.push({ directory: this.scratch, disposition: "held", bytes: 0, reason: `owner-unknown: ${String(error)}` });
      return result;
    }
    if (now() >= deadline) return result;
    const candidate = this.db.query<Recovery, [number]>(`SELECT directory,identity,cursor,binding,conflict,matches FROM trash_recovery
      WHERE restored=0 AND checkedAt<=? ORDER BY checkedAt,turn,directory LIMIT 1`).get(now());
    if (!candidate) return result;
    this.db.query("UPDATE trash_recovery_scan SET turn=turn+1 WHERE id=1").run();
    this.db.query("UPDATE trash_recovery SET turn=?,checkedAt=? WHERE directory=?").run(scan.turn + 1, now(), candidate.directory);
    const hold = (reason = "owner-unknown", pending = false) => {
      result.outcomes.push({ directory: candidate.directory, disposition: pending ? "deferred" : "held", bytes: 0, reason });
      if (!pending) this.db.query("UPDATE trash_recovery SET cursor='',binding=NULL,conflict=0,matches='[]',checkedAt=? WHERE directory=?")
        .run(now() + 60_000, candidate.directory);
      return result;
    };
    const journal = readAttemptTempTrash(attemptTempJournalPath(candidate.directory), this.scratch);
    if (!journal || journal.identity !== candidate.identity) return hold();
    let binding: Binding | null = candidate.binding ? JSON.parse(candidate.binding) : null;
    let conflict = !!candidate.conflict, matches: string[] = JSON.parse(candidate.matches);
    const offer = (value: { pipelineId?: string | null; launchId?: string | null }) => {
      if (!value.pipelineId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value.pipelineId)
        || typeof value.launchId !== "string" || !value.launchId) { conflict = true; return; }
      const next = { pipelineId: value.pipelineId, launchId: value.launchId };
      if (binding && !same(binding, next)) conflict = true;
      binding = next;
    };
    try {
      const parent = statePath("evidence", "attempt-temp");
      const stat = fs.lstatSync(parent, { throwIfNoEntry: false });
      let done = true, cursor = "";
      if (stat) {
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(parent) !== parent
          || process.getuid && stat.uid !== process.getuid()) return hold();
        const page = discoverAttemptCopies(parent, candidate.cursor, now, deadline);
        result.manifestEntries = page.read; done = page.done; cursor = page.cursor;
        // A namespace mutation invalidates every previous observation.
        const generation = (value: string) => { try { return JSON.parse(value).generation; } catch { return null; } };
        if (candidate.cursor && generation(candidate.cursor) !== generation(page.cursor)) { binding = null; conflict = false; matches = []; }
        for (const name of page.names) {
          if (now() >= deadline) return hold("owner-unknown: binding scan deferred", true);
          if (!/^[a-f0-9]{64}$/.test(name)) continue;
          const destination = path.join(parent, name), own = fs.lstatSync(destination);
          if (!own.isDirectory() || own.isSymbolicLink() || process.getuid && own.uid !== process.getuid()) return hold();
          const file = path.join(destination, "manifest.json");
          if (!fs.lstatSync(file, { throwIfNoEntry: false })) continue;
          const manifest = readAttemptEvidenceBinding(file);
          if (manifest.original !== journal.directory || manifest.identity !== journal.identity) continue;
          offer(manifest);
          if (matches.length >= 32) return hold();
          matches.push(file);
        }
      } else if (candidate.cursor) return hold(); // A vanished inventory cannot prove its earlier bindings.
      if (!done) {
        this.db.query("UPDATE trash_recovery SET cursor=?,binding=?,conflict=?,matches=? WHERE directory=?")
          .run(cursor, binding ? JSON.stringify(binding) : null, Number(conflict), JSON.stringify(matches), candidate.directory);
        return hold("owner-unknown: binding scan pending", true);
      }
      // Repeat matched headers at completion; no awaited work separates the
      // exact root/check/manifest proof from the insert of its owner row.
      for (const file of matches) {
        if (now() >= deadline) return hold("owner-unknown: binding scan deferred", true);
        if (fs.realpathSync(path.dirname(file)) !== path.dirname(file)) return hold();
        const manifest = readAttemptEvidenceBinding(file);
        if (manifest.original !== journal.directory || manifest.identity !== journal.identity) return hold();
        offer(manifest);
      }
      if (now() >= deadline) return hold("owner-unknown: binding scan deferred", true);
      const recorded = readRecorded(store => store.rootBindings(journal.directory, journal.identity), { bindings: [], read: 0, overflow: false });
      result.checks = recorded.read;
      if (recorded.overflow) return hold();
      for (const value of recorded.bindings) offer(value);
      const current = readAttemptTempTrash(attemptTempJournalPath(candidate.directory), this.scratch);
      if (conflict || !binding || !current || current.identity !== journal.identity || current.trash !== journal.trash) return hold();
      const agreed: Binding = binding;
      const existing = this.db.query<{ pipelineId: string | null; launchId: string; identity: string }, [string]>(
        "SELECT pipelineId,launchId,identity FROM roots WHERE directory=?").get(journal.directory);
      if (existing && (existing.identity !== journal.identity || existing.pipelineId !== agreed.pipelineId || existing.launchId !== agreed.launchId)) return hold();
      this.db.transaction(() => {
        const inserted = this.db.query(`INSERT OR IGNORE INTO roots(directory,pipelineId,launchId,retainUntilClose,createdAt,identity,checkedAt)
          VALUES(?,?,?,1,?,?,0)`).run(journal.directory, agreed.pipelineId, agreed.launchId, now(), journal.identity);
        this.db.query("UPDATE trash_recovery SET restored=1,cursor=?,binding=?,matches=? WHERE directory=?")
          .run(cursor, JSON.stringify(agreed), JSON.stringify(matches), journal.directory);
        if (inserted.changes) result.restored++;
      })();
      return result;
    } catch { return hold(); }
  }
}
