import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AccountMutationBusyError, withAccountMutationLockAsync } from "@/lib/accounts/accountMutation";
import { ensureLegacyCollectionsImported } from "@/lib/state/legacyCollections";
import { writeTranscribeBackend } from "@/lib/transcribeBackend";
import { writeTtsBackend } from "@/lib/ttsBackend";
import { settleInterruptedTransfers } from "@/lib/viewerInstrumentation";

import { exportTransferBundle } from "./exporter";
import { applyTransferImport, previewTransferImport, readImportRecords, recoverTransferImports, recoverTransferImportsAtStartup, TransferImportError } from "./importer";
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
const REPO = path.resolve(import.meta.dir, "../../..");
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

async function runWorker(install: Install, request: unknown, fault?: string, extra: Record<string, string> = {}): Promise<{ code: number | null; signal: string | null; response: TransferWorkerResponse | null }> {
  const child = Bun.spawn([process.execPath, WORKER], {
    env: { ...process.env, ...installEnv(install), HOME: install.home, NODE_ENV: "test", ...(fault ? { LLV_TRANSFER_TEST_FAULT: fault } : {}), ...extra },
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

function journals(target: Install): { directory: string; journal: { state: string; files: { root: string; relative: string; before: string | null; backup: { relative: string } | null }[] } }[] {
  const root = path.join(target.state, "transfer", "imports");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).map(name => ({ directory: path.join(root, name), journal: JSON.parse(fs.readFileSync(path.join(root, name, "journal.json"), "utf8")) }));
}

function journalStates(target: Install): string[] {
  return journals(target).map(entry => entry.journal.state);
}

/** Whether the target's database holds an import's ledger row, read straight from SQLite. */
function ledgerVisible(target: Install): boolean {
  const db = new Database(path.join(target.state, "state.sqlite"), { readonly: true });
  try { return !!db.query("SELECT 1 FROM state_rows WHERE collection = 'transfer_imports'").get(); }
  finally { db.close(); }
}

/** `chmodSync` of the target's database fails as an I/O error does, once, the first time after an import's commit is visible: the step `commitPatchesSync` runs after COMMIT. */
function failChmodAfterCommit(target: Install) {
  const database = path.join(target.state, "state.sqlite");
  const original = fs.chmodSync;
  const state = { fired: false };
  const spy = spyOn(fs, "chmodSync").mockImplementation(((file: fs.PathLike, mode: fs.Mode) => {
    if (!state.fired && String(file) === database && ledgerVisible(target)) {
      state.fired = true;
      throw Object.assign(new Error("EIO: i/o error, chmod (injected)"), { code: "EIO" });
    }
    return original(file, mode);
  }) as typeof fs.chmodSync);
  return { state, restore: () => spy.mockRestore() };
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

  test("a failure after COMMIT keeps the commit: the rows and the files stay together, recovery included", async () => {
    const { target, plan } = await prepared("after-commit-error");
    const created = path.join(target.state, "project-settings.json");
    expect(fs.existsSync(created)).toBe(false);
    const chmod = failChmodAfterCommit(target);
    const { report } = await within(target, () => applyTransferImport({ bundleSha256: plan.bundleSha256, revisions: plan.revisions })).finally(() => chmod.restore());
    expect(chmod.state.fired).toBe(true);
    expect(report.complete).toBe(true);
    const imported = snapshot(target);
    const [record] = await within(target, () => readImportRecords());
    expect(record?.importId).toBe(report.importId);
    expect(JSON.parse(fs.readFileSync(created, "utf8")).projects[REPOSITORY].mergeOnReview.enabled).toBe(true);
    expect(journalStates(target)).toEqual(["done"]);
    expect((await runWorker(target, { operation: "recover" })).response).toEqual({ ok: true, result: [] });
    expect(snapshot(target)).toEqual(imported);
  }, 60_000);

  test("a commit whose outcome cannot be read is never undone on a guess: recovery waits until it reads, then finishes it", async () => {
    const { target, plan } = await prepared("after-commit-unknown");
    const created = path.join(target.state, "project-settings.json");
    const chmod = failChmodAfterCommit(target);
    process.env.LLV_TRANSFER_TEST_READ_FAULT = "ledger";
    let failure: unknown;
    try {
      failure = await within(target, () => applyTransferImport({ bundleSha256: plan.bundleSha256, revisions: plan.revisions })).then(() => null, (error: unknown) => error);
      expect(String((failure as Error)?.message)).toMatch(/whether it landed cannot be read yet/);
      // Committed, and nothing undone: the journal stays open for recovery.
      expect(journalStates(target)).toEqual(["writing"]);
      expect(await within(target, () => readImportRecords())).toHaveLength(1);
      expect(fs.existsSync(created)).toBe(true);
      const held = snapshot(target);
      await expect(within(target, () => settleInterruptedTransfers())).rejects.toThrow(/activation refused: .*whether import .* committed cannot be read \(EIO\)/);
      expect(journalStates(target)).toEqual(["writing"]);
      expect(snapshot(target)).toEqual(held);
    } finally {
      chmod.restore();
      delete process.env.LLV_TRANSFER_TEST_READ_FAULT;
    }
    const settled = await within(target, () => recoverTransferImports());
    expect(settled).toEqual([{ importId: expect.any(String), outcome: "finished" }]);
    expect(journalStates(target)).toEqual(["done"]);
    expect(JSON.parse(fs.readFileSync(created, "utf8")).projects[REPOSITORY].mergeOnReview.enabled).toBe(true);
  }, 60_000);

  test("a commit that failed, with its outcome unreadable, waits for recovery, which then undoes it", async () => {
    const { target, plan } = await prepared("failed-commit-unknown");
    const before = snapshot(target);
    process.env.LLV_TRANSFER_TEST_FAULT = "sqlite";
    process.env.LLV_TRANSFER_TEST_READ_FAULT = "ledger";
    try {
      const failure = await within(target, () => applyTransferImport({ bundleSha256: plan.bundleSha256, revisions: plan.revisions })).then(() => null, (error: unknown) => error);
      expect(String((failure as Error)?.message)).toMatch(/whether it landed cannot be read yet/);
    } finally {
      delete process.env.LLV_TRANSFER_TEST_FAULT;
      delete process.env.LLV_TRANSFER_TEST_READ_FAULT;
    }
    expect(journalStates(target)).toEqual(["writing"]);
    expect(snapshot(target).files).not.toEqual(before.files);
    expect(await within(target, () => recoverTransferImports())).toEqual([{ importId: expect.any(String), outcome: "rolled-back" }]);
    expect(snapshot(target)).toEqual(before);
  }, 60_000);

  test("a file system that refuses links refuses the creation of a new file, with nothing written under its name", async () => {
    const { target, plan } = await prepared("links-refused");
    const before = snapshot(target);
    const link = spyOn(fs, "linkSync").mockImplementation(() => { throw Object.assign(new Error("EPERM: operation not permitted, link (injected)"), { code: "EPERM" }); });
    let failure: unknown;
    try { failure = await within(target, () => applyTransferImport({ bundleSha256: plan.bundleSha256, revisions: plan.revisions })).then(() => null, (error: unknown) => error); }
    finally { link.mockRestore(); }
    expect((failure as Error).name).toBe("TransferLinkRefusedError");
    expect(snapshot(target)).toEqual(before);
    expect(journalStates(target)).toEqual(["rolled-back"]);
  }, 60_000);

  test("a write that fails part way through a new file leaves no partial file under its name", async () => {
    const { target, plan } = await prepared("partial-create");
    const before = snapshot(target);
    const original = fs.writeFileSync;
    let partial = 0;
    const write = spyOn(fs, "writeFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      if (typeof file === "string" && file.endsWith(".transfer-new") && path.basename(file).startsWith(".project-settings.json.")) {
        partial += 1;
        original(file, String(data).slice(0, 8), options);
        throw Object.assign(new Error("ENOSPC: no space left on device, write (injected)"), { code: "ENOSPC" });
      }
      return original(file, data, options);
    }) as typeof fs.writeFileSync);
    let failure: unknown;
    try { failure = await within(target, () => applyTransferImport({ bundleSha256: plan.bundleSha256, revisions: plan.revisions })).then(() => null, (error: unknown) => error); }
    finally { write.mockRestore(); }
    expect(partial).toBe(1);
    expect(String((failure as Error).message)).toContain("ENOSPC");
    expect(fs.existsSync(path.join(target.state, "project-settings.json"))).toBe(false);
    expect(snapshot(target)).toEqual(before);
    expect(await within(target, () => recoverTransferImports())).toEqual([]);
    expect(snapshot(target)).toEqual(before);
  }, 60_000);

  test("a worker killed while a new file is staged leaves nothing under its name, and recovery removes the staged bytes", async () => {
    const { target, plan } = await prepared("die-before-link");
    const before = snapshot(target);
    const result = await runWorker(target, { operation: "apply", request: { bundleSha256: plan.bundleSha256, revisions: plan.revisions } }, "die-before-link");
    expect(result.signal).toBe("SIGKILL");
    const [{ journal }] = journals(target);
    const created = journal.files.find(entry => entry.before === null)!;
    expect(fs.existsSync(path.join(target.state, created.relative))).toBe(false);
    expect(fs.readdirSync(path.dirname(path.join(target.state, created.relative))).filter(name => name.endsWith(".transfer-new"))).toHaveLength(1);
    expect((await runWorker(target, { operation: "recover" })).response).toMatchObject({ ok: true, result: [{ outcome: "rolled-back" }] });
    expect(snapshot(target)).toEqual(before);
  }, 60_000);

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
    const [{ journal }] = journals(target);
    const replaced = journal.files.find(entry => entry.backup)!;
    expect(replaced.root).toBe("state");
    const backup = path.join(target.state, replaced.backup!.relative);
    const aside = path.join(target.root, "aside");
    fs.renameSync(backup, aside);
    await expect(within(target, () => settleInterruptedTransfers())).rejects.toThrow(/activation refused: .*checkpoint copy of operator-settings\.json is missing/);
    expect(journalStates(target)).toEqual(["writing"]);
    fs.renameSync(aside, backup);
    await within(target, () => settleInterruptedTransfers());
    expect(journalStates(target)).toEqual(["rolled-back"]);
    expect(snapshot(target)).toEqual(before);
  }, 60_000);

  test("a real writer of a file the import writes waits for the import, and keeps its value after a successful apply and after a rollback", async () => {
    const other = `repo-${"e".repeat(32)}`;
    /* The product's own writer in a process of its own, as the Viewer is to the apply worker. */
    const writer = (target: Install) => Bun.spawn([process.execPath, "-e",
      `import(${JSON.stringify(path.join(REPO, "src/lib/memory/settings.ts"))}).then(({ setSharedMemoryEnabled }) => setSharedMemoryEnabled(${JSON.stringify(other)}, true)).catch(error => { console.error(error); process.exit(1); });`], {
      cwd: REPO, env: { ...process.env, ...installEnv(target), HOME: target.home, LLV_TRANSFER_TEST_FAULT: "" }, stdout: "inherit", stderr: "inherit",
    });
    const sharedFile = (target: Install) => path.join(target.state, "shared-memory-settings.json");
    /* Waits, inside the import's hold, until the writer queued on the file's lock: then it can only run after the import. */
    const startWriterInside = (target: Install, started: ReturnType<typeof writer>[]) => (index: number) => {
      if (index !== 0) return;
      started.push(writer(target));
      const queue = `${sharedFile(target)}.write-locks`;
      const deadline = Date.now() + 60_000;
      while ((fs.existsSync(queue) ? fs.readdirSync(queue).filter(name => name.endsWith(".json")).length : 0) < 2) {
        if (Date.now() > deadline) throw new Error("the writer never queued on the file's lock");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    };

    // The import commits: the writer's value is added to what the import wrote.
    const applied = await prepared("real-writer-applied", target => writeRaw(target, "shared-memory-settings.json", "{}\n"));
    const startedApplied: ReturnType<typeof writer>[] = [];
    const { report } = await within(applied.target, () => applyTransferImport({ bundleSha256: applied.plan.bundleSha256, revisions: applied.plan.revisions }, { beforeFileWrite: startWriterInside(applied.target, startedApplied) }));
    expect(report.complete).toBe(true);
    expect(await startedApplied[0]!.exited).toBe(0);
    expect(JSON.parse(fs.readFileSync(sharedFile(applied.target), "utf8"))).toEqual({ [REPOSITORY]: true, [other]: true });

    // The import rolls back: the writer's value is added to the original.
    const rolled = await prepared("real-writer-rolled", target => writeRaw(target, "shared-memory-settings.json", "{}\n"));
    const startedRolled: ReturnType<typeof writer>[] = [];
    process.env.LLV_TRANSFER_TEST_FAULT = "file-step";
    try {
      const failure = await within(rolled.target, () => applyTransferImport({ bundleSha256: rolled.plan.bundleSha256, revisions: rolled.plan.revisions }, { beforeFileWrite: startWriterInside(rolled.target, startedRolled) }))
        .then(() => null, (error: unknown) => error as Error);
      expect(failure?.message).toBe("injected file step failure");
    } finally { delete process.env.LLV_TRANSFER_TEST_FAULT; }
    expect(await startedRolled[0]!.exited).toBe(0);
    expect(JSON.parse(fs.readFileSync(sharedFile(rolled.target), "utf8"))).toEqual({ [other]: true });
    expect(await within(rolled.target, () => readImportRecords())).toEqual([]);
  }, 180_000);

  test("with state and config on two file systems, a disk that fills after a config file's write puts the original back by a rename", async () => {
    const voice = (await within(source, () => exportTransferBundle({ now: new Date(NOW), exportId: "export-voice", product: "test", env: {}, sections: ["settings.voice"] }))).bytes;
    const target = makeInstall(parent, "split-roots");
    await within(target, () => ensureLegacyCollectionsImported(() => {}));
    // Voice settings as the source has them, so the first file written is a config file.
    fs.writeFileSync(path.join(target.state, "voice-companion.json"), JSON.stringify({ version: 1, settings: { enabled: true, monthlyCapUsd: 12, backend: "codex" }, charges: {}, sessions: {} }));
    await within(target, () => { writeTranscribeBackend("local"); writeTtsBackend("openai"); });
    const plan = await within(target, () => previewTransferImport(voice, { replace: ["settings.voice"] }));
    expect(plan.sections[0]!.conflicts.map(conflict => conflict.key)).toEqual(["text:voice-choices|transcribe-backend", "text:voice-choices|tts-backend"]);
    const before = snapshot(target);
    const result = await runWorker(target, { operation: "apply", request: { bundleSha256: plan.bundleSha256, revisions: plan.revisions, replace: ["settings.voice"] } }, "disk-full", { LLV_TRANSFER_TEST_SPLIT_ROOTS: "1" });
    expect(result.response).toMatchObject({ ok: false, error: { code: "failed" } });
    const message = String((result.response as { error: { message: string } }).error.message);
    expect(message).toContain("ENOSPC");
    expect(message).not.toContain("could not be undone");
    expect(snapshot(target)).toEqual(before);
    const [{ journal }] = journals(target);
    expect(journal.files.map(entry => [entry.root, entry.relative])).toEqual([["config", "transcribe-backend"], ["config", "tts-backend"]]);
    expect(await within(target, () => readImportRecords())).toEqual([]);
    expect((await runWorker(target, { operation: "recover" }, undefined, { LLV_TRANSFER_TEST_SPLIT_ROOTS: "1" })).response).toMatchObject({ ok: true, result: [{ outcome: "rolled-back" }] });
    expect(snapshot(target)).toEqual(before);
  }, 60_000);

  test("recovery metadata that cannot be read refuses activation and is kept, however it fails, until it reads", async () => {
    const { target, plan } = await prepared("unreadable-metadata");
    const before = snapshot(target);
    expect((await runWorker(target, { operation: "apply", request: { bundleSha256: plan.bundleSha256, revisions: plan.revisions } }, "die-after-files")).signal).toBe("SIGKILL");
    const imported = snapshot(target);
    expect(imported.files).not.toEqual(before.files);
    const [{ directory }] = journals(target);
    const journalFile = path.join(directory, "journal.json");
    /** `deny`: makes a path unreadable for the attempt, and gives it back after. */
    const refusedWith = async (pattern: RegExp, deny?: { file: string; mode: number }) => {
      const held = fs.readFileSync(journalFile);
      if (deny) fs.chmodSync(deny.file, 0o000);
      try { await expect(within(target, () => settleInterruptedTransfers())).rejects.toThrow(pattern); }
      finally { if (deny) fs.chmodSync(deny.file, deny.mode); }
      // Nothing undone, nothing settled: the next attempt finds the same journal.
      expect(fs.readFileSync(journalFile)).toEqual(held);
      expect(snapshot(target).files).toEqual(imported.files);
    };
    for (const [fault, pattern] of [["journal", /activation refused: .*journal of import .* cannot be read \(EIO\)/], ["imports", /activation refused: .*list of interrupted imports cannot be read \(EIO\)/]] as const) {
      process.env.LLV_TRANSFER_TEST_READ_FAULT = fault;
      try { await refusedWith(pattern); } finally { delete process.env.LLV_TRANSFER_TEST_READ_FAULT; }
    }
    const original = fs.readFileSync(journalFile);
    for (const damaged of ["{ half a journal", JSON.stringify({ importId: "x", state: "writing", files: [{ relative: 7 }], reservations: [] })]) {
      fs.writeFileSync(journalFile, damaged);
      await refusedWith(/activation refused: .*journal of import .* is damaged/);
    }
    fs.writeFileSync(journalFile, original);
    /* Permissions refuse reads only to a process that is not root. */
    if (process.getuid?.() !== 0) {
      await refusedWith(/activation refused: .*journal of import .* cannot be read \(EACCES\)/, { file: journalFile, mode: 0o600 });
      await refusedWith(/activation refused: .*list of interrupted imports cannot be read \(EACCES\)/, { file: path.dirname(directory), mode: 0o700 });
    }
    await within(target, () => settleInterruptedTransfers());
    expect(journalStates(target)).toEqual(["rolled-back"]);
    expect(snapshot(target)).toEqual(before);
  }, 120_000);

  test("a recovery that fails in a serving Viewer keeps launches and further imports waiting until it settles", async () => {
    const { target, plan } = await prepared("viewer-recovery-fails");
    const before = snapshot(target);
    const created = path.join(target.state, "project-settings.json");
    expect(fs.existsSync(created)).toBe(false);
    await within(target, async () => {
      const launch = { executable: process.execPath, workerPath: WORKER };
      const env = { HOME: target.home, NODE_ENV: "test", LLV_TRANSFER_TEST_FAULT: "die-after-files" };
      let failing = true;
      let attempts = 0;
      const recover = async () => {
        attempts += 1;
        if (failing) throw new Error("the undo is held for the test");
        return recoverTransferImports();
      };
      const answer = applyBundle({ bundleSha256: plan.bundleSha256, revisions: plan.revisions }, { launch, env, recover, recoveryRetryMs: [20] });
      // A launch admission queued once the Viewer holds the lock for the apply.
      const lock = path.join(target.state, "account-selection.lock");
      const holder = () => { try { return (JSON.parse(fs.readFileSync(lock, "utf8")) as { holder?: string }).holder ?? null; } catch { return null; } };
      for (let waited = 0; holder() !== "install transfer"; waited += 1) {
        if (waited > 3_000) throw new Error("the Viewer never took the account lock for the apply");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const queued = withAccountMutationLockAsync(() => ({ attempts, journals: journalStates(target), created: fs.existsSync(created) }), { holder: "a queued launch", waitMs: 120_000 });

      const first = await answer;
      expect(first).toMatchObject({ ok: false, error: { code: "recovery_pending" } });
      // The worker died after its writes and the undo failed: the import's file is there, and nothing is admitted.
      expect(fs.existsSync(created)).toBe(true);
      await expect(withAccountMutationLockAsync(() => "admitted", { holder: "a launch", waitMs: 50 })).rejects.toBeInstanceOf(AccountMutationBusyError);
      expect(await applyBundle({ bundleSha256: plan.bundleSha256, revisions: plan.revisions }, { launch, env: { HOME: target.home, NODE_ENV: "test" } })).toMatchObject({ ok: false, error: { code: "busy" } });
      const failedSoFar = attempts;
      expect(failedSoFar).toBeGreaterThanOrEqual(1);

      failing = false;
      const seen = await queued;
      // The queued launch ran only once the import was undone.
      expect(seen.journals).toEqual(["rolled-back"]);
      expect(seen.created).toBe(false);
      expect(seen.attempts).toBeGreaterThan(failedSoFar);
    });
    expect(snapshot(target)).toEqual(before);
  }, 120_000);

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
