import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { continuityMarker, headSession } from "./lineage";
import { readRootLineage, recordRootSession, RootLineageStoreError, rootIdentity, rootLineageFile, rootLineageStore } from "./store";

let sandbox = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-root-lineage-"));
  process.env.LLV_STATE_DIR = sandbox;
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("the lineage round-trips through the state file", () => {
  expect(readRootLineage()).toBeNull();

  const created = recordRootSession({ conversationId: "conversation_a", path: "/tmp/a.jsonl" });

  expect(created.outcome).toBe("created");
  expect(readRootLineage()).toEqual(created.lineage);
  expect(fs.existsSync(rootLineageFile())).toBe(true);
});

test("the file is replaced by rename, leaving no temp file behind", () => {
  recordRootSession({ conversationId: "conversation_a" });
  recordRootSession({ conversationId: "conversation_b" });

  const strays = fs.readdirSync(sandbox).filter((entry) => entry.includes(".tmp"));
  expect(strays).toEqual([]);
});

test("an in-flight reference survives a session rollover because it names the root, not the session", () => {
  const first = recordRootSession({ conversationId: "conversation_a", path: "/tmp/a.jsonl" });
  /* What a durable consumer is allowed to hold on to. */
  const referencedRoot = first.lineage.rootId;

  const rolled = recordRootSession({ conversationId: "conversation_b", path: "/tmp/b.jsonl" }, { reason: "rollover" });

  expect(rolled.outcome).toBe("rolled-over");
  expect(readRootLineage()!.rootId).toBe(referencedRoot);
  expect(headSession(readRootLineage())!.conversationId).toBe("conversation_b");
  expect(continuityMarker(readRootLineage())!.previousConversationId).toBe("conversation_a");
});

test("the root identity is minted once and is stable across later sessions", () => {
  const minted = rootIdentity();

  expect(rootIdentity()).toBe(minted);
  recordRootSession({ conversationId: "conversation_a" });
  recordRootSession({ conversationId: "conversation_b" });
  expect(rootIdentity()).toBe(minted);
});

test("demoting an empty imported lineage preserves the absent-file format", () => {
  expect(readRootLineage()).toBeNull();
  rootLineageStore.checkpointRollbackMirror(rootLineageFile());
  expect(fs.existsSync(rootLineageFile())).toBe(false);
  expect(readRootLineage()).toBeNull();
  expect(rootIdentity()).not.toBe("");
});

test("demoting an empty collection from a torn source also leaves no lineage file", () => {
  fs.mkdirSync(path.dirname(rootLineageFile()), { recursive: true });
  fs.writeFileSync(rootLineageFile(), "{ truncated", { mode: 0o600 });
  expect(readRootLineage()).toBeNull();
  rootLineageStore.checkpointRollbackMirror(rootLineageFile());
  expect(fs.existsSync(rootLineageFile())).toBe(false);
  expect(fs.readdirSync(sandbox).some(name => name.startsWith("root-lineage.json.unreadable-"))).toBe(true);
});

test("a torn lineage is preserved with an import gap", () => {
  fs.mkdirSync(path.dirname(rootLineageFile()), { recursive: true });
  fs.writeFileSync(rootLineageFile(), "{ not json", "utf8");

  expect(readRootLineage()).toBeNull();
  const preserved = fs.readdirSync(sandbox).find(name => name.startsWith("root-lineage.json.unreadable-"));
  expect(preserved).toBeDefined();
  expect(fs.readFileSync(path.join(sandbox, preserved!), "utf8")).toBe("{ not json");
});

test("a lineage written by an unknown schema is refused", () => {
  fs.mkdirSync(path.dirname(rootLineageFile()), { recursive: true });
  fs.writeFileSync(rootLineageFile(), JSON.stringify({ schemaVersion: 99, rootId: "root_x", revision: 0, updatedAt: "", sessions: [] }), "utf8");

  expect(() => readRootLineage()).toThrow(RootLineageStoreError);
});
