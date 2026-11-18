import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Private refs/index, shared immutable objects, no registration in the lane. */
export function sharedCheckout(source: string, target: string, ref?: string): void {
  const run = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, timeout: 60_000, stdio: "pipe" });
  run(source, ["clone", "--quiet", "--shared", "--no-checkout", "--", source, target]);
  if (ref) run(target, ["-c", "core.hooksPath=/dev/null", "checkout", "--quiet", "--detach", ref]);
  const remote = spawnSync("git", ["config", "--get", "remote.origin.url"], { cwd: source, encoding: "utf8", timeout: 10_000 });
  if (remote.status === 0) run(target, ["config", "remote.origin.url", remote.stdout.trim()]);
  else if (remote.status === 1) run(target, ["remote", "remove", "origin"]);
  else throw new Error("cannot read source remote");
  // clone names remote-tracking refs after the source's local branches. Its
  // local main may differ from the upstream used by publication comparisons.
  const main = spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main^{commit}"], { cwd: source, encoding: "utf8", timeout: 10_000 });
  if (main.status === 0) run(target, ["update-ref", "refs/remotes/origin/main", main.stdout.trim()]);
  else if (main.status !== 1) throw new Error("cannot read source comparison base");
}

/** Overlay only changed inputs onto a shared checkout. The lane index, refs
 * and working files are never written; generated outputs remain private. */
export function currentCheckout(source: string, target: string): void {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: source, encoding: "utf8", stdio: "pipe" });
  const head = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: source, encoding: "utf8" });
  sharedCheckout(source, target, head.status === 0 ? head.stdout.trim() : undefined);
  const generated = new Set(["node_modules", ".next", "dist", "tsconfig.tsbuildinfo"]);
  for (const name of generated) fs.rmSync(path.join(target, name), { recursive: true, force: true });
  const wanted = new Set(git("ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0")
    .filter(file => file && !generated.has(file.split("/")[0]!)));
  const previous = execFileSync("git", ["ls-files", "-z"], { cwd: target, encoding: "utf8" }).split("\0").filter(Boolean);
  const cachedFiles = new Set(git("ls-files", "--stage", "-z").split("\0")
    .filter(entry => entry && !entry.startsWith("160000 ")).map(entry => entry.slice(entry.indexOf("\t") + 1)));
  const inputStat = (file: string) => {
    try { return fs.lstatSync(file, { throwIfNoEntry: false }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOTDIR") return undefined; throw error; }
  };
  for (const file of previous) {
    const stat = inputStat(path.join(source, file));
    if (!wanted.has(file) || !stat || stat.isDirectory())
      fs.rmSync(path.join(target, file), { recursive: true, force: true });
  }
  // Compare bytes instead of trusting Git's stat cache or assume-unchanged
  // flags. The export must include every current byte even under those flags.
  for (const file of wanted) {
    const from = path.join(source, file), to = path.join(target, file);
    const stat = inputStat(from);
    if (!stat) continue;
    if (stat.isDirectory()) {
      // A cached plain file may now be an ordinary directory. Its current
      // children are separate inputs; Git does not retain empty directories.
      if (cachedFiles.has(file) && !fs.existsSync(path.join(from, ".git"))) continue;
      throw new Error("source check requires a file input; nested repositories need their own check");
    }
    // Remove obsolete file or symlink ancestors before looking up a child.
    // Following a committed symlink here could write outside the export.
    let parent = target;
    for (const part of file.split("/").slice(0, -1)) {
      parent = path.join(parent, part);
      const entry = fs.lstatSync(parent, { throwIfNoEntry: false });
      if (entry && !entry.isDirectory()) fs.rmSync(parent, { force: true });
      fs.mkdirSync(parent, { recursive: true });
    }
    const old = fs.lstatSync(to, { throwIfNoEntry: false });
    if (stat.isSymbolicLink() && old?.isSymbolicLink() && fs.readlinkSync(from) === fs.readlinkSync(to)) continue;
    if (stat.isFile() && old?.isFile() && stat.mode === old.mode && fs.readFileSync(from).equals(fs.readFileSync(to))) continue;
    fs.rmSync(to, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { verbatimSymlinks: true });
  }
  const modules = path.join(source, "node_modules");
  if (fs.existsSync(modules)) fs.symlinkSync(fs.realpathSync(modules), path.join(target, "node_modules"), "dir");
}
