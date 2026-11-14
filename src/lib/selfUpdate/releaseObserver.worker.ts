import { spawnSync } from "node:child_process";
export const RELEASE_OBSERVER = "/usr/local/libexec/delegatus-release-holders";

/** Helper-only observer. The sudo grant names this executable with no arguments.
 * The root-owned observer validates stdin against its installed release root. */
export function observePrivilegedReleases(directory: string, invoke: typeof spawnSync = spawnSync): unknown {
  const observed = invoke("/usr/bin/sudo", ["-n", "--", RELEASE_OBSERVER], {
    encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024,
    input: JSON.stringify({ directory }), stdio: ["pipe", "pipe", "ignore"],
  });
  if (observed.error || observed.status !== 0) throw new Error("proc observer unavailable");
  return JSON.parse(observed.stdout);
}
