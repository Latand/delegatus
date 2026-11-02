import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry } from "./registry";

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
