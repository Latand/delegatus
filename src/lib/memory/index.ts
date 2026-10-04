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

type InjectionName = Pick<Candidate, "id" | "title"> & { score: number };

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
    try {
      this.db.exec(`
        PRAGMA busy_timeout = 0;
        PRAGMA journal_mode = WAL;
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
        CREATE TABLE IF NOT EXISTS memory_terminal_occurrences (
          delivery TEXT PRIMARY KEY, conversation TEXT, transcript TEXT, occurrence TEXT, offset INTEGER,
          UNIQUE(conversation, transcript, occurrence)
        );
        CREATE INDEX IF NOT EXISTS memory_terminal_pending ON memory_terminal_deliveries(conversation, request, digest);
        CREATE TABLE IF NOT EXISTS memory_native_turns (
          conversation TEXT, request TEXT, transcript TEXT, offset INTEGER, digest TEXT, occurrence TEXT,
          PRIMARY KEY(conversation, request), UNIQUE(conversation, occurrence)
        );
        CREATE TABLE IF NOT EXISTS memory_hook_attempts (conversation TEXT, request TEXT, PRIMARY KEY(conversation, request));
      `);
      if (!this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_injection_names'").get()) {
        // Migrate once, atomically, without waiting behind a live writer. A hook
        // can abandon a contended first open and retry on a later prompt.
        this.db.transaction(() => {
          this.db!.exec(`CREATE TABLE memory_injection_names (
            memory_id TEXT NOT NULL, request_id TEXT NOT NULL, title TEXT NOT NULL,
            PRIMARY KEY (memory_id, request_id)
          );
          INSERT INTO memory_injection_names
            SELECT o.memory_id, o.request_id, e.title FROM memory_offers o JOIN memory_entries e ON e.id = o.memory_id
            WHERE o.channel = 'inject';`);
        })();
      }
      this.db.exec("PRAGMA busy_timeout = 5000");
    } catch (error) {
      this.db.close(); this.db = undefined;
      throw error;
    }
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
    this.replayConfirmedInjections();
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

  private terminalFallback(id: string) {
    return path.join(statePath("memory-terminal-pending"), crypto.createHash("sha256").update(id).digest("hex") + ".json");
  }

  private replayTerminalDeliveries(db: BunDatabase) {
    const directory = statePath("memory-terminal-pending");
    let files: string[];
    try { files = fsSync.readdirSync(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    // An incomplete replay cannot establish operator authorship. Fail open
    // without memory if evidence exceeds the optional bookkeeping budget.
    if (files.length > 256) throw Error("memory receipt replay budget");
    const deadline = performance.now() + 100;
    for (const name of files) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      if (performance.now() >= deadline) throw Error("memory receipt replay budget");
      const filename = path.join(directory, name);
      const stat = fsSync.lstatSync(filename);
      if (!stat.isFile() || stat.size > 16000) throw Error("invalid memory receipt evidence");
      const row = JSON.parse(fsSync.readFileSync(filename, "utf8"));
      if (typeof row.id !== "string" || this.terminalFallback(row.id) !== filename
        || typeof row.conversation !== "string" || !/^[a-f0-9]{64}$/.test(row.digest)
        || typeof row.origin !== "string" || !(row.transcript === null || typeof row.transcript === "string")
        || !(row.offset === null || Number.isSafeInteger(row.offset) && row.offset >= 0)) throw Error("invalid memory receipt evidence");
      db.query("INSERT OR IGNORE INTO memory_terminal_deliveries VALUES (?, ?, ?, ?, NULL, ?, ?)")
        .run(row.id, row.conversation, row.digest, row.origin, row.transcript, row.offset);
      fsSync.unlinkSync(filename);
    }
  }

  recordTerminalDelivery(id: string, conversation: string, prompt: string, origin: string, transcript?: string | null) {
    let offset: number | null = null;
    try { if (transcript) offset = fsSync.statSync(transcript).size; } catch { /* A launch can precede its journal. */ }
    const digest = messageTextDigest(prompt);
    try {
      this.hookDatabase(db => db.query("INSERT OR IGNORE INTO memory_terminal_deliveries VALUES (?, ?, ?, ?, NULL, ?, ?)")
        .run(id, conversation, digest, origin, transcript ?? null, offset));
    } catch (error) {
      // Authorship is required even when the rebuildable SQLite derivative is
      // contended. A private digest-only receipt survives process/release reload.
      const filename = this.terminalFallback(id);
      fsSync.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
      const temporary = filename + "." + crypto.randomUUID() + ".tmp";
      try {
        fsSync.writeFileSync(temporary, JSON.stringify({ id, conversation, digest, origin, transcript: transcript ?? null, offset }), { mode: 0o600 });
        fsSync.renameSync(temporary, filename);
      } finally { fsSync.rmSync(temporary, { force: true }); }
      throw error;
    }
  }

  hasTerminalDelivery(id: string): boolean {
    return this.hookDatabase(db => {
      this.replayTerminalDeliveries(db);
      return !!db.query("SELECT 1 FROM memory_terminal_deliveries WHERE id = ?").get(id);
    });
  }

  hasTerminalPrompt(conversation: string, prompt: string): boolean {
    return this.hookDatabase(db => !!db.query("SELECT 1 FROM memory_terminal_deliveries WHERE conversation = ? AND digest = ?")
      .get(conversation, messageTextDigest(prompt)));
  }

  forgetTerminalDelivery(id: string) {
    fsSync.rmSync(this.terminalFallback(id), { force: true });
    this.hookDatabase(db => db.query("DELETE FROM memory_terminal_deliveries WHERE id = ? AND request IS NULL").run(id));
  }

  private terminalOccurrences(db: BunDatabase, filename: string, engine: "claude" | "codex", conversation?: string) {
    const deadline = performance.now() + 100;
    const bound = db.query<{ delivery: string; occurrence: string }, [string]>("SELECT delivery, occurrence FROM memory_terminal_occurrences WHERE transcript = ?").all(filename);
    const seen = new Set(bound.map(row => row.occurrence)), joined = new Set(bound.map(row => row.delivery));
    // A prior operator hook can finish before its journal append. Resolve its
    // native id first so identical words cannot transfer its row to a receipt.
    const nativeTurns = db.query<{ request: string; digest: string; occurrence: string | null }, [string, string | null]>(
      "SELECT request, digest, occurrence FROM memory_native_turns WHERE transcript = ? OR (transcript = '' AND conversation = ?) ORDER BY rowid DESC LIMIT 256"
    ).all(filename, conversation ?? null);
    for (const turn of nativeTurns) {
      if (performance.now() >= deadline) throw Error("memory occurrence join budget");
      if (turn.occurrence) { seen.add(turn.occurrence); continue; }
      const cursor = nativeHookCursor(filename, engine, turn.request.slice("native:".length));
      if (cursor.key && cursor.digest === turn.digest) seen.add(cursor.key);
    }
    const receipts = db.query<{ id: string; conversation: string; digest: string; origin: string; request: string | null; offset: number | null }, [string, string | null]>(
      "SELECT id, conversation, digest, origin, request, offset FROM memory_terminal_deliveries WHERE transcript = ? OR (transcript IS NULL AND conversation = ?) ORDER BY rowid DESC LIMIT 256"
    ).all(filename, conversation ?? null).reverse();
    for (const receipt of receipts) {
      if (joined.has(receipt.id) || !receipt.request && receipt.origin !== "operator") continue;
      if (performance.now() >= deadline) throw Error("memory occurrence join budget");
      const cursor = receipt.request ? nativeHookCursor(filename, engine, receipt.request.slice("native:".length)) : null;
      const occurrence = cursor?.key && cursor.digest === receipt.digest && !seen.has(cursor.key) ? cursor
        : nativeOccurrenceAfter(filename, engine, receipt.offset ?? 0, receipt.digest, seen);
      if (!occurrence?.key) continue;
      if (!receipt.request && nativeOccurrenceAfter(filename, engine, receipt.offset ?? 0, receipt.digest, new Set([...seen, occurrence.key]))) continue;
      db.query("INSERT OR IGNORE INTO memory_terminal_occurrences VALUES (?, ?, ?, ?, ?)")
        .run(receipt.id, receipt.conversation, filename, occurrence.key, occurrence.offset);
      seen.add(occurrence.key);
    }
    return seen;
  }

  terminalContextOrigins(filename: string, engine: "claude" | "codex", conversation?: string) {
    return this.hookDatabase(db => {
      this.replayTerminalDeliveries(db);
      const owned = this.terminalOccurrences(db, filename, engine, conversation);
      const origins = new Map(db.query<{ offset: number; origin: string }, [string]>(`SELECT o.offset, d.origin FROM memory_terminal_occurrences o
        JOIN memory_terminal_deliveries d ON d.id = o.delivery WHERE o.transcript = ?`).all(filename).map(row => [row.offset, row.origin]));
      const pending = db.query<{ digest: string; offset: number | null }, [string, string | null]>(
        "SELECT digest, offset FROM memory_terminal_deliveries WHERE origin != 'operator' AND (transcript = ? OR (transcript IS NULL AND conversation = ?)) ORDER BY rowid DESC LIMIT 256"
      ).all(filename, conversation ?? null);
      const deadline = performance.now() + 100;
      for (const receipt of pending) for (let count = 0; ; count++) {
        if (count >= 256 || performance.now() >= deadline) throw Error("memory context authorship budget");
        const occurrence = nativeOccurrenceAfter(filename, engine, receipt.offset ?? 0, receipt.digest, owned);
        if (!occurrence) break;
        // Every indistinguishable row stays unknown, including the actual
        // machine row. Positive native operator ownership is excluded above.
        origins.set(occurrence.offset, "unknown"); owned.add(occurrence.key);
      }
      return origins;
    });
  }

  terminalOrigin(conversation: string, request: string, prompt: string, transcript?: string, engine?: "claude" | "codex"): string | null {
    return this.hookDatabase(db => {
      // Replay before the binding transaction: a receipt file is removed only
      // after its independent SQLite insert committed successfully.
      this.replayTerminalDeliveries(db);
      const owned = transcript && engine ? this.terminalOccurrences(db, transcript, engine, conversation) : new Set<string>();
      return db.transaction(() => {
        const existing = db.query<{ origin: string }, [string, string]>("SELECT origin FROM memory_terminal_deliveries WHERE conversation = ? AND request = ?").get(conversation, request);
        if (existing) return existing.origin;
        const digest = messageTextDigest(prompt);
        const operator = db.query("SELECT 1 FROM memory_native_turns WHERE conversation = ? AND request = ? AND digest = ?").get(conversation, request, digest);
        if (operator) return "operator";
        // Offset and equal text cannot distinguish an earlier queued operator
        // from the machine submission. Preserve the receipt instead of letting
        // either occurrence consume the other's authorship evidence.
        if (db.query("SELECT 1 FROM memory_terminal_deliveries WHERE conversation = ? AND digest = ? AND origin != 'operator'").get(conversation, digest)) return "unknown";
        const deliveries = db.query<{ id: string; origin: string; transcript: string | null; offset: number | null }, [string, string]>("SELECT id, origin, transcript, offset FROM memory_terminal_deliveries WHERE conversation = ? AND request IS NULL AND digest = ? ORDER BY rowid LIMIT 256").all(conversation, messageTextDigest(prompt));
        const cursor = transcript && engine ? nativeHookCursor(transcript, engine, request.slice("native:".length)) : null;
        for (const delivery of deliveries) {
          const journal = delivery.transcript ?? (delivery.id.startsWith("spawn:") ? transcript : undefined);
          if (journal && engine) {
            const joined = db.query<{ key: string; offset: number }, [string]>("SELECT occurrence AS key, offset FROM memory_terminal_occurrences WHERE delivery = ?").get(delivery.id);
            const seen = journal === transcript ? owned : this.terminalOccurrences(db, journal, engine, conversation);
            const journaled = joined ?? nativeOccurrenceAfter(journal, engine, delivery.offset ?? 0, messageTextDigest(prompt), seen);
            // No receipt-to-row identity can be inferred from repeated words.
            // Keep the receipt pending until native ownership disambiguates it.
            if (!joined && journaled && nativeOccurrenceAfter(journal, engine, delivery.offset ?? 0, messageTextDigest(prompt), new Set([...seen, journaled.key]))) return "unknown";
            if (journaled && journaled.key !== cursor?.key) {
              // A digest-only join cannot prove that the pending receipt owns
              // an earlier row, especially when the current hook has not yet
              // journaled. Preserve the receipt and abstain until ownership is
              // established, including when an earlier optional hook failed.
              return "unknown";
            }
          }
          db.query("UPDATE memory_terminal_deliveries SET request = ? WHERE id = ? AND request IS NULL").run(request, delivery.id);
          return delivery.origin;
        }
        return null;
      })();
    });
  }

  recordNativeTurn(conversation: string, request: string, transcript: string, offset: number, prompt: string) {
    this.hookDatabase(db => db.query("INSERT OR IGNORE INTO memory_native_turns VALUES (?, ?, ?, ?, ?, NULL)")
      .run(conversation, request, transcript, offset, messageTextDigest(prompt)));
  }

  nativeTurns(conversation: string, transcript: string) {
    return this.database().query<{ request: string; offset: number; digest: string; occurrence: string | null }, [string, string]>(
      "SELECT request, offset, digest, occurrence FROM memory_native_turns WHERE conversation = ? AND (transcript = ? OR transcript = '') ORDER BY rowid"
    ).all(conversation, transcript);
  }

  bindNativeTurn(conversation: string, request: string, occurrence: string) {
    return this.hookDatabase(db => db.query("UPDATE OR IGNORE memory_native_turns SET occurrence = ? WHERE conversation = ? AND request = ? AND occurrence IS NULL")
      .run(occurrence, conversation, request).changes > 0);
  }

  claimHook(conversation: string, request: string) {
    return this.hookDatabase(db => db.query("INSERT OR IGNORE INTO memory_hook_attempts VALUES (?, ?)").run(conversation, request).changes === 1);
  }

  recordInjection(entries: Array<Pick<Candidate, "id" | "title"> & { score: number }>, requestId: string, conversation: string) {
    this.hookDatabase(db => db.transaction(() => {
      for (const entry of entries) {
        db.query("INSERT OR IGNORE INTO memory_offers VALUES (?, ?, ?, ?, 'inject', ?, NULL, NULL)").run(entry.id, requestId, conversation, new Date().toISOString(), entry.score);
        // A historical offer keeps its name when the derivative is refreshed.
        db.query("INSERT OR IGNORE INTO memory_injection_names VALUES (?, ?, ?)").run(entry.id, requestId, entry.title);
      }
    })());
  }

  private preparedInjectionPath(conversation: string, hookId: string) {
    return path.join(statePath("memory-injection-prepared"), crypto.createHash("sha256").update(JSON.stringify([conversation, hookId])).digest("hex") + ".json");
  }

  recordPreparedInjection(entries: InjectionName[], requestId: string, conversation: string, hookId: string, expires: number) {
    const filename = this.preparedInjectionPath(conversation, hookId), directory = path.dirname(filename);
    fsSync.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const names = fsSync.readdirSync(directory);
    if (names.length > 1024) throw Error("memory prepared evidence budget");
    const deadline = performance.now() + 100;
    let retained = 0;
    for (const name of names) {
      if (performance.now() >= deadline) throw Error("memory prepared evidence budget");
      const old = path.join(directory, name), stat = fsSync.lstatSync(old);
      if (/^[a-f0-9]{64}\.json$/.test(name) && stat.isFile() && stat.mtimeMs < Date.now() - 31500) fsSync.rmSync(old);
      else retained++;
    }
    if (retained >= 1024) throw Error("memory prepared evidence budget");
    const evidence = JSON.stringify({ requestId, conversation, preparedAt: Date.now(), expires, retainUntil: expires + 30000,
      entries: entries.map(({ id, title, score }) => ({ id, title, score })) });
    const temporary = filename + "." + crypto.randomUUID() + ".tmp";
    try {
      fsSync.writeFileSync(temporary, evidence, { mode: 0o600 });
      fsSync.renameSync(temporary, filename);
    } finally { fsSync.rmSync(temporary, { force: true }); }
  }

  confirmPreparedInjection(conversation: string, hookId: string, emittedAt: number) {
    const filename = this.preparedInjectionPath(conversation, hookId);
    let stat: fsSync.Stats;
    try { stat = fsSync.lstatSync(filename); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (!stat.isFile() || stat.size > 128000) throw Error("invalid memory prepared evidence");
    const row = JSON.parse(fsSync.readFileSync(filename, "utf8"));
    if (row.conversation !== conversation || typeof row.requestId !== "string"
      || !Number.isFinite(row.preparedAt) || !Number.isFinite(row.expires) || row.retainUntil !== row.expires + 30000
      || !Array.isArray(row.entries) || row.entries.length > 15
      || row.entries.some((entry: InjectionName) => !entry || typeof entry.id !== "string" || typeof entry.title !== "string"
        || !Number.isFinite(entry.score) || entry.score < .7 || entry.score > 1)) throw Error("invalid memory prepared evidence");
    if (Date.now() >= row.retainUntil) { fsSync.rmSync(filename); return; }
    if (!Number.isFinite(emittedAt) || emittedAt < row.preparedAt || emittedAt >= row.expires) return;
    this.recordConfirmedInjection(row.entries, row.requestId, conversation);
    // Confirmation is now durable independently of the Viewer generation.
    fsSync.rmSync(filename, { force: true });
  }

  recordConfirmedInjection(entries: InjectionName[], requestId: string, conversation: string) {
    const evidence = JSON.stringify({ requestId, conversation, entries: entries.map(({ id, title, score }) => ({ id, title, score })) });
    const directory = statePath("memory-injection-pending");
    const filename = path.join(directory, crypto.createHash("sha256").update(JSON.stringify([conversation, requestId])).digest("hex") + ".json");
    fsSync.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = filename + "." + crypto.randomUUID() + ".tmp";
    try {
      fsSync.writeFileSync(temporary, evidence, { mode: 0o600 });
      fsSync.renameSync(temporary, filename);
    } finally { fsSync.rmSync(temporary, { force: true }); }
    // Confirmation is a delivery fact even when the derivative has a writer.
    // Preserve only scored names, never the prompt, body or credentials.
    try { this.replayConfirmedInjections(); } catch { /* durable evidence is retried on the next ledger read */ }
  }

  private replayConfirmedInjections() {
    const directory = statePath("memory-injection-pending");
    let names: string[];
    try { names = fsSync.readdirSync(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (names.length > 256) throw Error("memory confirmation replay budget");
    const deadline = performance.now() + 100;
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      if (performance.now() >= deadline) throw Error("memory confirmation replay budget");
      const filename = path.join(directory, name), stat = fsSync.lstatSync(filename);
      if (!stat.isFile() || stat.size > 128000) throw Error("invalid memory confirmation evidence");
      const row = JSON.parse(fsSync.readFileSync(filename, "utf8"));
      if (typeof row.requestId !== "string" || typeof row.conversation !== "string"
        || crypto.createHash("sha256").update(JSON.stringify([row.conversation, row.requestId])).digest("hex") + ".json" !== name
        || !Array.isArray(row.entries) || row.entries.length > 15
        || row.entries.some((entry: { id: unknown; title: unknown; score: unknown }) => !entry || typeof entry.id !== "string"
          || typeof entry.title !== "string" || typeof entry.score !== "number" || !Number.isFinite(entry.score) || entry.score < .7 || entry.score > 1)) throw Error("invalid memory confirmation evidence");
      this.recordInjection(row.entries, row.requestId, row.conversation);
      // Removal follows the committed idempotent inserts. A retry after reload
      // or a duplicate confirmation keeps precisely one row and its first name.
      fsSync.rmSync(filename, { force: true });
    }
  }

  turnOffers(conversation: string) {
    this.replayConfirmedInjections();
    return this.database().query<{ id: string; title: string; requestId: string; score: number }, [string]>(`SELECT o.memory_id AS id, COALESCE(n.title, e.title, o.memory_id) AS title, o.request_id AS requestId, o.score
      FROM memory_offers o LEFT JOIN memory_injection_names n ON n.memory_id = o.memory_id AND n.request_id = o.request_id
      LEFT JOIN memory_entries e ON e.id = o.memory_id WHERE o.conversation_id = ? AND o.channel = 'inject'
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
