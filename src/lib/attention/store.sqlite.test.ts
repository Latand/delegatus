import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resetLegacyDocumentStoresForTests } from "@/lib/state/legacyDocumentStore";
import { stateImportIncidents } from "@/lib/state/legacyImport";
import { readStateCollectionRevision, readStateImport } from "@/lib/state/sqliteStateStore";

import {
  attentionFile,
  AttentionStoreError,
  checkpointAttentionRollbackMirrorForDemotion,
  createAttentionRequest,
  importLegacyAttention,
  readAttentionFile,
  transitionAttentionRequest,
  type AttentionCreateInput,
} from "./store";
import { ATTENTION_SCHEMA_VERSION, type AttentionFileV1, type AttentionRequestV1 } from "./types";

/* #1870 slice 5: attention requests live in the `attention` collection of the
   `state.sqlite` beside `attention.json`. Every case runs in its own mkdtemp
   state directory through LLV_STATE_DIR, never the live one. */

let sandbox = "";
let previousStateDir: string | undefined;
const T0 = new Date("2026-09-22T10:00:00.000Z");

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-attention-sqlite-"));
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

function input(overrides: Partial<AttentionCreateInput> = {}): AttentionCreateInput {
  return {
    rootId: "root_fixed",
    origin: "root-agent",
    target: { kind: "conversation", path: "/tmp/reviewer.jsonl" },
    frameAtCreation: { project: "demo", rect: { x: 0, y: 0, w: 600, h: 780 }, boardRevision: 4 },
    intent: "show",
    reason: "The reviewer finished with request-changes.",
    ...overrides,
  };
}

/** A legacy record whose revision is well past anything a fresh store reaches. */
function seedLegacy(revision = 57): AttentionFileV1 {
  resetLegacyDocumentStoresForTests();
  const { request } = createAttentionRequest(input(), { now: T0, id: "attention_seed", filePath: path.join(fs.mkdtempSync(path.join(sandbox, "seed-")), "attention.json") });
  const file: AttentionFileV1 = {
    schemaVersion: ATTENTION_SCHEMA_VERSION,
    revision,
    updatedAt: T0.toISOString(),
    requests: [{ ...request, operationKey: "op-seeded" }],
  };
  fs.writeFileSync(attentionFile(), `${JSON.stringify(file, null, 2)}\n`);
  return file;
}

function writeJson(filePath: string, value: unknown): void {
  fs.rmSync(filePath, { recursive: true, force: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

describe("import once", () => {
  test("the first touch imports attention.json, keeps the file and leaves a tombstone", () => {
    const seeded = seedLegacy();

    expect(readAttentionFile()).toEqual(seeded);
    const record = readStateImport(db(), "attention");
    expect(record).toMatchObject({ sourceName: "attention.json", rowCount: 2, gap: null });
    expect(fs.statSync(attentionFile()).isDirectory()).toBe(true);
    expect(kept("attention.json.imported-")).toHaveLength(1);
  });

  test("a restart and the activation import never import again", () => {
    seedLegacy();
    readAttentionFile();
    const record = readStateImport(db(), "attention");
    resetLegacyDocumentStoresForTests();

    expect(importLegacyAttention().state).toBe("already-imported");
    expect(readAttentionFile().requests.map((request) => request.id)).toEqual(["attention_seed"]);
    expect(readStateImport(db(), "attention")).toEqual(record);
    expect(kept("attention.json.imported-")).toHaveLength(1);
  });

  test("an install with no attention.json starts empty and a write needs no file", () => {
    expect(readAttentionFile(undefined, T0)).toMatchObject({ revision: 0, requests: [] });
    createAttentionRequest(input(), { now: T0, id: "attention_1" });
    expect(readAttentionFile().revision).toBe(1);
    expect(readStateImport(db(), "attention")?.sourceSha256).toBeNull();
  });
});

describe("revision", () => {
  test("the attention revision is monotonic across the import: it continues from the file's", () => {
    seedLegacy(57);
    expect(readAttentionFile().revision).toBe(57);

    createAttentionRequest(input({ rootId: "root_other" }), { now: T0, id: "attention_next" });
    expect(readAttentionFile().revision).toBe(58);
    transitionAttentionRequest("attention_next", { kind: "offer", deviceId: "device-a" }, { now: T0 });
    expect(readAttentionFile().revision).toBe(59);
  });

  test("a write bumps the collection revision; a no-op transition and a read do not", () => {
    createAttentionRequest(input(), { now: T0, id: "attention_1" });
    const revision = readStateCollectionRevision(db(), "attention");

    readAttentionFile();
    expect(transitionAttentionRequest("attention_missing", { kind: "offer", deviceId: "device-a" }, { now: T0 }))
      .toEqual({ ok: false, reason: "not-found" });
    expect(readStateCollectionRevision(db(), "attention")).toBe(revision);

    transitionAttentionRequest("attention_1", { kind: "offer", deviceId: "device-a" }, { now: T0 });
    expect(readStateCollectionRevision(db(), "attention")).toBe(revision! + 1);
  });
});

describe("replay dedupe", () => {
  test("request_attention's operation key adopts the imported request instead of raising a twin", () => {
    seedLegacy();

    const replay = createAttentionRequest(input({ operationKey: "op-seeded" }), { now: T0 });
    expect(replay.adopted).toBe(true);
    expect(replay.request.id).toBe("attention_seed");
    expect(readAttentionFile().requests).toHaveLength(1);
    expect(readAttentionFile().revision).toBe(57);
  });
});

describe("corrupted sources", () => {
  test("a NUL-filled attention.json imports as a gap, is kept aside, and the store serves empty", () => {
    fs.writeFileSync(attentionFile(), Buffer.alloc(2048, 0));
    const before = stateImportIncidents().length;

    expect(readAttentionFile().requests).toEqual([]);
    expect(readStateImport(db(), "attention")?.gap).toBe("legacy-unreadable");
    expect(stateImportIncidents().slice(before).some((entry) => entry.collection === "attention")).toBe(true);
    expect(kept("attention.json.unreadable-")).toHaveLength(1);
    expect(createAttentionRequest(input(), { now: T0, id: "attention_after" }).request.id).toBe("attention_after");
  });

  test("a corrupted file that reappears after the import never overwrites the database", () => {
    seedLegacy();
    createAttentionRequest(input({ rootId: "root_other" }), { now: T0, id: "attention_kept" });
    const held = readAttentionFile();
    const revision = readStateCollectionRevision(db(), "attention");

    fs.rmSync(attentionFile(), { recursive: true, force: true });
    fs.writeFileSync(attentionFile(), "{ truncated");
    importLegacyAttention(attentionFile(), { reconcile: true });
    resetLegacyDocumentStoresForTests();

    expect(readAttentionFile()).toEqual(held);
    expect(readStateCollectionRevision(db(), "attention")).toBe(revision);
    expect(kept("attention.json.unreadable-")).toHaveLength(1);
    expect(fs.statSync(attentionFile()).isDirectory()).toBe(true);
  });

  test("valid JSON from an unknown schema refuses the import and leaves the file untouched", () => {
    const body = JSON.stringify({ schemaVersion: 99, revision: 0, updatedAt: "", requests: [] });
    fs.writeFileSync(attentionFile(), body);

    expect(() => readAttentionFile()).toThrow(AttentionStoreError);
    expect(fs.readFileSync(attentionFile(), "utf8")).toBe(body);
    expect(readStateImport(db(), "attention")).toBeNull();
  });
});

describe("rollback mirror", () => {
  test("the mirror carries the revision, and a rollback release's writes fold back on roll-forward", () => {
    seedLegacy(57);
    createAttentionRequest(input({ rootId: "root_other" }), { now: T0, id: "attention_two" });
    checkpointAttentionRollbackMirrorForDemotion();

    expect(fs.statSync(attentionFile()).isFile()).toBe(true);
    const mirror = JSON.parse(fs.readFileSync(attentionFile(), "utf8")) as AttentionFileV1;
    expect(mirror.revision).toBe(58);
    expect(mirror.requests.map((request) => request.id)).toEqual(["attention_seed", "attention_two"]);

    /* The rollback release offers one request and raises another. */
    const offered: AttentionRequestV1 = { ...mirror.requests[1]!, state: "offered", offeredTo: ["device-a"], revision: 1 };
    const raised: AttentionRequestV1 = { ...mirror.requests[1]!, id: "attention_three", requestedBy: { rootId: "root_third" } };
    writeJson(attentionFile(), { ...mirror, revision: 60, requests: [mirror.requests[0], offered, raised] });

    expect(importLegacyAttention(attentionFile(), { reconcile: true }).incident?.kind).toBe("legacy-reconciled");
    resetLegacyDocumentStoresForTests();

    const merged = readAttentionFile();
    expect(merged.revision).toBe(60);
    expect(merged.requests.map((request) => [request.id, request.state])).toEqual([
      ["attention_seed", "pending"],
      ["attention_two", "offered"],
      ["attention_three", "pending"],
    ]);
    expect(fs.statSync(attentionFile()).isDirectory()).toBe(true);
    expect(readStateImport(db(), "attention")?.mirrorRevision).not.toBeNull();
    createAttentionRequest(input({ rootId: "root_fourth" }), { now: T0, id: "attention_four" });
    expect(readAttentionFile().revision).toBe(61);
  });

  test("a legacy file with a lower revision never moves the revision back", () => {
    seedLegacy(57);
    readAttentionFile();
    checkpointAttentionRollbackMirrorForDemotion();
    /* An older writer that found the path empty mid-retire starts a record of its own. */
    const fresh = JSON.parse(fs.readFileSync(attentionFile(), "utf8")) as AttentionFileV1;
    writeJson(attentionFile(), { ...fresh, revision: 1, requests: [{ ...fresh.requests[0]!, id: "attention_fresh", operationKey: "op-fresh" }] });

    importLegacyAttention(attentionFile(), { reconcile: true });
    resetLegacyDocumentStoresForTests();

    const merged = readAttentionFile();
    expect(merged.revision).toBe(57);
    /* A file that lacks a row proves nothing about it: the seeded request stays. */
    expect(merged.requests.map((request) => request.id)).toEqual(["attention_seed", "attention_fresh"]);
  });

  test("an untouched mirror is retired on roll-forward without a merge", () => {
    seedLegacy();
    readAttentionFile();
    checkpointAttentionRollbackMirrorForDemotion();
    expect(importLegacyAttention(attentionFile(), { reconcile: true }).incident).toBeNull();
    expect(fs.statSync(attentionFile()).isDirectory()).toBe(true);
  });
});
