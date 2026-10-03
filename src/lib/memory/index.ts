import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Database as BunDatabase } from "bun:sqlite";

import { messageTextDigest } from "@/lib/runtime/messageTextDigest";
import { statePath } from "@/lib/configDir";
import { canonicalProject } from "@/lib/projects/aliases";
import { hardenedRedact } from "@/lib/view/compactText";
import { parseMemory, type MemoryKind, type MemorySource } from "./parsers";
import { nativeHookCursor, nativeOccurrenceAfter } from "./native";
import { nativeMatch, queryFor, type Candidate } from "./selection";

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
      CREATE TABLE IF NOT EXISTS memory_terminal_deliveries (
        id TEXT PRIMARY KEY, conversation TEXT, digest TEXT, origin TEXT, request TEXT, transcript TEXT, offset INTEGER
      );
      CREATE INDEX IF NOT EXISTS memory_terminal_pending ON memory_terminal_deliveries(conversation, request, digest);
      CREATE TABLE IF NOT EXISTS memory_native_turns (
        conversation TEXT, request TEXT, transcript TEXT, offset INTEGER, digest TEXT, occurrence TEXT,
        PRIMARY KEY(conversation, request), UNIQUE(conversation, occurrence)
      );
      CREATE TABLE IF NOT EXISTS memory_hook_attempts (conversation TEXT, request TEXT, PRIMARY KEY(conversation, request));
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

  search(input: { query: string; project?: string; kind?: MemoryKind; limit?: number; maxBytes?: number }) {
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
      if (Buffer.byteLength(JSON.stringify(page)) > Math.min(MEMORY_RESPONSE_BYTES, input.maxBytes ?? MEMORY_RESPONSE_BYTES)) {
        page.items.pop(); page.truncated = true; break;
      }
    }
    return page;
  }

  open(id: string, requestId: string, conversationId: string | null, project?: string, maxBytes = MEMORY_RESPONSE_BYTES) {
    const db = this.database();
    this.normalizeProjects(db);
    const canonical = project ? canonicalProject(project) : null;
    const item = db.query<MemoryItem, [string, string | null, string | null]>("SELECT * FROM memory_entries WHERE id = ? AND (? IS NULL OR project = ? OR scope = 'global')").get(id, canonical, canonical);
    if (!item) return null;
    const ledgerKey = crypto.createHash("sha256").update(`${conversationId ?? ""}\0${requestId}`).digest("hex");
    const recordOpened = () => {
      const at = new Date().toISOString();
      db.query("INSERT OR IGNORE INTO memory_offers VALUES (?, ?, ?, ?, 'search', NULL, 'opened', ?)").run(id, ledgerKey, conversationId, at, at);
      db.query("UPDATE memory_offers SET outcome = 'opened', outcome_at = ? WHERE memory_id = ? AND conversation_id = ? AND channel = 'inject' AND outcome IS NULL").run(at, id, conversationId);
    };
    const opened = { ...item, sourcePath: displayPath(item.sourcePath), flags: JSON.parse(item.flags) as string[] };
    const budget = Math.min(MEMORY_RESPONSE_BYTES, maxBytes);
    if (Buffer.byteLength(JSON.stringify({ item: opened })) <= budget) {
      recordOpened();
      return opened;
    }

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
        if (Buffer.byteLength(JSON.stringify({ item: truncated })) <= budget) {
          best = candidate;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      truncated[field] = best;
      if (Buffer.byteLength(JSON.stringify({ item: truncated })) <= budget) {
        recordOpened();
        return truncated;
      }
    }
    return null;
  }

  offers(id: string) {
    return this.database().query<{ channel: string; outcome: string; score: number | null; conversationId: string | null }, [string]>("SELECT channel, outcome, score, conversation_id AS conversationId FROM memory_offers WHERE memory_id = ? ORDER BY at").all(id);
  }

  injectionCandidates(prompt: string, project: string, engine: string, conversation: string, requestDeadline = Infinity): Candidate[] {
    // A native store can contain thousands of near matches. Optional retrieval
    // has its own short CPU budget and abandons incomplete filtering entirely.
    const deadline = Math.min(requestDeadline, performance.now() + 100);
    const check = () => { if (performance.now() >= deadline) throw Error("memory candidate budget"); };
    const query = queryFor(prompt, "recall");
    if (!query) return [];
    const db = this.database();
    db.exec("PRAGMA busy_timeout = 50");
    try {
      check();
      this.normalizeProjects(db);
      const canonical = canonicalProject(project);
      const hits = db.query<MemoryItem, [string, string, string, number]>(`SELECT e.* FROM memory_fts JOIN memory_entries e ON e.id = memory_fts.id
        WHERE memory_fts MATCH ? AND (e.project = ? OR e.scope = 'global')
          AND e.engine != ? AND e.engine != 'shared' AND e.kind != 'instruction'
        ORDER BY bm25(memory_fts, 0, 5, 2, 1), e.writtenAt DESC, e.id LIMIT 128 OFFSET ?`);
      const native: MemoryItem[] = [];
      const nativePage = db.query<MemoryItem, [string, string, string, string, number]>("SELECT * FROM memory_entries WHERE (engine = ? AND (? = 'codex' OR scope = 'global' OR project = ?)) OR (kind = 'instruction' AND (scope = 'global' OR project = ?)) ORDER BY id LIMIT 128 OFFSET ?");
      for (let offset = 0; ; offset += 128) {
        check();
        const page = nativePage.all(engine, engine, canonical, canonical, offset);
        native.push(...page);
        if (page.length < 128) break;
      }
      check();
      const offered = new Set(db.query<{ memory_id: string }, [string]>("SELECT memory_id FROM memory_offers WHERE conversation_id = ? AND channel = 'inject'").all(conversation).map(r => r.memory_id));
      const kept: MemoryItem[] = [];
      for (let offset = 0; ; offset += 128) {
        check();
        const page = hits.all(query, canonical, engine, offset);
        for (const hit of page) {
          check();
          if (hit.engine === engine || hit.engine === "shared" || hit.kind === "instruction" || offered.has(hit.id)
            || JSON.parse(hit.flags).includes("retired") || native.some(own => { check(); return nativeMatch(hit, own); })
            || kept.some(own => nativeMatch(hit, own))) continue;
          kept.push(hit);
          if (kept.length === 30) return kept;
        }
        if (page.length < 128) break;
      }
      check();
      return kept;
    } catch { return []; }
    finally { db.exec("PRAGMA busy_timeout = 5000"); }
  }

  private hookDatabase<T>(run: (db: BunDatabase) => T): T {
    const db = this.database();
    // Optional hook bookkeeping must never queue behind another writer.
    db.exec("PRAGMA busy_timeout = 0");
    try { return run(db); }
    finally { db.exec("PRAGMA busy_timeout = 5000"); }
  }

  recordTerminalDelivery(id: string, conversation: string, prompt: string, origin: string, transcript?: string | null) {
    let offset: number | null = null;
    try { if (transcript) offset = fsSync.statSync(transcript).size; } catch { /* A launch can precede its journal. */ }
    this.hookDatabase(db => db.query("INSERT OR IGNORE INTO memory_terminal_deliveries VALUES (?, ?, ?, ?, NULL, ?, ?)")
      .run(id, conversation, messageTextDigest(prompt), origin, transcript ?? null, offset));
  }

  forgetTerminalDelivery(id: string) {
    this.hookDatabase(db => db.query("DELETE FROM memory_terminal_deliveries WHERE id = ? AND request IS NULL").run(id));
  }

  terminalOrigin(conversation: string, request: string, prompt: string, transcript?: string, engine?: "claude" | "codex"): string | null {
    return this.hookDatabase(db => db.transaction(() => {
      const existing = db.query<{ origin: string }, [string, string]>("SELECT origin FROM memory_terminal_deliveries WHERE conversation = ? AND request = ?").get(conversation, request);
      if (existing) return existing.origin;
      const deliveries = db.query<{ id: string; origin: string; transcript: string | null; offset: number | null }, [string, string]>("SELECT id, origin, transcript, offset FROM memory_terminal_deliveries WHERE conversation = ? AND request IS NULL AND digest = ? ORDER BY rowid LIMIT 256").all(conversation, messageTextDigest(prompt));
      const cursor = transcript && engine ? nativeHookCursor(transcript, engine, request.slice("native:".length)) : null;
      for (const delivery of deliveries) {
        const journal = delivery.transcript ?? (delivery.id.startsWith("spawn:") ? transcript : undefined);
        if (journal && engine) {
          const journaled = nativeOccurrenceAfter(journal, engine, delivery.offset ?? 0);
          if (journaled && journaled.key !== cursor?.key) continue;
        }
        db.query("UPDATE memory_terminal_deliveries SET request = ? WHERE id = ? AND request IS NULL").run(request, delivery.id);
        return delivery.origin;
      }
      return null;
    })());
  }

  recordNativeTurn(conversation: string, request: string, transcript: string, offset: number, prompt: string) {
    this.hookDatabase(db => db.query("INSERT OR IGNORE INTO memory_native_turns VALUES (?, ?, ?, ?, ?, NULL)")
      .run(conversation, request, transcript, offset, messageTextDigest(prompt)));
  }

  nativeTurns(conversation: string, transcript: string) {
    return this.database().query<{ request: string; offset: number; digest: string; occurrence: string | null }, [string, string]>(
      "SELECT request, offset, digest, occurrence FROM memory_native_turns WHERE conversation = ? AND transcript = ? ORDER BY rowid"
    ).all(conversation, transcript);
  }

  bindNativeTurn(conversation: string, request: string, occurrence: string) {
    return this.hookDatabase(db => db.query("UPDATE OR IGNORE memory_native_turns SET occurrence = ? WHERE conversation = ? AND request = ? AND occurrence IS NULL")
      .run(occurrence, conversation, request).changes > 0);
  }

  claimHook(conversation: string, request: string) {
    return this.hookDatabase(db => db.query("INSERT OR IGNORE INTO memory_hook_attempts VALUES (?, ?)").run(conversation, request).changes === 1);
  }

  recordInjection(entries: Array<Candidate & { score: number }>, requestId: string, conversation: string) {
    this.hookDatabase(db => db.transaction(() => {
      for (const entry of entries) db.query("INSERT OR IGNORE INTO memory_offers VALUES (?, ?, ?, ?, 'inject', ?, NULL, NULL)").run(entry.id, requestId, conversation, new Date().toISOString(), entry.score);
    })());
  }

  turnOffers(conversation: string) {
    return this.database().query<{ id: string; title: string; requestId: string; score: number }, [string]>(`SELECT e.id, e.title, o.request_id AS requestId, o.score
      FROM memory_offers o JOIN memory_entries e ON e.id = o.memory_id WHERE o.conversation_id = ? AND o.channel = 'inject'
      ORDER BY o.at DESC, o.request_id DESC, o.memory_id DESC LIMIT 1000`).all(conversation).reverse();
  }

  recordCitations(conversation: string, assistantText: string) {
    this.hookDatabase(db => {
      const block = assistantText.match(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/)?.[0];
      if (!block) return;
      const citations = [...block.matchAll(/^([^<>\n]+?):(\d+)(?:-(\d+))?\|note=/gm)];
      const pending = db.query<MemoryItem, [string]>(`SELECT DISTINCT e.* FROM memory_entries e JOIN memory_offers o ON o.memory_id = e.id
        WHERE o.conversation_id = ? AND o.channel = 'inject' AND (o.outcome IS NULL OR o.outcome != 'cited')`).all(conversation);
      const sources = new Map<string, { lines: number; bullets: Map<string, Array<[number, number]>> } | null>();
      const deadline = performance.now() + 50;
      for (const memory of pending) {
        // Outcomes are optional: never spend an operator's hook budget replaying
        // old citations. Already cited offers were removed by the query above.
        if (performance.now() > deadline) break;
        const matches = citations.filter(c => memory.sourcePath === c[1] || memory.sourcePath.endsWith("/" + c[1]));
        if (!matches.length) continue;
        if (!sources.has(memory.sourcePath)) {
          let source: { lines: number; bullets: Map<string, Array<[number, number]>> } | null = null;
          try {
            if (fsSync.statSync(memory.sourcePath).size <= 4 * 1024 * 1024) {
              const lines = fsSync.readFileSync(memory.sourcePath, "utf8").split("\n");
              const bullets = new Map<string, Array<[number, number]>>();
              for (let i = 0; i < lines.length; i++) {
                if (!/^[-*] /.test(lines[i])) continue;
                const key = byteBound(hardenedRedact(lines[i].slice(2)), 400);
                let last = i;
                while (last + 1 < lines.length && /^\s+\S/.test(lines[last + 1])) last++;
                bullets.set(key, [...(bullets.get(key) ?? []), [i + 1, last + 1]]);
              }
              source = { lines: lines.length, bullets };
            }
          } catch { /* a stale or unavailable source has no cheap citation proof */ }
          sources.set(memory.sourcePath, source);
        }
        const source = sources.get(memory.sourcePath);
        if (!source) continue;
        const ranges = memory.sourceKind === "claude_memory" ? [[1, source.lines]] : source.bullets.get(memory.summary.split("\n")[0]) ?? [];
        if (!ranges.some(([first, last]) => matches.some(c => Number(c[2]) <= last && Number(c[3] ?? c[2]) >= first))) continue;
        db.query("UPDATE memory_offers SET outcome = 'cited', outcome_at = ? WHERE conversation_id = ? AND memory_id = ? AND channel = 'inject'").run(new Date().toISOString(), conversation, memory.id);
      }
    });
  }

  close() { this.db?.close(); this.db = undefined; }
}
