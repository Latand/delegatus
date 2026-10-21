/**
 * The state store on the oldest SQLite Delegatus must run on.
 *
 * On macOS bun:sqlite runs Apple's SQLite: 3.39.5 on macOS 13 (the oldest
 * macOS Bun supports), 3.43.2 on macOS 14 and 15. Bun links a newer SQLite on
 * Linux, so the triggers 1.13.0 to 1.15.0 wrote with jsonb and aggregate
 * ORDER BY (SQLite 3.45 and 3.44) never failed here, and on macOS they set
 * every user's state aside and then stopped the Viewer from starting at all.
 * This file runs the real store, its activation check and its recovery on
 * SQLite 3.39.4 built from the official amalgamation (minimumSqlite.fixture.ts),
 * which this process loads in place of Bun's own. A seeding child keeps Bun's
 * SQLite, so it writes databases exactly as a newer SQLite leaves them.
 */
import { afterEach, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Pipeline } from "@/lib/pipelines/types";
import { buildPipeline } from "@/lib/pipelines/store";
import { minimumSqliteLibrary, minimumSqliteModule } from "./minimumSqlite.fixture";

const builtin = process.getBuiltinModule.bind(process);
const sqlite = minimumSqliteModule(minimumSqliteLibrary());
mock.module("bun:sqlite", () => sqlite);
process.getBuiltinModule = ((id: string) => id === "bun:sqlite" ? sqlite : builtin(id)) as typeof process.getBuiltinModule;

const SEED = path.join(import.meta.dir, "minimumSqlite.seedChild.ts");
const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const owned: string[] = [];
afterEach(() => { for (const root of owned.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function sandbox(): { root: string; filename: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minimum-sqlite-"));
  owned.push(root);
  return { root, filename: path.join(root, "state.sqlite") };
}

function pipeline(id: string, attempts = 1): Pipeline {
  const role = (roleId: "builder" | "reviewer") => ({ roleId, engine: "codex" as const, model: null, effort: null, access: "read-write" as const, promptScaffold: "fixture" });
  const record = buildPipeline({ id, task: "minimum SQLite fixture", project: "fixture", repoDir: "/repo", srcPath: null, srcConversationId: null, now: new Date(NOW).toISOString(), stages: [
    { id: "build", kind: "run", prompt: "", role: { roleId: "builder" }, effectiveRole: role("builder"), next: null },
  ] });
  record.state = "running";
  for (let n = 1; n <= attempts; n += 1) {
    record.runs[0]!.attempts.push({ n, state: n === attempts ? "running" : "passed", effectiveRole: role("builder"), launchId: null,
      conversationId: `conversation_${id}_${n}`, sessionId: null, agentPath: `${id}-${n}.jsonl`, paneId: null, flowId: null,
      startedAt: new Date(NOW - (attempts - n) * 60_000).toISOString(), completedAt: n === attempts ? null : new Date(NOW).toISOString(),
      input: null, activatedBy: null, output: null, verdict: n === attempts ? null : { status: "pass" }, error: null } as never);
  }
  return record;
}

const pipelines = { collection: "pipelines", schemaVersion: 1, busyMessage: "busy", key: (row: Pipeline) => row.id,
  decode: (raw: unknown) => raw as Pipeline, clone: (row: Pipeline) => structuredClone(row) };

/** Writes `filename` on Bun's own SQLite in a child, as a newer SQLite leaves it. */
function seed(filename: string, mode: "legacy" | "foreign", row: Pipeline): void {
  const child = Bun.spawnSync([process.execPath, SEED, filename, mode, JSON.stringify(row)], { stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(`seed child failed: ${child.stderr.toString()}`);
}

function rows<T>(filename: string, sql: string): T[] {
  const db = new sqlite.Database(filename, { readonly: true });
  try { return db.query(sql).all() as T[]; } finally { db.close(); }
}

function digest(file: string): string {
  return new Bun.CryptoHasher("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("the fixture is SQLite 3.39.4 and refuses what 3.42, 3.44 and 3.45 added", () => {
  const db = new sqlite.Database(":memory:");
  try {
    expect(db.query("SELECT sqlite_version() AS v").get()).toEqual({ v: "3.39.4" });
    expect(() => db.query("SELECT json_group_array(value ORDER BY value) FROM json_each('[2,1]')").get()).toThrow('near "ORDER": syntax error');
    expect(() => db.query("SELECT jsonb('{}')").get()).toThrow("no such function: jsonb");
    expect(db.query("SELECT unixepoch('2026-10-21T12:00:00.250Z', 'subsec') AS t").get()).toEqual({ t: null });
  } finally { db.close(); }
});

test("state.sqlite installs, maintains its pipeline references and projects history on the minimum SQLite", async () => {
  const { initializeStateCollections, SqliteStateCollection } = await import("./sqliteStateStore");
  const { pipelineControllerReferencesCurrent } = await import("./pipelineControllerReferences");
  const { readHistoryProjection, historyAttemptCounts } = await import("./historyProjection");
  const { root, filename } = sandbox();
  initializeStateCollections(filename, [{ ...pipelines, migrationId: "fixture", loadRecords: () => [pipeline("pipeline_a")] }]);
  const store = new SqliteStateCollection<Pipeline>(filename, pipelines);
  const refs = () => rows<{ row_key: string; stageId: string; n: number }>(filename, "SELECT row_key,stageId,n FROM pipeline_attempt_refs ORDER BY row_key,position");
  const owners = () => rows<{ row_key: string; identity: string; live: number }>(filename,
    "SELECT row_key,identity,live FROM pipeline_owner_refs WHERE kind='conversationId' ORDER BY row_key,identity");
  expect(refs()).toEqual([{ row_key: "pipeline_a", stageId: "build", n: 1 }]);

  store.boundedPatch(2, tx => { tx.put(pipeline("pipeline_a", 2)); tx.put(pipeline("pipeline_b")); });
  expect(refs()).toEqual([
    { row_key: "pipeline_a", stageId: "build", n: 1 }, { row_key: "pipeline_a", stageId: "build", n: 2 },
    { row_key: "pipeline_b", stageId: "build", n: 1 },
  ]);
  expect(owners()).toEqual([
    { row_key: "pipeline_a", identity: "conversation_pipeline_a_1", live: 0 }, { row_key: "pipeline_a", identity: "conversation_pipeline_a_2", live: 1 },
    { row_key: "pipeline_b", identity: "conversation_pipeline_b_1", live: 1 },
  ]);
  store.boundedPatch(1, tx => tx.delete("pipeline_b"));
  expect(refs().map(row => row.row_key)).toEqual(["pipeline_a", "pipeline_a"]);

  expect(await readHistoryProjection(db => historyAttemptCounts(db, "fixture", NOW), { filename })).toEqual({ builder: 2 });
  const db = new sqlite.Database(filename, { readonly: true });
  try {
    expect(pipelineControllerReferencesCurrent(db as never)).toBe(true);
    const schema = (db.query("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL").all() as { sql: string }[]).map(row => row.sql).join("\n");
    expect(schema).not.toContain("jsonb");
    expect(schema).not.toContain("subsec");
  } finally { db.close(); }
  expect(fs.readdirSync(root).filter(name => /\.(corrupt|replaced|schema)-/.test(name))).toEqual([]);
});

test("triggers an earlier release wrote with SQL this SQLite cannot compile are rebuilt in place; nothing is set aside or emptied", async () => {
  const { checkStateDatabasesAtActivation } = await import("./durability");
  const { SqliteStateCollection } = await import("./sqliteStateStore");
  const { readHistoryProjection, historyAttemptCounts } = await import("./historyProjection");
  const { root, filename } = sandbox();
  seed(filename, "legacy", pipeline("pipeline_kept", 2));
  expect(() => rows(filename, "SELECT count(*) FROM state_rows")).toThrow('malformed database schema (pipeline_refs_insert) - near "ORDER": syntax error');

  const incidents = checkStateDatabasesAtActivation(root, { now: new Date(NOW) });
  expect(incidents.map(incident => incident.kind)).toEqual(["database-schema-repaired"]);
  expect(incidents[0]!.message).toContain("SQLite 3.39.4 cannot compile: pipeline_refs_insert");
  const names = fs.readdirSync(root);
  expect(names.filter(name => name.includes(".corrupt-"))).toEqual([]);
  expect(names).toContain("state.sqlite.schema-2026-10-21T12-00-00-000Z");
  expect(rows<{ row_key: string }>(filename, "SELECT row_key FROM state_rows WHERE collection='pipelines'")).toEqual([{ row_key: "pipeline_kept" }]);

  const store = new SqliteStateCollection<Pipeline>(filename, pipelines);
  expect(store.get("pipeline_kept")?.runs[0]?.attempts).toHaveLength(2);
  expect(rows<{ n: number }>(filename, "SELECT n FROM pipeline_attempt_refs WHERE row_key='pipeline_kept' ORDER BY n")).toEqual([{ n: 1 }, { n: 2 }]);
  store.boundedPatch(1, tx => tx.put(pipeline("pipeline_new")));
  expect(rows<{ row_key: string }>(filename, "SELECT DISTINCT row_key FROM pipeline_attempt_refs ORDER BY row_key")).toEqual([{ row_key: "pipeline_kept" }, { row_key: "pipeline_new" }]);
  expect(await readHistoryProjection(db => historyAttemptCounts(db, "fixture", NOW), { filename })).toEqual({ builder: 3 });
  expect(rows<{ type: string }>(filename, "SELECT DISTINCT typeof(input) AS type FROM history_inputs")).toEqual([{ type: "text" }]);
  expect(checkStateDatabasesAtActivation(root, { now: new Date(NOW + 1) })).toEqual([]);
});

test("a statement no store rebuilds fails loudly with the SQLite version and its name, and the database stays exactly as it was", async () => {
  const { checkStateDatabasesAtActivation } = await import("./durability");
  const { SqliteStateCollection, initializeStateCollections } = await import("./sqliteStateStore");
  const { IncompatibleSchemaError } = await import("./schemaCompatibility");
  const { runtimeDataCorruptionCode } = await import("@/lib/runtime/dataCorruption");
  const { classifyStructuredHostStartupError } = await import("@/lib/viewerInstrumentation");
  const { root, filename } = sandbox();
  seed(filename, "foreign", pipeline("pipeline_kept"));
  const backups = path.join(root, "backups", "sqlite");
  fs.mkdirSync(backups, { recursive: true });
  fs.copyFileSync(filename, path.join(backups, "state-2026-10-21T11-00-00-000Z.sqlite"));

  const incidents = checkStateDatabasesAtActivation(root, { now: new Date(NOW) });
  expect(incidents.map(incident => incident.kind)).toEqual(["database-incompatible"]);
  expect(incidents[0]!.message).toContain("SQLite 3.39.4 cannot compile: operator_pipeline_keys");
  expect(incidents[0]!.corruptFiles).toEqual([]);
  const before = digest(filename);
  expect(fs.readdirSync(root).filter(name => /\.(corrupt|replaced|restoring)/.test(name))).toEqual([]);
  expect(checkStateDatabasesAtActivation(root, { now: new Date(NOW + 1) }).map(incident => incident.kind)).toEqual(["database-incompatible"]);
  expect(digest(filename)).toBe(before);

  let caught: unknown;
  try {
    initializeStateCollections(filename, [{ ...pipelines, migrationId: "fixture", loadRecords: () => [] }]);
    new SqliteStateCollection<Pipeline>(filename, pipelines).get("pipeline_kept");
  } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(IncompatibleSchemaError);
  expect((caught as Error).message).toContain("SQLite 3.39.4 cannot compile: operator_pipeline_keys");
  expect(runtimeDataCorruptionCode(caught)).toBeUndefined();
  expect(runtimeDataCorruptionCode((caught as Error).cause)).toBeUndefined();
  expect(classifyStructuredHostStartupError((caught as Error).cause).category).toBe("configuration");
  expect(digest(filename)).toBe(before);
});

test("a damaged database is restored from a backup that holds legacy triggers: no backup is refused for them", async () => {
  const { checkStateDatabasesAtActivation } = await import("./durability");
  const { root, filename } = sandbox();
  seed(filename, "legacy", pipeline("pipeline_backed_up"));
  const backups = path.join(root, "backups", "sqlite");
  fs.mkdirSync(backups, { recursive: true });
  const backup = new sqlite.Database(filename);
  try {
    backup.exec("PRAGMA writable_schema = ON");
    backup.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally { backup.close(); }
  fs.copyFileSync(filename, path.join(backups, "state-2026-10-21T11-00-00-000Z.sqlite"));
  for (const suffix of ["-wal", "-shm"]) fs.rmSync(`${filename}${suffix}`, { force: true });
  fs.writeFileSync(filename, Buffer.alloc(8192, 0x5a));

  const incidents = checkStateDatabasesAtActivation(root, { now: new Date(NOW) });
  expect(incidents.map(incident => [incident.kind, incident.backup])).toEqual([["database-restored", "state-2026-10-21T11-00-00-000Z.sqlite"]]);
  expect(rows<{ row_key: string }>(filename, "SELECT row_key FROM state_rows WHERE collection='pipelines'")).toEqual([{ row_key: "pipeline_backed_up" }]);
  expect(rows<{ name: string }>(filename, "SELECT name FROM sqlite_master WHERE name='pipeline_refs_insert'")).toEqual([]);
});

test("a database an earlier release set aside for an uncompilable trigger is put back while the live one is empty; every file is kept", async () => {
  const { checkStateDatabasesAtActivation } = await import("./durability");
  const { SqliteStateCollection } = await import("./sqliteStateStore");
  const { root, filename } = sandbox();
  seed(filename, "legacy", pipeline("pipeline_recovered", 2));
  const aside = `${filename}.corrupt-2026-10-20T08-00-00-000Z`;
  for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(`${filename}${suffix}`)) fs.renameSync(`${filename}${suffix}`, `${aside}${suffix}`);
  const asideFiles = fs.readdirSync(root).filter(name => name.includes(".corrupt-")).sort();
  const asideDigest = digest(aside);
  // What the failed start left: an empty database with WAL turned on.
  const empty = new sqlite.Database(filename);
  try { empty.exec("PRAGMA journal_mode = WAL"); } finally { empty.close(); }

  const incidents = checkStateDatabasesAtActivation(root, { now: new Date(NOW) });
  expect(incidents.map(incident => incident.kind)).toEqual(["database-recovered"]);
  expect(incidents[0]!.message).toContain("pipeline_refs_insert");
  expect(incidents[0]!.corruptFiles).toEqual(asideFiles);
  expect(fs.readdirSync(root).filter(name => name.includes(".corrupt-")).sort()).toEqual(asideFiles);
  expect(digest(aside)).toBe(asideDigest);
  expect(fs.readdirSync(root).some(name => name.startsWith("state.sqlite.replaced-2026-10-21T12-00-00-000Z"))).toBe(true);
  const store = new SqliteStateCollection<Pipeline>(filename, pipelines);
  expect(store.get("pipeline_recovered")?.runs[0]?.attempts).toHaveLength(2);
  expect(rows<{ n: number }>(filename, "SELECT n FROM pipeline_attempt_refs ORDER BY n")).toEqual([{ n: 1 }, { n: 2 }]);
  // The live database now holds rows, so the next start leaves both alone.
  expect(checkStateDatabasesAtActivation(root, { now: new Date(NOW + 1) })).toEqual([]);
});

test("a set-aside database is left alone when it is really damaged, or when the live database already holds rows", async () => {
  const { checkStateDatabasesAtActivation } = await import("./durability");
  const { initializeStateCollections } = await import("./sqliteStateStore");
  const damaged = sandbox();
  const aside = `${damaged.filename}.corrupt-2026-10-20T08-00-00-000Z`;
  fs.writeFileSync(aside, Buffer.alloc(8192, 0x5a));
  expect(checkStateDatabasesAtActivation(damaged.root, { now: new Date(NOW) })).toEqual([]);
  expect(fs.existsSync(damaged.filename)).toBe(false);
  expect(fs.readFileSync(aside)).toEqual(Buffer.alloc(8192, 0x5a));
  expect(fs.readdirSync(damaged.root).filter(name => name.includes(".restoring"))).toEqual([]);

  const used = sandbox();
  seed(used.filename, "legacy", pipeline("pipeline_old"));
  const usedAside = `${used.filename}.corrupt-2026-10-20T08-00-00-000Z`;
  for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(`${used.filename}${suffix}`)) fs.renameSync(`${used.filename}${suffix}`, `${usedAside}${suffix}`);
  initializeStateCollections(used.filename, [{ ...pipelines, migrationId: "fixture", loadRecords: () => [pipeline("pipeline_since")] }]);
  const asideDigest = digest(usedAside);
  expect(checkStateDatabasesAtActivation(used.root, { now: new Date(NOW) })).toEqual([]);
  expect(rows<{ row_key: string }>(used.filename, "SELECT row_key FROM state_rows WHERE collection='pipelines'")).toEqual([{ row_key: "pipeline_since" }]);
  expect(digest(usedAside)).toBe(asideDigest);
});

test("the runtime journal's deployment list orders by start time on the minimum SQLite", async () => {
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const { root } = sandbox();
  const journal = new RuntimeJournal(path.join(root, "journal.sqlite"));
  try {
    const db = (journal as unknown as { db: InstanceType<typeof sqlite.Database> }).db;
    const insert = db.query("INSERT INTO entities(kind,id,revision,state_json,checkpoint_seq,updated_at) VALUES ('deployment', ?, 1, ?, ?, 1)");
    for (const [index, [id, createdAt]] of [["deployment-b", "2026-10-21T11:00:00.250Z"], ["deployment-a", "2026-10-21T12:00:00.750Z"], ["deployment-c", "2026-10-20T12:00:00.000Z"]].entries()) {
      insert.run(id, JSON.stringify({ deploymentId: id, idempotencyKey: id, createdAt, updatedAt: createdAt, phase: "succeeded", terminal: true }), index + 1);
    }
    expect(journal.listViewerDeployments({ limit: 3 }).deployments.map(row => row.deploymentId)).toEqual(["deployment-a", "deployment-b", "deployment-c"]);
  } finally { journal.close(); }
});
