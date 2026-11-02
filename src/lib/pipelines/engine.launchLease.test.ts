import "./engineEnvironment.fixture";
import { expect, setSystemTime, spyOn, test } from "bun:test";
import { AgentRegistry, accountManager, create, crypto, defaultPipelinePorts, fs, harness, loadPipelines, path, rawPatchPipeline, savePipelines, setAgentRegistryForTests, tickPipelines } from "./engine.fixture";
import { FlowPipelineController } from "./controller";
import { tickPipelinesController } from "./controllerPass";
import { roleMemoryCollection } from "@/lib/memory/roleStore";
import { TaskPageWorker, shutdownTaskPageWorker } from "@/lib/links/taskPageWorker";
import { DEFAULT_CPU_PRESSURE_POLICY } from "@/lib/runtime/cpuPressure";
import { RuntimeJournal } from "@/runtime-host/journal";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import type { SpawnedStructuredHost } from "@/lib/runtime/structuredSpawn";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("launch checkpoint did not settle")), 10_000);
  })]); } finally { clearTimeout(timer); }
}

const cases = ["git-guard", "role-memory", "activation", "pause", "epoch", "owner", "admission", "privacy-failure",
  "runtime-retry", "runtime-pause", "runtime-backoff-pause", "runtime-epoch", "runtime-owner", "runtime-admission"] as const;
test.each([...cases])("reserved launch survives pass expiry with its fences: %s", async boundary => {
  // A fresh process owns every registry, worker and activation executor.
  if (process.env.LLV_LAUNCH_LEASE_CASE !== boundary) {
    const directory = fs.mkdtempSync(path.join(process.env.TMPDIR!, "launch-lease-case-"));
    try {
      const child = Bun.spawn([process.execPath, "test", "--timeout=30000", import.meta.path,
        "-t", `^reserved launch survives pass expiry with its fences: ${boundary}$`], {
        env: { ...process.env, LLV_STATE_DIR: directory, LLV_LAUNCH_LEASE_CASE: boundary }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, output + errors).toBe(0);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    return;
  }
  setSystemTime(new Date("2026-11-02T01:03:00Z"));
  let nextId = 0;
  const ids = spyOn(crypto, "randomUUID").mockImplementation(() => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`);
  const root = process.env.LLV_STATE_DIR!;
  const registry = new AgentRegistry(path.join(root, "launch-registry.json"));
  setAgentRegistryForTests(registry);
  roleMemoryCollection(true)!.boundedPatch(1, tx => tx.put({
    kind: "rule", id: "r_launch_lease", scope: "machine", rule: "Keep silver orchard evidence private", why: "", state: "active", hints: [],
    source: { project: "fixture", pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_fixture" },
    createdAt: "2026-11-02T01:03:00Z", changedAt: "2026-11-02T01:03:00Z",
  }));
  const binary = path.join(root, "fixture-codex");
  fs.writeFileSync(binary, "#!/bin/sh\nprintf '[]\\n'\n", { mode: 0o700 });
  const previousBinary = process.env.LLV_CODEX_BINARY;
  process.env.LLV_CODEX_BINARY = binary;
  const clientModule = await import("@/lib/runtime/client");
  const spawnModule = await import("@/lib/runtime/structuredSpawn");
  const realSpawn = spawnModule.spawnStructuredConversation;
  const guardModule = await import("@/lib/git/stageAttemptGuard");
  const resolve = spyOn(accountManager, "resolveProjectSpawn").mockReturnValue({ kind: "available", account: {
    engine: "codex", accountId: "fixture-account", kind: "managed", home: root, transcriptRoot: root, env: { NODE_ENV: "test" },
  } });
  const entered = latch(), release = latch(), finished = latch();
  let guardDone = false, held = false, reservations = 0, dispatches = 0, calls = 0;
  const hold = async () => { held = true; entered.resolve(); await release.promise; };
  const runtimeCase = boundary.startsWith("runtime-");
  const journal = runtimeCase ? new RuntimeJournal(path.join(root, "runtime.sqlite"), { structuredHosts: true }) : null;
  const spawnKeys: string[] = [];
  const client = spyOn(clientModule, "runtimeHostClient").mockReturnValue(runtimeCase ? {
    command: async command => {
      expect(command.kind).toBe("spawn");
      spawnKeys.push(command.idempotencyKey!);
      const result = journal!.executeOperation(command);
      if (spawnKeys.length === 1) {
        if (boundary !== "runtime-backoff-pause") await hold();
        throw new clientModule.RuntimeHostUnavailableError("runtime host request timed out");
      }
      expect(result.replayed).toBe(true);
      return result;
    },
    transitionOperation: async (id, status, details, options) => journal!.transitionOperation(id, status, details, options),
  } as RuntimeHostClient : {} as never);
  const guard = spyOn(guardModule, "prepareStageGitGuard").mockImplementation(async () => {
    if (boundary === "git-guard") await hold();
    guardDone = true;
    return {};
  });
  const realPrivacy = TaskPageWorker.prototype.privacy;
  const privacy = spyOn(TaskPageWorker.prototype, "privacy").mockImplementation(async function(this: TaskPageWorker, request) {
    if (guardDone && !held && (boundary === "role-memory" || boundary === "privacy-failure")) {
      await hold();
      if (boundary === "privacy-failure") throw new Error("fixture privacy worker failed");
    }
    return realPrivacy.call(this, request);
  });
  let retainedPermit: (() => void | Promise<void>) | undefined;
  const spawn = spyOn(spawnModule, "spawnStructuredConversation").mockImplementation(async input => {
    retainedPermit = input.authorize;
    if (runtimeCase) {
      const sessionId = crypto.randomUUID();
      const artifact = path.join(root, `${sessionId}.jsonl`);
      const host = {
        identity: { threadId: sessionId, path: artifact },
        health: async () => ({ status: "idle" }), release: async () => {},
        sessionMaterializationEvidence: async () => ({ state: "materialized" }),
      } as unknown as SpawnedStructuredHost;
      return await realSpawn(input, {
        now: () => 0,
        sleep: async () => { if (boundary === "runtime-backoff-pause" && !held) await hold(); },
        startHost: async () => { dispatches++; return host; },
        bindHost: async (store, key, _host, owner, epoch) => {
          const entry = store.readOnlySnapshot().entries[`codex:${key.sessionId}`]!;
          store.setStructuredHostClaimed(key, { ...entry.structuredHost!, process: { pid: process.pid, startIdentity: "fixture" } }, "live", owner, epoch);
          return () => {};
        },
        publishHost: async (_key, _host, authorize) => {
          expect(await authorize!()).toBe(true);
          return async () => {};
        },
        deliverFirst: async current => {
          await current.authorize?.();
          fs.writeFileSync(artifact, JSON.stringify({ type: "session_meta", payload: { id: sessionId } }) + "\n");
        },
      });
    }
    await input.authorize?.();
    expect(input.prompt).not.toContain("Keep silver orchard evidence private");
    dispatches++;
    return { path: path.join(root, `${crypto.randomUUID()}.jsonl`) } as never;
  });
  let admissionClock = 0;
  const monotonic = boundary.endsWith("admission") ? spyOn(performance, "now").mockImplementation(() => admissionClock) : null;
  const h = harness();
  let eligible = false;
  h.ports.now = () => "2026-11-02T01:03:00Z";
  h.ports.cpuPressureHold = () => eligible ? null : { since: Date.parse(h.ports.now()), avg10: 90, deferred: false, policy: DEFAULT_CPU_PRESSURE_POLICY };
  const defaults = defaultPipelinePorts();
  h.ports.spawnReceipt = defaults.spawnReceipt;
  h.ports.spawnAgent = async (input, onReserved, prepare, phase) => {
    calls++;
    try {
      return await defaults.spawnAgent(input, async reservation => {
        reservations++;
        if (reservations === 2 && ["activation", "pause", "epoch", "owner", "admission"].includes(boundary)) await hold();
        await onReserved(reservation);
      }, prepare, phase);
    } finally { finished.resolve(); }
  };
  const timers: Array<{ active: boolean; callback: () => void }> = [];
  let now = 0;
  const controller = new FlowPipelineController({
    tickPipelines: entries => tickPipelinesController(entries, h.ports), now: () => now,
    scan: async () => ({ files: [], complete: false }), log: () => {},
    scheduleTimeout: callback => { const timer = { active: true, callback }; timers.push(timer); return timer; },
    clearTimeout: timer => { (timer as typeof timers[number]).active = false; },
  }, { phaseDeadlineMs: 500, maxPasses: 1 });
  let first: Promise<unknown> | undefined;
  try {
    await create(h.ports, [{ id: "build", kind: "run", role: { roleId: "builder" }, engine: "codex", prompt: "Build safely. Keep silver orchard evidence private", next: null }] as never,
      { repoDir: path.join(root, "repo") });
    await tickPipelines([], h.ports);
    fs.mkdirSync(loadPipelines()[0]!.worktreeDir!, { recursive: true });
    await tickPipelines([], h.ports);
    eligible = true;
    first = controller.tick();
    await bounded(entered.promise);
    const reserved = loadPipelines()[0]!.runs[0]!.attempts[0]!;
    expect(reserved.launchId).toBeTruthy();
    expect(registry.spawnReceipt(reserved.launchId!)?.state).toBe("starting");
    now = 500;
    timers.find(timer => timer.active)!.callback();
    await bounded(first);
    // A second pass sees the durable reservation while the original is held.
    await bounded(controller.poll());
    expect(calls).toBe(1);
    expect(dispatches).toBe(0);
    if (boundary === "pause" || boundary === "runtime-pause" || boundary === "runtime-backoff-pause") {
      const paused = await rawPatchPipeline(loadPipelines()[0]!.id, { action: "pause", reason: "fixture pause during launch" }, h.ports);
      expect(paused.error).toBeUndefined();
      expect(loadPipelines()[0]!.state).toBe("paused");
    }
    if (["epoch", "owner", "runtime-epoch", "runtime-owner"].includes(boundary)) {
      const lane = loadPipelines()[0]!;
      if (!boundary.endsWith("owner")) lane.controlGeneration = "fixture-successor-control";
      else lane.runs[0]!.attempts[0]!.activation!.owner = { pid: 999999, startIdentity: "successor", bootEpoch: "fixture" };
      savePipelines([lane]);
    }
    if (boundary.endsWith("admission")) admissionClock = 1_000_000;
    release.resolve();
    await bounded(finished.promise);
    // Drain the executor's final activation CAS before observing the next pass.
    await bounded((async () => {
      while (loadPipelines()[0]!.runs[0]!.attempts[0]!.activation?.owner) await new Promise<void>(done => setImmediate(done));
    })());
    await bounded(controller.poll());
    const lane = loadPipelines()[0]!;
    expect(calls).toBe(1);
    if (runtimeCase) {
      expect(spawnKeys).toHaveLength(boundary === "runtime-retry" ? 2 : 1);
      expect(new Set(spawnKeys).size).toBe(1);
    }
    if (["git-guard", "role-memory", "activation", "runtime-retry"].includes(boundary)) {
      expect(dispatches).toBe(1);
      expect(lane.state).toBe("running");
      expect(lane.runs[0]!.attempts).toHaveLength(1);
      expect(lane.runs[0]!.attempts[0]!.state).toBe("running");
      expect(lane.runs[0]!.attempts[0]!.activation).toBeUndefined();
      // A retained staged continuation outlives activation custody.
      await retainedPermit?.();
    } else {
      expect(dispatches).toBe(0);
      expect(registry.spawnReceipt(reserved.launchId!)?.state).toBe("failed");
      if (boundary === "privacy-failure") expect(lane.stateDetail).toContain("role memory could not be read or filtered");
      if (boundary.endsWith("pause")) expect(lane.state).toBe("paused");
    }
  } finally {
    release.resolve();
    if (first) await bounded(first).catch(() => {});
    await shutdownTaskPageWorker();
    journal?.close();
    resolve.mockRestore(); client.mockRestore(); guard.mockRestore(); privacy.mockRestore(); spawn.mockRestore(); ids.mockRestore(); monotonic?.mockRestore();
    setAgentRegistryForTests(null); setSystemTime();
    if (previousBinary === undefined) delete process.env.LLV_CODEX_BINARY;
    else process.env.LLV_CODEX_BINARY = previousBinary;
  }
}, 30_000);
