import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";

import {
  ACCOUNT_SOURCE_NAMES,
  BINDINGS_SOURCE,
  CLAUDE_ACCOUNTS_SOURCE,
  readAccountSource,
  resetAccountCollectionsForTests,
  writeAccountSource,
} from "@/lib/accounts/accountsStore";
import { boardFor, mutateBoard } from "@/lib/board/store";
import { loadTasks, mutateTasks } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";
import {
  checkpointHotStateRollbackMirrorsForDemotion,
  establishHotStateCutoverBoundary,
  initializeHotStateStoresAtStartup,
} from "@/lib/viewerInstrumentation";

import { HOT_STATE_BACKEND } from "./hotStateAuthority";
import { ensureLegacyCollectionsImported } from "./legacyCollections";
import { readStateImport } from "./sqliteStateStore";

/* The release path of #1870 slice 1 in a sandboxed state directory: a release
   that is not yet promoted reads the legacy file and refuses writes, the
   activation imports, and the demotion checkpoint the deployment adapter also
   runs writes the rollback mirror that the next activation retires. */

const saved = { state: process.env.LLV_STATE_DIR, port: process.env.PORT };
const sandboxes: string[] = [];

afterEach(() => {
  if (saved.state === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = saved.state;
  if (saved.port === undefined) delete process.env.PORT;
  else process.env.PORT = saved.port;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function task(id: string): BoardTask {
  return {
    id,
    project: "proj",
    status: "inbox",
    text: `task ${id}`,
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
  };
}

test("an unpromoted release reads tasks.json, activation imports it, and demotion mirrors it back", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-legacy-collections-"));
  sandboxes.push(sandbox);
  const revision = "7".repeat(40);
  process.env.LLV_STATE_DIR = sandbox;
  process.env.PORT = "19071";
  const tasksFile = path.join(sandbox, "tasks.json");
  fs.writeFileSync(path.join(sandbox, "viewer-release.json"), JSON.stringify({
    endpoint: "http://127.0.0.1:19071",
    revision,
    hotStateBackend: HOT_STATE_BACKEND,
  }));
  fs.writeFileSync(tasksFile, JSON.stringify({ tasks: [task("legacy")] }));

  // Before activation the release may not import: reads fall back to the file, writes are busy.
  expect(loadTasks(tasksFile).map((row) => row.id)).toEqual(["legacy"]);
  expect(() => mutateTasks((tasks) => ({ tasks, result: undefined }), tasksFile)).toThrow("waiting for release promotion");
  expect(fs.statSync(tasksFile).isFile()).toBe(true);

  const boundary = await establishHotStateCutoverBoundary(() => true, {
    pollMs: 0,
    stablePolls: 1,
    maxPolls: 2,
    schedule: (callback) => { callback(); return { unref() {} }; },
  });
  await initializeHotStateStoresAtStartup(boundary);
  const outcomes = await ensureLegacyCollectionsImported();

  expect(outcomes.get("tasks")).toMatchObject({ state: "imported" });
  expect(readStateImport(path.join(sandbox, "state.sqlite"), "tasks")?.release).toBe(revision.slice(0, 12));
  expect(fs.statSync(tasksFile).isDirectory()).toBe(true);
  expect(fs.readdirSync(sandbox).filter((name) => name.startsWith("tasks.json.imported-"))).toEqual([`tasks.json.imported-${revision.slice(0, 12)}`]);
  mutateTasks((tasks) => ({ tasks: [...tasks, task("after-import")], result: undefined }), tasksFile);

  await checkpointHotStateRollbackMirrorsForDemotion();

  const mirror = JSON.parse(fs.readFileSync(tasksFile, "utf8")) as { tasks: BoardTask[] };
  expect(mirror.tasks.map((row) => row.id)).toEqual(["legacy", "after-import"]);

  // Roll-forward: the untouched mirror is recognized and retired, not imported twice.
  const rolledForward = await ensureLegacyCollectionsImported();
  expect(rolledForward.get("tasks")).toMatchObject({ state: "already-imported", incident: null });
  expect(fs.statSync(tasksFile).isDirectory()).toBe(true);
  expect(loadTasks(tasksFile).map((row) => row.id)).toEqual(["legacy", "after-import"]);
});

test("the account stores follow the same release path: unpromoted reads the files, activation imports, demotion mirrors", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-legacy-collections-accounts-"));
  sandboxes.push(sandbox);
  const revision = "5".repeat(40);
  process.env.LLV_STATE_DIR = sandbox;
  process.env.PORT = "19072";
  resetAccountCollectionsForTests();
  fs.writeFileSync(path.join(sandbox, "viewer-release.json"), JSON.stringify({
    endpoint: "http://127.0.0.1:19072",
    revision,
    hotStateBackend: HOT_STATE_BACKEND,
  }));
  const registryFile = path.join(sandbox, "claude-accounts.json");
  const bindingsFile = path.join(sandbox, "account-project-bindings.json");
  fs.writeFileSync(registryFile, JSON.stringify({
    version: 1, active: "default",
    accounts: [{ id: "lane-one", label: "Lane One", kind: "managed", createdAt: 1 }],
    retired: [], removals: [],
  }));
  fs.writeFileSync(bindingsFile, JSON.stringify({
    schemaVersion: 1,
    bindings: [{ engine: "claude", accountId: "lane-one", project: "repo-alpha", createdAt: "2026-09-19T00:00:00.000Z" }],
  }));

  // Before activation this release may not import: reads fall back to the files, writes are busy.
  expect(readAccountSource(CLAUDE_ACCOUNTS_SOURCE, sandbox).kind).toBe("legacy");
  expect(() => writeAccountSource(CLAUDE_ACCOUNTS_SOURCE, {}, sandbox)).toThrow("waiting for release promotion");
  expect(fs.statSync(registryFile).isFile()).toBe(true);

  const boundary = await establishHotStateCutoverBoundary(() => true, {
    pollMs: 0,
    stablePolls: 1,
    maxPolls: 2,
    schedule: (callback) => { callback(); return { unref() {} }; },
  });
  await initializeHotStateStoresAtStartup(boundary);
  const outcomes = await ensureLegacyCollectionsImported();

  expect(outcomes.get("accounts")).toMatchObject({ state: "imported" });
  expect(readStateImport(path.join(sandbox, "state.sqlite"), "accounts")?.release).toBe(revision.slice(0, 12));
  /* Every one of the eight is retired behind its tombstone, the primary and
     its siblings alike. */
  for (const name of ACCOUNT_SOURCE_NAMES) {
    expect([name, fs.statSync(path.join(sandbox, name)).isDirectory()]).toEqual([name, true]);
  }
  expect(readAccountSource(BINDINGS_SOURCE, sandbox)).toMatchObject({
    body: { bindings: [{ accountId: "lane-one", project: "repo-alpha" }] },
  });

  await checkpointHotStateRollbackMirrorsForDemotion();

  // A rollback release finds every store back as the file it knows.
  expect((JSON.parse(fs.readFileSync(registryFile, "utf8")) as { accounts: { id: string }[] }).accounts.map((row) => row.id))
    .toEqual(["lane-one"]);
  expect((JSON.parse(fs.readFileSync(bindingsFile, "utf8")) as { bindings: { project: string }[] }).bindings.map((row) => row.project))
    .toEqual(["repo-alpha"]);
  const marker = JSON.parse(fs.readFileSync(path.join(sandbox, "account-mutation-revision.json"), "utf8")) as { revision: number };
  expect(marker.revision).toBe(readStateImport(path.join(sandbox, "state.sqlite"), "accounts")!.mirrorRevision!);

  // Roll-forward: the untouched mirror is recognized and retired, not imported twice.
  resetAccountCollectionsForTests();
  const rolledForward = await ensureLegacyCollectionsImported();
  expect(rolledForward.get("accounts")).toMatchObject({ state: "already-imported", incident: null });
  expect(fs.statSync(registryFile).isDirectory()).toBe(true);
  expect(readAccountSource(CLAUDE_ACCOUNTS_SOURCE, sandbox)).toMatchObject({
    body: { accounts: [{ id: "lane-one" }] },
  });
});

test("the board joins the same activation import and demotion mirror", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-legacy-collections-board-"));
  sandboxes.push(sandbox);
  const revision = "5".repeat(40);
  process.env.LLV_STATE_DIR = sandbox;
  process.env.PORT = "19072";
  const boardFile = path.join(sandbox, "board.json");
  fs.writeFileSync(path.join(sandbox, "viewer-release.json"), JSON.stringify({
    endpoint: "http://127.0.0.1:19072",
    revision,
    hotStateBackend: HOT_STATE_BACKEND,
  }));
  fs.writeFileSync(boardFile, JSON.stringify({ projects: { repo: {
    schemaVersion: 1,
    revision: 2,
    updatedAt: "2026-09-19T00:00:00.000Z",
    prefs: { manual: ["/legacy"], hidden: [], expanded: [], viewMode: null, taskPanelOpen: false },
  } } }));

  // Before activation the release may not import: reads fall back to the file, writes are busy.
  expect(boardFor("repo", boardFile).prefs.manual).toEqual(["/legacy"]);
  expect(() => mutateBoard("repo", 2, [{ kind: "close", path: "/legacy" }], boardFile))
    .toThrow("waiting for release promotion");
  expect(fs.statSync(boardFile).isFile()).toBe(true);

  const boundary = await establishHotStateCutoverBoundary(() => true, {
    pollMs: 0,
    stablePolls: 1,
    maxPolls: 2,
    schedule: (callback) => { callback(); return { unref() {} }; },
  });
  await initializeHotStateStoresAtStartup(boundary);
  const outcomes = await ensureLegacyCollectionsImported();

  expect(outcomes.get("board")).toMatchObject({ state: "imported" });
  expect(readStateImport(path.join(sandbox, "state.sqlite"), "board")?.release).toBe(revision.slice(0, 12));
  expect(fs.statSync(boardFile).isDirectory()).toBe(true);
  expect(mutateBoard("repo", 2, [{ kind: "restore", path: "/after-import", placement: "manual" }], boardFile).ok).toBe(true);

  await checkpointHotStateRollbackMirrorsForDemotion();

  const mirror = JSON.parse(fs.readFileSync(boardFile, "utf8")) as { projects: Record<string, { prefs: { manual: string[] } }> };
  expect(mirror.projects.repo!.prefs.manual).toEqual(["/legacy", "/after-import"]);

  // Roll-forward: the untouched mirror is recognized and retired, not imported twice.
  const rolledForward = await ensureLegacyCollectionsImported();
  expect(rolledForward.get("board")).toMatchObject({ state: "already-imported", incident: null });
  expect(fs.statSync(boardFile).isDirectory()).toBe(true);
  expect(boardFor("repo", boardFile).prefs.manual).toEqual(["/legacy", "/after-import"]);
});
