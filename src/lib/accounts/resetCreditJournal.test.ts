import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetJournalCollectionsForTests } from "@/lib/state/journalCollection";
import * as sqliteState from "@/lib/state/sqliteStateStore";

import {
  appendResetCreditJournal,
  checkpointResetCreditJournalRollbackMirrorForDemotion,
  importLegacyResetCreditJournal,
  readResetCreditJournal,
  RESET_CREDIT_RETENTION,
  type ResetCreditJournalEntry,
} from "./resetCreditJournal";

const saved = process.env.LLV_STATE_DIR;
let sandbox = "";

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reset-credits-"));
  process.env.LLV_STATE_DIR = sandbox;
  resetJournalCollectionsForTests();
});

afterEach(() => {
  resetJournalCollectionsForTests();
  sqliteState.resetStateReadonlyReaderForTests();
  if (saved === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = saved;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const ledger = () => path.join(sandbox, "codex-reset-credits.ndjson");

function entry(n: number, outcome: ResetCreditJournalEntry["outcome"] = "reset"): ResetCreditJournalEntry {
  return {
    at: new Date(Date.UTC(2026, 10, 1) + n * 60_000).toISOString(),
    engine: "codex",
    accountId: `account-${n % 3}`,
    accountKind: "managed",
    actor: n % 2 ? { kind: "operator" } : { kind: "agent", conversationId: `conversation_${n}` },
    idempotencyKey: `attempt-${n}`,
    outcome,
    refusedLocally: false,
    before: { availableCount: 2, window: { usedPercent: 97, resetsAt: 1_800_000_000, windowDurationMins: 10_080 } },
    after: outcome === "consume_failed" ? null : { availableCount: 1, window: { usedPercent: 0, resetsAt: 1_800_600_000, windowDurationMins: 10_080 } },
    detail: outcome === "consume_failed" ? "the backend did not answer" : null,
  };
}

test("the current ledger imports, its rotated half stays, and reads answer newest first as before", async () => {
  fs.writeFileSync(`${ledger()}.1`, `${JSON.stringify(entry(0))}\n`);
  fs.writeFileSync(ledger(), [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => JSON.stringify(entry(n, n === 4 ? "consume_failed" : "reset"))).join("\n")
    + `\n{"at":"2026-11-02T00:00:00.000Z","engine":"cod`);
  const before = { all: readResetCreditJournal(), two: readResetCreditJournal(2) };
  expect(before.all.map((row) => row.idempotencyKey)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => `attempt-${n}`));

  expect(importLegacyResetCreditJournal(ledger())).toMatchObject({ state: "imported", record: { rowCount: 10 } });
  expect(fs.statSync(ledger()).isDirectory()).toBe(true);
  expect(fs.readFileSync(`${ledger()}.1`, "utf8")).toBe(`${JSON.stringify(entry(0))}\n`);
  expect({ all: readResetCreditJournal(), two: readResetCreditJournal(2) }).toEqual(before);

  expect(await appendResetCreditJournal(entry(10))).toBe(true);
  expect(readResetCreditJournal(2).map((row) => row.idempotencyKey)).toEqual(["attempt-10", "attempt-9"]);
});

test("a write that fails answers false and the ledger reads as it was", async () => {
  expect(await appendResetCreditJournal(entry(1))).toBe(true);
  const failing = spyOn(sqliteState.SqliteStateCollection.prototype, "patchSync").mockImplementation(() => { throw new Error("disk is full"); });
  const quiet = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    expect(await appendResetCreditJournal(entry(2))).toBe(false);
  } finally { failing.mockRestore(); quiet.mockRestore(); }
  expect(readResetCreditJournal().map((row) => row.idempotencyKey)).toEqual(["attempt-1"]);
});

test("the ledger keeps its newest entries", async () => {
  const imported = RESET_CREDIT_RETENTION + 2;
  fs.writeFileSync(ledger(), Array.from({ length: imported }, (_, n) => JSON.stringify(entry(n))).join("\n") + "\n");
  importLegacyResetCreditJournal(ledger());
  expect(readResetCreditJournal(RESET_CREDIT_RETENTION + 10)).toHaveLength(imported);
  // The next entry is the newest, and the oldest beyond the bound leave with it.
  expect(await appendResetCreditJournal(entry(imported))).toBe(true);
  const rows = readResetCreditJournal(RESET_CREDIT_RETENTION + 10);
  expect(rows).toHaveLength(RESET_CREDIT_RETENTION);
  expect(rows[0]!.idempotencyKey).toBe(`attempt-${imported}`);
  expect(rows.at(-1)!.idempotencyKey).toBe(`attempt-${imported - RESET_CREDIT_RETENTION + 1}`);
}, 60_000);

test("the rollback mirror is the ledger file, and entries an older release appends fold back in once", async () => {
  for (const n of [1, 2]) await appendResetCreditJournal(entry(n));
  checkpointResetCreditJournalRollbackMirrorForDemotion(ledger());
  expect(fs.readFileSync(ledger(), "utf8")).toBe(`${JSON.stringify(entry(1))}\n${JSON.stringify(entry(2))}\n`);
  expect(importLegacyResetCreditJournal(ledger())).toMatchObject({ state: "already-imported", incident: null });
  expect(fs.statSync(ledger()).isDirectory()).toBe(true);

  checkpointResetCreditJournalRollbackMirrorForDemotion(ledger());
  fs.appendFileSync(ledger(), `${JSON.stringify(entry(3, "consume_failed"))}\n`);
  expect(importLegacyResetCreditJournal(ledger())).toMatchObject({ incident: { kind: "legacy-reconciled", summary: { added: 1, kept: 2 } } });
  expect(readResetCreditJournal().map((row) => [row.idempotencyKey, row.outcome])).toEqual([
    ["attempt-3", "consume_failed"], ["attempt-2", "reset"], ["attempt-1", "reset"],
  ]);
});
