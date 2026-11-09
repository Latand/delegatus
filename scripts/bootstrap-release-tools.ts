import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const RELEASE_TOOLS = ["scripts/release-verify.ts", "scripts/local-gate.ts"] as const;

/** Refresh release-critical tooling from current main before the release PR is reviewed. */
export function bootstrapReleaseTools(root = process.cwd()): void {
  execFileSync("git", ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"], { cwd: root, stdio: "ignore" });

  for (const relativePath of RELEASE_TOOLS) {
    const content = execFileSync("git", ["show", `refs/remotes/origin/main:${relativePath}`], { cwd: root, encoding: "utf8" });
    if (!content) throw new Error(`main has no release tool at ${relativePath}`);
    const target = path.join(root, relativePath);
    const temporary = `${target}.release-bootstrap`;
    fs.writeFileSync(temporary, content, { mode: fs.statSync(target).mode });
    fs.renameSync(temporary, target);
  }
}

if (import.meta.main) {
  try {
    bootstrapReleaseTools();
    console.log("Release verifier and publication hook refreshed from origin/main.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "release tooling bootstrap failed");
    process.exitCode = 1;
  }
}
