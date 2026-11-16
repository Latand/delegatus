import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runtimeScope } from "@/lib/runtime/contracts";
import { appendRuntimeLiveTurnDelta, normalizeRuntimeLiveTurn, runtimeLiveTurnItems, type RuntimeLiveTurn } from "@/lib/runtime/liveTurn";
import { ownershipSandbox } from "@/lib/state/fixtures/ownershipSandbox";
import { StateStartupMutationRefused } from "@/lib/stateOwnership";
import { RuntimeJournal } from "./journal";
import { IDLE_LIVE_TURN_COMPACTION_VERSION_KEY, IdleLiveTurnCompaction } from "./journalEntityWrites";

const now = Date.parse("2026-11-16T00:00:00Z");
type Internals = { db: Database; liveTurnCompaction: IdleLiveTurnCompaction };

function status(journal: RuntimeJournal, id: string, turn = "idle", extra: Record<string, unknown> = {}) {
  journal.append({ scope: runtimeScope("session", id), kind: "session-status", payload: {
    conversationId: id, sessionKey: { engine: "codex", sessionId: id }, hostKind: "codex-app-server",
    host: "hosted", turn, provenance: "structured", capabilities: {}, ...extra,
  } });
}
function turn(journal: RuntimeJournal, id: string, turnId: string, texts: string[], end = true) {
  journal.append({ scope: runtimeScope("session", id), kind: "turn-started", payload: { conversationId: id, turnId } });
  for (const text of texts) journal.append({ scope: runtimeScope("session", id), kind: "delta", payload: { conversationId: id, turnId, text } });
  if (end) journal.append({ scope: runtimeScope("session", id), kind: "turn-ended", payload: { conversationId: id, turnId } });
}
function stored(db: Database, id: string): Record<string, unknown> {
  return JSON.parse(db.query<{ state_json: string }, [string]>("SELECT state_json FROM entities WHERE kind='session' AND id=?").get(id)!.state_json);
}
function handoff(db: Database, id: string): unknown {
  const row = db.query<{ live_turn_json: string }, [string]>("SELECT live_turn_json FROM session_live_handoffs WHERE id=?").get(id);
  return row ? JSON.parse(row.live_turn_json) : null;
}
function internals(journal: RuntimeJournal): Internals { return journal as unknown as Internals; }
function scratch(prefix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, file: path.join(root, "journal.sqlite"), remove: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("an ended turn's body leaves the session row and still bridges into the next turn (#626)", () => {
  const journal = new RuntimeJournal(":memory:", { now: () => now });
  const { db } = internals(journal);
  try {
    status(journal, "conversation-a");
    turn(journal, "conversation-a", "turn-1", ["first commentary"], false);
    // An open turn keeps its body in the row.
    expect(runtimeLiveTurnItems(stored(db, "conversation-a").liveTurn as never).map(item => item.text)).toEqual(["first commentary"]);
    expect(handoff(db, "conversation-a")).toBeNull();
    journal.append({ scope: runtimeScope("session", "conversation-a"), kind: "turn-ended", payload: { conversationId: "conversation-a", turnId: "turn-1" } });
    expect(stored(db, "conversation-a")).toHaveProperty("liveTurn", null);
    expect(stored(db, "conversation-a").turn).toBe("idle");
    expect(runtimeLiveTurnItems(handoff(db, "conversation-a") as never).map(item => item.text)).toEqual(["first commentary"]);
    // The journal's own reads see the whole session; the snapshot shows no body at idle, as before.
    expect(runtimeLiveTurnItems(journal.sessionState("conversation-a")?.liveTurn).map(item => item.text)).toEqual(["first commentary"]);
    expect(journal.snapshot().sessions[0]?.liveTurn).toBeNull();
    // Status heartbeats and receipts rewrite the session without losing the handoff.
    status(journal, "conversation-a", "idle", { cwd: "/elsewhere" });
    expect(stored(db, "conversation-a")).toHaveProperty("liveTurn", null);
    expect(runtimeLiveTurnItems(journal.sessionState("conversation-a")?.liveTurn).map(item => item.text)).toEqual(["first commentary"]);
    // The next turn carries the rows not yet echoed and the row holds the body again.
    turn(journal, "conversation-a", "turn-2", ["second commentary"], false);
    const carried = runtimeLiveTurnItems(stored(db, "conversation-a").liveTurn as never);
    expect(carried.map(({ text, phase }) => ({ text, phase }))).toEqual([
      { text: "first commentary", phase: "awaiting-echo" },
      { text: "second commentary", phase: "streaming" },
    ]);
    expect(handoff(db, "conversation-a")).toBeNull();
    expect(runtimeLiveTurnItems(journal.snapshot().sessions[0]?.liveTurn).map(item => item.text)).toEqual(["first commentary", "second commentary"]);
    // An explicit clear at idle still clears.
    journal.append({ scope: runtimeScope("session", "conversation-a"), kind: "turn-ended", payload: { conversationId: "conversation-a", turnId: "turn-2" } });
    expect(handoff(db, "conversation-a")).not.toBeNull();
    status(journal, "conversation-a", "idle", { liveTurn: null });
    expect(handoff(db, "conversation-a")).toBeNull();
    expect(journal.sessionState("conversation-a")?.liveTurn ?? null).toBeNull();
  } finally { journal.close(); }
});

test("a peer's idle body is newer than the handoff, and deleting the session drops the handoff", () => {
  const { file, remove } = scratch("llv-handoff-peer-");
  const journal = new RuntimeJournal(file, { now: () => now });
  const { db } = internals(journal);
  const peer = new Database(file);
  try {
    status(journal, "conversation-a");
    turn(journal, "conversation-a", "turn-1", ["kept apart"]);
    // An older release writing during succession stores its body in the row.
    peer.exec(`UPDATE entities SET state_json=json_set(state_json,'$.liveTurn',json('{"turnId":"turn-old","text":"older release"}'))
      WHERE kind='session' AND id='conversation-a'`);
    expect(journal.sessionState("conversation-a")?.liveTurn?.turnId).toBe("turn-old");
    status(journal, "conversation-a", "idle", { cwd: "/elsewhere" });
    expect(stored(db, "conversation-a")).toHaveProperty("liveTurn", null);
    expect((handoff(db, "conversation-a") as { turnId: string }).turnId).toBe("turn-old");
    peer.exec("DELETE FROM entities WHERE kind='session' AND id='conversation-a'");
    expect(handoff(db, "conversation-a")).toBeNull();
  } finally { peer.close(); journal.close(); remove(); }
});

/** A release older than the handoff writes a session the way it always did,
    in one transaction: it inserts its event, then reads only the row, changes
    it and upserts it with that event's seq. */
function olderReleaseWrite(db: Database, id: string, kind: string, change: (session: Record<string, unknown>) => Record<string, unknown>): void {
  db.transaction(() => {
    const seq = db.query<{ seq: number }, []>("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events").get()!.seq;
    db.query(`INSERT INTO events(seq, event_id, scope, revision, kind, payload_json, created_at, occurred_at, recorded_at, producer_kind, prev_hash, hash)
      VALUES (?, ?, ?, ?, ?, '{}', 0, '', '', 'older-release', '', '')`).run(seq, `older-${seq}`, `session:${id}`, seq, kind);
    const row = db.query<{ state_json: string; revision: number }, [string]>(
      "SELECT state_json, revision FROM entities WHERE kind='session' AND id=?").get(id)!;
    const next = change(JSON.parse(row.state_json));
    db.query(`INSERT INTO entities(kind, id, revision, state_json, checkpoint_seq, updated_at) VALUES ('session', ?, ?, ?, ?, NULL)
      ON CONFLICT(kind, id) DO UPDATE SET revision = excluded.revision, state_json = excluded.state_json,
        checkpoint_seq = excluded.checkpoint_seq, updated_at = excluded.updated_at`)
      .run(id, row.revision + 1, JSON.stringify(next), seq);
  })();
}
const olderTurnStarted = (turnId: string) => (session: Record<string, unknown>) =>
  ({ ...session, turn: "running", activeTurnId: turnId, liveTurn: session.liveTurn });
const olderTurnEnded = (session: Record<string, unknown>) =>
  ({ ...session, turn: "idle", activeTurnId: null, liveTurn: session.liveTurn });
const olderDelta = (turnId: string, text: string) => (session: Record<string, unknown>) =>
  ({ ...session, liveTurn: appendRuntimeLiveTurnDelta(session.liveTurn as RuntimeLiveTurn | null, turnId, text, null) });
/** The older session-status: the payload merges over the row and a body that
    normalizes to nothing, an explicit null included, drops the key. */
const olderStatus = (payload: Record<string, unknown>) => (session: Record<string, unknown>) => {
  const { liveTurn, ...rest } = { ...session, ...payload };
  const body = normalizeRuntimeLiveTurn(liveTurn);
  return body ? { ...rest, liveTurn: body } : rest;
};
const rowTexts = (db: Database, id: string) => runtimeLiveTurnItems(stored(db, id).liveTurn as never).map(item => item.text);
const sessionTexts = (journal: RuntimeJournal, id: string) => runtimeLiveTurnItems(journal.sessionState(id)?.liveTurn).map(item => item.text);
const compactionVersion = (db: Database) =>
  db.query<{ value: string }, []>(`SELECT value FROM journal_meta WHERE key='${IDLE_LIVE_TURN_COMPACTION_VERSION_KEY}'`).get()?.value ?? null;

/** Ended turns of three sessions in this release, then the journal is left
    to an older release. */
function rolledBack(prefix: string) {
  const { file, remove } = scratch(prefix);
  const journal = new RuntimeJournal(file, { now: () => now });
  try {
    for (const id of ["conversation-a", "conversation-b", "conversation-c"]) {
      status(journal, id);
      turn(journal, id, "turn-1", [`body of ${id}`]);
      expect(stored(internals(journal).db, id)).toHaveProperty("liveTurn", null);
    }
    const compaction = compactionOf(journal);
    while (!compaction.done) compaction.step();
    expect(compactionVersion(internals(journal).db)).toBe("1");
  } finally { journal.close(); }
  return { file, remove, older: new Database(file) };
}

test("after a rollback the older release reads every ended turn's body before it writes, as it did before the handoff", () => {
  const { file, remove, older } = rolledBack("llv-handoff-rollback-");
  try {
    // A late delta for the ended turn extends the whole body, and its next turn carries it.
    olderReleaseWrite(older, "conversation-a", "delta", olderDelta("turn-1", " + late delta"));
    expect(rowTexts(older, "conversation-a")).toEqual(["body of conversation-a + late delta"]);
    expect(handoff(older, "conversation-a")).toBeNull();
    olderReleaseWrite(older, "conversation-a", "turn-started", olderTurnStarted("turn-2"));
    olderReleaseWrite(older, "conversation-a", "delta", olderDelta("turn-2", "next turn"));
    olderReleaseWrite(older, "conversation-a", "delta", olderDelta("turn-2", ", continued"));
    expect(rowTexts(older, "conversation-a")).toEqual(["body of conversation-a + late delta", "next turn, continued"]);
    olderReleaseWrite(older, "conversation-a", "turn-ended", olderTurnEnded);
    // An explicit clear at idle clears for good.
    olderReleaseWrite(older, "conversation-b", "session-status", olderStatus({ liveTurn: null }));
    expect(stored(older, "conversation-b").liveTurn ?? null).toBeNull();
    expect(handoff(older, "conversation-b")).toBeNull();
    // An unrelated idle status keeps the body, which is in the row again.
    olderReleaseWrite(older, "conversation-c", "session-status", olderStatus({ cwd: "/elsewhere" }));
    expect(rowTexts(older, "conversation-c")).toEqual(["body of conversation-c"]);
    expect(handoff(older, "conversation-c")).toBeNull();
    // The rows hold ended turns' bodies again, so the compaction runs on the next open.
    expect(compactionVersion(older)).toBeNull();
  } finally { older.close(); }
  const forward = new RuntimeJournal(file, { now: () => now });
  const { db } = internals(forward);
  try {
    expect(sessionTexts(forward, "conversation-a")).toEqual(["body of conversation-a + late delta", "next turn, continued"]);
    expect(forward.sessionState("conversation-b")?.liveTurn ?? null).toBeNull();
    expect(sessionTexts(forward, "conversation-c")).toEqual(["body of conversation-c"]);
    const compaction = compactionOf(forward);
    while (!compaction.done) compaction.step();
    expect(compaction.moved).toBe(2);
    for (const id of ["conversation-a", "conversation-c"]) {
      expect(stored(db, id)).toHaveProperty("liveTurn", null);
      expect(handoff(db, id)).not.toBeNull();
    }
    expect(handoff(db, "conversation-b")).toBeNull();
    expect(sessionTexts(forward, "conversation-a")).toEqual(["body of conversation-a + late delta", "next turn, continued"]);
    expect(forward.sessionState("conversation-b")?.liveTurn ?? null).toBeNull();
    expect(sessionTexts(forward, "conversation-c")).toEqual(["body of conversation-c"]);
  } finally { forward.close(); remove(); }
});

test("a write without an event that opens a turn without a body gets the handoff back", () => {
  const { remove, older } = rolledBack("llv-handoff-raw-");
  try {
    older.exec(`UPDATE entities SET state_json = json_remove(json_set(state_json, '$.turn', 'interrupt_requested'), '$.liveTurn')
      WHERE kind = 'session' AND id = 'conversation-b'`);
    expect(rowTexts(older, "conversation-b")).toEqual(["body of conversation-b"]);
    expect(handoff(older, "conversation-b")).toBeNull();
    // A raw idle write leaves the handoff alone.
    older.exec(`UPDATE entities SET state_json = json_set(state_json, '$.cwd', '/elsewhere') WHERE kind = 'session' AND id = 'conversation-c'`);
    expect(stored(older, "conversation-c")).toHaveProperty("liveTurn", null);
    expect(handoff(older, "conversation-c")).not.toBeNull();
  } finally { older.close(); remove(); }
});

test("this release's own turn-started writes the body once, without the restore", () => {
  const journal = new RuntimeJournal(":memory:", { now: () => now });
  const { db } = internals(journal);
  const sequence = () => db.query<{ seq: number }, []>("SELECT seq FROM sqlite_sequence WHERE name='entity_write_ticks'").get()!.seq;
  try {
    status(journal, "conversation-a");
    turn(journal, "conversation-a", "turn-1", ["first"]);
    const marks = () => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM session_live_handoff_own_events").get()!.n;
    compactionOf(journal);
    db.query("INSERT OR REPLACE INTO journal_meta(key, value) VALUES (?, '1')").run(IDLE_LIVE_TURN_COMPACTION_VERSION_KEY);
    // An idle status of this release: the body stays in the handoff, the row is written once.
    let before = sequence();
    status(journal, "conversation-a", "idle", { cwd: "/elsewhere" });
    expect(stored(db, "conversation-a")).toHaveProperty("liveTurn", null);
    expect(handoff(db, "conversation-a")).not.toBeNull();
    expect(sequence() - before).toBe(1);
    expect(marks()).toBe(0);
    expect(compactionVersion(db)).toBe("1");
    before = sequence();
    journal.append({ scope: runtimeScope("session", "conversation-a"), kind: "turn-started", payload: { conversationId: "conversation-a", turnId: "turn-2" } });
    expect(rowTexts(db, "conversation-a")).toEqual(["first"]);
    expect(handoff(db, "conversation-a")).toBeNull();
    // One entity write, one tick: a corrective update by a trigger would take a second.
    expect(sequence() - before).toBe(1);
    expect(marks()).toBe(0);
  } finally { journal.close(); }
});

test("a session read sees the row and its handoff from one snapshot while a peer starts the next turn", () => {
  const { file, remove } = scratch("llv-handoff-race-");
  const seedJournal = new RuntimeJournal(file, { now: () => now });
  try {
    status(seedJournal, "conversation-a");
    turn(seedJournal, "conversation-a", "turn-1", ["reader still needs this"]);
  } finally { seedJournal.close(); }
  const reader = new RuntimeJournal(file, { now: () => now });
  const peer = new RuntimeJournal(file, { now: () => now });
  const db = internals(reader).db;
  const query = db.query.bind(db);
  const check = new Database(file, { readonly: true });
  try {
    // Count the statements one session read issues, then commit the peer's turn-started before each of them in turn.
    let statements = 0;
    let injectAt = -1;
    let injected = false;
    (db as unknown as { query: unknown }).query = (sql: string) => {
      if (statements++ === injectAt && !injected) {
        injected = true;
        peer.append({ scope: runtimeScope("session", "conversation-a"), kind: "turn-started", payload: { conversationId: "conversation-a", turnId: "turn-2" } });
      }
      return query(sql);
    };
    expect(runtimeLiveTurnItems(reader.sessionState("conversation-a")?.liveTurn).map(item => item.text)).toEqual(["reader still needs this"]);
    const total = statements;
    expect(total).toBeGreaterThan(0);
    for (injectAt = 0; injectAt < total; injectAt++) {
      // Back to idle with the body in the handoff, then read again with the peer's commit at this point.
      peer.append({ scope: runtimeScope("session", "conversation-a"), kind: "turn-ended", payload: { conversationId: "conversation-a", turnId: "turn-2" } });
      expect(handoff(check, "conversation-a")).not.toBeNull();
      statements = 0;
      injected = false;
      const session = reader.sessionState("conversation-a");
      expect(injected).toBe(true);
      expect(runtimeLiveTurnItems(session?.liveTurn).map(item => item.text)).toEqual(["reader still needs this"]);
    }
  } finally { (db as unknown as { query: unknown }).query = query; check.close(); peer.close(); reader.close(); remove(); }
});

/** Sessions an older release left with bodies at idle, beside open turns. */
function legacyJournal(file: string, idle: number): Map<string, string> {
  const journal = new RuntimeJournal(file, { now: () => now });
  for (let index = 0; index < idle; index++) status(journal, `idle-${String(index).padStart(3, "0")}`);
  status(journal, "open-running", "running");
  status(journal, "open-interrupt", "interrupt_requested");
  const metadata = (journal as unknown as { sessionHostMetadata: { ready: boolean; step(): void } }).sessionHostMetadata;
  while (!metadata.ready) metadata.step();
  journal.close();
  const raw = new Database(file);
  const bodies = new Map<string, string>();
  raw.transaction(() => {
    const update = raw.query("UPDATE entities SET state_json=json_set(state_json,'$.liveTurn',json(?)) WHERE kind='session' AND id=?");
    for (const { id } of raw.query<{ id: string }, []>("SELECT id FROM entities WHERE kind='session' ORDER BY id").all()) {
      const body = JSON.stringify({ turnId: `turn-${id}`, items: [{ itemId: `item-${id}`, text: `body of ${id}`, phase: "awaiting-echo", startedAt: null, completedAt: null }] });
      update.run(body, id);
      bodies.set(id, body);
    }
    raw.exec(`DELETE FROM journal_meta WHERE key IN ('${IDLE_LIVE_TURN_COMPACTION_VERSION_KEY}', 'idle_live_turn_compaction_cursor')`);
  })();
  raw.close();
  return bodies;
}

function compactionOf(journal: RuntimeJournal): IdleLiveTurnCompaction {
  const compaction = internals(journal).liveTurnCompaction;
  compaction.close(); // the test drives every step itself
  return compaction;
}

test("startup compaction moves idle bodies in bounded steps, leaves open turns, and changes no presented frame", () => {
  const { file, remove } = scratch("llv-handoff-compaction-");
  const bodies = legacyJournal(file, 70);
  const journal = new RuntimeJournal(file, { now: () => now });
  const { db } = internals(journal);
  try {
    const compaction = compactionOf(journal);
    const ids = [...bodies.keys()];
    const before = Object.fromEntries(ids.map(id => [id, journal.sessionState(id)]));
    const frame = journal.snapshotJson();
    const moved: number[] = [];
    while (!compaction.done) moved.push(compaction.step());
    expect(moved.every(count => count <= 32)).toBe(true);
    expect(moved.length).toBeGreaterThanOrEqual(3);
    expect(compaction.moved).toBe(70);
    for (const id of ids) {
      const open = id.startsWith("open-");
      expect(stored(db, id).liveTurn !== null).toBe(open);
      expect(handoff(db, id)).toEqual(open ? null : JSON.parse(bodies.get(id)!));
      expect(journal.sessionState(id)).toEqual(before[id]!);
    }
    // The presented frame is unchanged, so the cached frame is reused.
    const rebuilds = journal.snapshotRebuilds;
    expect(journal.snapshotJson()).toBe(frame);
    expect(journal.snapshotRebuilds).toBe(rebuilds);
    expect(db.query<{ value: string }, []>(`SELECT value FROM journal_meta WHERE key='${IDLE_LIVE_TURN_COMPACTION_VERSION_KEY}'`).get()?.value).toBe("1");
    // A second run, even with its marker and cursor gone, moves nothing and changes nothing.
    db.exec(`DELETE FROM journal_meta WHERE key IN ('${IDLE_LIVE_TURN_COMPACTION_VERSION_KEY}', 'idle_live_turn_compaction_cursor')`);
    const again = new IdleLiveTurnCompaction(db);
    const handoffs = db.query("SELECT * FROM session_live_handoffs ORDER BY id").all();
    while (!again.done) expect(again.step()).toBe(0);
    expect(db.query("SELECT * FROM session_live_handoffs ORDER BY id").all()).toEqual(handoffs);
  } finally { journal.close(); remove(); }
});

test.each([0, 6])("a compaction killed inside its transaction loses nothing and the next process finishes it (writes stalled %i ms)", (slowWriteMs) => {
  const { file, remove } = scratch("llv-handoff-killed-");
  const bodies = legacyJournal(file, 40);
  try {
    /* One committed step of five rows, then the process dies while the next
       transaction holds moved rows. Both steps run on a clock that never
       moves, so the time budget never ends a step early: the crash lands on
       the third row of the second transaction however slow the writes are.
       SLOW_WRITE_MS stalls every row move to prove it. */
    const program = `import { RuntimeJournal } from ${JSON.stringify(new URL("./journal.ts", import.meta.url).href)};
      import { IdleLiveTurnCompaction } from ${JSON.stringify(new URL("./journalEntityWrites.ts", import.meta.url).href)};
      const journal = new RuntimeJournal(process.argv[1], { now: () => ${now} });
      journal.liveTurnCompaction.close();
      const frozen = { clock: () => 0 };
      const slow = Number(process.env.SLOW_WRITE_MS ?? 0);
      const query = journal.db.query.bind(journal.db);
      let armed = false;
      let rows = 0;
      journal.db.query = (sql) => {
        const statement = query(sql);
        if (!sql.includes("json('null')")) return statement;
        const run = statement.run.bind(statement);
        return Object.assign(Object.create(statement), { run: (...args) => {
          if (armed && ++rows === 3) process.exit(9);
          const result = run(...args);
          Bun.sleepSync(slow);
          return result;
        } });
      };
      const first = new IdleLiveTurnCompaction(journal.db, { ...frozen, rowsPerStep: 5 });
      if (first.step() !== 5) process.exit(3);
      process.stdout.write(String(first.moved));
      armed = true;
      new IdleLiveTurnCompaction(journal.db, frozen).step();
      process.exit(4);`;
    const child = spawnSync(process.execPath, ["--eval", program, file], { env: { ...process.env, SLOW_WRITE_MS: String(slowWriteMs) }, encoding: "utf8", timeout: 30_000 });
    expect(child.status, child.stderr).toBe(9);
    const committed = Number(child.stdout);
    expect(committed).toBe(5);
    const raw = new Database(file, { readonly: true });
    const rows = raw.query<{ id: string; state_json: string }, []>("SELECT id, state_json FROM entities WHERE kind='session' ORDER BY id").all();
    const split = rows.filter(row => JSON.parse(row.state_json).liveTurn === null).map(row => row.id);
    // Exactly the committed rows moved, each with its handoff; none is half-moved.
    expect(split).toEqual(rows.filter(row => row.id.startsWith("idle-")).slice(0, committed).map(row => row.id));
    expect(raw.query<{ id: string }, []>("SELECT id FROM session_live_handoffs ORDER BY id").all().map(row => row.id)).toEqual(split);
    raw.close();
    const journal = new RuntimeJournal(file, { now: () => now });
    try {
      const compaction = compactionOf(journal);
      while (!compaction.done) compaction.step();
      expect(compaction.moved).toBe(40 - committed);
      for (const [id, body] of bodies) {
        if (id.startsWith("open-")) continue;
        expect(stored(internals(journal).db, id)).toHaveProperty("liveTurn", null);
        expect(handoff(internals(journal).db, id)).toEqual(JSON.parse(body));
      }
    } finally { journal.close(); }
  } finally { remove(); }
});

test("a process without the right to migrate the operator's state never compacts", async () => {
  const sandbox = ownershipSandbox();
  const owner = process.env.LLV_STATE_OWNER;
  const temporary = process.env.TMPDIR;
  // The sandbox's own temp root, so its home is not read as scratch.
  process.env.TMPDIR = path.join(path.dirname(sandbox.home), "tmp");
  try {
    const directory = path.join(sandbox.home, ".config", "delegatus", "state");
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, "runtime-events.sqlite");
    process.env.LLV_STATE_OWNER = "runtime-host";
    legacyJournal(file, 3);
    delete process.env.LLV_STATE_OWNER;
    const journal = new RuntimeJournal(file, { now: () => now });
    try {
      const compaction = internals(journal).liveTurnCompaction;
      expect(() => compaction.step()).toThrow(StateStartupMutationRefused);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(compaction.moved).toBe(0);
      expect(internals(journal).db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM session_live_handoffs").get()!.n).toBe(0);
      expect(stored(internals(journal).db, "idle-000").liveTurn).not.toBeNull();
    } finally { journal.close(); }
    // The runtime host, opening the same journal, runs it on its own timer.
    process.env.LLV_STATE_OWNER = "runtime-host";
    const host = new RuntimeJournal(file, { now: () => now });
    try {
      const compaction = internals(host).liveTurnCompaction;
      for (let wait = 0; wait < 100 && !compaction.done; wait++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(compaction.done).toBe(true);
      expect(compaction.moved).toBe(3);
    } finally { host.close(); }
  } finally {
    if (owner === undefined) delete process.env.LLV_STATE_OWNER; else process.env.LLV_STATE_OWNER = owner;
    if (temporary === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = temporary;
    sandbox.release();
  }
});
