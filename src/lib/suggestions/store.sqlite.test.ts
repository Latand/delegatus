import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resetLegacyDocumentStoresForTests } from "@/lib/state/legacyDocumentStore";
import { readStateCollectionRevision, readStateImport, SqliteStateCollection } from "@/lib/state/sqliteStateStore";

import {
  checkpointReplySuggestionsRollbackMirrorForDemotion,
  importLegacyReplySuggestions,
  readReplySuggestionsFile,
  recordOperatorMessageAdmission,
  replySuggestionsFile,
} from "./store";

/* #1870 slice 5: admission receipts live in the `reply_suggestions`
   collection of the `state.sqlite` beside `reply-suggestions.json`. A record
   an older release wrote also holds reply-draft `sets`: they import without
   failing, are never read, and the next write drops their rows while the
   receipts stay. Every case runs in its own mkdtemp state directory through
   LLV_STATE_DIR, never the live one. */

let sandbox = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-suggestions-sqlite-"));
  process.env.LLV_STATE_DIR = sandbox;
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  resetLegacyDocumentStoresForTests();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const db = () => path.join(sandbox, "state.sqlite");
const kept = (prefix: string) => fs.readdirSync(sandbox).filter((name) => name.startsWith(prefix));
const ORIGIN = { kind: "manager", conversationId: "conversation_seat", role: "orchestrator" };
const ADMISSION = { conversationId: "conversation_a", key: "client-message-1", at: "2026-09-22T09:10:00.000Z" };

/** `reply-suggestions.json` as a release with reply drafts wrote it. */
function seedLegacy() {
  const file = {
    schemaVersion: 1,
    revision: 9,
    updatedAt: "2026-09-22T10:00:00.000Z",
    sets: [
      { conversationId: "conversation_a", setId: "rsg_a", at: "2026-09-22T09:00:00.000Z", origin: ORIGIN, replies: [{ label: "yes", text: "Yes." }] },
      { conversationId: "conversation_b", setId: "rsg_b", at: "2026-09-22T09:30:00.000Z", origin: ORIGIN, replies: [{ label: "hold", text: "Hold." }] },
    ],
    admissions: [ADMISSION],
  };
  fs.writeFileSync(replySuggestionsFile(), `${JSON.stringify(file, null, 2)}\n`);
  return file;
}

function writeJson(filePath: string, value: unknown): void {
  fs.rmSync(filePath, { recursive: true, force: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/** The collection's rows as SQLite holds them, past the store's own reading. */
function rawCollection() {
  return new SqliteStateCollection<{ key: string; value: unknown }>(db(), {
    collection: "reply_suggestions", schemaVersion: 1, busyMessage: "busy",
    key: (row) => row.key, decode: (value) => value as { key: string; value: unknown }, clone: structuredClone, strictDecode: false,
  });
}
const rowKeys = () => rawCollection().snapshot().map((row) => row.key);

describe("import once", () => {
  test("a file holding reply drafts imports, keeps its receipts and reads no drafts", () => {
    seedLegacy();

    expect(readReplySuggestionsFile()).toEqual({ schemaVersion: 1, revision: 9, updatedAt: "2026-09-22T10:00:00.000Z", admissions: [ADMISSION] });
    expect(readStateImport(db(), "reply_suggestions")).toMatchObject({ sourceName: "reply-suggestions.json", gap: null });
    expect(fs.statSync(replySuggestionsFile()).isDirectory()).toBe(true);
    expect(kept("reply-suggestions.json.imported-")).toHaveLength(1);

    resetLegacyDocumentStoresForTests();
    expect(importLegacyReplySuggestions().state).toBe("already-imported");
    expect(readReplySuggestionsFile().admissions).toEqual([ADMISSION]);
  });
});

describe("stored reply drafts", () => {
  test("set rows an older release stored are ignored, and the next write drops only them", () => {
    seedLegacy();
    readReplySuggestionsFile();
    /* The older release's import wrote one row per set beside the receipt. */
    rawCollection().boundedPatch(1, (tx) => tx.put({ key: "s:conversation_c", value: { conversationId: "conversation_c", setId: "rsg_c" } }));
    resetLegacyDocumentStoresForTests();
    expect(readReplySuggestionsFile().admissions).toEqual([ADMISSION]);

    expect(recordOperatorMessageAdmission("conversation_a", new Date("2026-09-22T10:05:00.000Z"), "client-message-2")).toBe(true);
    resetLegacyDocumentStoresForTests();
    expect(rowKeys().filter((key) => key.startsWith("s:"))).toEqual([]);
    expect(readReplySuggestionsFile().admissions.map((entry) => entry.key)).toEqual(["client-message-1", "client-message-2"]);
    expect(readReplySuggestionsFile().revision).toBe(10);
  });
});

describe("replay dedupe", () => {
  test("an admission receipt imported from the file still pins a replayed message to its first admission", () => {
    seedLegacy();
    expect(recordOperatorMessageAdmission("conversation_a", new Date("2026-09-22T09:25:00.000Z"), "client-message-1")).toBe(false);
    expect(readReplySuggestionsFile().admissions).toEqual([ADMISSION]);
  });
});

describe("revision", () => {
  test("the record revision continues from the file's, and each write bumps the collection once", () => {
    seedLegacy();
    readReplySuggestionsFile();
    const collection = readStateCollectionRevision(db(), "reply_suggestions");

    recordOperatorMessageAdmission("conversation_c", new Date("2026-09-22T10:05:00.000Z"), "client-message-3");
    expect(readReplySuggestionsFile().revision).toBe(10);
    expect(readStateCollectionRevision(db(), "reply_suggestions")).toBe(collection! + 1);

    /* A replay writes nothing. */
    recordOperatorMessageAdmission("conversation_c", new Date("2026-09-22T10:06:00.000Z"), "client-message-3");
    expect(readStateCollectionRevision(db(), "reply_suggestions")).toBe(collection! + 1);
  });
});

describe("corrupted sources", () => {
  test("a NUL-filled file imports as a gap, is kept aside, and reads as empty", () => {
    fs.writeFileSync(replySuggestionsFile(), Buffer.alloc(1024, 0));

    expect(readReplySuggestionsFile().admissions).toEqual([]);
    expect(readStateImport(db(), "reply_suggestions")?.gap).toBe("legacy-unreadable");
    expect(kept("reply-suggestions.json.unreadable-")).toHaveLength(1);
  });

  test("a corrupted file that reappears after the import never overwrites the database", () => {
    seedLegacy();
    const imported = readReplySuggestionsFile();
    fs.rmSync(replySuggestionsFile(), { recursive: true, force: true });
    fs.writeFileSync(replySuggestionsFile(), "{ truncated");

    importLegacyReplySuggestions(replySuggestionsFile(), { reconcile: true });
    resetLegacyDocumentStoresForTests();
    expect(readReplySuggestionsFile()).toEqual(imported);
    expect(fs.statSync(replySuggestionsFile()).isDirectory()).toBe(true);
  });
});

describe("rollback mirror", () => {
  test("the mirror keeps an empty sets array an older release needs, and its new receipt folds back", () => {
    seedLegacy();
    readReplySuggestionsFile();
    checkpointReplySuggestionsRollbackMirrorForDemotion();
    const mirror = JSON.parse(fs.readFileSync(replySuggestionsFile(), "utf8")) as Record<string, unknown> & { admissions: unknown[] };
    expect(mirror.revision).toBe(9);
    /* A release that predates #1870 reads a file without `sets` as empty. */
    expect(mirror.sets).toEqual([]);

    writeJson(replySuggestionsFile(), {
      ...mirror,
      revision: 11,
      sets: [{ conversationId: "conversation_c", setId: "rsg_c", at: "2026-09-22T10:10:00.000Z", origin: ORIGIN, replies: [{ label: "ok", text: "OK." }] }],
      admissions: [...mirror.admissions, { conversationId: "conversation_c", key: "client-message-2", at: "2026-09-22T10:11:00.000Z" }],
    });
    expect(importLegacyReplySuggestions(replySuggestionsFile(), { reconcile: true }).incident?.kind).toBe("legacy-reconciled");
    resetLegacyDocumentStoresForTests();

    const merged = readReplySuggestionsFile();
    expect(merged.revision).toBe(11);
    expect(merged.admissions.map((entry) => entry.key)).toEqual(["client-message-1", "client-message-2"]);
    expect(rowKeys().filter((key) => key.startsWith("s:"))).toEqual([]);
    expect(fs.statSync(replySuggestionsFile()).isDirectory()).toBe(true);
  });
});
