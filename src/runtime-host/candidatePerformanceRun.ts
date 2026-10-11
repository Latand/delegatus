/* #2761: the candidate performance gate's runner. Run directly, this file is
   the gate:

     bun run src/runtime-host/candidatePerformanceRun.ts [--scale <0..1>]

   It builds the synthetic registry (registryPerformanceDataset.ts) in a private
   directory, returns it to the schema the previous release left, and then acts
   as a Viewer opening it:

   - first boot: the registry opens and upgrades, the first snapshot is taken,
     and the first board projection is built by a cold projection worker;
   - warm operation: this process writes grant-bearing rows while a second
     process does the same, keyed operation-id reads run, and eight board
     scopes poll through the real `/api/files` handler and its worker;
   - release handover: a successor process opens the same registry, runs the
     archive pass and decides the same grants while this one keeps writing and
     serving.

   It prints one report line (`CANDIDATE_PERFORMANCE_REPORT_PREFIX`) and exits
   non-zero when a bound is breached. `verify-candidate` runs it inside a
   container from the candidate image. Everything it creates sits under one
   temporary directory removed on exit; it never reads the operator's state.

   `--induce-slow-ms <n>` holds every write of this process for n ms. It exists
   so the gate's own test can prove a slow candidate is refused. */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";

import {
  CANDIDATE_PERFORMANCE_BOUNDS,
  CANDIDATE_PERFORMANCE_REPORT_PREFIX,
  candidatePerformanceBreaches,
  latencySummary,
  type CandidatePerformanceEvidence,
  type CandidatePerformanceMeasurements,
} from "./candidatePerformance";

const SCOPES = 8;
const WARM_MS = 12_000;
const HANDOVER_MS = 10_000;
const WRITE_INTERVAL_MS = 60;
const SCOPE_ROUND_MS = 1_500;
const KEYED_READ_INTERVAL_MS = 150;
/** A successor still silent after this counts as a runtime timeout. */
const SUCCESSOR_DEADLINE_MS = 60_000;
const CHILD_DEADLINE_MS = 120_000;
const BUSY = /SQLITE_BUSY|database is locked/i;

type Mode = "gate" | "writer" | "successor";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** Every store here opens a registry the dataset already imported. */
const importedAlready = (): never => { throw new Error("the candidate performance registry was not imported"); };

function busyWait(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) { /* a deliberately slow candidate */ }
}

/** Every child shares the gate's private environment and nothing else. */
function sandboxEnvironment(root: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    TMPDIR: path.join(root, "tmp"),
    LLV_STATE_DIR: path.join(root, "state"),
    LLV_AGENT_REGISTRY_SQLITE: "sqlite",
    /* No control URL is reachable from here: ticks and notifications fail fast. */
    LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1",
    DELEGATUS_TELEMETRY: "0",
    DO_NOT_TRACK: "1",
  };
  for (const name of ["LLV_CANDIDATE_PERFORMANCE_BIN", "LLV_BUN_EXECUTABLE"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

function runtimeBin(): string {
  return process.env.LLV_CANDIDATE_PERFORMANCE_BIN || process.execPath;
}

function child(mode: Exclude<Mode, "gate">, args: string[], env: Record<string, string>): { process: ChildProcess; result: Promise<Record<string, unknown>> } {
  const started = spawn(runtimeBin(), [path.join(import.meta.dir, "candidatePerformanceRun.ts"), `--${mode}`, ...args], {
    cwd: process.cwd(),
    env: env as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  started.stdout?.on("data", (chunk) => { stdout += String(chunk); });
  started.stderr?.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4_000); });
  const result = new Promise<Record<string, unknown>>((resolve) => {
    const timer = setTimeout(() => { started.kill("SIGKILL"); }, CHILD_DEADLINE_MS);
    started.once("exit", (code, signal) => {
      clearTimeout(timer);
      const line = stdout.trim().split("\n").filter(Boolean).at(-1);
      try {
        resolve({ ...JSON.parse(line ?? "{}") as Record<string, unknown>, exitCode: code, signal });
      } catch {
        resolve({ error: `${mode} produced no report`, exitCode: code, signal, stderr: stderr.split("\n").slice(-10) });
      }
    });
  });
  return { process: started, result };
}

/* ---- the second writer: another process with its own connection ---- */
async function writerMain(): Promise<void> {
  const filename = option("--registry")!;
  const keys = JSON.parse(option("--keys")!) as Array<{ key: string; servers: string[] }>;
  const duration = Number(option("--duration-ms"));
  const { normalizeRegistry } = await import("@/lib/agent/registry");
  const { SqliteAgentRegistryStore } = await import("@/lib/agent/sqliteRegistryStore");
  const store = new SqliteAgentRegistryStore(filename, { normalize: normalizeRegistry, initialSnapshot: importedAlready });
  const latencies: number[] = [];
  let mismatches = 0;
  let failures = 0;
  let busy = 0;
  const until = performance.now() + duration;
  for (let index = 0; performance.now() < until; index++) {
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
  console.log(JSON.stringify({ latencies, mismatches, failures, busy }));
}

/* ---- the successor release: a second Viewer opening the same registry ---- */
async function successorMain(): Promise<void> {
  const filename = option("--registry")!;
  const subjects = JSON.parse(option("--subjects")!) as Array<{ collection: "entries" | "receipts"; key: string; servers: string[] }>;
  const started = performance.now();
  const { normalizeRegistry } = await import("@/lib/agent/registry");
  const { SqliteAgentRegistryStore } = await import("@/lib/agent/sqliteRegistryStore");
  let busy = 0;
  try {
    const store = new SqliteAgentRegistryStore(filename, { normalize: normalizeRegistry, initialSnapshot: importedAlready });
    const snapshotStarted = performance.now();
    store.readOnlySnapshot();
    const snapshotMs = performance.now() - snapshotStarted;
    /* One bounded pass, as the reaper's hygiene runs it each cycle. */
    const archived = store.archiveInactive();
    const decided = store.read((file) => subjects.map((subject) =>
      [...(file[subject.collection][subject.key]?.launchProfile?.mcpServers ?? [])]));
    const grantMismatches = decided.filter((servers, index) => JSON.stringify(servers) !== JSON.stringify(subjects[index]!.servers)).length;
    store.close();
    console.log(JSON.stringify({ readyMs: performance.now() - started, snapshotMs, archived, grantMismatches, busy }));
  } catch (error) {
    if (BUSY.test(String(error))) busy += 1;
    console.log(JSON.stringify({ error: String(error), busy }));
  }
}

/** Return the seeded registry to the schema the previous release left: the
    archive view without identity equalities and no generation identity index.
    The first boot then pays the upgrade a real release pays. */
function previousReleaseSchema(filename: string): void {
  const { Database } = process.getBuiltinModule("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(filename);
  try {
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

/** What an active worker's host relies on: who owns it, under which claim, and its host. */
function hostingOf(json: string): string {
  const entry = JSON.parse(json) as Record<string, unknown>;
  return JSON.stringify(["status", "claimOwner", "claimEpoch", "host", "structuredHost", "pendingAction", "artifactPath"].map((field) => entry[field] ?? null));
}

async function gateMain(): Promise<CandidatePerformanceEvidence> {
  const checkedAt = new Date().toISOString();
  const runtime = `bun ${Bun.version}`;
  const scale = Number(option("--scale") ?? "1");
  const inducedDelayMs = Number(option("--induce-slow-ms") ?? "0");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-candidate-performance-"));
  const log: string[] = [];
  const note = (line: string) => { log.push(line); if (log.length > 40) log.shift(); };
  try {
    const env = sandboxEnvironment(root);
    for (const directory of [env.HOME!, env.XDG_CONFIG_HOME!, env.TMPDIR!, env.LLV_STATE_DIR!]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    /* This process is the Viewer under test: its own state resolution, worker
       launch and registry backend all come from the sandbox. */
    for (const [name, value] of Object.entries(env)) if (name !== "PATH") process.env[name] = value;
    delete (process.env as Record<string, string | undefined>).NODE_ENV;
    delete process.env.LLV_FILES_RESPONSE_WORKER;
    delete process.env.LLV_FILES_RESPONSE_WORKER_DISABLED;

    const { buildRegistryPerformanceDataset, REGISTRY_PERFORMANCE_SHAPE, scaledRegistryPerformanceShape } = await import("@/lib/agent/registryPerformanceDataset");
    const dataset = buildRegistryPerformanceDataset(env.LLV_STATE_DIR!, scale >= 1 ? REGISTRY_PERFORMANCE_SHAPE : scaledRegistryPerformanceShape(scale));
    previousReleaseSchema(dataset.filename);
    note(`dataset ${dataset.rows} rows, ${dataset.coldRows} cold, seeded in ${Math.round(dataset.seedMs)}ms`);
    const deliveryIds = [...dataset.pendingDeliveryIds, ...dataset.uncertainDeliveryIds];
    const deliveriesBefore = rowsOf(dataset.filename, "heldDeliveries", deliveryIds);
    const entriesBefore = rowsOf(dataset.filename, "entries", dataset.activeEntryKeys);

    /* ---- first boot ---- */
    const openStarted = performance.now();
    const { agentRegistry, normalizeRegistry } = await import("@/lib/agent/registry");
    const registry = agentRegistry();
    registry.storageDiagnostics();
    const registryOpenMs = performance.now() - openStarted;
    const snapshotStarted = performance.now();
    registry.readOnlySnapshot();
    const firstSnapshotMs = performance.now() - snapshotStarted;
    const { GET, filesProjectionQueueDiagnostics } = await import("@/app/api/files/operatorProjection");
    const { drainFilesResponseWorker, filesResponseWorkerPoolDiagnostics } = await import("@/lib/scanner/filesResponseWorker");
    const { SqliteAgentRegistryStore, registryRowsMatching } = await import("@/lib/agent/sqliteRegistryStore");
    const scopeUrl = (scope: number) => `http://127.0.0.1/api/files?view=summary&path=${encodeURIComponent(dataset.conversationPaths[scope * 7 % dataset.conversationPaths.length]!)}`;
    const coldStarted = performance.now();
    const cold = await GET(new Request(scopeUrl(0)));
    await cold.arrayBuffer();
    const coldProjectionMs = performance.now() - coldStarted;
    if (cold.status !== 200) throw new Error(`the first projection answered ${cold.status}`);
    const workerPid = filesResponseWorkerPoolDiagnostics().pid;
    note(`first boot: open ${Math.round(registryOpenMs)}ms, snapshot ${Math.round(firstSnapshotMs)}ms, cold projection ${Math.round(coldProjectionMs)}ms`);

    /* ---- warm operation and handover, measured together ---- */
    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    const store = new SqliteAgentRegistryStore(dataset.filename, { normalize: normalizeRegistry, initialSnapshot: importedAlready });
    const entrySubjects = dataset.grantSubjects.filter((subject) => subject.collection === "entries");
    const ownSubjects = entrySubjects.filter((_, index) => index % 2 === 0);
    const otherSubjects = entrySubjects.filter((_, index) => index % 2 === 1);
    const writeLatencies: number[] = [];
    let writeMismatches = 0;
    let writeFailures = 0;
    let sqliteBusy = 0;
    let runtimeTimeouts = 0;
    let running = true;
    const writer = (async () => {
      for (let index = 0; running; index++) {
        const subject = ownSubjects[index % ownSubjects.length]!;
        const started = performance.now();
        try {
          const servers = store.mutate((file) => {
            const entry = file.entries[subject.key]!;
            entry.updatedAt = new Date().toISOString();
            if (inducedDelayMs > 0) busyWait(inducedDelayMs);
            return [...(entry.launchProfile?.mcpServers ?? [])];
          }, false, { operationName: "candidate-performance-writer" }).result;
          writeLatencies.push(performance.now() - started);
          if (JSON.stringify(servers) !== JSON.stringify(subject.servers)) writeMismatches += 1;
        } catch (error) {
          if (BUSY.test(String(error))) sqliteBusy += 1;
          else writeFailures += 1;
          note(`writer: ${String(error).slice(0, 200)}`);
        }
        await Bun.sleep(WRITE_INTERVAL_MS);
      }
    })();
    const keyedLatencies: number[] = [];
    const keyed = (async () => {
      for (let index = 0; running; index++) {
        const operationId = (index % 4 === 3 ? dataset.hotOperationIds : dataset.coldOperationIds)[index % 97 % Math.max(1, dataset.coldOperationIds.length)]
          ?? dataset.coldOperationIds[0]!;
        const started = performance.now();
        store.read((file) => registryRowsMatching(file, "heldDeliveries", "command.operationId", operationId).length);
        keyedLatencies.push(performance.now() - started);
        await Bun.sleep(KEYED_READ_INTERVAL_MS);
      }
    })();
    const external = child("writer", [
      "--registry", dataset.filename,
      "--keys", JSON.stringify(otherSubjects.map(({ key, servers }) => ({ key, servers }))),
      "--duration-ms", String(WARM_MS + HANDOVER_MS),
    ], env);
    const requestLatencies: number[] = [];
    let scopeFailures = 0;
    let timeoutRetirements = 0;
    let lastRetirement = filesResponseWorkerPoolDiagnostics().lastRetirement;
    const scopePaths = new Map<number, string[]>();
    let stableProjection = true;
    const round = async (final = false) => {
      await Promise.all(Array.from({ length: SCOPES }, async (_, scope) => {
        const started = performance.now();
        try {
          const response = await GET(new Request(scopeUrl(scope)));
          const body = await response.text();
          requestLatencies.push(performance.now() - started);
          if (response.status !== 200) { scopeFailures += 1; return; }
          const files = (JSON.parse(body) as { files?: Array<{ path?: string }> }).files ?? [];
          const paths = files.map((file) => file.path ?? "").sort();
          const previous = scopePaths.get(scope);
          if (final && previous && JSON.stringify(previous) !== JSON.stringify(paths)) stableProjection = false;
          scopePaths.set(scope, paths);
        } catch (error) {
          scopeFailures += 1;
          if (/timed out/i.test(String(error))) runtimeTimeouts += 1;
          note(`scope ${scope}: ${String(error).slice(0, 200)}`);
        }
      }));
      const retirement = filesResponseWorkerPoolDiagnostics().lastRetirement;
      if (retirement !== lastRetirement && retirement?.includes("timed out")) timeoutRetirements += 1;
      lastRetirement = retirement;
    };
    const phaseUntil = async (ms: number) => {
      const until = performance.now() + ms;
      while (performance.now() < until) {
        const started = performance.now();
        await round();
        await Bun.sleep(Math.max(0, SCOPE_ROUND_MS - (performance.now() - started)));
      }
    };
    await phaseUntil(WARM_MS);
    note("warm operation measured; starting the successor release");
    const successorStarted = performance.now();
    const successor = child("successor", [
      "--registry", dataset.filename,
      "--subjects", JSON.stringify(dataset.grantSubjects),
    ], env);
    const successorDeadline = setTimeout(() => successor.process.kill("SIGKILL"), SUCCESSOR_DEADLINE_MS);
    await phaseUntil(HANDOVER_MS);
    const successorReport = await successor.result;
    clearTimeout(successorDeadline);
    const successorElapsed = performance.now() - successorStarted;
    if (successorReport.signal === "SIGKILL") runtimeTimeouts += 1;
    running = false;
    await Promise.all([writer, keyed]);
    const externalReport = await external.result;
    /* Writes stopped: every scope must show the rows it showed a round ago. */
    await round();
    await round(true);
    loop.disable();
    store.close();

    const queue = filesProjectionQueueDiagnostics();
    const pool = filesResponseWorkerPoolDiagnostics();
    const deliveriesAfter = rowsOf(dataset.filename, "heldDeliveries", deliveryIds);
    const entriesAfter = rowsOf(dataset.filename, "entries", dataset.activeEntryKeys);
    const deliveryPreserved = deliveryIds.every((id) => {
      const before = deliveriesBefore.get(id);
      const after = deliveriesAfter.get(id);
      return before && after && !after.cold && before.json === after.json;
    });
    const entriesPreserved = dataset.activeEntryKeys.every((key) => {
      const before = entriesBefore.get(key);
      const after = entriesAfter.get(key);
      return before && after && !after.cold && hostingOf(before.json) === hostingOf(after.json);
    });
    const externalLatencies = Array.isArray(externalReport.latencies) ? externalReport.latencies as number[] : [];
    sqliteBusy += Number(externalReport.busy ?? 0) + Number(successorReport.busy ?? 0);
    if (externalReport.error) note(`external writer: ${String(externalReport.error)}`);
    if (successorReport.error) note(`successor: ${String(successorReport.error).slice(0, 300)}`);
    const warmBuilds = queue.recent.slice(1).map((build) => build.buildMs);
    const measurements: CandidatePerformanceMeasurements = {
      dataset: { rows: dataset.rows, coldRows: dataset.coldRows, payloadBytes: dataset.payloadBytes, seedMs: Math.round(dataset.seedMs) },
      firstBoot: { registryOpenMs: Math.round(registryOpenMs), firstSnapshotMs: Math.round(firstSnapshotMs), coldProjectionMs: Math.round(coldProjectionMs) },
      grantWrites: { ...latencySummary(writeLatencies), mismatches: writeMismatches, failures: writeFailures },
      externalWrites: {
        ...latencySummary(externalLatencies),
        mismatches: Number(externalReport.mismatches ?? 0),
        failures: Number(externalReport.failures ?? 0) + (externalReport.error ? 1 : 0),
      },
      keyedOperationReads: latencySummary(keyedLatencies),
      eventLoop: { p95Ms: Math.round(loop.percentile(95) / 1e5) / 10, maxMs: Math.round(loop.max / 1e5) / 10 },
      projection: { warmBuilds: latencySummary(warmBuilds), queueWait: latencySummary(queue.recent.map((build) => build.waitMs)) },
      scopeRequests: {
        ...latencySummary(requestLatencies),
        scopes: SCOPES,
        failures: scopeFailures,
        maxQueueDepth: queue.maxWaiting,
        refused: queue.refused,
        expired: queue.expired,
      },
      worker: { spawns: pool.spawns, timeoutRetirements, pidStable: workerPid !== null && pool.pid === workerPid && pool.spawns === 1 },
      handover: {
        successorReadyMs: Math.round(Number(successorReport.readyMs ?? successorElapsed)),
        successorSnapshotMs: Math.round(Number(successorReport.snapshotMs ?? 0)),
        successorArchived: Number(successorReport.archived ?? 0),
        grantMismatches: successorReport.error ? dataset.grantSubjects.length : Number(successorReport.grantMismatches ?? 0),
      },
      sqliteBusy,
      runtimeTimeouts,
      deliveryEvidence: { pending: dataset.pendingDeliveryIds.length, uncertain: dataset.uncertainDeliveryIds.length, preserved: deliveryPreserved },
      activeWorkers: { entries: dataset.activeEntryKeys.length, preserved: entriesPreserved },
      stableProjection,
    };
    await drainFilesResponseWorker("candidate performance gate complete");
    const breaches = candidatePerformanceBreaches(measurements);
    return {
      checkedAt,
      runtime,
      bounds: CANDIDATE_PERFORMANCE_BOUNDS,
      measurements,
      breaches,
      ...(inducedDelayMs > 0 ? { inducedDelayMs } : {}),
      ok: breaches.length === 0,
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
      ...(inducedDelayMs > 0 ? { inducedDelayMs } : {}),
      ok: false,
      detail: `the candidate performance gate could not run: ${error instanceof Error ? error.message : String(error)}`,
      log,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const mode: Mode = process.argv.includes("--writer") ? "writer" : process.argv.includes("--successor") ? "successor" : "gate";
  if (mode === "writer") {
    await writerMain();
    process.exit(0);
  }
  if (mode === "successor") {
    await successorMain();
    process.exit(0);
  }
  const report = await gateMain();
  if (process.env.LLV_CANDIDATE_PERFORMANCE_DEBUG_CHILDREN === "1") {
    console.error(Bun.spawnSync(["ps", "--ppid", String(process.pid), "-o", "pid,args"]).stdout.toString());
  }
  console.log(CANDIDATE_PERFORMANCE_REPORT_PREFIX + JSON.stringify(report));
  process.exit(report.ok ? 0 : 1);
}
