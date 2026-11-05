import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { statePath } from "@/lib/configDir";
import { fsyncPath, writeJsonDurably } from "@/lib/state/durableJson";
import { pipelineLiteralGitEnv } from "./git";
import { isPreservedMedia } from "@/lib/artifact/evidenceFormats";

const exec = promisify(execFile);
const within = (file: string, root: string) => file === root || file.startsWith(root + path.sep);
type SavedFile = { path: string; savedPath: string; bytes: number; hash: string };
const signature = (stat: fs.BigIntStats) => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");

/** A separate index preserves work without changing the checkout's index,
 * branch, or reflog. The backup's second parent preserves the original index.
 * A backup is usable only after both Git trees and
 * every ignored evidence file have been verified again. */
export async function backupWorktree(options: {
  directory: string;
  pipelineId: string;
  head: string;
  branch: string | null;
  ignored: string[];
  disposable: (relative: string) => boolean;
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
  const gitWithIndex = async (index: string | undefined, ...args: string[]) => {
    const childEnv: NodeJS.ProcessEnv = { ...env };
    if (index === undefined) delete childEnv.GIT_INDEX_FILE; else childEnv.GIT_INDEX_FILE = index;
    const result = await exec("git", ["-c", "core.fsync=loose-object,reference", ...args], { cwd: directory, env: childEnv, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
    if (!options.guard()) throw new Error("backup ownership changed");
    return result.stdout.trim();
  };
  const git = (...args: string[]) => gitWithIndex(env.GIT_INDEX_FILE, ...args);
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
  const inventory = new Map<string, string>();
  let inspected = 0;
  const collect = (relative: string, artifact = false) => {
    if (++inspected > 200_000) throw new Error("ignored evidence inventory exceeds its entry bound");
    const source = path.resolve(directory, relative);
    if (!within(source, directory) || source === directory) throw new Error("invalid backup path");
    const stat = fs.lstatSync(source, { bigint: true });
    inventory.set(relative, signature(stat));
    const components = path.normalize(relative).split(path.sep);
    if (components.includes(".git")) throw new Error("nested repository requires its own preservation");
    const inArtifact = artifact || components.includes(".artifacts");
    if (stat.isSymbolicLink()) {
      if (!inArtifact && !isPreservedMedia(relative) && options.disposable(relative)) return;
      throw new Error("linked evidence requires its own preservation");
    }
    if (stat.isDirectory()) {
      const names = fs.readdirSync(source);
      if (names.includes("objects") && ["HEAD", "refs", "config"].some(name => names.includes(name)))
        throw new Error("nested repository requires its own preservation");
      for (const name of names) collect(path.join(relative, name), inArtifact);
    } else {
      if (!inArtifact && !isPreservedMedia(relative) && options.disposable(relative)) return;
      if (!stat.isFile() || (!inArtifact && !isPreservedMedia(relative))) throw new Error("unknown ignored file");
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
    const originalIndex = await gitWithIndex(undefined, "rev-parse", "--path-format=absolute", "--git-path", "index");
    const indexBytes = fs.readFileSync(originalIndex);
    const savedIndex = path.join(scratch, "original-index");
    fs.writeFileSync(savedIndex, indexBytes, { flag: "wx", mode: 0o600 });
    const indexTree = await gitWithIndex(savedIndex, "write-tree");
    const indexCommit = await git("commit-tree", indexTree, "-p", head, "-m", "Preserve settled worktree index");
    const savedTree = await tree();
    const commit = await git("commit-tree", savedTree, "-p", head, "-p", indexCommit, "-m", "Preserve settled worktree");
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
      fsyncPath(target);
      for (let parent = path.dirname(target);; parent = path.dirname(parent)) {
        fsyncPath(parent);
        if (parent === path.dirname(statePath("evidence"))) break;
      }
      kept.push({ path: relative, savedPath, bytes, hash });
    }
    const manifest = statePath("evidence", pipelineId, "worktree-backup.json");
    writeJsonDurably(manifest, { ref, head, branch: options.branch, tree: savedTree, indexTree, indexCommit, files: kept,
      bytes: kept.reduce((total, file) => total + file.bytes, 0) });
    const verify = async () => {
      if (!options.guard()) return false;
      const expected = new Map(inventory);
      files.length = 0; inspected = 0; inventory.clear();
      for (const ignored of options.ignored) collect(ignored.replace(/\/$/, ""));
      if (inventory.size !== expected.size || [...inventory].some(([file, stamp]) => expected.get(file) !== stamp)) return false;
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
      if (await git("rev-parse", `${ref}^2^{tree}`) !== indexTree
        || await git("rev-parse", `${ref}^{tree}`) !== savedTree) return false;
      const final = fs.lstatSync(directory);
      return options.guard() && final.dev === root.dev && final.ino === root.ino
        && fs.readFileSync(originalIndex).equals(indexBytes)
        && [...inventory].every(([file, stamp]) => signature(fs.lstatSync(path.join(directory, file), { bigint: true })) === stamp);
    };
    if (!await verify()) throw new Error("worktree changed after backup");
    retained = true;
    return { ref, tree: savedTree, verify, close: () => fs.rmSync(scratch, { recursive: true, force: true }) };
  } finally {
    if (!retained) fs.rmSync(scratch, { recursive: true, force: true });
  }
}
