import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE_NAME = /^(?:[a-f0-9]{12}|npm-\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)$/;
const held = new Map<string, number>();

/** The self-update release directory (`…/releases/<sha12>` or
 * `…/releases/npm-<version>`) that contains `file`, if any. */
export function releaseRootOf(file: string): string | null {
  let current = path.resolve(file);
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    if (path.basename(parent) === "releases" && RELEASE_NAME.test(path.basename(current))) return current;
    current = parent;
  }
}

/** A loaded module leaves nothing in /proc once its file has been read, so a
 * process that loads Delegatus code from a release keeps a descriptor on that
 * release's root for its whole lifetime. Retention's process inventory sees
 * the descriptor and keeps the release. A release already moved off its path
 * refuses the load. Outside a release this does nothing. */
export function holdReleaseOf(file: string): string | null {
  const root = releaseRootOf(file.startsWith("file:") ? fileURLToPath(file) : file);
  if (!root || held.has(root)) return root;
  try { held.set(root, fs.openSync(root, "r")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`release ${root} is being removed`);
    // A descriptor limit must not stop the process; its argv and cwd still name the release.
    return null;
  }
  return root;
}
