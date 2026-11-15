import { waitForStateLock } from "@/lib/state/lockWait";
import { agentRegistry } from "@/lib/agent/registry";
import { mutateTasksAsync as mutateTasks } from "@/lib/tasks/store";
import { isoNow } from "@/lib/tasks/helpers";
import { recordSpawnNoticeObligation } from "@/lib/spawnNotice/store";

import type { RuntimeConsumerPorts, SpawnTurnEnded } from "./consumers";

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
