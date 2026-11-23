import path from "node:path";
import { statePath } from "@/lib/configDir";
import { pipelineRecordReader } from "@/lib/pipelines/store";
import { loadTasksForList } from "@/lib/tasks/store";
import type { TemporaryDataAuthority } from "@/lib/runtime/temporaryDataRetention";
import type { TemporaryDataCandidate } from "@/lib/runtime/temporaryDataStore";
import type { BoardTask } from "@/lib/tasks/types";

const taskText = new WeakMap<BoardTask, string>();

/** The board has both structured lane/launch membership and human-written
 * evidence references. Check across projects: a task can link another lane's
 * report. The store only decodes changed rows, including at the dispatch edge. */
export function openTaskReferencesEvidence(row: TemporaryDataCandidate, authority: TemporaryDataAuthority): boolean {
  const relative = path.relative(statePath(), row.directory).split(path.sep).join("/");
  const absolute = encodeURI(row.directory);
  const laneIds = authority.pipelineIds ?? [];
  const linked = new Set(laneIds.flatMap(id => pipelineRecordReader(id).read()?.taskIds ?? []));
  const evidenceOwner = path.basename(path.dirname(row.directory));
  return loadTasksForList(statePath("tasks.json")).some(task => {
    if (task.status === "done") return false;
    if (linked.has(task.id) || row.kind === "agent-evidence" && task.assignments.some(assignment => assignment.launchId === row.owner)) return true;
    let body = taskText.get(task);
    if (body === undefined) {
      body = JSON.stringify(task);
      taskText.set(task, body);
    }
    return body.includes(relative) || body.includes(encodeURI(relative)) || body.includes(absolute)
      || laneIds.some(id => body.includes(`evidence/${id}`) || body.includes(id))
      || row.kind === "ownerless-copy" && body.includes(path.basename(row.directory))
      || row.kind === "agent-evidence" && body.includes(`evidence/agents/${evidenceOwner}`);
  });
}
