import { SEAT_TICK_ANNOUNCED_MAINTENANCE_LIMIT } from "./types";

export function maintenancePageToken(runId: string, page: number, pages?: number): string {
  return `${runId}:page:${page}${pages === undefined ? "" : `/${pages}`}`;
}

/** A landing records only its visible pages. Keep partial receipts together
 * and replace them with the run ID once the full delivered set is proved. */
export function maintenanceAnnouncements(before: readonly string[], delivered: readonly string[] = []): string[] {
  const runs = new Map<string, { pages: Set<number>; total?: number; complete?: boolean }>();
  for (const token of [...before, ...delivered]) {
    const page = /^(.+):page:(\d+)(?:\/(\d+))?$/.exec(token);
    const id = page?.[1] ?? token;
    const run = runs.get(id) ?? { pages: new Set<number>() };
    if (page) {
      run.pages.add(Number(page[2]));
      if (page[3] !== undefined) run.total = Number(page[3]);
    } else run.complete = true;
    runs.delete(id);
    runs.set(id, run);
  }
  return [...runs].slice(-SEAT_TICK_ANNOUNCED_MAINTENANCE_LIMIT).flatMap(([id, run]) => {
    const total = run.total;
    if (run.complete || total && [...run.pages].filter(page => page < total).length === total) return [id];
    return [...run.pages].map(page => maintenancePageToken(id, page));
  });
}
