/** When a browser tab last read a project's board, for A's sync schedule
    (docs/design/linked-installs.md M.5). Memory only; `/api/files` marks it. */
const presence = globalThis as typeof globalThis & { __llvBoardViewedAt?: Map<string, number> };

export function markBoardViewed(project: string | undefined, now = Date.now()): void {
  if (!project) return;
  const seen = presence.__llvBoardViewedAt ??= new Map();
  seen.set(project, now);
  if (seen.size > 256) for (const [key, at] of seen) if (now - at > 60_000) seen.delete(key);
}

/** Whether one of `projects` was read in the last `withinMs`. */
export function boardOpen(projects: Iterable<string>, now = Date.now(), withinMs = 30_000): boolean {
  const seen = presence.__llvBoardViewedAt;
  if (!seen?.size) return false;
  const recent = (project: string) => seen.has(project) && now - seen.get(project)! <= withinMs;
  if (recent("__overview__")) return true;
  for (const project of projects) if (recent(project)) return true;
  return false;
}
