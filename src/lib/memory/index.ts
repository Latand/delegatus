import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Database as BunDatabase } from "bun:sqlite";

import { statePath } from "@/lib/configDir";
import { canonicalProject } from "@/lib/projects/aliases";
import { hardenedRedact } from "@/lib/view/compactText";
import { parseMemory, type MemoryKind, type MemorySource } from "./parsers";

interface MemoryItem {
  id: string;
  engine: MemorySource["engine"];
  kind: MemoryKind;
  scope: "project" | "global";
  project: string | null;
  sourcePath: string;
  sourceKind: MemorySource["sourceKind"];
  title: string;
  summary: string;
  body: string;
  writtenAt: string;
  flags: string;
}

export const MEMORY_RESPONSE_BYTES = 16_000;

function byteBound(text: string, limit: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  // Decode whole Unicode code points, without a replacement character at the cut.
  return new TextDecoder("utf8", { fatal: false }).decode(bytes.subarray(0, limit)).replace(/\uFFFD$/, "");
}

function displayPath(filename: string): string {
  const home = os.homedir();
  return filename.startsWith(home + path.sep) ? "$HOME/" + path.relative(home, filename) : filename;
}

/** A rebuildable, private derivative. Every source is opened read-only. */
export class MemoryIndex {
  private db?: BunDatabase;

  private normalizeProjects(db: BunDatabase) {
    // Project succession can change independently of the source file's timestamp.
    const projects = db.query<{ project: string }, []>("SELECT DISTINCT project FROM memory_entries WHERE project IS NOT NULL").all();
    for (const { project } of projects) {
      const canonical = canonicalProject(project);
      if (canonical !== project) db.query("UPDATE memory_entries SET project = ? WHERE project = ?").run(canonical, project);
    }
  }

  private removeSource(filename: string) {
    const db = this.database();
    db.query("DELETE FROM memory_fts WHERE id IN (SELECT id FROM memory_entries WHERE sourcePath = ?)").run(filename);
    db.query("DELETE FROM memory_entries WHERE sourcePath = ?").run(filename);
    db.query("DELETE FROM memory_files WHERE path = ?").run(filename);
  }

  private database(): BunDatabase {
    if (this.db) return this.db;
    const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
    if (!sqlite) throw new Error("Memory search requires the Bun runtime");
    const filename = statePath("memory-index.sqlite");
    // The state resolver owns the directory; this module never claims live state.
    fsSync.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new sqlite.Database(filename, { create: true });
    fsSync.chmodSync(filename, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS memory_files (path TEXT PRIMARY KEY, identity TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY, engine TEXT, kind TEXT, scope TEXT, project TEXT,
        sourcePath TEXT, sourceKind TEXT, title TEXT, summary TEXT, body TEXT, writtenAt TEXT, flags TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED, title, summary, body);
      CREATE TABLE IF NOT EXISTS memory_offers (
        memory_id TEXT NOT NULL, request_id TEXT NOT NULL, conversation_id TEXT,
        at TEXT NOT NULL, channel TEXT NOT NULL, score REAL, outcome TEXT, outcome_at TEXT,
        PRIMARY KEY (memory_id, request_id)
      );
    `);
    return this.db;
  }

  async refresh(sources: readonly MemorySource[], options: { complete?: boolean } = {}) {
    const db = this.database();
    this.normalizeProjects(db);
    const result = { filesRead: 0, filesSkipped: 0, entriesIndexed: 0, filesFailed: 0 };
    for (const source of sources) {
      try {
        const stat = await fs.stat(source.path);
        if (!stat.isFile() || stat.size > 4 * 1024 * 1024) {
          db.transaction(() => this.removeSource(source.path))();
          result.filesSkipped++; continue;
        }
        const identity = JSON.stringify([stat.size, stat.mtimeMs, stat.ctimeMs, source.project, source.sourceKind, source.engine]);
        const previous = db.query<{ identity: string }, [string]>("SELECT identity FROM memory_files WHERE path = ?").get(source.path);
        if (previous?.identity === identity) { result.filesSkipped++; continue; }
        const content = await fs.readFile(source.path, "utf8");
        const after = await fs.stat(source.path);
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) { result.filesFailed++; continue; }
        result.filesRead++;
        const entries = [...new Map(parseMemory(source, content).map(entry => [entry.anchor, entry])).values()];
        db.transaction(() => {
          this.removeSource(source.path);
          for (const entry of entries) {
            const id = "m_" + crypto.createHash("sha256").update(`${source.engine}\0${source.path}\0${entry.anchor}`).digest("hex").slice(0, 24);
            const clean = (text: string, limit: number) => byteBound(hardenedRedact(text), limit);
            const title = clean(entry.title, 160), summary = clean(entry.summary, 400), body = clean(entry.body, 2048);
            const redacted = [entry.title, entry.summary, entry.body].some(text => hardenedRedact(text) !== text);
            const date = entry.writtenAt ? Date.parse(entry.writtenAt) : NaN;
            db.query("INSERT INTO memory_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, source.engine, entry.kind, entry.project ? "project" : "global", entry.project ? canonicalProject(entry.project) : null, source.path, source.sourceKind, title, summary, body, Number.isFinite(date) ? new Date(date).toISOString() : stat.mtime.toISOString(), JSON.stringify(redacted ? ["redacted_secret"] : []));
            db.query("INSERT INTO memory_fts VALUES (?, ?, ?, ?)").run(id, title, summary, body);
          }
          db.query("INSERT OR REPLACE INTO memory_files VALUES (?, ?)").run(source.path, identity);
        })();
        result.entriesIndexed += entries.length;
        if (!entries.length) result.filesSkipped++;
      } catch { result.filesFailed++; } // Counts only: paths and personal content never enter logs.
    }
    if (options.complete && !result.filesFailed) {
      // Only absent source files leave the derivative. Disuse never removes anything.
      const listed = new Set(sources.map(source => source.path));
      db.transaction(() => {
        for (const row of db.query<{ path: string }, []>("SELECT path FROM memory_files").all()) {
          if (listed.has(row.path)) continue;
          this.removeSource(row.path);
        }
      })();
    }
    return result;
  }

  search(input: { query: string; project?: string; kind?: MemoryKind; limit?: number }) {
    const terms = input.query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 16) ?? [];
    if (!terms.length) return { items: [], truncated: false };
    const db = this.database();
    this.normalizeProjects(db);
    const items = db.query<MemoryItem, [string, string | null, string | null, string | null, string | null, number]>(`
      SELECT e.*, bm25(memory_fts, 0, 5, 2, 1) AS score FROM memory_fts JOIN memory_entries e ON e.id = memory_fts.id
      WHERE memory_fts MATCH ? AND (? IS NULL OR e.project = ? OR e.scope = 'global')
        AND (? IS NULL OR e.kind = ?)
      ORDER BY bm25(memory_fts, 0, 5, 2, 1), e.writtenAt DESC, e.id LIMIT ?
    `).all(terms.map(term => `"${term}"`).join(" AND "), input.project ? canonicalProject(input.project) : null, input.project ? canonicalProject(input.project) : null, input.kind ?? null, input.kind ?? null, Math.max(1, Math.min(20, input.limit ?? 10)));
    const page = { items: [] as Array<Omit<MemoryItem, "body" | "flags"> & { flags: string[] }>, truncated: false };
    for (const item of items) {
      const hit = {
        id: item.id, engine: item.engine, kind: item.kind, scope: item.scope, project: item.project,
        sourcePath: displayPath(item.sourcePath), sourceKind: item.sourceKind,
        title: item.title, summary: item.summary, writtenAt: item.writtenAt,
        flags: JSON.parse(item.flags) as string[],
      };
      page.items.push(hit);
      if (Buffer.byteLength(JSON.stringify(page)) > MEMORY_RESPONSE_BYTES) {
        page.items.pop(); page.truncated = true; break;
      }
    }
    return page;
  }

  open(id: string, requestId: string, conversationId: string | null, project?: string) {
    const db = this.database();
    this.normalizeProjects(db);
    const canonical = project ? canonicalProject(project) : null;
    const item = db.query<MemoryItem, [string, string | null, string | null]>("SELECT * FROM memory_entries WHERE id = ? AND (? IS NULL OR project = ? OR scope = 'global')").get(id, canonical, canonical);
    if (!item) return null;
    const at = new Date().toISOString();
    const ledgerKey = crypto.createHash("sha256").update(`${conversationId ?? ""}\0${requestId}`).digest("hex");
    db.query("INSERT OR IGNORE INTO memory_offers VALUES (?, ?, ?, ?, 'search', NULL, 'opened', ?)").run(id, ledgerKey, conversationId, at, at);
    const opened = { ...item, sourcePath: displayPath(item.sourcePath), flags: JSON.parse(item.flags) as string[] };
    if (Buffer.byteLength(JSON.stringify({ item: opened })) <= MEMORY_RESPONSE_BYTES) return opened;

    // Raw UTF-8 caps do not bound JSON: control characters expand to six bytes
    // when serialized. Keep the source pointer intact and trim the least
    // essential text first until the complete route response fits its budget.
    const truncated = { ...opened, truncated: true };
    for (const field of ["body", "summary", "title"] as const) {
      const original = truncated[field];
      let low = 0;
      let high = Buffer.byteLength(original);
      let best = "";
      truncated[field] = best;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = byteBound(original, middle);
        truncated[field] = candidate;
        if (Buffer.byteLength(JSON.stringify({ item: truncated })) <= MEMORY_RESPONSE_BYTES) {
          best = candidate;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      truncated[field] = best;
      if (Buffer.byteLength(JSON.stringify({ item: truncated })) <= MEMORY_RESPONSE_BYTES) return truncated;
    }
    return truncated;
  }

  offers(id: string) {
    return this.database().query<{ channel: string; outcome: string; conversationId: string | null }, [string]>("SELECT channel, outcome, conversation_id AS conversationId FROM memory_offers WHERE memory_id = ? ORDER BY at").all(id);
  }

  close() { this.db?.close(); this.db = undefined; }
}
