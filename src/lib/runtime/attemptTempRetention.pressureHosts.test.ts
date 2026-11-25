import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, spyOn, test } from "bun:test";
import { WorktreeSweepWorker } from "../pipelines/worktreeSweepWorker";
import { AttemptTempStore, ATTEMPT_TEMP_LOW_SPACE_BYTES } from "./attemptTempRetention";
import { buildPipeline, savePipelines } from "../pipelines/store";
import { finishedLane } from "./attemptTempRetention.testSupport";
import { statePath } from "../configDir";
import { plantKeepMarker } from "./keepMarker.testSupport";
import { allocatedAttemptBytes } from "./attemptTempFilesystem";
import { AgentRegistry, type AgentHostStatus } from "../agent/registry";
import { emptyLaunchProfile } from "../accounts/migration/contracts";
import { materializeStructuredHostAccess, tempOwnerForConversation } from "./structuredSpawn";

import { cleanupPressureFixtures, NOW, roots, fixture, realParentPass, restoreEnvironment } from "./attemptTempPressure.testSupport";

afterEach(cleanupPressureFixtures);

for (const sqliteMode of ["off", "sqlite"] as const) for (const lowSpace of [false, true]) {
  test.each(["live", "starting", "resume", "starts-during-pass", "ended"] as const)(
    `real parent protects standalone %s scratch and config (${sqliteMode}, low-space=${lowSpace})`, async kind => {
    const originalEnv = { ...process.env }, f = fixture();
    process.env.LLV_STATE_DIR = path.join(f.root, "state");
    process.env.LLV_AGENT_REGISTRY_SQLITE = sqliteMode;
    let now = NOW - 2 * 86400000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const registry = new AgentRegistry(undefined, undefined, undefined, { sqliteMode });
    let access: ReturnType<typeof materializeStructuredHostAccess> | undefined;
    try {
      const profile = { ...emptyLaunchProfile({ cwd: f.root }), title: "Standalone pressure fixture" };
      // An ended fixture has no outstanding native-start admission owner.
      const launch = registry.beginSpawnRequest({ engine: "codex", cwd: f.root,
        transport: kind === "starts-during-pass" || kind === "ended" ? null : "structured", accountId: null, launchProfile: profile });
      if (launch.kind !== "created") throw new Error("fixture launch refused");
      const artifactPath = path.join(f.root, "transcript.jsonl"); fs.writeFileSync(artifactPath, "{}\n");
      registry.completeSpawn(launch.receipt.launchId, { key: { engine: "codex", sessionId: "pressure-standalone-session" }, artifactPath, cwd: f.root,
        accountId: null, launchProfile: profile, status: (kind === "resume" || kind === "starts-during-pass" || kind === "ended" ? "dead" : kind) as AgentHostStatus,
        host: null, claimEpoch: 0, claimOwner: null, pendingAction: kind === "resume" ? "resume" : null });
      const owner = tempOwnerForConversation(registry, launch.receipt.conversationId, launch.receipt.launchId);
      expect(owner.pipelineId).toBeNull();
      access = materializeStructuredHostAccess(false, process.env, null, undefined, owner);
      const store = new AttemptTempStore();
      const owned = store.retentionPage(32);
      for (const row of owned) store.measure(row.directory, 12288);
      store.close();
      expect(owned).toHaveLength(2);
      for (const row of owned) fs.writeFileSync(path.join(row.directory, "data"), "standalone work");
      const config = path.join(f.root, "fixture.json");
      fs.writeFileSync(config, JSON.stringify({ now: NOW, freeBytes: lowSpace ? 0 : 1e12,
        ...(kind === "starts-during-pass" ? { resumeDuringPass: owner.launchId } : {}) }));
      process.env.LLV_TEMP_SWEEP = "on"; process.env.LLV_ATTEMPT_TEMP_CAP_BYTES = lowSpace ? "1000000000" : "0";
      process.env.LLV_PRESSURE_FIXTURE = config; now = NOW;
      const report = await realParentPass();
      expect(report.errors).toBe(0);
      if (kind === "ended") {
        expect(report.removed).toBeGreaterThan(0);
        let removed = report.removed;
        for (let pass = 1; removed < 2 && pass < 3; pass++) {
          // A real filesystem proof can change during a native dispatch.
          // Verify the refusal's zero effects before restarting the helper.
          for (const row of owned.filter(row => fs.existsSync(row.directory))) {
            const stat = fs.statSync(row.directory);
            expect(`${stat.dev}:${stat.ino}`).toBe(row.identity);
            expect(fs.readFileSync(path.join(row.directory, "data"), "utf8")).toBe("standalone work");
          }
          const next = await realParentPass(); expect(next.errors).toBe(0); removed += next.removed;
        }
        expect(removed).toBe(2);
      } else expect(report.removed).toBe(0);
      for (const row of owned) {
        if (kind === "ended") expect(fs.existsSync(row.directory)).toBeFalse();
        else {
          const stat = fs.statSync(row.directory);
          expect(`${stat.dev}:${stat.ino}`).toBe(row.identity);
          expect(fs.readFileSync(path.join(row.directory, "data"), "utf8")).toBe("standalone work");
        }
      }
      if (kind === "starts-during-pass") {
        expect(registry.hostEntry(registry.spawnReceipt(owner.launchId)!.key!)?.status).toBe("starting");
        expect(report.outcomes.some(row => /^authority revision [a-f0-9]{64} changed before dispatch$/.test(row.reason))).toBeTrue();
      }
    } finally { access?.cleanup(); registry.close(); clock.mockRestore(); f.store.close(); restoreEnvironment(originalEnv); }
  }, 120_000);
}

test("real parent and restarted helper reclaim a thousand-root inventory five times over cap", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pressure-campaign-")); roots.push(root);
  const originalEnv = { ...process.env };
  const state = path.join(root, "state"), scratch = path.join(state, "scratch"); fs.mkdirSync(scratch, { recursive: true });
  process.env.LLV_STATE_DIR = state;
  const store = new AttemptTempStore(path.join(state, "attempt-temp.sqlite"));
  const held: string[] = [];
  try {
    const ended = finishedLane(root, new Date(NOW - 2 * 86400_000).toISOString());
    const live = buildPipeline({ id: "pressure-live", task: "Live pressure fixture", project: "fixture", repoDir: root,
      stages: [{ id: "build", kind: "run", prompt: "Fixture", next: null, effectiveRole: ended.stages[0]!.effectiveRole }],
      srcPath: null, srcConversationId: null, now: "2030-01-19T00:00:00Z" });
    live.runs = [{ stageId: "build", attempts: [{ n: 1, state: "running", launchId: "retention-launch", effectiveRole: live.stages[0]!.effectiveRole,
      conversationId: "fixture", sessionId: null, agentPath: null, paneId: null, flowId: null,
      startedAt: "2030-01-19T00:00:00Z", completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null }] }];
    savePipelines([ended, live]);
    for (let n = 0; n < 1000; n++) {
      const directory = path.join(scratch, `llv-stage-${String(n).padStart(6, "0")}`); fs.mkdirSync(directory, { mode: 0o700 });
      const payload = n < 100 ? 1024 ** 2 : 4096;
      fs.writeFileSync(path.join(directory, "data"), Buffer.alloc(payload));
      store.register({ directory, pipelineId: n === 1 ? live.id : "retention-lane", launchId: "retention-launch", retainUntilClose: false, createdAt: NOW - 10_000 + n });
      store.measure(directory, payload + 8192);
      if (n === 0 || n === 500) { plantKeepMarker(path.join(directory, ".delegatus-keep")); held.push(directory); }
      if (n === 1) held.push(directory);
    }
    const cap = store.bytes() / 5, config = path.join(root, "fixture.json");
    fs.writeFileSync(config, JSON.stringify({ pressureInventory: true, now: NOW, freeBytes: 100 * ATTEMPT_TEMP_LOW_SPACE_BYTES }));
    process.env.LLV_TEMP_SWEEP = "on"; process.env.LLV_ATTEMPT_TEMP_CAP_BYTES = String(cap); process.env.LLV_PRESSURE_FIXTURE = config;
    const preload = path.join(import.meta.dir, "attemptTempPressure.preload.ts");
    let passes = 0, reclaimed = 0;
    while (store.bytes() > cap && passes < 32) {
      const worker = new WorktreeSweepWorker({ executable: process.execPath, entry: "--preload", args: [preload, path.join(import.meta.dir, "../worktreeSweep.worker.ts")] },
        60_000, { now: () => 0, setTimeout, clearTimeout });
      try {
        const result = await worker.attemptTemp() as { checked: number; removed: number; removedBytes: number; overCapBytes: number; errors: number };
        expect(result.checked).toBeLessThanOrEqual(32); expect(result.removed).toBeGreaterThan(0); expect(result.errors).toBe(0);
        reclaimed += result.removedBytes; passes++;
      } finally { await worker.close(); }
    }
    expect(passes).toBeLessThanOrEqual(4); expect(store.bytes()).toBeLessThanOrEqual(cap); expect(reclaimed).toBeGreaterThan(0);
    const allocated = await allocatedAttemptBytes(scratch);
    expect(allocated).toBeLessThanOrEqual(cap);
    for (const directory of held) expect(fs.existsSync(directory)).toBeTrue();
    const report = JSON.parse(fs.readFileSync(statePath("attempt-temp-report.json"), "utf8"));
    expect(report.condition).toMatchObject({ overCap: false, failing: false });
    console.error(JSON.stringify({ fixture: "thousand-root-pressure", roots: 1000, cap, passes, reclaimed, remaining: store.bytes(), allocated }));
  } finally {
    store.close(); for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]; Object.assign(process.env, originalEnv);
  }
}, 180_000);
