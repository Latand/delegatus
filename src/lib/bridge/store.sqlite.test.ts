import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { stateImportIncidents } from "@/lib/state/legacyImport";
import { readStateCollectionRevision, readStateImport } from "@/lib/state/sqliteStateStore";

import {
  acknowledgeBridgeReports,
  appendBridgeReports,
  BridgeStateCorruptError,
  bridgeChannelPath,
  bridgeReportId,
  scopedReportId,
  bridgeReportLogPath,
  checkpointBridgeRollbackMirrorsForDemotion,
  drainBridgeReports,
  importLegacyBridgeChannels,
  importLegacyBridgeReports,
  issueBridgeAckToken,
  openBridgeChannel,
  readBridgeChannel,
  readBridgeReportLog,
  recordBridgeDirectiveAnswer,
  redeemBridgeAckToken,
  resetBridgeCollectionsForTests,
} from "./store";
import { BRIDGE_REPORT_CAPACITY, type BridgeChannelScope, type BridgeReportInput } from "./types";

/* #1870 slice 4: the bridge report log and the channel cursors run on the
   `bridge_reports` and `bridge_channels` collections of the `state.sqlite`
   beside them. Every case uses its own mkdtemp state directory through
   LLV_STATE_DIR, never the live one. */

const saved = process.env.LLV_STATE_DIR;
const sandboxes: string[] = [];

afterEach(() => {
  if (saved === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = saved;
  resetBridgeCollectionsForTests();
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function sandbox(): { state: string; db: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-bridge-sqlite-"));
  sandboxes.push(dir);
  const state = path.join(dir, "state");
  fs.mkdirSync(state, { recursive: true });
  process.env.LLV_STATE_DIR = state;
  return { state, db: path.join(state, "state.sqlite") };
}

const NOW = new Date("2026-09-22T10:00:00.000Z");
const SCOPE: BridgeChannelScope = { project: "repo-project-a", seatConversationId: "conversation_seat_a" };

function report(key: string, overrides: Partial<BridgeReportInput> = {}): BridgeReportInput {
  return {
    key,
    class: "status",
    at: NOW.toISOString(),
    body: `report ${key}`,
    project: SCOPE.project,
    targetSeatConversationId: SCOPE.seatConversationId,
    ...overrides,
  };
}

function legacyReport(key: string, seq: number): Record<string, unknown> {
  return {
    id: bridgeReportId(key),
    seq,
    at: NOW.toISOString(),
    class: "status",
    body: `legacy ${key}`,
    project: SCOPE.project,
    targetSeatConversationId: SCOPE.seatConversationId,
  };
}

function writeJson(file: string, body: unknown): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = `${JSON.stringify(body, null, 2)}\n`;
  fs.writeFileSync(file, text);
  return text;
}

function seedLegacy(): { reportsText: string } {
  const reportsText = writeJson(bridgeReportLogPath(), {
    schemaVersion: 1,
    lastSeq: 12,
    trimmedThroughSeq: 10,
    trimmedThroughByChannel: {},
    reports: [legacyReport("eleven", 11), legacyReport("twelve", 12)],
    retired: [bridgeReportId("retired-before-import")],
    answeredRefs: [],
    pendingAnswers: [],
  });
  writeJson(bridgeChannelPath(), {
    schemaVersion: 1,
    rootId: "root_legacy",
    managerRecordRef: "orchestrator",
    managerReportCursor: 4,
    updatedAt: NOW.toISOString(),
  });
  writeJson(bridgeChannelPath(SCOPE), {
    schemaVersion: 1,
    rootId: "root_scoped",
    project: SCOPE.project,
    seatConversationId: SCOPE.seatConversationId,
    managerRecordRef: "orchestrator",
    managerReportCursor: 11,
    updatedAt: NOW.toISOString(),
  });
  return { reportsText };
}

function kept(directory: string, prefix: string): string[] {
  return fs.readdirSync(directory).filter((name) => name.startsWith(prefix));
}

describe("import once", () => {
  test("the first touch imports the report log and every channel, keeps the files and leaves tombstones", () => {
    const { state, db } = sandbox();
    const { reportsText } = seedLegacy();

    expect(readBridgeReportLog().reports.map((entry) => entry.seq)).toEqual([11, 12]);
    expect(readBridgeChannel(SCOPE)?.managerReportCursor).toBe(11);
    expect(readBridgeChannel()?.managerReportCursor).toBe(4);

    const reports = readStateImport(db, "bridge_reports");
    expect(reports?.sourceSha256).toBe(crypto.createHash("sha256").update(reportsText).digest("hex"));
    expect(reports?.gap).toBeNull();
    expect(readStateImport(db, "bridge_channels")?.rowCount).toBe(2);

    for (const file of [bridgeReportLogPath(), bridgeChannelPath(), bridgeChannelPath(SCOPE)]) {
      expect(fs.statSync(file).isDirectory()).toBe(true);
    }
    const keptReports = kept(state, "bridge-reports.json.imported-");
    expect(keptReports).toHaveLength(1);
    expect(fs.readFileSync(path.join(state, keptReports[0]!), "utf8")).toBe(reportsText);
    expect(kept(state, "bridge.json.imported-")).toHaveLength(1);
    expect(kept(path.dirname(bridgeChannelPath(SCOPE)), `${path.basename(bridgeChannelPath(SCOPE))}.imported-`)).toHaveLength(1);
  });

  test("a second touch, a restart and the activation import never import again", () => {
    const { db } = sandbox();
    seedLegacy();
    readBridgeReportLog();
    readBridgeChannel(SCOPE);
    const first = readStateImport(db, "bridge_reports")!;
    const firstChannels = readStateImport(db, "bridge_channels")!;

    resetBridgeCollectionsForTests();
    expect(readBridgeReportLog().lastSeq).toBe(12);
    expect(importLegacyBridgeReports(bridgeReportLogPath(), { reconcile: true }).state).toBe("already-imported");
    expect(importLegacyBridgeChannels(path.dirname(bridgeReportLogPath()), { reconcile: true }).state).toBe("already-imported");

    expect(readStateImport(db, "bridge_reports")?.importedAt).toBe(first.importedAt);
    expect(readStateImport(db, "bridge_channels")?.importedAt).toBe(firstChannels.importedAt);
  });

  test("an install with no bridge files starts empty and a write needs no file", () => {
    const { db } = sandbox();
    expect(readBridgeReportLog().lastSeq).toBe(0);
    expect(readBridgeChannel(SCOPE)).toBeNull();
    openBridgeChannel("root_a", NOW, SCOPE);
    expect(appendBridgeReports([report("first")]).appended[0]?.seq).toBe(1);
    expect(readStateImport(db, "bridge_reports")?.rowCount).toBe(0);
  });

  test("seq keeps counting from the imported log", () => {
    sandbox();
    seedLegacy();
    expect(appendBridgeReports([report("thirteen")]).appended[0]?.seq).toBe(13);
  });
});

describe("replay dedupe", () => {
  test("a replayed key is skipped, whether live, retired before the import, or trimmed after it", () => {
    sandbox();
    seedLegacy();

    expect(appendBridgeReports([report("eleven")])).toMatchObject({ appended: [], skipped: 1 });
    expect(appendBridgeReports([report("retired-before-import")])).toMatchObject({ appended: [], skipped: 1 });

    const first = appendBridgeReports([report("fresh")]);
    expect(first.appended).toHaveLength(1);
    expect(appendBridgeReports([report("fresh")])).toMatchObject({ appended: [], skipped: 1 });

    appendBridgeReports(Array.from({ length: BRIDGE_REPORT_CAPACITY + 3 }, (_, index) => report(`fill-${index}`)));
    const log = readBridgeReportLog();
    expect(log.reports).toHaveLength(BRIDGE_REPORT_CAPACITY);
    expect(log.retired).toContain(scopedReportId(SCOPE.project, "fresh"));
    resetBridgeCollectionsForTests();
    expect(appendBridgeReports([report("fresh")])).toMatchObject({ appended: [], skipped: 1 });
    expect(appendBridgeReports([report("fill-0")])).toMatchObject({ appended: [], skipped: 1 });
  });

  test("the retired ids keep their order and their cap across a reload", () => {
    sandbox();
    appendBridgeReports(Array.from({ length: BRIDGE_REPORT_CAPACITY + 10 }, (_, index) => report(`r-${index}`)));
    const before = readBridgeReportLog().retired;
    resetBridgeCollectionsForTests();
    expect(readBridgeReportLog().retired).toEqual(before);
    expect(before[0]).toBe(scopedReportId(SCOPE.project, "r-0"));
  });
});

describe("cursor round trip", () => {
  test("an issued and redeemed batch moves the cursor, and it reads back after a restart", () => {
    const { db } = sandbox();
    openBridgeChannel("root_a", NOW, SCOPE);
    appendBridgeReports([report("one"), report("two")]);
    const batch = drainBridgeReports({ now: NOW, scope: SCOPE });
    expect(batch.throughSeq).toBe(2);
    const token = issueBridgeAckToken(batch.throughSeq, NOW, SCOPE);

    resetBridgeCollectionsForTests();
    expect(redeemBridgeAckToken(token, NOW)).toEqual({ ok: true, throughSeq: 2 });
    expect(redeemBridgeAckToken(token, NOW).ok).toBe(false);

    resetBridgeCollectionsForTests();
    expect(readBridgeChannel(SCOPE)?.managerReportCursor).toBe(2);
    expect(readBridgeChannel(SCOPE)?.outstanding).toBeUndefined();
    expect(drainBridgeReports({ now: NOW, scope: SCOPE }).reports).toEqual([]);
    expect(fs.existsSync(bridgeChannelPath(SCOPE))).toBe(false);
    expect(readStateCollectionRevision(db, "bridge_channels")).toBeGreaterThan(0);
  });

  test("an imported cursor is where the gateway resumes, and a late acknowledgement never moves it back", () => {
    sandbox();
    seedLegacy();
    expect(drainBridgeReports({ now: NOW, scope: SCOPE }).reports.map((entry) => entry.seq)).toEqual([12]);
    expect(acknowledgeBridgeReports(12, NOW, SCOPE)?.managerReportCursor).toBe(12);
    expect(acknowledgeBridgeReports(5, NOW, SCOPE)?.managerReportCursor).toBe(12);
    expect(readBridgeChannel()?.managerReportCursor).toBe(4);
  });
});

describe("revision", () => {
  test("an append bumps the report collection revision; a replay and a read do not", () => {
    const { db } = sandbox();
    appendBridgeReports([report("a")]);
    const after = readStateCollectionRevision(db, "bridge_reports")!;
    appendBridgeReports([report("a")]);
    readBridgeReportLog();
    expect(readStateCollectionRevision(db, "bridge_reports")).toBe(after);
    appendBridgeReports([report("b")]);
    expect(readStateCollectionRevision(db, "bridge_reports")).toBe(after + 1);
  });

  test("an answer bumps it once; answering again does not", () => {
    const { db } = sandbox();
    const [asked] = appendBridgeReports([report("q", { class: "question" })]).appended;
    const before = readStateCollectionRevision(db, "bridge_reports")!;
    recordBridgeDirectiveAnswer(asked!.seq, SCOPE, (id) => id);
    recordBridgeDirectiveAnswer(asked!.seq, SCOPE, (id) => id);
    expect(readStateCollectionRevision(db, "bridge_reports")).toBe(before + 1);
    expect(readBridgeReportLog().answeredRefs).toEqual([asked!.seq]);
  });

  test("a cursor advance bumps the channel revision; a stale one does not", () => {
    const { db } = sandbox();
    openBridgeChannel("root_a", NOW, SCOPE);
    const opened = readStateCollectionRevision(db, "bridge_channels")!;
    openBridgeChannel("root_a", NOW, SCOPE);
    expect(readStateCollectionRevision(db, "bridge_channels")).toBe(opened);
    acknowledgeBridgeReports(3, NOW, SCOPE);
    acknowledgeBridgeReports(2, NOW, SCOPE);
    expect(readStateCollectionRevision(db, "bridge_channels")).toBe(opened + 1);
  });
});

describe("corrupted sources", () => {
  test("a NUL-filled report log imports as a gap, and new reports still land above every cursor", () => {
    const { state, db } = sandbox();
    seedLegacy();
    fs.writeFileSync(bridgeReportLogPath(), Buffer.alloc(2048, 0));
    const before = stateImportIncidents().length;

    expect(readBridgeReportLog().reports).toEqual([]);
    expect(readStateImport(db, "bridge_reports")?.gap).toBe("legacy-unreadable");
    expect(stateImportIncidents().slice(before).some((entry) => entry.collection === "bridge_reports")).toBe(true);
    expect(kept(state, "bridge-reports.json.unreadable-")).toHaveLength(1);

    /* The scoped cursor sat at 11. A log restarted at seq 1 would leave that
       gateway deaf to everything below 12. */
    const [next] = appendBridgeReports([report("after-loss")]).appended;
    expect(next!.seq).toBeGreaterThan(11);
    expect(drainBridgeReports({ now: NOW, scope: SCOPE }).reports.map((entry) => entry.id)).toContain(next!.id);
  });

  test("a corrupted report log that reappears after the import never overwrites the database", () => {
    const { state, db } = sandbox();
    seedLegacy();
    appendBridgeReports([report("kept")]);
    const revision = readStateCollectionRevision(db, "bridge_reports");
    const log = readBridgeReportLog();

    fs.rmSync(bridgeReportLogPath(), { recursive: true, force: true });
    fs.writeFileSync(bridgeReportLogPath(), "{ truncated");
    importLegacyBridgeReports(bridgeReportLogPath(), { reconcile: true });
    resetBridgeCollectionsForTests();

    expect(readBridgeReportLog()).toEqual(log);
    expect(readStateCollectionRevision(db, "bridge_reports")).toBe(revision);
    expect(kept(state, "bridge-reports.json.unreadable-")).toHaveLength(1);
    expect(fs.statSync(bridgeReportLogPath()).isDirectory()).toBe(true);
  });

  test("a corrupted channel file that reappears after the import leaves the cursor alone", () => {
    const { db } = sandbox();
    seedLegacy();
    acknowledgeBridgeReports(12, NOW, SCOPE);
    const revision = readStateCollectionRevision(db, "bridge_channels");

    fs.rmSync(bridgeChannelPath(SCOPE), { recursive: true, force: true });
    fs.writeFileSync(bridgeChannelPath(SCOPE), Buffer.alloc(512, 0));
    importLegacyBridgeChannels(path.dirname(bridgeReportLogPath()), { reconcile: true });
    resetBridgeCollectionsForTests();

    expect(readBridgeChannel(SCOPE)?.managerReportCursor).toBe(12);
    expect(readStateCollectionRevision(db, "bridge_channels")).toBe(revision);
    expect(fs.statSync(bridgeChannelPath(SCOPE)).isDirectory()).toBe(true);
  });

  test("an unreadable channel file on first import is kept aside and recorded as a gap", () => {
    const { db } = sandbox();
    seedLegacy();
    fs.writeFileSync(bridgeChannelPath(SCOPE), "{ half");
    expect(readBridgeChannel(SCOPE)).toBeNull();
    expect(readBridgeChannel()?.managerReportCursor).toBe(4);
    expect(readStateImport(db, "bridge_channels")?.gap).toContain("legacy-unreadable");
    const directory = path.dirname(bridgeChannelPath(SCOPE));
    expect(kept(directory, `${path.basename(bridgeChannelPath(SCOPE))}.unreadable-`)).toHaveLength(1);
  });

  test("a scoped file whose stored seat does not match its name costs only that channel", () => {
    const { db } = sandbox();
    seedLegacy();
    const other: BridgeChannelScope = { project: SCOPE.project, seatConversationId: "conversation_seat_b" };
    writeJson(bridgeChannelPath(other), {
      schemaVersion: 1,
      rootId: "root_mismatched",
      project: SCOPE.project,
      seatConversationId: "conversation_seat_elsewhere",
      managerRecordRef: "orchestrator",
      managerReportCursor: 3,
      updatedAt: NOW.toISOString(),
    });

    expect(readBridgeChannel(SCOPE)?.managerReportCursor).toBe(11);
    expect(readBridgeChannel()?.managerReportCursor).toBe(4);
    expect(readBridgeChannel(other)).toBeNull();
    expect(readStateImport(db, "bridge_channels")?.gap).toContain(path.basename(bridgeChannelPath(other)));
    const directory = path.dirname(bridgeChannelPath(other));
    expect(kept(directory, `${path.basename(bridgeChannelPath(other))}.unreadable-`)).toHaveLength(1);
    expect(openBridgeChannel("root_b", NOW, other).managerReportCursor).toBe(0);
  });

  test("valid JSON holding a malformed report refuses the import and leaves the file untouched", () => {
    const { db } = sandbox();
    const text = writeJson(bridgeReportLogPath(), { schemaVersion: 1, lastSeq: 1, reports: [{ seq: "one" }], retired: [] });
    expect(() => readBridgeReportLog()).toThrow(BridgeStateCorruptError);
    expect(readStateImport(db, "bridge_reports")).toBeNull();
    expect(fs.readFileSync(bridgeReportLogPath(), "utf8")).toBe(text);
  });
});

describe("rollback mirror", () => {
  test("a rollback release's appends and cursor moves fold back on roll-forward", () => {
    const { db } = sandbox();
    seedLegacy();
    appendBridgeReports([report("thirteen")]);
    checkpointBridgeRollbackMirrorsForDemotion();

    expect(fs.statSync(bridgeReportLogPath()).isFile()).toBe(true);
    expect(fs.statSync(bridgeChannelPath(SCOPE)).isFile()).toBe(true);

    /* The rollback release appends seq 14 and advances the scoped cursor. */
    const mirror = JSON.parse(fs.readFileSync(bridgeReportLogPath(), "utf8")) as { lastSeq: number; reports: unknown[] };
    expect(mirror.lastSeq).toBe(13);
    mirror.reports.push(legacyReport("fourteen", 14));
    mirror.lastSeq = 14;
    writeJson(bridgeReportLogPath(), mirror);
    const channel = JSON.parse(fs.readFileSync(bridgeChannelPath(SCOPE), "utf8")) as { managerReportCursor: number };
    channel.managerReportCursor = 13;
    writeJson(bridgeChannelPath(SCOPE), channel);

    expect(importLegacyBridgeReports(bridgeReportLogPath(), { reconcile: true }).incident?.kind).toBe("legacy-reconciled");
    importLegacyBridgeChannels(path.dirname(bridgeReportLogPath()), { reconcile: true });
    resetBridgeCollectionsForTests();

    expect(readBridgeReportLog().reports.map((entry) => entry.seq)).toEqual([11, 12, 13, 14]);
    expect(readBridgeChannel(SCOPE)?.managerReportCursor).toBe(13);
    expect(appendBridgeReports([report("fifteen")]).appended[0]?.seq).toBe(15);
    expect(fs.statSync(bridgeReportLogPath()).isDirectory()).toBe(true);
    expect(fs.statSync(bridgeChannelPath(SCOPE)).isDirectory()).toBe(true);
    expect(readStateImport(db, "bridge_reports")?.mirrorRevision).not.toBeNull();
  });

  test("an untouched channel mirror is deleted on roll-forward, never kept as a second copy", () => {
    sandbox();
    seedLegacy();
    readBridgeChannel(SCOPE);
    const directory = path.dirname(bridgeChannelPath(SCOPE));
    const prefix = `${path.basename(bridgeChannelPath(SCOPE))}.imported-`;
    expect(kept(directory, prefix)).toHaveLength(1);

    for (let cycle = 0; cycle < 2; cycle += 1) {
      checkpointBridgeRollbackMirrorsForDemotion();
      expect(fs.statSync(bridgeChannelPath(SCOPE)).isFile()).toBe(true);
      importLegacyBridgeChannels(path.dirname(bridgeReportLogPath()), { reconcile: true });
      expect(fs.statSync(bridgeChannelPath(SCOPE)).isDirectory()).toBe(true);
    }

    expect(kept(directory, prefix)).toHaveLength(1);
    expect(readBridgeChannel(SCOPE)?.managerReportCursor).toBe(11);
  });

  test("channel files standing beside a stray import record rebuild their rows (#1905)", () => {
    const { state, db } = sandbox();
    seedLegacy();
    /* A process with no release imported (no release recorded), while the
       machine's release target stood beside it; the release kept writing its
       JSON channel, here re-opened under a new root at the same cursor. */
    importLegacyBridgeChannels(state, { reconcile: true });
    expect(readStateImport(db, "bridge_channels")?.release).toBeNull();
    const revision = "b".repeat(40);
    fs.writeFileSync(path.join(state, "viewer-release.json"), JSON.stringify({
      endpoint: "http://127.0.0.1:8898", revision, hotStateBackend: "sqlite-v1",
    }));
    fs.writeFileSync(path.join(state, "hot-state-authority.json"), JSON.stringify({
      schemaVersion: 1, epoch: 1, mode: "sqlite", releaseRevision: revision,
      updatedAt: "2026-09-20T00:00:00.000Z", activationReadyAt: "2026-09-20T00:00:00.000Z",
    }));
    fs.rmSync(bridgeChannelPath(SCOPE), { recursive: true, force: true });
    writeJson(bridgeChannelPath(SCOPE), {
      schemaVersion: 1,
      rootId: "root_release_wrote",
      project: SCOPE.project,
      seatConversationId: SCOPE.seatConversationId,
      managerRecordRef: "orchestrator",
      managerReportCursor: 11,
      updatedAt: NOW.toISOString(),
    });
    resetBridgeCollectionsForTests();

    expect(importLegacyBridgeChannels(state, { reconcile: true }).state).toBe("reimported");

    resetBridgeCollectionsForTests();
    expect(readBridgeChannel(SCOPE)?.rootId).toBe("root_release_wrote");
    expect(readBridgeChannel()?.managerReportCursor).toBe(4);
    expect(fs.statSync(bridgeChannelPath(SCOPE)).isDirectory()).toBe(true);
    /* The files are retired now, so the next activation has nothing to rebuild from. */
    expect(importLegacyBridgeChannels(state, { reconcile: true }).state).toBe("already-imported");
    expect(readBridgeChannel(SCOPE)?.rootId).toBe("root_release_wrote");
  });

  test("an untouched mirror is retired on roll-forward without a merge", () => {
    sandbox();
    seedLegacy();
    checkpointBridgeRollbackMirrorsForDemotion();
    const outcome = importLegacyBridgeReports(bridgeReportLogPath(), { reconcile: true });
    expect(outcome.incident).toBeNull();
    expect(fs.statSync(bridgeReportLogPath()).isDirectory()).toBe(true);
  });
});
