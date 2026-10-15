/** Isolated controller replay. See docs/perf/pipelines-controller-pass.md.
 * The launcher supplies fresh copies, isolated roots, and the external gate.
 * No repository, transcript, network, agent or process actuation is admitted. */
import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import type { PipelinePorts } from "../src/lib/pipelines/engine";

const root = process.env.AUDIT_RUN;
if (!root || !path.isAbsolute(root) || process.env.LLV_STATE_DIR !== path.join(root, "state")
  || !["HOME", "XDG_CONFIG_HOME", "TMPDIR"].every(key => process.env[key]?.startsWith(`${root}/`))
  || process.env.LLV_VIEWER_CONTROL_URL !== "http://127.0.0.1:1") throw new Error("replay requires isolated roots and a closed control URL");
const denied: Record<string, number> = {};
const deny = (action: string): never => { denied[action] = (denied[action] ?? 0) + 1; throw new Error(`replay refused ${action}`); };
process.kill = () => deny("signal");
globalThis.fetch = Object.assign(async () => deny("network"), { preconnect: () => deny("network-preconnect") });
Bun.spawn = (() => deny("spawn")) as typeof Bun.spawn;
Bun.spawnSync = (() => deny("spawnSync")) as typeof Bun.spawnSync;
const writable = (filename: unknown) => {
  if (typeof filename !== "number" && !path.resolve(String(filename)).startsWith(`${root}/`)) deny("write outside replay root");
};
// Guard filesystem mutations before loading the production module graph.
const mutableFs = fs as unknown as Record<string, (...args: unknown[]) => unknown>;
for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "unlinkSync", "rmdirSync", "chmodSync", "truncateSync", "symlinkSync"]) {
  const original = mutableFs[name]!;
  mutableFs[name] = (filename, ...args) => { writable(filename); return original(filename, ...args); };
}
for (const name of ["renameSync", "copyFileSync"]) {
  const original = mutableFs[name]!;
  mutableFs[name] = (source, destination, ...args) => {
    writable(destination); if (name === "renameSync") writable(source);
    return original(source, destination, ...args);
  };
}
const open = fs.openSync;
fs.openSync = ((filename, flags, mode) => {
  if ((typeof flags === "string" && /[wa+]/.test(flags)) || (typeof flags === "number" && flags !== 0)) writable(filename);
  return open(filename, flags, mode);
}) as typeof fs.openSync;

const { registerPipelineTick } = await import("../src/lib/pipelines/controllerSignal");
registerPipelineTick(async () => {});
const { performanceSpans } = await import("../src/lib/performanceSpans");
let maxSliceMs = 0, maxSliceSite = "", snapshots = 0, copiedRows = 0;
let maxLeaseHoldMs = 0;
let decodedRows = 0, decodedBytes = 0, clonedRows = 0, clonedBytes = 0, fullReturnedSnapshots = 0, fullReturnedRows = 0;
const sync = performanceSpans.sync.bind(performanceSpans);
performanceSpans.sync = ((site, work, rows, bytes) => {
  const start = performance.now();
  try { return sync(site, work, rows, bytes); }
  finally { const elapsed = performance.now() - start; if (elapsed > maxSliceMs) { maxSliceMs = elapsed; maxSliceSite = site; } }
}) as typeof performanceSpans.sync;
const { SqliteStateCollection } = await import("../src/lib/state/sqliteStateStore");
const methods = SqliteStateCollection.prototype as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
for (const [name, index] of [["mutate", 4], ["reconcileSnapshot", 1]] as const) {
  const original = methods[name]!;
  methods[name] = function (...args) {
    const observer = args[index] as ((ms: number) => void) | undefined;
    args[index] = (ms: number) => { maxLeaseHoldMs = Math.max(maxLeaseHoldMs, ms); observer?.(ms); };
    return original.apply(this, args);
  };
}
type ObservedCollection = { options: { collection: string; clone: (value: object) => object; cloneController?: (value: object) => object } };
const observed = SqliteStateCollection.prototype as unknown as { decodeRow: (value: string) => object | null };
const decode = observed.decodeRow;
const bytesByValue = new WeakMap<object, number>(), patched = new WeakSet<object>();
const nativeClone = globalThis.structuredClone;
let decodingBytes = 0;
globalThis.structuredClone = (value, options) => {
  const result = nativeClone(value, options);
  if (value && typeof value === "object" && "stages" in value && "runs" in value && "repoDir" in value) {
    const bytes = bytesByValue.get(value) ?? decodingBytes;
    clonedRows++; clonedBytes += bytes;
    if (result && typeof result === "object") bytesByValue.set(result, bytes);
  }
  return result;
};
observed.decodeRow = function (value: string) {
  const { options } = this as unknown as ObservedCollection;
  if (!patched.has(options)) {
    patched.add(options);
    for (const field of ["clone", "cloneController"] as const) {
      const original = options[field];
      if (original) options[field] = record => {
        const bytes = bytesByValue.get(record) ?? 0, result = original(record);
        bytesByValue.set(result, bytes); return result;
      };
    }
  }
  const previous = decodingBytes; decodingBytes = options.collection === "pipelines" ? Buffer.byteLength(value) : 0;
  let result: object | null;
  try { result = decode.call(this, value); } finally { decodingBytes = previous; }
  if (options.collection === "pipelines") { decodedRows++; decodedBytes += Buffer.byteLength(value); }
  if (result) bytesByValue.set(result, Buffer.byteLength(value));
  return result;
};
const snapshotAsync = SqliteStateCollection.prototype.snapshotAsync;
SqliteStateCollection.prototype.snapshotAsync = async function () {
  const records = await snapshotAsync.call(this);
  if ((this as unknown as ObservedCollection).options.collection === "pipelines") { fullReturnedSnapshots++; fullReturnedRows += records.length; }
  return records;
};
const snapshot = SqliteStateCollection.prototype.snapshot;
SqliteStateCollection.prototype.snapshot = function () {
  const start = performance.now();
  const result = snapshot.call(this);
  maxSliceMs = Math.max(maxSliceMs, performance.now() - start);
  // Count all synchronous state snapshots; before/after use the same graph.
  snapshots++; copiedRows += result.length;
  return result;
};
function threadCounters() {
  const fields = fs.readFileSync(`/proc/self/task/${process.pid}/stat`, "utf8").split(") ")[1]!.split(" ");
  const io = Object.fromEntries(fs.readFileSync(`/proc/self/task/${process.pid}/io`, "utf8").trim().split("\n").map(line => line.split(": ")));
  return { ticks: Number(fields[11]) + Number(fields[12]), rchar: Number(io.rchar) };
}
let delayed = false, waitActive = false;
let waitWindow: { wallMs: number; mainThreadTicks: number; rchar: number; maxTimerGapMs: number } | null = null;
let waitGapMs = 0, lastTimer = performance.now();
const { tickPipelines, defaultPipelinePorts } = await import("../src/lib/pipelines/engine");
const ports: PipelinePorts = {
  ...defaultPipelinePorts(), now: () => "2026-10-15T10:26:11.383Z", monotonicNow: () => performance.now(),
  exec: async (_command, _args, _cwd, _env, options) => {
    if (!delayed && new Error().stack?.includes("stageBranch")) {
      delayed = true;
      const start = performance.now(), before = threadCounters();
      waitActive = true; lastTimer = start;
      await new Promise(resolve => setTimeout(resolve, Number(process.env.AUDIT_GIT_DELAY_MS ?? 10_000)));
      const after = threadCounters(); waitActive = false;
      waitWindow = { wallMs: performance.now() - start, mainThreadTicks: after.ticks - before.ticks,
        rchar: after.rchar - before.rchar, maxTimerGapMs: waitGapMs };
    }
    return { code: options?.signal?.aborted ? null : 1, stdout: "", stderr: "audit unavailable" };
  },
  provisionExec: async () => ({ code: 1, stdout: "", stderr: "audit unavailable" }),
  cpuAdmissionReconcile: async () => {}, cpuPressureHold: () => null, cpuAdmissionSuspend: () => {},
  drainHold: () => null, structuredDeliveryPublication: () => "unbound", scheduleTick: () => {},
  spawnAgent: async () => deny("spawnAgent"), recoverStagedLaunch: async () => {},
  stopStageAgent: async () => ({ outcome: "unconfirmed", operationId: null, detail: "audit unknown" }),
  stopInterruptedStageAgent: async () => null, stopStagePane: async () => ({ outcome: "unknown", detail: "audit unknown" }),
  stageHostResident: async () => true, stageHostTreeStillRunning: () => "audit unknown", paneAgentAlive: async () => true,
  conversationAgentActive: async () => null, conversationTurnInterrupted: async () => null,
  conversationOperatorStopped: async () => false, runtimeHostEpoch: async () => null,
  durableTurnEvidence: async () => null, sourcePathAllowed: () => false, transcriptPresent: () => false,
  headCwd: () => null, lastMessage: () => null, worktreePresent: () => false,
  resumeSeveredTurn: async () => false, requestConversationReseat: async () => {},
  runtimeSwitchControl: async () => {}, runtimeSwitchOutcome: async () => ({ state: "pending" }),
  runtimeSwitchKilled: async () => false, runtimeSwitchDelivery: async () => ({ state: "pending" }),
  retireRuntimeSwitch: async () => null, cancelRuntimeSwitch: async () => {},
  deputySeatFor: () => null, createFlow: async () => deny("createFlow"),
};
const observations = [];
console.log("PREPARED", new Date().toISOString());
const mode = process.env.AUDIT_MODE ?? "legacy";
for (let round = 0; round < 3; round++) {
  maxSliceMs = snapshots = copiedRows = decodedRows = decodedBytes = clonedRows = clonedBytes = fullReturnedSnapshots = fullReturnedRows = 0; maxSliceSite = ""; maxLeaseHoldMs = 0;
  const start = performance.now(), cpu = threadCounters();
  let maxTimerGapMs = 0;
  lastTimer = start;
  const timer = setInterval(() => {
    const now = performance.now(), gap = Math.max(0, now - lastTimer - 10);
    maxTimerGapMs = Math.max(maxTimerGapMs, gap);
    if (waitActive) waitGapMs = Math.max(waitGapMs, gap);
    lastTimer = now;
  }, 10);
  const ticks: number[] = [], phaseCpuTicks: number[] = [];
  let jobSettlementWallMs = 0, jobSettlementCpuTicks = 0;
  const errors: string[] = [];
  try {
    let lastWork = 0;
    const completed = new Set<string>();
    const prototype = SqliteStateCollection.prototype as unknown as { pipelineTickWork?: (now: number, excluded: string[], limit: number) => Array<{ row_key: string }> };
    const select = prototype.pipelineTickWork;
    if (mode !== "legacy" && select) prototype.pipelineTickWork = function (now, excluded, limit) {
      const work = select.call(this, now, [...excluded, ...completed], limit);
      lastWork = work.length;
      for (const item of work) completed.add(item.row_key);
      return work;
    };
    const { FlowPipelineController } = await import("../src/lib/pipelines/controller");
    const candidate = mode === "legacy" ? null : await import("../src/lib/pipelines/" + "controllerPass");
    const jobs = mode === "legacy" ? null : await import("../src/lib/pipelines/" + "controllerJobs");
    const phaseEvidence: Array<{ phase: string; state: string; ageMs: number }> = [];
    let pending: Promise<unknown> | undefined;
    const controller = new FlowPipelineController({
      tickPipelines: files => {
        pending = candidate ? candidate.tickPipelinesController(files, ports) : tickPipelines(files, ports);
        return pending as Promise<{ changed: boolean }>;
      },
      tickFlows: async () => ({ changed: false }), scan: async () => ({ files: [], complete: false }),
      now: () => 0, log: () => {},
      publishHeartbeat: heartbeat => { phaseEvidence.push({ phase: heartbeat.phase, state: heartbeat.state, ageMs: heartbeat.ageMs }); },
    }, { maxPasses: 1 });
    const deadline = performance.now() + 90_000;
    do {
      const phaseCpu = threadCounters().ticks, tick = performance.now(); await controller.tick("replay"); ticks.push(performance.now() - tick); phaseCpuTicks.push(threadCounters().ticks - phaseCpu);
      await pending;
      if (mode === "legacy" || lastWork === 0) break;
      if (performance.now() > deadline) throw new Error("controller replay exceeded its work deadline");
    } while (true);
    const jobAt = performance.now(), jobCpu = threadCounters().ticks;
    await jobs?.settlePipelineControllerJobs();
    jobSettlementWallMs = performance.now() - jobAt; jobSettlementCpuTicks = threadCounters().ticks - jobCpu;
    if (select) prototype.pipelineTickWork = select;
    if (phaseEvidence.some(row => row.phase === "pipelines" && row.state !== "running" && row.state !== "completed")) throw new Error("controller phase did not complete within budget");
  } finally { await new Promise(resolve => setTimeout(resolve, 20)); clearInterval(timer); }
  const after = threadCounters();
  observations.push({ round, wallMs: performance.now() - start, mainThreadTicks: after.ticks - cpu.ticks,
    rchar: after.rchar - cpu.rchar, maxSliceMs, maxSliceSite, maxTimerGapMs, ticks, snapshots, copiedRows,
    decodedRows, decodedBytes, clonedRows, clonedBytes, fullReturnedSnapshots, fullReturnedRows, maxLeaseHoldMs, phaseCpuTicks, jobSettlementWallMs, jobSettlementCpuTicks, externalChildCpuMs: 0,
    waitWindow: round === 0 ? waitWindow : null, errors, denied: { ...denied } });
  fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(observations, null, 2));
  console.log(JSON.stringify({ ...observations.at(-1), ticks: { count: ticks.length, maxMs: Math.max(...ticks) } }));
  if (errors.length || Object.keys(denied).length) throw new Error("controller replay failed");
}
// Authoritative state only. Derived projection tables intentionally differ.
const db = new Database(path.join(root, "state/state.sqlite"), { readonly: true });
fs.writeFileSync(path.join(root, "final-state.json"), JSON.stringify(db.query(
  "SELECT collection,row_key,value_json FROM state_rows WHERE collection IN ('pipelines','pipelines_archive') ORDER BY collection,row_key",
).all()));
db.close();

process.exit(0);
