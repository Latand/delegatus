import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureLegacyCollectionsImported } from "@/lib/state/legacyCollections";
import { settleInterruptedTransfers } from "@/lib/viewerInstrumentation";

import { exportTransferBundle } from "./exporter";
import { applyTransferImport, previewTransferImport, readImportRecords, recoverTransferImportsAtStartup, TransferImportError } from "./importer";
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

async function prepared(name: string, setup: (target: Install) => void = () => {}): Promise<{ target: Install; plan: TransferPlan; mappings: Record<string, string> }> {
  const target = makeInstall(parent, name);
  await within(target, () => ensureLegacyCollectionsImported(() => {}));
  // A setting the import replaces, so the checkpoint holds a file to restore.
  fs.writeFileSync(path.join(target.state, "operator-settings.json"), JSON.stringify({ schemaVersion: 1 }));
  setup(target);
  const plan = await within(target, () => previewTransferImport(bundle, {}));
  return { target, plan, mappings: {} };
}

function journals(target: Install): { directory: string; journal: { state: string; files: { relative: string; before: string | null; backup: { name: string } | null }[] } }[] {
  const root = path.join(target.state, "transfer", "imports");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).map(name => ({ directory: path.join(root, name), journal: JSON.parse(fs.readFileSync(path.join(root, name, "journal.json"), "utf8")) }));
}

function journalStates(target: Install): string[] {
  return journals(target).map(entry => entry.journal.state);
}

/** A writer that takes no lock: it rewrites the file in place of whatever is there. */
const writeRaw = (target: Install, relative: string, text: string) => fs.writeFileSync(path.join(target.state, relative), text);

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

  test("a disk that fills during the writes leaves every original file and row, though the undo itself cannot allocate", async () => {
    // The first file the import writes replaces one this install has, so the undo has to put it back.
    const { target, plan } = await prepared("disk-full", target => writeRaw(target, "shared-memory-settings.json", "{}\n"));
    const before = snapshot(target);
    const result = await runWorker(target, { operation: "apply", request: { bundleSha256: plan.bundleSha256, revisions: plan.revisions } }, "disk-full");
    expect(result.code).toBe(0);
    expect(result.response).toMatchObject({ ok: false, error: { code: "failed" } });
    expect(String((result.response as { error: { message: string } }).error.message)).toContain("ENOSPC");
    // Intact before any recovery runs: the undo was renames and removals only.
    expect(snapshot(target)).toEqual(before);
    expect(await within(target, () => readImportRecords())).toEqual([]);
    const [{ journal }] = journals(target);
    expect([journal.state, journal.files[0]?.relative, journal.files[0]?.before !== null]).toEqual(["writing", "shared-memory-settings.json", true]);
    // The journal could not record its end on the full disk; the next recovery finds nothing left to undo.
    expect((await runWorker(target, { operation: "recover" })).response).toMatchObject({ ok: true, result: [{ outcome: "rolled-back" }] });
    expect(snapshot(target)).toEqual(before);
    expect(journalStates(target)).toEqual(["rolled-back"]);
  }, 60_000);

  test("a writer that came in after the first write refuses the import and keeps its bytes, a file it created included", async () => {
    const { target, plan } = await prepared("concurrent");
    const before = snapshot(target);
    const writerOperator = `${JSON.stringify({ schemaVersion: 1, locale: { value: "en", source: "chosen", changedAt: NOW } })}\n`;
    const writerProjects = `${JSON.stringify({ schemaVersion: 1, projects: { [`repo-${"c".repeat(32)}`]: { bridgeReports: { enabled: false, changedAt: NOW, changedBy: "operator" } } } })}\n`;
    const failure = await within(target, () => applyTransferImport({ bundleSha256: plan.bundleSha256, revisions: plan.revisions }, {
      afterFileWrite: index => {
        if (index !== 0) return;
        writeRaw(target, "operator-settings.json", writerOperator);
        // Absent at the dry run, the import's to create: a writer made it first.
        writeRaw(target, "project-settings.json", writerProjects);
      },
    })).then(() => null, (error: unknown) => error);
    expect((failure as TransferImportError).code).toBe("target_changed");
    const after = snapshot(target);
    expect(fs.readFileSync(path.join(target.state, "operator-settings.json"), "utf8")).toBe(writerOperator);
    expect(fs.readFileSync(path.join(target.state, "project-settings.json"), "utf8")).toBe(writerProjects);
    const others = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).filter(([file]) => !/(?:operator|project)-settings\.json$/.test(file)));
    expect(others(after.files)).toEqual(others(before.files));
    expect(after.rows).toEqual(before.rows);
    expect(await within(target, () => readImportRecords())).toEqual([]);
  }, 60_000);

  test("writers between a stop and its recovery keep what they wrote; recovery undoes only the import's own values", async () => {
    // Stopped before any write: nothing there is the import's.
    const early = await prepared("stop-before-writes");
    const earlyBefore = snapshot(early.target);
    expect((await runWorker(early.target, { operation: "apply", request: { bundleSha256: early.plan.bundleSha256, revisions: early.plan.revisions } }, "die-after-checkpoint")).signal).toBe("SIGKILL");
    const created = `${JSON.stringify({ schemaVersion: 1, projects: {} })}\n`;
    writeRaw(early.target, "project-settings.json", created);
    writeRaw(early.target, "operator-settings.json", "{\"schemaVersion\":1,\"by\":\"writer\"}\n");
    await within(early.target, () => recoverTransferImportsAtStartup());
    expect(fs.readFileSync(path.join(early.target.state, "project-settings.json"), "utf8")).toBe(created);
    expect(fs.readFileSync(path.join(early.target.state, "operator-settings.json"), "utf8")).toBe("{\"schemaVersion\":1,\"by\":\"writer\"}\n");
    const unrelated = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).filter(([file]) => !/(?:operator|project)-settings\.json$/.test(file)));
    expect(unrelated(snapshot(early.target).files)).toEqual(unrelated(earlyBefore.files));

    // Stopped after its writes: a writer then adds its own project to a file the import created.
    const late = await prepared("stop-after-writes");
    const lateBefore = snapshot(late.target);
    expect((await runWorker(late.target, { operation: "apply", request: { bundleSha256: late.plan.bundleSha256, revisions: late.plan.revisions } }, "die-after-files")).signal).toBe("SIGKILL");
    const file = path.join(late.target.state, "project-settings.json");
    const imported = JSON.parse(fs.readFileSync(file, "utf8")) as { projects: Record<string, unknown> };
    expect(Object.keys(imported.projects)).toEqual([REPOSITORY]);
    const other = `repo-${"d".repeat(32)}`;
    fs.writeFileSync(file, `${JSON.stringify({ ...imported, projects: { ...imported.projects, [other]: { bridgeReports: { enabled: false, changedAt: NOW, changedBy: "operator" } } } }, null, 2)}\n`);
    const [outcome] = await within(late.target, () => recoverTransferImportsAtStartup());
    expect(outcome).toMatchObject({ outcome: "rolled-back", kept: ["project-settings.json"] });
    expect(Object.keys((JSON.parse(fs.readFileSync(file, "utf8")) as { projects: Record<string, unknown> }).projects)).toEqual([other]);
    const lateAfter = snapshot(late.target);
    expect(Object.fromEntries(Object.entries(lateAfter.files).filter(([name]) => !name.endsWith("project-settings.json")))).toEqual(lateBefore.files);
    expect(lateAfter.rows).toEqual(lateBefore.rows);
  }, 120_000);

  test("a commit cut short before its known values is finished by recovery: the stale file then holds the new lessons", async () => {
    const { target, plan } = await prepared("known-values", target => {
      fs.mkdirSync(path.join(target.state, "role-memory"), { recursive: true });
      writeRaw(target, path.join("role-memory", "known-values.txt"), "a stale value\n");
    });
    expect((await runWorker(target, { operation: "apply", request: { bundleSha256: plan.bundleSha256, revisions: plan.revisions } }, "die-after-commit")).signal).toBe("SIGKILL");
    const known = path.join(target.state, "role-memory", "known-values.txt");
    expect(fs.readFileSync(known, "utf8")).toBe("a stale value\n");
    expect((await within(target, () => readImportRecords()))[0]?.followUp.knownValues).toBe(true);
    await runWorker(target, { operation: "recover" });
    expect(fs.readFileSync(known, "utf8")).toContain("Keep public text free of identities.");
    expect((await within(target, () => readImportRecords()))[0]?.followUp).toEqual({ knownValues: false, accounts: false });
  }, 60_000);

  test("a recovery that cannot settle refuses the Viewer's activation, and the next start settles the same journal", async () => {
    const { target, plan } = await prepared("startup-refused");
    const before = snapshot(target);
    expect((await runWorker(target, { operation: "apply", request: { bundleSha256: plan.bundleSha256, revisions: plan.revisions } }, "die-after-files")).signal).toBe("SIGKILL");
    const [{ directory, journal }] = journals(target);
    const replaced = journal.files.find(entry => entry.backup)!;
    const backup = path.join(directory, "checkpoint", replaced.backup!.name);
    const aside = path.join(target.root, "aside");
    fs.renameSync(backup, aside);
    await expect(within(target, () => settleInterruptedTransfers())).rejects.toThrow(/activation refused: .*checkpoint copy of operator-settings\.json is missing/);
    expect(journalStates(target)).toEqual(["writing"]);
    fs.renameSync(aside, backup);
    await within(target, () => settleInterruptedTransfers());
    expect(journalStates(target)).toEqual(["rolled-back"]);
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
