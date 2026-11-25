import "./engineEnvironment.fixture";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { Database } from "bun:sqlite";
import { expect, setSystemTime, spyOn } from "bun:test";
import { AgentRegistry, defaultPipelinePorts, loadPipelines, reserveActivationOnly,
  setAgentRegistryForTests, tickPipelines } from "./engine.fixture";
import { RoleMemoryChanged } from "@/lib/memory/privacy";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";

export const cleanups: Array<() => void | Promise<void>> = [];

export async function cleanupRoleMemoryDispatch() {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    setSystemTime();
    setAgentRegistryForTests(null);
  }
}

export function nativeStart(engine: "codex" | "claude", pathname: string, now: string) {
  fs.appendFileSync(pathname, JSON.stringify(engine === "codex"
    ? { type: "event_msg", timestamp: now, payload: { type: "task_started" } }
    : { type: "assistant", timestamp: now, message: { role: "assistant", stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "native-start-tool", name: "Read", input: { file_path: "fixture.txt" } }] } }) + "\n");
}

export async function ownedIdleChild() {
  const child = Bun.spawn([process.execPath, "-e", "process.stdin.resume(); console.log('ready')"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  cleanups.push(async () => { if (child.exitCode === null) child.stdin.end(); await child.exited; });
  const reader = child.stdout.getReader();
  try { expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe("ready"); }
  finally { reader.releaseLock(); }
  return child;
}

export async function fixture(name: string, sqliteWriterDeadlineMs?: number, engine: "codex" | "claude" = "codex") {
  setSystemTime(new Date("2026-11-03T12:00:00Z"));
  let sequence = 0;
  const ids = spyOn(crypto, "randomUUID").mockImplementation(() => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`);
  cleanups.push(() => ids.mockRestore());
  const h = await reserveActivationOnly([{ id: "plan", kind: "run", role: { roleId: "builder" }, engine,
    ...(engine === "claude" ? { model: "fable" } : {}),
    access: "read-only", prompt: "Build safely", next: null }] as never);
  h.advanceWallClock(Date.parse("2026-11-03T12:00:00Z") - Date.parse(h.ports.now()));
  const registryFile = path.join(process.env.LLV_STATE_DIR!, `memory-dispatch-${name}.json`);
  const registry = new AgentRegistry(registryFile, undefined, undefined, sqliteWriterDeadlineMs === undefined ? {} : {
    sqliteMode: "sqlite", sqliteWriterDeadlineMs,
  });
  cleanups.push(() => registry.close());
  setAgentRegistryForTests(registry);
  const production = defaultPipelinePorts();
  // The fixture producer bypasses spawnAgent's production cache invalidation.
  // Each observation therefore uses a fresh production projection, including
  // reservations created after a previous launch's retirement.
  h.ports.spawnReceipt = launchId => defaultPipelinePorts().spawnReceipt(launchId);
  h.ports.claimSpawnRetry = production.claimSpawnRetry;
  h.ports.sourcePathAllowed = production.sourcePathAllowed;
  for (const key of ["LLV_CODEX_HOME", "LLV_CLAUDE_HOME"]) {
    const previous = process.env[key];
    process.env[key] = path.join(process.env.LLV_STATE_DIR!, key, name);
    cleanups.push(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  h.ports.durableTurnEvidence = (await import("./durableEvidence")).durableStageTurnEvidence;
  const launches: string[] = [];
  h.ports.spawnAgent = async (input, onReserved) => {
    const begun = registry.beginSpawnRequest({ engine: input.role.engine, cwd: input.cwd,
      transport: "structured", clientAttemptId: input.clientAttemptId, launchProfile: { title: input.title } });
    expect(begun.kind).toBe("created");
    launches.push(begun.receipt.launchId);
    await onReserved(begun.receipt);
    throw new RoleMemoryChanged();
  };
  await tickPipelines([], h.ports);
  const attempt = () => loadPipelines()[0]!.runs[0]!.attempts[0]!;
  const stage = (status: "unhosted" | "live" = "unhosted", launchId = launches[0]!, artifact: "absent" | "metadata" = "absent", directory?: string, createDirectory = true, artifactSessionId?: string) => {
    const key = { engine, sessionId: crypto.randomUUID() };
    const artifactPath = path.join(directory ?? path.join(engine === "codex" ? process.env.LLV_CODEX_HOME! : process.env.LLV_CLAUDE_HOME!,
      engine === "codex" ? "sessions" : "projects", name), `${artifactSessionId ?? key.sessionId}.jsonl`);
    if (createDirectory) fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    if (artifact === "metadata") fs.writeFileSync(artifactPath, JSON.stringify({ type: "session_meta", payload: { id: key.sessionId } }) + "\n");
    const entry = { key, artifactPath, cwd: loadPipelines()[0]!.worktreeDir!, accountId: null,
      launchProfile: emptyLaunchProfile(), status, host: null, pendingAction: null, claimEpoch: 0, claimOwner: null };
    expect(registry.stageStructuredSpawn(launchId, entry).kind).toBe("settled");
    return entry;
  };
  const replacements: string[] = [];
  const normalSpawn: typeof h.ports.spawnAgent = async (input, onReserved) => {
    const begun = registry.beginSpawnRequest({ engine: input.role.engine, cwd: input.cwd,
      transport: "structured", clientAttemptId: input.clientAttemptId, launchProfile: { title: input.title } });
    expect(begun.kind).toBe("created");
    replacements.push(begun.receipt.launchId);
    await onReserved(begun.receipt);
    const entry = stage("live", begun.receipt.launchId);
    registry.completeSpawn(begun.receipt.launchId, entry);
    return { launchId: begun.receipt.launchId, conversationId: begun.receipt.conversationId,
      sessionId: entry.key.sessionId, transcript: entry.artifactPath, paneId: null, accountId: null };
  };
  return { h, registry, registryFile, production, normalSpawn, launches, replacements, attempt, stage };
}

export function holdRegistryWriter(f: Awaited<ReturnType<typeof fixture>>) {
  const holder = new Database(f.registryFile.replace(/\.json$/, ".sqlite"));
  holder.exec("PRAGMA busy_timeout = 0");
  holder.exec("BEGIN IMMEDIATE");
  return holder;
}

export async function childTick(f: Awaited<ReturnType<typeof fixture>>, now: string, transcriptPath?: string, operations = "matched", active = true) {
    const child = Bun.spawn([process.execPath, "-e", `
      const { setMachineCpuPressureForTests } = await import("./src/lib/runtime/cpuPressure");
      setMachineCpuPressureForTests(null);
      const { tickPipelines, defaultPipelinePorts } = await import("./src/lib/pipelines/engine");
      const { registerPipelineTick } = await import("./src/lib/pipelines/controllerSignal");
      const { loadPipelines } = await import("./src/lib/pipelines/store");
      const { AgentRegistry, setAgentRegistryForTests } = await import("./src/lib/agent/registry");
      const registry = new AgentRegistry(process.env.LLV_MEMORY_DISPATCH_REGISTRY);
      setAgentRegistryForTests(registry); registerPipelineTick(async () => {});
      let spawns = 0;
      await tickPipelines([], { ...defaultPipelinePorts(), now: () => process.env.LLV_MEMORY_DISPATCH_NOW,
        exec: async () => ({ code: 0, stdout: "", stderr: "" }), scheduleTick: () => {},
        cpuPressureHold: () => null, drainHold: () => null, worktreePresent: () => true,
        conversationAgentActive: async () => process.env.LLV_MEMORY_DISPATCH_ACTIVE === "true",
        ...(process.env.LLV_MEMORY_DISPATCH_TRANSCRIPT_PATH ? {
          originalLaunchOperations: async () => process.env.LLV_MEMORY_DISPATCH_OPERATIONS,
        } : {}),
        spawnAgent: async () => { spawns++; throw new Error("unexpected launch"); },
        recoverStagedLaunch: async () => { throw new Error("privacy wait must not replay its launch"); },
      });
      const lane = loadPipelines()[0];
      const attempt = lane.runs[0].attempts[0];
      console.log(JSON.stringify({ state: lane.state, attemptState: attempt.state, verdict: attempt.verdict, detail: lane.stateDetail, wait: attempt.roleMemoryDispatchWait,
        launchId: attempt.launchId, agentPath: attempt.agentPath, retiredLaunches: attempt.retiredLaunches, spawns }));
      registry.close();
    `], { env: { ...process.env, LLV_MEMORY_DISPATCH_REGISTRY: f.registryFile, LLV_MEMORY_DISPATCH_NOW: now,
      LLV_MEMORY_DISPATCH_OPERATIONS: operations,
      LLV_MEMORY_DISPATCH_ACTIVE: String(active),
      ...(transcriptPath ? { LLV_MEMORY_DISPATCH_TRANSCRIPT_PATH: transcriptPath } : {}) },
      stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, errors).toBe(0);
    return JSON.parse(output);
}
