import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { candidateBrowserExecutable } from "./candidateBrowserRun";
import { CANDIDATE_PERFORMANCE_REPORT_PREFIX, parseCandidatePerformanceReport, type CandidatePerformanceEvidence } from "./candidatePerformance";
import { ViewerDeploymentCoordinator } from "./deployment";
import { HostCommandViewerDeploymentAdapter } from "./deploymentAdapter";
import { FakeDeploymentAdapter, healthy } from "./fixtures/fakeDeploymentAdapter";
import { RuntimeJournal } from "./journal";

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

/* The full verdict: four minutes of a loaded machine's CPU, and the same run
   `verify-candidate` makes inside the candidate's gate image before
   promotion, browser views of the production build included. Run it with
   LLV_CANDIDATE_PERFORMANCE_FULL=1 after `bun run build`, with CHROME_BIN
   naming a Chromium, or `bun scripts/verify-viewer-runtime.ts --performance`. */
test.skipIf(process.env.LLV_CANDIDATE_PERFORMANCE_FULL !== "1")("the candidate gate passes the current code over thirty thousand rows of retained history", async () => {
  const { code, report } = await runGate([]);
  if (!report.ok) console.error(JSON.stringify(report, null, 2));
  const measured = report.measurements!;
  expect(measured.dataset.rows).toBeGreaterThan(29_000);
  expect(measured.handover).toMatchObject({ switched: true, demotionExitCode: 0, servingRelease: "successor", serving: { failures: 0 } });
  expect(measured.workers).toMatchObject({ count: 4, rehosted: 4, answering: 4, lostProgress: 0, repeatedProgress: 0, failedPings: 0 });
  expectEvidenceIntact(report);
  expect(measured.browser).toMatchObject({ views: 8, filesErrors: 0, selectionsLost: 0, staleNotices: 0, writes: { failures: 0 } });
  expect(measured.browser!.writes.count).toBeGreaterThanOrEqual(50);
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

/* The reviewer's reproduction of a stalled runtime host: every call the
   releases make through the production client goes unanswered for the whole
   warm operation. The client's own deadlines time them out, the gate counts
   each one, and the verdict, read by the real host-command adapter and acted
   on by the coordinator, retires the candidate: promote is never called and
   the serving release keeps serving. */
test("a runtime host that stops answering is refused through the adapter and the coordinator, and the serving release is kept", async () => {
  const { code, stdout, report } = await runGate(["--scale", "0.1", "--induce", "runtime-stall"]);
  expect(code).toBe(1);
  expect(report.ok).toBe(false);
  expect(report.induced).toEqual(["runtime-stall"]);
  const measured = report.measurements!;
  expect(measured.runtimeRpc.timeouts).toBeGreaterThan(0);
  expect(measured.runtimeTimeouts).toBe(measured.runtimeRpc.timeouts);
  expect(measured.runtimeRpc.hostAlive).toBe(true);
  const timeouts = `${measured.runtimeTimeouts} runtime timeout(s)`;
  expect(report.breaches).toContain(timeouts);
  expectEvidenceIntact(report);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-candidate-performance-coordinator-"));
  const store = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { now: () => 1_000 });
  try {
    const adapter = new FakeDeploymentAdapter();
    const serving = adapter.current;
    const host = new HostCommandViewerDeploymentAdapter(async (action) => (action === "verify-candidate" ? {
      ...healthy("http://127.0.0.1/candidate"),
      runtimeHost: {
        checkedAt: "2026-10-12T00:01:00.000Z",
        runtime: "bun 1.4.0",
        succession: { predecessorReadyMs: 1_480, successorTookOverMs: 2_140, completed: true },
        listener: { windowMs: 15_000, polls: 30, answered: 30, abandoned: 15 },
        socket: { polls: 30, answered: 30, abandoned: 15 },
        ok: true,
      },
      performance: parseCandidatePerformanceReport(stdout),
    } : {}));
    adapter.verifyCandidate = async (candidate) => {
      adapter.calls.push(`verify-candidate:${candidate.container}`);
      return host.verifyCandidate(candidate);
    };
    const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });
    const receipt = await coordinator.requestViewerDeployment({ idempotencyKey: "deploy-runtime-stall" });
    if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
    const status = await coordinator.waitForDeployment(receipt.deploymentId);
    expect(status).toMatchObject({ phase: "failed", terminal: true });
    expect(status?.error).toStartWith("candidate performance gate refused the release");
    expect(status?.health.at(-1)?.performance?.breaches).toContain(timeouts);
    expect(adapter.calls).toContain(`retire:${status?.candidate?.container}`);
    expect(adapter.calls.filter((call) => call.startsWith("promote:") || call.startsWith("rollback:"))).toEqual([]);
    expect(adapter.current).toEqual(serving);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 400_000);

/* The production server itself, held: `next start` over the gate's history
   with the event-loop probe preloaded, eight Chromium views and two writers,
   and its loop held once for 800 ms while the views operate. Nothing the page
   reads shows it; the server's own reading refuses the candidate. Needs the
   production build and a Chromium, as the full run does. */
const served = fs.existsSync(path.resolve(import.meta.dir, "../../.next/BUILD_ID")) && candidateBrowserExecutable() !== null;
test.skipIf(!served)("a production server held under the browser views is refused by its own event loop", async () => {
  const { code, report } = await runGate(["--scale", "0.1", "--induce", "server-stall"]);
  expect(code).toBe(1);
  expect(report.ok).toBe(false);
  expect(report.induced).toEqual(["server-stall"]);
  const browser = report.measurements!.browser!;
  expect(browser.views).toBe(8);
  expect(browser.server!.samples).toBeGreaterThan(1_000);
  expect(browser.server!.maxMs).toBeGreaterThanOrEqual(780);
  expect(report.breaches).toEqual(expect.arrayContaining([
    expect.stringMatching(/^server event-loop delay max under the browser views \d+(\.\d+)?ms exceeds 500ms$/),
  ]));
  expect(report.log?.some((line) => line.startsWith("induced: held the production server's event loop for 800ms"))).toBe(true);
  expectEvidenceIntact(report);
}, 600_000);
