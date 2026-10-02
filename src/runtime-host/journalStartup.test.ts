import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { RuntimeJournal } from "./journal";

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegatus-journal-startup-"));
  sandboxes.push(dir);
  const filename = path.join(dir, "events.sqlite");
  const journal = new RuntimeJournal(filename, { maxEvents: 100 });
  const inputs = ["codex-app-server", "claude-broker"].flatMap((kind) =>
    [1, 2, 3].map((sequence) => ({
      scope: `session:${kind}`,
      kind: "turn.started",
      payload: { turnId: `turn-${sequence}` },
      producer: { kind, eventKey: `startup-${sequence}` },
    })),
  );
  const events = inputs.map((input) => journal.append(input));
  journal.close();
  return { filename, inputs, events };
}

test("startup backfills missing producer receipts and preserves existing receipts and replay", () => {
  const { filename, inputs, events } = fixture();
  const db = new Database(filename);
  const retained = db.query<{ producer_kind: string; producer_key: string; event_json: string }, []>(
    "SELECT producer_kind, producer_key, event_json FROM producer_receipts WHERE producer_key = 'startup-1' ORDER BY producer_kind",
  ).all();
  db.exec("DELETE FROM producer_receipts WHERE producer_key != 'startup-1'");
  db.close();

  const reopened = new RuntimeJournal(filename);
  try {
    expect(reopened.isWritable()).toBe(true);
    for (const [index, input] of inputs.entries()) expect(reopened.append(input)).toEqual(events[index]);
    expect(reopened.snapshot().snapshotSeq).toBe(6);
  } finally {
    reopened.close();
  }

  const read = new Database(filename, { readonly: true });
  try {
    expect(read.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM producer_receipts").get()?.count).toBe(6);
    expect(read.query(
      "SELECT producer_kind, producer_key, event_json FROM producer_receipts WHERE producer_key = 'startup-1' ORDER BY producer_kind",
    ).all()).toEqual(retained);
  } finally {
    read.close();
  }
});

test("startup receipt backfill rolls back the whole batch on failure and can retry", () => {
  const { filename, inputs, events } = fixture();
  const db = new Database(filename);
  db.exec(`
    DELETE FROM producer_receipts;
    CREATE TRIGGER reject_startup_receipt BEFORE INSERT ON producer_receipts
    WHEN NEW.producer_kind = 'codex-app-server' AND NEW.producer_key = 'startup-2'
    BEGIN SELECT RAISE(ABORT, 'injected startup receipt failure'); END;
  `);
  db.close();

  expect(() => new RuntimeJournal(filename)).toThrow("injected startup receipt failure");
  const repair = new Database(filename);
  try {
    expect(repair.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM producer_receipts").get()?.count).toBe(0);
    repair.exec("DROP TRIGGER reject_startup_receipt");
  } finally {
    repair.close();
  }

  const reopened = new RuntimeJournal(filename);
  try {
    expect(reopened.isWritable()).toBe(true);
    for (const [index, input] of inputs.entries()) expect(reopened.append(input)).toEqual(events[index]);
  } finally {
    reopened.close();
  }
});

test("startup does not attempt to insert receipts that already exist", () => {
  const { filename } = fixture();
  const db = new Database(filename);
  db.exec(`
    CREATE TRIGGER reject_existing_receipt BEFORE INSERT ON producer_receipts
    WHEN EXISTS (
      SELECT 1 FROM producer_receipts
      WHERE producer_kind = NEW.producer_kind AND producer_key = NEW.producer_key
    )
    BEGIN SELECT RAISE(ABORT, 'existing receipt must be skipped'); END;
  `);
  db.close();

  const reopened = new RuntimeJournal(filename);
  try {
    expect(reopened.isWritable()).toBe(true);
  } finally {
    reopened.close();
  }
});
