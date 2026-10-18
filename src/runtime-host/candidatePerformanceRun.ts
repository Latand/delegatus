/* #2761: the candidate performance gate's runner. Run directly, this file is
   the gate:

     bun run src/runtime-host/candidatePerformanceRun.ts [--scale <0..1>]

   --profile-dir <directory> writes separate CPU profiles for both source
   Viewer processes. A profiled run is diagnostic evidence; repeat without
   profiling for release qualification.

   It builds the synthetic registry (registryPerformanceDataset.ts) and the
   newest conversations' transcripts in a private home, and returns the
   registry to the schema the previous release left. It starts the candidate's
   own runtime host there (candidateRuntimeHost.ts), which every release
   reaches through its production RPC client under the production deadlines.
   Then it plays the part of the deployment around two Viewer releases, each
   its own process running the candidate's code:

   - first boot: release A opens and upgrades the registry, takes the first
     snapshot and builds the first board projection with a cold projection
     worker, its event loop watched from before the registry opens. Being the
     serving release, its structured-host startup re-hosts the live workers:
     each is a running process that keeps writing progress into its transcript
     and answering on its socket, resumed from that transcript as an engine is;
   - warm operation: release A writes grant-bearing rows and runs keyed
     operation-id reads while a separate writer process does the same, and
     eight board scopes, each pinning a conversation of its own, are asked of
     it over HTTP, and it asks the runtime host for snapshots and operation
     receipts as a serving Viewer does;
   - release handover: release B boots over the same registry while A keeps
     writing and serving, runs the archive pass, decides the same grants and
     builds its own first projection. Once B is ready the serving target names
     it: A demotes through `completeViewerReleaseDemotion`, handing its workers
     over and exiting as a release does, and B's structured-host startup
     re-hosts every worker. The board is asked of whichever release the target
     names, through the transition.

   Every board answer is compared with its scope's settled answer from before
   the first write; every worker's progress is read back from its transcript.
   It prints one report line (`CANDIDATE_PERFORMANCE_REPORT_PREFIX`) and exits
   non-zero when an operation fails, a measurement is missing, or a fault is induced.
   Duration threshold observations remain in timingWarnings.
   `verify-candidate` runs it inside a container from the candidate image.
   Everything it creates sits under one temporary directory removed on exit,
   and every process it starts leaves when it does; it never reads the
   operator's state.

   `--induce-slow-ms <n>` holds every write of release A for n ms,
   `--induce worker-kill|worker-stall` kills or stops one re-hosted worker,
   `--induce runtime-stall` leaves every runtime-host call unanswered through
   warm operation, and `--induce server-stall` holds the event loop of the
   production server once while the browser views operate. They exist so the
   gate's own tests can prove such candidates are refused. */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  CANDIDATE_PERFORMANCE_BOUNDS,
  CANDIDATE_PERFORMANCE_REPORT_PREFIX,
  candidatePerformanceBreaches,
  latencySummary,
  projectionBuildSummary,
  type CandidatePerformanceEvidence,
  type CandidatePerformanceMeasurements,
  type ProjectionBuildSample,
} from "./candidatePerformance";
import { browserViewPins, candidateBrowserExecutable, measureBoardInBrowser, serverLoopProbe } from "./candidateBrowserRun";
import { startCandidateRuntimeHost, waitForServerStartup, type CandidateRuntimeHost } from "./candidateRuntimeHost";
import type { CandidateBrowserMeasurements } from "./candidateBrowser";

const SCOPES = 8;
const WARM_MS = 12_000;
/** After the switch, how long the board keeps being asked of the successor. */
const SERVED_AFTER_SWITCH_MS = 8_000;
/** Longest a release's re-hosting is waited for before the run goes on. */
const ADOPTION_WAIT_MS = 30_000;
const WRITE_INTERVAL_MS = 60;
const SCOPE_ROUND_MS = 1_500;
const KEYED_READ_INTERVAL_MS = 150;
const PING_INTERVAL_MS = 500;
/** A step of a release, or a timer tick, this late is named in the gate's log. */
const SLOW_STEP_MS = 100;
/** A serving Viewer's runtime traffic: a snapshot and a receipt read each tick. */
const RPC_INTERVAL_MS = 500;
/** An agent mid-turn writes an event every second or so. */
const WORKER_STEP_MS = 1_000;
/** A release not ready to serve after this is a failed release. */
const RELEASE_READY_DEADLINE_MS = 90_000;
const CHILD_DEADLINE_MS = 240_000;
/** The baseline is the board once two rounds in a row agree, or after this. */
const BASELINE_SETTLE_MS = 30_000;
const BUSY = /SQLITE_BUSY|database is locked/i;
const ENTRY = path.join(import.meta.dir, "candidatePerformanceRun.ts");

type Mode = "gate" | "viewer" | "writer" | "worker";
type Induced = "worker-kill" | "worker-stall" | "runtime-stall" | "server-stall";
const INDUCED: readonly Induced[] = ["worker-kill", "worker-stall", "runtime-stall", "server-stall"];
/** How long `--induce server-stall` holds the production server's event loop. */
const INDUCED_SERVER_STALL_MS = 800;

interface WorkerSpec { key: string; sessionId: string; transcript: string; socket: string }
interface AdoptionRecord { appointedAt: number; adoptedAt: number; pids: Record<string, number> }
interface GrantSubject { collection: "entries" | "receipts"; key: string; servers: string[] }

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function options(name: string): string[] {
  return process.argv.flatMap((value, index) => value === name && process.argv[index + 1] ? [process.argv[index + 1]!] : []);
}

const debugging = () => process.env.LLV_CANDIDATE_PERFORMANCE_DEBUG === "1";

/** Every store here opens a registry the dataset already imported. */
const importedAlready = (): never => { throw new Error("the candidate performance registry was not imported"); };

/**
 * How late a 10 ms timer fires while the window is open: the delay any timer,
 * socket answer or request handler of the process waits behind synchronous
 * work. Each window keeps its own samples; `perf_hooks`' delay monitor reports
 * one shared histogram under Bun, whatever instance is asked.
 */
function lagWindow() {
  const samples: number[] = [];
  /* The late ticks worth naming, with the wall clock they ended at, so a
     refusal can be read against what the release was doing then. */
  const stalls: Array<{ at: number; ms: number }> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let expected = 0;
  const tick = () => {
    const now = performance.now();
    const late = Math.max(0, now - expected);
    samples.push(late);
    if (late >= SLOW_STEP_MS && stalls.length < 20) stalls.push({ at: Date.now(), ms: Math.round(late) });
    expected = now + 10;
    timer = setTimeout(tick, 10);
  };
  return {
    enable() {
      if (timer) return;
      expected = performance.now() + 10;
      timer = setTimeout(tick, 10);
    },
    disable() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
    summary() {
      const sorted = [...samples].sort((left, right) => left - right);
      return { p95Ms: sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]! : 0, maxMs: sorted.at(-1) ?? 0, stalls: [...stalls] };
    },
  };
}

function busyWait(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) { /* a deliberately slow candidate */ }
}

/** Leave when the gate does, however it went: nothing it started outlives it.
    A gate that is its container's entrypoint is PID 1, and is followed too. */
function followOwner(): void {
  const owner = Number(option("--owner"));
  if (!Number.isSafeInteger(owner) || owner < 1) return;
  setInterval(() => {
    try { process.kill(owner, 0); } catch { process.exit(86); }
  }, 500).unref();
}

/** Every child shares the gate's private environment and nothing else. */
function sandboxEnvironment(root: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    /* The whole private root is the children's temp root, so every directory
       above sits under it. Run from a stage whose own temp root lies under the
       operator's state/scratch, a sibling TMPDIR left HOME, config and state
       outside every temp root a child knows, and the child read them as the
       operator's: its registry open was refused before it measured anything. */
    TMPDIR: root,
    /* Claude Code's task directory follows this before TMPDIR; inherited, the
       scanner would list another session's task output. */
    CLAUDE_CODE_TMPDIR: path.join(root, "tmp"),
    /* tmux finds its server under this; inherited from a host, the Viewer
       would observe the operator's own panes and processes. */
    TMUX_TMPDIR: path.join(root, "tmux"),
    LLV_STATE_DIR: path.join(root, "state"),
    LLV_AGENT_REGISTRY_SQLITE: "sqlite",
    /* No control URL is reachable from here: ticks and notifications fail fast. */
    LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1",
    DELEGATUS_TELEMETRY: "0",
    DO_NOT_TRACK: "1",
    /* The projection worker runs the candidate's source, as the releases do. */
    LLV_FILES_RESPONSE_WORKER_LAUNCH: "source",
  };
  for (const name of ["LLV_CANDIDATE_PERFORMANCE_BIN", "LLV_BUN_EXECUTABLE", "LLV_CANDIDATE_PERFORMANCE_DEBUG", "LLV_FILES_RESPONSE_TRACE", "BUN_OPTIONS", "LANG", "TZ"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

function runtimeBin(): string {
  return process.env.LLV_CANDIDATE_PERFORMANCE_BIN || process.execPath;
}

interface ChildOutcome {
  /** The child reported that it completed, and was not killed. */
  completed: boolean;
  exitCode: number | null;
  signal: string | null;
  report: Record<string, unknown>;
  error?: string;
}

/** Start one of this file's other modes. A child that exits without its own
    report, or is killed, has not completed, whatever it printed; one that
    reports through its output must also exit 0. A Viewer release reports
    through `--report` instead, since a demoted release exits from inside its
    demotion with the demotion's code. */
function child(mode: Exclude<Mode, "gate">, args: string[], env: Record<string, string>, reportFile?: string): { process: ChildProcess; result: Promise<ChildOutcome> } {
  const label = args.includes("--name") ? `${mode}:${args[args.indexOf("--name") + 1]}` : mode;
  const profileDirectory = mode === "viewer" ? option("--profile-dir") : undefined;
  if (profileDirectory) fs.mkdirSync(profileDirectory, { recursive: true });
  const profile = profileDirectory ? ["--cpu-prof", `--cpu-prof-dir=${profileDirectory}`, `--cpu-prof-name=${label.replace(":", "-")}.cpuprofile`] : [];
  const started = spawn(runtimeBin(), [...profile, ENTRY, `--${mode}`, "--owner", String(process.pid), ...args], {
    cwd: process.cwd(),
    env: env as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  started.stdout?.on("data", (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-4_000_000); });
  started.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-4_000);
    if (debugging()) process.stderr.write(`[${label} ${Date.now()}] ${String(chunk)}`);
  });
  const result = new Promise<ChildOutcome>((resolve) => {
    const timer = setTimeout(() => { started.kill("SIGKILL"); }, CHILD_DEADLINE_MS);
    started.once("exit", (code, signal) => {
      clearTimeout(timer);
      let text: string | undefined;
      if (reportFile) {
        try { text = fs.readFileSync(reportFile, "utf8"); } catch { text = undefined; }
      } else {
        text = stdout.trim().split("\n").filter(Boolean).at(-1);
      }
      let report: Record<string, unknown> = {};
      let error: string | undefined;
      try {
        const parsed = text ? JSON.parse(text) as unknown : null;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) report = parsed as Record<string, unknown>;
        else error = `${label} produced no report`;
      } catch {
        error = `${label} produced no report`;
      }
      if (!error && typeof report.error === "string") error = report.error;
      const completed = !error && report.completed === true && signal === null && (reportFile ? true : code === 0);
      if (!completed && !error) error = `${label} exited ${code ?? signal ?? "without a code"}`;
      const tail = stderr.split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 400);
      resolve({ completed, exitCode: code, signal, report, ...(error ? { error: `${error}${tail ? `: ${tail}` : ""}` } : {}) });
    });
  });
  return { process: started, result };
}

/* ---- a live worker: an agent process that keeps making progress ---- */

/** Progress steps a worker's transcript holds, in the order written. */
function progressOf(transcript: string): Array<{ step: number; at: number }> {
  let text = "";
  try { text = fs.readFileSync(transcript, "utf8"); } catch { return []; }
  const steps: Array<{ step: number; at: number }> = [];
  for (const line of text.split("\n")) {
    if (!line.includes("\"progress ")) continue;
    try {
      const record = JSON.parse(line) as { timestamp?: string; payload?: { message?: string } };
      const match = /^progress (\d+)$/.exec(record.payload?.message ?? "");
      if (match && record.timestamp) steps.push({ step: Number(match[1]), at: Date.parse(record.timestamp) });
    } catch { /* a torn last line is read again next time */ }
  }
  return steps;
}

/* A worker resumes from its transcript, as `codex resume` does: its next step
   follows the last one written, whoever wrote it. It answers its socket with
   the last step it wrote. Like an engine it outlives the Viewer that started
   it, until a release ends it; it leaves with the gate. */
async function workerMain(): Promise<void> {
  followOwner();
  const transcript = option("--transcript")!;
  const socketPath = option("--socket")!;
  let next = Math.max(0, ...progressOf(transcript).map((item) => item.step)) + 1;
  fs.rmSync(socketPath, { force: true });
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.end(`${next - 1}\n`);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const timer = setInterval(() => {
    fs.appendFileSync(transcript, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: { type: "agent_message", message: `progress ${next}` },
    })}\n`);
    next += 1;
  }, WORKER_STEP_MS);
  process.once("SIGTERM", () => {
    clearInterval(timer);
    server.close();
    fs.rmSync(socketPath, { force: true });
    process.exit(0);
  });
}

/** Ask a worker for its last step; null when it does not answer within a second. */
function pingWorker(socketPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    let answer = "";
    let settled = false;
    const socket = net.createConnection(socketPath);
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 1_000);
    socket.on("data", (chunk) => { answer += String(chunk); });
    socket.on("end", () => {
      const step = Number(answer.trim());
      finish(answer.trim() && Number.isFinite(step) ? step : null);
    });
    socket.on("error", () => finish(null));
  });
}

interface StartedWorker { pid: number; identity: { pid: number; startIdentity: string | null }; exited: Promise<number> }

async function startWorker(spec: WorkerSpec, env: Record<string, string>, owner: number): Promise<StartedWorker> {
  const { captureProcessIdentity } = await import("@/lib/processIdentity");
  const started = Bun.spawn([runtimeBin(), ENTRY, "--worker", "--owner", String(owner), "--transcript", spec.transcript, "--socket", spec.socket], {
    cwd: process.cwd(), env, stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  for (const until = performance.now() + 15_000; performance.now() < until;) {
    if (started.exitCode !== null) break;
    if (fs.existsSync(spec.socket) && await pingWorker(spec.socket) !== null) {
      return { pid: started.pid, identity: captureProcessIdentity(started.pid), exited: started.exited };
    }
    await Bun.sleep(50);
  }
  started.kill("SIGKILL");
  throw new Error(`worker ${spec.sessionId} did not start answering`);
}

async function stopWorker(worker: StartedWorker): Promise<void> {
  try { process.kill(worker.pid, "SIGCONT"); process.kill(worker.pid, "SIGTERM"); } catch { /* already gone */ }
  const timer = setTimeout(() => { try { process.kill(worker.pid, "SIGKILL"); } catch { /* already gone */ } }, 3_000);
  await worker.exited;
  clearTimeout(timer);
}

/** The engine host a Viewer holds for one worker: the production adopter,
    host persistence and delivery controller see the surface a real one offers. */
async function workerHost(spec: WorkerSpec, worker: StartedWorker) {
  const { FakeEngineHost, createFakeDeliveryLedger } = await import("@/lib/runtime/fixtures/fakeEngineHost");
  const state = {
    status: "active" as const,
    sessionKey: spec.sessionId,
    endpoint: `stdio:${worker.pid}`,
    pid: worker.pid,
    processStartIdentity: worker.identity.startIdentity,
    eventCursor: 0,
    protocolVersion: "candidate-performance-worker",
    activeTurnRef: `candidate-performance-turn-${spec.sessionId}`,
    pendingAttention: [],
    activeFlags: [],
    account: null,
  };
  type State = Omit<typeof state, "status" | "pid" | "processStartIdentity" | "activeTurnRef"> & {
    status: "active" | "unhosted"; pid: number | null; processStartIdentity: string | null; activeTurnRef: string | null;
  };
  let current: State = state;
  const listeners = new Set<(value: State) => void>();
  let released: Promise<void> | null = null;
  const host = new FakeEngineHost(createFakeDeliveryLedger(), state);
  return Object.assign(host, {
    health: async () => ({ ...current }),
    setWriterFence: () => {},
    onStateChange: (listener: (value: State) => void) => {
      listeners.add(listener);
      listener(current);
      return () => { listeners.delete(listener); };
    },
    /* As an engine host's release does: the engine ends, then the host
       reports itself unhosted, which writes the row free of its claim. */
    release: () => (released ??= stopWorker(worker).then(() => {
      current = { ...current, status: "unhosted", pid: null, processStartIdentity: null, activeTurnRef: null };
      for (const listener of [...listeners]) listener(current);
    })),
  });
}

function readTarget(file: string): string {
  try { return fs.readFileSync(file, "utf8").trim(); } catch { return ""; }
}

function writeAtomically(file: string, value: unknown): void {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value));
  fs.renameSync(`${file}.tmp`, file);
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return null; }
}

/* ---- the separate writer: another process with its own connection ---- */
async function writerMain(): Promise<void> {
  followOwner();
  const filename = option("--registry")!;
  const keys = JSON.parse(option("--keys")!) as Array<{ key: string; servers: string[] }>;
  const stopFile = option("--stop")!;
  const { normalizeRegistry } = await import("@/lib/agent/registry");
  const { SqliteAgentRegistryStore } = await import("@/lib/agent/sqliteRegistryStore");
  const store = new SqliteAgentRegistryStore(filename, { normalize: normalizeRegistry, initialSnapshot: importedAlready });
  const latencies: number[] = [];
  let mismatches = 0;
  let failures = 0;
  let busy = 0;
  for (let index = 0; !fs.existsSync(stopFile); index++) {
    const subject = keys[index % keys.length]!;
    const started = performance.now();
    try {
      const servers = store.mutate((file) => {
        const entry = file.entries[subject.key]!;
        entry.updatedAt = new Date().toISOString();
        return [...(entry.launchProfile?.mcpServers ?? [])];
      }, false, { operationName: "candidate-performance-external-writer" }).result;
      latencies.push(performance.now() - started);
      if (JSON.stringify(servers) !== JSON.stringify(subject.servers)) mismatches += 1;
    } catch (error) {
      if (BUSY.test(String(error))) busy += 1;
      else failures += 1;
    }
    await Bun.sleep(WRITE_INTERVAL_MS);
  }
  store.close();
  console.log(JSON.stringify({ completed: true, latencies, mismatches, failures, busy }));
}

/* ---- a Viewer release ---- */
async function viewerMain(): Promise<void> {
  followOwner();
  const started = performance.now();
  const name = option("--name")!;
  const root = option("--root")!;
  const filename = option("--registry")!;
  const targetFile = option("--target")!;
  const readyFile = option("--ready")!;
  const adoptedFile = option("--adopted")!;
  const reportFile = option("--report")!;
  const stopFile = option("--stop")!;
  const writesStart = option("--writes-start");
  const writesStop = option("--writes-stop");
  const subjects = JSON.parse(option("--subjects") ?? "[]") as GrantSubject[];
  const writes = JSON.parse(option("--writes") ?? "[]") as GrantSubject[];
  const keyed = JSON.parse(option("--keyed") ?? "{\"cold\":[],\"hot\":[]}") as { cold: string[]; hot: string[] };
  const workers = JSON.parse(option("--workers")!) as WorkerSpec[];
  const firstScope = option("--first-scope")!;
  const archive = process.argv.includes("--archive");
  const inducedDelayMs = Number(option("--induce-slow-ms") ?? "0");
  const env = sandboxEnvironment(root);
  const owner = Number(option("--owner"));
  const log: string[] = [];
  const note = (line: string) => {
    log.push(line.slice(0, 300));
    if (log.length > 20) log.shift();
    if (debugging()) console.error(line);
  };
  let busy = 0;
  let timeoutRetirements = 0;
  const writeLatencies: number[] = [];
  let writeMismatches = 0;
  let writeFailures = 0;
  const keyedLatencies: number[] = [];
  /* Each step of this release that took SLOW_STEP_MS or more, with the wall
     clock it ended at: what a late timer tick is read against. */
  const slowSteps: Array<{ step: string; at: number; ms: number }> = [];
  const step = (name: string, startedAt: number) => {
    const ms = performance.now() - startedAt;
    if (ms >= SLOW_STEP_MS && slowSteps.length < 40) slowSteps.push({ step: name, at: Date.now(), ms: Math.round(ms) });
    return ms;
  };
  const samples: ProjectionBuildSample[] = [];
  const replacements = new Map<string, StartedWorker>();
  let appointedAt: number | null = null;
  let adoptedAt: number | null = null;
  const report: Record<string, unknown> = { completed: false, name };
  const finish = (extra: Record<string, unknown> = {}) => writeAtomically(reportFile, { ...report, ...extra, log });
  try {
    /* ---- first boot, watched from before the registry opens ---- */
    const bootLoop = lagWindow();
    bootLoop.enable();
    const openStarted = performance.now();
    const { agentRegistry, normalizeRegistry } = await import("@/lib/agent/registry");
    const registry = agentRegistry();
    registry.storageDiagnostics();
    report.registryOpenMs = performance.now() - openStarted;
    const snapshotStarted = performance.now();
    await registry.prepareReadOnlySnapshot();
    report.snapshotMs = performance.now() - snapshotStarted;
    const { SqliteAgentRegistryStore, registryRowsMatching } = await import("@/lib/agent/sqliteRegistryStore");
    if (archive) {
      /* One bounded pass, as the reaper's hygiene runs it each cycle, and the
         grants decided over its own connection. */
      const store = new SqliteAgentRegistryStore(filename, { normalize: normalizeRegistry, initialSnapshot: importedAlready });
      report.archived = store.archiveInactive();
      const decided = store.read((file) => subjects.map((subject) =>
        [...(file[subject.collection][subject.key]?.launchProfile?.mcpServers ?? [])]));
      report.grantMismatches = decided.filter((servers, index) => JSON.stringify(servers) !== JSON.stringify(subjects[index]!.servers)).length;
      store.close();
    }
    const { GET, filesProjectionQueueDiagnostics, filesProjectionsSettled, observeFilesProjectionBuilds } = await import("@/app/api/files/operatorProjection");
    const { drainFilesResponseWorker, filesResponseWorkerPoolDiagnostics } = await import("@/lib/scanner/filesResponseWorker");
    observeFilesProjectionBuilds((sample) => {
      samples.push(sample);
      if (sample.buildMs > 1_000) note(`projection ${JSON.stringify(sample)} at ${Date.now()}`);
    });
    const firstStarted = performance.now();
    const first = await GET(new Request(`http://127.0.0.1/api/files?view=summary&path=${encodeURIComponent(firstScope)}`));
    await first.arrayBuffer();
    report.firstProjectionMs = performance.now() - firstStarted;
    report.firstUsableMs = performance.now() - openStarted;
    if (first.status !== 200) throw new Error(`the first projection answered ${first.status}`);
    /* A timer that came due during the last synchronous step fires now. */
    await Bun.sleep(20);
    report.bootLoopMaxMs = bootLoop.summary().maxMs;
    bootLoop.disable();
    const projectionWorkerPid = filesResponseWorkerPoolDiagnostics().pid;
    let lastRetirement = filesResponseWorkerPoolDiagnostics().lastRetirement;
    const watchRetirements = setInterval(() => {
      const retirement = filesResponseWorkerPoolDiagnostics().lastRetirement;
      if (retirement !== lastRetirement && retirement?.includes("timed out")) timeoutRetirements += 1;
      lastRetirement = retirement;
    }, 250);
    watchRetirements.unref();
    /* Serving, before an appointment and after its activation, apart from the
       activation itself: the structured-host startup that re-hosts the live
       workers once the serving target names this release. */
    const loop = lagWindow();
    const activationLoop = lagWindow();
    let activation = "waiting" as "waiting" | "running" | "done";
    let activationMs: number | null = null;
    /* No idle cutoff: a cold scope may wait its turn longer than Bun's default. */
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: (request) => {
      /* The handler's synchronous part, up to its first wait. */
      const startedAt = performance.now();
      const answer = GET(request);
      step("board request", startedAt);
      return answer;
    } });

    const { captureProcessIdentity } = await import("@/lib/processIdentity");
    const { UnixRuntimeHostClient, runtimeHostRequestTotals } = await import("@/lib/runtime/client");
    const { activateViewerRuntimeWhenCurrent, completeViewerReleaseDemotion, runStructuredHostStartup } = await import("@/lib/viewerInstrumentation");
    const { adoptStructuredHostsAtStartup } = await import("@/lib/runtime/startup");
    const { bindStructuredDeliveryQueue, hasStructuredDeliveryHost, releaseStructuredDeliveryHostsForDemotion } = await import("@/lib/runtime/structuredDeliveryController");
    const { structuredStartupAxis } = await import("@/lib/runtime/startupStatus");
    /* The production client over the gate's real runtime host, under the
       production deadlines: what it costs and every call that timed out is
       this release's to report. */
    const runtimeSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
    if (!runtimeSocket) throw new Error("no runtime host socket was given to this release");
    const client = new UnixRuntimeHostClient(runtimeSocket);
    const rpcLatencies: number[] = [];
    await bindStructuredDeliveryQueue([], { registry, client });
    const adoptHost = async (sessionId: string) => {
      const spec = workers.find((worker) => worker.sessionId === sessionId);
      if (!spec) throw new Error(`no synthetic worker for ${sessionId}`);
      const worker = await startWorker(spec, env, owner);
      replacements.set(spec.key, worker);
      note(`release ${name} started worker ${spec.sessionId.slice(-4)} as ${worker.pid}`);
      return await workerHost(spec, worker) as never;
    };
    let writing = false;
    let ended = false;
    const writeStore = writes.length ? new SqliteAgentRegistryStore(filename, { normalize: normalizeRegistry, initialSnapshot: importedAlready }) : null;
    /** What this release measured, read at its end, whichever end it is. */
    const seal = (exitPath: "demoted" | "stopped") => {
      ended = true;
      writing = false;
      clearInterval(watchRetirements);
      const pool = filesResponseWorkerPoolDiagnostics();
      const queue = filesProjectionQueueDiagnostics();
      Object.assign(report, {
        completed: true,
        exitPath,
        samples,
        servedLoop: loop.summary(),
        activation: { completed: activation === "done", ms: activationMs, eventLoopMaxMs: activationLoop.summary().maxMs },
        writes: { latencies: writeLatencies, mismatches: writeMismatches, failures: writeFailures },
        keyedLatencies,
        busy,
        timeoutRetirements,
        projectionWorker: { spawns: pool.spawns, pidStable: projectionWorkerPid !== null && pool.pid === projectionWorkerPid && pool.spawns === 1 },
        queue: { maxWaiting: queue.maxWaiting, refused: queue.refused, expired: queue.expired },
        appointedAt,
        adoptedAt,
        adopted: Object.fromEntries([...replacements].map(([key, worker]) => [key, worker.pid])),
        runtimeRpc: { ...runtimeHostRequestTotals(), latencies: rpcLatencies },
        slowSteps,
      });
      loop.disable();
      activationLoop.disable();
      writeStore?.close();
    };
    await activateViewerRuntimeWhenCurrent(async () => {
      appointedAt = Date.now();
      loop.disable();
      activationLoop.enable();
      activation = "running";
      note(`release ${name} appointed`);
      await runStructuredHostStartup(() => adoptStructuredHostsAtStartup({
        registry,
        client,
        orchestratorSeats: () => [],
        resolveCodexOwner: () => null,
        resolveClaudeOwner: () => null,
        adoptClaude: async () => [],
        /* The production pass, with only the engine it starts replaced. */
        adoptCodexHost: adoptHost,
      }), (...args: unknown[]) => note(args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ")));
    }, () => readTarget(targetFile) === name, {
      pollMs: 50,
      /* The real demotion: hosts handed over and released, the release's
         state checkpointed, and the process gone with the demotion's code. */
      onDemoted: () => {
        /* Demoted, it serves nothing: the stable listener sends the board to
           the release the target names. What its hand-over costs is read off
           the successor's adoption and the workers' progress. */
        loop.disable();
        return completeViewerReleaseDemotion(async () => {
        note(`release ${name} demoted`);
        seal("demoted");
        await filesProjectionsSettled(10_000);
        server.stop(true);
        await drainFilesResponseWorker("candidate performance release demoted", 10_000);
      }, (code) => {
        finish({ demotionExitCode: code });
        process.exit(code);
      }, (...args: unknown[]) => note(args.map((arg) => arg instanceof Error ? arg.message : String(arg)).join(" ")));
      },
    });
    report.readyMs = performance.now() - started;
    writeAtomically(readyFile, { port: server.port, readyMs: report.readyMs, identity: captureProcessIdentity(process.pid) });

    const writeLoop = async () => {
      const own = writes.filter((subject) => subject.collection === "entries");
      for (let index = 0; writing && own.length; index++) {
        const subject = own[index % own.length]!;
        const startedAt = performance.now();
        try {
          const servers = writeStore!.mutate((file) => {
            const entry = file.entries[subject.key]!;
            entry.updatedAt = new Date().toISOString();
            if (inducedDelayMs > 0) busyWait(inducedDelayMs);
            return [...(entry.launchProfile?.mcpServers ?? [])];
          }, false, { operationName: "candidate-performance-writer" }).result;
          writeLatencies.push(step("grant-bearing write", startedAt));
          if (JSON.stringify(servers) !== JSON.stringify(subject.servers)) writeMismatches += 1;
        } catch (error) {
          if (BUSY.test(String(error))) busy += 1;
          else writeFailures += 1;
          note(`writer: ${String(error).slice(0, 200)}`);
        }
        await Bun.sleep(WRITE_INTERVAL_MS);
      }
    };
    const keyedLoop = async () => {
      for (let index = 0; writing && keyed.cold.length; index++) {
        const operationId = (index % 4 === 3 ? keyed.hot : keyed.cold)[index % 97 % Math.max(1, keyed.cold.length)] ?? keyed.cold[0]!;
        const startedAt = performance.now();
        writeStore!.read((file) => registryRowsMatching(file, "heldDeliveries", "command.operationId", operationId).length);
        keyedLatencies.push(step("keyed read", startedAt));
        await Bun.sleep(KEYED_READ_INTERVAL_MS);
      }
    };
    /* A serving Viewer's runtime traffic, through the production client: the
       snapshot the board's runtime surfaces read and a receipt lookup. A call
       that fails is counted by the client; its time is recorded either way. */
    const rpcLoop = async () => {
      for (let index = 0; !ended && !fs.existsSync(stopFile); index++) {
        for (const call of [() => client.snapshot(), () => client.operationStatus(keyed.cold[index % Math.max(1, keyed.cold.length)] ?? `candidate-performance-${index}`)]) {
          const startedAt = performance.now();
          try { await call(); } catch (error) { note(`runtime host: ${String(error).slice(0, 160)}`); }
          rpcLatencies.push(step("runtime-host call", startedAt));
        }
        await Bun.sleep(RPC_INTERVAL_MS);
      }
    };
    let loopsStarted = false;
    let lastWatch = 0;
    let lastWaitNote = 0;
    while (!ended && !fs.existsSync(stopFile)) {
      if (!loopsStarted && (!writesStart || fs.existsSync(writesStart))) {
        loopsStarted = true;
        if (activation !== "running") loop.enable();
        void rpcLoop();
        if (writesStart && writeStore) {
          writing = true;
          void writeLoop();
          void keyedLoop();
        }
      }
      if (writing && writesStop && fs.existsSync(writesStop)) writing = false;
      /* The activation ends once its startup pass reports ready and every
         worker is re-hosted here. */
      if (activation === "running" && adoptedAt !== null && structuredStartupAxis() === "ready") {
        activation = "done";
        activationMs = Date.now() - appointedAt!;
        activationLoop.disable();
        if (loopsStarted) loop.enable();
      }
      /* Watched through a direct keyed read of the worker rows, so the
         watching adds no snapshot of history to the release under test. */
      if (adoptedAt === null && appointedAt !== null && Date.now() - lastWatch >= 250) {
        lastWatch = Date.now();
        const rows = rowsOf(filename, "entries", workers.map((spec) => spec.key));
        const hosted = workers.map((spec) => {
          const row = rows.get(spec.key);
          const pid = row ? (JSON.parse(row.json) as { structuredHost?: { process?: { pid?: number } | null } }).structuredHost?.process?.pid ?? null : null;
          return { spec, pid, replacement: replacements.get(spec.key) ?? null };
        });
        const rehosted = hosted.every(({ spec, pid, replacement }) => replacement && pid === replacement.pid
          && hasStructuredDeliveryHost({ engine: "codex", sessionId: spec.sessionId }));
        if (!rehosted && debugging() && lastWatch - lastWaitNote >= 2_000) {
          lastWaitNote = lastWatch;
          note(`release ${name} waiting: ${hosted.map(({ spec, pid, replacement }) => `${spec.sessionId.slice(-4)}:${pid ?? "-"}/${replacement?.pid ?? "-"}`).join(" ")}`);
        }
        if (rehosted) {
          adoptedAt = Date.now();
          writeAtomically(adoptedFile, { appointedAt, adoptedAt, pids: Object.fromEntries([...replacements].map(([key, worker]) => [key, worker.pid])) } satisfies AdoptionRecord);
          note(`release ${name} re-hosted ${replacements.size} worker(s) ${adoptedAt - appointedAt}ms after its appointment`);
        }
      }
      await Bun.sleep(50);
    }
    if (ended) {
      /* The demotion is under way and ends this process. */
      await new Promise(() => {});
    }
    /* Stopped while still serving: a release shut down at the end of the run. */
    seal("stopped");
    try { await releaseStructuredDeliveryHostsForDemotion(); } catch (error) { note(`release: ${String(error).slice(0, 200)}`); }
    for (const worker of replacements.values()) await stopWorker(worker);
    server.stop(true);
    await drainFilesResponseWorker("candidate performance release stopped", 30_000);
    const { fileScanCacheStatus } = await import("@/lib/scanner/scanCache");
    for (const until = performance.now() + 30_000; fileScanCacheStatus().inFlight && performance.now() < until;) await Bun.sleep(100);
    finish();
    process.exit(0);
  } catch (error) {
    if (BUSY.test(String(error))) busy += 1;
    note(`release ${name} failed: ${String(error).slice(0, 300)}`);
    for (const worker of replacements.values()) await stopWorker(worker);
    const { runtimeHostRequestTotals } = await import("@/lib/runtime/client");
    finish({ completed: false, error: String(error).slice(0, 500), busy, runtimeRpc: { ...runtimeHostRequestTotals(), latencies: [] } });
    process.exit(1);
  }
}

/** Return the seeded registry to the schema the previous release left: the
    archive view without identity equalities and no generation identity index.
    The first boot then pays the upgrade a real release pays. */
function previousReleaseSchema(filename: string): void {
  const { Database } = process.getBuiltinModule("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(filename);
  try {
    // These receipt indexes are new to the candidate too. Seed-time schema
    // preparation must not hide their first-boot migration cost.
    for (const index of ["registry_archive_request_digest", "registry_archive_supersedes", "registry_lookup_requestDigest", "registry_lookup_supersedes_conversationId", "registry_lookup_structuredHost_kind", "registry_archive_structured_host_kind", "registry_rows_failure_repair"]) {
      db.exec(`DROP INDEX IF EXISTS ${index}`);
    }
    db.exec(`BEGIN IMMEDIATE;
      DROP VIEW registry_records;
      CREATE VIEW registry_records AS
        SELECT collection,row_key,value_json,row_order FROM registry_hot_rows
        UNION ALL SELECT a.collection,a.row_key,a.value_json,a.row_order
        FROM registry_cold c JOIN registry_archive a ON a.id=c.archive_id;
      DROP TRIGGER IF EXISTS registry_generation_identities_insert;
      DROP TRIGGER IF EXISTS registry_generation_identities_update;
      DROP TRIGGER IF EXISTS registry_generation_identities_delete;
      DROP TABLE IF EXISTS registry_generation_identities;
      DELETE FROM registry_meta WHERE key='generation_identities_version';
      COMMIT;`);
  } finally {
    db.close();
  }
}

function rowsOf(filename: string, collection: string, keys: readonly string[]): Map<string, { json: string; cold: boolean }> {
  const { Database } = process.getBuiltinModule("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(filename, { readonly: true });
  try {
    const query = db.query<{ value_json: string; cold: number }, [string, string, string, string]>(
      `SELECT value_json, EXISTS (SELECT 1 FROM registry_cold c WHERE c.collection=? AND c.row_key=?) AS cold
        FROM registry_records WHERE collection=? AND row_key=?`);
    return new Map(keys.flatMap((key) => {
      const row = query.get(collection, key, collection, key);
      return row ? [[key, { json: row.value_json, cold: row.cold === 1 }] as const] : [];
    }));
  } finally {
    db.close();
  }
}

/** A board answer's rows by path, each with the identity it must keep. */
function boardRows(body: string): Map<string, string> {
  const files = (JSON.parse(body) as { files?: Array<{ path?: string; conversationId?: string; project?: string }> }).files ?? [];
  return new Map(files.map((file) => [file.path ?? "", `${file.conversationId ?? ""}|${file.project ?? ""}`]));
}

function sameRows(left: Map<string, string>, right: Map<string, string>): boolean {
  return left.size === right.size && [...left].every(([row, identity]) => right.get(row) === identity);
}

/* ---- the board in real browser views ---- */

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * The candidate's own production build (`next start` from the image's `.next`)
 * over the registry the release phases left, opened in eight browser views
 * while two writers run. Without a build, a browser or the full dataset there
 * is nothing to measure, and the verdict refuses a report without it.
 */
async function browserPhase(input: {
  root: string;
  env: Record<string, string>;
  registry: string;
  conversations: ReadonlyArray<{ path: string; conversationId: string }>;
  keys: ReadonlyArray<{ key: string; servers: string[] }>;
  children: ChildProcess[];
  note: (line: string) => void;
  /** Hold the server's event loop this long once the views operate. */
  inducedStallMs?: number;
}): Promise<CandidateBrowserMeasurements | null> {
  const executablePath = candidateBrowserExecutable();
  if (!executablePath) { input.note("browser: no Chromium in this image or CHROME_BIN"); return null; }
  if (!fs.existsSync(path.join(process.cwd(), ".next", "BUILD_ID"))) { input.note("browser: no production build to serve"); return null; }
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env: Record<string, string> = {
    ...input.env,
    NODE_ENV: "production",
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    NEXT_TELEMETRY_DISABLED: "1",
    /* As the board driver's server: no account probes, no reaper of its own. */
    LLV_ACCOUNT_CONTROLLER_DISABLED: "1",
    LLV_REAPER_ENABLED: "0",
  };
  delete env.LLV_FILES_RESPONSE_WORKER_LAUNCH;
  /* The server's event loop is read from inside it, over the views' whole load. */
  fs.mkdirSync(path.join(input.root, "server-loop"), { recursive: true });
  const probe = serverLoopProbe(path.join(input.root, "server-loop", "probe"));
  const server = spawn(runtimeBin(), [...probe.preload, "--bun", "node_modules/.bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: process.cwd(), env: { ...env, ...probe.env } as NodeJS.ProcessEnv, stdio: ["ignore", "ignore", debugging() ? "inherit" : "ignore"],
  });
  input.children.push(server);
  try {
    /* Up, then its first board built, as an operator's server is when they open it. */
    for (const until = performance.now() + 180_000; ; await Bun.sleep(500)) {
      if (server.exitCode !== null) throw new Error(`the production server exited ${server.exitCode}`);
      if (performance.now() > until) throw new Error("the production server never served a board");
      try {
        const response = await fetch(`${baseUrl}/api/files?view=summary`);
        if (response.ok && ((await response.json()) as { files?: unknown[] }).files?.length) break;
      } catch { /* booting */ }
    }
    const startup = await waitForServerStartup(baseUrl);
    input.note(`browser: the server's structured-host startup is ${startup}`);
    if (startup !== "ready") throw new Error(`the production server's structured-host startup is ${startup}, never ready`);
    await fetch(`${baseUrl}/api/onboarding`, { method: "PUT", headers: { "content-type": "application/json", origin: baseUrl }, body: JSON.stringify({ dismissed: true }) });
    /* The probe must be watching the process that serves, or its reading says nothing. */
    if (probe.pid() !== server.pid) throw new Error("the production server carries no event-loop probe");
    const result = await measureBoardInBrowser({
      baseUrl,
      executablePath,
      server: probe,
      onOperating: (remainingMs) => {
        if (!input.inducedStallMs) return;
        setTimeout(() => { probe.stall(input.inducedStallMs!); input.note(`induced: held the production server's event loop for ${input.inducedStallMs}ms`); }, remainingMs / 3);
      },
      pins: browserViewPins(input.conversations),
      writers: {
        runtime: runtimeBin(), entry: ENTRY, cwd: process.cwd(), env: input.env as NodeJS.ProcessEnv,
        registry: input.registry, keys: input.keys, stopFile: path.join(input.root, "browser-writers-stop"),
      },
    });
    for (const view of result.diagnostics) {
      input.note(`browser view ${view.view}: slowest ${JSON.stringify(view.slowest.slice(0, 2))}`
        + (view.failures.length ? `; failed ${JSON.stringify(view.failures)}` : ""));
    }
    input.note(`browser: the server's event loop ${JSON.stringify(result.measurements.server)}`
      + (result.serverStalls.length ? `; delays of ${SLOW_STEP_MS}ms or more: ${result.serverStalls.map((stall) => `${stall.ms}ms at ${stall.at}`).join(", ")}` : ""));
    return result.measurements;
  } finally {
    server.kill("SIGTERM");
    const timer = setTimeout(() => server.kill("SIGKILL"), 10_000);
    if (server.exitCode === null && server.signalCode === null) await new Promise((resolve) => server.once("exit", resolve));
    clearTimeout(timer);
  }
}

const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
const numbers = (value: unknown) => Array.isArray(value) ? value.filter((item): item is number => typeof item === "number" && Number.isFinite(item)) : [];

/** A fresh process over a caller-owned COPY of one synthetic census. This
 * diagnostic cell can be copied unchanged into a baseline source export;
 * both versions use their own production registry/recovery implementation.
 * It measures registry preparation separately from the full candidate gate. */
async function startupProbeMain(): Promise<void> {
  const filename = option("--registry");
  if (!filename || !fs.existsSync(filename)) throw new Error("--registry must name an isolated census copy");
  const loop = lagWindow(); loop.enable();
  const { AgentRegistry } = await import("@/lib/agent/registry");
  let loads = 0;
  const started = performance.now();
  const registry = new AgentRegistry(path.join(path.dirname(filename), "agent-registry.json"), undefined, undefined,
    { sqliteMode: "sqlite", onSqliteSnapshotLoad: () => { loads++; } });
  registry.storageDiagnostics();
  const openMs = performance.now() - started;
  const viewStarted = performance.now();
  if (typeof registry.prepareReadOnlySnapshot === "function") await registry.prepareReadOnlySnapshot();
  else registry.readOnlySnapshot();
  const viewMs = performance.now() - viewStarted;
  await Bun.sleep(20);
  const bootLoop = loop.summary(); loop.disable();
  const { Database } = process.getBuiltinModule("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(filename, { readonly: true });
  const retained = () => db.query<{ value_json: string }, []>(`SELECT value_json FROM registry_records
    WHERE collection='heldDeliveries' OR collection='receipts' AND json_extract(value_json,'$.state')='path-pending'
    ORDER BY collection,row_key`).all().map(row => row.value_json);
  const before = retained();
  const { RuntimeHost } = await import("./host");
  const { RuntimeJournal } = await import("./journal");
  const { serveRuntimeHost } = await import("./socket");
  const { UnixRuntimeHostClient } = await import("@/lib/runtime/client");
  const { recoverPendingStructuredSpawns } = await import("@/lib/runtime/structuredSpawn");
  const { performanceSpans, performanceSites } = await import("@/lib/performanceSpans");
  const journal = new RuntimeJournal(path.join(path.dirname(filename), "probe-runtime.sqlite"), { structuredHosts: true });
  const host = new RuntimeHost(journal);
  const counts: Record<string, number> = {};
  const socket = path.join(process.env.TMPDIR!, "probe.sock");
  const server = serveRuntimeHost(socket, { handle: async (request, options) => {
    counts[request.method] = (counts[request.method] ?? 0) + 1;
    return host.handle(request, options);
  } });
  await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    performanceSpans.clear();
    const recoveryLoop = lagWindow(); recoveryLoop.enable();
    const recoveryStarted = performance.now();
    const probeAt = db.query<{ at: string | null }, []>("SELECT MAX(json_extract(value_json,'$.createdAt')) AS at FROM registry_records WHERE collection='receipts' AND json_extract(value_json,'$.state')='path-pending'").get()?.at;
    await recoverPendingStructuredSpawns(registry, new UnixRuntimeHostClient(socket), { now: () => probeAt ? Date.parse(probeAt) : Date.now() });
    const recoveryMs = performance.now() - recoveryStarted;
    await Bun.sleep(20); recoveryLoop.disable();
    console.log(JSON.stringify({ openMs, viewMs, bootLoop, recoveryMs, recoveryLoop: recoveryLoop.summary(), counts, loads,
      retained: before.length, preserved: JSON.stringify(before) === JSON.stringify(retained()),
      longest: performanceSpans.snapshot().records.filter(row => row.kind === "sync").sort((a,b) => b.maxMs-a.maxMs).slice(0,6)
        .map(row => ({ site: performanceSites[row.site], ms: row.maxMs })) }));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    journal.close(); db.close(); registry.close();
  }
}

async function gateMain(): Promise<CandidatePerformanceEvidence> {
  const checkedAt = new Date().toISOString();
  const runtime = `bun ${Bun.version}`;
  const scale = Number(option("--scale") ?? "1");
  const inducedDelayMs = Number(option("--induce-slow-ms") ?? "0");
  const induced = options("--induce").filter((name): name is Induced => (INDUCED as readonly string[]).includes(name));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-candidate-performance-"));
  const log: string[] = [];
  const note = (line: string) => {
    log.push(line.slice(0, 1_000));
    if (log.length > 48) log.shift();
    if (debugging()) console.error(`[gate ${Date.now()}] ${line}`);
  };
  const inducedFields = {
    ...(inducedDelayMs > 0 ? { inducedDelayMs } : {}),
    ...(induced.length ? { induced } : {}),
  };
  const children: ChildProcess[] = [];
  const workerPids: number[] = [];
  let runtimeHost: CandidateRuntimeHost | null = null;
  try {
    const env = sandboxEnvironment(root);
    for (const directory of [env.HOME!, env.XDG_CONFIG_HOME!, env.CLAUDE_CODE_TMPDIR!, env.TMUX_TMPDIR!, env.LLV_STATE_DIR!, path.join(root, "w")]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    /* The dataset is built here, under the sandbox's state directory and
       nothing of the caller's. */
    process.env.LLV_STATE_DIR = env.LLV_STATE_DIR;
    const { buildRegistryPerformanceDataset, REGISTRY_PERFORMANCE_SHAPE, scaledRegistryPerformanceShape } = await import("@/lib/agent/registryPerformanceDataset");
    const dataset = buildRegistryPerformanceDataset(
      env.LLV_STATE_DIR!,
      scale >= 1 ? REGISTRY_PERFORMANCE_SHAPE : scaledRegistryPerformanceShape(scale),
      { sessionsRoot: path.join(env.HOME!, ".codex", "sessions") },
    );
    previousReleaseSchema(dataset.filename);
    note(`dataset ${dataset.rows} rows, ${dataset.coldRows} cold, ${dataset.conversations.length} transcripts, seeded in ${Math.round(dataset.seedMs)}ms`);
    /* The runtime host every release, and the browser half's server, reach
       through the production client; it reads the same retained registry. */
    runtimeHost = await startCandidateRuntimeHost({
      runtimeBin: runtimeBin(), cwd: process.cwd(), env, directory: path.join(root, "rt"),
      faults: induced.includes("runtime-stall"),
    });
    env.LLV_RUNTIME_HOST_SOCKET = runtimeHost.socket;
    note(`runtime host ${runtimeHost.pid} answering`);
    const workers: WorkerSpec[] = dataset.workers.map((worker, index) => ({ ...worker, socket: path.join(root, "w", `${index}.sock`) }));
    const deliveryIds = [...dataset.pendingDeliveryIds, ...dataset.uncertainDeliveryIds];
    const deliveriesBefore = rowsOf(dataset.filename, "heldDeliveries", deliveryIds);
    const { Database } = process.getBuiltinModule("bun:sqlite") as typeof import("bun:sqlite");
    const censusDb = new Database(dataset.filename, { readonly: true });
    const retainedDeliveryIds = censusDb.query<{ row_key: string }, []>("SELECT row_key FROM registry_records WHERE collection='heldDeliveries'").all().map(row => row.row_key);
    const pendingLaunchIds = censusDb.query<{ row_key: string }, []>("SELECT row_key FROM registry_records WHERE collection='receipts' AND json_extract(value_json,'$.state')='path-pending'").all().map(row => row.row_key);
    censusDb.close();
    const retainedDeliveries = rowsOf(dataset.filename, "heldDeliveries", retainedDeliveryIds);
    const pendingLaunches = rowsOf(dataset.filename, "receipts", pendingLaunchIds);
    /* Eight scopes, each pinning a different conversation with a transcript. */
    const pinned = Array.from({ length: SCOPES }, (_, scope) => dataset.conversationPaths[(scope * 7 + 3) % dataset.conversationPaths.length]!);
    const scopeQuery = (scope: number) => `/api/files?view=summary&path=${encodeURIComponent(pinned[scope]!)}`;
    const entrySubjects = dataset.grantSubjects.filter((subject) => subject.collection === "entries" && !workers.some((worker) => worker.key === subject.key));
    const targetFile = path.join(root, "viewer-target");
    fs.writeFileSync(targetFile, "a");
    const file = (name: string) => path.join(root, name);
    const release = (name: "a" | "b", extra: string[]) => {
      const started = child("viewer", [
        "--name", name,
        "--root", root,
        "--registry", dataset.filename,
        "--target", targetFile,
        "--ready", file(`release-${name}-ready.json`),
        "--adopted", file(`release-${name}-adopted.json`),
        "--report", file(`release-${name}-report.json`),
        "--stop", file(`release-${name}-stop`),
        "--workers", JSON.stringify(workers),
        "--first-scope", pinned[0]!,
        ...extra,
      ], env, file(`release-${name}-report.json`));
      children.push(started.process);
      let exited = false;
      void started.result.then(() => { exited = true; });
      return {
        ...started,
        exited: () => exited,
        ready: () => readJson<{ port: number; readyMs: number }>(file(`release-${name}-ready.json`)),
        adopted: () => readJson<AdoptionRecord>(file(`release-${name}-adopted.json`)),
      };
    };
    const waitFor = async (condition: () => boolean, ms: number) => {
      for (const until = performance.now() + ms; performance.now() < until && !condition();) await Bun.sleep(100);
      return condition();
    };

    /* ---- first boot: release A, appointed from the start ---- */
    const aStartedAt = Date.now();
    const a = release("a", [
      "--writes-start", file("writes-start"),
      "--writes-stop", file("writes-stop"),
      "--writes", JSON.stringify(entrySubjects.filter((_, index) => index % 2 === 0)),
      "--keyed", JSON.stringify({ cold: dataset.coldOperationIds, hot: dataset.hotOperationIds }),
      ...(inducedDelayMs > 0 ? ["--induce-slow-ms", String(inducedDelayMs)] : []),
    ]);
    if (!await waitFor(() => a.ready() !== null || a.exited(), RELEASE_READY_DEADLINE_MS) || !a.ready()) {
      const outcome = await a.result;
      throw new Error(`release A never became ready: ${outcome.error ?? "no reason"}`);
    }
    if (!await waitFor(() => a.adopted() !== null || a.exited(), ADOPTION_WAIT_MS) || !a.adopted()) {
      throw new Error("release A did not host the live workers");
    }
    workerPids.push(...Object.values(a.adopted()!.pids));
    note(`release A ready in ${Math.round(a.ready()!.readyMs)}ms and hosting ${workers.length} live workers`);

    /* ---- the board's scopes, asked of whichever release serves ---- */
    let servingPort = a.ready()!.port;
    let servingName: "a" | "b" = "a";
    const requestLatencies: number[] = [];
    let scopeFailures = 0;
    let servingCounting = false;
    const serving = { requests: 0, failures: 0 };
    const baseline = new Map<number, Map<string, string>>();
    const stability = { rounds: 0, responses: 0, emptyResponses: 0, missingRows: 0, extraRows: 0, reattributedRows: 0, missingPins: 0 };
    let dumped = false;
    const round = async (compare: boolean): Promise<Array<Map<string, string> | null>> => {
      const answers = await Promise.all(Array.from({ length: SCOPES }, async (_, scope) => {
        const startedAt = performance.now();
        if (servingCounting) serving.requests += 1;
        try {
          const response = await fetch(`http://127.0.0.1:${servingPort}${scopeQuery(scope)}`, { signal: AbortSignal.timeout(60_000) });
          const body = await response.text();
          requestLatencies.push(performance.now() - startedAt);
          if (response.status !== 200) throw new Error(`answered ${response.status}`);
          const rows = boardRows(body);
          const debugDir = process.env.LLV_CANDIDATE_PERFORMANCE_DEBUG_DIR;
          if (compare && !dumped && debugDir && baseline.get(scope) && !sameRows(rows, baseline.get(scope)!)) {
            dumped = true;
            fs.writeFileSync(path.join(debugDir, `scope-${scope}-diverged.json`), body);
          }
          return rows;
        } catch (error) {
          scopeFailures += 1;
          if (servingCounting) serving.failures += 1;
          note(`scope ${scope}: ${String(error).slice(0, 200)}`);
          return null;
        }
      }));
      if (compare) {
        stability.rounds += 1;
        answers.forEach((rows, scope) => {
          const before = baseline.get(scope);
          if (!rows || !before) return;
          stability.responses += 1;
          if (!rows.size) stability.emptyResponses += 1;
          if (!rows.has(pinned[scope]!)) stability.missingPins += 1;
          let missing = 0;
          let extra = 0;
          let moved = 0;
          for (const [row, identity] of before) {
            if (!rows.has(row)) missing += 1;
            else if (rows.get(row) !== identity) moved += 1;
          }
          for (const row of rows.keys()) if (!before.has(row)) extra += 1;
          stability.missingRows += missing;
          stability.extraRows += extra;
          stability.reattributedRows += moved;
          if (missing || extra || moved) {
            const gone = [...before.keys()].filter((row) => !rows.has(row)).slice(0, 2).map((row) => path.basename(row));
            const added = [...rows.keys()].filter((row) => !before.has(row)).slice(0, 2).map((row) => path.basename(row));
            note(`scope ${scope} (release ${servingName}): ${missing} row(s) missing, ${extra} extra, ${moved} reattributed (${gone.join(" ")} -> ${added.join(" ")})`);
          }
        });
      }
      return answers;
    };
    /* The settled board before any write: two rounds in a row that agree. */
    let previous = await round(false);
    for (const until = performance.now() + BASELINE_SETTLE_MS; performance.now() < until;) {
      await Bun.sleep(500);
      const next = await round(false);
      const agreed = next.every((rows, scope) => rows && previous[scope] && sameRows(rows, previous[scope]!));
      previous = next;
      if (agreed) break;
    }
    previous.forEach((rows, scope) => { if (rows) baseline.set(scope, rows); });
    note(`baseline rows per scope: ${[...baseline.values()].map((rows) => rows.size).join(",")}`);

    /* Every worker is asked for its step through the whole run. */
    const pings: Array<{ at: number; ok: boolean }> = [];
    let pinging = true;
    const pinger = (async () => {
      while (pinging) {
        const at = Date.now();
        const answers = await Promise.all(workers.map((spec) => pingWorker(spec.socket)));
        for (const answer of answers) pings.push({ at, ok: answer !== null });
        await Bun.sleep(PING_INTERVAL_MS);
      }
    })();

    /* ---- warm operation ---- */
    if (induced.includes("runtime-stall")) { runtimeHost.stall(true); note("induced: the runtime host stopped answering"); }
    fs.writeFileSync(file("writes-start"), "1");
    const external = child("writer", [
      "--registry", dataset.filename,
      "--keys", JSON.stringify(entrySubjects.filter((_, index) => index % 2 === 1).map(({ key, servers }) => ({ key, servers }))),
      "--stop", file("writer-stop"),
    ], env);
    children.push(external.process);
    const phase = async (ms: number, until: () => boolean = () => false) => {
      const end = performance.now() + ms;
      while (performance.now() < end && !until()) {
        const startedAt = performance.now();
        await round(true);
        await Bun.sleep(Math.max(0, SCOPE_ROUND_MS - (performance.now() - startedAt)));
      }
    };
    await phase(WARM_MS);
    if (induced.includes("runtime-stall")) {
      runtimeHost.stall(false);
      note(`induced: the runtime host answers again after holding ${runtimeHost.stalled()} call(s)`);
    }

    /* ---- release handover: B boots beside the serving A ---- */
    note("warm operation measured; starting release B");
    servingCounting = true;
    const successorStarted = performance.now();
    const b = release("b", ["--archive", "--subjects", JSON.stringify(dataset.grantSubjects)]);
    await phase(RELEASE_READY_DEADLINE_MS, () => b.ready() !== null || b.exited());
    let switchedAt: number | null = null;
    let adopted: AdoptionRecord | null = null;
    const bReady = b.ready();
    if (bReady && !b.exited()) {
      /* The promotion: the serving target names B, and the stable listener
         sends the board to it from now on. */
      switchedAt = Date.now();
      fs.writeFileSync(targetFile, "b");
      servingPort = bReady.port;
      servingName = "b";
      note(`release B ready in ${Math.round(bReady.readyMs)}ms; serving target switched`);
      await phase(ADOPTION_WAIT_MS, () => b.adopted() !== null || b.exited());
      adopted = b.adopted();
      if (adopted) {
        workerPids.push(...Object.values(adopted.pids));
        note(`release B re-hosted ${Object.keys(adopted.pids).length} worker(s) ${adopted.adoptedAt - switchedAt}ms after the switch`);
        const victim = Object.values(adopted.pids)[0];
        if (victim && induced.includes("worker-kill")) { process.kill(victim, "SIGKILL"); note("induced: killed a re-hosted worker"); }
        if (victim && induced.includes("worker-stall")) { process.kill(victim, "SIGSTOP"); note("induced: stopped a re-hosted worker"); }
      } else note("release B did not re-host every worker");
      await phase(SERVED_AFTER_SWITCH_MS, () => b.exited());
    } else {
      /* Never promoted: the serving release keeps serving and keeps its workers. */
      note("release B never became ready; release A keeps serving");
      await phase(SERVED_AFTER_SWITCH_MS, () => a.exited());
    }

    /* ---- the end of writes ---- */
    fs.writeFileSync(file("writes-stop"), "1");
    fs.writeFileSync(file("writer-stop"), "1");
    const externalOutcome = await external.result;
    await round(true);

    /* ---- the workers, as they stand once the transition is over ---- */
    const workersCheckedAt = Date.now();
    pinging = false;
    await pinger;
    const finalPings = await Promise.all(workers.map((spec) => pingWorker(spec.socket)));
    const { captureProcessIdentity } = await import("@/lib/processIdentity");
    const entryRows = rowsOf(dataset.filename, "entries", workers.map((spec) => spec.key));
    const rehosted = workers.filter((spec) => {
      const pid = adopted?.pids[spec.key];
      const row = entryRows.get(spec.key);
      if (pid === undefined || !row) return false;
      const entry = JSON.parse(row.json) as { status?: string; claimOwner?: string | null; structuredHost?: { process?: { pid: number; startIdentity: string | null } | null } };
      const owned = entry.structuredHost?.process ?? null;
      return entry.status === "live" && Boolean(entry.claimOwner) && owned?.pid === pid
        && captureProcessIdentity(pid).startIdentity === owned.startIdentity;
    }).length;
    const transitionEnd = adopted?.adoptedAt ?? null;
    const failedPings = pings.filter((ping) => !ping.ok
      && !(switchedAt !== null && transitionEnd !== null && ping.at >= switchedAt && ping.at <= transitionEnd + PING_INTERVAL_MS)).length;
    let progressGapMaxMs = 0;
    let lostProgress = 0;
    let repeatedProgress = 0;
    for (const spec of workers) {
      let last = 0;
      let lastAt: number | null = null;
      for (const { step, at } of progressOf(spec.transcript)) {
        if (step <= last) repeatedProgress += 1;
        else lostProgress += step - last - 1;
        last = Math.max(last, step);
        if (lastAt !== null) progressGapMaxMs = Math.max(progressGapMaxMs, at - lastAt);
        lastAt = at;
      }
      progressGapMaxMs = Math.max(progressGapMaxMs, workersCheckedAt - (lastAt ?? 0));
    }

    /* ---- each release's own account ---- */
    for (const name of ["a", "b"]) fs.writeFileSync(file(`release-${name}-stop`), "1");
    for (const pid of workerPids) { try { process.kill(pid, "SIGCONT"); } catch { /* gone */ } }
    const [aOutcome, bOutcome] = await Promise.all([a.result, b.result]);
    const aReport = aOutcome.report;
    const bReport = bOutcome.report;
    for (const [name, outcome] of [["A", aOutcome], ["B", bOutcome]] as const) {
      if (outcome.error) note(`release ${name}: ${outcome.error}`);
      for (const line of Array.isArray(outcome.report.log) ? outcome.report.log as string[] : []) note(`release ${name}: ${line}`);
    }
    note(`event loop while serving: release A ${JSON.stringify(aReport.servedLoop ?? null)}, release B ${JSON.stringify(bReport.servedLoop ?? null)}`);
    for (const [name, report] of [["A", aReport], ["B", bReport]] as const) {
      const slow = Array.isArray(report.slowSteps) ? report.slowSteps as Array<{ step: string; at: number; ms: number }> : [];
      if (slow.length) note(`release ${name} steps of ${SLOW_STEP_MS}ms or more: ${slow.map((item) => `${item.step} ${item.ms}ms at ${item.at}`).join("; ")}`);
    }
    const aBuilds = projectionBuildSummary(Array.isArray(aReport.samples) ? aReport.samples as ProjectionBuildSample[] : []);
    const bBuilds = projectionBuildSummary(Array.isArray(bReport.samples) ? bReport.samples as ProjectionBuildSample[] : []);
    note(`warm builds: release A ${JSON.stringify(latencySummary(aBuilds.warm))}, release B ${JSON.stringify(latencySummary(bBuilds.warm))}`);
    const aWrites = (aReport.writes ?? {}) as { latencies?: unknown; mismatches?: number; failures?: number };
    const loops = [aReport.servedLoop, bReport.servedLoop].map((value) => (value ?? {}) as { p95Ms?: number; maxMs?: number });
    const queues = [aReport.queue, bReport.queue].map((value) => (value ?? {}) as { maxWaiting?: number; refused?: number; expired?: number });
    const externalLatencies = numbers(externalOutcome.report.latencies);
    const deliveriesAfter = rowsOf(dataset.filename, "heldDeliveries", deliveryIds);
    const retainedAfter = rowsOf(dataset.filename, "heldDeliveries", retainedDeliveryIds);
    const launchesAfter = rowsOf(dataset.filename, "receipts", pendingLaunchIds);
    const retainedPreserved = retainedDeliveryIds.every(id => retainedDeliveries.get(id)?.json === retainedAfter.get(id)?.json)
      && pendingLaunchIds.every(id => pendingLaunches.get(id)?.json === launchesAfter.get(id)?.json);
    const deliveryPreserved = retainedPreserved && deliveryIds.every((id) => {
      const before = deliveriesBefore.get(id);
      const after = deliveriesAfter.get(id);
      return before && after && !after.cold && before.json === after.json;
    });
    if (externalOutcome.error) note(`separate writer: ${externalOutcome.error}`);
    /* Keep completion separate from the elapsed time of an unfinished activation. */
    const activationOf = (report: Record<string, unknown>, since: number | null) => {
      const value = (report.activation ?? {}) as { completed?: boolean; ms?: number | null; eventLoopMaxMs?: number };
      return {
        completed: value.completed === true,
        ms: value.completed === true ? finite(value.ms) : since === null ? 0 : Math.max(0, workersCheckedAt - since),
        eventLoopMaxMs: Number.isFinite(value.eventLoopMaxMs) ? Number(value.eventLoopMaxMs) : 0,
      };
    };
    /* Every runtime-host call either release made, read from its production
       client: the time the gate's own traffic took, and every timeout and
       transport failure of any call, the releases' own startup included. */
    const rpcOf = (report: Record<string, unknown>) => (report.runtimeRpc ?? {}) as { requests?: number; timeouts?: number; failures?: number; maxMs?: number; latencies?: unknown };
    const rpcReports = [rpcOf(aReport), rpcOf(bReport)];
    const rpcLatencies = rpcReports.flatMap((report) => numbers(report.latencies));
    const runtimeRpc = {
      requests: rpcReports.reduce((sum, report) => sum + finite(report.requests), 0),
      p95Ms: latencySummary(rpcLatencies).p95Ms,
      maxMs: Math.round(Math.max(latencySummary(rpcLatencies).maxMs, ...rpcReports.map((report) => finite(report.maxMs)))),
      timeouts: rpcReports.reduce((sum, report) => sum + finite(report.timeouts), 0),
      failures: rpcReports.reduce((sum, report) => sum + finite(report.failures), 0),
      hostAlive: !runtimeHost.exited(),
    };
    note(`runtime host calls: ${JSON.stringify(runtimeRpc)}${runtimeHost.exited() ? `; the runtime host exited: ${runtimeHost.log().slice(-3).join(" | ")}` : ""}`);
    const incumbentActivation = activationOf(aReport, aStartedAt);
    const successorActivation = activationOf(bReport, switchedAt);
    note(`activations: release A ${JSON.stringify(aReport.activation ?? null)}, release B ${JSON.stringify(bReport.activation ?? null)}`);
    /* The releases and their workers are done; the browser opens the board of
       a production server over the history they left. A structural run, or
       one under an induced fault, is a refusal already and skips it. */
    for (const pid of workerPids) { try { process.kill(pid, "SIGCONT"); process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    let browser: CandidateBrowserMeasurements | null = null;
    /* A run that holds the server is refused by what the browser half measures, so it runs it. */
    const serverStall = induced.includes("server-stall");
    if (!serverStall && (scale < 1 || inducedDelayMs || induced.length)) note("browser: skipped, this run is a refusal already");
    else {
      try {
        browser = await browserPhase({
          root, env, registry: dataset.filename, conversations: dataset.conversations,
          keys: entrySubjects.map(({ key, servers }) => ({ key, servers })), children, note,
          ...(serverStall ? { inducedStallMs: INDUCED_SERVER_STALL_MS } : {}),
        });
      } catch (error) {
        note(`browser: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const measurements: CandidatePerformanceMeasurements = {
      dataset: { scale, rows: dataset.rows, coldRows: dataset.coldRows, payloadBytes: dataset.payloadBytes, transcripts: dataset.conversations.length, seedMs: Math.round(dataset.seedMs), receipts: dataset.receipts },
      firstBoot: {
        registryOpenMs: finite(aReport.registryOpenMs),
        firstSnapshotMs: finite(aReport.snapshotMs),
        coldProjectionMs: finite(aReport.firstProjectionMs),
        firstUsableMs: finite(aReport.firstUsableMs),
        eventLoopMaxMs: finite(aReport.bootLoopMaxMs),
        coldBuild: aBuilds.cold ?? { sequence: 0, buildMs: 0 },
      },
      activation: {
        incumbentMs: incumbentActivation.ms,
        successorMs: successorActivation.ms,
        incumbentCompleted: incumbentActivation.completed,
        successorCompleted: successorActivation.completed,
        eventLoopMaxMs: Math.round(Math.max(incumbentActivation.eventLoopMaxMs, successorActivation.eventLoopMaxMs)),
      },
      grantWrites: {
        ...latencySummary(numbers(aWrites.latencies)),
        mismatches: finite(aWrites.mismatches),
        failures: finite(aWrites.failures) + (aOutcome.completed ? 0 : 1),
      },
      externalWrites: {
        ...latencySummary(externalLatencies),
        mismatches: finite(externalOutcome.report.mismatches),
        failures: finite(externalOutcome.report.failures) + (externalOutcome.completed ? 0 : 1),
      },
      keyedOperationReads: latencySummary(numbers(aReport.keyedLatencies)),
      eventLoop: {
        p95Ms: Math.round(Math.max(...loops.map((value) => Number(value.p95Ms ?? 0))) * 10) / 10,
        maxMs: Math.round(Math.max(...loops.map((value) => Number(value.maxMs ?? 0))) * 10) / 10,
      },
      projection: {
        warmBuilds: latencySummary([...aBuilds.warm, ...bBuilds.warm]),
        queueWait: latencySummary([...aBuilds.waits, ...bBuilds.waits]),
      },
      scopeRequests: {
        ...latencySummary(requestLatencies),
        scopes: SCOPES,
        failures: scopeFailures,
        maxQueueDepth: Math.max(...queues.map((queue) => finite(queue.maxWaiting))),
        refused: queues.reduce((sum, queue) => sum + finite(queue.refused), 0),
        expired: queues.reduce((sum, queue) => sum + finite(queue.expired), 0),
      },
      worker: {
        spawns: finite((aReport.projectionWorker as { spawns?: number } | undefined)?.spawns),
        timeoutRetirements: finite(aReport.timeoutRetirements) + finite(bReport.timeoutRetirements),
        pidStable: (aReport.projectionWorker as { pidStable?: boolean } | undefined)?.pidStable === true,
      },
      stability,
      handover: {
        successor: {
          completed: bOutcome.completed && bOutcome.exitCode === 0,
          exitCode: bOutcome.exitCode,
          signal: bOutcome.signal,
          readyMs: bReady ? Math.round(bReady.readyMs) : Math.round(performance.now() - successorStarted),
          registryOpenMs: finite(bReport.registryOpenMs),
          snapshotMs: finite(bReport.snapshotMs),
          firstProjectionMs: finite(bReport.firstProjectionMs),
          archived: finite(bReport.archived),
          grantMismatches: bOutcome.completed ? finite(bReport.grantMismatches) : dataset.grantSubjects.length,
          adoptionMs: adopted && switchedAt !== null ? Math.max(0, adopted.adoptedAt - switchedAt) : Math.round(performance.now() - successorStarted),
          adopted: adopted ? Object.keys(adopted.pids).length : 0,
        },
        switched: switchedAt !== null,
        demotionExitCode: switchedAt !== null && aReport.exitPath === "demoted" ? aOutcome.exitCode : null,
        servingRelease: readTarget(targetFile) === "b" ? "successor" : "incumbent",
        serving,
      },
      workers: {
        count: workers.length,
        rehosted,
        answering: finalPings.filter((answer) => answer !== null).length,
        progressGapMaxMs: Math.round(progressGapMaxMs),
        lostProgress,
        repeatedProgress,
        failedPings,
      },
      sqliteBusy: finite(aReport.busy) + finite(bReport.busy) + finite(externalOutcome.report.busy),
      runtimeTimeouts: runtimeRpc.timeouts,
      runtimeRpc,
      deliveryEvidence: { pending: dataset.pendingDeliveryIds.length, uncertain: dataset.uncertainDeliveryIds.length, retained: retainedDeliveryIds.length, pendingLaunches: pendingLaunchIds.length, preserved: deliveryPreserved },
      browser,
    };
    const timingWarnings: string[] = [];
    const breaches = candidatePerformanceBreaches(measurements, CANDIDATE_PERFORMANCE_BOUNDS, timingWarnings);
    return {
      checkedAt,
      runtime,
      bounds: CANDIDATE_PERFORMANCE_BOUNDS,
      measurements,
      breaches,
      timingWarnings,
      ...inducedFields,
      ok: breaches.length === 0 && !inducedDelayMs && !induced.length,
      ...(breaches.length ? { detail: breaches[0] } : {}),
      log,
    };
  } catch (error) {
    return {
      checkedAt,
      runtime,
      bounds: CANDIDATE_PERFORMANCE_BOUNDS,
      measurements: null,
      breaches: [],
      ...inducedFields,
      ok: false,
      detail: `the candidate performance gate could not run: ${error instanceof Error ? error.message : String(error)}`,
      log,
    };
  } finally {
    /* Every process this run started, by the pid it recorded. Workers and
       releases also leave on their own once this process is gone. */
    for (const pid of workerPids) { try { process.kill(pid, "SIGCONT"); process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    for (const started of children) if (started.exitCode === null && started.signalCode === null) started.kill("SIGKILL");
    await runtimeHost?.stop().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main && option("--seed-census")) {
  const { buildRegistryPerformanceDataset } = await import("@/lib/agent/registryPerformanceDataset");
  const dataset = buildRegistryPerformanceDataset(option("--seed-census")!);
  previousReleaseSchema(dataset.filename);
  console.log(JSON.stringify({ rows: dataset.rows, receipts: dataset.receipts, payloadBytes: dataset.payloadBytes }));
  process.exit(0);
}
if (import.meta.main && process.argv.includes("--probe-startup")) {
  await startupProbeMain();
  process.exit(0);
}
if (import.meta.main) {
  const mode: Mode = process.argv.includes("--writer") ? "writer"
    : process.argv.includes("--viewer") ? "viewer"
      : process.argv.includes("--worker") ? "worker" : "gate";
  if (mode === "worker") {
    await workerMain();
  } else if (mode === "writer") {
    await writerMain();
    process.exit(0);
  } else if (mode === "viewer") {
    await viewerMain();
  } else {
    const report = await gateMain();
    console.log(CANDIDATE_PERFORMANCE_REPORT_PREFIX + JSON.stringify(report));
    process.exit(report.ok ? 0 : 1);
  }
}
