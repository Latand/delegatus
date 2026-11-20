import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { procBackend } from "@/lib/proc";
import { captureProcessIdentity, processIdentityMayRun, processIdentityStatus } from "@/lib/processIdentity";
import { performanceSpans } from "@/lib/performanceSpans";
import type { ExecOptions, ExecPort, ExecResult } from "@/lib/workflows/provision";
import { pipelineArtifactsDir } from "./store";
import type { Pipeline } from "./types";
import { readWorktreeProvenance, worktreeRegistration } from "./worktreeProvenance";

type Lane = Pick<Pipeline, "id" | "repoDir" | "worktreeDir">;
const sameInode = (a: fs.BigIntStats, b: fs.BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const within = (target: string, directory: string) => target === directory || target.startsWith(directory + path.sep);
const missing = (error: unknown) => ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "");
const syncFile = promisify(fs.fsync);

/** Linux exposes descriptors and cwd in the Viewer's PID namespace. A process
    tied to this checkout or an uninspectable Git writer of the service account
    can block recovery even when its descriptors cannot be read. */
async function indexLockHolder(lock: string, gitDir: string, worktree: string, index: fs.BigIntStats,
  signal?: AbortSignal): Promise<string | null> {
  if (process.platform !== "linux" || procBackend.name !== "linux") return "open-file evidence is unavailable on this platform";
  const deadline = performance.now() + 5_000;
  const checkDeadline = () => {
    if (signal?.aborted || performance.now() >= deadline) throw new Error("the open-file check was interrupted");
  };
  let unreadablePid: number | undefined;
  for (const entry of await fs.promises.readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    checkDeadline();
    const pid = Number(entry);
    const identity = captureProcessIdentity(pid);
    if (!processIdentityMayRun(identity)) continue;
    const proc = `/proc/${pid}`;
    const argv = procBackend.readArgv(pid);
    const git = /^git(?:-|$)/.test(path.basename(argv[0] ?? ""));
    let cwd: string | undefined;
    try {
      cwd = await fs.promises.readlink(`${proc}/cwd`);
      let held = within(cwd, gitDir) ? "the worktree Git directory" : null;
      // Git may close its descriptor before installing the index. Retain a
      // live Git writer's claim while it is still bound to this checkout.
      let gitInCheckout = false;
      if (!held && git) {
        const dir = procBackend.readEnvVar(pid, "GIT_DIR");
        const checkout = procBackend.readEnvVar(pid, "GIT_WORK_TREE");
        gitInCheckout = dir ? path.resolve(cwd, dir) === gitDir : within(path.resolve(cwd, checkout ?? "."), worktree);
      }
      for (const fd of held ? [] : await fs.promises.readdir(`${proc}/fd`)) {
        checkDeadline();
        const descriptor = `${proc}/fd/${fd}`;
        try {
          const target = await fs.promises.readlink(descriptor);
          if (!within(target, gitDir)) continue;
          if (target === lock && !sameInode(index, await fs.promises.stat(descriptor, { bigint: true }))) continue;
          held = target === lock ? "index.lock" : "the worktree Git directory";
          break;
        } catch (error) { if (!missing(error)) throw error; }
      }
      if ((held || gitInCheckout) && processIdentityMayRun(identity)) {
        return held ? `PID ${pid} holds ${held}` : `PID ${pid} is running Git in the linked worktree`;
      }
    } catch (error) {
      checkDeadline();
      if (!processIdentityMayRun(identity)) continue;
      if (!["EACCES", "EPERM", "ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      const bound = (cwd && within(cwd, worktree)) || argv.some(arg => path.isAbsolute(arg)
        && (within(arg, gitDir) || within(arg, worktree)));
      if (bound) { unreadablePid ??= pid; continue; }
      if (argv.length && !git) continue;
      const status = await fs.promises.readFile(`${proc}/status`, "utf8").catch(error => {
        if (!missing(error)) throw error;
        return "";
      });
      if (processIdentityStatus(identity) === "dead") continue;
      const uids = /^Uid:\s*([\d\t ]+)$/m.exec(status)?.[1]?.trim().split(/\s+/);
      if (!uids || uids.includes(String(process.geteuid?.()))) unreadablePid ??= pid;
    }
  }
  return unreadablePid === undefined ? null : `open-file evidence for PID ${unreadablePid} is unavailable`;
}

/** Accept the command's EEXIST diagnostic for an absolute index.lock path. */
function refusedIndexLock(result: ExecResult): string | undefined {
  if (result.code === 0 || result.code === null) return;
  const lock = /^(?:fatal|error): [Uu]nable to create '([^\n]+)': File exists\./.exec(result.stderr)?.[1];
  if (lock && path.isAbsolute(lock) && path.basename(lock) === "index.lock") return lock;
}

/** The linked registration, its creation record and Git's effective index
    path must agree. Recheck the original inode after the asynchronous probe. */
export async function recoverLaneIndexLock(lane: Lane, lock: string, exec: ExecPort, operation: string,
  env?: Partial<NodeJS.ProcessEnv>, options?: ExecOptions, remove = true): Promise<string | null> {
  const refused = "index.lock recovery refused because this lane's worktree ownership could not be verified";
  try {
    const worktree = fs.realpathSync(lane.worktreeDir);
    const registration = worktreeRegistration(worktree);
    if (!registration) return refused;
    const gitDir = fs.realpathSync(registration.admin);
    if (path.join(gitDir, "index.lock") !== path.join(fs.realpathSync(path.dirname(lock)), path.basename(lock))) return refused;
    const directory = fs.lstatSync(gitDir, { bigint: true });
    if (!directory.isDirectory()) return refused;
    const index = fs.lstatSync(lock, { bigint: true, throwIfNoEntry: false });
    if (!index?.isFile() || index.nlink !== BigInt(1)) return "index.lock changed before recovery; retry with fresh evidence";
    const uid = process.geteuid?.();
    if (uid !== undefined && (index.uid !== BigInt(uid) || directory.uid !== BigInt(uid))) return refused;
    const probe = { ...options, stdoutEncoding: "utf8" as const, timeoutMs: Math.min(options?.timeoutMs ?? 5_000, 5_000) };
    const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], lane.repoDir, undefined, probe);
    if (common.code !== 0 || !path.isAbsolute(common.stdout.trim())) return refused;
    const commonDir = fs.realpathSync(common.stdout.trim());
    const ownsRegistration = () => {
      const current = worktreeRegistration(worktree);
      if (!current || fs.realpathSync(current.admin) !== gitDir || fs.realpathSync(lane.worktreeDir) !== worktree
        || !sameInode(directory, fs.lstatSync(gitDir, { bigint: true }))) return false;
      const owner = readWorktreeProvenance(worktree, { commonDir });
      return owner?.creator === "pipeline" && owner.id === lane.id;
    };
    if (!ownsRegistration()) return refused;
    const artifacts = pipelineArtifactsDir(lane.id);
    if (remove) await fs.promises.mkdir(artifacts, { recursive: true, mode: 0o700 });
    const location = await exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-path", "index"], lane.worktreeDir, env, probe);
    const [topLevel, effectiveIndex] = location.stdout.trimEnd().split("\n");
    if (location.code !== 0 || !topLevel || `${effectiveIndex}.lock` !== lock || fs.realpathSync(topLevel) !== worktree) return refused;
    const holder = await performanceSpans.wait("proc.scan", () => indexLockHolder(path.join(gitDir, "index.lock"), gitDir, worktree, index, options?.signal));
    if (holder) return `index.lock recovery blocked: ${holder}`;
    if (!remove) return "index.lock blocked the Git retry; inspect the worktree before retrying the stage";
    if (options?.signal?.aborted || !ownsRegistration()) return refused;
    const dirFd = fs.openSync(gitDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      if (!sameInode(directory, fs.fstatSync(dirFd, { bigint: true }))) return refused;
      const anchored = `/proc/self/fd/${dirFd}/index.lock`;
      const journal = fs.openSync(path.join(artifacts, "git-recovery.ndjson"),
        fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
      try {
        // Keep the inode comparison and unlink together after the async scan.
        const current = fs.lstatSync(anchored, { bigint: true, throwIfNoEntry: false });
        if (!current || !sameInode(index, current) || current.ctimeNs !== index.ctimeNs || current.mtimeNs !== index.mtimeNs) {
          return "index.lock changed during recovery; retry with fresh evidence";
        }
        fs.unlinkSync(anchored);
        fs.writeFileSync(journal, JSON.stringify({ at: new Date().toISOString(), operation, detail: "removed stale index.lock" }) + "\n");
        await syncFile(journal);
      } finally { fs.closeSync(journal); }
    } finally { fs.closeSync(dirFd); }
    return null;
  } catch {
    return "index.lock recovery could not verify or record the worktree lock state";
  }
}

/** Retry the exact failed command once. Use the same executor so the lane's
    existing authority checks, cancellation and inherited fence still apply. */
export function withLaneIndexLockRecovery(lane: Lane, exec: ExecPort): ExecPort {
  return async (command, args, cwd, env, options) => {
    const result = await exec(command, args, cwd, env, options);
    if (command !== "git" || path.resolve(cwd) !== path.resolve(lane.worktreeDir)) return result;
    const lock = refusedIndexLock(result);
    if (!lock) return result;
    const refusal = await recoverLaneIndexLock(lane, lock, exec, args[0]!, env, options);
    if (refusal) return { ...result, stderr: refusal };
    const retry = await exec(command, args, cwd, env, options);
    const next = refusedIndexLock(retry);
    if (!next) return retry;
    const detail = await recoverLaneIndexLock(lane, next, exec, args[0]!, env, options, false);
    return { ...retry, stderr: detail ?? retry.stderr };
  };
}
