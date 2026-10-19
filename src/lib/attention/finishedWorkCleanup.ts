import { agentRegistry, readOnlyConversationLookupFromSnapshot } from "@/lib/agent/registry";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import { loadPipelinesForList, loadArchivedPipelinesForList, loadArchivedPipelinesForListAsync, pipelineRegistryHealth } from "@/lib/pipelines/store";
import { waitForStateLock } from "@/lib/state/lockWait";
import { assertStateStartupMutation } from "@/lib/stateOwnership";
import { loadTasksFile, mutateTasksFile } from "@/lib/tasks/store";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { finishedWorkIndex } from "./finishedWork";

export const FINISHED_WORK_CLEANUP = "finishedWorkInbox-v1";

/** One fenced startup pass includes archived lanes. It changes only the
 * column of unfinished tasks; task completion and process retirement keep
 * their own authorities. The marker and column changes commit together. */
export async function cleanupFinishedWorkAtStartup(now = new Date().toISOString(), assertActive = () => {}): Promise<number> {
  const file = statePath("tasks.json");
  assertStateStartupMutation(path.dirname(file), "withdraw finished work from In progress");
  if (loadTasksFile(file).migrations?.[FINISHED_WORK_CLEANUP]) return 0;
  await withViewerOperation("attention.finished-cleanup.archive", () => loadArchivedPipelinesForListAsync());
  return withViewerOperation("attention.finished-cleanup", () => waitForStateLock("attention.finished-cleanup", () => {
    assertActive();
    return mutateTasksFile(state => {
      if (state.migrations?.[FINISHED_WORK_CLEANUP]) return { state: undefined, result: 0 };
      // Read AFTER admission. No earlier snapshot can overwrite a reopening.
      const finished = finishedWorkIndex(state.tasks, [...loadPipelinesForList(), ...loadArchivedPipelinesForList()]);
      if (pipelineRegistryHealth().length) throw new Error("cannot verify pipeline membership for finished work cleanup");
      const snapshot = agentRegistry().readOnlySnapshot();
      const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
      const live = (reference: { conversationId?: string | null; path?: string | null }) => {
        const conversation = reference.conversationId?.startsWith("conversation_")
          ? lookup.conversation(reference.conversationId as `conversation_${string}`)
          : reference.path ? lookup.conversationForPath(reference.path) : null;
        const generation = conversation?.generations.at(-1);
        const entry = conversation && generation ? snapshot.entries[`${conversation.engine}:${generation.id}`] : null;
        return entry && entry.status !== "dead";
      };
      let count = 0;
      const tasks = state.tasks.map(task => {
        const status = finished.taskStatus(task);
        if (status === task.status || task.assignments.some(live)) return task;
        count += 1;
        const next = { ...task, status, updatedAt: now };
        delete next.statusBy;
        return next;
      });
      return { state: { ...state, tasks, migrations: { ...state.migrations, [FINISHED_WORK_CLEANUP]: now } }, result: count };
    }, file);
  }, { subject: "tasks" }));
}
