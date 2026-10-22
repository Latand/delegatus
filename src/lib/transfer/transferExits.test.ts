import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureLegacyCollectionsImported } from "@/lib/state/legacyCollections";

import { exportTransferBundle } from "./exporter";
import { previewTransferImport, readImportRecords, recoverTransferImportsAtStartup } from "./importer";
import { applyBundle } from "./service";
import { installEnv, makeInstall, NOW, REPOSITORY, seedSource, treeDigest, within, type Install } from "./transfer.fixture";
import type { TransferPlan } from "./types";
import type { TransferWorkerResponse } from "./workerProtocol";

/* Every exit of apply (docs/design/install-memory-transfer.md §4.7), each
   driven in a real worker process by fault injection: a failed file step, a
   failed SQLite commit, and a hard kill at each point between the checkpoint
   and the cleanup, recovered by the worker's recovery, by the Viewer's
   startup step and by the Viewer's own handler when its worker dies. */

const WORKER = path.join(import.meta.dir, "transfer.worker.ts");
let parent: string;
let source: Install;
let bundle: Buffer;

function sqliteRows(install: Install): string {
  const file = path.join(install.state, "state.sqlite");
  if (!fs.existsSync(file)) return "";
  const db = new Database(file, { readonly: true });
  try {
    const rows = db.query<{ collection: string; row_key: string; value_json: string }, []>("SELECT collection, row_key, value_json FROM state_rows ORDER BY collection, row_key").all();
    /* An owner may initialize an empty collection before the transaction; a
       collection with no row and no write holds nothing to restore. */
    const revisions = db.query<{ collection: string; revision: number }, []>("SELECT collection, revision FROM state_collections ORDER BY collection").all()
      .filter(entry => entry.revision > 0 || rows.some(row => row.collection === entry.collection));
    return JSON.stringify({ rows, revisions });
  } finally { db.close(); }
}

/** Files other than the databases, the transfer's own journal and the account
    lock (a killed holder leaves its lock file; the next holder takes it over),
    plus every SQLite row and revision. */
function snapshot(install: Install) {
  const files = Object.fromEntries(Object.entries(treeDigest(install.root)).filter(([file]) => !/\.sqlite(?:-wal|-shm)?$/.test(file)
    && !file.includes("transfer/imports/") && !file.includes("transfer/staged/") && !file.includes("account-selection.lock")));
  return { files, rows: sqliteRows(install) };
}

async function runWorker(install: Install, request: unknown, fault?: string): Promise<{ code: number | null; signal: string | null; response: TransferWorkerResponse | null }> {
  const child = Bun.spawn([process.execPath, WORKER], {
    env: { ...process.env, ...installEnv(install), HOME: install.home, NODE_ENV: "test", ...(fault ? { LLV_TRANSFER_TEST_FAULT: fault } : {}) },
    stdin: "pipe", stdout: "pipe", stderr: "inherit",
  });
  child.stdin.write(JSON.stringify(request));
  child.stdin.end();
  const [code, text] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  const line = text.trim().split("\n").at(-1);
  return { code: child.signalCode ? null : code, signal: child.signalCode ?? null, response: line ? JSON.parse(line) as TransferWorkerResponse : null };
}

async function prepared(name: string): Promise<{ target: Install; plan: TransferPlan; mappings: Record<string, string> }> {
  const target = makeInstall(parent, name);
  await within(target, () => ensureLegacyCollectionsImported(() => {}));
  // A setting the import replaces, so the checkpoint holds a file to restore.
  fs.writeFileSync(path.join(target.state, "operator-settings.json"), JSON.stringify({ schemaVersion: 1 }));
  const plan = await within(target, () => previewTransferImport(bundle, {}));
  return { target, plan, mappings: {} };
}

function journalStates(target: Install): string[] {
  const root = path.join(target.state, "transfer", "imports");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).map(name => (JSON.parse(fs.readFileSync(path.join(root, name, "journal.json"), "utf8")) as { state: string }).state);
}

beforeAll(async () => {
  parent = fs.mkdtempSync(path.join(os.tmpdir(), "transfer-exits-"));
  source = makeInstall(parent, "source");
  await seedSource(source);
  bundle = (await within(source, () => exportTransferBundle({ now: new Date(NOW), exportId: "export-exits", product: "test", env: {} }))).bytes;
}, 120_000);

afterAll(() => { fs.rmSync(parent, { recursive: true, force: true }); });

describe("apply exits", () => {
  test("a failed file step restores replaced files, deletes created ones and leaves SQLite untouched", async () => {
    const { target, plan } = await prepared("file-step");
    const before = snapshot(target);
    const result = await runWorker(target, { operation: "apply", request: { bundleSha256: plan.bundleSha256, revisions: plan.revisions } }, "file-step");
    expect(result.code).toBe(0);
    expect(result.response).toMatchObject({ ok: false, error: { code: "failed" } });
    expect(snapshot(target)).toEqual(before);
    expect(journalStates(target)).toEqual(["rolled-back"]);
  }, 60_000);

  test("a failed SQLite commit rolls the rows back and restores the files", async () => {
    const { target, plan } = await prepared("sqlite");
    const before = snapshot(target);
    const result = await runWorker(target, { operation: "apply", request: { bundleSha256: plan.bundleSha256, revisions: plan.revisions } }, "sqlite");
    expect(result.response).toMatchObject({ ok: false });
    expect(snapshot(target)).toEqual(before);
    expect(await within(target, () => readImportRecords())).toEqual([]);
  }, 60_000);

  for (const fault of ["die-after-checkpoint", "die-after-files"] as const) {
    test(`a worker killed at ${fault} is rolled back by recovery`, async () => {
      const { target, plan } = await prepared(fault);
      const before = snapshot(target);
      const result = await runWorker(target, { operation: "apply", request: { bundleSha256: plan.bundleSha256, revisions: plan.revisions } }, fault);
      expect(result.signal).toBe("SIGKILL");
      expect(journalStates(target)).toEqual(["writing"]);
      if (fault === "die-after-files") expect(snapshot(target).files).not.toEqual(before.files);
      const recovered = await runWorker(target, { operation: "recover" });
      expect(recovered.response).toMatchObject({ ok: true, result: [{ outcome: "rolled-back" }] });
      expect(snapshot(target)).toEqual(before);
      expect(journalStates(target)).toEqual(["rolled-back"]);
      expect((await runWorker(target, { operation: "recover" })).response).toEqual({ ok: true, result: [] });
    }, 60_000);
  }

  test("a worker killed after its commit is finished by recovery, never undone", async () => {
    const { target, plan } = await prepared("die-after-commit");
    const result = await runWorker(target, { operation: "apply", request: { bundleSha256: plan.bundleSha256, revisions: plan.revisions } }, "die-after-commit");
    expect(result.signal).toBe("SIGKILL");
    const [record] = await within(target, () => readImportRecords());
    expect(record?.bundleSha256).toBe(plan.bundleSha256);
    const recovered = await runWorker(target, { operation: "recover" });
    expect(recovered.response).toMatchObject({ ok: true, result: [{ importId: record!.importId, outcome: "finished" }] });
    expect(journalStates(target)).toEqual(["done"]);
    expect(fs.existsSync(path.join(target.state, "transfer", "imports", record!.importId, "checkpoint"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(target.state, "project-settings.json"), "utf8")).projects[REPOSITORY].mergeOnReview.enabled).toBe(true);
  }, 60_000);

  test("the Viewer's startup step settles an import its previous process left mid-write", async () => {
    const { target, plan } = await prepared("startup");
    const before = snapshot(target);
    const result = await runWorker(target, { operation: "apply", request: { bundleSha256: plan.bundleSha256, revisions: plan.revisions } }, "die-after-files");
    expect(result.signal).toBe("SIGKILL");
    expect(await within(target, () => recoverTransferImportsAtStartup())).toEqual([{ importId: expect.any(String), outcome: "rolled-back" }]);
    expect(snapshot(target)).toEqual(before);
  }, 60_000);

  test("the Viewer recovers at once when its apply worker dies, and a clean apply then succeeds", async () => {
    const { target, plan } = await prepared("viewer-handler");
    const before = snapshot(target);
    const launch = { executable: process.execPath, workerPath: WORKER };
    const died = await within(target, () => applyBundle({ bundleSha256: plan.bundleSha256, revisions: plan.revisions }, { launch, env: { HOME: target.home, NODE_ENV: "test", LLV_TRANSFER_TEST_FAULT: "die-after-files" } }));
    expect(died).toMatchObject({ ok: false, error: { code: "worker_stopped" }, recovered: [{ outcome: "rolled-back" }] });
    expect(snapshot(target)).toEqual(before);
    const applied = await within(target, () => applyBundle({ bundleSha256: plan.bundleSha256, revisions: plan.revisions }, { launch, env: { HOME: target.home, NODE_ENV: "test" } }));
    expect(applied).toMatchObject({ ok: true, result: { complete: true } });
  }, 60_000);
});
