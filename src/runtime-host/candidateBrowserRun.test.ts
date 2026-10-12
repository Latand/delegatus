import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { candidateBrowserBreaches } from "./candidateBrowser";
import { candidateBrowserExecutable, measureBoardInBrowser } from "./candidateBrowserRun";
import { candidatePerformanceBreaches, CANDIDATE_PERFORMANCE_BOUNDS, type CandidatePerformanceEvidence } from "./candidatePerformance";
import { ViewerDeploymentCoordinator } from "./deployment";
import { HostCommandViewerDeploymentAdapter } from "./deploymentAdapter";
import { passingCandidatePerformanceMeasurements } from "./fixtures/candidatePerformanceMeasurements";
import { FakeDeploymentAdapter, healthy } from "./fixtures/fakeDeploymentAdapter";
import { RuntimeJournal } from "./journal";

/* #2761: the gate's browser helper, driven against a board that is fast in
   every way but one. The page polls `/api/files`, asks for its host targets
   and its runtime snapshot once, and holds an event stream open, as the board
   does. Clean, it passes; with `/api/tmux/targets` never answering, or
   `/api/runtime/snapshot` answering 503, the same helper refuses it, and that
   verdict carried through the real host-command adapter and the coordinator
   retires the candidate while the serving release keeps serving. Needs a
   Chromium (`CHROME_BIN` or the image's own). */

const browser = candidateBrowserExecutable();
const WINDOW_MS = 12_000;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-candidate-browser-"));
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

type Fault = "none" | "stalled-targets" | "snapshot-503";

const PAGE = `<!doctype html><html><body>
<div data-kanban-board><div data-kanban-card>Synthetic conversation 1</div></div>
<script>
  const files = () => fetch("/api/files?view=summary").catch(() => {});
  files();
  setInterval(files, 2000);
  fetch("/api/tmux/targets", { method: "POST", headers: { "content-type": "application/json" }, body: "{\\"reqs\\":[]}" }).catch(() => {});
  fetch("/api/runtime/snapshot").catch(() => {});
  new EventSource("/api/streams");
</script></body></html>`;

function serveBoard(fault: Fault) {
  const streams: ReadableStreamDefaultController[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    /* A stalled request stays open until the page gives up, never the server. */
    idleTimeout: 0,
    fetch(request) {
      const route = new URL(request.url).pathname;
      if (route === "/") return new Response(PAGE, { headers: { "content-type": "text/html" } });
      if (route === "/api/files") return Response.json({ files: [] });
      if (route === "/api/tmux/targets") return fault === "stalled-targets" ? new Promise<Response>(() => {}) : Response.json({ targets: {} });
      if (route === "/api/runtime/snapshot") return fault === "snapshot-503" ? Response.json({ error: "runtime host is unavailable" }, { status: 503 }) : Response.json({ sessions: [] });
      if (route === "/api/streams") {
        return new Response(new ReadableStream({ start(controller) { streams.push(controller); controller.enqueue(new TextEncoder().encode(": open\n\n")); } }), {
          headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/* The two writers the helper starts, each answering thirty quick writes once told to stop. */
const writer = path.join(directory, "writer.ts");
fs.writeFileSync(writer, `const stop = process.argv[process.argv.indexOf("--stop") + 1];
while (!(await Bun.file(stop).exists())) await Bun.sleep(50);
console.log(JSON.stringify({ latencies: Array.from({ length: 30 }, () => 2), failures: 0 }));
`);

async function measure(fault: Fault) {
  const board = serveBoard(fault);
  try {
    return await measureBoardInBrowser({
      baseUrl: board.url,
      executablePath: browser,
      pins: Array.from({ length: 8 }, () => ({ path: "/sessions/1.jsonl", conversationId: "one", title: "Synthetic conversation 1" })),
      writers: {
        runtime: process.execPath, entry: writer, cwd: directory, env: { ...process.env },
        registry: path.join(directory, "registry.sqlite"), keys: [], stopFile: path.join(directory, `${fault}-stop`),
      },
      windowMs: WINDOW_MS,
    });
  } finally {
    board.stop();
  }
}

async function refusedThroughCoordinator(measurements: NonNullable<CandidatePerformanceEvidence["measurements"]>) {
  const breaches = candidatePerformanceBreaches(measurements);
  const performance: CandidatePerformanceEvidence = {
    checkedAt: "2026-10-12T00:00:00.000Z", runtime: `bun ${Bun.version}`, bounds: CANDIDATE_PERFORMANCE_BOUNDS,
    measurements, breaches, ok: breaches.length === 0, ...(breaches.length ? { detail: breaches[0] } : {}),
  };
  const store = new RuntimeJournal(path.join(fs.mkdtempSync(path.join(directory, "journal-")), "runtime.sqlite"), { now: () => 1_000 });
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
      performance,
    } : {}));
    adapter.verifyCandidate = async (candidate) => host.verifyCandidate(candidate);
    const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });
    const receipt = await coordinator.requestViewerDeployment({ idempotencyKey: `deploy-browser-${breaches.length}-${Date.now()}` });
    if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
    const status = await coordinator.waitForDeployment(receipt.deploymentId);
    return {
      status,
      promoted: adapter.calls.filter((call) => call.startsWith("promote:") || call.startsWith("rollback:")),
      retired: adapter.calls.includes(`retire:${status?.candidate?.container}`),
      servingKept: JSON.stringify(adapter.current) === JSON.stringify(serving),
    };
  } finally {
    store.close();
  }
}

test.skipIf(!browser)("a board fast in every way passes the browser bounds", async () => {
  const result = await measure("none");
  expect(candidateBrowserBreaches(result.measurements)).toEqual([]);
  expect(result.measurements).toMatchObject({ apiErrors: 0, apiFirstError: null, apiUnfinished: 0 });
}, 120_000);

test.skipIf(!browser)("a side request left unanswered past the bound refuses the candidate and keeps the serving release", async () => {
  const result = await measure("stalled-targets");
  const breaches = candidateBrowserBreaches(result.measurements);
  expect(breaches).toHaveLength(1);
  expect(breaches[0]).toMatch(/^browser \/api\/tmux\/targets \(unanswered\) \d+ms exceeds 10000ms$/);
  expect(result.measurements.apiUnfinished).toBe(8);
  const outcome = await refusedThroughCoordinator({ ...passingCandidatePerformanceMeasurements(), browser: result.measurements });
  expect(outcome.status).toMatchObject({ phase: "failed", terminal: true });
  expect(outcome.status?.error).toContain("browser /api/tmux/targets (unanswered)");
  expect(outcome).toMatchObject({ promoted: [], retired: true, servingKept: true });
}, 120_000);

test.skipIf(!browser)("a side request answered 503 refuses the candidate and keeps the serving release", async () => {
  const result = await measure("snapshot-503");
  expect(candidateBrowserBreaches(result.measurements)).toEqual(["8 other browser API request(s) failed, first /api/runtime/snapshot HTTP 503"]);
  const outcome = await refusedThroughCoordinator({ ...passingCandidatePerformanceMeasurements(), browser: result.measurements });
  expect(outcome.status).toMatchObject({ phase: "failed", terminal: true });
  expect(outcome.status?.error).toContain("8 other browser API request(s) failed, first /api/runtime/snapshot HTTP 503");
  expect(outcome).toMatchObject({ promoted: [], retired: true, servingKept: true });
}, 120_000);
