import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCachedResourceSessions, parsePersistedResourceObservation } from "./resources";

const originalState = process.env.LLV_STATE_DIR;
const directories: string[] = [];
afterEach(() => {
  if (originalState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = originalState;
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test("a fleet memory read uses only the saved table and neither starts nor persists a collection", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-resources-")); directories.push(directory);
  process.env.LLV_STATE_DIR = directory;
  expect(readCachedResourceSessions()).toEqual({ sessions: [], stale: true });
  expect(fs.readdirSync(directory)).toEqual([]);
  const filename = path.join(directory, "resources-observation.json");
  const session = { target: "fixture", panePid: 100, path: null, engine: "claude" as const, title: "Fixture", project: null,
    activity: null, lastActiveAt: null, cwd: null, rssBytes: 100, swapBytes: 0, procCount: 1, conversationId: "conversation_one" };
  const observation = { version: 1, observation: { generation: 1, startedAt: Date.now(), completedAt: Date.now(), collectorId: "fixture",
    value: { payload: { system: null, sessions: [session] }, diagnostic: { fresh: false, status: "complete", durationMs: 0,
      phases: { systemMemory: 0, readFiles: 0, readHosts: 0, ppidMap: 0, processMemory: 0, attach: 0, serialization: 0 } },
      hostCount: 1, treeCount: 1, targets: [] } } };
  const raw = JSON.stringify(observation);
  expect(parsePersistedResourceObservation(raw)).not.toBeNull();
  fs.writeFileSync(filename, raw);
  expect(readCachedResourceSessions()).toEqual({ sessions: [session], stale: false });
  expect(fs.readFileSync(filename, "utf8")).toBe(raw);
  observation.observation.startedAt -= 700_000; observation.observation.completedAt -= 700_000;
  fs.writeFileSync(filename, JSON.stringify(observation));
  expect(readCachedResourceSessions().stale).toBe(true);
  fs.writeFileSync(filename, "invalid");
  expect(readCachedResourceSessions()).toEqual({ sessions: [], stale: true });
  expect(fs.readFileSync(filename, "utf8")).toBe("invalid");
});
