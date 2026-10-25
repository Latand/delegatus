import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeStateCollections, readCompactPipelineEvidence, pipelineEvidenceRevision } from "./sqliteStateStore";
import { blockingWaitDiagnostics, resetBlockingWaitsForTests } from "@/lib/blockingWaits";

test("compact evidence validates changed rows across raw writes, deletion, rollback and lost tracking", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "compact-evidence-"));
  const filename = path.join(root, "state.sqlite");
  try {
    initializeStateCollections(filename, ["pipelines", "pipelines_archive"].map(collection => ({ collection, schemaVersion: 1,
      migrationId: "one", key: (row: { id: string }) => row.id, loadRecords: () => Array.from({ length: 100 }, (_, i) => ({ id: `${collection}-${i}` })) })));
    const db = new Database(filename);
    try {
      const plan = db.query<{ detail: string }, [number]>(`EXPLAIN QUERY PLAN SELECT e.collection,e.row_key,e.revision,r.row_key AS present
        FROM pipeline_evidence_rows e INDEXED BY pipeline_evidence_changed LEFT JOIN state_rows r
        ON r.collection=e.collection AND r.row_key=e.row_key
        WHERE e.revision>? AND e.collection IN ('pipelines','pipelines_archive') ORDER BY e.revision,e.collection,e.row_key`).all(0);
      expect(plan.some(row => /SEARCH e USING COVERING INDEX pipeline_evidence_changed.*revision>/.test(row.detail))).toBe(true);
      let decodes = 0;
      const project = (raw: unknown) => { decodes++; return (raw as { id: string }).id; };
      let cache = (await readCompactPipelineEvidence(filename, undefined, project))!;
      expect(decodes).toBe(200);
      cache = (await readCompactPipelineEvidence(filename, cache, project))!;
      expect(decodes).toBe(200);
      const before = pipelineEvidenceRevision(filename);
      db.query("UPDATE state_rows SET value_json=? WHERE collection='pipelines' AND row_key='pipelines-0'").run('{"id":"changed"}');
      expect(pipelineEvidenceRevision(filename)).not.toBe(before);
      const pinned = cache;
      cache = (await readCompactPipelineEvidence(filename, cache, project))!;
      expect(pinned.rows.get(JSON.stringify(["pipelines", "pipelines-0"]))?.value).toBe("pipelines-0");
      expect(decodes).toBe(201);
      expect([...cache.rows.values()].map(row => row.value)).toContain("changed");
      db.exec("BEGIN IMMEDIATE");
      db.query("DELETE FROM state_rows WHERE collection='pipelines'").run();
      db.exec("ROLLBACK");
      cache = (await readCompactPipelineEvidence(filename, cache, project))!;
      expect(decodes).toBe(201);
      expect(cache.rows.size).toBe(200);
      db.query("DELETE FROM state_rows WHERE collection='pipelines_archive'").run();
      cache = (await readCompactPipelineEvidence(filename, cache, project))!;
      expect(cache.rows.size).toBe(100);
      // Clearing the old change journal cannot suppress trigger evidence.
      db.query("DELETE FROM state_changes").run();
      db.query("UPDATE state_rows SET value_json='{broken' WHERE row_key='pipelines-0'").run();
      await expect(readCompactPipelineEvidence(filename, cache, project)).rejects.toThrow("corrupt pipelines SQLite row");
      db.exec("DROP TRIGGER pipeline_evidence_update");
      expect(pipelineEvidenceRevision(filename)).toBeNull();
      expect(await readCompactPipelineEvidence(filename, cache, project)).toBeNull();
    } finally { db.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

/* Each startup admission asks for the revision two or three times. Opening
   the state database and checking the index schema cost about 16 ms each on a
   production copy; the schema check now runs once per schema version, and the
   revision is read from the clock on every call. */
test("the evidence schema is checked again only after a schema edit or a replacement, and every commit moves the revision", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-revision-memo-"));
  const filename = path.join(root, "state.sqlite");
  const query = spyOn(Database.prototype, "query");
  const schemaReads = () => query.mock.calls.filter(([sql]) => String(sql).includes("FROM sqlite_master WHERE name IN")).length;
  try {
    const seed = (collection: string) => ({ collection, schemaVersion: 1, migrationId: "one", key: (row: { id: string }) => row.id,
      loadRecords: () => [{ id: `${collection}-0` }] });
    initializeStateCollections(filename, ["pipelines", "pipelines_archive"].map(seed));
    const first = pipelineEvidenceRevision(filename);
    expect(first).not.toBeNull();
    const reads = schemaReads();
    for (let call = 0; call < 5; call++) expect(pipelineEvidenceRevision(filename)).toBe(first);
    expect(await readCompactPipelineEvidence(filename, undefined, raw => raw)).not.toBeNull();
    expect(schemaReads()).toBe(reads);
    const db = new Database(filename);
    try {
      db.exec("BEGIN IMMEDIATE");
      db.query("UPDATE state_rows SET value_json='{\"id\":\"rolled back\"}' WHERE collection='pipelines'").run();
      db.exec("ROLLBACK");
      expect(pipelineEvidenceRevision(filename)).toBe(first);
      db.query("UPDATE state_rows SET value_json='{\"id\":\"changed\"}' WHERE collection='pipelines'").run();
      const changed = pipelineEvidenceRevision(filename);
      expect(changed).not.toBeNull();
      expect(changed).not.toBe(first);
      expect(schemaReads()).toBe(reads);
      // A schema edit is seen by the next call, through either reader.
      db.exec("DROP TRIGGER pipeline_evidence_update");
      expect(pipelineEvidenceRevision(filename)).toBeNull();
      expect(await readCompactPipelineEvidence(filename, undefined, raw => raw)).toBeNull();
      expect(schemaReads()).toBe(reads + 1);
    } finally { db.close(); }
    // A replacement at the same path never answers from the old file.
    fs.rmSync(filename); fs.rmSync(`${filename}-wal`, { force: true }); fs.rmSync(`${filename}-shm`, { force: true });
    initializeStateCollections(filename, ["pipelines", "pipelines_archive"].map(seed));
    expect(pipelineEvidenceRevision(filename)).not.toBeNull();
    // A deleted clock row refuses at once, with the schema unchanged.
    const raw = new Database(filename);
    try { raw.query("DELETE FROM pipeline_evidence_clock").run(); } finally { raw.close(); }
    expect(pipelineEvidenceRevision(filename)).toBeNull();
  } finally { query.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("a contended synchronous initialization refuses promptly, records its wait, and retries intact", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "state-busy-bound-"));
  const filename = path.join(root, "state.sqlite");
  const seed = { collection: "fixture", schemaVersion: 1, migrationId: "one", key: (row: { id: string }) => row.id,
    loadRecords: () => [{ id: "retained" }] };
  try {
    initializeStateCollections(filename, [seed]);
    const peer = new Database(filename);
    peer.exec("BEGIN IMMEDIATE");
    resetBlockingWaitsForTests(() => {});
    const started = performance.now();
    try { expect(() => initializeStateCollections(filename, [seed])).toThrow("busy"); }
    finally { peer.exec("ROLLBACK"); peer.close(); }
    expect(performance.now() - started).toBeLessThan(1000);
    expect(blockingWaitDiagnostics().sites["state-write-lock"]?.synchronousCount).toBeGreaterThan(0);
    initializeStateCollections(filename, [seed]);
    const check = new Database(filename, { readonly: true });
    try { expect(check.query("SELECT value_json FROM state_rows WHERE collection='fixture'").all()).toEqual([{ value_json: '{"id":"retained"}' }]); }
    finally { check.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 60_000);
