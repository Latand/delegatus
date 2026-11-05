import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { initializeStateCollections } from "@/lib/state/sqliteStateStore";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { buildPipeline, loadPipelines, loadArchivedPipelines, pipelineDeliveryLookup, pipelineStateCollectionSeeds } from "./store";

function fixture(id: string) {
  return { ...buildPipeline({ id, task: "Retained format upgrade", project: "fixture", repoDir: "/repo",
    stages: [{ id: "build", kind: "run", prompt: "Build", next: null,
      effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } }],
    srcPath: null, srcConversationId: null, now: "2026-11-05T00:00:00.000Z" }),
    creationRequest: { key: `original-${id}`, digest: "original" },
    adoptedCreationRequest: { key: `prior-${id}`, digest: "prior" },
    adoptedCreationRequests: [{ key: `adopted-${id}`, digest: "adopted" }],
  };
}
async function isolated(run: (root: string) => void | Promise<void>) {
  const previous = process.env.LLV_STATE_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-format-upgrade-"));
  process.env.LLV_STATE_DIR = root;
  try { await run(root); }
  finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function oldState(root: string) {
  const active = fixture("active"), archive = fixture("archive");
  const opaque = { ...fixture("opaque"), state: "future-state" };
  initializeStateCollections(path.join(root, "state.sqlite"), pipelineStateCollectionSeeds().map((seed, index) => ({
    ...seed, schemaVersion: 5, compatibleSchemaVersions: undefined, loadRecords: () => index === 0 ? [active, opaque] : [archive],
  })));
  const db = new Database(path.join(root, "state.sqlite"));
  try {
    db.exec("UPDATE state_collections SET revision=17,change_floor=3 WHERE collection='pipelines'");
    db.exec("UPDATE state_collections SET revision=9,change_floor=2 WHERE collection='pipelines_archive'");
    db.exec("UPDATE state_rows SET row_revision=(SELECT revision FROM state_collections WHERE collection=state_rows.collection)");
    db.exec("INSERT INTO state_changes(collection,revision,row_key,operation) VALUES ('pipelines',17,'active','upsert'),('pipelines_archive',9,'archive','upsert')");
    db.query("INSERT INTO state_imports(collection,source_name,source_sha256,source_bytes,row_count,row_digest,release,imported_at,mirror_sha256,mirror_revision,reconciled_sha256) VALUES ('pipelines',?,?,?,?,?,?,?,?,?,?)")
      .run("pipelines.json", "a".repeat(64), 123, 2, "b".repeat(64), "old-release", "2026-11-01T00:00:00.000Z", "c".repeat(64), 17, "d".repeat(64));
  } finally { db.close(); }
  fs.writeFileSync(path.join(root, "pipelines.json"), "stale invalid JSON must stay unread");
  fs.writeFileSync(path.join(root, "pipelines-archive.json"), "stale invalid archive must stay unread");
}
function snapshot(root: string) {
  const db = new Database(path.join(root, "state.sqlite"), { readonly: true });
  try { return {
    markers: db.query<{ collection: string; schema_version: number }, []>("SELECT collection,schema_version FROM state_collections ORDER BY collection").all(),
    metadata: db.query("SELECT collection,revision,change_floor,migration_id,imported_at FROM state_collections ORDER BY collection").all(),
    rows: db.query("SELECT * FROM state_rows ORDER BY collection,row_key").all(),
    changes: db.query("SELECT * FROM state_changes ORDER BY collection,revision,row_key").all(),
    imports: db.query("SELECT * FROM state_imports ORDER BY collection").all(),
    leases: db.query("SELECT * FROM state_leases ORDER BY collection").all(),
    receipts: db.query("SELECT * FROM pipeline_request_receipts ORDER BY collection,row_key,request_key").all(),
    controller: db.query("SELECT * FROM pipeline_controller_work").all().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    scheduling: db.query("SELECT * FROM pipeline_tick_work").all().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  }; } finally { db.close(); }
}

test("format five upgrades both authoritative collections without rewriting data or replay evidence", async () => isolated(root => {
  oldState(root);
  const before = snapshot(root);
  expect(loadPipelines().map(p => p.id)).toEqual(["active"]);
  expect(loadArchivedPipelines().map(p => p.id)).toEqual(["archive"]);
  const after = snapshot(root);
  expect(after.markers).toEqual([{ collection: "pipelines", schema_version: 6 }, { collection: "pipelines_archive", schema_version: 6 }]);
  expect({ ...after, markers: before.markers }).toEqual(before);
  for (const id of ["active", "archive"]) for (const prefix of ["original", "prior", "adopted"]) {
    expect(pipelineDeliveryLookup({ requestKey: `${prefix}-${id}` })?.id).toBe(id);
  }
  expect(fs.readFileSync(path.join(root, "pipelines.json"), "utf8")).toBe("stale invalid JSON must stay unread");
  initializeStateCollections(path.join(root, "state.sqlite"), pipelineStateCollectionSeeds());
  expect(snapshot(root)).toEqual(after);
}));


test.each(["mixed", "missing", "future", "migration"] as const)("format upgrade refuses %s metadata without changing retained evidence", async kind => isolated(root => {
  oldState(root);
  const db = new Database(path.join(root, "state.sqlite"));
  try {
    if (kind === "mixed") db.exec("UPDATE state_collections SET schema_version=6 WHERE collection='pipelines_archive'");
    if (kind === "missing") db.exec("DELETE FROM state_collections WHERE collection='pipelines_archive'");
    if (kind === "future") db.exec("UPDATE state_collections SET schema_version=7");
    if (kind === "migration") db.exec("UPDATE state_collections SET migration_id='unknown' WHERE collection='pipelines'");
  } finally { db.close(); }
  const before = snapshot(root);
  expect(loadPipelines).toThrow(kind === "mixed" ? "mixed collection versions" : kind === "missing" ? "both retained collections"
    : kind === "future" ? "unsupported pipelines SQLite schema: 7" : "unknown migration identity");
  expect(snapshot(root)).toEqual(before);
}));

test("format upgrade refuses a mismatched receipt schema without repairing or relabeling it", async () => isolated(root => {
  oldState(root);
  const db = new Database(path.join(root, "state.sqlite"));
  try { db.exec("DROP INDEX pipeline_request_receipt_key; CREATE INDEX pipeline_request_receipt_key ON pipeline_request_receipts(collection,row_key)"); }
  finally { db.close(); }
  const before = snapshot(root);
  expect(loadPipelines).toThrow("verified pipeline_request_receipt_key schema");
  expect(snapshot(root)).toEqual(before);
}));

test("a fault during the joint marker update rolls back backfill and both markers, then retry succeeds", async () => isolated(root => {
  oldState(root);
  const filename = path.join(root, "state.sqlite"), db = new Database(filename);
  try {
    db.exec("DELETE FROM pipeline_request_receipts WHERE request_key='adopted-active'");
    db.exec("CREATE TRIGGER reject_archive_format BEFORE UPDATE OF schema_version ON state_collections WHEN NEW.collection='pipelines_archive' AND NEW.schema_version=6 BEGIN SELECT RAISE(ABORT, 'fixture marker fault'); END");
  } finally { db.close(); }
  const before = snapshot(root);
  expect(loadPipelines).toThrow("fixture marker fault");
  expect(snapshot(root)).toEqual(before);
  const repair = new Database(filename);
  try { repair.exec("DROP TRIGGER reject_archive_format"); } finally { repair.close(); }
  expect(loadPipelines().map(p => p.id)).toEqual(["active"]);
  expect(snapshot(root).markers.every(marker => marker.schema_version === 6)).toBe(true);
  expect(pipelineDeliveryLookup({ requestKey: "adopted-active" })?.id).toBe("active");
  expect(snapshot(root).rows).toEqual(before.rows);
  expect(snapshot(root).metadata).toEqual(before.metadata);
}));

test.each(["non-owner", "after-marks"] as const)("format upgrade retains all evidence when startup authority is lost: %s", async mode => isolated(root => {
  oldState(root);
  const db = new Database(path.join(root, "state.sqlite"));
  try { db.exec("DELETE FROM pipeline_request_receipts WHERE request_key='adopted-active'"); } finally { db.close(); }
  const before = snapshot(root);
  const result = spawnSync(process.execPath, ["-e", `
    import { mock } from "bun:test";
    const mode = ${JSON.stringify(mode)};
    const ownership = await import("./src/lib/stateOwnership.ts");
    const check = ownership.assertStateStartupMutation;
    let publicationChecks = 0;
    mock.module("./src/lib/stateOwnership.ts", () => ({ ...ownership,
      assertStateStartupMutation: (directory, step) => {
        if (mode === "non-owner" && step === "pipeline format six migration"
          || mode === "after-marks" && step === "pipeline format six publication" && ++publicationChecks === 2) {
          throw new ownership.StateStartupMutationRefused(step, directory, {});
        }
        return check(directory, step);
      },
    }));
    const store = await import("./src/lib/pipelines/store.ts");
    try { store.loadPipelines(); process.exit(2); }
    catch (error) { if (!String(error).includes("pipeline format six")) throw error; }
  `], { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 20_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(snapshot(root)).toEqual(before);
}));

test("a live or unidentified collection writer holds the format transition until its lease is released", async () => isolated(root => {
  oldState(root);
  const filename = path.join(root, "state.sqlite"), owner = captureProcessIdentity(process.pid);
  const db = new Database(filename);
  try { db.query("INSERT INTO state_leases(collection,owner_token,owner_pid,owner_start_identity,acquired_at) VALUES ('pipelines','live-fixture',?,?,?)")
    .run(owner.pid, owner.startIdentity, Date.now()); } finally { db.close(); }
  const before = snapshot(root);
  expect(loadPipelines).toThrow(/collection writer|state migration is busy/);
  expect(snapshot(root)).toEqual(before);
  const unknown = new Database(filename);
  try { unknown.exec("UPDATE state_leases SET owner_start_identity=NULL WHERE owner_token='live-fixture'"); } finally { unknown.close(); }
  const uncertain = snapshot(root);
  expect(loadPipelines).toThrow(/collection writer|state migration is busy/);
  expect(snapshot(root)).toEqual(uncertain);
  const release = new Database(filename);
  try { release.exec("DELETE FROM state_leases WHERE owner_token='live-fixture'"); } finally { release.close(); }
  expect(loadPipelines().map(p => p.id)).toEqual(["active"]);
}));

test.skipIf(process.platform !== "linux")("a proven reused PID lease stays byte-for-byte during the format transition", async () => isolated(root => {
  oldState(root);
  const owner = captureProcessIdentity(process.pid);
  expect(owner.startIdentity).not.toBeNull();
  const db = new Database(path.join(root, "state.sqlite"));
  try { db.query("INSERT INTO state_leases(collection,owner_token,owner_pid,owner_start_identity,acquired_at) VALUES ('pipelines','prior-fixture',?,?,?)")
    .run(owner.pid, `${owner.startIdentity}-previous`, Date.now()); } finally { db.close(); }
  const before = snapshot(root);
  expect(loadPipelines().map(p => p.id)).toEqual(["active"]);
  const after = snapshot(root);
  expect(after.markers.every(marker => marker.schema_version === 6)).toBe(true);
  expect({ ...after, markers: before.markers }).toEqual(before);
}));
