import { expect, test } from "bun:test";
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
      let decodes = 0;
      const project = (raw: unknown) => { decodes++; return (raw as { id: string }).id; };
      let cache = (await readCompactPipelineEvidence(filename, undefined, project))!;
      expect(decodes).toBe(200);
      cache = (await readCompactPipelineEvidence(filename, cache, project))!;
      expect(decodes).toBe(200);
      const before = pipelineEvidenceRevision(filename);
      db.query("UPDATE state_rows SET value_json=? WHERE collection='pipelines' AND row_key='pipelines-0'").run('{"id":"changed"}');
      expect(pipelineEvidenceRevision(filename)).not.toBe(before);
      cache = (await readCompactPipelineEvidence(filename, cache, project))!;
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
