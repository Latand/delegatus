/** M4 T9-check replay. Every read and effect is confined to an explicit copy. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { mock } from "bun:test";

const replayNow = Number(process.env.PROBE_NOW);
if (Number.isFinite(replayNow) && replayNow > 0) Date.now = () => replayNow;

type SourceTiming = { calls: number; syncMs: number; maxSyncMs: number; wallMs: number; maxWallMs: number };

function replayRoot(): { root: string; state: string } {
  const root = process.env.PROBE_ROOT && fs.realpathSync(process.env.PROBE_ROOT);
  const control = new URL(process.env.LLV_VIEWER_CONTROL_URL ?? "http://invalid");
  if (!root || root === path.parse(root).root || control.protocol !== "http:" || control.hostname !== "127.0.0.1" || !control.port || control.port === "8898") {
    throw new Error("T9-check requires an isolated M4 copy and the closed control port");
  }
  for (const key of ["LLV_STATE_DIR", "HOME", "XDG_CONFIG_HOME", "TMPDIR", "CODEX_HOME"]) {
    const value = process.env[key];
    if (!value || !fs.realpathSync(value).startsWith(root + path.sep)) throw new Error(`T9-check requires an isolated ${key}`);
  }
  return { root, state: process.env.LLV_STATE_DIR! };
}

async function installReplayEvidence() {
  const { state } = replayRoot();
  const control = new URL(process.env.LLV_VIEWER_CONTROL_URL!);
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: Number(control.port) });
    socket.setTimeout(1000);
    socket.once("connect", () => { socket.destroy(); reject(new Error("T9-check control port is open")); });
    socket.once("timeout", () => { socket.destroy(); reject(new Error("T9-check control port did not refuse")); });
    socket.once("error", error => {
      socket.destroy();
      if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") resolve(); else reject(error);
    });
  });
  const bytes = fs.readFileSync(path.join(state, "board-summary-bootstrap.bin"));
  const head = bytes.readUInt32BE(0);
  const manifest = JSON.parse(bytes.subarray(4, 4 + head).toString()) as { bodyBytes: number };
  const body = JSON.parse(bytes.subarray(4 + head, 4 + head + manifest.bodyBytes).toString());
  const catalogue = JSON.parse(fs.readFileSync(path.join(state, "project-catalog.json"), "utf8")).files;
  const scan = await import("@/lib/scanner/scanCache");
  const snapshot = { files: body.files, projectCatalog: [], complete: true };
  const snapshotFile = path.join(state, "probe-seat-scan.json");
  fs.writeFileSync(snapshotFile, JSON.stringify({ epoch: "probe", generation: 1, snapshot }), { mode: 0o600 });
  // Replay the persisted descriptors; never open the original transcripts.
  mock.module("@/lib/scanner/scanCache", () => ({
    ...scan,
    cachedFileScan: async () => ({ snapshot: { files: body.files, projectCatalog: [], complete: true },
      generation: 1, targetGeneration: 1, cacheStatus: "hit", requestCount: 1, cloneDurationMs: 0 }),
    fileScanBootstrapEpoch: () => "probe",
    completedFileScan: async () => ({ snapshot: structuredClone(snapshot), epoch: "probe", generation: 1, targetGeneration: 1,
      cacheStatus: "hit", requestCount: 1, cloneDurationMs: 0 }),
    completedFileScanDescriptor: () => ({ epoch: "probe", generation: 1, snapshotFile }),
  }));
  const liveness = await import("@/lib/lifecycle/liveness");
  const production = liveness.productionLivenessSources;
  mock.module("@/lib/lifecycle/liveness", () => ({ ...liveness, productionLivenessSources: (dependencies?: Parameters<typeof production>[0]) => {
    const source = production(dependencies);
    source.describeTranscript = async file => catalogue[file] ? { ...catalogue[file], path: file } : null;
    source.transcriptEvidence = async () => null;
    source.transcriptIdentity = async () => null;
    source.readHostTurnRecord = () => ({ state: "absent" });
    return source;
  } }));
  return { summaryBytes: manifest.bodyBytes };
}

function sourceFingerprint(): string {
  const hash = createHash("sha256");
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) hash.update(file).update(fs.readFileSync(file));
    }
  };
  walk("src");
  for (const file of ["package.json", "bun.lock", "scripts/probe-seat-tick.ts"]) hash.update(file).update(fs.readFileSync(file));
  return hash.digest("hex");
}

/** Also consumed by the T9-check case in the M4 probe catalogue. */
export async function prepareSeatTickProbe() {
  const copied = await installReplayEvidence();
  const { defaultSeatTickSources } = await import("@/lib/monitor/seatTickSources");
  const { runSeatTickCheck } = await import("@/lib/monitor/seatTickController");
  const { DEFAULT_SEAT_TICK_POLICY } = await import("@/lib/monitor/seatTick");
  const worker = await import("@/lib/scanner/filesResponseWorker");
  worker.setFilesResponseWorkerRuntimeForTests({
    launch: { executable: process.execPath, workerPath: import.meta.path },
    env: { ...process.env, PROBE_SEAT_WORKER: "1" },
  });
  // As in other M4 cases, load the module graph before the first timer.
  await import("@/app/api/files/operatorProjection");
  const sources = defaultSeatTickSources();
  const project = sources.activeSeats().find(key => sources.settings(key).enabled) ?? sources.activeSeats()[0];
  if (!project) throw new Error("copy contains no active seat");
  sources.seatContextUsage = () => null;
  sources.seatTurnOutcome = async () => null;
  sources.openPullRequests = async () => ({ ok: true, pullRequests: [] });
  const rotation = async () => ({ status: 409, body: { code: "probe", error: "scratch replay suppresses actions" } });
  const registry = sources.registry().readOnlySnapshot();
  const copiedStatuses = Object.values(registry.entries).reduce((count, entry) => {
    if (["live", "idle"].includes(entry.status)) count.live++;
    if (entry.status === "live") count.running++;
    return count;
  }, { live: 0, running: 0 });
  const { readSeatTickState, writeSeatTickState } = await import("@/lib/monitor/seatTickState");
  const { appendSeatTickRecord } = await import("@/lib/monitor/journalStore");
  let times: Record<string, SourceTiming> = {};
  function timed<F extends (...args: never[]) => unknown>(name: string, work: F): F {
    return ((...args: unknown[]) => {
      const query = args[0] as { project?: string } | undefined;
      const label = name === "liveness" ? `${name}.${query?.project ? "project" : "conversation"}` : name;
      const row = times[label] ??= { calls: 0, syncMs: 0, maxSyncMs: 0, wallMs: 0, maxWallMs: 0 };
      row.calls++;
      const started = performance.now();
      const finish = () => { const ms = performance.now() - started; row.wallMs += ms; row.maxWallMs = Math.max(row.maxWallMs, ms); };
      let result: unknown;
      try { result = Reflect.apply(work, undefined, args); }
      catch (error) { finish(); throw error; }
      const sync = performance.now() - started;
      row.syncMs += sync; row.maxSyncMs = Math.max(row.maxSyncMs, sync);
      if (result instanceof Promise) return result.finally(finish);
      finish(); return result;
    }) as unknown as F;
  }
  for (const [name, value] of Object.entries(sources)) {
    if (typeof value === "function") Object.assign(sources, { [name]: timed(name, value) });
  }
  if (sources.reports) sources.reports.log = timed("reports.log", sources.reports.log);
  const statePorts = { readState: timed("readState", readSeatTickState), writeState: timed("writeState", writeSeatTickState),
    appendRecord: timed("appendRecord", appendSeatTickRecord) };
  return {
    readiness: { case: "T9-check", bun: process.versions.bun, sourceFingerprint: sourceFingerprint(), ...copied, copiedStatuses,
      liveAgents: process.env.PROBE_LIVE_AGENTS ?? "record separately", runningAgents: process.env.PROBE_RUNNING_AGENTS ?? "record separately",
      replayNow: Number.isFinite(replayNow) ? replayNow : null,
      condition: "module imports, inert summary/catalogue decoding and registry scale count precede run 0; task, pipeline and memory lists stay cold; gh and action ports stubbed; transcript evidence suppressed in both processes" },
    async run(index: number) {
      times = {};
      const result = await runSeatTickCheck(project, { sources, ...statePorts, policy: DEFAULT_SEAT_TICK_POLICY,
        deliver: async () => ({ ok: false, error: "scratch replay" }) as never, ensureCard: () => true, reconcileSeat: () => null,
        seatRecovery: { rotate: rotation as never }, seatAutoRotation: { rotate: rotation as never },
        seatAuth: { rotate: rotation as never, telegram: async () => ({ ok: false }) as never }, proposalIssues: async () => [] });
      return { case: "T9-check", run: index, at: new Date().toISOString(), load: os.loadavg(),
        verdict: result?.verdict, reasons: result?.reasons, items: result?.items,
        failureCode: result?.verdict !== "error" ? null : /ledger/i.test(result.detail ?? "") ? "ledger-gap"
          : /bridge report log is busy/i.test(result.detail ?? "") ? "report-log-busy" : "other", sources: times };
    },
    async cleanup() {
      await worker.drainFilesResponseWorker("probe complete");
      await (await import("@/lib/pipelines/worktreeSweepWorker")).stopWorktreeSweepWorker();
    },
  };
}

if (process.env.PROBE_SEAT_WORKER === "1") {
  await installReplayEvidence();
  await import("@/lib/filesResponse.worker");
} else if (import.meta.main) {
  const probe = await prepareSeatTickProbe();
  console.log(JSON.stringify(probe.readiness));
  try {
    for (let index = 0; index < 6; index++) {
      let previous = performance.now(), maxGapMs = 0, recording = false;
      let ready!: () => void, sampled: (() => void) | undefined;
      const heartbeat = new Promise<void>(resolve => { ready = resolve; });
      const timer = setInterval(() => {
        const now = performance.now();
        if (recording) maxGapMs = Math.max(maxGapMs, now - previous);
        previous = now; ready(); sampled?.(); sampled = undefined;
      }, 1);
      try {
        await heartbeat; recording = true;
        const started = performance.now();
        const result = await probe.run(index);
        if (!result || result.verdict === "error") {
          throw new Error(`T9-check run ${index} did not complete successfully: ${result?.failureCode ?? "no result"}`);
        }
        if ((result.verdict !== "wake" && result.verdict !== "proactive") || !result.reasons?.length || !result.items) {
          throw new Error(`T9-check run ${index} did not exercise an eligible wake decision`);
        }
        const ms = performance.now() - started;
        await new Promise<void>(resolve => { sampled = resolve; });
        console.log(JSON.stringify({ ...result, ms, maxGapMs }));
        if (process.argv.includes("--enforce") && (maxGapMs > 100 || Object.values(result.sources).some(row => row.maxSyncMs > 50))) {
          throw new Error("T9-check exceeded its loop or synchronous-source bound");
        }
      } finally { clearInterval(timer); }
    }
  } finally { await probe.cleanup(); }
}
