import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { statePath } from "@/lib/configDir";
import { pipelineRecordReader } from "@/lib/pipelines/store";
import { loadTasksForList } from "@/lib/tasks/store";
import type { TemporaryDataAuthority } from "@/lib/runtime/temporaryDataRetention";
import type { TemporaryDataCandidate } from "@/lib/runtime/temporaryDataStore";
import type { BoardTask } from "@/lib/tasks/types";

const taskText = new WeakMap<BoardTask, string>();

function resolveReferencedPath(input: string): string {
  const root = path.parse(input).root;
  if (!path.isAbsolute(input)) throw new Error("task evidence path must be absolute");
  const pending = input.slice(root.length).split(path.sep).filter(Boolean);
  let current = root, links = 0;
  while (pending.length) {
    const part = pending.shift()!;
    if (part === ".") continue;
    if (part === "..") { current = path.dirname(current); continue; }
    const next = path.join(current, part), stat = fs.lstatSync(next, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) {
      if (++links > 40) throw new Error("task evidence symlink depth exceeded");
      const target = fs.readlinkSync(next);
      const targetRoot = path.parse(target).root;
      if (path.isAbsolute(target)) current = targetRoot;
      pending.unshift(...target.slice(targetRoot.length).split(path.sep).filter(Boolean));
    } else current = next;
  }
  return current;
}

function evidenceTargets(body: string): string[] {
  const values = new Set<string>();
  for (const match of body.matchAll(/file:\/\/[^\s<>"')\]]+/g)) {
    try {
      const url = match[0];
      if (/%00/i.test(url)) continue;
      // URL parsing collapses dot segments before the filesystem sees them.
      // Protect just those components through decoding, then remove the sentinel.
      const preserved = url.replace(/\/((?:\.|%2e){1,2})(?=\/|[?#]|$)/gi, "/$1%00");
      values.add(fileURLToPath(preserved).replaceAll("\0", ""));
    } catch { /* Unsupported or malformed task link. */ }
  }
  for (const match of body.matchAll(/(?<![\w:])\/(?:[^\s"'<>()[\]]+)/g)) {
    values.add(match[0]);
    values.add(match[0].replace(/[),.;]+$/, ""));
  }
  return [...values];
}

/** The board has both structured lane/launch membership and human-written
 * evidence references. Check across projects: a task can link another lane's
 * report. The store only decodes changed rows, including at the dispatch edge. */
export function openTaskReferencesEvidence(row: TemporaryDataCandidate, authority: TemporaryDataAuthority, current = row.directory): boolean {
  const relative = path.relative(statePath(), row.directory).split(path.sep).join("/");
  const absolute = encodeURI(row.directory);
  const evidence = [row.directory, current].map(resolveReferencedPath);
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
    for (const target of evidenceTargets(body)) {
      try {
        const physicalTarget = resolveReferencedPath(target);
        if (evidence.some(directory => physicalTarget === directory || physicalTarget.startsWith(directory + path.sep))) return true;
      } catch { /* A malformed, inaccessible, or cyclic link cannot prove a hold. */ }
    }
    return body.includes(relative) || body.includes(encodeURI(relative)) || body.includes(absolute)
      || laneIds.some(id => body.includes(`evidence/${id}`) || body.includes(id))
      || row.kind === "ownerless-copy" && body.includes(path.basename(row.directory))
      || row.kind === "agent-evidence" && body.includes(`evidence/agents/${evidenceOwner}`);
  });
}
