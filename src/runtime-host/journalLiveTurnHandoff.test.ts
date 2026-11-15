import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runtimeScope } from "@/lib/runtime/contracts";
import { runtimeLiveTurnItems } from "@/lib/runtime/liveTurn";
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

test("a compaction killed inside its transaction loses nothing and the next process finishes it", () => {
  const { file, remove } = scratch("llv-handoff-killed-");
  const bodies = legacyJournal(file, 40);
  try {
    // One committed step, then the process dies while the next transaction holds moved rows.
    const program = `import { RuntimeJournal } from ${JSON.stringify(new URL("./journal.ts", import.meta.url).href)};
      import { IdleLiveTurnCompaction } from ${JSON.stringify(new URL("./journalEntityWrites.ts", import.meta.url).href)};
      const journal = new RuntimeJournal(process.argv[1], { now: () => ${now} });
      journal.liveTurnCompaction.close();
      const first = new IdleLiveTurnCompaction(journal.db);
      while (first.moved === 0) first.step();
      process.stdout.write(String(first.moved));
      // Die on the third row of the next transaction, after two rows moved in it.
      const query = journal.db.query.bind(journal.db);
      let rows = 0;
      journal.db.query = (sql) => {
        const statement = query(sql);
        if (!sql.includes("json('null')")) return statement;
        const run = statement.run.bind(statement);
        return Object.assign(Object.create(statement), { run: (...args) => { if (++rows === 3) process.exit(9); return run(...args); } });
      };
      new IdleLiveTurnCompaction(journal.db).step();`;
    const child = spawnSync(process.execPath, ["--eval", program, file], { env: process.env, encoding: "utf8", timeout: 30_000 });
    expect(child.status, child.stderr).toBe(9);
    const committed = Number(child.stdout);
    expect(committed).toBeGreaterThan(0);
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
