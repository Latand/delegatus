import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { readStateCollectionRows, readStateImport } from "@/lib/state/sqliteStateStore";

import {
  accountsCollectionRevision,
  accountsDatabasePath,
  accountSourcePath,
  ACCOUNT_SOURCE_NAMES,
  BINDINGS_SOURCE,
  checkpointAccountRollbackMirrorsForDemotion,
  CLAUDE_ACCOUNTS_SOURCE,
  CODEX_ACCOUNTS_SOURCE,
  FENCES_SOURCE,
  importLegacyAccounts,
  MUTATION_REVISION_SOURCE,
  OVERRIDES_SOURCE,
  readAccountSource,
  readRetiredAccountIds,
  resetAccountCollectionsForTests,
  writeAccountSource,
  type AccountSourceName,
} from "./accountsStore";

/* #1870 slice 7: the account stores as one `accounts` collection of
   state.sqlite. The failure matrix the design asks every MOVE slice for
   ((a)–(g) of §8), plus the two this slice owes: a #1857 removal is atomic
   across the account row and its journal, and the mutation revision IS the
   collection revision.

   Every case runs in its own mkdtemp directory and never touches the live
   state directory. Account names are invented. */

const CHILD = path.join(import.meta.dir, "accountsStore.sqliteChild.ts");
const directories: string[] = [];

afterEach(() => {
  resetAccountCollectionsForTests();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function sandbox(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-accounts-sqlite-"));
  directories.push(directory);
  resetAccountCollectionsForTests();
  return directory;
}

function seed(directory: string, name: AccountSourceName, body: unknown): void {
  fs.writeFileSync(accountSourcePath(name, directory), `${JSON.stringify(body, null, 2)}\n`);
}

function registry(active: string, ids: string[] = [active], extra: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    active,
    accounts: ids.map((id) => ({ id, label: id, kind: "managed", createdAt: 1 })),
    retired: [],
    removals: [],
    ...extra,
  };
}

function body(directory: string, name: AccountSourceName): unknown {
  const read = readAccountSource(name, directory);
  return read.kind === "collection" ? read.body : "READ-FROM-LEGACY-FILE";
}

function rows(directory: string): { k: string; v: unknown }[] {
  return (readStateCollectionRows(accountsDatabasePath(directory), "accounts") ?? []) as { k: string; v: unknown }[];
}

function siblings(directory: string, prefix: string): string[] {
  return fs.readdirSync(directory).filter((name) => name.startsWith(prefix)).sort();
}

/** A state directory of a deployed machine: a release target, and the
    authority that admits an unidentified local client's writes. */
function deployedRelease(directory: string): void {
  const revision = "b".repeat(40);
  fs.writeFileSync(path.join(directory, "viewer-release.json"), JSON.stringify({
    endpoint: "http://127.0.0.1:8898", revision, hotStateBackend: "sqlite-v1",
  }));
  fs.writeFileSync(path.join(directory, "hot-state-authority.json"), JSON.stringify({
    schemaVersion: 1, epoch: 1, mode: "sqlite", releaseRevision: revision,
    updatedAt: "2026-09-20T00:00:00.000Z", activationReadyAt: "2026-09-20T00:00:00.000Z",
  }));
}

function isTombstone(directory: string, name: AccountSourceName): boolean {
  try { return fs.lstatSync(accountSourcePath(name, directory)).isDirectory(); }
  catch { return false; }
}

test("an unpromoted candidate scans accounts from an older SQLite schema without changing it", () => {
  const root = sandbox();
  const directory = path.join(root, "state");
  fs.mkdirSync(directory);
  seed(directory, CODEX_ACCOUNTS_SOURCE, registry("fixture"));
  importLegacyAccounts(directory, { reconcile: true });
  resetAccountCollectionsForTests();
  const database = accountsDatabasePath(directory);
  const db = new Database(database);
  db.exec("DROP INDEX state_rows_task_due");
  db.close();
  deployedRelease(directory);
  const script = `
    const { completedFileScan } = await import(${JSON.stringify(path.resolve("src/lib/scanner/scanCache.ts"))});
    const scan = await completedFileScan();
    if (!scan.snapshot.complete) throw new Error("scan incomplete");
    const { viewerMcpBindings } = await import(${JSON.stringify(path.resolve("src/lib/mcp/bindings.ts"))});
    const board = await viewerMcpBindings().board_snapshot({ clientRequestId: "candidate-test", limit: 1 });
    if (typeof board.count !== "number") throw new Error("board snapshot did not return");
    const { readAccountSource, writeAccountSource, CODEX_ACCOUNTS_SOURCE } = await import(${JSON.stringify(path.resolve("src/lib/accounts/accountsStore.ts"))});
    const read = readAccountSource(CODEX_ACCOUNTS_SOURCE);
    if (read.kind !== "collection" || read.body.active !== "fixture") throw new Error("account registry was not read");
    let refused = false;
    try { writeAccountSource(CODEX_ACCOUNTS_SOURCE, read.body); }
    catch (error) { refused = String(error).includes("fenced during release handoff"); }
    if (!refused) throw new Error("candidate account write was not fenced");
  `;
  const before = fs.readFileSync(database);
  const wal = `${database}-wal`;
  const walBefore = fs.existsSync(wal) ? fs.readFileSync(wal) : null;
  const child = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, "config"),
      LLV_STATE_DIR: directory, LLV_STATE_OWNER: "viewer", PORT: "19717",
      LLV_HOT_STATE_RELEASE_REVISION: "a".repeat(40), LLV_VIEWER_DEPLOY_TARGET: path.join(directory, "viewer-release.json"),
      LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" },
  });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  expect(fs.readFileSync(database)).toEqual(before);
  expect(fs.existsSync(wal) ? fs.readFileSync(wal) : null).toEqual(walBefore);
  const verify = new Database(database, { readonly: true });
  expect(verify.query("SELECT name FROM sqlite_master WHERE name = 'state_rows_task_due'").get()).toBeNull();
  verify.close();
});

test.each([...new Set([process.platform, "darwin", "win32"])])("candidate account scans defer interrupted archive cleanup until promotion (%s)", (recoveryPlatform) => {
  const root = sandbox();
  const directory = path.join(root, "state");
  fs.mkdirSync(directory);
  const journal = [{ id: "fixture", phase: "scrubbing", startedAt: 1 }];
  for (const name of [CODEX_ACCOUNTS_SOURCE, CLAUDE_ACCOUNTS_SOURCE] as const) {
    seed(directory, name, registry("default", [], { removals: journal }));
  }
  importLegacyAccounts(directory, { reconcile: true });
  resetAccountCollectionsForTests();
  const secrets = [
    path.join(root, "shared", "codex", "retired", "fixture", "auth.json"),
    path.join(root, "shared", "claude", "retired", "fixture", ".credentials.json"),
  ];
  for (const secret of secrets) {
    fs.mkdirSync(path.dirname(secret), { recursive: true });
    fs.writeFileSync(secret, "fixture");
  }
  const histories = secrets.map((secret) => path.join(path.dirname(secret), "history.jsonl"));
  for (const history of histories) fs.writeFileSync(history, "retained history\n");
  deployedRelease(directory);
  const script = `
    const fs = await import("node:fs");
    const { codexSessionRoots } = await import(${JSON.stringify(path.resolve("src/lib/accounts/codex.ts"))});
    const { claudeProjectRoots } = await import(${JSON.stringify(path.resolve("src/lib/accounts/claude.ts"))});
    codexSessionRoots(); claudeProjectRoots();
    for (const file of ${JSON.stringify(secrets)}) if (!fs.existsSync(file)) throw new Error("candidate cleaned an archive");
    const { readAccountSource } = await import(${JSON.stringify(path.resolve("src/lib/accounts/accountsStore.ts"))});
    for (const name of ${JSON.stringify([CODEX_ACCOUNTS_SOURCE, CLAUDE_ACCOUNTS_SOURCE])}) {
      const read = readAccountSource(name);
      if (read.kind !== "collection" || JSON.stringify(read.body.removals) !== ${JSON.stringify(JSON.stringify(journal))}) {
        throw new Error("candidate changed the removal journal");
      }
    }
    fs.writeFileSync(${JSON.stringify(path.join(directory, "viewer-release.json"))}, JSON.stringify({
      revision: "a".repeat(40), endpoint: "http://127.0.0.1:19717", hotStateBackend: "sqlite-v1",
    }));
    const { publishHotStateAuthority } = await import(${JSON.stringify(path.resolve("src/lib/state/hotStateAuthority.ts"))});
    publishHotStateAuthority(${JSON.stringify(directory)}, "sqlite", "a".repeat(40), { activationReadyAt: new Date().toISOString() });
    // Exercise the non-Linux refusal on every host, after native setup and activation.
    Object.defineProperty(process, "platform", { value: ${JSON.stringify(recoveryPlatform)} });
    codexSessionRoots(); claudeProjectRoots();
  `;
  const child = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, "config"),
      LLV_STATE_DIR: directory, LLV_STATE_OWNER: "viewer", PORT: "19717",
      LLV_HOT_STATE_RELEASE_REVISION: "a".repeat(40), LLV_VIEWER_DEPLOY_TARGET: path.join(directory, "viewer-release.json"),
      LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" },
  });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const cleanupSupported = recoveryPlatform === "linux";
  for (const secret of secrets) {
    expect(fs.existsSync(secret)).toBe(!cleanupSupported);
    if (!cleanupSupported) expect(fs.readFileSync(secret, "utf8")).toBe("fixture");
  }
  for (const history of histories) expect(fs.readFileSync(history, "utf8")).toBe("retained history\n");
  for (const name of [CODEX_ACCOUNTS_SOURCE, CLAUDE_ACCOUNTS_SOURCE] as const) {
    expect(body(directory, name)).toMatchObject({ removals: cleanupSupported ? [] : journal });
  }
});

async function child(mode: string, directory: string, arg?: string, gate?: string) {
  const proc = Bun.spawn({
    cmd: [process.execPath, CHILD, mode, directory, arg ?? "", gate ?? ""].filter((part, index) => index < 4 || part !== ""),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, LLV_STATE_DIR: directory },
  });
  return proc;
}

async function runChild(mode: string, directory: string, arg?: string): Promise<{ exit: number; out: string; error: string }> {
  const proc = await child(mode, directory, arg);
  const [out, error, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exit, out, error };
}

/** Start the child, wait for it to reach its seam, then SIGKILL it there. */
async function killAtSeam(mode: string, directory: string): Promise<void> {
  const ready = path.join(directory, `${mode}.ready`);
  const proc = await child(mode, directory, ready);
  for (let attempt = 0; attempt < 1_500 && !fs.existsSync(ready); attempt += 1) await Bun.sleep(4);
  expect(fs.existsSync(ready)).toBe(true);
  proc.kill("SIGKILL");
  await proc.exited;
  fs.rmSync(ready, { force: true });
  resetAccountCollectionsForTests();
}

describe("the account stores import once into state.sqlite", () => {
  test("all eight legacy files land in one collection, and every one of them is retired behind a tombstone", () => {
    const directory = sandbox();
    seed(directory, CLAUDE_ACCOUNTS_SOURCE, registry("work"));
    seed(directory, CODEX_ACCOUNTS_SOURCE, registry("cx"));
    seed(directory, BINDINGS_SOURCE, { schemaVersion: 1, bindings: [{ engine: "claude", accountId: "work", project: "repo-one", createdAt: "2026-01-01T00:00:00.000Z" }] });
    seed(directory, OVERRIDES_SOURCE, { schemaVersion: 1, overrides: [{ at: "2026-01-01T00:00:00.000Z", engine: "claude", accountId: "work" }] });
    seed(directory, FENCES_SOURCE, { version: 1, fences: { "attempt-aaaaaaaa": { version: 1, clientAttemptId: "attempt-aaaaaaaa" } } });
    seed(directory, MUTATION_REVISION_SOURCE, { version: 1, revision: 41 });

    const outcome = importLegacyAccounts(directory, { reconcile: true });

    expect(outcome.state).toBe("imported");
    expect(outcome.record.gap).toBeNull();
    for (const name of ACCOUNT_SOURCE_NAMES) expect([name, isTombstone(directory, name)]).toEqual([name, true]);
    expect(body(directory, CLAUDE_ACCOUNTS_SOURCE)).toEqual(registry("work"));
    expect(body(directory, CODEX_ACCOUNTS_SOURCE)).toEqual(registry("cx"));
    expect(body(directory, BINDINGS_SOURCE)).toEqual({
      schemaVersion: 1,
      bindings: [{ engine: "claude", accountId: "work", project: "repo-one", createdAt: "2026-01-01T00:00:00.000Z" }],
    });
    expect(body(directory, FENCES_SOURCE)).toEqual({ version: 1, fences: { "attempt-aaaaaaaa": { version: 1, clientAttemptId: "attempt-aaaaaaaa" } } });
    expect(rows(directory).map((row) => row.k)).toEqual(expect.arrayContaining([
      "active:claude", "claude:work", "active:codex", "codex:cx",
      "binding:claude:work:repo-one", "fence:attempt-aaaaaaaa",
    ]));
  });

  test("a record with no usable id keeps its place instead of being dropped, so a damaged registry still reads as damaged", () => {
    const directory = sandbox();
    seed(directory, CLAUDE_ACCOUNTS_SOURCE, {
      version: 1,
      active: "work",
      accounts: [{ id: "work", label: "Work", kind: "managed", createdAt: 1 }, { label: "no id at all" }],
      retired: [],
      removals: [],
    });

    importLegacyAccounts(directory, { reconcile: true });

    expect((body(directory, CLAUDE_ACCOUNTS_SOURCE) as { accounts: unknown[] }).accounts).toEqual([
      { id: "work", label: "Work", kind: "managed", createdAt: 1 },
      { label: "no id at all" },
    ]);
  });

  test("the account state is one store: the eight files share one collection revision", () => {
    const directory = sandbox();
    seed(directory, CLAUDE_ACCOUNTS_SOURCE, registry("work"));
    importLegacyAccounts(directory, { reconcile: true });
    const before = accountsCollectionRevision(directory);

    writeAccountSource(CODEX_ACCOUNTS_SOURCE, registry("cx"), directory);

    expect(accountsCollectionRevision(directory)).toBe(before + 1);
    // A write that changes nothing advances nothing.
    writeAccountSource(CODEX_ACCOUNTS_SOURCE, registry("cx"), directory);
    expect(accountsCollectionRevision(directory)).toBe(before + 1);
  });

  test("(b) a NUL-filled legacy file is recorded as a gap and kept aside; it never reads as an empty store", () => {
    const directory = sandbox();
    fs.writeFileSync(accountSourcePath(CLAUDE_ACCOUNTS_SOURCE, directory), Buffer.alloc(4096, 0));
    fs.writeFileSync(accountSourcePath(BINDINGS_SOURCE, directory), Buffer.alloc(2048, 0));

    const outcome = importLegacyAccounts(directory, { reconcile: true });

    expect(outcome.record.gap).toBe("legacy-unreadable");
    /* Empty is not the answer an account store may give for bytes it could not
       read: an empty binding record is every fence it held disappearing, and an
       empty registry is a mutation overwriting a registry nobody has repaired.
       The gap says so, and it names the file that was kept. */
    expect(readAccountSource(CLAUDE_ACCOUNTS_SOURCE, directory).kind).toBe("gap");
    const gap = readAccountSource(BINDINGS_SOURCE, directory);
    expect(gap.kind).toBe("gap");
    expect(gap.kind === "gap" && gap.preservedAs).toContain(`${BINDINGS_SOURCE}.unreadable-`);
    const kept = siblings(directory, `${CLAUDE_ACCOUNTS_SOURCE}.unreadable-`);
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(path.join(directory, kept[0]!)).every((byte) => byte === 0)).toBe(true);
    expect(siblings(directory, `${BINDINGS_SOURCE}.unreadable-`)).toHaveLength(1);

    // The store keeps accepting writes, and the first one clears that gap.
    writeAccountSource(CLAUDE_ACCOUNTS_SOURCE, registry("after-gap"), directory);
    expect(body(directory, CLAUDE_ACCOUNTS_SOURCE)).toEqual(registry("after-gap"));
    expect(readAccountSource(BINDINGS_SOURCE, directory).kind).toBe("gap");
  });

  test("a retired store with no import record is a gap, not an empty one", () => {
    const directory = sandbox();
    seed(directory, CLAUDE_ACCOUNTS_SOURCE, registry("work"));
    // The bindings file was retired into a database that is no longer there.
    fs.mkdirSync(accountSourcePath(BINDINGS_SOURCE, directory), { recursive: true });

    importLegacyAccounts(directory, { reconcile: true });

    expect(readAccountSource(BINDINGS_SOURCE, directory).kind).toBe("gap");
    expect(body(directory, CLAUDE_ACCOUNTS_SOURCE)).toEqual(registry("work"));
  });

  test("(g) an import whose verification fails leaves the database unmarked and the legacy files untouched", () => {
    const directory = sandbox();
    seed(directory, CLAUDE_ACCOUNTS_SOURCE, registry("work"));
    seed(directory, BINDINGS_SOURCE, { schemaVersion: 1, bindings: [] });
    const before = fs.readFileSync(accountSourcePath(CLAUDE_ACCOUNTS_SOURCE, directory), "utf8");

    expect(() => importLegacyAccounts(directory, {
      reconcile: true,
      // A row written after the rows and before the read-back breaks the digest.
      hooks: {
        beforeVerify: (execute) => execute(
          "INSERT INTO state_rows(collection, row_key, value_json, row_order, row_revision, controller_active) VALUES (?, ?, ?, ?, ?, ?)",
          "accounts", "claude:smuggled", JSON.stringify({ k: "claude:smuggled", v: {} }), 99, 1, 1,
        ),
      },
    })).toThrow(/verification failed/);

    expect(readStateImport(accountsDatabasePath(directory), "accounts")).toBeNull();
    expect(fs.readFileSync(accountSourcePath(CLAUDE_ACCOUNTS_SOURCE, directory), "utf8")).toBe(before);
    expect(isTombstone(directory, BINDINGS_SOURCE)).toBe(false);
  });
});

describe("crash seams", () => {
  test("(a) a writer killed mid-transaction loses only that transaction", async () => {
    const directory = sandbox();
    seed(directory, CLAUDE_ACCOUNTS_SOURCE, registry("work"));
    importLegacyAccounts(directory, { reconcile: true });
    const revision = accountsCollectionRevision(directory);

    await killAtSeam("hold-write", directory);

    const after = JSON.parse((await runChild("read", directory)).out) as { body: unknown; revision: number };
    expect(after.body).toEqual(registry("work"));
    expect(after.revision).toBe(revision);
    // The lease a dead pid held is reclaimed: the next write still lands.
    expect((await runChild("write", directory, "next")).exit).toBe(0);
    expect(body(directory, CLAUDE_ACCOUNTS_SOURCE)).toEqual(registry("next"));
  });

  test("(c) a crash before COMMIT imports on the retry", async () => {
    const directory = sandbox();
    seed(directory, CLAUDE_ACCOUNTS_SOURCE, registry("work"));
    seed(directory, BINDINGS_SOURCE, { schemaVersion: 1, bindings: [] });

    await killAtSeam("hold-import", directory);
    expect(readStateImport(accountsDatabasePath(directory), "accounts")).toBeNull();
    expect(isTombstone(directory, CLAUDE_ACCOUNTS_SOURCE)).toBe(false);

    const retry = JSON.parse((await runChild("import", directory)).out) as { state: string; rows: number };
    expect(retry.state).toBe("imported");
    expect(body(directory, CLAUDE_ACCOUNTS_SOURCE)).toEqual(registry("work"));
  });

  test("(c) a crash after COMMIT finishes the retirement without a second import", async () => {
    const directory = sandbox();
    seed(directory, CLAUDE_ACCOUNTS_SOURCE, registry("work"));
    seed(directory, BINDINGS_SOURCE, { schemaVersion: 1, bindings: [{ engine: "codex", accountId: "cx", project: "repo-two", createdAt: "2026-02-02T00:00:00.000Z" }] });

    await killAtSeam("kill-after-commit", directory);
    const imported = readStateImport(accountsDatabasePath(directory), "accounts")!;
    expect(imported.rowDigest).toBeTruthy();
    expect(isTombstone(directory, CLAUDE_ACCOUNTS_SOURCE)).toBe(false);

    const finish = JSON.parse((await runChild("import", directory)).out) as { state: string; digest: string };
    expect(finish.state).toBe("already-imported");
    expect(finish.digest).toBe(imported.rowDigest);
    expect(isTombstone(directory, CLAUDE_ACCOUNTS_SOURCE)).toBe(true);
    expect(isTombstone(directory, BINDINGS_SOURCE)).toBe(true);
    expect(body(directory, BINDINGS_SOURCE)).toEqual({
      schemaVersion: 1,
      bindings: [{ engine: "codex", accountId: "cx", project: "repo-two", createdAt: "2026-02-02T00:00:00.000Z" }],
    });
  });

  test("(c) a crash after the rename and before the tombstone finishes on the next boot", async () => {
    const directory = sandbox();
    seed(directory, CLAUDE_ACCOUNTS_SOURCE, registry("work"));

    await killAtSeam("kill-after-rename", directory);
    expect(fs.existsSync(accountSourcePath(CLAUDE_ACCOUNTS_SOURCE, directory))).toBe(false);

    const finish = JSON.parse((await runChild("import", directory)).out) as { state: string };
    expect(finish.state).toBe("already-imported");
    expect(isTombstone(directory, CLAUDE_ACCOUNTS_SOURCE)).toBe(true);
    expect(body(directory, CLAUDE_ACCOUNTS_SOURCE)).toEqual(registry("work"));
  });

  test("(d) two processes importing at once import once, and both read the same digest", async () => {
    const directory = sandbox();
    seed(directory, CLAUDE_ACCOUNTS_SOURCE, registry("work", ["work", "spare"]));
    seed(directory, CODEX_ACCOUNTS_SOURCE, registry("cx"));
    const gate = path.join(directory, "go");

    const [first, second] = await Promise.all([
      child("import", directory, "", gate).then(async (proc) => ({ out: await new Response(proc.stdout).text(), exit: await proc.exited })),
      child("import", directory, "", gate).then(async (proc) => ({ out: await new Response(proc.stdout).text(), exit: await proc.exited })),
      Bun.sleep(80).then(() => fs.writeFileSync(gate, "go")),
    ]);

    expect([first.exit, second.exit]).toEqual([0, 0]);
    const left = JSON.parse(first.out) as { state: string; digest: string };
    const right = JSON.parse(second.out) as { state: string; digest: string };
    expect(left.digest).toBe(right.digest);
    expect([left.state, right.state].filter((state) => state === "imported")).toHaveLength(1);
    expect(siblings(directory, `${CLAUDE_ACCOUNTS_SOURCE}.imported-`)).toHaveLength(1);
  });

  test("(e) a legacy writer after the import fails with EISDIR and nothing is lost", async () => {
    const directory = sandbox();
    seed(directory, CLAUDE_ACCOUNTS_SOURCE, registry("work"));
    importLegacyAccounts(directory, { reconcile: true });

    const attempt = JSON.parse((await runChild("legacy-write", directory)).out) as { read: string; write: string };

    expect(attempt.read).toBe("EISDIR");
    expect(["EISDIR", "ENOTEMPTY", "EEXIST", "EPERM"]).toContain(attempt.write);
    expect(body(directory, CLAUDE_ACCOUNTS_SOURCE)).toEqual(registry("work"));
  });
});

describe("(f) rollback and roll-forward", () => {
  test("the demotion mirror writes every store back, and the roll-forward merges what the rollback release changed", () => {
    const directory = sandbox();
    seed(directory, CLAUDE_ACCOUNTS_SOURCE, registry("work", ["work", "spare"]));
    seed(directory, BINDINGS_SOURCE, { schemaVersion: 1, bindings: [{ engine: "claude", accountId: "work", project: "repo-one", createdAt: "2026-01-01T00:00:00.000Z" }] });
    importLegacyAccounts(directory, { reconcile: true });

    checkpointAccountRollbackMirrorsForDemotion(directory);

    // Every mirrored store is a file the rollback release can read again.
    for (const name of [CLAUDE_ACCOUNTS_SOURCE, BINDINGS_SOURCE, MUTATION_REVISION_SOURCE] as AccountSourceName[]) {
      expect([name, isTombstone(directory, name)]).toEqual([name, false]);
      expect([name, JSON.parse(fs.readFileSync(accountSourcePath(name, directory), "utf8")) !== null]).toEqual([name, true]);
    }
    const mirrored = readStateImport(accountsDatabasePath(directory), "accounts")!;
    expect(mirrored.mirrorRevision).toBeGreaterThan(0);
    const marker = JSON.parse(fs.readFileSync(accountSourcePath(MUTATION_REVISION_SOURCE, directory), "utf8")) as { revision: number };
    expect(marker.revision).toBe(mirrored.mirrorRevision!);

    /* The rollback release runs on the files: it retires an account, adds a
       binding, and advances the mutation revision it read from the mirror. */
    seed(directory, CLAUDE_ACCOUNTS_SOURCE, registry("work", ["work"]));
    seed(directory, BINDINGS_SOURCE, {
      schemaVersion: 1,
      bindings: [
        { engine: "claude", accountId: "work", project: "repo-one", createdAt: "2026-01-01T00:00:00.000Z" },
        { engine: "claude", accountId: "work", project: "repo-three", createdAt: "2026-03-03T00:00:00.000Z" },
      ],
    });
    seed(directory, MUTATION_REVISION_SOURCE, { version: 1, revision: marker.revision + 2 });
    resetAccountCollectionsForTests();

    importLegacyAccounts(directory, { reconcile: true });

    expect((body(directory, CLAUDE_ACCOUNTS_SOURCE) as { accounts: { id: string }[] }).accounts.map((row) => row.id)).toEqual(["work"]);
    expect((body(directory, BINDINGS_SOURCE) as { bindings: { project: string }[] }).bindings.map((row) => row.project))
      .toEqual(["repo-one", "repo-three"]);
    for (const name of ACCOUNT_SOURCE_NAMES) expect([name, isTombstone(directory, name)]).toEqual([name, true]);
  });

  test("a file that does not descend from the recorded mirror deletes nothing", () => {
    const directory = sandbox();
    seed(directory, CLAUDE_ACCOUNTS_SOURCE, registry("work", ["work", "spare"]));
    importLegacyAccounts(directory, { reconcile: true });
    checkpointAccountRollbackMirrorsForDemotion(directory);

    /* An old writer that found the path empty — the window between retiring a
       file and creating its tombstone — writes a store out of nothing. Its
       mutation revision does not descend from the mirror, so what it lacks
       proves no deletion. */
    seed(directory, CLAUDE_ACCOUNTS_SOURCE, registry("fresh", ["fresh"]));
    fs.rmSync(accountSourcePath(MUTATION_REVISION_SOURCE, directory), { force: true });
    resetAccountCollectionsForTests();

    importLegacyAccounts(directory, { reconcile: true });

    expect((body(directory, CLAUDE_ACCOUNTS_SOURCE) as { accounts: { id: string }[] }).accounts.map((row) => row.id).sort())
      .toEqual(["fresh", "spare", "work"]);
  });

  test("an untouched mirror is retired without merging anything back", () => {
    const directory = sandbox();
    seed(directory, CLAUDE_ACCOUNTS_SOURCE, registry("work"));
    importLegacyAccounts(directory, { reconcile: true });
    checkpointAccountRollbackMirrorsForDemotion(directory);
    resetAccountCollectionsForTests();

    importLegacyAccounts(directory, { reconcile: true });

    expect(body(directory, CLAUDE_ACCOUNTS_SOURCE)).toEqual(registry("work"));
    for (const name of ACCOUNT_SOURCE_NAMES) expect([name, isTombstone(directory, name)]).toEqual([name, true]);
  });
});

describe("a release that may not import yet", () => {
  test("reads fall back to the legacy files and writes refuse", () => {
    const directory = sandbox();
    seed(directory, CLAUDE_ACCOUNTS_SOURCE, registry("work"));
    /* A release target that no activation has answered fences this process out
       of the database (#958): it may not import, and it may not write. */
    fs.writeFileSync(path.join(directory, "viewer-release.json"), JSON.stringify({
      endpoint: "http://127.0.0.1:1/",
      revision: "1".repeat(40),
    }));
    resetAccountCollectionsForTests();

    expect(body(directory, CLAUDE_ACCOUNTS_SOURCE)).toBe("READ-FROM-LEGACY-FILE");
    expect(() => writeAccountSource(CLAUDE_ACCOUNTS_SOURCE, registry("other"), directory))
      .toThrow(/waiting for release promotion/);
    expect(fs.readFileSync(accountSourcePath(CLAUDE_ACCOUNTS_SOURCE, directory), "utf8")).toContain("work");
  });
});

describe("an import record a stray process wrote is not evidence the move happened (#1905)", () => {
  /** What #1905 left on the production machine: a collection and a
      `state_imports` row a lane's `next build` wrote from the live files, the
      eight files restored beside it from their `.imported-*` copies, and the
      release still on the JSON readers ever since. */
  function strayImportThenRestore(directory: string, restored: unknown): void {
    /* The stray import ran with no PORT and no release revision, so it
       recorded no release — while the machine's release target stood right
       beside it. That pair is what marks the record as not the release's. */
    importLegacyAccounts(directory, { reconcile: true });
    deployedRelease(directory);
    for (const name of ACCOUNT_SOURCE_NAMES) fs.rmSync(accountSourcePath(name, directory), { recursive: true, force: true });
    seed(directory, CLAUDE_ACCOUNTS_SOURCE, restored);
    resetAccountCollectionsForTests();
  }

  test("an account the release removed after the stray import does not come back", () => {
    const directory = sandbox();
    seed(directory, CLAUDE_ACCOUNTS_SOURCE, registry("work", ["work", "spare"]));
    /* The release kept running on its JSON files after the stray import and
       removed `spare`. Merging the file into the stray rows would spare what
       the file no longer has and hand the operator a deleted account back. */
    strayImportThenRestore(directory, registry("work", ["work"]));
    const stale = readStateImport(accountsDatabasePath(directory), "accounts")!;

    const outcome = importLegacyAccounts(directory, { reconcile: true });

    expect((body(directory, CLAUDE_ACCOUNTS_SOURCE) as { accounts: { id: string }[] }).accounts.map((row) => row.id))
      .toEqual(["work"]);
    expect(rows(directory).map((row) => row.k)).not.toContain("claude:spare");
    expect(outcome.state).toBe("reimported");
    for (const name of ACCOUNT_SOURCE_NAMES) expect([name, isTombstone(directory, name)]).toEqual([name, true]);
    const record = readStateImport(accountsDatabasePath(directory), "accounts")!;
    expect(record.rowCount).toBeLessThan(stale.rowCount);
    expect(record.importedAt >= stale.importedAt).toBe(true);
  });

  test("the siblings are re-read too, so a binding the stale record never saw survives the move", () => {
    const directory = sandbox();
    seed(directory, CLAUDE_ACCOUNTS_SOURCE, registry("work"));
    seed(directory, BINDINGS_SOURCE, { schemaVersion: 1, bindings: [] });
    strayImportThenRestore(directory, registry("work"));
    seed(directory, BINDINGS_SOURCE, {
      schemaVersion: 1,
      bindings: [{ engine: "claude", accountId: "work", project: "repo-after", createdAt: "2026-01-01T00:00:00.000Z" }],
    });

    expect(importLegacyAccounts(directory, { reconcile: true }).state).toBe("reimported");

    expect((body(directory, BINDINGS_SOURCE) as { bindings: { project: string }[] }).bindings.map((row) => row.project))
      .toEqual(["repo-after"]);
  });

  test("a file the release deliberately mirrored for a rollback still merges rather than replacing", () => {
    const directory = sandbox();
    seed(directory, CLAUDE_ACCOUNTS_SOURCE, registry("work", ["work", "spare"]));
    importLegacyAccounts(directory, { reconcile: true });
    checkpointAccountRollbackMirrorsForDemotion(directory);
    deployedRelease(directory);
    resetAccountCollectionsForTests();
    /* The rollback release added an account to the mirror it was handed. */
    const mirrored = JSON.parse(fs.readFileSync(accountSourcePath(CLAUDE_ACCOUNTS_SOURCE, directory), "utf8")) as {
      accounts: { id: string }[];
    };
    seed(directory, CLAUDE_ACCOUNTS_SOURCE, {
      ...mirrored,
      accounts: [...mirrored.accounts, { id: "added", label: "added", kind: "managed", createdAt: 2 }],
    });

    const outcome = importLegacyAccounts(directory, { reconcile: true });

    expect(outcome.state).toBe("already-imported");
    expect((body(directory, CLAUDE_ACCOUNTS_SOURCE) as { accounts: { id: string }[] }).accounts.map((row) => row.id).sort())
      .toEqual(["added", "spare", "work"]);
    expect(readStateImport(accountsDatabasePath(directory), "accounts")?.reconciledSha256).toBeTruthy();
  });

  test("a file that no longer parses leaves the stale rows and the database exactly as they were", () => {
    const directory = sandbox();
    seed(directory, CLAUDE_ACCOUNTS_SOURCE, registry("work"));
    strayImportThenRestore(directory, registry("work"));
    fs.writeFileSync(accountSourcePath(CLAUDE_ACCOUNTS_SOURCE, directory), Buffer.alloc(16));
    const before = readStateImport(accountsDatabasePath(directory), "accounts")!;

    const outcome = importLegacyAccounts(directory, { reconcile: true });

    expect(outcome.state).toBe("already-imported");
    expect(readStateImport(accountsDatabasePath(directory), "accounts")).toEqual(before);
    expect(siblings(directory, `${CLAUDE_ACCOUNTS_SOURCE}.unreadable-`)).toHaveLength(1);
  });
});

/* The one read outside this module's owners: `AgentRegistry.beginSpawnRequest`
   refuses a launch on a retired account, so a registry that could not be read
   must not answer with an empty retired list. */
test("a registry that could not be read reports that, rather than an empty retired list", () => {
  const directory = sandbox();
  seed(directory, CLAUDE_ACCOUNTS_SOURCE, registry("work", ["work"], {
    retired: [{ id: "gone", label: "gone", retiredAt: "2026-01-01T00:00:00.000Z" }],
  }));
  fs.writeFileSync(accountSourcePath(CODEX_ACCOUNTS_SOURCE, directory), Buffer.alloc(1024, 0));

  importLegacyAccounts(directory, { reconcile: true });

  expect(readRetiredAccountIds("claude", directory)).toEqual({ kind: "known", ids: new Set(["gone"]) });
  const unknown = readRetiredAccountIds("codex", directory);
  expect(unknown.kind).toBe("unknown");
  expect(unknown.kind === "unknown" && unknown.reason).toContain(`${CODEX_ACCOUNTS_SOURCE}.unreadable-`);
});


describe("database identity", () => {
  test("cached account reads probe database identity without numeric precision loss", () => {
    const directory = sandbox();
    writeAccountSource(CLAUDE_ACCOUNTS_SOURCE, registry("first"), directory);
    const stat = spyOn(fs, "statSync");
    try {
      readAccountSource(CLAUDE_ACCOUNTS_SOURCE, directory);
      const probes = stat.mock.calls.filter(([file]) => file === accountsDatabasePath(directory));
      expect(probes.length).toBeGreaterThan(0);
      expect(probes[0]?.[1]).toEqual({ bigint: true });
    } finally { stat.mockRestore(); }
  });

  test("absent, created and replaced account databases keep reads and writes on the current file", () => {
    const replacement = sandbox();
    writeAccountSource(CLAUDE_ACCOUNTS_SOURCE, registry("replacement"), replacement);
    const directory = sandbox();
    const database = accountsDatabasePath(directory);
    expect(fs.existsSync(database)).toBe(false);
    expect(body(directory, CLAUDE_ACCOUNTS_SOURCE)).toBeUndefined();
    writeAccountSource(CLAUDE_ACCOUNTS_SOURCE, registry("original"), directory);
    expect(body(directory, CLAUDE_ACCOUNTS_SOURCE)).toEqual(registry("original"));
    for (const suffix of ["", "-wal", "-shm"]) {
      if (fs.existsSync(database + suffix)) fs.renameSync(database + suffix, database + ".held" + suffix);
      const source = accountsDatabasePath(replacement) + suffix;
      if (fs.existsSync(source)) fs.renameSync(source, database + suffix);
    }
    expect(body(directory, CLAUDE_ACCOUNTS_SOURCE)).toEqual(registry("replacement"));
    writeAccountSource(CLAUDE_ACCOUNTS_SOURCE, registry("updated"), directory);
    expect(body(directory, CLAUDE_ACCOUNTS_SOURCE)).toEqual(registry("updated"));
    expect(readStateCollectionRows(database + ".held", "accounts")).toEqual(
      expect.arrayContaining([expect.objectContaining({ v: expect.objectContaining({ id: "original" }) })]),
    );
  });
});
