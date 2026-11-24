import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";

import { semanticTitle } from "@/lib/title";
import { recordValue, stringValue } from "./json";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CLI_ID = new RegExp(`^${UUID}$`, "i");
const DESKTOP_ID = new RegExp(`^local_${UUID}$`, "i");
const REFRESH_MS = 15_000;
const MAX_METADATA_BYTES = 1024 * 1024;

interface CachedDesktopFile {
  stamp: string;
  chat: DesktopChat;
  cliIds: string[];
}

interface DesktopChat {
  key: string;
  parentKey: string | null;
  currentId: string | null;
  title: string | null;
}

function cliId(value: unknown): string | null {
  return typeof value === "string" && CLI_ID.test(value) ? value.toLowerCase() : null;
}

function desktopId(value: unknown): string | null {
  return typeof value === "string" && DESKTOP_ID.test(value) ? value.toLowerCase() : null;
}

function directoryEntries(directory: string) {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Claude Desktop stores this presentation metadata outside the CLI logs. Only
 * join it to transcripts the caller already has permission to list or open. */
export function loadClaudeDesktopChats(root: string, parsed?: Map<string, CachedDesktopFile>): ReadonlyMap<string, DesktopChat> {
  const visited = new Set<string>();
  const byCliId = new Map<string, DesktopChat>();
  const ambiguous = new Set<string>();
  for (const organization of directoryEntries(root)) {
    if (!organization.isDirectory()) continue;
    const orgRoot = path.join(root, organization.name);
    for (const account of directoryEntries(orgRoot)) {
      if (!account.isDirectory()) continue;
      const scope = path.join(orgRoot, account.name);
      for (const file of directoryEntries(scope)) {
        const id = desktopId(file.name.endsWith(".json") ? file.name.slice(0, -5) : null);
        if (!id || !file.isFile()) continue;
        const filename = path.join(scope, file.name);
        try {
          const stat = lstatSync(filename);
          if (!stat.isFile() || stat.size > MAX_METADATA_BYTES) continue;
          visited.add(filename);
          const stamp = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
          let cached = parsed?.get(filename);
          if (cached?.stamp !== stamp) {
            const row = recordValue(JSON.parse(readFileSync(filename, "utf8")));
            if (!row || desktopId(row.sessionId) !== id) continue;
            const spawn = recordValue(row.spawnedFrom);
            const parentId = desktopId(row.forkedFromSessionId) ?? desktopId(spawn?.sessionId);
            const prior = Array.isArray(row.priorCliSessionIds) ? row.priorCliSessionIds : [];
            cached = {
              stamp,
              chat: {
                key: path.join(scope, id),
                parentKey: parentId && parentId !== id ? path.join(scope, parentId) : null,
                currentId: cliId(row.cliSessionId),
                title: semanticTitle(stringValue(row.title), 160) ?? semanticTitle(stringValue(spawn?.title), 160),
              },
              cliIds: [row.cliSessionId, ...prior].flatMap(value => {
                const nativeId = cliId(value);
                return nativeId ? [nativeId] : [];
              }),
            };
            parsed?.set(filename, cached);
          }
          const { chat, cliIds } = cached;
          for (const nativeId of cliIds) {
            if (ambiguous.has(nativeId)) continue;
            const previous = byCliId.get(nativeId);
            if (!previous || previous.key === chat.key) byCliId.set(nativeId, chat);
            else {
              byCliId.delete(nativeId);
              ambiguous.add(nativeId);
            }
          }
        } catch {
          // Desktop may replace a metadata file while it is being read.
        }
      }
    }
  }
  if (parsed) {
    for (const filename of parsed.keys()) if (!visited.has(filename)) parsed.delete(filename);
  }
  return byCliId;
}

let cached: { root: string; expiresAt: number; index: ReadonlyMap<string, DesktopChat>; parsed: Map<string, CachedDesktopFile> } | undefined;

export function claudeDesktopChats(): ReadonlyMap<string, DesktopChat> {
  const root = path.join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions");
  const now = Date.now();
  if (cached?.root === root && cached.expiresAt > now) return cached.index;
  const parsed = cached?.root === root ? cached.parsed : new Map<string, CachedDesktopFile>();
  const index = platform() === "darwin" ? loadClaudeDesktopChats(root, parsed) : new Map<string, DesktopChat>();
  cached = { root, expiresAt: now + REFRESH_MS, index, parsed };
  return index;
}

export function claudeDesktopChatForPath(pathname: string, index = claudeDesktopChats()): DesktopChat | undefined {
  const id = cliId(path.basename(pathname, ".jsonl"));
  return id ? index.get(id) : undefined;
}

interface ChatRow {
  path: string;
  parent?: string;
  project: string;
  engine: string;
  kind: string;
  mtime: number;
}

/** For the chat tree, show one currently available transcript per Desktop
 * session. Historical generations remain available in the flat catalog. */
export function projectClaudeDesktopChats<T extends ChatRow>(rows: readonly T[], index = claudeDesktopChats()): T[] {
  const desktopRows = new Map<string, DesktopChat>();
  const canonical = new Map<string, T>();
  const key = (project: string, chat: string) => JSON.stringify([project, chat]);
  for (const row of rows) {
    if (row.engine !== "claude" || row.kind !== "session") continue;
    const chat = claudeDesktopChatForPath(row.path, index);
    if (!chat) continue;
    desktopRows.set(row.path, chat);
    const group = key(row.project, chat.key);
    const previous = canonical.get(group);
    const currentName = chat.currentId + ".jsonl";
    const current = path.basename(row.path) === currentName;
    const previousIsCurrent = previous && path.basename(previous.path) === currentName;
    if (!previous || (current && !previousIsCurrent) ||
        (current === Boolean(previousIsCurrent) && row.mtime > previous.mtime)) canonical.set(group, row);
  }
  return rows.flatMap(row => {
    const chat = desktopRows.get(row.path);
    if (!chat) {
      const predecessor = row.parent ? desktopRows.get(row.parent) : undefined;
      const parent = predecessor && canonical.get(key(row.project, predecessor.key));
      return [parent && parent.path !== row.parent ? { ...row, parent: parent.path } : row];
    }
    if (canonical.get(key(row.project, chat.key)) !== row) return [];
    const parent = chat.parentKey ? canonical.get(key(row.project, chat.parentKey)) : undefined;
    return [parent ? { ...row, parent: parent.path } : row];
  });
}
