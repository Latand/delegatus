import "./engineEnvironment.fixture";
import { expect, spyOn, test } from "bun:test";
import * as timers from "node:timers/promises";
import { create, harness, tickPipelines, loadPipelines } from "./engine.fixture";
import { roleMemoryCollection } from "@/lib/memory/roleStore";
import { TaskPageWorker, shutdownTaskPageWorker } from "@/lib/links/taskPageWorker";

const rule = "Keep silver orchard evidence private until the owning operation completes";
test.each(["timeout-recovery", "busy-recovery", "exhaustion", "permanent"] as const)("stage preparation retains its privacy fence through %s", async mode => {
  roleMemoryCollection(true)!.boundedPatch(1, tx => tx.put({
    kind: "rule", id: "r_stage_read", scope: "machine", rule, why: "", state: "active", hints: [],
    source: { project: "fixture", pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_fixture" },
    createdAt: "2026-11-05T00:00:00Z", changedAt: "2026-11-05T00:00:00Z",
  }));
  const h = harness();
  let clock = 0, failures = 0;
  const now = spyOn(performance, "now").mockImplementation(() => clock);
  const pause = spyOn(timers, "setTimeout").mockImplementation(async ms => {
    expect(h.spawnInputs).toHaveLength(0);
    clock += Number(ms);
  });
  const log = spyOn(console, "warn").mockImplementation(() => {});
  const real = TaskPageWorker.prototype.privacy;
  const worker = spyOn(TaskPageWorker.prototype, "privacy").mockImplementation(async function(this: TaskPageWorker, request) {
    if (++failures <= 2 || mode === "exhaustion" || mode === "permanent") {
      if (mode !== "permanent") clock += Math.min(60_000, 180_000 - clock);
      throw Object.assign(new Error(rule), { code: mode === "permanent" ? "EACCES" : mode === "busy-recovery" ? "SQLITE_BUSY" : "ETIMEDOUT" });
    }
    return real.call(this, request);
  });
  try {
    await create(h.ports, [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: `Build safely. ${rule}`, next: null }] as never);
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    const lane = loadPipelines()[0]!;
    const text = log.mock.calls.flat().join("\n");
    expect(text).not.toContain(rule);
    if (mode.endsWith("recovery")) {
      expect(h.spawnInputs).toHaveLength(1);
      expect(h.spawnInputs[0]!.prompt).toContain("[learned rule]");
      expect(h.spawnInputs[0]!.prompt).not.toContain(rule);
      expect(lane.runs[0]!.attempts.at(-1)!.state).toBe("running");
      expect(text).toContain(mode === "busy-recovery" ? "store-busy" : "worker-timeout");
    } else {
      expect(h.spawnInputs).toHaveLength(0);
      expect(lane.state).toBe("needs_decision");
      expect(lane.stateDetail).toContain(mode === "permanent" ? "access-denied" : "worker-timeout; retry window exhausted after 180 seconds");
      expect(lane.stateDetail).not.toContain(rule);
      expect(clock).toBe(mode === "permanent" ? 0 : 180_000);
      if (mode === "permanent") expect(pause).not.toHaveBeenCalled();
    }
  } finally { worker.mockRestore(); pause.mockRestore(); now.mockRestore(); log.mockRestore(); await shutdownTaskPageWorker(); }
});
