/** Synthetic controller load: fixed ids, bounded ports, no operator data. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { Database } from "bun:sqlite";
import { buildPipeline, savePipelines, archiveSettledPipelines } from "../store";
import type { Pipeline, PipelineStageAttempt } from "../types";
import { defaultPipelinePorts } from "../engine";
import { tickPipelinesController } from "../controllerPass";
import { registerPipelineTick } from "../controllerSignal";
import { SqliteStateCollection, resetStateReadonlyConnectionCountForTests, stateReadonlyConnectionCountForTests } from "@/lib/state/sqliteStateStore";

export async function measureSeededController() {
  const root = process.env.AUDIT_RUN!;
  const startedUtc = new Date().toISOString();
  const now = Date.parse("2026-10-16T00:00:00Z");
  registerPipelineTick(async () => {});
  const role = { roleId: null, engine: "codex" as const, model: null, effort: null, access: "read-only" as const, promptScaffold: null };
  const record = (id: string, closed: boolean): Pipeline => {
    const lane = buildPipeline({ id, task: id, project: "fixture", repoDir: "/fixture/repository", publication: "internal",
      stages: [{ id: "build", kind: "run", prompt: "Build", next: null, effectiveRole: role }],
      srcPath: null, srcConversationId: null, now: new Date(now).toISOString() });
    lane.state = closed ? "closed" : "paused";
    lane.pausedState = closed ? null : "running";
    lane.closedAt = closed ? "2026-09-01T00:00:00Z" : null;
    lane.baseBranch = "main"; lane.baseRef = lane.lastPassedCommit = "a".repeat(40); lane.baseRefPinned = true;
    lane.cursor = closed ? null : { stageId: "build", state: "running", input: null, activatedBy: null };
    lane.runs[0]!.attempts = Array.from({ length: 16 }, (_, n): PipelineStageAttempt => ({
      n: n + 1, state: closed || n < 15 ? "failed" : "running", effectiveRole: role,
      historical: n < 15, launchId: null, conversationId: null, sessionId: null, agentPath: null, paneId: null, flowId: null,
      startedAt: new Date(now).toISOString(), completedAt: closed || n < 15 ? "2026-09-01T00:00:00Z" : null,
      input: null, activatedBy: null, output: "x".repeat(7_300), error: null,
      verdict: closed || n < 15 ? { status: "fail", findings: [] } : null,
    }));
    return lane;
  };
  savePipelines(Array.from({ length: 796 }, (_, i) => record(`archive-${i.toString().padStart(4,"0")}`, true)));
  await archiveSettledPipelines(now);
  savePipelines([...Array.from({ length: 30 }, (_, i) => record(`open-${i.toString().padStart(4,"0")}`, false)),
    ...Array.from({ length: 232 }, (_, i) => record(`retained-${i.toString().padStart(4,"0")}`, true))]);
  const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"));
  const corpus = db.query("SELECT collection,count(*) AS rows,sum(length(value_json)) AS bytes FROM state_rows WHERE collection IN ('pipelines','pipelines_archive') GROUP BY collection").all();
  const digest = crypto.createHash("sha256");
  for (const row of db.query<{ collection: string; row_key: string; value_json: string }, []>(
    "SELECT collection,row_key,value_json FROM state_rows WHERE collection IN ('pipelines','pipelines_archive') ORDER BY collection,row_key").iterate()) {
    digest.update(JSON.stringify([row.collection,row.row_key,row.value_json])).update("\n");
  }
  const seedSha256 = digest.digest("hex");
  const limits = [];
  const group = fs.readFileSync("/proc/self/cgroup","utf8").trim().split("\n").find(line => line.startsWith("0::"))?.slice(3);
  if (group) for (let dir = path.join("/sys/fs/cgroup",group), level = 0; dir.startsWith("/sys/fs/cgroup"); dir = path.dirname(dir), level++) {
    const read = (name: string) => { try { return fs.readFileSync(path.join(dir,name),"utf8").trim(); } catch { return null; } };
    const cpu = read("cpu.max"), memory = read("memory.max");
    if (cpu || memory) limits.push({ level,cpu,memory });
    if (dir === "/sys/fs/cgroup") break;
  }
  let clock = now;
  const ports = { ...defaultPipelinePorts(), now: () => new Date(clock).toISOString(), monotonicNow: () => performance.now(),
    exec: async () => ({ code: 1, stdout: "", stderr: "fixture unavailable" }),
    provisionExec: async () => ({ code: 1, stdout: "", stderr: "fixture unavailable" }),
    cpuAdmissionReconcile: async () => {}, cpuPressureHold: () => null, drainHold: () => null,
    durableTurnEvidence: async () => null, sourcePathAllowed: () => false, transcriptPresent: () => false,
    stageHostResident: async () => true, conversationAgentActive: async () => null, worktreePresent: () => false,
    scheduleTick: () => {},
  };
  const counters = () => {
    const stat = fs.readFileSync(`/proc/self/task/${process.pid}/stat`, "utf8").split(") ")[1]!.split(" ");
    const io = Object.fromEntries(fs.readFileSync(`/proc/self/task/${process.pid}/io`, "utf8").trim().split("\n").map(line => line.split(": ")));
    return { cpuMs: (Number(stat[11]) + Number(stat[12])) * 10, bytes: Number(io.rchar) };
  };
  const decode = (SqliteStateCollection.prototype as unknown as { decodeRow: (json: string) => unknown }).decodeRow;
  let decodedBytes = 0;
  (SqliteStateCollection.prototype as unknown as { decodeRow: (json: string) => unknown }).decodeRow = function(json) { decodedBytes += Buffer.byteLength(json); return decode.call(this,json); };
  resetStateReadonlyConnectionCountForTests();
  const loadBefore = os.loadavg();
  const logError = console.error;
  let errors = 0;
  console.error = (...args) => { errors++; logError(...args); };
  const ticks = [];
  for (let tick = 0; tick < 600; tick++) {
    clock = now + tick * 1000;
    // One durable lane edit per simulated second. Every lane changes in 30s.
    const id = `open-${(tick % 30).toString().padStart(4,"0")}`;
    db.query("UPDATE state_rows SET value_json=json_set(value_json,'$.stateDetail',?),row_revision=row_revision+1 WHERE collection='pipelines' AND row_key=?").run(`progress-${tick}`,id);
    db.query("UPDATE state_collections SET revision=revision+1 WHERE collection='pipelines'").run();
    const before = counters(), start = performance.now(), decoded = decodedBytes;
    const result = await tickPipelinesController([],ports);
    if (errors) throw new Error("seeded controller reported an error");
    const after = counters();
    ticks.push({ wallMs: performance.now()-start, cpuMs: after.cpuMs-before.cpuMs, readBytes: after.bytes-before.bytes,
      decodedBytes: decodedBytes-decoded, changed: result.changed });
  }
  console.error = logError;
  const result = { errors, startedUtc, finishedUtc: new Date().toISOString(), corpus, seedSha256, limits, simulatedSeconds: 600, ticks, overruns: ticks.filter(tick => tick.wallMs > 15_000).length,
    readConnections: stateReadonlyConnectionCountForTests(), load: { before: loadBefore, after: os.loadavg(), cpuCount: os.cpus().length,
      cpuMax: fs.existsSync("/sys/fs/cgroup/cpu.max") ? fs.readFileSync("/sys/fs/cgroup/cpu.max","utf8").trim() : "unavailable at cgroup root" } };
  fs.writeFileSync(path.join(root,"seeded-result.json"),JSON.stringify(result,null,2));
  console.log(JSON.stringify({ corpus, ticks: ticks.length, overruns: result.overruns, connections: result.readConnections,
    maxMs: Math.max(...ticks.map(tick => tick.wallMs)), totalCpuMs: ticks.reduce((sum,tick)=>sum+tick.cpuMs,0), readBytes: ticks.reduce((sum,tick)=>sum+tick.readBytes,0) }));
  db.close();
}
