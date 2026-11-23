import { afterAll, expect, test } from "bun:test";
import path from "node:path";
import { saveTasks } from "../tasks/store";
import type { BoardTask } from "../tasks/types";
import type { CpuPrioritySource } from "../runtime/cpuPriority";
import { CpuAdmissionQueue, CPU_QUEUE_MAX_WAIT_MS, CPU_QUEUE_SPACING_MS } from "../runtime/cpuAdmission";
import { DEFAULT_CPU_PRESSURE_POLICY } from "../runtime/cpuPressure";
import { createPipelineFromRequest, tickPipelines, type PipelinePorts } from "./engine";
import { loadPipelines, savePipelines, withDeliveryPublicationDetail } from "./store";
import { parseCpuQueueDetail } from "../runtime/cpuQueueText";
import { registerPipelineTick } from "./controllerSignal";
import { captureProcessIdentity } from "../processIdentity";

registerPipelineTick(async () => {});
afterAll(async () => { await (await import("@/lib/links/taskPageWorker")).shutdownTaskPageWorker(); });

test.each([false, true])("stage activation uses task priority (%s) independently of a slot-waiting command", async prioritized => {
  savePipelines([]);
  let now = Date.parse("2026-10-20T00:00:00.000Z");
  saveTasks(["one", "two"].map((id) => ({ id, project: "fixture", text: id, status: "inbox", placement: "unplaced", assignments: [], createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), ...(prioritized && id === "two" ? { priority: "high" } : {}) } as BoardTask)));
  const queue = new CpuAdmissionQueue(path.join(process.env.LLV_STATE_DIR!, `cpu-${prioritized}.sqlite`), () => now);
  const commandOwner = captureProcessIdentity(process.pid);
  expect(queue.check("command:waiting-for-slot", true, commandOwner, false)).toBeNull();
  const launches: string[] = [];
  const queuedKeys = new Set<string>();
  let draining = false;
  let pressureAllows = false;
  const remote = "https://example.invalid/project.git";
  const ports = {
    exec: (_command: string, args: string[], cwd: string) => {
      if (args[0] === "remote" && args[1] === "get-url") return { code: 0, stdout: `${remote}\n`, stderr: "" };
      if (args.length === 1 && args[0] === "remote") return { code: 0, stdout: "origin\n", stderr: "" };
      // URL validation reads an ephemeral remote through Git's command-line config.
      if (args[0] === "-c" && args[2] === "remote" && args[3] === "-v") {
        const probe = /^remote\.([^=]+)\.url=(.*)$/.exec(args[1]!);
        if (probe) return { code: 0, stdout: `${probe[1]}\t${probe[2]} (fetch)\n${probe[1]}\t${probe[2]} (push)\n`, stderr: "" };
      }
      return { code: 0, stdout: args[0] === "branch" && args[1] === "--show-current" ? `${loadPipelines().find(p => p.worktreeDir === cwd)?.branch ?? "main"}\n` : args[0] === "status" ? "" : `${"a".repeat(40)}\n`, stderr: "" };
    },
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
    cpuPressureHold: (key: string, priority: CpuPrioritySource) => {
      queuedKeys.add(key);
      const wait = queue.check(key, pressureAllows, undefined, true, priority);
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
      const result = await createPipelineFromRequest({ task: word, taskIds: [word], spec: "CPU queue", repoDir: `/fixture/${word}`, src: "/fixture/creator.jsonl", publication: "internal", baseRef: "a".repeat(40), stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null, onFail: null }] }, ports);
      expect(result.error).toBeUndefined();
    }
    await tickPipelines([], ports); await tickPipelines([], ports);
    now += 5_000; // The next scheduled poll refreshes earlier cards after later tickets join.
    await tickPipelines([], ports);
    const held = loadPipelines();
    const parsed = held.map(p => parseCpuQueueDetail(p.stateDetail));
    expect(parsed.map(wait => wait?.position)).toEqual(prioritized ? [2, 1] : [1, 2]);
    expect(parsed.map(wait => wait?.priority)).toEqual(prioritized ? ["normal", "high"] : ["normal", "normal"]);
    expect(parsed.map(wait => wait?.heldBy)).toEqual(prioritized ? ["queue", "pressure"] : ["pressure", "queue"]);
    expect(parsed.every(wait => wait?.minutes === 0)).toBe(true);
    const projected = withDeliveryPublicationDetail({ ...held[0]!, delivery: {
      target: { repository: "fixture", remote: "origin", branch: "refs/heads/main" },
      disposition: "owner", ownerId: "viewer", epoch: 1, publish: "enabled",
      active: true, journal: [],
    } });
    expect(projected.stateDetail).toContain(" · Viewer publication:");
    expect(parseCpuQueueDetail(projected.stateDetail)).toEqual(parsed[0]);
    expect(loadPipelines()[0]!.stateDetail).not.toContain("Viewer publication:");
    expect(launches).toHaveLength(0);
    draining = true;
    await tickPipelines([], ports);
    expect(loadPipelines().every(p => p.stateDetail?.startsWith("held for the automatic update"))).toBe(true);
    expect(queue.check("command:update-check", true)).toBeNull();
    expect(launches).toHaveLength(0);
    draining = false;
    now += 5 * 60_000;
    pressureAllows = true; // Before aging, the newer urgent stage keeps its preference.
    // The production reconciliation port releases all eligible tickets before
    // polling the first lane after a drain, regardless of controller order.
    queue.reconcile("stage:", queuedKeys);
    await tickPipelines([], ports);
    expect(launches).toHaveLength(1);
    expect(launches[0]).toContain(prioritized ? "two" : "one");
    now += CPU_QUEUE_SPACING_MS;
    await tickPipelines([], ports);
    expect(launches).toHaveLength(2);
    expect(loadPipelines().every(p => !p.stateDetail?.startsWith("Waiting for the CPU queue"))).toBe(true);
  } finally { queue.close(); savePipelines([]); saveTasks([]); }
});
