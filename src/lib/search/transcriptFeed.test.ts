import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  scheduleTranscriptIndex,
  setTranscriptMigrationRetryBackoffForTests,
  waitForTranscriptIndexIdleForTests,
} from "./transcriptFeed";
import { indexTranscriptSources, searchTranscripts, type TranscriptIndexSource } from "./transcriptSearch";
import { performanceSpans, performanceSites } from "@/lib/performanceSpans";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-transcript-feed-"));
const previousEnvironment = {
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  LLV_STATE_DIR: process.env.LLV_STATE_DIR,
  TMPDIR: process.env.TMPDIR,
};

beforeEach(async () => {
  await waitForTranscriptIndexIdleForTests();
  process.env.HOME = path.join(sandbox, "home");
  process.env.XDG_CONFIG_HOME = path.join(sandbox, "config");
  process.env.LLV_STATE_DIR = path.join(sandbox, "state");
  process.env.TMPDIR = path.join(sandbox, "tmp");
  fs.rmSync(process.env.LLV_STATE_DIR, { recursive: true, force: true });
  fs.mkdirSync(process.env.TMPDIR, { recursive: true });
});

afterAll(async () => {
  await waitForTranscriptIndexIdleForTests();
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("starts initial indexing after the caller returns and completes it in the background", async () => {
  const transcript = path.join(sandbox, "background-session.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "background saffron body" } }) + "\n");
  const stat = fs.statSync(transcript);
  const sources: TranscriptIndexSource[] = [{
    path: transcript,
    project: "background",
    engine: "claude",
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  }];
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const run = async (nextSources: readonly TranscriptIndexSource[], complete: boolean) => {
    markStarted();
    await gate;
    await indexTranscriptSources(nextSources, { complete });
  };

  const returned = scheduleTranscriptIndex({ sources, complete: true }, { force: true, run });

  expect(returned).toBeUndefined();
  await started;
  expect(fs.existsSync(path.join(process.env.LLV_STATE_DIR!, "transcript-search.sqlite"))).toBeFalse();
  release();
  await waitForTranscriptIndexIdleForTests();
  expect(searchTranscripts({ query: "saffron" }).items).toHaveLength(1);
});

test("transcript indexing records sync work and clears its watchdog site while awaiting input", async () => {
  const transcript = path.join(sandbox, "attributed-session.jsonl");
  fs.writeFileSync(transcript, "fixture\n");
  const stat = fs.statSync(transcript);
  const indexedSource: TranscriptIndexSource = {
    path: transcript,
    project: "attributed",
    engine: "claude",
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
  let markReaderStarted!: () => void;
  const readerStarted = new Promise<void>((resolve) => { markReaderStarted = resolve; });
  let releaseReader!: () => void;
  const readerGate = new Promise<void>((resolve) => { releaseReader = resolve; });
  const observedSites: string[] = [];
  performanceSpans.clear();
  performanceSpans.observeSite((site) => { observedSites.push(performanceSites[site] ?? "unknown-runtime-or-native"); });
  try {
    const indexing = indexTranscriptSources([indexedSource], {
      complete: true,
      readMessages: async function* () {
        markReaderStarted();
        await readerGate;
        yield { body: "indexed body", speaker: "user", timestamp: null, byteOffset: 0, lineNumber: 1 };
      },
    });
    await readerStarted;
    const syncSlicesBeforeResume = performanceSpans.snapshot().records.filter((row) =>
      performanceSites[row.site] === "transcript.index" && row.kind === "sync").length;
    expect(observedSites.at(-1) ?? "unknown-runtime-or-native").toBe("unknown-runtime-or-native");
    performanceSpans.sync("http.render", () => {});
    expect(observedSites.at(-1)).toBe("unknown-runtime-or-native");
    releaseReader();
    const result = await indexing;
    expect(result.failures).toEqual([]);
    const slices = performanceSpans.snapshot().records.filter((row) =>
      performanceSites[row.site] === "transcript.index" && row.kind === "sync");
    expect(slices.length).toBeGreaterThanOrEqual(3);
    expect(slices.length).toBeGreaterThan(syncSlicesBeforeResume);
  } finally {
    performanceSpans.observeSite();
    performanceSpans.clear();
  }
});

test("custom runner and state-dir changes prevent earlier deferred migration timers from firing stale work", async () => {
  const { Database } = await import("bun:sqlite");
  const prevHelper = process.env.LLV_HELPER_LEASE_ENTRY;
  const dirA = fs.mkdtempSync(path.join(sandbox, "feed-iso-a-"));
  const dirB = fs.mkdtempSync(path.join(sandbox, "feed-iso-b-"));
  const fileA = path.join(dirA, "iso-a.jsonl");
  fs.writeFileSync(fileA, `${JSON.stringify({ type: "user", timestamp: "2026-09-11T00:00:00.000Z", message: { content: "isoaneedle" } })}\n`);
  const statA = fs.statSync(fileA);
  const srcA: TranscriptIndexSource = { path: fileA, project: "iso", engine: "claude", size: statA.size, mtimeMs: statA.mtimeMs };

  process.env.LLV_STATE_DIR = dirA;
  setTranscriptMigrationRetryBackoffForTests(120);
  try {
    expect((await indexTranscriptSources([srcA], { complete: false })).failures).toEqual([]);
    const dbPathA = path.join(dirA, "transcript-search.sqlite");
    const setup = new Database(dbPathA);
    try {
      setup.exec(`
        PRAGMA foreign_keys = OFF;
        PRAGMA legacy_alter_table = ON;
        BEGIN IMMEDIATE;
        ALTER TABLE transcript_files RENAME TO transcript_files_v6;
        CREATE TABLE transcript_files (
          path TEXT PRIMARY KEY,
          size INTEGER NOT NULL,
          mtime_ms REAL NOT NULL,
          project TEXT NOT NULL,
          engine TEXT NOT NULL CHECK(engine IN ('claude', 'codex', 'copilot')),
          messages_count INTEGER NOT NULL,
          indexed_at INTEGER NOT NULL
        );
        INSERT INTO transcript_files SELECT * FROM transcript_files_v6;
        DROP TABLE transcript_files_v6;
        PRAGMA user_version = 5;
        COMMIT;
        PRAGMA legacy_alter_table = OFF;
        PRAGMA foreign_keys = ON;
      `);
    } finally {
      setup.close();
    }

    process.env.LLV_HELPER_LEASE_ENTRY = path.join(dirA, "missing-helper.mjs");
    scheduleTranscriptIndex({ sources: [srcA], complete: false }, { force: true });
    await waitForTranscriptIndexIdleForTests();

    // 1. Switching LLV_STATE_DIR before the 120ms timer fires prevents dirA's timer from touching dirB.
    process.env.LLV_STATE_DIR = dirB;
    if (prevHelper === undefined) delete process.env.LLV_HELPER_LEASE_ENTRY;
    else process.env.LLV_HELPER_LEASE_ENTRY = prevHelper;
    await Bun.sleep(200);
    await waitForTranscriptIndexIdleForTests();
    expect(fs.existsSync(path.join(dirB, "transcript-search.sqlite"))).toBe(false);

    // 2. Re-arm on dirA, then publish a custom runner: the pending retry timer is canceled immediately.
    process.env.LLV_STATE_DIR = dirA;
    setTranscriptMigrationRetryBackoffForTests(120);
    process.env.LLV_HELPER_LEASE_ENTRY = path.join(dirA, "missing-helper.mjs");
    scheduleTranscriptIndex({ sources: [srcA], complete: false }, { force: true });
    await waitForTranscriptIndexIdleForTests();

    let customRuns = 0;
    if (prevHelper === undefined) delete process.env.LLV_HELPER_LEASE_ENTRY;
    else process.env.LLV_HELPER_LEASE_ENTRY = prevHelper;
    scheduleTranscriptIndex({ sources: [], complete: false }, {
      force: true,
      run: async () => { customRuns += 1; },
    });
    await waitForTranscriptIndexIdleForTests();
    await Bun.sleep(220);
    await waitForTranscriptIndexIdleForTests();
    expect(customRuns).toBe(1);
    const probe = new Database(dbPathA, { readonly: true });
    try {
      expect(probe.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(5);
    } finally {
      probe.close();
    }
  } finally {
    setTranscriptMigrationRetryBackoffForTests(null);
    await waitForTranscriptIndexIdleForTests();
    if (prevHelper === undefined) delete process.env.LLV_HELPER_LEASE_ENTRY;
    else process.env.LLV_HELPER_LEASE_ENTRY = prevHelper;
  }
});
