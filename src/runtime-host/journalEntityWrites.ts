import { assertStateStartupMutation, mayRunStateStartupMutation } from "@/lib/stateOwnership";
import type { Database } from "bun:sqlite";
import path from "node:path";

/* Two companions of the entities table, kept by triggers that live in the
   database file, so they fire for every connection that writes it: this
   release, an older release during succession or rollback, and raw SQL.

   entity_write_ticks names the newest write of each entity row. AUTOINCREMENT
   never hands out a tick twice, so a row rewritten, or deleted and inserted
   again with its old id, revision and checkpoint_seq, always carries a tick
   greater than any a reader has seen. A snapshot reader evicts exactly the
   rows whose tick moved past the last one it read (#3803).

   session_live_handoffs holds the live-turn body of a session whose turn is
   no longer running. The session row itself stores no body, so a snapshot
   rebuild never reads or parses it; the journal's own session reads put it
   back, which keeps the #626 bridge that carries rows not yet echoed by the
   transcript into the next turn.

   A release older than the handoff reads only the row, so it must find the
   body there before it reads. Every journal write of every release inserts
   its event first and projects the session after, in one transaction. When
   that event names a session with a handoff and was not inserted by this
   release, a trigger puts the handoff back into the row at the event insert,
   before the older release reads the row. It then sees exactly what it saw
   before the handoff existed: a late delta extends the whole body, its turn
   start carries it, and an explicit clear removes it for good. This release
   marks its own inserts through a connection-local trigger, so its writes
   never pay for the move. */
export const IDLE_LIVE_TURN_COMPACTION_VERSION_KEY = "idle_live_turn_compaction_version";
const CURSOR_KEY = "idle_live_turn_compaction_cursor";

const SCHEMA: ReadonlyArray<{ name: string; sql: string }> = [
  { name: "entity_write_ticks", sql: `CREATE TABLE IF NOT EXISTS entity_write_ticks (
    tick INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, id TEXT NOT NULL, UNIQUE(kind, id))` },
  { name: "session_live_handoffs", sql: "CREATE TABLE IF NOT EXISTS session_live_handoffs (id TEXT PRIMARY KEY, live_turn_json TEXT NOT NULL)" },
  /* The event seqs this release inserted for a session with a handoff. A row
     lives only inside the statement that inserts its event. */
  { name: "session_live_handoff_own_events", sql: "CREATE TABLE IF NOT EXISTS session_live_handoff_own_events (seq INTEGER PRIMARY KEY)" },
  /* Delete, then insert: an outer statement's conflict policy governs a
     trigger's own statements, so an INSERT OR IGNORE into entities would turn
     an upsert here into a no-op and leave the tick behind. */
  { name: "entity_write_tick_insert", sql: `CREATE TRIGGER IF NOT EXISTS entity_write_tick_insert AFTER INSERT ON entities BEGIN
    DELETE FROM entity_write_ticks WHERE kind = NEW.kind AND id = NEW.id;
    INSERT INTO entity_write_ticks(kind, id) VALUES (NEW.kind, NEW.id);
  END` },
  { name: "entity_write_tick_update", sql: `CREATE TRIGGER IF NOT EXISTS entity_write_tick_update AFTER UPDATE ON entities BEGIN
    DELETE FROM entity_write_ticks WHERE (kind = OLD.kind AND id = OLD.id) OR (kind = NEW.kind AND id = NEW.id);
    INSERT INTO entity_write_ticks(kind, id) VALUES (NEW.kind, NEW.id);
  END` },
  /* An event another writer inserts for a session with a handoff: the body
     goes back into the row before that writer projects the event. A body
     already in the row is newer (sessionWithHandoff prefers it), so only the
     handoff goes. The row then holds an ended turn's body again, so the next
     open of this release runs the idle compaction once more. */
  { name: "session_live_handoff_foreign_event", sql: `CREATE TRIGGER IF NOT EXISTS session_live_handoff_foreign_event AFTER INSERT ON events
    WHEN substr(NEW.scope, 1, 8) = 'session:'
      AND (EXISTS (SELECT 1 FROM session_live_handoffs WHERE id = substr(NEW.scope, 9))
        OR EXISTS (SELECT 1 FROM session_live_handoff_own_events WHERE seq = NEW.seq))
    BEGIN
      UPDATE entities SET state_json = json_set(state_json, '$.liveTurn',
          json((SELECT live_turn_json FROM session_live_handoffs WHERE id = substr(NEW.scope, 9))))
        WHERE kind = 'session' AND id = substr(NEW.scope, 9)
          AND json_type(state_json, '$.liveTurn') IS NOT 'object'
          AND NOT EXISTS (SELECT 1 FROM session_live_handoff_own_events WHERE seq = NEW.seq);
      DELETE FROM journal_meta WHERE key IN ('${IDLE_LIVE_TURN_COMPACTION_VERSION_KEY}', '${CURSOR_KEY}')
        AND EXISTS (SELECT 1 FROM session_live_handoffs WHERE id = substr(NEW.scope, 9))
        AND NOT EXISTS (SELECT 1 FROM session_live_handoff_own_events WHERE seq = NEW.seq);
      DELETE FROM session_live_handoffs WHERE id = substr(NEW.scope, 9)
        AND NOT EXISTS (SELECT 1 FROM session_live_handoff_own_events WHERE seq = NEW.seq);
      DELETE FROM session_live_handoff_own_events WHERE seq = NEW.seq;
    END` },
  /* A second line for a writer that opens a turn without an event (raw SQL):
     an open turn written without a body while a handoff exists gets the
     handoff back in the same statement. This release never writes that: the
     row of an open turn always holds its body (storedSession drops the
     handoff before that write). */
  { name: "session_live_handoff_restore", sql: `CREATE TRIGGER IF NOT EXISTS session_live_handoff_restore AFTER UPDATE ON entities
    WHEN NEW.kind = 'session'
      AND EXISTS (SELECT 1 FROM session_live_handoffs WHERE id = NEW.id)
      AND json_extract(NEW.state_json, '$.turn') IN ('running', 'interrupt_requested')
      AND json_type(NEW.state_json, '$.liveTurn') IS NOT 'object'
    BEGIN
      UPDATE entities SET state_json = json_set(state_json, '$.liveTurn', json((SELECT live_turn_json FROM session_live_handoffs WHERE id = NEW.id)))
        WHERE kind = 'session' AND id = NEW.id;
      DELETE FROM session_live_handoffs WHERE id = NEW.id;
    END` },
  /* A deleted row needs no tick: no reader selects an id that is gone, and an
     insert under the same id takes a new tick. Its handoff goes with it. */
  { name: "entity_write_tick_delete", sql: `CREATE TRIGGER IF NOT EXISTS entity_write_tick_delete AFTER DELETE ON entities BEGIN
    DELETE FROM entity_write_ticks WHERE kind = OLD.kind AND id = OLD.id;
    DELETE FROM session_live_handoffs WHERE OLD.kind = 'session' AND id = OLD.id;
  END` },
];

/** Creates whatever is missing. Creating it in an operator's journal is a
    startup mutation, so only the runtime host or the Viewer may do it. */
export function installEntityWriteSchema(db: Database, directory: string): void {
  const existing = new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger')").all().map(row => row.name));
  const missing = SCHEMA.filter(({ name }) => !existing.has(name));
  if (!missing.length) return;
  assertStateStartupMutation(directory, "runtime journal entity write tracking");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const { sql } of missing) db.exec(sql);
    /* AUTOINCREMENT adds its sqlite_sequence row at the end of the first
       statement that could insert a tick, even one that changes no row, so a
       later open would commit that one row. It is added here instead. */
    db.exec("INSERT INTO sqlite_sequence(name, seq) SELECT 'entity_write_ticks', 0 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'entity_write_ticks')");
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* the failed statement closed it */ }
    throw error;
  }
}

/** Marks the events this connection inserts for a session with a handoff, so
    session_live_handoff_foreign_event leaves this release's own writes alone:
    they read the handoff themselves. A TEMP trigger fires only for the
    connection that created it. Call after installEntityWriteSchema. */
export function markOwnSessionEvents(db: Database): void {
  db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS session_live_handoff_own_event BEFORE INSERT ON main.events
    WHEN substr(NEW.scope, 1, 8) = 'session:' AND EXISTS (SELECT 1 FROM main.session_live_handoffs WHERE id = substr(NEW.scope, 9))
    BEGIN
      DELETE FROM session_live_handoff_own_events WHERE seq = NEW.seq;
      INSERT INTO session_live_handoff_own_events(seq) VALUES (NEW.seq);
    END`);
}

/** A turn in one of these states may still receive deltas and items. */
export function liveTurnStillOpen(turn: unknown): boolean {
  return turn === "running" || turn === "interrupt_requested";
}

/** Moves the live-turn bodies that older releases left on sessions whose
 * turn had ended into session_live_handoffs, once per journal. The work runs
 * on timer turns after open, at most 32 rows / 4 ms per transaction, and the
 * cursor commits with the rows it describes, so an interrupted run resumes
 * where it stopped and a finished one is never repeated. Each row's turn is
 * read again under the write lock, so an open turn keeps its body. A process
 * that may not migrate the operator's state stands down and leaves the work
 * to the runtime host. */
export class IdleLiveTurnCompaction {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private reportedError = false;
  private closed = false;
  done = false;
  /** Rows moved; the presented snapshot does not change, so the snapshot
      cache does not count these writes. */
  excludedChanges = 0;
  moved = 0;

  private readonly rowsPerStep: number;
  private readonly stepBudgetMs: number;
  private readonly clock: () => number;

  /** The bounds are options so a test can place a crash inside one
      transaction whatever the speed of the disk. */
  constructor(private readonly db: Database, options: { rowsPerStep?: number; stepBudgetMs?: number; clock?: () => number } = {}) {
    this.rowsPerStep = options.rowsPerStep ?? 32;
    this.stepBudgetMs = options.stepBudgetMs ?? 4;
    this.clock = options.clock ?? (() => performance.now());
  }

  start(): void {
    if (this.db.query<{ value: string }, [string]>("SELECT value FROM journal_meta WHERE key = ?").get(IDLE_LIVE_TURN_COMPACTION_VERSION_KEY)?.value === "1") {
      this.done = true;
      return;
    }
    if (!mayRunStateStartupMutation(path.dirname(this.db.filename))) return;
    this.schedule(0);
  }

  close(): void { this.closed = true; clearTimeout(this.timer); }

  private schedule(delay: number): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      try {
        this.step();
        this.reportedError = false;
        if (!this.done) this.schedule(1);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "SQLITE_BUSY" && code !== "SQLITE_LOCKED" && !this.reportedError) {
          console.error("[runtime host] idle live-turn compaction deferred", error);
          this.reportedError = true;
        }
        this.schedule(250);
      }
    }, delay);
    this.timer.unref();
  }

  /** One bounded transaction. Returns how many rows it moved. */
  step(): number {
    assertStateStartupMutation(path.dirname(this.db.filename), "runtime journal idle live-turn compaction");
    const changes = this.totalChanges();
    const timeout = this.db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()!.timeout;
    this.db.exec("PRAGMA busy_timeout = 0");
    let moved = 0;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const read = this.db.query<{ value: string }, [string]>("SELECT value FROM journal_meta WHERE key = ?");
        if (read.get(IDLE_LIVE_TURN_COMPACTION_VERSION_KEY)?.value === "1") {
          this.db.exec("COMMIT");
          this.done = true;
          return 0;
        }
        let cursor = read.get(CURSOR_KEY)?.value ?? null;
        type Row = { id: string; turn: unknown; body: string | null };
        const columns = "id, json_extract(state_json, '$.turn') AS turn, json_type(state_json, '$.liveTurn') AS body";
        const next = this.db.query<Row, [string]>(`SELECT ${columns} FROM entities WHERE kind = 'session' AND id > ? ORDER BY id LIMIT 1`);
        const first = this.db.query<Row, []>(`SELECT ${columns} FROM entities WHERE kind = 'session' ORDER BY id LIMIT 1`);
        /* SQLite moves the body without a round trip through JS. The key stays
           in place as null: every key keeps its stored order, and presentation
           writes null over it there, so the presented frame is the same to the
           byte. */
        const handoff = this.db.query(`INSERT INTO session_live_handoffs(id, live_turn_json)
          SELECT id, json_extract(state_json, '$.liveTurn') FROM entities WHERE kind = 'session' AND id = ?
          ON CONFLICT(id) DO UPDATE SET live_turn_json = excluded.live_turn_json`);
        const strip = this.db.query("UPDATE entities SET state_json = json_set(state_json, '$.liveTurn', json('null')) WHERE kind = 'session' AND id = ?");
        const started = this.clock();
        let complete = false;
        for (let rows = 0; rows < this.rowsPerStep; rows++) {
          const row = cursor === null ? first.get() : next.get(cursor);
          if (!row) { complete = true; break; }
          cursor = row.id;
          // Only a body: the journal never stores another shape (normalizeRuntimeLiveTurn).
          if (!liveTurnStillOpen(row.turn) && row.body === "object") {
            // The row's body is the newest: this release never stores one at idle.
            handoff.run(row.id);
            strip.run(row.id);
            moved++;
          }
          if (this.clock() - started >= this.stepBudgetMs) break;
        }
        const set = this.db.query("INSERT INTO journal_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
        if (cursor !== null) set.run(CURSOR_KEY, cursor);
        if (complete) set.run(IDLE_LIVE_TURN_COMPACTION_VERSION_KEY, "1");
        this.db.exec("COMMIT");
        this.moved += moved;
        this.done = complete;
        return moved;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      this.excludedChanges += this.totalChanges() - changes;
      this.db.exec(`PRAGMA busy_timeout = ${timeout}`);
    }
  }

  private totalChanges(): number {
    return this.db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n;
  }
}
