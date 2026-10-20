import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { claimProcessTempRoot, TEST_RUN_TEMP_PREFIX } from "@/lib/tempDirs";
import type { StructuredStartupDependencies } from "@/lib/runtime/startup";
import type { RuntimeHostClient } from "@/lib/runtime/client";

/** Run in an isolated HOME/config/state/temp root through gate-slot.sh. The
 * input must be an offline SQLite backup, never the serving registry. Preserve
 * retained conversations and memberships; remove every current source actuation row and cold pointer
 * before opening it, then add one deterministic hand-over refusal. */
export async function measureStartupRetries(source?: string) {
  const [{ AgentRegistry }, { emptyLaunchProfile }, { captureProcessIdentity }, { RuntimeJournal },
    { runStructuredHostStartup }, { adoptStructuredHostsAtStartup }, { bindStructuredDeliveryQueue }] = await Promise.all([
    import("@/lib/agent/registry"), import("@/lib/accounts/migration/contracts"), import("@/lib/processIdentity"),
    import("@/runtime-host/journal"), import("@/lib/viewerInstrumentation"), import("@/lib/runtime/startup"),
    import("@/lib/runtime/structuredDeliveryController"),
  ]);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-startup-measure-"));
  const sqlite = path.join(directory, "registry.sqlite");
  let retainedConversations = 0;
  if (source) {
    fs.copyFileSync(source, sqlite);
    const db = new Database(sqlite);
    try {
      retainedConversations = (db.query("SELECT count(*) AS n FROM registry_rows WHERE collection='conversations'").get() as { n: number }).n;
      for (const table of ["registry_rows", "registry_cold"]) {
        db.query(`DELETE FROM ${table} WHERE collection IN ('entries','receipts','heldDeliveries','deliveryOperationOwners','migrationIntents','pendingSupersedence')`).run();
      }
      db.exec("DELETE FROM registry_liveness_entries");
      db.exec("DELETE FROM registry_liveness_receipts");
    } finally { db.close(); }
  }
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: source ? "sqlite" : "off" });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const sessionId = "25300000-0000-0000-0000-000000000074";
  const artifactPath = path.join(directory, `${sessionId}.jsonl`);
  fs.writeFileSync(artifactPath, JSON.stringify({ payload: { type: "user_message" }, timestamp: "2026-10-16T12:00:00Z" }) + "\n");
  registry.reconcileConversations([{ engine: "codex", path: artifactPath, accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: directory }), turn: { state: "busy", source: "lifecycle", terminalAt: null }, observedAt: "2026-10-16T12:00:00Z" }]);
  registry.upsert({ key: { engine: "codex", sessionId }, artifactPath, cwd: directory, accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: directory }), status: "unhosted", host: null,
    structuredHost: { kind: "codex-app-server", endpoint: "stdio:released", process: null, eventCursor: 0, protocolVersion: "fixture",
      writerClaimEpoch: 3, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
    claimEpoch: 3, claimOwner: `structured-host:${JSON.stringify(captureProcessIdentity(process.pid))}`, pendingAction: "handoff" });
  const client = {
    readSession: async (identity) => journal.readSession(identity), snapshot: async () => journal.snapshot(),
    append: async event => journal.append(event), command: async command => journal.executeOperation(command),
    operationStatus: async operationId => journal.operationResult(operationId),
    effectBatch: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transitionOperation: async (operationId, status, details) => journal.transitionOperation(operationId, status, details),
  } as RuntimeHostClient;
  let clock = Date.parse("2026-10-16T12:00:00Z");
  const horizon = clock + 3_600_000;
  const dateNow = Date.now;
  Date.now = () => clock;
  const scheduled: { callback: () => void; at: number }[] = [];
  const schedule = (callback: () => void, delay: number) => { scheduled.push({ callback, at: clock + delay }); return { unref() {} }; };
  let fullPasses = 0;
  let rowPasses = 0;
  const dependencies: StructuredStartupDependencies = {
    registry, client, orchestratorSeats: () => [], refreshTranscriptState: async () => { fullPasses++; },
    resolveCodexOwner: () => null, resolveClaudeOwner: () => null, adoptClaude: async () => [],
    schedule, pipelineEvidence: () => ({ settled: new Set(), deferred: new Set() }),
  };
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  try {
    await runStructuredHostStartup(() => adoptStructuredHostsAtStartup(dependencies), () => {}, { schedule, jitterRatio: 0 });
    while (scheduled.length) {
      scheduled.sort((a, b) => a.at - b.at);
      const next = scheduled.shift()!;
      if (next.at > horizon) break;
      clock = next.at;
      const fullBefore = fullPasses;
      next.callback();
      const deadline = performance.now() + 120_000;
      while (!scheduled.length && performance.now() < deadline) await Bun.sleep(1);
      if (!scheduled.length) throw new Error("startup retry did not settle");
      if (fullPasses === fullBefore) rowPasses++;
    }
    const cpu = process.cpuUsage(cpuStart);
    return { simulatedHours: 1, retainedConversations, fullPasses, rowPasses,
      cpuMs: (cpu.user + cpu.system) / 1000, elapsedMs: performance.now() - wallStart };
  } finally {
    Date.now = dateNow;
    await bindStructuredDeliveryQueue([], { registry, client: null });
    journal.close(); registry.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function countAttributedWarningRecords(output: string, prefix: string, pid: number, role: string): { total: number; attributed: number } {
  const records = output.split(/\r?\n/).filter(line => line.startsWith(`${prefix} `));
  let attributed = 0;
  for (const line of records) {
    try {
      const payload = JSON.parse(line.slice(prefix.length + 1)) as { pid?: unknown; role?: unknown };
      if (payload.pid === pid && payload.role === role) attributed++;
    } catch { /* A split or malformed warning is an unattributed record. */ }
  }
  return { total: records.length, attributed };
}

/** Rehearse a built Next server's boot and restart with identical synthetic
 * history and a short revision writer. Run from the build's scratch export.
 * No runtime socket or account home is inherited by the server or writer. */
export async function measurePipelineAuthorityRestarts() {
  const { stopFixtureProcess } = await import("@/lib/testing/fixtureProcess");
  const { spawn } = await import("node:child_process");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-authority-restarts-"));
  const previousState = process.env.LLV_STATE_DIR;
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: "production", LLV_STATE_OWNER: "viewer",
    LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", NEXT_TELEMETRY_DISABLED: "1", DELEGATUS_TELEMETRY_OVERRIDE: "off" };
  for (const [name, suffix] of Object.entries({ HOME: "home", XDG_CONFIG_HOME: "config", TMPDIR: "tmp", LLV_STATE_DIR: "state" })) {
    env[name] = path.join(directory, suffix); fs.mkdirSync(env[name]!);
  }
  process.env.LLV_STATE_DIR = env.LLV_STATE_DIR;
  const rows: Array<{ generation: number; unreadable: number; syntheticUnavailable: number; leaseBudget: number;
    loopGap: number; performanceSummary: number; writer: { writes: number; busy: number }; attributedRefusals: number; attributedLeaseBudget: number }> = [];
  try {
    const [{ AgentRegistry }, { emptyLaunchProfile }, { buildPipeline, savePipelines }] = await Promise.all([
      import("@/lib/agent/registry"), import("@/lib/accounts/migration/contracts"), import("@/lib/pipelines/store"),
    ]);
    const state = env.LLV_STATE_DIR!;
    const role = { roleId: null, engine: "codex" as const, model: null, effort: null, access: "read-write" as const, promptScaffold: null };
    savePipelines(Array.from({ length: 1024 }, (_, i) => buildPipeline({ id: `synthetic-${i}`, task: "Synthetic startup evidence", project: "synthetic", repoDir: directory,
      stages: [{ id: "build", kind: "run", prompt: "build", next: null, effectiveRole: role }],
      srcPath: null, srcConversationId: null, now: "2026-10-19T00:00:00.000Z" })));
    const registry = new AgentRegistry(path.join(state, "agent-registry.json"));
    try {
      for (let i = 0; i < 64; i++) {
        const sessionId = `00000000-1111-0111-0111-${String(i).padStart(12, "0")}`;
        const artifactPath = path.join(directory, `${sessionId}.jsonl`);
        fs.writeFileSync(artifactPath, JSON.stringify({ type: "assistant", timestamp: "2026-10-19T00:00:00.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "Synthetic completed turn" }], stop_reason: "end_turn" } }) + "\n");
        const launchProfile = emptyLaunchProfile({ cwd: directory });
        registry.reconcileConversations([{ engine: "claude", path: artifactPath, accountId: null, launchProfile,
          turn: { state: "terminal", source: "assistant", terminalAt: "2026-10-19T00:00:00.000Z" }, observedAt: "2026-10-19T00:00:00.000Z" }]);
        registry.upsert({ key: { engine: "claude", sessionId }, artifactPath, cwd: directory, accountId: null, launchProfile, status: "unhosted", host: null,
          structuredHost: { kind: "claude-broker", endpoint: "stdio:released", process: null, eventCursor: 0, protocolVersion: "fixture",
            writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] }, claimEpoch: 1, claimOwner: null, pendingAction: null });
      }
    } finally { registry.close(); }
    for (const generation of [1, 2]) {
      const writer = spawn(process.execPath, ["-e", `
        const { Database } = await import("bun:sqlite");
        const db = new Database(process.argv[1]);
        let writes = 0, busy = 0;
        console.log("ready");
        const start = performance.now();
        const timer = setInterval(() => {
          try { db.query("UPDATE state_collections SET revision=revision+1 WHERE collection='pipelines'").run(); writes++; }
          catch (error) {
            if (!/database is (?:locked|busy)|SQLITE_BUSY|SQLITE_LOCKED/i.test(String(error))) throw error;
            busy++;
          }
          if (performance.now() - start >= 8000) { clearInterval(timer); db.close(); console.log(JSON.stringify({writes,busy})); }
        }, 5);
      `, path.join(state, "state.sqlite")], { env, stdio: ["ignore", "pipe", "pipe"] });
      let writerOutput = "", output = "";
      const writerReady = Promise.withResolvers<void>();
      writer.stdout!.on("data", chunk => { writerOutput += String(chunk); if (writerOutput.includes("ready\n")) writerReady.resolve(); });
      const writerDone = new Promise<void>((resolve, reject) => {
        writer.on("error", reject); writer.on("exit", code => code === 0 ? resolve() : reject(new Error(`revision writer exited ${code}`)));
      });
      // Observe an early writer failure while the readiness handshake is pending.
      void writerDone.catch(error => writerReady.reject(error));
      let server: ReturnType<typeof spawn> | undefined;
      const writerDeadline = setTimeout(() => writerReady.reject(new Error("revision writer never became ready")), 10_000);
      try {
        await writerReady.promise;
        clearTimeout(writerDeadline);
        server = spawn(process.execPath, ["--bun", path.join(process.cwd(), "node_modules/.bin/next"), "start", "--hostname", "127.0.0.1", "--port", "0"],
          { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
        const ready = Promise.withResolvers<void>();
        const failed = Promise.withResolvers<never>();
        let readySeen = false;
        void ready.promise.catch(failed.reject);
        void failed.promise.catch(() => {});
        const collect = (chunk: unknown) => {
          output += String(chunk);
          if (Buffer.byteLength(output) > 16 * 1024 * 1024) failed.reject(new Error("server evidence exceeded bound"));
          if (output.includes("Ready in")) { readySeen = true; ready.resolve(); }
        };
        server.stdout!.on("data", collect); server.stderr!.on("data", collect);
        server.on("error", ready.reject);
        const exited = new Promise<never>((_, reject) => server!.on("exit", code => reject(new Error(`built server exited ${code}`))));
        void exited.catch(() => {});
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          // A measurement window, independent of readiness: includes startup,
          // the writer's eight seconds and one ordinary performance summary.
          await Promise.race([exited, failed.promise, new Promise<void>((resolve, reject) => {
            timer = setTimeout(() => readySeen ? resolve() : reject(new Error("built server never became ready")), 70_000);
          })]);
          await ready.promise;
          await writerDone;
        } finally { clearTimeout(timer); }
        const count = (text: string) => output.split(text).length - 1;
        const refusalRecords = countAttributedWarningRecords(output, "[structured hosts] pipeline registry unreadable; deferring pipeline adoption", server!.pid!, "viewer");
        const leaseRecords = countAttributedWarningRecords(output, "[structured hosts] state lease exceeded budget", server!.pid!, "viewer");
        const writerCounts = JSON.parse(writerOutput.trim().split("\n").at(-1)!) as { writes: number; busy: number };
        if (!(writerCounts.writes > 0) || !output.includes('phase: "ready"')) throw new Error("startup or concurrent writes did not complete");
        if (refusalRecords.attributed !== refusalRecords.total || leaseRecords.attributed !== leaseRecords.total) {
          throw new Error(`warning attribution mismatch in generation ${generation}: refusal ${refusalRecords.attributed}/${refusalRecords.total}, lease ${leaseRecords.attributed}/${leaseRecords.total}`);
        }
        rows.push({ generation, unreadable: refusalRecords.total, syntheticUnavailable: count("pipeline admission authority is unavailable"),
          leaseBudget: count("[structured hosts] state lease exceeded budget"), loopGap: count("[viewer loop-gap]"), performanceSummary: count("[performance summary]"),
          writer: writerCounts,
          attributedRefusals: refusalRecords.attributed, attributedLeaseBudget: leaseRecords.attributed });
      } finally {
        clearTimeout(writerDeadline);
        if (server) await stopFixtureProcess(server);
        await stopFixtureProcess(writer);
        await writerDone.catch(() => {});
      }
    }
    return { conditions: { pipelines: 1024, completedStructuredRows: 64, generations: 2, windowMs: 70_000, writerMs: 8000, writerIntervalMs: 5, runtimeSocket: "unset", port: "ephemeral", retainedStateAcrossRestart: true }, rows };
  } finally {
    if (previousState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const root = claimProcessTempRoot(TEST_RUN_TEMP_PREFIX);
  Object.assign(process.env, { NODE_ENV: "test" });
  delete process.env.LLV_STATE_OWNER;
  for (const key of ["HOME", "XDG_CONFIG_HOME", "LLV_STATE_DIR"]) {
    process.env[key] = path.join(root.root, key.toLowerCase());
    fs.mkdirSync(process.env[key]!);
  }
  try { console.log(JSON.stringify(process.argv[2] === "--authority-restarts" ? await measurePipelineAuthorityRestarts() : await measureStartupRetries(process.argv[2]))); }
  finally { root.release(); }
}
