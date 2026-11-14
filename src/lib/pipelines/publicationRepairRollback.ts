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
  if (!["restore", "clean", "update-ref"].includes(intent.args[0])) stop("repair-write-fenced", 78);
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
 * A moved head requires producer creation proof before a compare-and-swap
 * restores its pre-repair ref. Ignored files remain outside cleanup. */
export async function restoreRejectedPublicationRepair(
  pipeline: Pipeline, repair: Repair, exec: ExecPort,
  idle: () => Promise<boolean>, persist: () => void | Promise<void>,
  ownsHead: (head: string) => Promise<boolean>,
): Promise<"done" | "waiting" | { error: string; retryable?: true }> {
  if (repair.rollback?.phase === "done") return "done";
  const baseline = repair.cleanHead;
  const preserve = { error: "The refused repair checkout changed or has no clean handoff proof; preserve its contents." };
  let waiting = false;
  let changed = false;
  let staleStats = false;
  let gitRefused = false;
  let realIndex = "";
  let expectedHead = repair.rollback?.head ?? baseline?.sha;
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
    if (!index && ["restore", "clean", "update-ref"].includes(args[0]!) && mutationStats) {
      const manifest = path.join(scratch, "write.json");
      await fs.promises.writeFile(manifest, JSON.stringify({ args, stamps: [...mutationStats],
        head: expectedHead, branch: baseline!.branch, lock: path.join(directory, "remote-action.lock") }), { mode: 0o600 });
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
  const ignored = new Set(baseline?.ignoredPaths?.map(file => file.replace(/\/$/, "")));
  const protectedPath = (file: string) => {
    for (let parent = file; parent !== "."; parent = path.posix.dirname(parent)) {
      if (ignored.has(parent)) return true;
    }
    return false;
  };
  const key = crypto.createHash("sha256").update(repair.operationId).digest("hex");
  const directory = pipelineArtifactsDir(pipeline.id);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const scratch = await fs.promises.mkdtemp(path.join(directory, `repair-rollback-${key}-`));
  const indexFile = path.join(scratch, "index");
  const boundary = async () => {
    const head = await git(["rev-parse", "HEAD"]);
    const branch = await git(["branch", "--show-current"]);
    if (!baseline || head !== expectedHead || branch !== baseline.branch) {
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
    // The real index also carries force-added ignored files that HEAD lacks.
    await git(["read-tree", index], indexFile);
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
    const head = await git(["rev-parse", "HEAD"]);
    if (!repair.rollback && head !== baseline.sha) {
      // Producer creation receipts prove the whole repair suffix.
      // A foreign commit must stay untouched.
      await assertIdle();
      const owned = await ownsHead(head);
      await assertIdle();
      if (!owned) return preserve;
      expectedHead = head;
    } else if (repair.rollback && head === baseline.sha) expectedHead = baseline.sha;
    if (!repair.rollback) {
      const before = await snapshot();
      if (repair.commitCustody && (before.index !== repair.commitCustody.tree || before.tree !== repair.commitCustody.tree)) return preserve;
      const tracked = [...new Set((await git(["diff", "--name-only", "--no-renames", "-z", baseline.sha, "--", ".", ...CONTROLLER_ARTIFACT_PATHSPECS])
        + await git(["diff", "--cached", "--name-only", "--no-renames", "-z", baseline.sha, "--", ".", ...CONTROLLER_ARTIFACT_PATHSPECS])).split("\0").filter(Boolean))];
      const others = (await git(["ls-files", "--others", "--exclude-standard", "-z", "--", ".", ...CONTROLLER_ARTIFACT_PATHSPECS]))
        .split("\0").filter(Boolean);
      const untracked = others.filter(file => !protectedPath(file));
      const changedPaths = new Set((await git(["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", baseTree, before.tree]))
        .split("\0").filter(Boolean));
      const restore = [...tracked, ...others.filter(protectedPath)].filter(file => changedPaths.has(file));
      if (restore.length) await git(["restore", `--source=${baseline.sha}`, "--staged", "--", ...literal(restore)], indexFile);
      const afterTree = await git(["write-tree"], indexFile);
      // A second observation fences files changed while the snapshot awaited Git.
      const current = await snapshot();
      if (current.index !== before.index || current.tree !== before.tree) return preserve;
      repair.rollback = { ...before, afterTree, tracked, untracked, phase: "restore",
        ...(expectedHead !== baseline.sha ? { head: expectedHead } : {}) };
      await persist();
    }
    const rollback = repair.rollback;
    const trackedPaths = new Set(rollback.tracked);
    // Older handoffs cannot prove newly tracked files were repair-created.
    // Keep those contents rather than infer ownership from a commit receipt.
    if (baseline.ignoredPaths === undefined) {
      const additions = (await git(["diff-tree", "--no-commit-id", "--name-only", "--diff-filter=A", "-r", "-z", baseTree, rollback.tree]))
        .split("\0").filter(Boolean);
      if (additions.some(file => trackedPaths.has(file))) return preserve;
    }
    if (rollback.phase === "restore") {
      const current = await snapshot();
      const original = current.index === rollback.index && current.tree === rollback.tree;
      const restored = current.index === baseTree && current.tree === rollback.afterTree;
      const restoredSubset = async (from: string, to: string, desired: string) => {
        const changedPaths = (await git(["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", from, to])).split("\0").filter(Boolean);
        return changedPaths.every(file => trackedPaths.has(file) || protectedPath(file)) && (!changedPaths.length
          || !await git(["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", desired, to, "--", ...literal(changedPaths)]));
      };
      const partial = !original && !restored
        && await restoredSubset(rollback.index, current.index, baseTree)
        && await restoredSubset(rollback.tree, current.tree, rollback.afterTree);
      if (!original && !restored && !partial) return preserve;
      if (expectedHead !== baseline.sha) {
        // The intent survives a restart on either side of this ref write.
        // Its child rechecks head, branch, index and files after all awaits.
        await git(["update-ref", "--no-deref", `refs/heads/${baseline.branch}`, baseline.sha, expectedHead!]);
        expectedHead = baseline.sha;
      }
      if ((original || partial) && rollback.tracked.length) {
        const indexPaths = (await git(["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", baseTree, current.index])).split("\0").filter(Boolean);
        const worktreePaths = (await git(["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", rollback.afterTree, current.tree])).split("\0").filter(Boolean);
        const remaining = new Set([...indexPaths, ...worktreePaths]);
        const worktree = rollback.tracked.filter(file => remaining.has(file) && !protectedPath(file));
        const indexOnly = indexPaths.filter(file => trackedPaths.has(file) && protectedPath(file));
        if (worktree.length) {
          await git(["restore", `--source=${baseline.sha}`, "--staged", "--worktree", "--", ...literal(worktree)]);
          // Refresh the index stamp before the next guarded write. Both subsets
          // are covered by the persisted restore intent during restart recovery.
          if (indexOnly.length) {
            const refreshed = await snapshot();
            if (!await restoredSubset(rollback.index, refreshed.index, baseTree)
              || !await restoredSubset(rollback.tree, refreshed.tree, rollback.afterTree)) return preserve;
          }
        }
        if (indexOnly.length) await git(["restore", `--source=${baseline.sha}`, "--staged", "--", ...literal(indexOnly)]);
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
