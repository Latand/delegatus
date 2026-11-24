import type { TaskStatus } from "@/lib/tasks/types";

export const FIRST_SCREEN_VERSION = 1;
export const FIRST_SCREEN_PROJECTS = 6;
export const FIRST_SCREEN_CARDS_PER_COLUMN = 8;
const MAX_TITLE = 256;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type FirstScreenColumn = { status: TaskStatus; titles: string[] };
export type FirstScreenProjection = { active?: TaskStatus; columns: FirstScreenColumn[] };
export type FirstScreenLayout = FirstScreenProjection & { revision: number; savedAt: number };
export type FirstScreenSeat = { name: string | null; savedAt: number };
export type ProjectFirstScreen = {
  version: typeof FIRST_SCREEN_VERSION;
  savedAt: number;
  scope: string;
  project: string;
  desktop?: FirstScreenLayout;
  phone?: FirstScreenLayout;
  seat?: FirstScreenSeat;
};

export const FIRST_SCREEN_STATUSES = ["inbox", "assigned", "blocked", "done"] as const;

export function firstScreenTitle(text: string): string {
  return text.trim().slice(0, MAX_TITLE);
}

export function firstScreenColumn(status: TaskStatus, titles: Iterable<string>): FirstScreenColumn {
  const visible: string[] = [];
  for (const title of titles) {
    if (visible.length === FIRST_SCREEN_CARDS_PER_COLUMN) break;
    const text = firstScreenTitle(title);
    if (text) visible.push(text);
  }
  return { status, titles: visible };
}

const title = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_TITLE;

const fresh = (savedAt: number, now: number): boolean =>
  Number.isFinite(savedAt) && savedAt <= now && now - savedAt <= MAX_AGE_MS;

function readLayout(value: unknown, now: number): FirstScreenLayout | undefined {
  if (!value || typeof value !== "object") return;
  const { revision, savedAt, columns, active } = value as FirstScreenLayout;
  if (!Number.isSafeInteger(revision) || revision < 0 || !fresh(savedAt, now)
    || (active !== undefined && !FIRST_SCREEN_STATUSES.includes(active))
    || !Array.isArray(columns) || columns.length !== FIRST_SCREEN_STATUSES.length
    || ![...columns].every((column, index) => column?.status === FIRST_SCREEN_STATUSES[index]
      && Array.isArray(column.titles) && column.titles.length <= FIRST_SCREEN_CARDS_PER_COLUMN
      && [...column.titles].every(title))) return;
  return { revision, savedAt, active, columns: columns.map(({ status, titles }) => ({ status, titles })) };
}

export function readFirstScreenParts(value: unknown, scope: string, project: string, now: number): ProjectFirstScreen | null {
  if (!value || typeof value !== "object") return null;
  const row = value as ProjectFirstScreen;
  if (row.version !== FIRST_SCREEN_VERSION || row.scope !== scope || !/^[a-f0-9]{64}$/.test(scope)
    || row.project !== project || typeof project !== "string" || project.length === 0 || project.length > 256
    || !fresh(row.savedAt, now)) return null;
  const desktop = readLayout(row.desktop, now);
  const phone = readLayout(row.phone, now);
  const seat = row.seat && fresh(row.seat.savedAt, now) && (row.seat.name === null || title(row.seat.name))
    ? { name: row.seat.name, savedAt: row.seat.savedAt } : undefined;
  if (!desktop && !phone && !seat) return null;
  return { version: row.version, scope, project, savedAt: row.savedAt, desktop, phone, seat };
}

export function mergeFirstScreenParts(previous: ProjectFirstScreen | undefined, next: ProjectFirstScreen): ProjectFirstScreen {
  const newerLayout = (old?: FirstScreenLayout, update?: FirstScreenLayout) => {
    if (!old || (update && update.revision >= old.revision && update.savedAt >= old.savedAt)) return update;
    return old;
  };
  const seat = !previous?.seat || (next.seat && next.seat.savedAt >= previous.seat.savedAt) ? next.seat : previous.seat;
  return {
    ...next, savedAt: Math.max(previous?.savedAt ?? 0, next.savedAt),
    desktop: newerLayout(previous?.desktop, next.desktop),
    phone: newerLayout(previous?.phone, next.phone),
    seat,
  };
}
