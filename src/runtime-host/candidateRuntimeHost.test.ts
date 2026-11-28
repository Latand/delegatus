import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CandidateBrowserStartupError, captureBrowserStartupStderr, candidateHostLoopRecords, startCandidateRuntimeHost, waitForServerStartup } from "./candidateRuntimeHost";
import { candidatePerformanceEvidence, CANDIDATE_PERFORMANCE_BOUNDS, CANDIDATE_PERFORMANCE_REPORT_PREFIX, parseCandidatePerformanceReport } from "./candidatePerformance";
import { passingCandidatePerformanceMeasurements } from "./fixtures/candidatePerformanceMeasurements";

const line = (gap: number, at: number, extra = {}) => `[viewer loop-gap] ${JSON.stringify({ role: "runtime-host", pid: 42, utc: new Date(at).toISOString(), gapMs: gap, logDropped: 0, ...extra })}`;

const failurePhase = "reading structured startup registry";
const nextRetryAt = "2026-11-28T08:14:05.000Z";
const retryCategory = "registry-contention";
const capability = (state: "pending" | "failed" | "ready", failureCategory: string | null, retryAt: string | null) =>
  Response.json({ capability: "viewer-deployments", version: 1, structuredHostStartup: {
    state, phase: failurePhase, completedHosts: 0, totalHosts: null, failurePhase, failureCategory, nextRetryAt: retryAt,
  } });

test("browser startup waits through a scheduled and an executing retry", async () => {
  let probes = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/api/runtime/snapshot") return Response.json({ structuredStartup: "failed" });
    probes++;
    return capability(probes >= 3 ? "ready" : "failed", probes >= 3 ? null : retryCategory, probes === 1 ? nextRetryAt : null);
  } });
  try {
    expect(await waitForServerStartup(server.url.origin, 3_000)).toMatchObject({ state: "ready" });
    expect(probes).toBe(3);
  } finally { server.stop(true); }
});

test("a terminal startup refusal retains a bounded redacted excerpt in the gate report", async () => {
  let probes = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    probes++;
    return capability("failed", "configuration", null);
  } });
  const stderr = new PassThrough();
  const excerpt = captureBrowserStartupStderr(stderr);
  const secret = ["fictional", "credential", "value"].join("-");
  const privatePath = path.join("/", "home", "fictional-owner", "fixture", "state.sqlite");
  const url = new URL(`/callback?code=${secret}`, server.url).href;
  stderr.write("startup exception\n" + "Authori");
  stderr.write(`zation: Bearer ${secret}\n${JSON.stringify({ password: secret, path: privatePath, url })}\n`);
  stderr.write("-----BEGIN PRIVATE KEY-----\n" + secret + "\n" + "extra\n".repeat(2_000));
  stderr.end("\n-----END PRIVATE KEY-----\n");
  try {
    const startup = await waitForServerStartup(server.url.origin, 3_000);
    if (startup.state === "ready") throw new Error("terminal startup became ready");
    expect(probes).toBe(1);
    const error = new CandidateBrowserStartupError({ ...startup, stderr: excerpt() });
    const measured = passingCandidatePerformanceMeasurements();
    measured.browser = null;
    const serialized = CANDIDATE_PERFORMANCE_REPORT_PREFIX + JSON.stringify({
      checkedAt: "2026-11-28T08:14:00.000Z", runtime: `bun ${Bun.version}`,
      bounds: CANDIDATE_PERFORMANCE_BOUNDS, measurements: measured, breaches: [error.message], ok: false,
      browserStartupFailure: error.failure,
    });
    const report = parseCandidatePerformanceReport(serialized);
    expect(report).toMatchObject({ ok: false, browserStartupFailure: {
      reason: "terminal", state: "failed", failurePhase, failureCategory: "configuration", nextRetryAt: null,
    } });
    expect(report.browserStartupFailure?.stderr).toContain("startup exception");
    expect(report.browserStartupFailure?.stderr).toContain("[stderr clipped]");
    expect(report.browserStartupFailure!.stderr.length).toBeLessThanOrEqual(2048);
    for (const privateText of [secret, privatePath, "fictional-owner", server.url.host]) {
      expect(serialized).not.toContain(privateText);
    }
  } finally { server.stop(true); }
});

test("the startup deadline includes an unanswered HTTP body and retains the retry diagnostics", async () => {
  let probes = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    if (++probes === 1) return capability("failed", retryCategory, nextRetryAt);
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } }));
  } });
  try {
    expect(await waitForServerStartup(server.url.origin, 1_500)).toEqual({
      reason: "deadline", state: "failed", failurePhase, failureCategory: retryCategory, nextRetryAt,
    });
    expect(probes).toBe(2);
  } finally { server.stop(true); }
}, 3_000);

test("an exited browser server ends startup polling with the last observed phase", async () => {
  const gone = new AbortController();
  const reached = Promise.withResolvers<void>();
  let probes = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    if (++probes === 2) reached.resolve();
    return capability("pending", null, null);
  } });
  try {
    const waiting = waitForServerStartup(server.url.origin, 10_000, gone.signal);
    await reached.promise;
    gone.abort();
    expect(await waiting).toMatchObject({ reason: "server-exit", state: "pending", failurePhase });
  } finally { server.stop(true); }
});

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

test.each([
  ["pid", { pid: undefined }],
  ["role", { role: undefined }],
])("a valid host summary does not mask a gap missing %s", (_field, identity) => {
  const records = candidateHostLoopRecords();
  records.read(line(800, 4000, identity), 42);
  records.read(`[performance summary] ${JSON.stringify({ role: "runtime-host", pid: 42, utc: new Date(60000).toISOString(), logDropped: 0 })}`, 42);
  const reading = records.window(1000, 76000);
  expect(reading).toEqual({ records: 1, malformed: 1, maxMs: 0 });

  const measured = passingCandidatePerformanceMeasurements();
  measured.hostLoop = reading;
  const report = candidatePerformanceEvidence({ checkedAt: "2026-10-01T00:00:00.000Z", runtime: `bun ${Bun.version}`,
    bounds: CANDIDATE_PERFORMANCE_BOUNDS, measurements: measured, breaches: [], ok: true });
  expect(report.ok).toBe(false);
  expect(report.detail).toContain("malformed");
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
