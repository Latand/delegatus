/** Reproducible isolated worker costs. See docs/perf/viewer-idle-workers.md. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AgentRegistry, agentRegistry } from "../src/lib/agent/registry";
import { emptyLaunchProfile } from "../src/lib/accounts/migration/contracts";
import { reconcileMigrationInventory } from "../src/lib/accounts/migration/coordinator";
import { reconcileFileControllers } from "../src/lib/scanner";
import { AccountMigrationController, reconcileAccountMigrationCycle, startAccountMigrationController } from "../src/lib/accounts/migration/controller";
import { buildFilesResponseInWorker, drainFilesResponseWorker, filesResponseWorkerPoolDiagnostics } from "../src/lib/scanner/filesResponseWorker";
import type { FileEntry } from "../src/lib/types";

const [mode, fixtureArg, gapArg] = process.argv.slice(2);
if (!process.env.LLV_STATE_DIR || !process.env.TMPDIR || !fixtureArg) {
  throw new Error("Name private LLV_STATE_DIR, HOME, XDG_CONFIG_HOME, TMPDIR and a fixture directory");
}
const scratch = path.resolve(process.env.TMPDIR);
for (const key of ["HOME", "XDG_CONFIG_HOME", "LLV_STATE_DIR"] as const) {
  const relative = path.relative(scratch, path.resolve(process.env[key] ?? "/"));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${key} must name a child of the private temp root`);
  }
}
const fixture = path.resolve(fixtureArg);
const rows = 7098;
const scanned = 560;
const now = Date.parse("2026-10-16T00:00:00.000Z");
const registryFile = path.join(process.env.LLV_STATE_DIR, "agent-registry.json");
if (fs.existsSync(registryFile) || fs.existsSync(path.join(process.env.LLV_STATE_DIR, "agent-registry.sqlite"))) {
  throw new Error("Use a fresh state root for each sample");
}
function emit(value: unknown) { process.stdout.write(JSON.stringify(value) + "\n"); }
function io(pid = process.pid): number {
  return Number(/^rchar: (\d+)$/m.exec(fs.readFileSync(`/proc/${pid}/io`, "utf8"))?.[1] ?? 0);
}
if (mode === "prepare") {
  if (fs.existsSync(fixture)) throw new Error("Fixture already exists; keep the original immutable seed");
  fs.mkdirSync(path.join(fixture, "transcripts"), { recursive: true });
  const files = Array.from({ length: scanned }, (_, index): FileEntry => {
    const pathname = path.join(fixture, "transcripts", `session-${index}.jsonl`);
    const content = JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/fixture" } }) + "\n";
    fs.writeFileSync(pathname, content);
    fs.utimesSync(pathname, now / 1000, now / 1000);
    return { path: pathname, root: "codex-sessions", name: `session-${index}`, project: "fixture", title: `Session ${index}`,
      engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: now / 1000, size: Buffer.byteLength(content),
      activity: "idle", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null,
      nativeForkSourceThreadId: null, sessionStartedAt: new Date(now).toISOString() };
  });
  const registry = new AgentRegistry(registryFile, undefined, undefined, { sqliteMode: "off" });
  registry.reconcileConversations(Array.from({ length: rows }, (_, index) => ({ engine: "codex" as const,
    path: files[index]?.path ?? `/history/session-${index}.jsonl`, accountId: null, launchProfile: emptyLaunchProfile({ cwd: "/repo/fixture" }),
    turn: { state: "idle" as const, source: "empty" as const, terminalAt: null }, observedAt: new Date(now).toISOString() })));
  const seed = registry.snapshot();
  seed.conversations = Object.fromEntries(Object.values(seed.conversations).map((conversation, index) => {
    const id = `conversation_fixture-${String(index).padStart(5, "0")}` as const;
    return [id, { ...conversation, id }];
  }));
  const body = JSON.stringify(seed);
  fs.writeFileSync(path.join(fixture, "registry.json"), body);
  fs.writeFileSync(path.join(fixture, "files.json"), JSON.stringify(files));
  registry.close();
  emit({ mode, rows, scanned, seedBytes: Buffer.byteLength(body), seedSha256: crypto.createHash("sha256").update(body).digest("hex") });
} else {
  fs.mkdirSync(path.dirname(registryFile), { recursive: true });
  fs.copyFileSync(path.join(fixture, "registry.json"), registryFile, fs.constants.COPYFILE_EXCL);
  const files = JSON.parse(fs.readFileSync(path.join(fixture, "files.json"), "utf8")) as FileEntry[];
  if (mode === "migration") {
    process.env.LLV_ACCOUNT_CONTROLLER_INVENTORY_WORKER = "1";
    // The worker and its scanner consumers share one production registry.
    const registry = agentRegistry();
    if (registry.storageDiagnostics().backendMode !== "sqlite") throw new Error("Measurement requires the SQLite registry backend");
    let phaseReadBytes: Record<string, number> = {};
    const phase = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
      const before = io();
      try { return await work(); } finally { phaseReadBytes[name] = (phaseReadBytes[name] ?? 0) + io() - before; }
    };
    let inventoryPaths = 0;
    let linksRefreshed = false;
    const controller = new AccountMigrationController(registry, { tick: async () => {} }, null, {
      scan: async () => ({ files, projectCatalog: [], complete: true }),
      reconcileInventory: (current, changed) => {
        inventoryPaths = changed.length;
        return phase("inventory", () => reconcileMigrationInventory(current, changed, { readOnlySnapshot: true, incrementalInventory: true }));
      },
      reconcileFiles: (entries, options) => {
        linksRefreshed = options?.inventoryChanged !== false;
        return phase("files", () => reconcileFileControllers(entries, options));
      },
      reconcileMigrationCycle: (current, quota) => phase("migrations", () => reconcileAccountMigrationCycle(current, quota)),
      // Account/provider processes, task writes and OS reaping are outside
      // this inventory measurement. Migration reconciliation itself is real.
      reconcileRuntime: async () => {}, reconcileTaskStore: async () => {}, syncRouting: async () => {},
    });
    // Drive the real startup in both revisions, including the baseline's
    // missing preparation. Cancel only the polling timer this start created.
    const runtime = globalThis as typeof globalThis & {
      __llvAccountMigrationController?: AccountMigrationController;
      __llvAccountMigrationStopPolling?: () => void;
    };
    runtime.__llvAccountMigrationController = controller;
    const bootstrapStart = { cpu: process.cpuUsage(), read: io(), ms: performance.now() };
    await startAccountMigrationController();
    runtime.__llvAccountMigrationStopPolling?.();
    const bootstrapCpu = process.cpuUsage(bootstrapStart.cpu);
    const bootstrap = { cpuMs: (bootstrapCpu.user + bootstrapCpu.system) / 1000, readBytes: io() - bootstrapStart.read,
      wallMs: performance.now() - bootstrapStart.ms };
    const pass = async () => {
      phaseReadBytes = {};
      inventoryPaths = 0;
      linksRefreshed = false;
      const before = { cpu: process.cpuUsage(), read: io(), ms: performance.now() };
      await controller.poll();
      const cpu = process.cpuUsage(before.cpu);
      return { cpuMs: (cpu.user + cpu.system) / 1000, readBytes: io() - before.read, wallMs: performance.now() - before.ms, inventoryPaths, linksRefreshed, phaseReadBytes };
    };
    const cold = await pass();
    const settling = await pass();
    const idle = [];
    for (let cycle = 0; cycle < 6; cycle++) idle.push(await pass());
    files[0] = { ...files[0]!, title: "Changed fixture title" };
    const delta = await pass();
    registry.close();
    emit({ mode, rows, scanned, bootstrap, cold, settling, idle, delta, cadenceSeconds: 60,
      cpuMsPerScheduledMinute: idle.reduce((sum, row) => sum + row.cpuMs, 0) / idle.length,
      cpuMsPerMinute: idle.reduce((sum, row) => sum + row.cpuMs, 0) * 60000
        / idle.reduce((sum, row) => sum + 60000 + row.wallMs, 0),
      bytesReadPerIdleCycle: idle.reduce((sum, row) => sum + row.readBytes, 0) / idle.length });
  } else if (mode === "files") {
    const gapMs = Number(gapArg ?? 65000);
    if (!Number.isFinite(gapMs) || gapMs < 61000) throw new Error("Use the real idle threshold: gap must exceed 60 seconds");
    const request = { type: "project" as const, url: "http://127.0.0.1/api/files?view=summary", headers: [] as Array<[string, string]>,
      snapshot: { files, projectCatalog: [], complete: true } };
    const runtime = { launch: { executable: process.execPath, workerPath: path.resolve("src/lib/filesResponse.worker.ts") },
      env: { ...process.env, NODE_ENV: "production" as const, LLV_FILES_RESPONSE_WORKER: "1" }, timeoutMs: 60000 };
    const started = performance.now();
    const initialSpawns = filesResponseWorkerPoolDiagnostics().spawns;
    const workerSamples: Array<{ cpuTicks: number; readBytes: number }> = [];
    for (let build = 0; build < 2; build++) {
      await buildFilesResponseInWorker(request, runtime);
      const pid = filesResponseWorkerPoolDiagnostics().pid;
      if (pid) {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ");
        workerSamples.push({ cpuTicks: Number(stat[11]) + Number(stat[12]), readBytes: io(pid) });
      }
      if (build === 0) await new Promise(resolve => setTimeout(resolve, gapMs));
    }
    const elapsedMs = performance.now() - started;
    const spawns = filesResponseWorkerPoolDiagnostics().spawns - initialSpawns;
    await drainFilesResponseWorker("benchmark complete");
    emit({ mode, rows, scanned, gapMs, elapsedMs, builds: 2, spawns, respawns: spawns - 1,
      respawnsPerHour: (spawns - 1) * 3600000 / elapsedMs, workerSamples });
  } else throw new Error("Mode must be prepare, migration or files");
}
