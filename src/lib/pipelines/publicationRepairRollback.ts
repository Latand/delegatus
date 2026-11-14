import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ExecPort } from "@/lib/workflows/provision";
import type { Pipeline, PipelineStageAttempt } from "./types";
import { currentPipelineBranchHead, pipelineLiteralGitEnv } from "./git";
import { pipelineArtifactsDir } from "./store";
import { CONTROLLER_ARTIFACT_PATHSPECS } from "./controllerArtifacts";

type Repair = NonNullable<PipelineStageAttempt["publicationRepair"]>;

// The child verifies the last snapshot after the executor's own awaited fences.
// Synchronous metadata checks and Git writes stay outside the Viewer event loop.
const WRITE_GUARD = `
const fs = require("node:fs"), { spawnSync } = require("node:child_process");
const deadline = Date.now() + 5000;
const stop = (kind, code) => { process.stdout.write(kind); process.exit(code); };
const stamp = file => {
  try {
    const s = fs.lstatSync(file, { bigint: true });
    return [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].join(":");
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return "missing";
    throw error;
  }
};
try {
  const intent = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!["restore", "clean"].includes(intent.args[0])) stop("repair-write-fenced", 78);
  const lock = fs.statSync(intent.lock), held = fs.fstatSync(3);
  if (lock.dev !== held.dev || lock.ino !== held.ino) stop("repair-write-fenced", 78);
  const git = (args, output = "ignore") => spawnSync("git", args, {
    stdio: ["ignore", output, "ignore", 3], encoding: "utf8", env: process.env,
    timeout: Math.max(1, deadline - Date.now()), killSignal: "SIGKILL",
  });
  const head = git(["rev-parse", "HEAD"], "pipe"), branch = git(["branch", "--show-current"], "pipe");
  if (head.status !== 0 || branch.status !== 0 || head.stdout.trim() !== intent.head
    || branch.stdout.trim() !== intent.branch) stop("repair-write-fenced", 78);
  for (const [file, expected] of intent.stamps) if (stamp(file) !== expected) stop("repair-write-stale", 75);
  process.exit(git(intent.args).status === 0 ? 0 : 1);
} catch { stop("repair-write-fenced", 78); }
`;

/** Refused output is pinned as Git trees before restoring the clean handoff.
 * Recovery accepts only that snapshot or its exact, partially cleaned result.
 * It never resets a moved branch or removes ignored files. */
export async function restoreRejectedPublicationRepair(
  pipeline: Pipeline, repair: Repair, exec: ExecPort,
  idle: () => Promise<boolean>, persist: () => void | Promise<void>,
): Promise<"done" | "waiting" | { error: string; retryable?: true }> {
  if (repair.rollback?.phase === "done") return "done";
  const baseline = repair.cleanHead;
  const preserve = { error: "The refused repair checkout changed or has no clean handoff proof; preserve its contents." };
  let waiting = false;
  let changed = false;
  let staleStats = false;
  let gitRefused = false;
  let realIndex = "";
  let mutationStats: Map<string, string> | undefined;
  const stamp = async (file: string) => {
    try {
      const stat = await fs.promises.lstat(file, { bigint: true });
      return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return "missing";
      changed = true;
      throw new Error("repair path cannot be inspected");
    }
  };
  const assertStamps = async (expected: Map<string, string>) => {
    for (const [file, value] of expected) if (await stamp(file) !== value) {
      staleStats = true;
      throw new Error("repair files changed");
    }
  };
  const assertIdle = async () => {
    if (!await idle()) { waiting = true; throw new Error("repair is active"); }
  };
  const git = async (args: string[], index?: string) => {
    await assertIdle();
    const env = pipelineLiteralGitEnv(index ? { GIT_INDEX_FILE: index } : undefined);
    let result;
    if (!index && ["restore", "clean"].includes(args[0]!) && mutationStats) {
      const manifest = path.join(scratch, "write.json");
      await fs.promises.writeFile(manifest, JSON.stringify({ args, stamps: [...mutationStats],
        head: baseline!.sha, branch: baseline!.branch, lock: path.join(directory, "remote-action.lock") }), { mode: 0o600 });
      await assertIdle();
      result = await exec(process.execPath, ["-e", WRITE_GUARD, manifest], pipeline.worktreeDir, env, { timeoutMs: 5_000 });
      if (result.code === 75 && result.stdout === "repair-write-stale") {
        staleStats = true;
        throw new Error("repair files changed before the write");
      }
      if (result.code === 78 && result.stdout === "repair-write-fenced") {
        changed = true;
        throw new Error("repair write lost its fence");
      }
    } else result = await exec("git", args, pipeline.worktreeDir, env, { timeoutMs: 5_000 });
    await assertIdle();
    if (result.code !== 0) {
      gitRefused = true;
      throw new Error("repair Git operation refused");
    }
    return args.includes("-z") ? result.stdout : result.stdout.trim();
  };
  const literal = (files: string[]) => files.map(file => `:(top,literal)${file}`);
  const key = crypto.createHash("sha256").update(repair.operationId).digest("hex");
  const directory = pipelineArtifactsDir(pipeline.id);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const scratch = await fs.promises.mkdtemp(path.join(directory, `repair-rollback-${key}-`));
  const indexFile = path.join(scratch, "index");
  const boundary = async () => {
    const head = await git(["rev-parse", "HEAD"]);
    const branch = await git(["branch", "--show-current"]);
    if (!baseline || head !== baseline.sha || branch !== baseline.branch) {
      changed = true;
      throw new Error("repair head changed");
    }
  };
  const snapshot = async () => {
    await boundary();
    const files = repair.rollback ? [...new Set([...repair.rollback.tracked, ...repair.rollback.untracked])]
      .map(file => path.join(pipeline.worktreeDir, file)) : [];
    const fileStats = new Map<string, string>();
    for (const file of files) fileStats.set(file, await stamp(file));
    const index = await git(["write-tree"]);
    // write-tree may refresh its cache in the real index. Pin that completed
    // write before the later awaits; canonical tree equality alone misses a
    // concurrent index edit made just after the final write-tree returned.
    fileStats.set(realIndex, await stamp(realIndex));
    // Use a private index to retain untracked and unstaged output as objects.
    // Its staged content stays unchanged until the restore checkpoint is saved.
    await git(["read-tree", "HEAD"], indexFile);
    await git(["add", "--all", "--", ".", ...CONTROLLER_ARTIFACT_PATHSPECS], indexFile);
    const tree = await git(["write-tree"], indexFile);
    await boundary();
    if (await git(["write-tree"]) !== index) {
      changed = true;
      throw new Error("repair index changed");
    }
    await assertStamps(fileStats);
    mutationStats = fileStats;
    return { index, tree };
  };
  try {
    // Clean legacy refusals need no destructive recovery or new proof.
    if (!baseline) {
      const current = await currentPipelineBranchHead(pipeline, exec);
      return current.ok && current.sha === repair.sha ? "done" : preserve;
    }
    if (!/^[0-9a-f]{40}$/.test(baseline.sha) || baseline.sha !== repair.sha
      || ![pipeline.branch, pipeline.delivery?.target.branch.replace(/^refs\/heads\//, "")].includes(baseline.branch)) return preserve;
    await fs.promises.mkdir(path.dirname(indexFile), { recursive: true, mode: 0o700 });
    const gitDirectory = await git(["rev-parse", "--absolute-git-dir"]);
    if (!path.isAbsolute(gitDirectory)) return preserve;
    realIndex = path.join(gitDirectory, "index");
    const baseTree = await git(["rev-parse", `${baseline.sha}^{tree}`]);
    if (!repair.rollback) {
      const before = await snapshot();
      const tracked = [...new Set((await git(["diff", "--name-only", "--no-renames", "-z", baseline.sha, "--", ".", ...CONTROLLER_ARTIFACT_PATHSPECS])
        + await git(["diff", "--cached", "--name-only", "--no-renames", "-z", baseline.sha, "--", ".", ...CONTROLLER_ARTIFACT_PATHSPECS])).split("\0").filter(Boolean))];
      const untracked = (await git(["ls-files", "--others", "--exclude-standard", "-z", "--", ".", ...CONTROLLER_ARTIFACT_PATHSPECS])).split("\0").filter(Boolean);
      if (tracked.length) await git(["restore", `--source=${baseline.sha}`, "--staged", "--", ...literal(tracked)], indexFile);
      const afterTree = await git(["write-tree"], indexFile);
      // A second observation fences files changed while the snapshot awaited Git.
      const current = await snapshot();
      if (current.index !== before.index || current.tree !== before.tree) return preserve;
      repair.rollback = { ...before, afterTree, tracked, untracked, phase: "restore" };
      await persist();
    }
    const rollback = repair.rollback;
    if (rollback.phase === "restore") {
      const current = await snapshot();
      const original = current.index === rollback.index && current.tree === rollback.tree;
      const restored = current.index === baseTree && current.tree === rollback.afterTree;
      const restoredSubset = async (from: string, to: string, desired: string) => {
        const changedPaths = (await git(["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", from, to])).split("\0").filter(Boolean);
        return changedPaths.every(file => rollback.tracked.includes(file)) && (!changedPaths.length
          || !await git(["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", desired, to, "--", ...literal(changedPaths)]));
      };
      const partial = !original && !restored
        && await restoredSubset(rollback.index, current.index, baseTree)
        && await restoredSubset(rollback.tree, current.tree, rollback.afterTree);
      if (!original && !restored && !partial) return preserve;
      if ((original || partial) && rollback.tracked.length) {
        await git(["restore", `--source=${baseline.sha}`, "--staged", "--worktree", "--", ...literal(rollback.tracked)]);
      }
      rollback.phase = "clean";
      await persist();
    }
    const current = await snapshot();
    if (current.index !== baseTree) return preserve;
    // An interrupted clean may have removed any subset of the pinned new files.
    // Every other difference, including a changed new file, stops recovery.
    const changes = (await git(["diff-tree", "--no-commit-id", "--name-status", "--no-renames", "-r", "-z", rollback.afterTree, current.tree])).split("\0").filter(Boolean);
    for (let n = 0; n < changes.length; n += 2) {
      if (changes[n] !== "D" || !rollback.untracked.includes(changes[n + 1]!)) return preserve;
    }
    if (rollback.untracked.length) await git(["clean", "-f", "--", ...literal(rollback.untracked)]);
    const final = await snapshot();
    if (final.index !== baseTree || final.tree !== baseTree) return preserve;
    rollback.phase = "done";
    await persist();
    return "done";
  } catch (error) {
    // Lease revocation and a refused durable checkpoint belong to the caller.
    if (!waiting && !changed && !staleStats && !gitRefused) throw error;
    return waiting ? "waiting" : staleStats
      ? { error: "The repair files changed during cleanup; rechecking their pinned snapshot before retrying.", retryable: true }
      : changed ? preserve
      : { error: "The refused publication repair cleanup was interrupted; its pinned output awaits automatic recovery.", retryable: true };
  } finally {
    await fs.promises.rm(scratch, { recursive: true, force: true });
  }
}
