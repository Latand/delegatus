import os from "node:os";
import path from "node:path";

/** Shared by allocation and disk admission, before a random root exists. */
export function attemptTempConfigParent(source: Readonly<Record<string, string | undefined>> = process.env): string {
  return path.join(source.HOME || process.env.HOME || os.homedir(), ".cache", "delegatus", "attempt-temp");
}
