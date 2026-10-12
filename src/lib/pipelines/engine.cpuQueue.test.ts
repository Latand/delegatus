import { expect, test } from "bun:test";
import path from "node:path";
import { CpuAdmissionQueue, CPU_QUEUE_MAX_WAIT_MS, CPU_QUEUE_SPACING_MS } from "../runtime/cpuAdmission";
import { DEFAULT_CPU_PRESSURE_POLICY } from "../runtime/cpuPressure";
import { createPipelineFromRequest, tickPipelines, type PipelinePorts } from "./engine";
import { loadPipelines, savePipelines } from "./store";
import { registerPipelineTick } from "./controllerSignal";

registerPipelineTick(async () => {});

test("stage activation uses stable FIFO tickets, persists the card reason and launches one expired head", async () => {
  savePipelines([]);
  let now = Date.now();
  const queue = new CpuAdmissionQueue(path.join(process.env.LLV_STATE_DIR!, "cpu.sqlite"), () => now);
  const launches: string[] = [];
  let draining = false;
  const ports = {
    exec: (_command: string, args: string[], cwd: string) => ({ code: 0, stdout: args[0] === "branch" && args[1] === "--show-current" ? `${loadPipelines().find(p => p.worktreeDir === cwd)?.branch ?? "main"}\n` : args[0] === "status" ? "" : `${"a".repeat(40)}\n`, stderr: "" }),
    provisionExec: () => ({ code: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" }),
    preflightRepo: (repoDir: string) => ({ ok: true, repoDir, gitCommonDir: path.join(repoDir, ".git"), worktreeParent: path.dirname(repoDir) }),
    roleLookup: () => ({ engine: "codex", model: "gpt-6.1-sol", effort: "high", access: "read-write", promptScaffold: "Build" }),
    projectForCwd: () => "fixture", sourcePathAllowed: () => true,
    conversationIdForPath: () => "creator", pipelineAdoptionCandidates: () => [],
    pathForConversation: () => null, headCwd: () => null,
    worktreePresent: () => true, structuredDeliveryPublication: () => "ready",
    spawnReceipt: () => null, claimSpawnRetry: () => "claimed",
    drainHold: () => draining ? { id: "update", target: "a".repeat(40), since: new Date(now).toISOString(), until: now + CPU_QUEUE_MAX_WAIT_MS } : null,
    cpuAdmissionSuspend: (key: string) => queue.suspend(key),
    cpuPressureHold: (key: string) => {
      const wait = queue.check(key, false);
      return wait ? { since: wait.since, avg10: 90, deferred: false, policy: DEFAULT_CPU_PRESSURE_POLICY, queue: wait } : null;
    },
    spawnAgent: async (input: { clientAttemptId: string; title: string }, onReserved: (value: { launchId: string; conversationId: string }) => Promise<void>) => {
      launches.push(input.title);
      await onReserved({ launchId: input.clientAttemptId, conversationId: `launched-${launches.length}` });
      return { launchId: input.clientAttemptId, conversationId: `launched-${launches.length}`, sessionId: "session", transcript: `/fixture/stage-${launches.length}.jsonl`, paneId: null };
    },
    stageHostResident: async () => false, conversationAgentActive: async () => false,
    durableTurnEvidence: async () => null, lastMessage: () => null,
    scheduleTick: () => {}, monotonicNow: Date.now, now: () => new Date(now).toISOString(),
  } as unknown as PipelinePorts;
  try {
    for (const word of ["one", "two"]) {
      const result = await createPipelineFromRequest({ task: word, spec: "CPU queue", repoDir: `/fixture/${word}`, src: "/fixture/creator.jsonl", publication: "internal", baseRef: "a".repeat(40), stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null, onFail: null }] }, ports);
      expect(result.error).toBeUndefined();
    }
    await tickPipelines([], ports); await tickPipelines([], ports);
    const held = loadPipelines();
    expect(held.map(p => p.stateDetail)).toEqual(["Waiting for the CPU queue · 1st · up to 10 min", "Waiting for the CPU queue · 2nd · up to 11 min"]);
    expect(launches).toHaveLength(0);
    draining = true;
    await tickPipelines([], ports);
    expect(loadPipelines().every(p => p.stateDetail?.startsWith("held for the automatic update"))).toBe(true);
    expect(queue.check("command:update-check", true)).toBeNull();
    expect(launches).toHaveLength(0);
    draining = false;
    now += CPU_QUEUE_MAX_WAIT_MS;
    await tickPipelines([], ports);
    expect(launches).toHaveLength(1);
    now += CPU_QUEUE_SPACING_MS;
    await tickPipelines([], ports);
    expect(launches).toHaveLength(2);
    expect(loadPipelines().every(p => !p.stateDetail?.startsWith("Waiting for the CPU queue"))).toBe(true);
  } finally { queue.close(); savePipelines([]); }
});
