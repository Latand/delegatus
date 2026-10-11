import { expect, test } from "bun:test";
import path from "node:path";

import { CANDIDATE_PERFORMANCE_REPORT_PREFIX, parseCandidatePerformanceReport, type CandidatePerformanceEvidence } from "./candidatePerformance";

/* #2761: the gate's runner, run the way `verify-candidate` runs it, against
   the synthetic registry of retained history: first boot, warm operation with
   two writers and eight board scopes, and a successor release opening the same
   registry. The runner owns its whole sandbox; nothing here touches the
   operator's state. */

async function runGate(args: string[]): Promise<{ code: number; report: CandidatePerformanceEvidence }> {
  /* The gate acts as a Viewer, so its projection worker runs as in production. */
  const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: undefined };
  const child = Bun.spawn([process.execPath, "run", path.join(import.meta.dir, "candidatePerformanceRun.ts"), ...args], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (!stdout.includes(CANDIDATE_PERFORMANCE_REPORT_PREFIX)) throw new Error(`the gate printed no report (exit ${code}): ${stderr.slice(-2_000)}`);
  return { code, report: parseCandidatePerformanceReport(stdout) };
}

/** The invariants a slow candidate must still keep: speed is the only thing it may lose. */
function expectHistoryIntact(report: CandidatePerformanceEvidence): void {
  const measured = report.measurements!;
  expect(measured.grantWrites.mismatches + measured.externalWrites.mismatches + measured.handover.grantMismatches).toBe(0);
  expect(measured.grantWrites.failures + measured.externalWrites.failures).toBe(0);
  expect(measured.sqliteBusy).toBe(0);
  expect(measured.runtimeTimeouts).toBe(0);
  expect(measured.worker).toMatchObject({ timeoutRetirements: 0, pidStable: true });
  expect(measured.deliveryEvidence).toMatchObject({ pending: 16, uncertain: 8, preserved: true });
  expect(measured.activeWorkers).toMatchObject({ entries: 24, preserved: true });
  expect(measured.scopeRequests).toMatchObject({ scopes: 8, failures: 0, refused: 0, expired: 0 });
  expect(measured.stableProjection).toBe(true);
}

test("the candidate gate passes the current code over thirty thousand rows of retained history", async () => {
  const { code, report } = await runGate([]);
  if (!report.ok) console.error(JSON.stringify(report, null, 2));
  const measured = report.measurements!;
  expect(measured.dataset.rows).toBeGreaterThan(29_000);
  expect(measured.dataset.coldRows / measured.dataset.rows).toBeGreaterThan(0.9);
  /* First boot upgraded the previous release's schema and built a projection. */
  expect(measured.firstBoot.coldProjectionMs).toBeGreaterThan(0);
  /* Warm operation measured real traffic on every surface. */
  expect(measured.grantWrites.count).toBeGreaterThan(50);
  expect(measured.externalWrites.count).toBeGreaterThan(50);
  expect(measured.keyedOperationReads.count).toBeGreaterThan(20);
  expect(measured.projection.warmBuilds.count).toBeGreaterThan(8);
  /* Handover: the successor archived the hot tail and decided the same grants. */
  expect(measured.handover.successorArchived).toBeGreaterThan(0);
  expectHistoryIntact(report);
  expect(report.breaches).toEqual([]);
  expect({ code, ok: report.ok }).toEqual({ code: 0, ok: true });
}, 280_000);

test("an induced slow candidate is refused with the bounds it breached", async () => {
  const { code, report } = await runGate(["--scale", "0.1", "--induce-slow-ms", "600"]);
  expect(code).toBe(1);
  expect(report.ok).toBe(false);
  expect(report.inducedDelayMs).toBe(600);
  expect(report.breaches).toEqual(expect.arrayContaining([
    expect.stringMatching(/^grant-bearing write p95 \d+(\.\d+)?ms exceeds 350ms$/),
    expect.stringMatching(/^grant-bearing write max \d+(\.\d+)?ms exceeds 500ms$/),
    expect.stringMatching(/^Viewer event-loop delay p95 \d+(\.\d+)?ms exceeds 50ms$/),
  ]));
  expectHistoryIntact(report);
}, 200_000);
