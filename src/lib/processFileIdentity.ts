import fs from "node:fs";
import path from "node:path";

/**
 * Which files live processes use, by device and inode. A path is a spelling: a
 * process in another mount namespace, or behind a bind mount, names the same
 * directory differently, while the file's identity stays the same everywhere.
 */

/** One process: its `/proc` directory, its mount namespace, the identities of
 * the files it has mapped and every path it names. */
export type ProcessFiles = { directory: string; namespace: string | null; mapped?: Iterable<string>; paths: Iterable<string> };

const identityOf = (stat: { dev: bigint; ino: bigint }) => `${stat.dev}:${stat.ino}`;

function statIdentity(file: string): string | null {
  try { return identityOf(fs.statSync(file, { bigint: true })); }
  catch { return null; }
}

/** The `major:minor inode` columns of one `maps` line, as `stat` reports them.
 * A mapping keeps its file in use after the descriptor is closed. */
export function mappedFileIdentity(line: string): string | null {
  const match = /^\S+\s+\S+\s+\S+\s+([0-9a-f]+):([0-9a-f]+)\s+(\d+)(?:\s|$)/.exec(line);
  if (!match || match[3] === "0") return null;
  const major = parseInt(match[1]!, 16), minor = parseInt(match[2]!, 16);
  // The kernel's 12-bit major and 20-bit minor, in the layout `st_dev` uses.
  return `${major * 256 + minor % 256 + Math.floor(minor / 256) * 1_048_576}:${match[3]}`;
}

/** The identity of everything these processes reach: cwd, root, executable,
 * open files, mappings, and each step of every path they name. A path is
 * resolved under the process's own root, so the steps through a bind mount
 * carry the identity of the directory mounted there. */
export function identitiesInUse(processes: Iterable<ProcessFiles>): Set<string> {
  const found = new Set<string>();
  const add = (identity: string | null) => { if (identity) found.add(identity); };
  // Processes with the same namespace and root resolve a path alike.
  const walked = new Set<string>();
  for (const { directory, namespace, mapped, paths } of processes) {
    for (const identity of mapped ?? []) found.add(identity);
    for (const link of ["cwd", "root", "exe"]) add(statIdentity(`${directory}/${link}`));
    try {
      for (const fd of fs.readdirSync(`${directory}/fd`)) add(statIdentity(`${directory}/fd/${fd}`));
    } catch { /* Exited mid-read, or not ours. */ }
    const root = `${directory}/root`;
    const view = `${namespace}\0${statIdentity(root)}\0`;
    for (const named of paths) {
      if (!path.isAbsolute(named)) continue;
      for (let current = path.resolve(named.replace(/ \(deleted\)$/, "")); current !== "/"; current = path.dirname(current)) {
        if (walked.has(view + current)) break;
        walked.add(view + current);
        add(statIdentity(root + current));
      }
    }
  }
  return found;
}

/** Whether a tree (or a single file) holds something these identities name.
 * A directory matches by identity alone. A file with a second hard link is
 * matched only through a directory above it, which the path walk records:
 * package caches link one file into many trees, and its identity alone may
 * name another of those links. Over the limit, the tree counts as held. */
export function treeHoldsIdentity(tree: string, identities: ReadonlySet<string>, limit: number): boolean {
  const pending = [tree];
  let visited = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++visited > limit) return true;
    const stat = fs.lstatSync(current, { bigint: true });
    if ((stat.isDirectory() || Number(stat.nlink) === 1) && identities.has(identityOf(stat))) return true;
    if (stat.isDirectory()) for (const name of fs.readdirSync(current)) pending.push(path.join(current, name));
  }
  return false;
}
