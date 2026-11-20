import { conversationTree } from "@/lib/conversationTree";
import { projectClaudeDesktopChats } from "@/lib/scanner/claudeDesktop";
import { codexThreadIdFromPath } from "@/lib/scanner/codexNative";
import type { FileEntry } from "@/lib/types";

import type { BoardTask } from "./types";

type ChatFile = Pick<FileEntry, "engine" | "kind" | "mtime" | "parent" | "nativeThreadId" | "nativeParentThreadId" | "nativeForkSourceThreadId">;
type ChatTask = Pick<BoardTask, "id" | "project" | "origin" | "assignments">;

/** Project known transcript relationships onto task IDs. The board's file
 * shortlist may omit an older transcript while its assignment remains. */
export function taskChatParents(
  tasks: readonly ChatTask[],
  fileFor: (pathname: string, project: string) => ChatFile | null | undefined,
  desktopChats?: Parameters<typeof projectClaudeDesktopChats>[1],
): ReadonlyMap<string, string> {
  const projects = new Map<string, Map<string, { taskId: string; primary: boolean; ambiguous: boolean; file: ChatFile & Pick<FileEntry, "path" | "project" | "conversationId"> }>>();
  for (const task of tasks) {
    for (const assignment of task.assignments) {
      const pathname = assignment.path;
      if (!pathname || assignment.state === "failed") continue;
      const scanned = fileFor(pathname, task.project);
      if (scanned === null) continue;
      const engine = scanned?.engine ?? assignment.engine;
      if (engine !== "claude" && engine !== "codex") continue;
      const primary = task.origin?.kind === "conversation" && task.origin.key === (assignment.conversationId ?? pathname);
      let rows = projects.get(task.project);
      if (!rows) projects.set(task.project, rows = new Map());
      const previous = rows.get(pathname);
      if (previous) {
        if (previous.taskId === task.id) {
          if (primary) previous.primary = true;
          continue;
        }
        if (primary === previous.primary) previous.ambiguous = true;
        if (previous.primary || !primary) continue;
      }
      rows.set(pathname, {
        taskId: task.id, primary, ambiguous: false,
        file: {
          ...scanned, path: pathname, project: task.project, engine,
          kind: scanned?.kind ?? "session",
          mtime: scanned?.mtime ?? Date.parse(assignment.at) / 1000,
          parent: scanned?.parent ?? null,
          conversationId: assignment.conversationId ?? undefined,
          nativeThreadId: engine === "codex" ? scanned?.nativeThreadId ?? codexThreadIdFromPath(pathname) : null,
        },
      });
    }
  }
  const parents = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const rows of projects.values()) {
    const candidates = [...rows.values()].filter(row => !row.ambiguous).map(row => row.file);
    // The Desktop adapter never writes a null parent; map the optional
    // relationship back to the same shape used by the catalog tree.
    const desktop = projectClaudeDesktopChats(candidates.map(file => ({ ...file, parent: file.parent ?? undefined })), desktopChats);
    const families = conversationTree(desktop.map(file => ({ ...file, parent: file.parent ?? null })));
    const remaining = [...families];
    while (remaining.length) {
      const branch = remaining.pop()!;
      const parentId = rows.get(branch.file.path)!.taskId;
      for (const child of branch.children) {
        remaining.push(child);
        const id = rows.get(child.file.path)!.taskId;
        if (id === parentId) continue;
        const previous = parents.get(id);
        if (previous && previous !== parentId) ambiguous.add(id);
        parents.set(id, parentId);
      }
    }
  }
  for (const id of ambiguous) parents.delete(id);
  // Two multi-chat cards can imply a task-level cycle without a chat cycle.
  for (const id of parents.keys()) {
    const seen = new Set([id]);
    let parent = parents.get(id);
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      parent = parents.get(parent);
    }
    if (parent === id) for (const member of seen) parents.delete(member);
  }
  return parents;
}
