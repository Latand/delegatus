import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { AttemptTempStore } from "./attemptTempRetention";
import { savePipelines } from "../pipelines/store";
import { finishedLane } from "./attemptTempRetention.testSupport";
import { statePath } from "../configDir";
import { plantKeepMarker } from "./keepMarker.testSupport";
import { allocatedAttemptBytes } from "./attemptTempFilesystem";
import { NOW, roots, realParentPass, restoreEnvironment, nativeFenceDeferrals, ledgerRoots } from "./attemptTempPressure.testSupport";

export function protectedTailTests(timeoutPrefix: 4 | 8) {
for (const lowSpace of [false, true]) for (const clearsCap of lowSpace ? [false] : [false, true]) {
  test.each([
    { phase: "allocation" as const, requiredCost: 1500, costlyTail: false },
    { phase: "protection" as const, requiredCost: 1500, costlyTail: false },
    { phase: "allocation" as const, requiredCost: 3000, costlyTail: true },
  ])(
    `real parent advances a bounded pass past protected and slow roots (timeouts=${timeoutPrefix}, low-space=${lowSpace}, clears-cap=${clearsCap}, phase=$phase, costly-tail=$costlyTail)`, async ({ phase, requiredCost, costlyTail }) => {
    const originalEnv = { ...process.env };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-windows-")); roots.push(root);
    const state = path.join(root, "state"), scratch = path.join(state, "scratch"); fs.mkdirSync(scratch, { recursive: true });
    process.env.LLV_STATE_DIR = state;
    const store = new AttemptTempStore(), config = path.join(root, "fixture.json");
    const directories: { directory: string; identity: string }[] = [];
    const count = timeoutPrefix + 32;
    try {
      savePipelines([finishedLane(root, new Date(NOW - 2 * 86400_000).toISOString())]);
      for (let n = 0; n <= count; n++) {
        const directory = path.join(scratch, `llv-stage-${String(n).padStart(6, "0")}`);
        fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "data"), Buffer.alloc(4096));
        store.register({ directory, pipelineId: "retention-lane", launchId: "retention-launch", retainUntilClose: false, createdAt: NOW - 1000 + n });
        if (n === count) plantKeepMarker(path.join(directory, ".delegatus-keep"));
        store.measure(directory, await allocatedAttemptBytes(directory));
        const stat = fs.statSync(directory); directories.push({ directory, identity: `${stat.dev}:${stat.ino}` });
      }
      const held = directories[count]!, heldBytes = store.owner(held.directory)!.bytes;
      if (clearsCap) store.measure(held.directory, 2e9);
      process.env.LLV_TEMP_SWEEP = "on"; process.env.LLV_ATTEMPT_TEMP_CAP_BYTES = lowSpace || clearsCap ? "1000000000" : "0";
      process.env.LLV_PRESSURE_FIXTURE = config;
      fs.writeFileSync(config, JSON.stringify({ pressureInventory: true, now: NOW, freeBytes: lowSpace ? 0 : 1e12,
        slowProof: { phase, prefix: count + Number(costlyTail), timeoutPrefix, requiredCost } }));
      const before = store.bytes();
      let report = await realParentPass(), clock = JSON.parse(fs.readFileSync(config, "utf8"));
      for (let tick = 1; !clearsCap && report.removed === 0 && tick < Math.ceil(timeoutPrefix / 7) + 2; tick++) {
        expect(report.errors).toBe(0); expect(clock.elapsed).toBeLessThanOrEqual(40_001);
        fs.writeFileSync(config, JSON.stringify({ pressureInventory: true, now: NOW, freeBytes: lowSpace ? 0 : 1e12,
          slowProof: { phase, prefix: count + Number(costlyTail), timeoutPrefix, requiredCost } }));
        report = await realParentPass(); clock = JSON.parse(fs.readFileSync(config, "utf8"));
      }
      if (clearsCap) {
        expect(report).toMatchObject({ removed: 0, removedBytes: 0, errors: 0, overCapBytes: 0, checked: 1 });
        expect(report.deferred).toBe(0);
        // The largest protected root is measured first and clears the cap
        // before the expensive suffix needs any proof window.
        expect(clock.elapsed ?? 0).toBeLessThanOrEqual(40_001);
        for (const { directory, identity } of directories) {
          const stat = fs.statSync(directory); expect(`${stat.dev}:${stat.ino}`).toBe(identity);
          expect(fs.readFileSync(path.join(directory, "data")).length).toBe(4096);
        }
        expect(JSON.parse(fs.readFileSync(statePath("attempt-temp-report.json"), "utf8")).pass.ended).toBe("pressure-cleared");
        return;
      }
      expect(report.removed).toBeGreaterThan(0); expect(report.errors).toBe(0);
      expect(report.checked).toBeLessThanOrEqual(count + 1 + 32);
      expect(report.outcomes.length).toBeLessThanOrEqual(count + 1);
      expect(new Set(report.outcomes.map(row => row.directory)).size).toBe(report.outcomes.length);
      expect(report.deferred).toBe(report.checked - report.removed - report.held);
      expect(clock.elapsed).toBeLessThanOrEqual(40_001);
      expect(Math.max(...clock.windows)).toBeLessThanOrEqual(5000);
      expect(report.removedBytes).toBe(before - report.bytes);
      for (const { directory, identity } of [...directories.slice(0, timeoutPrefix), held]) {
        expect(`${fs.statSync(directory).dev}:${fs.statSync(directory).ino}`).toBe(identity);
        expect(fs.readFileSync(path.join(directory, "data")).length).toBe(4096);
      }
      expect(fs.existsSync(path.join(held.directory, ".delegatus-keep"))).toBeTrue();
      // The durable pass position names the next root; no visited root precedes it again.
      const next = store.pressurePassRoot(store.activePressurePass()!.position)!.directory;
      const cut = report.outcomes.at(-1)!;
      expect(!report.outcomes.some(row => row.directory === next) || cut.directory === next && cut.disposition === "deferred").toBeTrue();
      console.error(JSON.stringify({ fixture: "protected-proof-tail", phase, timeoutPrefix, lowSpace, costlyTail,
        checked: report.checked, removed: report.removed, removedBytes: report.removedBytes, deferred: report.deferred,
        bytes: report.bytes, elapsed: clock.elapsed }));
      // Restore proof and restart the actual helper over the same durable
      // cursor. The protected root stays while every ended sibling recovers.
      process.env.LLV_ATTEMPT_TEMP_CAP_BYTES = String(heldBytes);
      let removed = report.removed;
      let recoveryAt = NOW + (clock.elapsed ?? 0);
      const recover = () => {
        const retryAt = ledgerRoots(store, scratch).filter(row => row.directory !== held.directory).map(row => row.checkedAt);
        // The helper restarts on later ticks. Let recorded proof backoff
        // elapse before asking a new pass to reach the earlier deferrals.
        recoveryAt = Math.max(recoveryAt + 60_000, ...retryAt);
        fs.writeFileSync(config, JSON.stringify({ pressureInventory: true, now: recoveryAt, freeBytes: 1e12 }));
        return realParentPass();
      };
      const nativeRefused = new Set<string>();
      for (let pass = 0; pass < 3 && store.bytes() > heldBytes; pass++) {
        const recovered = await recover();
        if (pass === 0) expect(recovered.outcomes[0]!.directory).toBe(next);
        for (const directory of nativeFenceDeferrals(recovered, store)) nativeRefused.add(directory);
        expect(recovered.errors).toBe(0); removed += recovered.removed;
      }
      // Only a named native refusal with proven zero effects permits more
      // starts. A pressure-budget or cursor failure retains the three-pass
      // assertion rather than receiving an unconditional retry.
      for (let retry = 0; retry < 3 && store.bytes() > heldBytes; retry++) {
        for (const owner of ledgerRoots(store, scratch).filter(row => row.directory !== held.directory)) {
          expect(nativeRefused.has(owner.directory)).toBeTrue();
          const stat = fs.statSync(owner.directory); expect(`${stat.dev}:${stat.ino}`).toBe(owner.identity);
          expect(fs.readFileSync(path.join(owner.directory, "data")).length).toBe(4096);
        }
        const recovered = await recover(); expect(recovered.errors).toBe(0); removed += recovered.removed;
        for (const directory of nativeFenceDeferrals(recovered, store)) nativeRefused.add(directory);
      }
      expect(removed).toBe(count); expect(store.bytes()).toBe(heldBytes);
      expect(fs.readFileSync(path.join(held.directory, "data")).length).toBe(4096);
      expect(fs.existsSync(path.join(held.directory, ".delegatus-keep"))).toBeTrue();
      expect(JSON.parse(fs.readFileSync(statePath("attempt-temp-report.json"), "utf8")).condition.failing).toBeFalse();
    } finally { store.close(); restoreEnvironment(originalEnv); }
  }, 120_000);
}

}
