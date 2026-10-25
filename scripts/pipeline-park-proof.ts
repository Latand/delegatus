/** Script-only rehearsal. The caller must stop all writers before invoking it.
 * Usage: bun scripts/pipeline-park-proof.ts <checkout> <new-evidence-directory> --stopped [artifact-directory ...]
 * This first slice accepts external artifact directories only; no live pipeline state is read.
 * Evidence is retained on failure. Restore uses the recorded commit, never a moving branch.
 * Recovery after interruption: fetch checkout.bundle HEAD into the repository, then
 * git worktree add --detach <checkout> <manifest-commit>, then copy checkout-files
 * over the restored tree, then reapply manifest modes (including the "." root)
 * after copying, children before parents. Artifact copies stay in evidence.
 * The caller's stopped declaration is a precondition, not process-liveness detection.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type Entry = { name: string; kind: "file" | "directory" | "symlink"; mode: number; digest: string };
function git(cwd: string, ...args: string[]): string {
  try {
    return execFileSync("git", ["-c", "core.hooksPath=", "-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
  } catch { throw new Error("Git operation refused or failed; preserved evidence was retained"); }
}
function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function inventory(root: string, checkout = false): Entry[] {
  // Include the root in every preservation and verification comparison.
  const entries: Entry[] = [{ name: ".", kind: "directory", mode: fs.lstatSync(root).mode & 0o7777,
    digest: createHash("sha256").update(Buffer.alloc(0)).digest("hex") }];
  function walk(relative: string) {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      if (checkout && relative === "" && name === ".git") continue;
      const entry = path.join(relative, name);
      const filename = path.join(root, entry);
      const stat = fs.lstatSync(filename);
      const kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : null;
      if (!kind) throw new Error("Unsupported filesystem entry");
      const bytes = kind === "symlink" ? Buffer.from(fs.readlinkSync(filename)) : kind === "file" ? fs.readFileSync(filename) : Buffer.alloc(0);
      entries.push({ name: entry, kind, mode: stat.mode & 0o7777, digest: createHash("sha256").update(bytes).digest("hex") });
      if (kind === "directory") walk(entry);
    }
  }
  walk("");
  return entries;
}
function equal(a: Entry[], b: Entry[]): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function clean(checkout: string): void {
  if (git(checkout, "status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching")) throw new Error("Dirty or unaccounted checkout files");
  const tracked = new Set(git(checkout, "ls-files", "-z").split("\0").filter(Boolean));
  const entries = inventory(checkout, true);
  for (const entry of entries) {
    if (entry.name === ".") continue;
    if (entry.kind === "directory") {
      if (![...tracked].some(name => name.startsWith(`${entry.name}/`))) throw new Error("Unaccounted checkout directory");
    } else if (!tracked.has(entry.name)) throw new Error("Unaccounted checkout file");
  }
  if (git(checkout, "ls-files", "--stage").split("\n").some(line => line.startsWith("160000 "))) throw new Error("Submodules are outside this proof");
  if (git(checkout, "ls-files", "-v").split("\n").some(line => !line.startsWith("H "))) throw new Error("Hidden index state is outside this proof");
}

export function proveParkRestore(options: { checkout: string; evidence: string; stopped: boolean; artifacts: string[] }) {
  if (options.stopped !== true) throw new Error("A stopped checkout is required; the caller must quiesce all writers");
  const checkout = fs.realpathSync(options.checkout);
  const evidence = path.resolve(options.evidence);
  // Require an existing canonical parent, so symlink aliases cannot hide overlap.
  if (fs.realpathSync(path.dirname(evidence)) !== path.dirname(evidence)) throw new Error("Evidence parent must be canonical");
  if (fs.existsSync(evidence)) throw new Error("Evidence destination must be new");
  if (git(checkout, "rev-parse", "--show-toplevel") !== checkout || !fs.lstatSync(path.join(checkout, ".git")).isFile()) throw new Error("A linked worktree root is required");
  const common = fs.realpathSync(git(checkout, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  if (inside(checkout, common) || inside(checkout, evidence) || inside(evidence, checkout) || inside(common, evidence)) throw new Error("Preservation locations must be independent");
  const artifacts = options.artifacts.map(location => fs.realpathSync(location));
  for (const [index, location] of artifacts.entries()) {
    if (!fs.lstatSync(location).isDirectory() || [checkout, common, evidence, ...artifacts.slice(0, index)].some(other => inside(other, location) || inside(location, other))) throw new Error("Artifact directories must be independent");
  }
  clean(checkout);
  const commit = git(checkout, "rev-parse", "--verify", "HEAD^{commit}");
  const branch = git(checkout, "rev-parse", "--symbolic-full-name", "HEAD");
  const before = inventory(checkout, true);
  const artifactEntries = artifacts.map(location => inventory(location));
  fs.mkdirSync(evidence, { mode: 0o700 });
  const preservedCheckout = path.join(evidence, "checkout-files");
  fs.cpSync(checkout, preservedCheckout, { recursive: true, verbatimSymlinks: true,
    filter: source => source !== path.join(checkout, ".git") });
  if (!equal(before, inventory(preservedCheckout))) throw new Error("Checkout preservation mismatch");
  const bundle = path.join(evidence, "checkout.bundle");
  git(checkout, "bundle", "create", bundle, "HEAD");
  git(checkout, "bundle", "verify", bundle);
  artifacts.forEach((location, index) => fs.cpSync(location, path.join(evidence, `artifact-${index}`), { recursive: true, verbatimSymlinks: true }));
  artifacts.forEach((_, index) => {
    if (!equal(artifactEntries[index], inventory(path.join(evidence, `artifact-${index}`)))) throw new Error("Artifact preservation mismatch");
  });
  const record = { version: 1, commit, branch, checkout: path.relative(evidence, checkout), bundle: "checkout.bundle", preservedCheckout: "checkout-files", entries: before,
    artifacts: artifacts.map((location, index) => ({ location: path.relative(evidence, location), preserved: `artifact-${index}`, entries: artifactEntries[index] })) };
  fs.writeFileSync(path.join(evidence, "manifest.json"), JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o400 });
  // Recheck immediately before deletion. This is an offline proof, not a writer lock.
  clean(checkout);
  if (git(checkout, "rev-parse", "HEAD") !== commit || git(checkout, "rev-parse", "--symbolic-full-name", "HEAD") !== branch || !equal(before, inventory(checkout, true)) || artifacts.some((location, index) => !equal(artifactEntries[index], inventory(location)))) throw new Error("State changed during preservation");
  git(common, "worktree", "remove", checkout);
  if (fs.existsSync(checkout)) throw new Error("Worktree removal was incomplete");
  // Import from the preserved bundle even if the original branch later moves.
  git(common, "fetch", "--no-write-fetch-head", bundle, "HEAD");
  // Keep restored bytes private until all recorded permissions are reapplied.
  fs.mkdirSync(checkout, { mode: 0o700 });
  git(common, "worktree", "add", "--detach", checkout, commit);
  if (branch !== "HEAD") {
    if (git(common, "rev-parse", branch) !== commit) throw new Error("Branch moved; restored checkout remains detached");
    git(checkout, "symbolic-ref", "HEAD", branch);
  }
  // Preserve working bytes even when Git has line-ending or content filters.
  fs.cpSync(preservedCheckout, checkout, { recursive: true, verbatimSymlinks: true });
  // Copying can clear special file bits; restore modes after all writes,
  // with each directory after its children so restrictive parents cannot block them.
  for (const entry of [...before].reverse()) {
    if (entry.kind !== "symlink") fs.chmodSync(path.join(checkout, entry.name), entry.mode);
  }
  clean(checkout);
  if (git(checkout, "rev-parse", "HEAD") !== commit || !equal(before, inventory(checkout, true)) || artifacts.some((location, index) => !equal(artifactEntries[index], inventory(location)))) throw new Error("Restored state differs from preserved state");
  fs.writeFileSync(path.join(evidence, "verified.json"), JSON.stringify({ commit, byteIdentical: true, worktreeRemoved: true }) + "\n", { flag: "wx" });
  return record;
}

if (import.meta.main) {
  const [checkout, evidence, stopped, ...artifacts] = process.argv.slice(2);
  try {
    if (!checkout || !evidence || stopped !== "--stopped") throw new Error("Usage: pipeline-park-proof <checkout> <new-evidence-directory> --stopped [artifact-directory ...]");
    proveParkRestore({ checkout, evidence, stopped: true, artifacts });
    console.log("Park/restore proof verified");
  } catch (error) { console.error(error instanceof Error ? error.message : "Proof failed"); process.exitCode = 1; }
}
