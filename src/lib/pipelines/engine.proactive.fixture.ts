import { expect, harness, createPipelineFromRequest, loadPipelines, savePipelines, tickPipelines, finishReported, engineModule } from "./engine.fixture";
import { admitProactiveTask } from "@/lib/tasks/proactive";
import { candidate, NOW } from "@/lib/tasks/proactive.fixture";
import { applySeatTickSettingsChange, defaultSeatTickSettings, writeSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } from "@/lib/orchestrator/seats";
import { agentRegistry } from "@/lib/agent/registry";
import { proactiveObservation } from "@/lib/accounts/proactiveReserve.fixture";
import { ensurePipelineForTask } from "./taskBinding";

export const stages = [
  { id: "scope", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review the frozen scope", next: "build", onFail: { to: "build", maxRounds: 1 } },
  { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build the reviewed outcome", next: "review" },
  { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review the implemented outcome", next: null, onFail: { to: "build", maxRounds: 1 } },
] as const;
export async function fixture(name: string, cloud = false, repoDir = "/repo", project = `proactive-${name}`, graph: readonly { id: string; [key: string]: unknown }[] = stages) {
  savePipelines([]);
  const h = harness();
  h.advanceWallClock(NOW - 1_000_000);
  h.ports.projectForCwd = () => project;
  h.setConversationActive(false); h.setPaneAlive(false);
  const at = new Date(NOW).toISOString();
  const intent = beginOrchestratorSeatIntent({ project, mandate: "Maintain this project", clientRequestId: `seat-${name}`, mode: "existing", now: at });
  if (!("seat" in intent)) throw new Error("seat intent absent");
  const seat = completeOrchestratorSeatIntent({ project, clientRequestId: `seat-${name}`, conversationId: `conversation_seat_${name}`, path: null, now: at });
  if (!("seat" in seat)) throw new Error("seat absent");
  const changed = applySeatTickSettingsChange(defaultSeatTickSettings(project), { enabled: true, autonomy: { enabled: true, hours: null, proactive: { enabled: true } } },
    { at, actor: { kind: "gateway", project: null, conversationId: null, seatEpoch: null } });
  if (!changed.ok) throw new Error(changed.error);
  writeSeatTickSettings(project, changed.settings);
  const { task } = await admitProactiveTask({ ...candidate(`candidate-${name}`), project },
    { project, startedAt: at, conversationId: seat.seat.conversationId!, seatEpoch: seat.seat.seatEpoch });
  agentRegistry().recordQuotaObservation(proactiveObservation());
  const inputContext = ensurePipelineForTask(task, [], { repoDir, engine: "codex", model: null, effort: null, srcPath: "/codex/creator.jsonl" })!.inputContext;
  const request = { task: task.text, spec: "Retain the useful filter", inputContext, repoDir, taskIds: [task.id], publication: cloud ? "remote-branch" as const : "internal" as const,
    stages: structuredClone(graph).map(stage => cloud && stage.id === "build" ? { ...stage, runtime: "codex-cloud", engine: "codex", model: "gpt-6.1-sol" } : stage) as never };
  const made = await createPipelineFromRequest(request, h.ports);
  if (!made.pipeline) throw new Error(made.error);
  const id = made.pipeline.id;
  const current = () => loadPipelines().find(row => row.id === id)!;
  const tick = async (n = 3) => { for (let i = 0; i < n; i++) await tickPipelines([], h.ports); };
  const pass = async (verdict: "pass" | "fail" | "needs_decision" = "pass") => {
    const report = await engineModule.reportStageCompletion({ verdict, ...(verdict !== "pass" ? { findings: [{ severity: "P1", text: "Scope authority is required" }] } : {}) },
      { kind: "agent", role: "reviewer", conversationId: "conversation_stage_1" }, h.ports);
    expect(report.error).toBeUndefined();
    const entry = finishReported(h, "/codex/stage-1.jsonl", "pass", "Frozen scope checked");
    await tickPipelines([entry], h.ports);
    await tick();
  };
  const complete = async () => {
    await tick(); await pass();
    for (const [n, role] of [[2, "builder"], [3, "reviewer"]] as const) {
      expect((await engineModule.reportStageCompletion({ verdict: "pass" },
        { kind: "agent", role, conversationId: `conversation_stage_${n}` }, h.ports)).error).toBeUndefined();
      await tickPipelines([finishReported(h, `/codex/stage-${n}.jsonl`, "pass", "Checked")], h.ports);
      await tick();
    }
  };
  return { h, task, project, at, request, id, current, tick, pass, complete, seatConversationId: seat.seat.conversationId! };
}
