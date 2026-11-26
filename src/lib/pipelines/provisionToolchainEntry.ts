import fs from "node:fs";
import path from "node:path";

const releaseRoot = process.cwd();

export function provisionToolchainEntry(): { command: string; entry: string; cwd: string } {
  const bundled = path.join(releaseRoot, ".next/server/provision-toolchain-worker.js");
  const source = path.join(releaseRoot, "src/lib/pipelines/provisionToolchain.worker.ts");
  const built = process.env.NODE_ENV === "production" || fs.existsSync(path.join(releaseRoot, ".next/BUILD_ID"))
    || fs.existsSync(path.join(releaseRoot, "server.js"));
  const entry = built || fs.existsSync(bundled) ? bundled : source;
  if (!fs.statSync(entry, { throwIfNoEntry: false })?.isFile()) throw new Error("provisioning worker entry is missing from this release");
  const command = fs.existsSync("/usr/local/bin/bun-container") ? "/usr/local/bin/bun-container"
    : process.versions.bun ? process.execPath : process.env.LLV_BUN_EXECUTABLE || "bun";
  return { command, entry, cwd: releaseRoot };
}
