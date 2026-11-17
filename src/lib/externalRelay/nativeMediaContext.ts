import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export const NATIVE_MEDIA_CONTEXT_WAIT_MS = 3000;
async function openContext(filename: string) {
  const until = Date.now() + NATIVE_MEDIA_CONTEXT_WAIT_MS;
  for (;;) {
    try { return await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
    catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT") || Date.now() >= until) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, until - Date.now()))));
    }
  }
}

/** Only the server-resolved native transcript is admitted here. Protect it
 * before the engine appends private tool output; never follow a caller path. */
export async function protectNativeMediaContext(filename: string) {
  if (!path.isAbsolute(filename) || !filename.endsWith(".jsonl")) throw new Error("media_context_unavailable");
  const file = await openContext(filename);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || process.getuid && stat.uid !== process.getuid()) throw new Error("media_context_unavailable");
    const parent = await fs.open(path.dirname(filename), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0));
    try {
      const directory = await parent.stat();
      if (!directory.isDirectory() || process.getuid && directory.uid !== process.getuid()) throw new Error("media_context_unavailable");
      await file.chmod(0o600); await parent.chmod(0o700);
      const [named, namedParent] = await Promise.all([fs.lstat(filename), fs.lstat(path.dirname(filename))]);
      if (named.isSymbolicLink() || namedParent.isSymbolicLink() || named.dev !== stat.dev || named.ino !== stat.ino
        || namedParent.dev !== directory.dev || namedParent.ino !== directory.ino) throw new Error("media_context_unavailable");
    } finally { await parent.close(); }
  } finally { await file.close(); }
}
