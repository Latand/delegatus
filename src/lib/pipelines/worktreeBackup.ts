import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { statePath } from "@/lib/configDir";
import { fsyncPath, writeJsonDurably } from "@/lib/state/durableJson";
import { pipelineLiteralGitEnv } from "./git";

const exec = promisify(execFile);
const media = /\.(?:png|jpe?g|webp|gif|avif|mp4|webm)$/i;
const within = (file: string, root: string) => file === root || file.startsWith(root + path.sep);
type SavedFile = { path: string; savedPath: string; bytes: number; hash: string };

/** A separate index preserves work without changing the checkout's index,
 * branch, or reflog. A backup is usable only after both its Git tree and
 * every ignored evidence file have been verified again. */
export async function backupWorktree(options: {
  directory: string;
  pipelineId: string;
  head: string;
  branch: string | null;
  ignored: string[];
  guard: () => boolean;
}) {
  const { directory, pipelineId, head } = options;
  if (!/^[A-Za-z0-9_-]+$/.test(pipelineId)) throw new Error("invalid backup owner");
  if (fs.realpathSync(directory) !== directory) throw new Error("backup requires the physical checkout");
  const root = fs.lstatSync(directory);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "llv-worktree-backup-"));
  const env = { ...process.env, ...pipelineLiteralGitEnv(), GIT_INDEX_FILE: path.join(scratch, "index"),
    GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0",
    GIT_AUTHOR_NAME: "Delegatus", GIT_COMMITTER_NAME: "Delegatus",
    GIT_AUTHOR_EMAIL: ["noreply", "example.invalid"].join("@"), GIT_COMMITTER_EMAIL: ["noreply", "example.invalid"].join("@") };
  const git = async (...args: string[]) => {
    const result = await exec("git", ["-c", "core.fsync=loose-object,reference", ...args], { cwd: directory, env, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
    if (!options.guard()) throw new Error("backup ownership changed");
    return result.stdout.trim();
  };
  const tree = async () => {
    await git("read-tree", head);
    await git("add", "-A");
    const staged = await git("ls-files", "--stage");
    if (/^160000 /m.test(staged)) throw new Error("nested repository requires its own preservation");
    return git("write-tree");
  };
  const evidence = statePath("evidence", pipelineId, "worktree");
  const kept: SavedFile[] = [];
  const files: string[] = [];
  const collect = (relative: string, artifact = false) => {
    const source = path.resolve(directory, relative);
    if (!within(source, directory) || source === directory) throw new Error("invalid backup path");
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) throw new Error("linked evidence requires its own preservation");
    const components = path.normalize(relative).split(path.sep);
    const inArtifact = artifact || components[0] === ".artifacts";
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(source)) collect(path.join(relative, name), inArtifact);
    } else {
      if (!stat.isFile() || (!inArtifact && !media.test(relative))) throw new Error("unknown ignored file");
      files.push(relative);
    }
  };
  const digest = async (file: string) => {
    if (fs.realpathSync(path.dirname(file)) !== path.dirname(file)) throw new Error("linked evidence path");
    const hash = createHash("sha256");
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      if (!fs.fstatSync(descriptor).isFile()) throw new Error("evidence is not a regular file");
      for await (const chunk of fs.createReadStream(file, { fd: descriptor, autoClose: false })) hash.update(chunk);
    } finally { fs.closeSync(descriptor); }
    if (!options.guard()) throw new Error("backup ownership changed while reading evidence");
    return hash.digest("hex");
  };
  let retained = false;
  try {
    for (const ignored of options.ignored) collect(ignored.replace(/\/$/, ""));
    const savedTree = await tree();
    const commit = await git("commit-tree", savedTree, "-p", head, "-m", "Preserve settled worktree");
    const ref = `refs/delegatus/worktree-backup/${pipelineId}/${commit}`;
    const existing = await git("for-each-ref", "--format=%(objectname) %(refname)", ref);
    const recorded = existing.split("\n").find(line => line.endsWith(" " + ref))?.split(" ")[0];
    if (recorded && recorded !== commit) throw new Error("backup reference changed");
    if (!recorded) await git("update-ref", ref, commit, "0".repeat(commit.length));
    // Copy rather than link: a later write through another hard link must
    // never silently change the durable evidence that was just verified.
    for (const relative of files) {
      const source = path.join(directory, relative);
      let savedPath = relative, target = path.join(evidence, savedPath);
      const hash = await digest(source), bytes = fs.statSync(source).size;
      if (fs.existsSync(target) && (!fs.lstatSync(target).isFile() || await digest(target) !== hash)) {
        savedPath = path.join("versions", commit, relative); target = path.join(evidence, savedPath);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      if (fs.realpathSync(path.dirname(target)) !== path.dirname(target)) throw new Error("linked evidence destination");
      if (!fs.existsSync(target)) await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL);
      if (!fs.lstatSync(target).isFile() || fs.statSync(target).size !== bytes || await digest(target) !== hash) throw new Error("evidence backup differs");
      fsyncPath(target); fsyncPath(path.dirname(target));
      kept.push({ path: relative, savedPath, bytes, hash });
    }
    const manifest = statePath("evidence", pipelineId, "worktree-backup.json");
    writeJsonDurably(manifest, { ref, head, branch: options.branch, tree: savedTree, files: kept,
      bytes: kept.reduce((total, file) => total + file.bytes, 0) });
    const verify = async () => {
      if (!options.guard()) return false;
      if (await git("rev-parse", "HEAD") !== head || await tree() !== savedTree) return false;
      const current = fs.lstatSync(directory);
      if (!options.guard() || current.dev !== root.dev || current.ino !== root.ino) return false;
      for (const file of kept) {
        if (fs.lstatSync(path.join(directory, file.path)).size !== file.bytes
          || fs.lstatSync(path.join(evidence, file.savedPath)).size !== file.bytes
          || await digest(path.join(directory, file.path)) !== file.hash
          || await digest(path.join(evidence, file.savedPath)) !== file.hash) return false;
      }
      if (await git("rev-parse", ref) !== commit) return false;
      const final = fs.lstatSync(directory);
      return options.guard() && final.dev === root.dev && final.ino === root.ino;
    };
    if (!await verify()) throw new Error("worktree changed after backup");
    retained = true;
    return { ref, tree: savedTree, verify, close: () => fs.rmSync(scratch, { recursive: true, force: true }) };
  } finally {
    if (!retained) fs.rmSync(scratch, { recursive: true, force: true });
  }
}
