import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { buildPipeline, savePipelines, withPipelineMutation } from "./store";
import { tickPipelines, defaultPipelinePorts } from "./engine";
import { viewerLoopMonitor } from "@/lib/viewerLoopMonitor";

// Opt in with a numeric shape manifest: collection, state, bytes, attempts[].
// The manifest contains no record content and may describe another installation.
test.skipIf(!process.env.LLV_CONTROLLER_LEASE_SHAPE && process.env.LLV_CONTROLLER_LEASE_REPRO !== "1")("production-shaped evidence reads leave the controller lease free", async () => {
  const shape = JSON.parse(fs.readFileSync(process.env.LLV_CONTROLLER_LEASE_SHAPE ?? path.join(import.meta.dir, "fixtures/controllerLeaseShape.json"), "utf8")) as Array<{
    collection: string; state: string; bytes: number; attempts: number[];
  }>;
  const startedAt = "2026-10-14T00:00:00.000Z";
  const transcriptRoot = path.join(process.env.LLV_STATE_DIR!, "synthetic-transcripts");
  const records = shape.map((row, index) => {
    const lane = buildPipeline({ id: `synthetic-${index}`, task: "Synthetic controller evidence", project: "fixture", repoDir: "/repo",
      stages: row.attempts.map((_, n) => ({ id: `stage-${n}`, kind: "run" as const, prompt: "Build", next: null,
        effectiveRole: { roleId: null, engine: "codex" as const, model: null, effort: null, access: "read-write" as const, promptScaffold: null } })),
      srcPath: null, srcConversationId: null, now: startedAt, state: "draft" });
    lane.state = row.collection === "pipelines" ? row.state as typeof lane.state : "closed";
    row.attempts.forEach((count, n) => {
      for (let a = 0; a < count; a++) lane.runs[n]!.attempts.push({
        n: a + 1, state: "passed", effectiveRole: lane.stages[n]!.effectiveRole, historical: true,
        launchId: null, conversationId: null, sessionId: null, agentPath: null, paneId: null, flowId: null,
        startedAt, completedAt: startedAt, input: null, activatedBy: null, output: null, verdict: { status: "pass", findings: [] }, error: null,
      });
    });
    if (row.collection === "pipelines" && ["running", "needs_decision"].includes(row.state)) {
      const stage = lane.stages[0]!;
      const attempt = lane.runs[0]!.attempts.at(-1)!;
      const transcript = path.join(transcriptRoot, `controller-${index}.jsonl`);
      fs.mkdirSync(path.dirname(transcript), { recursive: true });
      const timestamp = new Date(Date.now() - 60_000).toISOString();
      const reasoning = "synthetic retained evidence ".repeat(Math.max(1, Math.floor(row.bytes / 80)));
      fs.writeFileSync(transcript, [
        JSON.stringify({ timestamp, type: "session_meta", payload: { id: `session-${index}` } }),
        JSON.stringify({ timestamp, type: "event_msg", payload: { type: "task_started" } }),
        JSON.stringify({ timestamp, type: "response_item", payload: { type: "reasoning", text: reasoning } }),
      ].join("\n") + "\n");
      attempt.state = "running";
      attempt.historical = true;
      attempt.agentPath = transcript;
      attempt.startedAt = timestamp;
      lane.cursor = { stageId: stage.id, state: "running", input: null, activatedBy: null };
    }
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
  const leaseOperations = new Set<string>();
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
    const basePorts = defaultPipelinePorts();
    const baseEvidence = basePorts.durableTurnEvidence;
    let evidenceReads = 0;
    const evidenceOperationScopes = new Set<string>();
    const ports = {
      ...basePorts,
      durableTurnEvidence: async (...args: Parameters<typeof baseEvidence>) => {
        evidenceReads++;
        const operation = viewerLoopMonitor.current();
        if (operation) evidenceOperationScopes.add(operation);
        const result = await baseEvidence(...args);
        await new Promise(resolve => setTimeout(resolve, 150));
        return result;
      },
    };
    await tickPipelines([], ports);
    clearInterval(contend);
    await writer;
    await new Promise(resolve => setTimeout(resolve, 20));
    // Retain production diagnostics alongside complete checkpoint timings.
    for (const line of logs) if (line.startsWith("[state lease-hold]")) {
      const hold = JSON.parse(line.slice("[state lease-hold] ".length)) as { heldMs: number; operation: string };
      holds.push(hold.heldMs);
      leaseOperations.add(hold.operation);
    }
    longestHoldMs = Math.max(0, ...holds);
    const loopOperations = logs.flatMap(line => {
      if (!line.startsWith("[viewer loop-gap] ")) return [];
      return (JSON.parse(line.slice("[viewer loop-gap] ".length)) as { operations: Array<{ name: string; durationMs: number }> }).operations;
    });
    console.log("CONTROLLER_LEASE_REPRO", JSON.stringify({ records: records.length,
      attempts: shape.reduce((n, row) => n + row.attempts.reduce((a, b) => a + b, 0), 0),
      evidenceReads, longestHoldMs, longestGapMs: Math.round(longestGapMs), writerRefusals, writerAdmissions,
      evidenceOperationScopes: [...evidenceOperationScopes], leaseOperations: [...leaseOperations], loopOperations,
      longestWriterMs: Math.round(longestWriterMs), leaseRows: db.query("SELECT count(*) AS n FROM state_leases").get() }));
    expect(longestHoldMs).toBeLessThan(200);
    expect(writerRefusals).toBe(0);
    expect(writerAdmissions).toBeGreaterThan(0);
    expect(longestWriterMs).toBeLessThan(1000);
    expect(evidenceReads).toBeGreaterThan(0);
    expect(evidenceOperationScopes.has("pipelines.controller-mutation")).toBe(true);
  } finally {
    clearInterval(contend); await writer;
    clearInterval(poll); viewerLoopMonitor.stop(); console.warn = original; db.close();
    if (previousWait === undefined) delete process.env.LLV_PIPELINE_LOCK_WAIT_MS;
    else process.env.LLV_PIPELINE_LOCK_WAIT_MS = previousWait;
  }
}, 120_000);
