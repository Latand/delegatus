import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { AgentRegistry } from "./registry";
import { pipelineSpawnHistorySelection } from "./sqliteRegistryStore";

test.each([{ sqliteMode: "off" }, { sqliteMode: "sqlite" }, { sqliteMode: "sqlite", clipped: true }] as const)("pipeline history reads original operation keys after reopen (%j)", async options => {
  const { sqliteMode } = options;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-spawn-history-"));
  const filename = path.join(root, "registry.json");
  let registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode });
  const base = "clipped" in options ? ("pipeline_" + "stage".repeat(24)).slice(0, 128) : "pipeline_example_build_2";
  try {
    const expected: string[] = [];
    for (const clientAttemptId of [base, `handshake_retry_2_${base}`, `handshake_retry_127_${base}`,
      base.length > 100 ? "pipeline_other_build_2" : `${base}0`, "handshake_retry_1_pipeline_other_build_2", "pipeline_example_build_3"]) {
      const reserved = registry.beginSpawnRequest({ engine: "codex", cwd: "/repo", transport: "structured",
        clientAttemptId: clientAttemptId.slice(0, 128), launchProfile: { title: "Recover original spawn history" } });
      expect(reserved.kind).toBe("created");
      if (!reserved.receipt) throw new Error("spawn fixture did not reserve a receipt");
      if (clientAttemptId === base || clientAttemptId.endsWith(`_${base}`)) expected.push(reserved.receipt.launchId);
      await registry.failStructuredSpawnOffLoop(reserved.receipt.launchId, "runtime host failed before dispatch");
    }
    registry.close();
    registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode });
    expect(registry.pipelineSpawnHistory(base).map(receipt => receipt.launchId).sort()).toEqual(expected.sort());
    expect(registry.pipelineSpawnHistory("pipeline_absent_build_1")).toEqual([]);
    expect(() => registry.pipelineSpawnHistory("pipeline_[untrusted]")).toThrow("invalid pipeline spawn history identity");
  } finally {
    registry.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pipeline history bounds receipt bodies before hydration, including archived operations", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-spawn-history-cap-"));
  const filename = path.join(root, "registry.json");
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite",
    now: () => Date.parse("2026-01-01T00:00:00Z") });
  const base = "pipeline_example_review_1";
  try {
    for (let call = 0; call < 130; call++) {
      const reserved = registry.beginSpawnRequest({ engine: "codex", cwd: "/repo", transport: "structured",
        clientAttemptId: call === 0 ? base : `handshake_retry_${call}_${base}`,
        launchProfile: { title: "Retain bounded history" } });
      await registry.failStructuredSpawnOffLoop(reserved.receipt.launchId, "runtime host failed before dispatch");
    }
    expect(registry.pipelineSpawnHistory(base)).toHaveLength(129);
    expect(registry.archiveInactiveRows(256)).toBeGreaterThan(0);
    expect(registry.pipelineSpawnHistory(base)).toHaveLength(129);
  } finally {
    registry.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pipeline history seeks the client-id index, and other lanes' receipts add nothing to its read", async () => {
  const base = "pipeline_example_build_2";
  const measure = async (otherLanes: number) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-spawn-history-index-"));
    const filename = path.join(root, "registry.json");
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
    try {
      const ids = [base, `handshake_retry_1_${base}`, `handshake_retry_2_${base}`,
        ...Array.from({ length: otherLanes }, (_, lane) => `pipeline_other${lane}_build_1`)];
      for (const clientAttemptId of ids) {
        const reserved = registry.beginSpawnRequest({ engine: "codex", cwd: "/repo", transport: "structured",
          clientAttemptId, launchProfile: { title: "Index the spawn history" } });
        await registry.failStructuredSpawnOffLoop(reserved.receipt.launchId, "runtime host failed before dispatch");
      }
      expect(registry.pipelineSpawnHistory(base)).toHaveLength(3);
      const db = new Database(filename.replace(/\.json$/, ".sqlite"), { readonly: true });
      try {
        const { sql, values } = pipelineSpawnHistorySelection(base);
        const plan = db.query<{ detail: string }, string[]>(`EXPLAIN QUERY PLAN ${sql}`).all(...values).map(row => row.detail);
        const searches = plan.filter(detail => detail.includes("registry_rows"));
        // The rows each branch may read: its index range, counted directly.
        const id = "json_extract(value_json,'$.clientAttemptId')";
        const visited = db.query<{ rows: number }, string[]>(`SELECT count(*) AS rows FROM registry_rows
          WHERE collection='receipts' AND (${id}=? OR (${id}>=? AND ${id}<?))`).get(values[0]!, values[1]!, values[2]!)!.rows;
        const receipts = db.query<{ rows: number }, []>("SELECT count(*) AS rows FROM registry_rows WHERE collection='receipts'").get()!.rows;
        return { searches, visited, receipts };
      } finally { db.close(); }
    } finally {
      registry.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
  const small = await measure(8);
  const large = await measure(48);
  for (const measured of [small, large]) {
    expect(measured.searches).toHaveLength(2);
    expect(measured.searches[0]).toContain("USING INDEX registry_lookup_clientAttemptId (collection=? AND <expr>=?)");
    expect(measured.searches[1]).toContain("USING INDEX registry_lookup_clientAttemptId (collection=? AND <expr>>? AND <expr><?)");
    expect(measured.visited).toBe(3);
  }
  expect(large.receipts - small.receipts).toBe(40);
});
