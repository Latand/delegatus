import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Conservative sharing: local resolutions can point back into the live lane. */
function dependencyInputs(repository: string): string[] | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8"));
    const lock = fs.readFileSync(path.join(repository, "bun.lock"), "utf8");
    const local = (value: unknown) => typeof value === "string" && /^(?:(?:file|link|workspace):|\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/]|~[\\/])/.test(value);
    const groups = [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies, manifest.peerDependencies, manifest.overrides];
    if (manifest.workspaces || groups.some(group => Object.values(group ?? {}).some(local)) || /@(?:file|link|workspace):/.test(lock)) return null;
    const patches = Object.values(manifest.patchedDependencies ?? {});
    if (patches.some(file => typeof file !== "string" || path.isAbsolute(file) || path.relative(repository, path.resolve(repository, file)).startsWith(".."))) return null;
    return ["package.json", "bun.lock", ...patches as string[]].sort();
  } catch { return null; }
}

function canShare(repository: string, exported: string): boolean {
  const inputs = dependencyInputs(exported);
  const sourceInputs = dependencyInputs(repository);
  if (!inputs || !sourceInputs || JSON.stringify(inputs) !== JSON.stringify(sourceInputs)) return false;
  try {
    return fs.statSync(path.join(repository, "node_modules")).isDirectory()
      && inputs.every(file => fs.readFileSync(path.join(repository, file)).equals(fs.readFileSync(path.join(exported, file))));
  } catch { return false; }
}

/** Export committed source into a newly owned scratch directory. Borrowed
 * dependencies carry the reviewer's read-only contract; never install here. */
export function reviewExport(repository: string, ref: string, scratch: string): { directory: string; head: string; dependencies: "shared" | "unavailable" } {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const head = git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`);
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(scratch), "llv-review-export-"));
  const archive = path.join(directory, "source.tar");
  try {
    const fd = fs.openSync(archive, "wx", 0o600);
    try { execFileSync("git", ["archive", "--format=tar", head], { cwd: repository, timeout: 60_000, stdio: ["ignore", fd, "pipe"] }); }
    finally { fs.closeSync(fd); }
    // Keep the archive outside its extraction directory: a tracked source.tar
    // must not replace the input while tar still reads it.
    const checkout = path.join(directory, "checkout");
    fs.mkdirSync(checkout);
    execFileSync("tar", ["-xf", archive, "-C", checkout], { timeout: 60_000, stdio: ["ignore", "ignore", "pipe"] });
    fs.unlinkSync(archive);
    // The gate runner ships an export through this record (scripts/gate-runner):
    // it sits outside the checkout, so no test and no tree id sees it.
    const repositoryDir = fs.realpathSync(git("rev-parse", "--path-format=absolute", "--git-common-dir"));
    fs.writeFileSync(path.join(directory, "export.json"), `${JSON.stringify({ version: 1, checkout: fs.realpathSync(checkout), head, repository: repositoryDir })}\n`);
    let dependencies: "shared" | "unavailable" = "unavailable";
    if (!fs.lstatSync(path.join(checkout, "node_modules"), { throwIfNoEntry: false }) && canShare(repository, checkout)) {
      fs.symlinkSync(fs.realpathSync(path.join(repository, "node_modules")), path.join(checkout, "node_modules"), "dir");
      dependencies = "shared";
    }
    return { directory: checkout, head, dependencies };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  const ref = process.argv[2];
  const scratch = process.env.TMPDIR;
  if (!ref || !scratch) throw new Error("usage: TMPDIR=<stage scratch> bun scripts/review-export.ts <commit>");
  console.log(JSON.stringify(reviewExport(process.cwd(), ref, scratch)));
}
