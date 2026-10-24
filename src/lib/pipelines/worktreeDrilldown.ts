import type { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { statePath } from "@/lib/configDir";
import { fsyncPath } from "@/lib/state/durableJson";
import type { SweptPipeline, WorktreeKeptReason, WorktreeSweepReport } from "./worktreeSweep";

export const WORKTREE_PAGE_SIZE = 4;
export type RetainedWorktree = {
  task: string | null;
  pipelineId: string | null;
  repository: string | null;
  checkout: string;
  reason: WorktreeKeptReason;
  bytes: number | null;
  observedAt: string | null;
};
export type WorktreePage = {
  at: string;
  mode: WorktreeSweepReport["mode"];
  total: number;
  start: number;
  rows: RetainedWorktree[];
  nextCursor: string | null;
  previousCursor: string | null;
};
type Meta = { generation: string; at: string; mode: WorktreeSweepReport["mode"]; total: number };
const file = () => statePath("worktree-drilldown.sqlite");
const CURSOR = /^([0-9a-f-]{36}):([0-9]{1,10})$/;
const timestamp = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
// Sweep imports also reach routes that Next collects under Node.
function sqliteDatabase(): typeof import("bun:sqlite").Database {
  const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
  if (!sqlite) throw new Error("The worktree drilldown requires the Bun runtime");
  return sqlite.Database;
}

function validRow(row: RetainedWorktree): boolean {
  return !!row && typeof row.checkout === "string" && !path.isAbsolute(row.checkout)
    && typeof row.reason === "string" && /^[a-z-]{1,64}$/.test(row.reason)
    && (row.task === null || typeof row.task === "string") && (row.pipelineId === null || typeof row.pipelineId === "string")
    && (row.repository === null || typeof row.repository === "string")
    && (row.bytes === null || (Number.isSafeInteger(row.bytes) && row.bytes >= 0))
    && (row.observedAt === null || timestamp(row.observedAt));
}

/** No filesystem lookup: sibling checkouts may legitimately start with ../.
 * Across volumes, prefer home-relative display, then elide the parent path. */
export function relativeCheckout(checkout: string, repository?: string): string {
  if (repository) {
    const relative = path.relative(repository, checkout);
    if (!path.isAbsolute(relative)) return relative.split(path.sep).join("/") || ".";
  }
  const home = os.homedir();
  const relative = path.relative(home, checkout);
  if (path.isAbsolute(relative)) return `…/${path.basename(checkout)}`;
  return `~/${relative.split(path.sep).join("/")}`;
}

/** One producer, the off-thread sweep. Build beside the target, close, then
 * atomically replace it; readers retain their inode and damage is replaced.
 * Failed writes keep the preceding snapshot. No request rebuilds it.
 * This separate derived database never changes the shared state-store schema. */
export function recordWorktreeDrilldown(report: WorktreeSweepReport, pipelines: readonly SweptPipeline[] = []): void {
  const target = file();
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = fs.mkdtempSync(path.join(parent, ".worktree-drilldown-"));
  const snapshot = path.join(temporary, "snapshot.sqlite");
  let db: Database | undefined;
  try {
    const Database = sqliteDatabase();
    db = new Database(snapshot, { create: true });
    const source = db;
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), generation TEXT NOT NULL, at TEXT NOT NULL, mode TEXT NOT NULL, total INTEGER NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS retained (id INTEGER PRIMARY KEY, body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) <= 65536))");
    const owners = new Map(pipelines.map(p => [p.id, p]));
    const insert = db.prepare("INSERT INTO retained (id, body) VALUES (?, ?)");
    source.transaction(() => {
      report.kept.forEach((kept, index) => {
        const owner = kept.pipelineId ? owners.get(kept.pipelineId) : undefined;
        const repository = kept.repository ?? owner?.repoDir;
        const row: RetainedWorktree = {
          task: owner?.task ?? null, pipelineId: kept.pipelineId ?? null,
          repository: repository ? path.basename(repository) : null,
          checkout: relativeCheckout(kept.path, repository),
          reason: kept.reason, bytes: kept.bytes ?? null, observedAt: kept.observedAt ?? null,
        };
        insert.run(index + 1, JSON.stringify(row));
      });
      source.prepare("INSERT INTO snapshot VALUES (1, ?, ?, ?, ?)")
        .run(randomUUID(), report.at, report.mode, report.kept.length);
    })();
    db.close(); db = undefined;
    fs.chmodSync(snapshot, 0o600);
    fsyncPath(snapshot);
    fs.renameSync(snapshot, target);
    fsyncPath(parent);
  } finally {
    try { db?.close(); }
    finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
}

export class WorktreePageError extends Error {
  constructor(public readonly status: number, public readonly code: "invalid_cursor" | "snapshot_changed" | "unavailable") { super(code); }
}

/** Primary-key seek, fixed page size, no OFFSET, COUNT, report JSON read or
 * filesystem scan. Zero busy timeout: a writer never stalls the Viewer loop.
 * The read transaction binds metadata and rows to one persisted generation. */
export function readWorktreePage(cursor: string | null): WorktreePage {
  const parsed = cursor === null ? null : CURSOR.exec(cursor);
  if (cursor !== null && (!parsed || !Number.isSafeInteger(Number(parsed[2]))))
    throw new WorktreePageError(400, "invalid_cursor");
  let db: Database | undefined;
  try {
    const Database = sqliteDatabase();
    db = new Database(file(), { readonly: true });
    db.exec("PRAGMA busy_timeout = 0");
    const source = db;
    return source.transaction(() => {
      const meta = source.query("SELECT generation, at, mode, total FROM snapshot WHERE id = 1").get() as Meta | null;
      if (!meta || !/^[0-9a-f-]{36}$/.test(meta.generation) || !timestamp(meta.at)
        || !["on", "dry-run"].includes(meta.mode) || !Number.isSafeInteger(meta.total) || meta.total < 0)
        throw new WorktreePageError(503, "unavailable");
      if (parsed && parsed[1] !== meta.generation) throw new WorktreePageError(409, "snapshot_changed");
      const start = parsed ? Number(parsed[2]) : 0;
      if (start > meta.total || start % WORKTREE_PAGE_SIZE !== 0) throw new WorktreePageError(400, "invalid_cursor");
      const records = source.query("SELECT id, body FROM retained WHERE id > ? ORDER BY id LIMIT ?").all(start, WORKTREE_PAGE_SIZE) as { id: number; body: string }[];
      if (records.length !== Math.min(WORKTREE_PAGE_SIZE, meta.total - start)) throw new WorktreePageError(503, "unavailable");
      const rows = records.map((record, index) => {
        if (record.id !== start + index + 1 || Buffer.byteLength(record.body) > 65536) throw new WorktreePageError(503, "unavailable");
        const row = JSON.parse(record.body) as RetainedWorktree;
        if (!validRow(row)) throw new WorktreePageError(503, "unavailable");
        return row;
      });
      return { at: meta.at, mode: meta.mode, total: meta.total, start, rows,
        previousCursor: start > 0 ? `${meta.generation}:${Math.max(0, start - WORKTREE_PAGE_SIZE)}` : null,
        nextCursor: start + rows.length < meta.total ? `${meta.generation}:${start + rows.length}` : null };
    })();
  } catch (error) {
    if (error instanceof WorktreePageError) throw error;
    throw new WorktreePageError(503, "unavailable");
  } finally { db?.close(); }
}
