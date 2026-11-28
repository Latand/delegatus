import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { candidateHostLoopRecords, startCandidateRuntimeHost, waitForServerStartup } from "./candidateRuntimeHost";
import { candidatePerformanceEvidence, CANDIDATE_PERFORMANCE_BOUNDS, CANDIDATE_PERFORMANCE_REPORT_PREFIX, parseCandidatePerformanceReport } from "./candidatePerformance";
import { passingCandidatePerformanceMeasurements } from "./fixtures/candidatePerformanceMeasurements";

const line = (gap: number, at: number, extra = {}) => `[viewer loop-gap] ${JSON.stringify({ role: "runtime-host", pid: 42, utc: new Date(at).toISOString(), gapMs: gap, logDropped: 0, ...extra })}`;

const failurePhase = "reading structured startup registry";
const nextRetryAt = "2026-11-28T08:14:05.000Z";
const retryCategory = "registry-contention";
const capability = (state: "pending" | "failed", failureCategory: string | null, retryAt: string | null) =>
  Response.json({ capability: "viewer-deployments", version: 1, structuredHostStartup: {
    state, phase: failurePhase, completedHosts: 0, totalHosts: null,
    failurePhase, failureCategory, nextRetryAt: retryAt,
  } });
async function startupServer(mode: "terminal" | "hanging-body" | "retry-ready") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-startup-server-"));
  const stderrGateFile = path.join(directory, "write-stderr");
  const stderrWrittenFile = path.join(directory, "stderr-written");
  const child = spawn(process.execPath, ["run", path.join(import.meta.dir, "candidateStartupServer.fixture.ts"), mode, stderrGateFile, stderrWrittenFile], {
    cwd: path.resolve(import.meta.dir, "../.."), env: process.env, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  const origin = await new Promise<string>((resolve, reject) => {
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline >= 0) resolve(stdout.slice(0, newline).trim());
    });
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`startup fixture exited before listening (${code}): ${stdout}`)));
  });
  if (!origin.startsWith("http://127.0.0.1:")) throw new Error("startup fixture did not publish its port");
  return { origin, stderr: child.stderr!, emitStartupStderr() { fs.writeFileSync(stderrGateFile, "1"); },
    async waitForStartupStderr() {
      const deadline = performance.now() + 2_000;
      while (!fs.existsSync(stderrWrittenFile) && performance.now() < deadline) await Bun.sleep(5);
      if (!fs.existsSync(stderrWrittenFile)) throw new Error("startup fixture did not write stderr");
      await Bun.sleep(10);
    },
    async stop() {
    child.kill("SIGTERM");
    await new Promise<void>(resolve => child.once("exit", () => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  } };
}

async function runBrowserRefusalProbe(mode: "terminal" | "terminal-interrupted") {
  const child = Bun.spawn([process.execPath, "run", path.join(import.meta.dir, "candidatePerformanceRun.ts"),
    "--probe-browser-refusal", mode], {
    cwd: path.resolve(import.meta.dir, "../.."), env: { ...process.env }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (!stdout.includes(CANDIDATE_PERFORMANCE_REPORT_PREFIX)) {
    throw new Error(`candidate runner emitted no refusal report (exit ${code}): ${stderr.slice(-2_000)}`);
  }
  return { code, serialized: stdout, report: parseCandidatePerformanceReport(stdout) };
}

test("browser startup waits through a scheduled and an executing retry", async () => {
  const server = await startupServer("retry-ready");
  try {
    expect(await waitForServerStartup(server.origin, 3_000)).toMatchObject({ state: "ready" });
  } finally { await server.stop(); }
});

test.each(["terminal", "terminal-interrupted"] as const)("production browser startup refusal redacts encoded private-key material: %s", async mode => {
    const result = await runBrowserRefusalProbe(mode);
    const report = result.report;
    expect(result.code).toBe(1);
    expect(report).toMatchObject({ ok: false, browserStartupFailure: {
      reason: "terminal", state: "failed", failurePhase, failureCategory: "configuration", nextRetryAt: null,
    } });
    expect(report.browserStartupFailure?.stderr).toContain("startup exception");
    expect(report.browserStartupFailure?.stderr).toContain("Authorization: [redacted]");
    expect(report.browserStartupFailure?.stderr).toContain("[redacted]");
    expect(report.browserStartupFailure!.stderr.length).toBeLessThanOrEqual(2048);
    for (const privateText of ["fixture marker value", "fixture-private-key-payload", "PRIVATE KEY"]) {
      expect(result.serialized).not.toContain(privateText);
    }
});

test("the startup deadline includes an unanswered HTTP body from an independent server process", async () => {
  const server = await startupServer("hanging-body");
  try {
    expect(await waitForServerStartup(server.origin, 1_500)).toEqual({
      reason: "deadline", state: "failed", failurePhase, failureCategory: retryCategory, nextRetryAt,
    });
  } finally { await server.stop(); }
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
