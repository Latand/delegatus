import fs from "node:fs";
import path from "node:path";

/** Managed MCP releases retain dist without the original checkout's bin. */
export function copyDestructiveGuardAssets(source: string, dist: string) {
  const destination = path.join(dist, "agent-guard");
  fs.mkdirSync(destination, { recursive: true });
  for (const name of ["destructive-guard.mjs", "destructive-rm.sh", "destructive-wrapper.sh", "destructive-shell-env.sh"]) {
    fs.copyFileSync(path.join(source, "bin", name), path.join(destination, name));
  }
}
