import { statePath } from "@/lib/configDir";
import { canonicalProject } from "@/lib/projects/aliases";
import { projectInfoFromCwd } from "@/lib/scanner/describe";
import { waitForStateLock } from "@/lib/state/lockWait";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { createTask } from "./commands";
import { withTaskCompletion } from "./completion";
import { mutateTasks } from "./store";

const SYSTEM_RUN_ORIGIN = "internal-autonomous-runs";

/** Autonomous service turns keep ordinary task membership, off the board.
 * An already admitted legacy attempt keeps its original task on replay. */
export async function withSystemRunTask(body: Record<string, unknown>, now = new Date().toISOString()): Promise<Record<string, unknown>> {
  if (typeof body.taskId === "string" && body.taskId.trim()) return body;
  const project = canonicalProject(typeof body.project === "string" && body.project.trim()
    ? body.project : projectInfoFromCwd(typeof body.cwd === "string" ? body.cwd : "")?.project ?? "other");
  const taskId = await withViewerOperation("tasks.system-run", () => waitForStateLock("tasks.system-run", () => mutateTasks(tasks => {
    const legacy = tasks.find(task => task.project === project && task.origin?.kind === "launch" && task.origin.key === body.clientAttemptId);
    let task = legacy ?? tasks.find(task => task.project === project && task.origin?.kind === "launch" && task.origin.key === SYSTEM_RUN_ORIGIN);
    if (!task) {
      const made = createTask(tasks, { project, text: "Службові запуски", board: "hidden", placement: "unplaced" }, [], { now: () => now, actor: "agent" });
      if (!made.ok) throw new Error(made.error);
      task = { ...made.task, origin: { kind: "launch", key: SYSTEM_RUN_ORIGIN, refinement: "titled" } };
      tasks = [...tasks, task];
    }
    // Omitting the optional admission snapshot keeps subsequent service turns
    // in this same hidden group, including path attribution and resume.
    if (task.status === "done" && task.board === "hidden" && task.groupHidden && !task.groupHidden.admitted) {
      return { tasks: undefined, result: task.id };
    }
    const hidden = withTaskCompletion({ ...task, status: "done", board: "hidden", groupHidden: { at: now, by: "agent" }, updatedAt: now }, task);
    return { tasks: tasks.map(row => row.id === task.id ? hidden : row), result: task.id };
  }, statePath("tasks.json"))));
  return { ...body, taskId };
}
