import { waitForStateLock } from "@/lib/state/lockWait";
import { agentRegistry } from "@/lib/agent/registry";
import { isoNow, newRound } from "@/lib/flows/engine";
import { withFlowMutation } from "@/lib/flows/store";
import type { Flow } from "@/lib/flows/types";
import { mutateTasksAsync as mutateTasks } from "@/lib/tasks/store";
import { recordSpawnNoticeObligation } from "@/lib/spawnNotice/store";
import { withWorkflowMutation } from "@/lib/workflows/store";

import type { RuntimeConsumerPorts, SpawnTurnEnded } from "./consumers";

const READY = /^REVIEW_READY:\s*(.*)$/m;

function readyNote(value: string | null): string | null {
  if (!value) return null;
  const matched = READY.exec(value);
  return matched ? matched[1]!.trim().slice(0, 2_000) : null;
}

export function advanceFlowFromRuntime(flow: Flow, note: string | null): boolean {
  const ready = readyNote(note);
  if (!ready || (flow.state !== "waiting_ready" && flow.state !== "fixing")) return false;
  flow.rounds.push(newRound(flow, "marker", ready));
  flow.state = flow.mode === "manual" ? "spawn_pending" : "spawning";
  flow.stateDetail = null;
  return true;
}

/**
 * Record the notice a settled turn owes its launcher
 * (docs/design/spawn-completion-notice.md §2): one keyed registry read and one
 * insert-if-absent, nothing else, because the host answers the append only
 * after this returns. A child with no launcher, one that opted out, and one a
 * pipeline, flow or seat already reports are owed nothing.
 */
export function recordSpawnTurnEnded(
  turn: SpawnTurnEnded,
  ports: {
    child: (id: string) => ReturnType<ReturnType<typeof agentRegistry>["spawnNoticeChild"]>;
    record: typeof recordSpawnNoticeObligation;
  } = { child: (id) => agentRegistry().spawnNoticeChild(id), record: recordSpawnNoticeObligation },
): boolean {
  const child = ports.child(turn.conversationId);
  if (!child?.launcher?.notify || child.contained || child.launcher.conversationId === child.conversationId) return false;
  return ports.record({
    childConversationId: child.conversationId,
    turnId: turn.turnId,
    launcherConversationId: child.launcher.conversationId,
    outcome: turn.outcome,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
  });
}

export function createServerRuntimeConsumers(): RuntimeConsumerPorts {
  return {
    flowReady(flowId, note) {
      return withFlowMutation(async (flows, persist) => {
        const flow = flows.find((item) => item.id === flowId);
        if (!flow) return undefined;
        if (advanceFlowFromRuntime(flow, note)) await persist();
        return flow;
      });
    },
    workflowStageCompleted(workflowId, stage) {
      return withWorkflowMutation(async (workflows, persist) => {
        const workflow = workflows.find((item) => item.id === workflowId);
        if (!workflow) return undefined;
        if (workflow.stageIndex !== stage) return workflow;
        const run = workflow.stageRuns[stage];
        if (!run || run.doneAt) return workflow;
        run.doneAt = isoNow();
        const next = workflow.template.stages[stage + 1];
        if (next) {
          workflow.stageIndex = stage + 1;
          workflow.state = next.kind === "review-loop" ? "reviewing" : "implementing";
        } else {
          workflow.state = "finishing";
        }
        workflow.stateDetail = null;
        await persist();
        return workflow;
      });
    },
    taskDeliveryAcknowledged(taskId, assignmentId) {
      return mutateTasks((tasks) => {
        const task = tasks.find((item) => item.id === taskId);
        if (!task) return { tasks: undefined, result: undefined };
        const assignment = task.assignments.find((item) => item.path === assignmentId || item.panePid === Number(assignmentId));
        if (!assignment) return { tasks: undefined, result: task };
        assignment.state = "delivered";
        assignment.error = null;
        assignment.at = isoNow();
        task.updatedAt = isoNow();
        return { tasks, result: task };
      });
    },
    async spawnTurnEnded(turn) {
      await waitForStateLock("runtime.spawnTurnEnded", () => recordSpawnTurnEnded(turn));
    },
  };
}
