import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { assertRetentionTestPath } from "./retentionTestSafety";
import { pruneDockerCache } from "./dockerCacheRetention";
import { TemporaryDataStore, type TemporaryDataCandidate } from "./runtime/temporaryDataStore";
import { sweepTemporaryData } from "./runtime/temporaryDataRetention";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-safety-")); roots.push(root);
  return root;
}
const outside = () => path.join(import.meta.dir, "operator-shaped-state", "uncreated.sqlite");
test("an outside path is refused before its metadata is read", () => {
  const inspect = spyOn(fs, "lstatSync");
  try {
    expect(() => assertRetentionTestPath(outside())).toThrow("outside its private temp root");
    expect(inspect).not.toHaveBeenCalled();
  } finally { inspect.mockRestore(); }
});
test("ledger, discovery, registration and Docker checkpoints reject outside state before a write", async () => {
  const root = fixture(), store = new TemporaryDataStore(path.join(root, "safe.sqlite"));
  let calls = 0;
  try {
    expect(() => new TemporaryDataStore(outside())).toThrow("outside its private temp root");
    expect(() => store.namespace(path.dirname(outside()), "journal")).toThrow("outside its private temp root");
    const row: TemporaryDataCandidate = { directory: outside(), scope: path.dirname(outside()), kind: "journal", owner: "fixture",
      identity: "0:1", adoptedAt: 0, checkedAt: 0, bytes: 0, reason: "fixture" };
    expect(() => store.register(row)).toThrow("outside its private temp root");
    await expect(pruneDockerCache({ file: outside(), run: async () => { calls++; } })).rejects.toThrow("outside its private temp root");
    expect(calls).toBe(0);
    expect(fs.existsSync(path.dirname(outside()))).toBeFalse();
  } finally { store.close(); }
});

test("changing test mode and TMPDIR cannot widen the original path boundary", () => {
  const previous = { NODE_ENV: process.env.NODE_ENV, TMPDIR: process.env.TMPDIR };
  try {
    Object.assign(process.env, { NODE_ENV: "production", TMPDIR: path.dirname(outside()) });
    expect(() => assertRetentionTestPath(outside())).toThrow("outside its private temp root");
  } finally { Object.assign(process.env, previous); }
});

test("an inside symlink cannot open an outside ledger", () => {
  const root = fixture(), link = path.join(root, "link");
  fs.symlinkSync(import.meta.dir, link, "dir");
  expect(() => new TemporaryDataStore(path.join(link, "operator-shaped-state", "uncreated.sqlite"))).toThrow("outside its private temp root");
  expect(fs.existsSync(path.dirname(outside()))).toBeFalse();
});

test("replayed rows outside the sandbox fail before authority and removal", async () => {
  const root = fixture(), store = new TemporaryDataStore(path.join(root, "safe.sqlite"));
  const db = new Database(store.filename);
  db.query("INSERT INTO candidates VALUES(?,?,?,?,?,?,?,?,?)").run(outside(), path.dirname(outside()), "journal", "fixture", "0:1", 0, 0, 0, "fixture");
  db.query("INSERT INTO namespaces VALUES(?,?,?,?,?)").run(path.dirname(outside()), "journal", "fixture", "", 0);
  db.close();
  let calls = 0;
  try {
    expect(() => store.namespaces(0)).toThrow("outside its private temp root");
    await expect(sweepTemporaryData(store, { claim: async () => { calls++; return () => {}; },
      authority: async () => { calls++; throw new Error("unexpected authority"); }, references: async () => { calls++; return true; },
    })).rejects.toThrow("outside its private temp root");
    expect(calls).toBe(0);
    expect(fs.existsSync(path.dirname(outside()))).toBeFalse();
  } finally { store.close(); }
});

test("a path replaced while claiming fails the test and releases its claim", async () => {
  const root = fixture(), scope = path.join(root, "scope"); fs.mkdirSync(scope);
  const directory = path.join(scope, "evidence"); fs.mkdirSync(directory);
  const stat = fs.statSync(directory), store = new TemporaryDataStore(path.join(root, "safe.sqlite"));
  store.register({ directory, scope, kind: "agent-evidence", owner: "fixture", identity: `${stat.dev}:${stat.ino}`,
    adoptedAt: 0, checkedAt: 0, bytes: 0, reason: "fixture" });
  let released = 0, authority = 0;
  try {
    await expect(sweepTemporaryData(store, {
      claim: async () => { fs.renameSync(scope, path.join(root, "held")); fs.symlinkSync(import.meta.dir, scope, "dir"); return () => { released++; }; },
      authority: async () => { authority++; throw new Error("unexpected authority"); }, references: async () => true,
    })).rejects.toThrow("outside its private temp root");
    expect(released).toBe(1); expect(authority).toBe(0);
    expect(fs.existsSync(path.join(root, "held", "evidence"))).toBeTrue();
  } finally { store.close(); }
});
