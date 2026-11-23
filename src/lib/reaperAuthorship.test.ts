import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { isOperatorOwnedDirectory } from "@/lib/stateOwnership";
import { readAuthorshipEvidence, readUserAuthoredPaths } from "@/lib/reaperAuthorship";
import { importLegacyReaperState, recordReaperEvidence, resetReaperStateForTests } from "@/lib/reaperState";

const stateFile = () => statePath("reaper-state.json");

afterEach(() => fs.rmSync(stateFile(), { force: true }));

function writeState(value: unknown): void {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(value), "utf8");
}

test("reads the sticky userAuthoredPaths map as a set", () => {
  writeState({ version: 1, firstObservedAt: {}, userAuthoredPaths: { "/a": true, "/b": true } });
  expect(readUserAuthoredPaths()).toEqual(new Set(["/a", "/b"]));
});

test("missing state file yields an empty set", () => {
  fs.rmSync(stateFile(), { force: true });
  expect(readUserAuthoredPaths()).toEqual(new Set());
});

test("corrupt or shapeless state yields an empty set", () => {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), "{ not json", "utf8");
  expect(readUserAuthoredPaths()).toEqual(new Set());
  writeState({ version: 1, firstObservedAt: {}, userAuthoredPaths: ["/a"] });
  expect(readUserAuthoredPaths()).toEqual(new Set());
  writeState({ version: 1 });
  expect(readUserAuthoredPaths()).toEqual(new Set());
});

test("missing state file is no evidence (fail closed)", () => {
  fs.rmSync(stateFile(), { force: true });
  const evidence = readAuthorshipEvidence();
  expect(evidence.userAuthoredPaths.has("/a")).toBe(false);
  expect(evidence.scannedAt.get("/a")).toBeUndefined();
});

test("after the import the evidence is read from SQLite and follows each recorded path", () => {
  const previous = process.env.LLV_STATE_DIR;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-authorship-"));
  process.env.LLV_STATE_DIR = directory;
  try {
    writeState({ version: 1, firstObservedAt: {}, userAuthoredPaths: { "/a": true }, scannedAt: { "/b": 1000 } });
    expect(importLegacyReaperState().state).toBe("imported");
    expect(fs.statSync(stateFile()).isDirectory()).toBe(true);
    const evidence = readAuthorshipEvidence();
    expect([evidence.userAuthoredPaths.has("/a"), evidence.userAuthoredPaths.has("/b")]).toEqual([true, false]);
    expect([evidence.scannedAt.get("/a"), evidence.scannedAt.get("/b")]).toEqual([undefined, 1000]);
    recordReaperEvidence({ authored: ["/b"], scanned: [["/c", 3000]] });
    const after = readAuthorshipEvidence();
    expect(after.userAuthoredPaths.has("/b")).toBe(true);
    expect([after.scannedAt.get("/b"), after.scannedAt.get("/c")]).toEqual([1000, 3000]);
    expect(readUserAuthoredPaths()).toEqual(new Set(["/a", "/b"]));
  } finally {
    resetReaperStateForTests();
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("reads the path-scoped scannedAt freshness map, dropping non-number stamps", () => {
  writeState({
    version: 1,
    firstObservedAt: {},
    userAuthoredPaths: {},
    scannedAt: { "/a": 1000, "/b": 2000.5, "/bad": "nope", "/nan": Number.NaN },
  });
  const evidence = readAuthorshipEvidence();
  expect(["/a", "/b", "/bad", "/nan"].map((pathname) => evidence.scannedAt.get(pathname))).toEqual([1000, 2000.5, undefined, undefined]);
});

test("missing or shapeless scannedAt yields an empty freshness map (fail closed)", () => {
  fs.rmSync(stateFile(), { force: true });
  expect(readAuthorshipEvidence().scannedAt.get("/a")).toBeUndefined();
  writeState({ version: 1, firstObservedAt: {}, userAuthoredPaths: {}, scannedAt: ["/a"] });
  expect(readAuthorshipEvidence().scannedAt.get("0")).toBeUndefined();
  expect(readAuthorshipEvidence().scannedAt.get("/a")).toBeUndefined();
  writeState({ version: 1, firstObservedAt: {}, userAuthoredPaths: {} });
  expect(readAuthorshipEvidence().scannedAt.get("/a")).toBeUndefined();
});

test("does not touch the caller's temp dir isolation", () => {
  /* The suite pins LLV_STATE_DIR to a throwaway temp dir; confirm the reader
     resolves under it and never falls back to the real config dir. The dir is
     the preload's own, under this run's temp root, unless the caller set one
     (a lane's agent runs with its spawn sandbox's), so the check is against
     the variable rather than os.tmpdir(). */
  expect(stateFile().startsWith(process.env.LLV_STATE_DIR! + path.sep)).toBe(true);
  expect(isOperatorOwnedDirectory(stateFile())).toBe(false);
});
