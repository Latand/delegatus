import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { buildPipeline, loadPipelinesForStartupAsync, pipelineRegistryHealthAsync, savePipelines, withPipelineControllerMutation, withPipelineMutation } from "./store";
import { viewerLoopMonitor, withViewerOperation } from "@/lib/viewerLoopMonitor";

// Opt in with a numeric shape manifest: collection, state, bytes, attempts[].
// The manifest contains no record content and may describe another installation.
test.skipIf(!process.env.LLV_CONTROLLER_LEASE_SHAPE && process.env.LLV_CONTROLLER_LEASE_REPRO !== "1")("production-shaped evidence reads leave the controller lease free", async () => {
  const shape = JSON.parse(fs.readFileSync(process.env.LLV_CONTROLLER_LEASE_SHAPE ?? path.join(import.meta.dir, "fixtures/controllerLeaseShape.json"), "utf8")) as Array<{
    collection: string; state: string; bytes: number; attempts: number[];
  }>;
  const startedAt = "2026-10-14T00:00:00.000Z";
  const records = shape.map((row, index) => {
    const lane = buildPipeline({ id: `synthetic-${index}`, task: "Synthetic controller evidence", project: "fixture", repoDir: "/repo",
      stages: row.attempts.map((_, n) => ({ id: `stage-${n}`, kind: "run" as const, prompt: "Build", next: null,
        effectiveRole: { roleId: null, engine: "codex" as const, model: null, effort: null, access: "read-write" as const, promptScaffold: null } })),
      srcPath: null, srcConversationId: null, now: startedAt, state: "draft" });
    lane.state = "paused";
    row.attempts.forEach((count, n) => {
      for (let a = 0; a < count; a++) lane.runs[n]!.attempts.push({
        n: a + 1, state: "passed", effectiveRole: lane.stages[n]!.effectiveRole, historical: true,
        launchId: null, conversationId: null, sessionId: null, agentPath: null, paneId: null, flowId: null,
        startedAt, completedAt: startedAt, input: null, activatedBy: null, output: null, verdict: { status: "pass", findings: [] }, error: null,
      });
    });
    if (["closed", "completed"].includes(row.state)) {
      lane.state = "closed"; lane.cursor = null; lane.closedAt = startedAt;
    }
    lane.spec = "x".repeat(Math.max(0, row.bytes - Buffer.byteLength(JSON.stringify(lane))));
    return lane;
  });
  const root = process.env.LLV_STATE_DIR!;
  fs.writeFileSync(path.join(root, "pipelines-archive.json"), JSON.stringify({ schemaVersion: 5,
    pipelines: records.filter((_, i) => shape[i]!.collection === "pipelines_archive") }));
  savePipelines(records.filter((_, i) => shape[i]!.collection === "pipelines"));
  const holds: number[] = [];
  const original = console.warn;
  const logs: string[] = [];
  console.warn = (...args) => { logs.push(args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")); original(...args); };
  let last = performance.now();
  let longestGapMs = 0;
  let longestHoldMs = 0;
  let writer: Promise<void> | null = null;
  let writerRefusals = 0;
  let writerAdmissions = 0;
  let longestWriterMs = 0;
  const previousWait = process.env.LLV_PIPELINE_LOCK_WAIT_MS;
  process.env.LLV_PIPELINE_LOCK_WAIT_MS = "100";
  const db = new Database(path.join(root, "state.sqlite"), { readonly: true });
  const poll = setInterval(() => {
    const now = performance.now(); longestGapMs = Math.max(longestGapMs, now - last - 10); last = now;
  }, 10);
  const contend = setInterval(() => {
    if (writer) return;
    const start = performance.now();
    // Exercise real writer admission without invalidating the evidence read.
    writer = withPipelineMutation(() => { writerAdmissions++; })
      .catch(() => { writerRefusals++; })
      .finally(() => { longestWriterMs = Math.max(longestWriterMs, performance.now() - start); writer = null; });
  }, 50);
  viewerLoopMonitor.start();
  try {
    await withViewerOperation("controller.pipelines", () => withPipelineControllerMutation(async (lanes, persist) => {
      for (const lane of lanes) {
        // These are the real complete active/archive readers used by startup.
        // Repeat per lane, as independent host recovery can request evidence.
        await loadPipelinesForStartupAsync();
        await pipelineRegistryHealthAsync();
        lane.stateDetail = "evidence inspected";
        persist([lane]);
      }
    }, heldMs => { holds.push(heldMs); }));
    clearInterval(contend);
    await writer;
    await new Promise(resolve => setTimeout(resolve, 20));
    // Retain production diagnostics alongside complete checkpoint timings.
    for (const line of logs) if (line.startsWith("[state lease-hold]")) {
      holds.push((JSON.parse(line.slice("[state lease-hold] ".length)) as { heldMs: number }).heldMs);
    }
    longestHoldMs = Math.max(0, ...holds);
    console.log("CONTROLLER_LEASE_REPRO", JSON.stringify({ records: records.length,
      attempts: shape.reduce((n, row) => n + row.attempts.reduce((a, b) => a + b, 0), 0),
      longestHoldMs, longestGapMs: Math.round(longestGapMs), writerRefusals, writerAdmissions,
      longestWriterMs: Math.round(longestWriterMs), leaseRows: db.query("SELECT count(*) AS n FROM state_leases").get() }));
    expect(longestHoldMs).toBeLessThan(200);
    expect(writerRefusals).toBe(0);
    expect(writerAdmissions).toBeGreaterThan(0);
    expect(longestWriterMs).toBeLessThan(1000);
  } finally {
    clearInterval(contend); await writer;
    clearInterval(poll); viewerLoopMonitor.stop(); console.warn = original; db.close();
    if (previousWait === undefined) delete process.env.LLV_PIPELINE_LOCK_WAIT_MS;
    else process.env.LLV_PIPELINE_LOCK_WAIT_MS = previousWait;
  }
}, 120_000);
