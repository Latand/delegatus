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

if (import.meta.main) {
  const root = claimProcessTempRoot(TEST_RUN_TEMP_PREFIX);
  Object.assign(process.env, { NODE_ENV: "test" });
  delete process.env.LLV_STATE_OWNER;
  for (const key of ["HOME", "XDG_CONFIG_HOME", "LLV_STATE_DIR"]) {
    process.env[key] = path.join(root.root, key.toLowerCase());
    fs.mkdirSync(process.env[key]!);
  }
  try { console.log(JSON.stringify(await measureStartupRetries(process.argv[2]))); }
  finally { root.release(); }
}
