import type { promises as fsp } from "node:fs";
import fs from "node:fs/promises";

/**
 * Whether an open descriptor is the file at `expected`, a path whose links
 * are already resolved. `O_NOFOLLOW` guards only the last component, so a
 * directory above it swapped for a link between the check and the open hands
 * back a file from somewhere else under the same name. The kernel's own name
 * for the open file settles it where the platform publishes one
 * (`/proc/self/fd`): it names the file that was opened, whatever the path says
 * by now. Elsewhere the path is resolved again after the open and must still
 * lead to the same inode.
 */
export async function openedAt(handle: fsp.FileHandle, expected: string): Promise<boolean> {
  const held = await fs.readlink(`/proc/self/fd/${handle.fd}`).catch(() => null);
  if (held !== null) return held === expected;
  try {
    if (await fs.realpath(expected) !== expected) return false;
    const [named, pinned] = await Promise.all([fs.stat(expected), handle.stat()]);
    return named.ino === pinned.ino && named.dev === pinned.dev;
  } catch {
    return false;
  }
}
