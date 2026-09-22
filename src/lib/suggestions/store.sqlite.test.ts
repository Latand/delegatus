import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resetLegacyDocumentStoresForTests } from "@/lib/state/legacyDocumentStore";
import { readStateCollectionRevision, readStateImport } from "@/lib/state/sqliteStateStore";

import {
  checkpointReplySuggestionsRollbackMirrorForDemotion,
  importLegacyReplySuggestions,
  readReplySuggestions,
  readReplySuggestionsFile,
  recordReplySuggestions,
  replySuggestionsFile,
  retireReplySuggestionsOnOperatorMessage,
} from "./store";
import type { ReplySuggestionsFileV1 } from "./types";

/* #1870 slice 5: reply-draft sets and admission receipts live in the
   `reply_suggestions` collection of the `state.sqlite` beside
   `reply-suggestions.json`. Every case runs in its own mkdtemp state
   directory through LLV_STATE_DIR, never the live one. */

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
const MANAGER = { kind: "manager", conversationId: "conversation_seat", role: "orchestrator" } as const;

function seedLegacy(): ReplySuggestionsFileV1 {
  const file: ReplySuggestionsFileV1 = {
    schemaVersion: 1,
    revision: 9,
    updatedAt: "2026-09-22T10:00:00.000Z",
    sets: [
      { conversationId: "conversation_a", setId: "rsg_a", at: "2026-09-22T09:00:00.000Z", origin: MANAGER, replies: [{ label: "yes", text: "Yes." }] },
      { conversationId: "conversation_b", setId: "rsg_b", at: "2026-09-22T09:30:00.000Z", origin: MANAGER, replies: [{ label: "hold", text: "Hold." }] },
    ],
    admissions: [{ conversationId: "conversation_a", key: "client-message-1", at: "2026-09-22T09:10:00.000Z" }],
  };
  fs.writeFileSync(replySuggestionsFile(), `${JSON.stringify(file, null, 2)}\n`);
  return file;
}

function writeJson(filePath: string, value: unknown): void {
  fs.rmSync(filePath, { recursive: true, force: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

describe("import once", () => {
  test("the first touch imports the sets and receipts, keeps the file and leaves a tombstone", () => {
    const seeded = seedLegacy();

    expect(readReplySuggestionsFile()).toEqual(seeded);
    expect(readStateImport(db(), "reply_suggestions")).toMatchObject({ sourceName: "reply-suggestions.json", rowCount: 4, gap: null });
    expect(fs.statSync(replySuggestionsFile()).isDirectory()).toBe(true);
    expect(kept("reply-suggestions.json.imported-")).toHaveLength(1);

    resetLegacyDocumentStoresForTests();
    expect(importLegacyReplySuggestions().state).toBe("already-imported");
    expect(readReplySuggestionsFile()).toEqual(seeded);
  });

  test("two sets for one conversation, written by older code, import as the newer one", () => {
    const seeded = seedLegacy();
    writeJson(replySuggestionsFile(), { ...seeded, sets: [...seeded.sets, { ...seeded.sets[0]!, setId: "rsg_a2", at: "2026-09-22T09:45:00.000Z" }] });

    expect(readReplySuggestionsFile().sets.map((set) => set.setId)).toEqual(["rsg_b", "rsg_a2"]);
  });
});

describe("replay dedupe", () => {
  test("an admission receipt imported from the file still pins a replayed message to its first admission", () => {
    seedLegacy();
    /* The manager's newer offer came after the operator's message was first admitted at 09:10. */
    recordReplySuggestions({ conversationId: "conversation_a", replies: [{ label: "go", text: "Go." }], origin: MANAGER, at: new Date("2026-09-22T09:20:00.000Z") });

    const replay = retireReplySuggestionsOnOperatorMessage("conversation_a", new Date("2026-09-22T09:25:00.000Z"), "client-message-1");
    expect(replay.cleared).toBe(false);
    expect(readReplySuggestions("conversation_a")?.replies).toEqual([{ label: "go", text: "Go." }]);
    expect(readReplySuggestionsFile().admissions.filter((entry) => entry.key === "client-message-1")).toHaveLength(1);
  });

  test("a replaced set moves behind the others, so the capacity trim still drops the oldest", () => {
    seedLegacy();
    recordReplySuggestions({ conversationId: "conversation_a", replies: [{ label: "go", text: "Go." }], origin: MANAGER, at: new Date("2026-09-22T10:05:00.000Z") });
    resetLegacyDocumentStoresForTests();

    expect(readReplySuggestionsFile().sets.map((set) => set.conversationId)).toEqual(["conversation_b", "conversation_a"]);
  });
});

describe("revision", () => {
  test("the record revision continues from the file's, and each write bumps the collection once", () => {
    seedLegacy();
    readReplySuggestionsFile();
    const collection = readStateCollectionRevision(db(), "reply_suggestions");

    recordReplySuggestions({ conversationId: "conversation_c", replies: [{ label: "yes", text: "Yes." }], origin: MANAGER, at: new Date("2026-09-22T10:05:00.000Z") });
    expect(readReplySuggestionsFile().revision).toBe(10);
    expect(readStateCollectionRevision(db(), "reply_suggestions")).toBe(collection! + 1);

    /* A clear with nothing to clear writes nothing. */
    retireReplySuggestionsOnOperatorMessage("conversation_quiet", new Date("2026-09-22T10:06:00.000Z"));
    expect(readStateCollectionRevision(db(), "reply_suggestions")).toBe(collection! + 1);
  });
});

describe("corrupted sources", () => {
  test("a NUL-filled file imports as a gap, is kept aside, and reads as no suggestions", () => {
    fs.writeFileSync(replySuggestionsFile(), Buffer.alloc(1024, 0));

    expect(readReplySuggestions("conversation_a")).toBeNull();
    expect(readStateImport(db(), "reply_suggestions")?.gap).toBe("legacy-unreadable");
    expect(kept("reply-suggestions.json.unreadable-")).toHaveLength(1);
  });

  test("a corrupted file that reappears after the import never overwrites the database", () => {
    const seeded = seedLegacy();
    readReplySuggestionsFile();
    fs.rmSync(replySuggestionsFile(), { recursive: true, force: true });
    fs.writeFileSync(replySuggestionsFile(), "{ truncated");

    importLegacyReplySuggestions(replySuggestionsFile(), { reconcile: true });
    resetLegacyDocumentStoresForTests();
    expect(readReplySuggestionsFile()).toEqual(seeded);
    expect(fs.statSync(replySuggestionsFile()).isDirectory()).toBe(true);
  });
});

describe("rollback mirror", () => {
  test("a rollback release's new set and receipt fold back on roll-forward, with the larger revision", () => {
    seedLegacy();
    readReplySuggestionsFile();
    checkpointReplySuggestionsRollbackMirrorForDemotion();
    const mirror = JSON.parse(fs.readFileSync(replySuggestionsFile(), "utf8")) as ReplySuggestionsFileV1;
    expect(mirror.revision).toBe(9);

    writeJson(replySuggestionsFile(), {
      ...mirror,
      revision: 11,
      sets: [...mirror.sets, { conversationId: "conversation_c", setId: "rsg_c", at: "2026-09-22T10:10:00.000Z", origin: MANAGER, replies: [{ label: "ok", text: "OK." }] }],
      admissions: [...mirror.admissions, { conversationId: "conversation_c", key: "client-message-2", at: "2026-09-22T10:11:00.000Z" }],
    });
    expect(importLegacyReplySuggestions(replySuggestionsFile(), { reconcile: true }).incident?.kind).toBe("legacy-reconciled");
    resetLegacyDocumentStoresForTests();

    const merged = readReplySuggestionsFile();
    expect(merged.revision).toBe(11);
    expect(merged.sets.map((set) => set.setId)).toEqual(["rsg_a", "rsg_b", "rsg_c"]);
    expect(merged.admissions.map((entry) => entry.key)).toEqual(["client-message-1", "client-message-2"]);
    expect(fs.statSync(replySuggestionsFile()).isDirectory()).toBe(true);
  });
});
