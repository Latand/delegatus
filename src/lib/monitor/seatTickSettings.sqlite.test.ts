import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { recordRevision } from "@/lib/mcp/listAnswers";
import { LegacyDocumentStore, resetLegacyDocumentStoresForTests } from "@/lib/state/legacyDocumentStore";
import { readStateCollectionRevision, readStateImport } from "@/lib/state/sqliteStateStore";

import {
  changeSeatTickSettings,
  checkpointSeatTickSettingsRollbackMirrorForDemotion,
  defaultSeatTickSettings,
  effectiveCurationSetting,
  importLegacySeatTickSettings,
  readSeatTickCurationSetting,
  readSeatTickSettings,
  readSeatTickSettingsFile,
  readTurboSettings,
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
  instructionLines: [{ text: "nothing here until the release lands", author: null, at: null }],
};

function seedLegacy(): void {
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, projects: { "repo-alpha": { ...QUIET, instructionLines: undefined } } }, null, 2)}\n`);
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
  test("the imported row revision includes its explicit unknown line attribution", () => {
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
    const newer = { ...QUIET, reason: "still quiet, now for the migration", instructionLines: [{ text: "still quiet, now for the migration", author: null, at: null }] };
    /* A new-code MCP process writes during the rollback window. */
    writeSeatTickSettings("repo-alpha", newer);
    writeJson(file, { version: 1, projects: { "repo-alpha": { ...QUIET, enabled: true, reason: null } } });

    const outcome = importLegacySeatTickSettings(file, { reconcile: true });
    expect(outcome.incident?.summary?.conflicts).toEqual(["p:repo-alpha"]);
    resetLegacyDocumentStoresForTests();
    expect(readSeatTickSettings("repo-alpha")).toEqual(newer);
  });
});

test("auto-rotation survives a SQLite round trip beside legacy rows that remain off", () => {
  const project = "auto-rotation-fixture";
  const row = { ...defaultSeatTickSettings(project), autoRotate: { enabled: true, thresholdPercent: 60, updatedAt: "2026-10-09T03:00:00.000Z",
    setBy: { kind: "gateway" as const, conversationId: null, project: null, seatEpoch: null }, why: null } };
  writeSeatTickSettings(project, row, file);
  expect(readSeatTickSettings(project, file)).toEqual(row);
  expect(readSeatTickSettings("old-fixture-row", file).autoRotate).toBeUndefined();
});


test("legacy text never inherits the last row editor's operator attribution", () => {
  const legacy = { ...QUIET, instructionLines: undefined, reason: "  Legacy first line.\nLegacy second line.  ", setBy: { kind: "gateway", conversationId: null, project: null, seatEpoch: null } };
  fs.writeFileSync(file, JSON.stringify({ version: 1, projects: { "repo-alpha": legacy } }));
  const read = readSeatTickSettings("repo-alpha");
  expect(read.instructionLines).toEqual(legacy.reason.split("\n").map(text => ({ text, author: null, at: null })));
  checkpointSeatTickSettingsRollbackMirrorForDemotion();
  const mirrored = JSON.parse(fs.readFileSync(file, "utf8"));
  expect(mirrored.projects["repo-alpha"].instructionLines).toEqual(read.instructionLines);
});


test("an existing SQLite row migrates unknown lines across a real process restart", () => {
  writeSeatTickSettings("repo-alpha", QUIET);
  // Reproduce a row committed by the previous release, bypassing the new writer.
  const database = new Database(db());
  database.query("UPDATE state_rows SET value_json = ? WHERE collection = ? AND row_key = ?")
    .run(JSON.stringify({ key: "p:repo-alpha", value: { ...QUIET, instructionLines: undefined, setBy: { kind: "gateway", conversationId: null, project: null, seatEpoch: null } } }), "seat_tick_settings", "p:repo-alpha");
  database.close();
  const child = Bun.spawnSync([process.execPath, "-e", `import { readSeatTickSettings } from "./src/lib/monitor/seatTickSettings"; console.log(JSON.stringify(readSeatTickSettings("repo-alpha")));`], {
    cwd: process.cwd(), env: { ...process.env, LLV_SEAT_TICK_SETTINGS_FILE: file }, stdout: "pipe", stderr: "pipe",
  });
  expect(child.exitCode).toBe(0);
  const read = JSON.parse(child.stdout.toString());
  expect(read.instructionLines).toEqual([{ text: QUIET.reason, author: null, at: null }]);
  expect(read.reason).toBe(QUIET.reason);
});

describe("cached narrow reads and bounded project writes", () => {
  test("narrow curation and turbo reads avoid full-row decoding and cloning, and repeated curation reads hit the transactional data_version witness", () => {
    const decisions = Array.from({ length: 120 }, (_, index) => ({
      id: `dec-${index}`,
      decision: `Decision ${index} `.repeat(15),
      why: `Reasoning ${index} `.repeat(15),
      undo: `Undo ${index} `.repeat(10),
      at: "2026-10-01T00:00:00.000Z",
      by: { kind: "manager" as const, conversationId: "conversation_seat", project: "repo-large", seatEpoch: 1 },
    }));
    const large: SeatTickSettings = {
      ...defaultSeatTickSettings("repo-large"),
      curation: {
        enabled: true,
        intervalHours: 8,
        updatedAt: "2026-10-01T00:00:00.000Z",
        setBy: { kind: "gateway", conversationId: null, project: null, seatEpoch: null },
      },
      autonomy: {
        enabled: true,
        startedAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        until: null,
        endedAt: null,
        endReason: null,
        why: null,
        setBy: { kind: "gateway", conversationId: null, project: null, seatEpoch: null },
        proactive: { enabled: false },
        decisions,
      },
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    writeSeatTickSettings("repo-large", large, file);
    // Warm the narrow curation cache with one read.
    expect(readSeatTickCurationSetting("repo-large", file)).toEqual({ enabled: true, intervalHours: 8, intervalMs: 8 * 3_600_000 });

    const nativeParse = JSON.parse;
    const nativeClone = globalThis.structuredClone;
    let parses = 0;
    let maxParsedLength = 0;
    let clones = 0;
    const parseSpy = spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      parses++;
      maxParsedLength = Math.max(maxParsedLength, String(text).length);
      return nativeParse(text, reviver);
    });
    const cloneSpy = spyOn(globalThis, "structuredClone").mockImplementation((value, options) => {
      clones++;
      return nativeClone(value, options);
    });
    try {
      // Unchanged database: curation hits the data_version witness with zero parses/clones,
      // and turbo extracts only its narrow fields with zero parses/clones when absent.
      for (let i = 0; i < 20; i++) {
        expect(readSeatTickCurationSetting("repo-large", file).intervalHours).toBe(8);
        expect(readTurboSettings("repo-large", file).turbo).toBeUndefined();
      }
      expect(parses).toBe(0);
      expect(clones).toBe(0);

      // Even after an unrelated SQLite write advances data_version, narrow curation
      // re-reads only the tiny curation JSON slice (not the 70+ KB autonomy payload).
      const writer = new Database(db());
      writer.exec("CREATE TABLE IF NOT EXISTS unrelated_noise(id INTEGER PRIMARY KEY, payload TEXT)");
      writer.query("INSERT INTO unrelated_noise(payload) VALUES (?)").run("x".repeat(4096));
      writer.close();

      expect(readSeatTickCurationSetting("repo-large", file).intervalHours).toBe(8);
      expect(parses).toBe(1);
      expect(maxParsedLength).toBeLessThan(512);
      // Full settings read parses once without redundant structuredClone.
      expect(readSeatTickSettings("repo-large", file).autonomy?.decisions).toHaveLength(120);
      expect(clones).toBe(0);
    } finally {
      parseSpy.mockRestore();
      cloneSpy.mockRestore();
    }

    // A write invalidates the cached curation witness immediately.
    const changed = changeSeatTickSettings("repo-large", { curation: { enabled: false, intervalHours: 12 } }, {
      at: "2026-10-01T01:00:00.000Z",
      actor: { kind: "gateway", conversationId: null, project: null, seatEpoch: null },
    }, file);
    expect(changed.ok).toBe(true);
    expect(readSeatTickCurationSetting("repo-large", file)).toEqual({ enabled: false, intervalHours: 12, intervalMs: 12 * 3_600_000 });
    expect(readSeatTickSettings("repo-large", file).curation?.enabled).toBe(false);
  });

  test("writing one project does not clone or rewrite unrelated projects", () => {
    writeSeatTickSettings("repo-a", { ...defaultSeatTickSettings("repo-a"), monitorPrompt: "alpha ".repeat(200) }, file);
    writeSeatTickSettings("repo-b", { ...defaultSeatTickSettings("repo-b"), monitorPrompt: "beta ".repeat(200) }, file);
    const nativeClone = globalThis.structuredClone;
    let unrelatedClones = 0;
    const cloneSpy = spyOn(globalThis, "structuredClone").mockImplementation((value, options) => {
      if (value && typeof value === "object" && "key" in value && value.key === "p:repo-a") unrelatedClones++;
      return nativeClone(value, options);
    });
    try {
      writeSeatTickSettings("repo-b", { ...defaultSeatTickSettings("repo-b"), monitorPrompt: "updated beta" }, file);
      expect(unrelatedClones).toBe(0);
    } finally {
      cloneSpy.mockRestore();
    }
    expect(readSeatTickSettings("repo-a", file).monitorPrompt).toBe("alpha ".repeat(200));
    expect(readSeatTickSettings("repo-b", file).monitorPrompt).toBe("updated beta");
  });

  test("concurrent write finishing during a cache fill is visible to the next read", () => {
    const project = "repo-race";
    const initial: SeatTickSettings = {
      ...defaultSeatTickSettings(project),
      monitorPrompt: "before-race",
      curation: {
        enabled: true,
        intervalHours: 4,
        updatedAt: "2026-10-01T00:00:00.000Z",
        setBy: { kind: "gateway", conversationId: null, project: null, seatEpoch: null },
      },
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    const updated: SeatTickSettings = {
      ...initial,
      monitorPrompt: "after-race",
      curation: {
        enabled: false,
        intervalHours: 11,
        updatedAt: "2026-10-01T00:05:00.000Z",
        setBy: { kind: "gateway", conversationId: null, project: null, seatEpoch: null },
      },
      updatedAt: "2026-10-01T00:05:00.000Z",
    };
    writeSeatTickSettings(project, initial, file);

    // Trigger a normal settings write right after the row is read, between the
    // read/revision step and any trailing filesystem signature check.
    let sawRowRead = false;
    let writeCommitted = false;
    let insideWrite = false;
    const origReadRow = LegacyDocumentStore.prototype.readRow;
    const readRowSpy = spyOn(LegacyDocumentStore.prototype, "readRow").mockImplementation(function (this: LegacyDocumentStore<unknown>, ...args) {
      const value = origReadRow.apply(this, args);
      if (!insideWrite && args[1] === `p:${project}`) sawRowRead = true;
      return value;
    });
    const origStatSync = fs.statSync;
    const statSpy = spyOn(fs, "statSync").mockImplementation(((target: fs.PathLike, options?: unknown) => {
      if (sawRowRead && !writeCommitted && !insideWrite && String(target).endsWith("-wal")) {
        insideWrite = true;
        try {
          writeSeatTickSettings(project, updated, file);
          writeCommitted = true;
        } finally {
          insideWrite = false;
        }
      }
      return (origStatSync as (...a: unknown[]) => unknown)(target, options) as ReturnType<typeof fs.statSync>;
    }) as typeof fs.statSync);
    try {
      const first = readSeatTickSettings(project, file);
      expect(first.monitorPrompt).toBe("before-race");
      if (!writeCommitted) {
        insideWrite = true;
        try { writeSeatTickSettings(project, updated, file); writeCommitted = true; } finally { insideWrite = false; }
      }
    } finally {
      statSpy.mockRestore();
      readRowSpy.mockRestore();
    }

    expect(readSeatTickSettings(project, file).monitorPrompt).toBe("after-race");
    expect(readSeatTickCurationSetting(project, file)).toEqual({ enabled: false, intervalHours: 11, intervalMs: 11 * 3_600_000 });
  });

  test("a second SQLite connection updating a row without advancing collection revision is visible immediately", () => {
    const project = "repo-peer";
    const initial: SeatTickSettings = {
      ...defaultSeatTickSettings(project),
      monitorPrompt: "v1-prompt",
      curation: {
        enabled: true,
        intervalHours: 4,
        updatedAt: "2026-10-01T00:00:00.000Z",
        setBy: { kind: "gateway", conversationId: null, project: null, seatEpoch: null },
      },
      turbo: {
        enabled: true,
        startedAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        until: null,
        endedAt: null,
        endReason: null,
        why: "initial",
        setBy: { kind: "gateway", conversationId: null, project: null, seatEpoch: null },
        plan: [],
        credits: { approved: true, accounts: ["acct-a"], approvedAt: "2026-10-01T00:00:00.000Z", withdrawnAt: null, withdrawnBy: null, withdrawnWhy: null },
        switches: [{
          conversationId: "conversation_turbo_1",
          accountId: "acct-a",
          model: "gpt-5.4",
          from: "default",
          to: "priority",
          state: "switched",
          at: "2026-10-01T00:00:00.000Z",
        }],
      },
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    writeSeatTickSettings(project, initial, file);
    // Warm every reader path.
    expect(readSeatTickSettings(project, file).monitorPrompt).toBe("v1-prompt");
    expect(readSeatTickCurationSetting(project, file)).toEqual({ enabled: true, intervalHours: 4, intervalMs: 4 * 3_600_000 });
    expect(readTurboSettings(project, file).turbo?.why).toBe("initial");

    // Second SQLite connection updates state_rows directly without bumping state_collections.revision.
    const revisionBefore = readStateCollectionRevision(db(), "seat_tick_settings");
    const peerUpdated: SeatTickSettings = {
      ...initial,
      monitorPrompt: "v2-from-peer",
      curation: {
        enabled: false,
        intervalHours: 9,
        updatedAt: "2026-10-01T01:00:00.000Z",
        setBy: { kind: "gateway", conversationId: null, project: null, seatEpoch: null },
      },
      turbo: { ...initial.turbo!, why: "updated-by-peer" },
    };
    const peer = new Database(db());
    peer.query("UPDATE state_rows SET value_json = ? WHERE collection = ? AND row_key = ?")
      .run(JSON.stringify({ key: `p:${project}`, value: peerUpdated }), "seat_tick_settings", `p:${project}`);
    peer.close();
    expect(readStateCollectionRevision(db(), "seat_tick_settings")).toBe(revisionBefore);

    expect(readSeatTickSettings(project, file).monitorPrompt).toBe("v2-from-peer");
    expect(readSeatTickCurationSetting(project, file)).toEqual({ enabled: false, intervalHours: 9, intervalMs: 9 * 3_600_000 });
    expect(readTurboSettings(project, file).turbo?.why).toBe("updated-by-peer");
  });

  test("mutating top-level and nested fields on returned settings objects does not throw or corrupt subsequent reads", () => {
    const project = "repo-mutate";
    const initial: SeatTickSettings = {
      ...QUIET,
      project,
      curation: {
        enabled: true,
        intervalHours: 6,
        updatedAt: "2026-10-01T00:00:00.000Z",
        setBy: { kind: "gateway", conversationId: null, project: null, seatEpoch: null },
      },
      autonomy: {
        enabled: true,
        startedAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        until: null,
        endedAt: null,
        endReason: null,
        why: null,
        setBy: { kind: "gateway", conversationId: null, project: null, seatEpoch: null },
        proactive: { enabled: true },
        decisions: [{
          id: "dec-1",
          decision: "keep",
          why: "original",
          undo: "revert",
          at: "2026-10-01T00:00:00.000Z",
          by: { kind: "manager", conversationId: "conversation_seat", project, seatEpoch: 1 },
        }],
      },
      turbo: {
        enabled: true,
        startedAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        until: null,
        endedAt: null,
        endReason: null,
        why: "original-turbo",
        setBy: { kind: "gateway", conversationId: null, project: null, seatEpoch: null },
        plan: [],
        credits: { approved: true, accounts: ["acct-a"], approvedAt: "2026-10-01T00:00:00.000Z", withdrawnAt: null, withdrawnBy: null, withdrawnWhy: null },
        switches: [{
          conversationId: "conversation_turbo_mut",
          accountId: "acct-a",
          model: "gpt-5.4",
          from: "default",
          to: "priority",
          state: "switched",
          at: "2026-10-01T00:00:00.000Z",
        }],
      },
    };
    writeSeatTickSettings(project, initial, file);

    // Warm, then mutate top-level and nested fields on the returned copy.
    const copy = readSeatTickSettings(project, file);
    copy.monitorPrompt = "mutated locally";
    copy.instructionLines![0]!.text = "locally edited instruction";
    copy.instructionLines!.push({ text: "extra local line", author: null, at: null });
    copy.autonomy!.proactive!.enabled = false;
    copy.autonomy!.decisions[0]!.decision = "changed locally";
    copy.curation!.intervalHours = 99;
    copy.turbo!.switches[0]!.state = "failed";

    expect(copy.instructionLines![0]!.text).toBe("locally edited instruction");
    expect(copy.instructionLines).toHaveLength(2);
    expect(copy.autonomy!.proactive!.enabled).toBe(false);

    const curationCopy = readSeatTickCurationSetting(project, file);
    curationCopy.enabled = false;
    curationCopy.intervalHours = 42;

    const turboCopy = readTurboSettings(project, file);
    turboCopy.turbo!.switches[0]!.state = "failed";

    // Subsequent reads must still observe the untouched durable data.
    const fresh = readSeatTickSettings(project, file);
    expect(fresh.monitorPrompt).toBe(QUIET.monitorPrompt);
    expect(fresh.instructionLines).toEqual(QUIET.instructionLines);
    expect(fresh.autonomy!.proactive!.enabled).toBe(true);
    expect(fresh.autonomy!.decisions[0]!.decision).toBe("keep");
    expect(fresh.curation!.intervalHours).toBe(6);
    expect(fresh.turbo!.switches[0]!.state).toBe("switched");
    expect(readSeatTickCurationSetting(project, file)).toEqual(effectiveCurationSetting(fresh));
    expect(readTurboSettings(project, file).turbo!.switches[0]!.state).toBe("switched");
  });

  test("concurrent curation write finishing mid-fill during narrow curation read is visible to the next read", () => {
    const project = "repo-curation-race";
    writeSeatTickSettings(project, {
      ...defaultSeatTickSettings(project),
      curation: {
        enabled: true,
        intervalHours: 5,
        updatedAt: "2026-10-01T00:00:00.000Z",
        setBy: { kind: "gateway", conversationId: null, project: null, seatEpoch: null },
      },
      updatedAt: "2026-10-01T00:00:00.000Z",
    }, file);

    // Commit a new curation setting right while the first narrow curation read
    // is parsing its extracted JSON (between ROLLBACK and cache insertion).
    let committed = false;
    const nativeParse = JSON.parse;
    const parseSpy = spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      const parsed = nativeParse(text, reviver);
      if (!committed && typeof text === "string" && text.includes("\"intervalHours\":5")) {
        committed = true;
        changeSeatTickSettings(project, { curation: { enabled: false, intervalHours: 14 } }, {
          at: "2026-10-01T00:10:00.000Z",
          actor: { kind: "gateway", conversationId: null, project: null, seatEpoch: null },
        }, file);
      }
      return parsed;
    });
    try {
      expect(readSeatTickCurationSetting(project, file)).toEqual({ enabled: true, intervalHours: 5, intervalMs: 5 * 3_600_000 });
      expect(committed).toBe(true);
    } finally {
      parseSpy.mockRestore();
    }
    expect(readSeatTickCurationSetting(project, file)).toEqual({ enabled: false, intervalHours: 14, intervalMs: 14 * 3_600_000 });
  });

  test("legacy unimported JSON files, legacy SQLite rows without instructionLines, and corrupt SQLite rows behave identically across narrow and full reads", () => {
    const legacyProject = "repo-legacy-narrow";
    writeJson(file, {
      version: 1,
      projects: {
        [legacyProject]: {
          ...QUIET,
          project: legacyProject,
          instructionLines: undefined,
          curation: {
            enabled: false,
            intervalHours: 10,
            updatedAt: "2026-09-22T09:00:00.000Z",
            setBy: { kind: "gateway", conversationId: null, project: null, seatEpoch: null },
          },
        },
      },
    });
    // First touch through the narrow curation reader imports the legacy file.
    expect(readSeatTickCurationSetting(legacyProject, file)).toEqual({ enabled: false, intervalHours: 10, intervalMs: 10 * 3_600_000 });
    expect(readStateImport(db(), "seat_tick_settings")?.rowCount).toBe(1);

    // A second SQLite connection writes a legacy-shaped row (without instructionLines)
    // and then a normal bounded patch updates another field without losing legacy attribution.
    const peer = new Database(db());
    peer.query("UPDATE state_rows SET value_json = ? WHERE collection = ? AND row_key = ?")
      .run(JSON.stringify({ key: `p:${legacyProject}`, value: { ...QUIET, project: legacyProject, instructionLines: undefined, reason: "Legacy peer line." } }), "seat_tick_settings", `p:${legacyProject}`);
    peer.close();
    const afterPeer = readSeatTickSettings(legacyProject, file);
    expect(afterPeer.instructionLines).toEqual([{ text: "Legacy peer line.", author: null, at: null }]);
    expect(readSeatTickCurationSetting(legacyProject, file)).toEqual({ enabled: true, intervalHours: 6, intervalMs: 6 * 3_600_000 });

    const edit = changeSeatTickSettings(legacyProject, { monitorPrompt: "updated after peer" }, {
      at: "2026-09-22T10:00:00.000Z",
      actor: { kind: "gateway", conversationId: null, project: null, seatEpoch: null },
    }, file);
    expect(edit.ok).toBe(true);
    expect(readSeatTickSettings(legacyProject, file).instructionLines).toEqual([{ text: "Legacy peer line.", author: null, at: null }]);
    expect(readSeatTickSettings(legacyProject, file).monitorPrompt).toBe("updated after peer");

    // Corrupt SQLite row still raises the store's decode error on both narrow and full reads.
    const corrupt = new Database(db());
    corrupt.query("UPDATE state_rows SET value_json = ? WHERE collection = ? AND row_key = ?")
      .run("{ not valid json", "seat_tick_settings", `p:${legacyProject}`);
    corrupt.close();
    expect(() => readSeatTickCurationSetting(legacyProject, file)).toThrow(/invalid seat_tick_settings row/);
    expect(() => readTurboSettings(legacyProject, file)).toThrow(/invalid seat_tick_settings row/);
    expect(() => readSeatTickSettings(legacyProject, file)).toThrow(/invalid seat_tick_settings row/);
  });
});



test("old copied metadata cannot attribute changed text to the operator", () => {
  const operator = { kind: "gateway" as const, conversationId: null, project: null, seatEpoch: null };
  writeSeatTickSettings("repo-alpha", { ...QUIET, reason: "Changed by an older writer.", instructionLines: [{ text: "Old operator wording.", author: operator, at: "2026-10-01T12:00:00.000Z" }] });
  expect(readSeatTickSettings("repo-alpha").instructionLines).toEqual([{ text: "Changed by an older writer.", author: null, at: null }]);
});
