import "./engineEnvironment.fixture";
import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import crypto from "node:crypto";
import { create, harness, tickPipelines, loadPipelines, savePipelines } from "./engine.fixture";
import { roleMemoryCollection } from "@/lib/memory/roleStore";
import { shutdownTaskPageWorker, taskPageWorkerDiagnostics } from "@/lib/links/taskPageWorker";
import type { PrivacyWorkerObservation } from "@/lib/memory/privacyDiagnostics";

afterEach(async () => { await shutdownTaskPageWorker(); });

test("production stage preparation binds successful worker envelopes to its owning attempt", async () => {
  setSystemTime(new Date("2026-11-05T00:00:00Z"));
  let id = 0;
  const ids = spyOn(crypto, "randomUUID").mockImplementation(() => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`);
  try {
    savePipelines([]);
    roleMemoryCollection(true)!.boundedPatch(1, tx => tx.put({ kind: "rule", id: "r_attempt_trace", scope: "machine",
      rule: "Preserve amber orchard receipts until the owning operation completes", why: "", state: "active", hints: [],
      source: { project: "fixture", pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false,
        conversationId: "conversation_fixture" }, createdAt: "2026-11-05T00:00:00Z", changedAt: "2026-11-05T00:00:00Z" }));
    const h = harness();
    await create(h.ports, [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build with current privacy", next: null }] as never);
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    expect(h.spawnInputs).toHaveLength(1);
    const lane = loadPipelines()[0]!;
    const attempt = lane.runs[0]!.attempts.at(-1)!;
    const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
    const observed: PrivacyWorkerObservation[] = taskPageWorkerDiagnostics().privacy?.rows ?? [];
    const owned = observed.filter(row => row.owner !== "unknown" && row.owner.pipeline === digest(lane.id)
      && row.owner.stage === digest("build") && row.owner.attempt === attempt.n);
    expect(owned.some(row => row.phase === "queued")).toBe(true);
    expect(owned.some(row => row.phase === "started")).toBe(true);
    expect(owned.some(row => row.phase === "settled" && !row.failure)).toBe(true);
    expect(new Set(owned.map(row => row.requestId)).size).toBe(1);
  } finally { ids.mockRestore(); setSystemTime(); }
}, 30_000);
