import { withTaskCompletion } from "@/lib/tasks/completion";
import { admissionSnapshot } from "@/lib/tasks/groupHide";
import { mutateTasks, TASKS_FILE } from "@/lib/tasks/store";
import { waitForStateLock } from "@/lib/state/lockWait";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { reportAttemptId, TELEGRAM_REPORT_PROJECT } from "./reportLineage";

/** Retire the placeholder admitted for this report while retaining its run. */
export async function finishTelegramReportTask(runId: string, finishedAt: string): Promise<void> {
  const clientAttemptId = reportAttemptId(runId);
  await withViewerOperation("telegram.report-task-settle", () => waitForStateLock("telegram.report-task-settle", () => mutateTasks(tasks => {
    const task = tasks.find(row => row.project === TELEGRAM_REPORT_PROJECT
      && row.origin?.kind === "launch" && row.origin.key === clientAttemptId);
    if (!task) return { tasks: undefined, result: undefined };
    if (task.status === "done" && task.board === "hidden" && task.groupHidden) {
      return { tasks: undefined, result: undefined };
    }
    const finished = withTaskCompletion({
      ...task,
      status: "done",
      board: "hidden",
      groupHidden: { at: finishedAt, by: "agent", admitted: admissionSnapshot(task.assignments) },
      updatedAt: finishedAt,
    }, task);
    return { tasks: tasks.map(row => row.id === task.id ? finished : row), result: undefined };
  }, TASKS_FILE)));
}
