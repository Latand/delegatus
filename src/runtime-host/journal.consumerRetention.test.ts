import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { RuntimeJournal } from "./journal";

test("a consumer holding the retention anchor prevents history scans on every append", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "journal-consumer-retention-"));
  const filename = path.join(directory, "events.sqlite");
  const journal = new RuntimeJournal(filename, { maxEvents: 2 });
  journal.registerConsumer("orchestration");
  const append = (id: number) => journal.append({
    scope: "system:fixture", kind: "fixture.history", payload: { id },
  });
  const events = Array.from({ length: 240 }, (_, index) => append(index));
  const query = spyOn(Database.prototype, "query");
  try {
    const tail = Array.from({ length: 8 }, (_, index) => append(240 + index));
    // Count and OFFSET walk retained history even when no prefix is eligible.
    const historyScans = query.mock.calls.filter(([sql]) => /COUNT\(\*\).*FROM events|FROM events ORDER BY seq LIMIT 1 OFFSET/i.test(sql));
    expect(historyScans).toHaveLength(0);
    query.mockRestore();
    expect(journal.unconsumedEvents("orchestration")[0]?.eventId).toBe(events[0]!.eventId);
    journal.markConsumerCompleted(events[0]!.eventId, "orchestration");
    journal.compact();
    expect(journal.unconsumedEvents("orchestration")[0]?.eventId).toBe(events[1]!.eventId);
    const db = new Database(filename, { readonly: true });
    try {
      expect(db.query<{ seq: number }, []>("SELECT MIN(seq) AS seq FROM events").get()?.seq).toBe(events[1]!.seq);
    } finally { db.close(); }
    for (const event of [...events.slice(1), ...tail]) journal.markConsumerCompleted(event.eventId, "orchestration");
    journal.compact();
    expect(journal.unconsumedEvents("orchestration")).toEqual([]);
    journal.close();
    const reopened = new RuntimeJournal(filename, { maxEvents: 2 });
    try {
      expect(reopened.isWritable()).toBe(true);
      const db = new Database(filename, { readonly: true });
      try {
        expect(db.query<{ seq: number }, []>("SELECT seq FROM events ORDER BY seq").all().map((row) => row.seq))
          .toEqual(tail.slice(-2).map((event) => event.seq));
      } finally { db.close(); }
    } finally { reopened.close(); }
  } finally {
    query.mockRestore();
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("keyed checkpoint retirement matches the anti-join through held consumers and reopen", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "journal-checkpoint-equivalence-"));
  const filename = path.join(directory, "events.sqlite");
  let journal = new RuntimeJournal(filename, { maxEvents: 3, now: () => 100 });
  const db = new Database(filename);
  try {
    journal.registerConsumer("fast");
    journal.registerConsumer("held");
    const events = Array.from({ length: 12 }, (_, id) => journal.append({
      scope: "system:fixture", kind: "fixture.history", payload: { id },
    }));
    for (const event of events) journal.markConsumerCompleted(event.eventId, "fast");
    // A later acknowledgement must survive while an earlier hole holds replay.
    journal.markConsumerCompleted(events[5]!.eventId, "held");
    db.exec("CREATE TABLE reference_checkpoints AS SELECT * FROM consumer_checkpoints");
    const assertEquivalent = (retainedSeqs: number[]) => {
      db.exec(`DELETE FROM reference_checkpoints WHERE NOT EXISTS (
        SELECT 1 FROM events WHERE events.event_id = reference_checkpoints.event_id)`);
      const rows = (table: string) => db.query(`SELECT * FROM ${table} ORDER BY event_id, consumer`).all();
      expect(rows("consumer_checkpoints")).toEqual(rows("reference_checkpoints"));
      expect(db.query<{ seq: number }, []>("SELECT seq FROM events ORDER BY seq").all().map((row) => row.seq)).toEqual(retainedSeqs);
    };
    journal.compact();
    assertEquivalent(events.map((event) => event.seq));
    for (const event of events.slice(0, 4)) {
      journal.markConsumerCompleted(event.eventId, "held");
      db.query("INSERT OR IGNORE INTO reference_checkpoints VALUES (?, ?, ?)").run(event.eventId, "held", 100);
    }
    journal.compact();
    assertEquivalent(events.slice(4).map((event) => event.seq));
    expect(journal.unconsumedEvents("held").map((event) => event.seq)).toEqual([5, 7, 8, 9, 10, 11, 12]);
    journal.close();
    journal = new RuntimeJournal(filename, { maxEvents: 3, now: () => 100 });
    expect(journal.isWritable()).toBe(true);
    for (const event of events.slice(4)) {
      journal.markConsumerCompleted(event.eventId, "held");
      db.query("INSERT OR IGNORE INTO reference_checkpoints VALUES (?, ?, ?)").run(event.eventId, "held", 100);
    }
    journal.compact();
    assertEquivalent(events.slice(-3).map((event) => event.seq));
    const appended = journal.append({ scope: "system:fixture", kind: "fixture.history", payload: { id: 12 } });
    assertEquivalent([...events.slice(-2).map((event) => event.seq), appended.seq]);
    expect(journal.consumerCompleted(events[0]!.eventId, "fast", events[0]!.seq)).toBe(true);
    expect(journal.consumerCompleted(events[5]!.eventId, "held", events[5]!.seq)).toBe(true);
  } finally {
    db.close();
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("eligible compaction clears legacy and late orphan checkpoints", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "journal-orphan-checkpoints-"));
  const filename = path.join(directory, "events.sqlite");
  let journal = new RuntimeJournal(filename, { maxEvents: 2, now: () => 100 });
  const db = new Database(filename);
  try {
    journal.registerConsumer("consumer");
    const events = Array.from({ length: 3 }, (_, id) => journal.append({
      scope: "system:fixture", kind: "fixture.history", payload: { id },
    }));
    for (const event of events) journal.markConsumerCompleted(event.eventId, "consumer");

    db.exec("CREATE TABLE reference_checkpoints AS SELECT * FROM consumer_checkpoints");
    const insertCheckpoint = (table: string, eventId: string) => db.query(
      `INSERT INTO ${table}(event_id, consumer, completed_at) VALUES (?, 'consumer', 100)`,
    ).run(eventId);
    const assertMatchesAntiJoin = () => {
      db.exec(`DELETE FROM reference_checkpoints WHERE NOT EXISTS (
        SELECT 1 FROM events WHERE events.event_id = reference_checkpoints.event_id)`);
      expect(db.query("SELECT * FROM consumer_checkpoints ORDER BY event_id, consumer").all())
        .toEqual(db.query("SELECT * FROM reference_checkpoints ORDER BY event_id, consumer").all());
      expect(db.query(`SELECT COUNT(*) AS count FROM consumer_checkpoints
        WHERE NOT EXISTS (SELECT 1 FROM events WHERE events.event_id = consumer_checkpoints.event_id)`)
        .get()).toEqual({ count: 0 });
    };

    // A checkpoint left by an older release is reconciled while the journal
    // opens, before any append can pay for a whole-table anti-join.
    journal.close();
    insertCheckpoint("consumer_checkpoints", "legacy-retired-event");
    insertCheckpoint("reference_checkpoints", "legacy-retired-event");
    journal = new RuntimeJournal(filename, { maxEvents: 2, now: () => 100 });
    assertMatchesAntiJoin();

    // A late completion after retirement used to recreate the same orphan.
    journal.markConsumerCompleted(events[0]!.eventId, "consumer");
    insertCheckpoint("reference_checkpoints", events[0]!.eventId);
    journal.append({ scope: "system:fixture", kind: "fixture.history", payload: { id: 3 } });
    journal.compact();
    assertMatchesAntiJoin();

    // Reopening also reconciles legacy residue left by a prior release.
    journal.close();
    insertCheckpoint("consumer_checkpoints", "legacy-after-reopen");
    insertCheckpoint("reference_checkpoints", "legacy-after-reopen");
    journal = new RuntimeJournal(filename, { maxEvents: 2, now: () => 100 });
    journal.append({ scope: "system:fixture", kind: "fixture.history", payload: { id: 4 } });
    journal.compact();
    assertMatchesAntiJoin();
  } finally {
    db.close();
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a late completion for a retired event cannot recreate an orphan checkpoint", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "journal-late-checkpoint-"));
  const filename = path.join(directory, "events.sqlite");
  const journal = new RuntimeJournal(filename, { maxEvents: 2, now: () => 100 });
  const db = new Database(filename);
  try {
    journal.registerConsumer("consumer");
    const events = Array.from({ length: 3 }, (_, id) => journal.append({
      scope: "system:fixture", kind: "fixture.history", payload: { id },
    }));
    for (const event of events) journal.markConsumerCompleted(event.eventId, "consumer");
    journal.compact();
    journal.markConsumerCompleted(events[0]!.eventId, "consumer");
    journal.append({ scope: "system:fixture", kind: "fixture.history", payload: { id: 3 } });
    journal.compact();
    expect(db.query(`SELECT COUNT(*) AS count FROM consumer_checkpoints
      WHERE NOT EXISTS (SELECT 1 FROM events WHERE events.event_id = consumer_checkpoints.event_id)`)
      .get()).toEqual({ count: 0 });
  } finally {
    db.close();
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("append checkpoint deletion uses indexed event and checkpoint lookups", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "journal-checkpoint-plan-"));
  const filename = path.join(directory, "events.sqlite");
  const journal = new RuntimeJournal(filename, { maxEvents: 2, now: () => 100 });
  const db = new Database(filename);
  const query = spyOn(Database.prototype, "query");
  try {
    for (let id = 0; id < 3; id++) journal.append({ scope: "system:fixture", kind: "fixture.history", payload: { id } });
    const deletes = query.mock.calls.filter(([sql]) => /DELETE FROM consumer_checkpoints/i.test(sql));
    expect(deletes).toHaveLength(1);
    const sql = deletes[0]![0];
    query.mockRestore();
    const plan = db.query<{ detail: string }, [number]>(`EXPLAIN QUERY PLAN ${sql}`).all(1).map((row) => row.detail);
    expect(plan.some((detail) => /SEARCH consumer_checkpoints USING .*\(event_id=\?\)/.test(detail))).toBe(true);
    expect(plan.some((detail) => /SEARCH events USING INTEGER PRIMARY KEY \(rowid<\?\)/.test(detail))).toBe(true);
    expect(plan.some((detail) => /SCAN (?:consumer_checkpoints|events)/.test(detail))).toBe(false);
  } finally {
    query.mockRestore();
    db.close();
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a refused event retirement rolls checkpoint deletion back with the anchor", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "journal-checkpoint-rollback-"));
  const filename = path.join(directory, "events.sqlite");
  const journal = new RuntimeJournal(filename, { maxEvents: 2, now: () => 100 });
  const db = new Database(filename);
  try {
    journal.registerConsumer("held");
    const events = Array.from({ length: 4 }, (_, id) => journal.append({ scope: "system:fixture", kind: "fixture.history", payload: { id } }));
    for (const event of events) journal.markConsumerCompleted(event.eventId, "held");
    db.exec("CREATE TRIGGER refuse_retirement BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'injected retirement refusal'); END");
    expect(() => journal.compact()).toThrow("injected retirement refusal");
    expect(db.query("SELECT event_id FROM consumer_checkpoints ORDER BY event_id").all()).toHaveLength(4);
    expect(db.query("SELECT seq FROM events ORDER BY seq").all()).toHaveLength(4);
    expect(db.query<{ value: string }, []>("SELECT value FROM journal_meta WHERE key = 'anchor_seq'").get()?.value).toBe("0");
    db.exec("DROP TRIGGER refuse_retirement");
    journal.compact();
    expect(db.query("SELECT event_id FROM consumer_checkpoints").all()).toHaveLength(2);
    expect(db.query("SELECT seq FROM events").all()).toHaveLength(2);
  } finally {
    db.close();
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
