import fs from "node:fs";

import { atomicWriteText } from "@/lib/agent/artifacts";
import { statePath } from "@/lib/configDir";

/**
 * When the operator last opened each task's album, so the card can say there
 * is something new and the album can mark it. Kept by the Viewer rather than
 * the browser: the phone and the desktop see the same "new".
 */

const MAX_TASKS = 5000;

export interface AlbumSeenStore {
  lastOpened(taskId: string): number | null;
  markOpened(taskId: string, atMs: number): number;
}

export function fileAlbumSeenStore(filePath: string = statePath("task-album-seen.json")): AlbumSeenStore {
  let cache: { mtimeMs: number; seen: Record<string, number> } | null = null;
  const read = (): Record<string, number> => {
    let mtimeMs = -1;
    try {
      mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {
      return {};
    }
    if (cache?.mtimeMs === mtimeMs) return cache.seen;
    let seen: Record<string, number> = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        seen = Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
      }
    } catch {
      seen = {};
    }
    cache = { mtimeMs, seen };
    return seen;
  };
  return {
    lastOpened: (taskId) => read()[taskId] ?? null,
    markOpened(taskId, atMs) {
      const seen = { ...read() };
      /* Opening never moves the mark back: an older tab's late write loses. */
      const at = Math.max(seen[taskId] ?? 0, Math.floor(atMs));
      delete seen[taskId];
      seen[taskId] = at;
      const entries = Object.entries(seen);
      atomicWriteText(filePath, JSON.stringify(Object.fromEntries(entries.slice(Math.max(0, entries.length - MAX_TASKS)))));
      cache = null;
      return at;
    },
  };
}

let production: AlbumSeenStore | null = null;
export function albumSeenStore(): AlbumSeenStore {
  production ??= fileAlbumSeenStore();
  return production;
}
