import path from "node:path";
import { assertStateStartupMutation } from "@/lib/stateOwnership";
import { mutateTasksFile, TASKS_FILE } from "@/lib/tasks/store";
import { sharedLinkState } from "./runtimeState";
import { linkedContext } from "./linked";

const completed = sharedLinkState("taskRepair.completed", () => new Set<string>());

/** Runs on the next task exchange, inside the task-store transaction. The
 * marker commits with the rows, so retries and other bundles cannot reapply it. */
export function repairLinkedTasks(filePath = TASKS_FILE): void {
  if (completed.has(filePath)) return;
  const context = linkedContext();
  if (!context.self || !context.all.size) return;
  const self = context.self;
  assertStateStartupMutation(path.dirname(path.resolve(filePath)), "linked task board repair");
  mutateTasksFile((state) => {
    const marker = "linkedArrivalsBoardV1";
    if (state.migrations?.[marker]) return { state: undefined, result: undefined };
    const tasks = state.tasks.map((task) => task.sync && task.machine && task.machine !== self.id && task.status === "done" && task.board === undefined
      ? { ...task, board: "hidden" as const } : task);
    return { state: { ...state, tasks, migrations: { ...state.migrations, [marker]: new Date().toISOString() } }, result: undefined };
  }, filePath);
  completed.add(filePath);
}
