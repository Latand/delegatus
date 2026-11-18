import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AttemptTempStore } from "./attemptTempRetention";
import { savePipelines } from "../pipelines/store";
import { finishedLane } from "./attemptTempRetention.testSupport";
import { plantKeepMarker } from "./keepMarker.testSupport";
import { cleanupPressureFixtures, NOW, roots, realParentPass, restoreEnvironment } from "./attemptTempPressure.testSupport";

afterEach(cleanupPressureFixtures);

test("large protection inventories resume across helper restarts and honor a late descendant pin", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "protection-recovery-")); roots.push(root);
  const before = { ...process.env }, state = path.join(root, "state"), scratch = path.join(state, "scratch");
  fs.mkdirSync(scratch, { recursive: true }); process.env.LLV_STATE_DIR = state;
  const store = new AttemptTempStore(), config = path.join(root, "fixture.json");
  const directory = path.join(scratch, "llv-stage-000001"), count = 65_536;
  try {
    savePipelines([finishedLane(root, new Date(NOW - 3600_000).toISOString())]);
    fs.mkdirSync(directory, { mode: 0o700 }); fs.writeFileSync(path.join(directory, "data"), "retained payload");
    for (let n = 0; n < count; n++) fs.mkdirSync(path.join(directory, String(n).padStart(6, "0")));
    store.register({ directory, pipelineId: "retention-lane", launchId: "retention-launch", retainUntilClose: false, createdAt: NOW - 1000 });
    store.measure(directory, 8 * 1024 ** 3); store.close();
    process.env.LLV_TEMP_SWEEP = "on"; process.env.LLV_ATTEMPT_TEMP_CAP_BYTES = "0"; process.env.LLV_PRESSURE_FIXTURE = config;
    const tick = async (n: number) => {
      fs.writeFileSync(config, JSON.stringify({ now: NOW + n * 105_000, freeBytes: 1e12, realClock: true, measureCost: 0 }));
      expect(await realParentPass(true)).not.toBeNull();
      return JSON.parse(fs.readFileSync(path.join(state, "attempt-temp-report.json"), "utf8"));
    };
    const first = await tick(0);
    expect(first.removed).toBe(0); expect(first.deferred).toBe(1);
    expect(first.outcomes[0].reason).toContain("inventory checkpointed");
    // This directory was already inventoried. A pin inserted after the helper
    // exits must invalidate that persisted observation before any deletion.
    const inventoryFiles = fs.readdirSync(path.join(state, "attempt-protection"));
    expect(inventoryFiles).toHaveLength(1);
    const inventory = new Database(path.join(state, "attempt-protection", inventoryFiles[0]!), { readonly: true });
    const scanned = inventory.query<{ file: string }, [string]>("SELECT file FROM directories WHERE version IS NOT NULL AND file<>? ORDER BY file LIMIT 1").get(directory)!;
    inventory.close();
    const marker = path.join(scanned.file, ".delegatus-keep"); plantKeepMarker(marker);
    let held = false;
    for (let n = 1; n <= 40; n++) {
      const report = await tick(n);
      expect(report.removed).toBe(0); expect(report.errors).toBe(0);
      expect(fs.readFileSync(path.join(directory, "data"), "utf8")).toBe("retained payload");
      if (report.outcomes.some((row: { disposition: string }) => row.disposition === "evidence")) { held = true; break; }
    }
    expect(held).toBeTrue();
    fs.unlinkSync(marker);
    let removed = false;
    for (let n = 41; n <= 110; n++) {
      const report = await tick(n);
      expect(report.errors).toBe(0);
      if (report.removed > 0) { removed = true; break; }
    }
    expect(removed).toBeTrue(); expect(fs.existsSync(directory)).toBeFalse();
    expect(fs.readdirSync(path.join(state, "attempt-protection"))).toEqual([]);
  } finally { store.close(); restoreEnvironment(before); }
}, 280_000);
