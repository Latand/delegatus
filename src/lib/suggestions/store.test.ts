import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FileTransactionBusyError } from "@/lib/state/fileTransaction";
import { resetLegacyDocumentStoresForTests, setLegacyDocumentWriteHookForTests } from "@/lib/state/legacyDocumentStore";
import { readStateImport } from "@/lib/state/sqliteStateStore";

import { readReplySuggestionsFile, recordOperatorMessageAdmission, replySuggestionsFile } from "./store";
import { REPLY_SUGGESTION_ADMISSION_CAPACITY } from "./types";

/*
 * The admission receipts of operator messages: when each keyed message to a
 * conversation was first accepted. Needs-you, the attention reconcile and the
 * bridge's open asks read them; the reply drafts the record once held are gone.
 */

let sandbox = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-suggestions-"));
  process.env.LLV_STATE_DIR = sandbox;
});
afterEach(() => {
  setLegacyDocumentWriteHookForTests(null);
  resetLegacyDocumentStoresForTests();
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("an operator message's first admission is recorded once under its key", () => {
  expect(recordOperatorMessageAdmission("conversation_a", new Date("2026-08-26T10:02:00.000Z"), "client-message-7")).toBe(true);
  /* The client retried the same message: its moment stays the first one. */
  expect(recordOperatorMessageAdmission("conversation_a", new Date("2026-08-26T10:05:00.000Z"), "client-message-7")).toBe(false);
  expect(readReplySuggestionsFile().admissions).toEqual([
    { conversationId: "conversation_a", key: "client-message-7", at: "2026-08-26T10:02:00.000Z" },
  ]);
  /* The same key in another conversation is another message. */
  expect(recordOperatorMessageAdmission("conversation_b", new Date("2026-08-26T10:06:00.000Z"), "client-message-7")).toBe(true);
  expect(readReplySuggestionsFile().admissions).toHaveLength(2);
});

test("a message without a key, or without a conversation, records nothing", () => {
  expect(recordOperatorMessageAdmission("conversation_a", new Date(), "")).toBe(false);
  expect(recordOperatorMessageAdmission("conversation_a", new Date(), "   ")).toBe(false);
  expect(recordOperatorMessageAdmission("", new Date(), "client-message-1")).toBe(false);
  expect(fs.existsSync(path.join(sandbox, "state.sqlite"))).toBe(false);
});

test("only the recent message keys are kept: the record is a replay window, not a history", () => {
  for (let index = 0; index < REPLY_SUGGESTION_ADMISSION_CAPACITY + 5; index += 1) {
    recordOperatorMessageAdmission("conversation_a", new Date(Date.UTC(2026, 7, 26, 10, 0, index)), `client-message-${index}`);
  }
  const admissions = readReplySuggestionsFile().admissions;
  expect(admissions).toHaveLength(REPLY_SUGGESTION_ADMISSION_CAPACITY);
  expect(admissions[0]!.key).toBe("client-message-5");
});

test("a record that cannot be written never fails the send that admitted the message", () => {
  setLegacyDocumentWriteHookForTests(() => {
    throw new FileTransactionBusyError("reply suggestions are busy");
  });
  expect(recordOperatorMessageAdmission("conversation_a", new Date("2026-08-26T10:02:00.000Z"), "blocked-1")).toBe(false);
  setLegacyDocumentWriteHookForTests(null);
  expect(readReplySuggestionsFile().admissions).toEqual([]);
});

test("the record survives in the state dir's database", () => {
  recordOperatorMessageAdmission("conversation_a", new Date("2026-08-26T10:00:00.000Z"), "client-message-1");

  /* #1870 slice 5: the record is the `reply_suggestions` collection of the
     `state.sqlite` beside where the file lived. */
  expect(replySuggestionsFile().startsWith(sandbox)).toBe(true);
  expect(readStateImport(path.join(sandbox, "state.sqlite"), "reply_suggestions")).not.toBeNull();
  const stored = readReplySuggestionsFile();
  expect(stored.schemaVersion).toBe(1);
  expect(stored.revision).toBe(1);
  expect(stored.admissions).toHaveLength(1);
});

test("an unreadable record reads as empty, and the next write recovers it", () => {
  fs.mkdirSync(path.dirname(replySuggestionsFile()), { recursive: true });
  fs.writeFileSync(replySuggestionsFile(), "{not json", "utf8");

  expect(readReplySuggestionsFile().admissions).toEqual([]);
  expect(recordOperatorMessageAdmission("conversation_a", new Date("2026-08-26T10:00:00.000Z"), "client-message-1")).toBe(true);
  expect(readReplySuggestionsFile().admissions).toHaveLength(1);
});
