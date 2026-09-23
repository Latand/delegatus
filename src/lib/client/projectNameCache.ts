/*
 * The project names this browser has seen (#2071).
 *
 * `/api/files` carries `projectDisplayNames`, but a cold start has nothing
 * until its first answer lands, and a header that falls back to the canonical
 * key shows `repo-<hash>` for that whole wait. This keeps the last names the
 * server gave, keyed by project, so the boot shell's inline script and the
 * first React frame both name the project the operator left.
 *
 * Presentation only: a remembered name never keys anything, and the live map
 * always wins over it (`projectTitle` in `@/lib/displayNames`). Bounded, most
 * recently confirmed first.
 */

export const PROJECT_NAMES_STORAGE_KEY = "llvProjectNames";
export const PROJECT_NAMES_CAP = 300;

type NameStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): NameStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

let parsedRaw: string | null | undefined;
let parsed: Record<string, string> = {};

function parse(raw: string | null): Record<string, string> {
  if (raw === parsedRaw) return parsed;
  let next: Record<string, string> = {};
  try {
    const value = raw ? JSON.parse(raw) as unknown : null;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      next = Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== ""));
    }
  } catch {
    next = {};
  }
  parsedRaw = raw;
  parsed = next;
  return next;
}

/** Every remembered name. Unreadable or absent storage reads as none. */
export function readCachedProjectNames(storage: NameStorage | null = defaultStorage()): Readonly<Record<string, string>> {
  if (!storage) return {};
  try {
    return parse(storage.getItem(PROJECT_NAMES_STORAGE_KEY));
  } catch {
    return {};
  }
}

export function cachedProjectName(project: string, storage: NameStorage | null = defaultStorage()): string | undefined {
  return readCachedProjectNames(storage)[project];
}

/**
 * Remember the names a certified answer carried. The answer's entries move to
 * the front, older ones follow, and the map is cut at the cap. Writes nothing
 * when nothing changed, so an identical poll costs no storage write.
 */
export function rememberProjectNames(names: Readonly<Record<string, string>>, storage: NameStorage | null = defaultStorage()): void {
  if (!storage) return;
  const incoming = Object.entries(names).filter(([, name]) => typeof name === "string" && name.trim() !== "");
  if (!incoming.length) return;
  const current = readCachedProjectNames(storage);
  if (incoming.every(([project, name]) => current[project] === name)) return;
  const next: Record<string, string> = {};
  for (const [project, name] of incoming) {
    if (Object.keys(next).length >= PROJECT_NAMES_CAP) break;
    next[project] = name;
  }
  for (const [project, name] of Object.entries(current)) {
    if (Object.keys(next).length >= PROJECT_NAMES_CAP) break;
    if (!(project in next)) next[project] = name;
  }
  try {
    storage.setItem(PROJECT_NAMES_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* quota or private mode: the names still apply for this page */
  }
}

/** Test seam: forget the parse memo so a test's fresh storage is read. */
export function resetProjectNameCacheForTest(): void {
  parsedRaw = undefined;
  parsed = {};
}
