import os from "node:os";
import path from "node:path";

/** Two `device:inode` identities that name the same inode, whatever device
 * number each was read under. */
export function sameAttemptInode(left: string, right: string): boolean {
  const inode = (identity: string) => /^\d+:(\d+)$/.exec(identity)?.[1];
  return inode(left) !== undefined && inode(left) === inode(right);
}

/** Shared by allocation and disk admission, before a random root exists. */
export function attemptTempConfigParent(source: Readonly<Record<string, string | undefined>> = process.env): string {
  return path.join(source.HOME || process.env.HOME || os.homedir(), ".cache", "delegatus", "attempt-temp");
}
