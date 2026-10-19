import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { candidateHostLoopRecords, startCandidateRuntimeHost } from "./candidateRuntimeHost";
import { candidatePerformanceEvidence, CANDIDATE_PERFORMANCE_BOUNDS } from "./candidatePerformance";
import { passingCandidatePerformanceMeasurements } from "./fixtures/candidatePerformanceMeasurements";

const line = (gap: number, at: number, extra = {}) => `[viewer loop-gap] ${JSON.stringify({ role: "runtime-host", pid: 42, utc: new Date(at).toISOString(), gapMs: gap, logDropped: 0, ...extra })}`;

test("host readings require the host identity and exclude boot and gaps straddling warm-up", () => {
  const records = candidateHostLoopRecords();
  records.read(line(900, 1000), 42);
  records.read(line(800, 2200), 42);
  records.read(line(300, 4000, { role: "viewer" }), 42);
  records.read(line(500, 4000, { pid: 43 }), 42);
  records.read(line(251, 4000), 42);
  expect(records.window(2000, 5000)).toEqual({ records: 1, malformed: 0, maxMs: 251 });
  expect(candidateHostLoopRecords().window(0, 5000)).toEqual({ records: 0, malformed: 0, maxMs: 0 });
});

test("a quiet host's minute summary proves its loop diagnostics were read", () => {
  const records = candidateHostLoopRecords();
  records.read(`[performance summary] ${JSON.stringify({ role: "runtime-host", pid: 42, utc: new Date(60000).toISOString(), logDropped: 0 })}`, 42);
  expect(records.window(1000, 76000)).toEqual({ records: 1, malformed: 0, maxMs: 0 });
});

test("unreadable, dropped and overflowing loop evidence fails closed", () => {
  const records = candidateHostLoopRecords();
  records.read("[viewer loop-gap] {", 42);
  records.read(line(-1, 4000), 42);
  records.read(line(300, 4000, { logDropped: 1 }), 42);
  records.reject();
  expect(records.window(0, 5000).malformed).toBe(4);
  for (let i = 0; i < 4097; i++) records.read(line(300, 4000), 42);
  expect(records.window(0, 5000)).toEqual({ records: 4096, malformed: 5, maxMs: 300 });
});

test("a real restarted host reports an induced stall through its own loop records", async () => {
  for (let generation = 0; generation < 2; generation++) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rg2-host-"));
    const env = { PATH: process.env.PATH!, HOME: path.join(directory, "home"), XDG_CONFIG_HOME: path.join(directory, "config"),
      TMPDIR: directory, LLV_STATE_DIR: path.join(directory, "state"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", DELEGATUS_TELEMETRY: "0" };
    for (const value of [env.HOME, env.XDG_CONFIG_HOME, env.LLV_STATE_DIR]) fs.mkdirSync(value, { recursive: true });
    const host = await startCandidateRuntimeHost({ runtimeBin: process.execPath, cwd: path.resolve(import.meta.dir, "../.."), env, directory: path.join(directory, "rt") });
    try {
      const started = Date.now();
      expect(host.loopReading(started, started).records).toBe(0);
      await host.holdLoop(800);
      const reading = host.loopReading(started, Date.now());
      expect(reading.records).toBeGreaterThan(0);
      expect(reading.maxMs).toBeGreaterThanOrEqual(780);
      expect(reading.malformed).toBe(0);
      expect(host.exited()).toBe(false);
      const measured = passingCandidatePerformanceMeasurements();
      measured.hostLoop = reading;
      const report = candidatePerformanceEvidence({ checkedAt: "2026-10-01T00:00:00.000Z", runtime: `bun ${Bun.version}`,
        bounds: CANDIDATE_PERFORMANCE_BOUNDS, measurements: measured, breaches: [], ok: true });
      expect(report.ok).toBe(true);
      expect(report.timingWarnings).toEqual([expect.stringMatching(/^runtime-host event-loop gap outside boot \d+ms exceeds 250ms$/)]);
    } finally {
      await host.stop();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}, 60_000);
