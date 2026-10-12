import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CANDIDATE_PERFORMANCE_REPORT_PREFIX, parseCandidatePerformanceReport, type CandidatePerformanceEvidence } from "./candidatePerformance";
import { HostCommandViewerDeploymentAdapter } from "./deploymentAdapter";

/* #2761: the gate's runner, run the way `verify-candidate` runs it, against
   the synthetic registry of retained history: two Viewer releases, live
   workers handed from one to the other, two writers and eight board scopes.
   The runner owns its whole sandbox; nothing here touches the operator's
   state. The refusals run at a tenth of the dataset, which is never a pass. */

async function runGate(args: string[], env: Record<string, string> = {}): Promise<{ code: number; report: CandidatePerformanceEvidence; stdout: string }> {
  /* The gate acts as a Viewer, so its projection worker runs as in production. */
  const child = Bun.spawn([process.execPath, "run", path.join(import.meta.dir, "candidatePerformanceRun.ts"), ...args], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: { ...process.env, NODE_ENV: undefined, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (!stdout.includes(CANDIDATE_PERFORMANCE_REPORT_PREFIX)) throw new Error(`the gate printed no report (exit ${code}): ${stderr.slice(-2_000)}`);
  return { code, report: parseCandidatePerformanceReport(stdout), stdout };
}

/** What a refused candidate must still keep: speed and its own release are the only things it may lose. */
function expectEvidenceIntact(report: CandidatePerformanceEvidence): void {
  const measured = report.measurements!;
  expect(measured.grantWrites.mismatches + measured.externalWrites.mismatches).toBe(0);
  expect(measured.sqliteBusy).toBe(0);
  expect(measured.deliveryEvidence).toMatchObject({ pending: 16, uncertain: 8, preserved: true });
  expect(measured.stability).toMatchObject({ emptyResponses: 0, missingRows: 0, extraRows: 0, reattributedRows: 0, missingPins: 0 });
  expect(measured.stability.rounds).toBeGreaterThanOrEqual(8);
}

/* The full verdict: three minutes of a loaded machine's CPU, and the same run
   `verify-candidate` makes inside the candidate image before promotion. Run
   it with LLV_CANDIDATE_PERFORMANCE_FULL=1, or `bun scripts/verify-viewer-runtime.ts --performance`. */
test.skipIf(process.env.LLV_CANDIDATE_PERFORMANCE_FULL !== "1")("the candidate gate passes the current code over thirty thousand rows of retained history", async () => {
  const { code, report } = await runGate([]);
  if (!report.ok) console.error(JSON.stringify(report, null, 2));
  const measured = report.measurements!;
  expect(measured.dataset.rows).toBeGreaterThan(29_000);
  expect(measured.handover).toMatchObject({ switched: true, demotionExitCode: 0, servingRelease: "successor", serving: { failures: 0 } });
  expect(measured.workers).toMatchObject({ count: 4, rehosted: 4, answering: 4, lostProgress: 0, repeatedProgress: 0, failedPings: 0 });
  expectEvidenceIntact(report);
  expect(report.breaches).toEqual([]);
  expect({ code, ok: report.ok }).toEqual({ code: 0, ok: true });
}, 600_000);

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
  expectEvidenceIntact(report);
}, 400_000);

/* The reviewer's reproduction: a successor that exits 7 without a word. The
   gate refuses it, the serving target never moves, the incumbent keeps
   serving the board and hosting its workers, and the deployment adapter reads
   the refusal into the candidate's health evidence. */
test("a successor release that exits without its report is refused while the serving release keeps serving", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-candidate-performance-shim-"));
  try {
    const shim = path.join(directory, "bun-shim.sh");
    fs.writeFileSync(shim, `#!/bin/sh
case " $* " in
  *" --viewer "*" --name b "*) exit 7 ;;
esac
exec "${process.execPath}" "$@"
`, { mode: 0o755 });
    const { code, stdout, report } = await runGate(["--scale", "0.1"], { LLV_CANDIDATE_PERFORMANCE_BIN: shim });
    expect(code).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.breaches).toEqual(expect.arrayContaining([
      "the successor release did not complete (exit 7)",
      "the serving target never moved to the successor",
      "4 of 4 live worker(s) were not re-hosted by the successor",
    ]));
    const measured = report.measurements!;
    expect(measured.handover).toMatchObject({
      successor: { completed: false, exitCode: 7, adopted: 0 },
      switched: false,
      demotionExitCode: null,
      servingRelease: "incumbent",
      serving: { failures: 0 },
    });
    expect(measured.handover.serving.requests).toBeGreaterThan(0);
    /* The incumbent was never demoted: its workers kept answering throughout. */
    expect(measured.workers).toMatchObject({ count: 4, rehosted: 0, answering: 4, lostProgress: 0, failedPings: 0 });
    expectEvidenceIntact(report);

    /* The same output, read the way the deployment adapter reads verify-candidate. */
    const candidate = { image: "viewer:test", container: "viewer-candidate", endpoint: "http://127.0.0.1:19312", revision: "a".repeat(40) };
    const adapter = new HostCommandViewerDeploymentAdapter(async (action) => (action === "verify-candidate" ? {
      checkedAt: "2026-10-12T00:00:00.000Z",
      endpoint: candidate.endpoint,
      processReady: true,
      rootStatus: 200,
      authenticatedStatus: 200,
      unauthorizedStatus: 403,
      assets: [],
      performance: parseCandidatePerformanceReport(stdout),
      ok: true,
    } : {}));
    const evidence = await adapter.verifyCandidate(candidate);
    expect(evidence.ok).toBe(false);
    expect(evidence.performance?.breaches).toContain("the successor release did not complete (exit 7)");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 400_000);

test("a live worker killed after the hand-over is refused", async () => {
  const { code, report } = await runGate(["--scale", "0.1", "--induce", "worker-kill"]);
  expect(code).toBe(1);
  expect(report.ok).toBe(false);
  expect(report.induced).toEqual(["worker-kill"]);
  expect(report.breaches).toEqual(expect.arrayContaining([
    "1 of 4 live worker(s) were not re-hosted by the successor",
    "1 of 4 live worker(s) stopped answering",
    expect.stringMatching(/^\d+ live-worker ping\(s\) went unanswered outside the transition$/),
  ]));
  expect(report.measurements!.handover).toMatchObject({ switched: true, demotionExitCode: 0, servingRelease: "successor" });
  expectEvidenceIntact(report);
}, 400_000);
