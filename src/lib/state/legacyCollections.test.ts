import crypto from "node:crypto";
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
import {
  authorizeCodexForkRetry,
  persistedCodexOperationJournal,
  resetMigrationOperationStoreForTests,
} from "@/lib/accounts/migration/provider";
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

/* The conversation-migration journal roots are the one moved store whose
   legacy form is a directory of per-operation files. They mirror back the same
   way (§6.4): every row becomes its `<sha>.json` again, and what the rollback
   release wrote into those files is folded back at roll-forward. */
const MIGRATION_OPS_COLLECTION = "account_migration_ops:migration-provider-operations";

function journalBody(operationId: string, extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    operationId,
    conversationId: `conversation_${operationId.replace(/-/g, "_")}`,
    sourceNativeId: "719f423a-d6e9-4903-b597-3e676b6ff3d4",
    sourceRoot: "/source/sessions",
    targetRoot: "/target/sessions",
    createdAtMs: 1_700_000_000_000,
    forkRecoveryFloorMs: null,
    forkRequestedAtMs: null,
    fork: null,
    forkSource: null,
    supersededForks: [],
    ...extra,
  };
}

test("the conversation-migration journals import at activation and mirror back for a rollback release", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-legacy-collections-migration-ops-"));
  sandboxes.push(sandbox);
  const revision = "3".repeat(40);
  process.env.LLV_STATE_DIR = sandbox;
  process.env.PORT = "19073";
  resetMigrationOperationStoreForTests();
  fs.writeFileSync(path.join(sandbox, "viewer-release.json"), JSON.stringify({
    endpoint: "http://127.0.0.1:19073",
    revision,
    hotStateBackend: HOT_STATE_BACKEND,
  }));
  const root = path.join(sandbox, "migration-provider-operations");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const journalFile = (operationId: string) =>
    path.join(root, `${crypto.createHash("sha256").update(operationId).digest("hex")}.json`);
  /* A fork this operation asked for and never heard back about: the one shape
     that lets an operator retry write the journal again. */
  fs.writeFileSync(journalFile("op-one"), JSON.stringify(journalBody("op-one", { forkRequestedAtMs: 1_700_000_000_500 })));

  // Before activation this release may not import: reads fall back to the files, writes are busy.
  expect(persistedCodexOperationJournal(root, "op-one")?.forkRequestedAtMs).toBe(1_700_000_000_500);
  await expect(authorizeCodexForkRetry("op-one", "conversation_op_one", root, () => []))
    .rejects.toThrow("waiting for release promotion");
  expect(fs.statSync(journalFile("op-one")).isFile()).toBe(true);

  const boundary = await establishHotStateCutoverBoundary(() => true, {
    pollMs: 0,
    stablePolls: 1,
    maxPolls: 2,
    schedule: (callback) => { callback(); return { unref() {} }; },
  });
  await initializeHotStateStoresAtStartup(boundary);
  const outcomes = await ensureLegacyCollectionsImported();

  expect(outcomes.get(MIGRATION_OPS_COLLECTION)).toMatchObject({ state: "imported" });
  /* The Claude root journals nothing yet and still joins the import, so its
     mirror is defined for the same rollback. Neither entry may be an Error:
     `ensureLegacyCollectionsImported` logs a failed store and carries on. */
  expect(outcomes.get("account_migration_ops:migration-provider-claude-operations"))
    .toMatchObject({ state: "imported", record: { rowCount: 0 } });
  const imported = readStateImport(path.join(sandbox, "state.sqlite"), MIGRATION_OPS_COLLECTION);
  expect([imported?.rowCount, imported?.release]).toEqual([1, revision.slice(0, 12)]);
  /* The root stays a directory — the per-operation lease lives in it — and each
     imported journal leaves the tombstone. */
  expect(fs.statSync(root).isDirectory()).toBe(true);
  expect(fs.statSync(journalFile("op-one")).isDirectory()).toBe(true);
  expect(persistedCodexOperationJournal(root, "op-one")?.forkRequestedAtMs).toBe(1_700_000_000_500);

  // A write now lands in the collection, not in the tombstoned file.
  expect(await authorizeCodexForkRetry("op-one", "conversation_op_one", root, () => [])).toBe("reauthorized");
  expect(persistedCodexOperationJournal(root, "op-one")?.forkRequestedAtMs).toBeNull();

  await checkpointHotStateRollbackMirrorsForDemotion();

  // A rollback release finds every journal back as the file it knows.
  expect(fs.statSync(journalFile("op-one")).isFile()).toBe(true);
  expect(JSON.parse(fs.readFileSync(journalFile("op-one"), "utf8")))
    .toEqual(persistedCodexOperationJournal(root, "op-one"));
  expect(readStateImport(path.join(sandbox, "state.sqlite"), MIGRATION_OPS_COLLECTION)?.mirrorRevision)
    .toBeGreaterThan(0);

  /* What the rollback release does on its JSON: it advances one journal and
     starts another. Both are its writes, and both must survive roll-forward. */
  fs.writeFileSync(journalFile("op-one"), JSON.stringify(journalBody("op-one", {
    fork: { id: "719f423a-d6e9-4903-8597-000000000001", path: "/source/sessions/rollout.jsonl" },
  })));
  fs.writeFileSync(journalFile("op-two"), JSON.stringify(journalBody("op-two")));

  resetMigrationOperationStoreForTests();
  const rolledForward = await ensureLegacyCollectionsImported();

  expect(rolledForward.get(MIGRATION_OPS_COLLECTION)).toMatchObject({ state: "already-imported" });
  expect(fs.statSync(journalFile("op-one")).isDirectory()).toBe(true);
  expect(fs.statSync(journalFile("op-two")).isDirectory()).toBe(true);
  expect(persistedCodexOperationJournal(root, "op-one")?.fork?.id).toBe("719f423a-d6e9-4903-8597-000000000001");
  expect(persistedCodexOperationJournal(root, "op-two")?.conversationId).toBe("conversation_op_two");
});
