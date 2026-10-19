import path from "node:path";
import { statePath } from "@/lib/configDir";
import { appendLifecycleEvents } from "@/lib/lifecycle/journal";
import { canonicalProject } from "@/lib/projects/aliases";
import { waitForStateLock } from "@/lib/state/lockWait";
import { assertStateStartupMutation } from "@/lib/stateOwnership";
import { withTaskCompletion } from "@/lib/tasks/completion";
import { mutateTasksFile } from "@/lib/tasks/store";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { readPassAuthority } from "./store";

const MIGRATION = "curatorPlaceholderRetirement-v1";
const JOURNALED = `${MIGRATION}:journaled`;
type Retirement = { at: string; projects: Record<string, number> };

/** Run only inside the serving release's fenced startup barrier. The task
 * migration retains journal input so a lost journal acknowledgement replays. */
export async function retireCuratorPlaceholdersAtStartup(now = new Date().toISOString(), assertActive = () => {}): Promise<Record<string, number>> {
  const file = statePath("tasks.json");
  assertStateStartupMutation(path.dirname(file), "retire curator placeholders");
  return withViewerOperation("memory.curation-cleanup", async () => {
    const outcome = await waitForStateLock("memory.curation-cleanup.tasks", () => {
      assertActive();
      return mutateTasksFile(state => {
        const recorded = state.migrations?.[MIGRATION];
        if (recorded) return { state: undefined, result: { applied: false, retirement: JSON.parse(recorded) as Retirement, journaled: !!state.migrations?.[JOURNALED] } };
        const retirement: Retirement = { at: now, projects: {} };
        const tasks = state.tasks.map(task => {
          if (task.origin?.kind !== "launch" || task.status === "done" && task.board === "hidden" && task.groupHidden) return task;
          const pass = readPassAuthority(task.origin.key);
          if (!pass || pass.clientAttemptId !== task.origin.key || canonicalProject(pass.project) !== canonicalProject(task.project)) return task;
          retirement.projects[task.project] = (retirement.projects[task.project] ?? 0) + 1;
          return withTaskCompletion({ ...task, status: "done", board: "hidden", groupHidden: { at: now, by: "agent" }, updatedAt: now }, task);
        });
        return { state: { ...state, tasks, migrations: { ...state.migrations, [MIGRATION]: JSON.stringify(retirement) } }, result: { applied: true, retirement, journaled: false } };
      }, file);
    });
    if (outcome.journaled) return {};
    await waitForStateLock("memory.curation-cleanup.journal", () => {
      assertActive();
      appendLifecycleEvents(Object.entries(outcome.retirement.projects).sort(([a], [b]) => a.localeCompare(b)).map(([project, count]) => ({
        key: `${MIGRATION}:${project}`, type: "task_finished", at: outcome.retirement.at, project, role: "curator",
        summary: `Retired and hid ${count} curator placeholder tasks.`,
      })));
    });
    await waitForStateLock("memory.curation-cleanup.acknowledge", () => {
      assertActive();
      mutateTasksFile(state => ({ state: { ...state, migrations: { ...state.migrations, [JOURNALED]: now } }, result: undefined }), file);
    });
    return outcome.applied ? outcome.retirement.projects : {};
  });
}
