import path from "node:path";
import { statePath } from "@/lib/configDir";
import { seatHostRecoveryCard } from "@/lib/monitor/seatHostRecovery";
import { isStoredPipeline } from "@/lib/pipelines/store";
import { waitForStateLock } from "@/lib/state/lockWait";
import { readStateCollectionRevisions, visitStateCollectionsRows } from "@/lib/state/sqliteStateStore";
import { assertStateStartupMutation } from "@/lib/stateOwnership";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { withTaskCompletion } from "./completion";
import { loadTasksFile, mutateTasksFile } from "./store";
import type { BoardTask } from "./types";

export const SEAT_RECOVERY_CLEANUP = "seat-recovery-placeholders-v1";
const collections = ["pipelines", "pipelines_archive"];
const generatedFields = new Set(["id", "project", "status", "text", "details", "placement", "assignments", "createdAt", "updatedAt", "revision"]);
const successText = new Set((["uk", "en"] as const).map(locale => seatHostRecoveryCard({
  id: "", conversationId: "", seatEpoch: 0, at: "", state: "revived", detail: "", told: false,
}, locale).detail));

/** Conservative proof of an untouched generated success notice. Presentation
 * edits can leave updatedAt unchanged, so unknown and optional fields exclude it. */
export function isEmptySeatRecoveryTask(task: BoardTask, linkedTasks: ReadonlySet<string>): boolean {
  return task.status === "inbox" && task.placement === "unplaced"
    && task.assignments.length === 0 && !linkedTasks.has(task.id)
    && task.createdAt === task.updatedAt && successText.has(task.text)
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z: revived; shared composer recovery started a fresh host\n\nmonitor-ref: seat-host-recovery-[a-f0-9]{32}$/.test(task.details ?? "")
    && Object.entries(task).every(([key, value]) => value === undefined || generatedFields.has(key));
}

/** Called inside the serving release's startup barrier. The marker and closes
 * commit together; a later operator reopen survives every subsequent startup. */
export async function retireSeatRecoveryPlaceholdersAtStartup(now = new Date().toISOString(), assertActive = () => {}): Promise<number> {
  const file = statePath("tasks.json");
  const database = statePath("state.sqlite");
  assertStateStartupMutation(path.dirname(file), "retire seat recovery placeholders");
  return withViewerOperation("tasks.seat-recovery-cleanup", async () => {
    const initial = loadTasksFile(file);
    if (initial.migrations?.[SEAT_RECOVERY_CLEANUP]) return 0;
    const linkedTasks = new Set<string>();
    const candidates = new Set(initial.tasks.filter(task => isEmptySeatRecoveryTask(task, linkedTasks)).map(task => task.id));
    // One startup scan with timer opportunities, retaining candidate identities
    // only. An installation without these notices needs no history scan.
    const revisions = candidates.size ? await visitStateCollectionsRows(database, collections, record => {
      if (!isStoredPipeline(record)) throw new Error("seat recovery cleanup cannot verify pipeline membership");
      for (const id of record.taskIds) if (candidates.has(id)) linkedTasks.add(id);
    }) : null;
    return waitForStateLock("tasks.seat-recovery-cleanup", () => {
      assertActive();
      assertStateStartupMutation(path.dirname(file), "retire seat recovery placeholders");
      return mutateTasksFile(state => {
        if (state.migrations?.[SEAT_RECOVERY_CLEANUP]) return { state: undefined, result: 0 };
        // The task transaction holds the shared SQLite writer fence. A pipeline
        // link added during the cooperative scan must force a fresh startup.
        if (revisions) {
          const current = readStateCollectionRevisions(database, collections);
          if (collections.some(name => current.get(name) !== revisions.get(name))) {
            throw new Error("seat recovery cleanup pipeline membership changed; retry startup");
          }
        }
        let closed = 0;
        const tasks = state.tasks.map(task => {
          if (!candidates.has(task.id) || !isEmptySeatRecoveryTask(task, linkedTasks)) return task;
          closed++;
          return withTaskCompletion({ ...task, status: "done", updatedAt: now }, task);
        });
        return { state: { ...state, tasks, migrations: { ...state.migrations, [SEAT_RECOVERY_CLEANUP]: now } }, result: closed };
      }, file);
    });
  });
}
