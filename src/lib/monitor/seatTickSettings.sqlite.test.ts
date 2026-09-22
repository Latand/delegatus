import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { recordRevision } from "@/lib/mcp/listAnswers";
import { resetLegacyDocumentStoresForTests } from "@/lib/state/legacyDocumentStore";
import { readStateCollectionRevision, readStateImport } from "@/lib/state/sqliteStateStore";

import {
  checkpointSeatTickSettingsRollbackMirrorForDemotion,
  defaultSeatTickSettings,
  importLegacySeatTickSettings,
  readSeatTickSettings,
  readSeatTickSettingsFile,
  writeSeatTickSettings,
  type SeatTickSettings,
} from "./seatTickSettings";

/* #1870 slice 5: per-project tick settings live in the `seat_tick_settings`
   collection of the `state.sqlite` beside `seat-tick-settings.json`. Every
   case runs in its own mkdtemp state directory, never the live one. */

let sandbox = "";
let file = "";
const saved = { LLV_STATE_DIR: process.env.LLV_STATE_DIR, LLV_SEAT_TICK_SETTINGS_FILE: process.env.LLV_SEAT_TICK_SETTINGS_FILE };

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-seat-tick-settings-sqlite-"));
  process.env.LLV_STATE_DIR = sandbox;
  delete process.env.LLV_SEAT_TICK_SETTINGS_FILE;
  file = path.join(sandbox, "seat-tick-settings.json");
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetLegacyDocumentStoresForTests();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const db = () => path.join(sandbox, "state.sqlite");
const kept = (prefix: string) => fs.readdirSync(sandbox).filter((name) => name.startsWith(prefix));

const QUIET: SeatTickSettings = {
  project: "repo-alpha",
  enabled: false,
  wakeIntervalMinutes: null,
  reason: "nothing here until the release lands",
  monitorPrompt: "watch the release lane",
  until: null,
  updatedAt: "2026-09-22T09:00:00.000Z",
  setBy: { kind: "manager", conversationId: "conversation_seat", project: "repo-alpha", seatEpoch: 3 },
};

function seedLegacy(): void {
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, projects: { "repo-alpha": QUIET } }, null, 2)}\n`);
}

function writeJson(filePath: string, value: unknown): void {
  fs.rmSync(filePath, { recursive: true, force: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

describe("import once", () => {
  test("the first touch imports every project's row, keeps the file and leaves a tombstone", () => {
    seedLegacy();

    expect(readSeatTickSettings("repo-alpha")).toEqual(QUIET);
    expect(readStateImport(db(), "seat_tick_settings")).toMatchObject({ sourceName: "seat-tick-settings.json", rowCount: 1, gap: null });
    expect(fs.statSync(file).isDirectory()).toBe(true);
    expect(kept("seat-tick-settings.json.imported-")).toHaveLength(1);

    resetLegacyDocumentStoresForTests();
    expect(importLegacySeatTickSettings().state).toBe("already-imported");
    expect(readSeatTickSettingsFile()).toEqual({ "repo-alpha": QUIET });
  });
});

describe("revision", () => {
  test("the seat_tick_settings revision of an imported row is the one the file's row answered", () => {
    seedLegacy();
    const before = recordRevision(QUIET);

    expect(recordRevision(readSeatTickSettings("repo-alpha"))).toBe(before);
  });

  test("a write bumps the collection once and touches only its own project's row", () => {
    seedLegacy();
    readSeatTickSettings("repo-alpha");
    const revision = readStateCollectionRevision(db(), "seat_tick_settings");

    writeSeatTickSettings("repo-beta", { ...defaultSeatTickSettings("repo-beta"), monitorPrompt: "beta note", updatedAt: "2026-09-22T10:00:00.000Z" });
    expect(readStateCollectionRevision(db(), "seat_tick_settings")).toBe(revision! + 1);
    expect(readSeatTickSettings("repo-alpha")).toEqual(QUIET);

    /* Writing a row exactly as it stands is not a change. */
    writeSeatTickSettings("repo-alpha", QUIET);
    expect(readStateCollectionRevision(db(), "seat_tick_settings")).toBe(revision! + 1);
  });
});

describe("corrupted sources", () => {
  test("a NUL-filled settings file imports as a gap and every project reads its defaults", () => {
    fs.writeFileSync(file, Buffer.alloc(512, 0));

    expect(readSeatTickSettings("repo-alpha")).toEqual(defaultSeatTickSettings("repo-alpha"));
    expect(readStateImport(db(), "seat_tick_settings")?.gap).toBe("legacy-unreadable");
    expect(kept("seat-tick-settings.json.unreadable-")).toHaveLength(1);
  });

  test("a corrupted file that reappears after the import never overwrites the database", () => {
    seedLegacy();
    readSeatTickSettings("repo-alpha");
    fs.rmSync(file, { recursive: true, force: true });
    fs.writeFileSync(file, "{ truncated");

    importLegacySeatTickSettings(file, { reconcile: true });
    resetLegacyDocumentStoresForTests();
    expect(readSeatTickSettings("repo-alpha")).toEqual(QUIET);
    expect(fs.statSync(file).isDirectory()).toBe(true);
  });
});

describe("rollback mirror", () => {
  test("a rollback release's change to a project folds back on roll-forward", () => {
    seedLegacy();
    readSeatTickSettings("repo-alpha");
    checkpointSeatTickSettingsRollbackMirrorForDemotion();
    const mirror = JSON.parse(fs.readFileSync(file, "utf8")) as { version: number; projects: Record<string, SeatTickSettings> };
    expect(mirror.projects["repo-alpha"]).toEqual(QUIET);

    const restored = { ...defaultSeatTickSettings("repo-alpha"), updatedAt: "2026-09-22T11:00:00.000Z" };
    writeJson(file, { version: 1, projects: { "repo-alpha": restored } });
    expect(importLegacySeatTickSettings(file, { reconcile: true }).incident?.kind).toBe("legacy-reconciled");
    resetLegacyDocumentStoresForTests();

    expect(readSeatTickSettings("repo-alpha")).toEqual(restored);
    expect(fs.statSync(file).isDirectory()).toBe(true);
  });

  test("a row SQLite changed after the mirror is kept over the rollback release's older one", () => {
    seedLegacy();
    readSeatTickSettings("repo-alpha");
    checkpointSeatTickSettingsRollbackMirrorForDemotion();
    const newer = { ...QUIET, reason: "still quiet, now for the migration" };
    /* A new-code MCP process writes during the rollback window. */
    writeSeatTickSettings("repo-alpha", newer);
    writeJson(file, { version: 1, projects: { "repo-alpha": { ...QUIET, enabled: true, reason: null } } });

    const outcome = importLegacySeatTickSettings(file, { reconcile: true });
    expect(outcome.incident?.summary?.conflicts).toEqual(["p:repo-alpha"]);
    resetLegacyDocumentStoresForTests();
    expect(readSeatTickSettings("repo-alpha")).toEqual(newer);
  });
});
