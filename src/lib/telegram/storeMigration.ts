import fs from "node:fs";
import path from "node:path";
import { UnsafeTelegramSessionError } from "./sessionStore";

/** Keep the original ownership fence before acquiring an import lock and
 * again under that lock. Validate the actual source's directory. */
export function validateTelegramLegacyStore(file: string): void {
  const directory = path.dirname(file);
  let parent: fs.Stats;
  try { parent = fs.lstatSync(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const owned = (stat: fs.Stats) => (stat.mode & 0o077) === 0
    && (typeof process.getuid !== "function" || stat.uid === process.getuid());
  if (!parent.isDirectory() || parent.isSymbolicLink() || !owned(parent)) {
    throw new UnsafeTelegramSessionError("legacy store directory must be owner-only");
  }
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (stat.isDirectory() && !stat.isSymbolicLink() && owned(stat)) return;
  if (!stat.isFile() || stat.isSymbolicLink() || !owned(stat)) {
    throw new UnsafeTelegramSessionError("legacy store must be an owner-only regular file");
  }
}
