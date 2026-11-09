import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { runtimeScope } from "@/lib/runtime/contracts";
import { RuntimeJournal, RUNTIME_ENTITY_READ_CACHE_BYTES, RUNTIME_ENTITY_READ_CACHE_ENTRIES } from "./journal";

const now = Date.parse("2026-10-28T00:00:00Z");
function status(journal: RuntimeJournal, id: string, turn = "idle") {
  journal.append({ scope: runtimeScope("session", id), kind: "session-status", payload: {
    conversationId: id, sessionKey: { engine: "codex", sessionId: id }, hostKind: "codex-app-server",
    host: "hosted", turn, provenance: "structured", capabilities: {},
    voiceDeliveries: [{ deliveryId: `delivery-${id}`, turnId: `turn-${id}`, ready: true, responses: [{ responseId: "response", text: "voice body" }] }],
  } });
}

test("snapshots reuse unchanged payloads, preserve mutable results, and invalidate exactly the local changed entity", () => {
  const journal = new RuntimeJournal(":memory:", { now: () => now });
  try {
    for (let index = 0; index < 20; index++) status(journal, `conversation-${index}`);
    const first = journal.snapshot();
    const reads = journal.snapshotProjectionReads;
    expect(journal.snapshot()).toEqual(first);
    expect(journal.snapshotProjectionReads).toBe(reads);
    first.sessions[0]!.voiceDeliveries![0]!.responses[0]!.text = "caller mutation";
    expect(journal.snapshot().sessions[0]!.voiceDeliveries![0]!.responses[0]!.text).toBe("voice body");
    status(journal, "conversation-3", "running");
    const changed = journal.snapshot();
    expect(changed.sessions.find(session => session.conversationId === "conversation-3")?.turn).toBe("running");
    expect(journal.snapshotProjectionReads - reads).toBe(1);
    const summary = JSON.parse(journal.snapshotJson([]));
    const target = JSON.parse(journal.snapshotJson(["conversation-3"]));
    expect(summary.sessions.every((session: { voiceDeliveries: { responses: { text: string }[] }[] }) => session.voiceDeliveries[0]!.responses[0]!.text === "")).toBe(true);
    expect(target.sessions.find((session: { conversationId: string }) => session.conversationId === "conversation-3").voiceDeliveries[0].responses[0].text).toBe("voice body");
  } finally { journal.close(); }
});

test("peer commits, deletes and same-revision edits invalidate snapshots and survive a real-process restart", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-journal-projection-"));
  const filename = path.join(root, "journal.sqlite");
  const journal = new RuntimeJournal(filename, { now: () => now });
  const peer = new Database(filename);
  try {
    status(journal, "conversation-kept"); status(journal, "conversation-deleted");
    journal.snapshotJson(); journal.snapshotJson([]);
    peer.query("UPDATE entities SET state_json=json_set(state_json,'$.turn','running') WHERE kind='session' AND id=?").run("conversation-kept");
    peer.query("DELETE FROM entities WHERE kind='session' AND id=?").run("conversation-deleted");
    const expected = journal.snapshot();
    expect(expected.sessions).toHaveLength(1);
    expect(expected.sessions[0]?.turn).toBe("running");
    expect(JSON.parse(journal.snapshotJson())).toEqual(expected);
    const program = `import { RuntimeJournal } from ${JSON.stringify(new URL("./journal.ts", import.meta.url).href)};
      const journal = new RuntimeJournal(process.argv[1], { now: () => ${now} });
      process.stdout.write(JSON.stringify(journal.snapshot())); journal.close();`;
    const child = spawnSync(process.execPath, ["--eval", program, filename], { env: process.env, encoding: "utf8", timeout: 30_000 });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual(expected);
  } finally { peer.close(); journal.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("rolled-back local SQL edits evict safely and a later edit cannot replay the old cache", () => {
  const journal = new RuntimeJournal(":memory:", { now: () => now });
  // Exercise direct local SQL too: recovery, compaction and maintenance use it.
  const db = (journal as unknown as { db: Database }).db;
  try {
    status(journal, "conversation-rollback");
    const original = journal.snapshot();
    db.exec("BEGIN");
    db.exec("UPDATE entities SET state_json=json_set(state_json,'$.turn','running') WHERE kind='session'");
    db.exec("ROLLBACK");
    expect(journal.snapshot()).toEqual(original);
    db.exec("UPDATE entities SET state_json=json_set(state_json,'$.turn','running') WHERE kind='session'");
    expect(journal.snapshot().sessions[0]?.turn).toBe("running");
    db.exec(`INSERT OR REPLACE INTO entities(kind,id,revision,state_json,checkpoint_seq,updated_at)
      SELECT kind,id,revision,json_set(state_json,'$.turn','idle'),checkpoint_seq,updated_at FROM entities WHERE kind='session'`);
    expect(journal.snapshot().sessions[0]?.turn).toBe("idle");
    db.exec("DELETE FROM entities WHERE kind='session'");
    expect(journal.snapshot().sessions).toEqual([]);
    expect((journal as unknown as { entityReads: Map<string, unknown> }).entityReads.size).toBe(0);
    status(journal, "conversation-rollback");
    expect(journal.snapshot().sessions[0]?.turn).toBe("idle");
  } finally { journal.close(); }
});

test("a population above the former 8192-row cap rebuilds from one changed row", () => {
  // Sessions plus their edges exceeded the old row cap on a busy install, so
  // each rebuild evicted and re-read every stored row.
  const journal = new RuntimeJournal(":memory:", { now: () => now });
  const state = journal as unknown as { db: Database };
  try {
    const insert = state.db.query("INSERT INTO entities(kind,id,revision,state_json,checkpoint_seq) VALUES ('task',?,1,?,1)");
    state.db.exec("BEGIN");
    for (let index = 0; index < 9000; index++) insert.run(`task-${String(index).padStart(5, "0")}`, JSON.stringify({ id: `task-${index}`, text: "x" }));
    state.db.exec("COMMIT");
    const first = journal.snapshotJson();
    expect(JSON.parse(first).tasks).toHaveLength(9000);
    const reads = journal.snapshotProjectionReads;
    state.db.run("UPDATE entities SET state_json = ? WHERE kind = 'task' AND id = 'task-04500'", [JSON.stringify({ id: "task-4500", text: "changed" })]);
    const second = JSON.parse(journal.snapshotJson());
    expect(journal.snapshotProjectionReads - reads).toBe(1);
    expect(journal.snapshotEntityEvictions).toBe(0);
    expect(second.tasks.filter((task: { value?: { text: string }; text?: string }) => (task.value ?? task).text === "changed")).toHaveLength(1);
  } finally { journal.close(); }
});

test("row and byte limits bound cache registrations across a real-process restart", () => {
  for (const [rows, textSize] of [[RUNTIME_ENTITY_READ_CACHE_ENTRIES + 8, 1], [66, 1024 * 1024], [1, 17 * 1024 * 1024]]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-projection-bounds-"));
    const filename = path.join(root, "journal.sqlite");
    const journal = new RuntimeJournal(filename, { now: () => now });
    let closed = false;
    const state = journal as unknown as { db: Database; entityReadBytes: number; entityReads: Map<string, unknown> };
    try {
      const insert = state.db.query("INSERT INTO entities(kind,id,revision,state_json,checkpoint_seq) VALUES ('task',?,1,?,1)");
      state.db.exec("BEGIN");
      for (let index = 0; index < rows!; index++) insert.run(`task-${String(index).padStart(5, "0")}`,
        JSON.stringify({ id: `task-${index}`, text: "x".repeat(textSize!) }));
      state.db.exec("COMMIT");
      const snapshot = journal.snapshot();
      expect(snapshot.tasks).toHaveLength(rows!);
      expect(state.entityReadBytes).toBeLessThanOrEqual(RUNTIME_ENTITY_READ_CACHE_BYTES);
      expect(state.entityReads.size).toBeLessThanOrEqual(RUNTIME_ENTITY_READ_CACHE_ENTRIES);
      expect(state.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM snapshot_entity_keys").get()!.n).toBe(state.entityReads.size);
      expect(journal.snapshot()).toEqual(snapshot);
      const digest = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
      journal.close(); closed = true;
      const program = `import { RuntimeJournal } from ${JSON.stringify(new URL("./journal.ts", import.meta.url).href)};
        import { createHash } from "node:crypto";
        const journal = new RuntimeJournal(process.argv[1], { now: () => ${now} });
        const snapshot = journal.snapshot();
        process.stdout.write(JSON.stringify({ tasks: snapshot.tasks.length,
          digest: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
          reads: journal.snapshotProjectionReads, bytes: journal.entityReadBytes, variants: journal.entityReads.size,
          keys: journal.db.query("SELECT COUNT(*) AS n FROM snapshot_entity_keys").get().n }));
        journal.close();`;
      const child = spawnSync(process.execPath, ["--eval", program, filename], { env: process.env, encoding: "utf8", timeout: 30_000 });
      expect(child.status, child.stderr).toBe(0);
      const restarted = JSON.parse(child.stdout);
      expect(restarted.tasks).toBe(rows!);
      expect(restarted.digest).toBe(digest);
      expect(restarted.reads).toBe(rows!);
      expect(restarted.bytes).toBeLessThanOrEqual(RUNTIME_ENTITY_READ_CACHE_BYTES);
      expect(restarted.variants).toBeLessThanOrEqual(RUNTIME_ENTITY_READ_CACHE_ENTRIES);
      expect(restarted.keys).toBe(restarted.variants);
    } finally {
      if (!closed) journal.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}, 60_000);

test("a failed snapshot rolls back its cache registrations and retries from committed state", () => {
  const journal = new RuntimeJournal(":memory:", { now: () => now });
  const db = (journal as unknown as { db: Database }).db;
  try {
    status(journal, "conversation-retry");
    db.exec("INSERT INTO entities(kind,id,revision,state_json,checkpoint_seq) VALUES ('task','broken',1,'invalid json',1)");
    expect(() => journal.snapshot()).toThrow();
    db.exec("DELETE FROM entities WHERE kind='task'");
    const snapshot = journal.snapshot();
    status(journal, "conversation-retry", "running");
    expect(journal.snapshot().sessions[0]?.turn).toBe("running");
    expect(snapshot.sessions[0]?.turn).toBe("idle");
  } finally { journal.close(); }
});

test("cached sessions apply retry receipt presentation once", () => {
  const journal = new RuntimeJournal(":memory:", { now: () => now });
  const db = (journal as unknown as { db: Database }).db;
  try {
    status(journal, "conversation-receipt");
    const origin = { operationId: "origin", kind: "send" as const, status: "failed" as const, revision: 1,
      idempotencyKey: "receipt", conversationId: "conversation-receipt", at: new Date(now).toISOString() };
    const retry = { ...origin, operationId: "retry", status: "queued", revision: 2,
      retryOfOperationId: "origin", presentationOperationId: "origin", presentationRevision: 2 };
    db.query("UPDATE entities SET state_json=json_set(state_json,'$.recentReceipts',json(?)) WHERE kind='session'")
      .run(JSON.stringify([origin, retry]));
    for (let pass = 0; pass < 2; pass++) {
      expect(journal.snapshot().sessions[0]?.recentReceipts).toEqual([
        { ...origin, status: "queued", revision: 2, retryOfOperationId: "origin" },
      ]);
    }
  } finally { journal.close(); }
});

test("a peer commit between the pinned read and cache validation reaches the next snapshot", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-snapshot-peer-race-"));
  const filename = path.join(root, "journal.sqlite");
  const journal = new RuntimeJournal(filename, { now: () => now });
  const peer = new Database(filename);
  const db = (journal as unknown as { db: Database }).db;
  const query = db.query.bind(db);
  let inject = false;
  const read = spyOn(db, "query").mockImplementation(((sql: string, ...args: unknown[]) => {
    if (inject && sql === "PRAGMA data_version") {
      inject = false;
      peer.exec("UPDATE entities SET state_json=json_set(state_json,'$.turn','running') WHERE kind='session'");
    }
    return query(sql, ...args as []);
  }) as typeof db.query);
  try {
    status(journal, "conversation-peer-race");
    journal.snapshot();
    inject = true;
    expect(journal.snapshot().sessions[0]?.turn).toBe("idle");
    expect(inject).toBe(false);
    expect(journal.snapshot().sessions[0]?.turn).toBe("running");
  } finally { read.mockRestore(); peer.close(); journal.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
