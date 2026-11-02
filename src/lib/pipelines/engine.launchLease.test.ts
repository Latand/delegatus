import "./engineEnvironment.fixture";
import { expect, setSystemTime, spyOn, test } from "bun:test";
import { AgentRegistry, accountManager, create, crypto, defaultPipelinePorts, fs, harness, loadPipelines, path, savePipelines, setAgentRegistryForTests, tickPipelines } from "./engine.fixture";
import { FlowPipelineController } from "./controller";
import { tickPipelinesController } from "./controllerPass";
import { roleMemoryCollection } from "@/lib/memory/roleStore";
import { TaskPageWorker, shutdownTaskPageWorker } from "@/lib/links/taskPageWorker";
import { DEFAULT_CPU_PRESSURE_POLICY } from "@/lib/runtime/cpuPressure";

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

const cases = ["git-guard", "role-memory", "activation", "pause", "epoch", "owner", "admission", "privacy-failure"] as const;
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
  const guardModule = await import("@/lib/git/stageAttemptGuard");
  const resolve = spyOn(accountManager, "resolveProjectSpawn").mockReturnValue({ kind: "available", account: {
    engine: "codex", accountId: "fixture-account", kind: "managed", home: root, transcriptRoot: root, env: { NODE_ENV: "test" },
  } });
  const client = spyOn(clientModule, "runtimeHostClient").mockReturnValue({} as never);
  const entered = latch(), release = latch(), finished = latch();
  let guardDone = false, held = false, reservations = 0, dispatches = 0, calls = 0;
  const hold = async () => { held = true; entered.resolve(); await release.promise; };
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
  const spawn = spyOn(spawnModule, "spawnStructuredConversation").mockImplementation(async input => {
    input.authorize?.();
    expect(input.prompt).not.toContain("Keep silver orchard evidence private");
    dispatches++;
    return { path: path.join(root, `${crypto.randomUUID()}.jsonl`) } as never;
  });
  let admissionClock = 0;
  const monotonic = boundary === "admission" ? spyOn(performance, "now").mockImplementation(() => admissionClock) : null;
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
    if (boundary === "pause" || boundary === "epoch" || boundary === "owner") {
      const lane = loadPipelines()[0]!;
      if (boundary === "pause") { lane.state = "paused"; lane.pausedAt = h.ports.now(); }
      if (boundary !== "owner") lane.controlGeneration = "fixture-successor-control";
      else lane.runs[0]!.attempts[0]!.activation!.owner = { pid: 999999, startIdentity: "successor", bootEpoch: "fixture" };
      savePipelines([lane]);
    }
    if (boundary === "admission") admissionClock = 1_000_000;
    release.resolve();
    await bounded(finished.promise);
    // Drain the executor's final activation CAS before observing the next pass.
    await bounded((async () => {
      while (loadPipelines()[0]!.runs[0]!.attempts[0]!.activation?.owner) await new Promise<void>(done => setImmediate(done));
    })());
    await bounded(controller.poll());
    const lane = loadPipelines()[0]!;
    expect(calls).toBe(1);
    if (["git-guard", "role-memory", "activation"].includes(boundary)) {
      expect(dispatches).toBe(1);
      expect(lane.state).toBe("running");
      expect(lane.runs[0]!.attempts).toHaveLength(1);
      expect(lane.runs[0]!.attempts[0]!.state).toBe("running");
      expect(lane.runs[0]!.attempts[0]!.activation).toBeUndefined();
    } else {
      expect(dispatches).toBe(0);
      expect(registry.spawnReceipt(reserved.launchId!)?.state).toBe("failed");
      if (boundary === "privacy-failure") expect(lane.stateDetail).toContain("role memory could not be read or filtered");
      if (boundary === "pause") expect(lane.state).toBe("paused");
    }
  } finally {
    release.resolve();
    if (first) await bounded(first).catch(() => {});
    await shutdownTaskPageWorker();
    resolve.mockRestore(); client.mockRestore(); guard.mockRestore(); privacy.mockRestore(); spawn.mockRestore(); ids.mockRestore(); monotonic?.mockRestore();
    setAgentRegistryForTests(null); setSystemTime();
    if (previousBinary === undefined) delete process.env.LLV_CODEX_BINARY;
    else process.env.LLV_CODEX_BINARY = previousBinary;
  }
}, 30_000);
