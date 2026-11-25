import fs from "node:fs";
import { createRequire } from "node:module";
import { constants } from "node:os";
import path from "node:path";
import { currentOperationLease } from "@/lib/operationLease";
import { performanceSpans } from "@/lib/performanceSpans";
import { captureProcessIdentity, processIdentityMayRun } from "@/lib/processIdentity";
import { procBackend } from "@/lib/proc";
import type { ExecOptions, ExecPort, ExecResult } from "@/lib/workflows/provision";
import { pipelineArtifactsDir } from "./store";
import type { Pipeline } from "./types";
import { readWorktreeProvenance, worktreeRegistration } from "./worktreeProvenance";

type Lane = Pick<Pipeline, "id" | "repoDir" | "worktreeDir">;
const sameInode = (a: fs.BigIntStats, b: fs.BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const unchanged = (a: fs.BigIntStats, b?: fs.BigIntStats) =>
  b?.isFile() && sameInode(a, b) && b.nlink === 1n && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs && a.size === b.size;
const stat = (file: string) => fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
const within = (file: string, root: string) => file === root || file.startsWith(root + path.sep);
const gone = (error: unknown) => ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "");
const canonical = (file: string) => fs.realpathSync.native(file);
const CHANGED = "index.lock changed during recovery; retry with fresh evidence";
const UNBOUND = "index.lock recovery could not verify the checkout and controller authority";
type Recovery = { error: string } | { removed: boolean };
type RecoveryContext = {
  verifyInitializing?: () => boolean;
  rejectedPath?: string;
  inspectOnly?: boolean;
  recordIntent?: () => void | Promise<void>;
};
const WRITES_INDEX = new Set(["add", "am", "apply", "checkout", "checkout-index", "cherry-pick", "commit", "merge",
  "mv", "pull", "push", "read-tree", "rebase", "reset", "restore", "revert", "rm", "stash", "switch", "update-index", "write-tree"]);

/** Git diagnostics are a trigger only. The lock path comes from the checkout. */
export function reportsExistingIndexLock(text: string): boolean {
  return /(?:^|[\s/'"`\\])index\.lock(?:['"`])?:\s*File exists\b/i.test(text);
}

export function reportedIndexLockPath(text: string): string | undefined {
  return /Unable to create '([^\r\n]+index\.lock)': File exists\b/i.exec(text)?.[1];
}

/** Resolve the Git process's explicit directory or Git's nearest checkout
 * marker. This also distinguishes a separate repo nested inside the lane. */
async function gitTargetsCheckout(argv: string[], cwd: string, processDir: string, worktree: string, gitDir: string): Promise<boolean> {
  const targetsAdmin = (file: string) => within(file, gitDir) && !within(file, path.join(gitDir, "worktrees"));
  if (targetsAdmin(cwd)) return true;
  if (argv.slice(1).some(arg => {
    const candidate = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
    return Boolean(candidate) && targetsAdmin(path.resolve(cwd, candidate));
  })) return true;
  let explicit: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-C") {
      const next = path.resolve(cwd, argv[++i] || ".");
      try { cwd = canonical(next); }
      catch (error) { if (!gone(error)) throw error; cwd = next; }
    }
    else if (arg === "--git-dir") explicit = argv[++i];
    else if (arg.startsWith("--git-dir=")) explicit = arg.slice("--git-dir=".length);
    else if (["-c", "--config-env", "--work-tree", "--namespace"].includes(arg)) i++;
    else if (!arg.startsWith("-")) break;
  }
  if (targetsAdmin(cwd)) return true;
  const environment = (await fs.promises.readFile(`${processDir}/environ`, "utf8")).split("\0");
  const setting = (name: string) => environment.find(entry => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  const index = setting("GIT_INDEX_FILE");
  if (index) {
    const file = path.resolve(cwd, index);
    if (path.basename(file) === "index") {
      let parent = path.dirname(file);
      try { parent = canonical(parent); }
      catch (error) { if (!gone(error)) throw error; }
      if (parent === gitDir) return true;
    }
  }
  const dir = explicit ?? setting("GIT_DIR");
  if (dir) {
    const target = path.resolve(cwd, dir);
    try { return targetsAdmin(canonical(target)); }
    catch (error) { if (gone(error)) return targetsAdmin(target); throw error; }
  }
  const checkout = setting("GIT_WORK_TREE");
  if (checkout && within(path.resolve(cwd, checkout), worktree)) return true;
  if (argv.includes("worktree") && argv.includes("add")
    && argv.some(arg => path.resolve(cwd, arg) === worktree)) return true;
  for (let parent = cwd; within(parent, worktree); parent = path.dirname(parent)) {
    if (parent === worktree) return true;
    if (stat(path.join(parent, ".git"))) return false;
  }
  return false;
}

/** Based on the earlier pipeline holder census. Keep process identities and
 * compare descriptor device/inode even when a descriptor names another path. */
async function indexLockHolder(index: fs.BigIntStats, gitDir: string, worktree: string, signal?: AbortSignal) {
  const counts = { processes: 0, descriptors: 0, inaccessibleDescriptorTables: 0 };
  const possibleHolders: Array<{ identity: ReturnType<typeof captureProcessIdentity>; detail: string }> = [];
  const deadline = performance.now() + 5_000;
  const checkDeadline = () => {
    if (signal?.aborted || performance.now() >= deadline) throw new Error("index lock holder scan interrupted");
  };
  const mountinfo = await fs.promises.readFile("/proc/self/mountinfo", "utf8");
  if (mountinfo.split("\n").some(line => line.split(" ")[4] === "/proc"
    && /\bhidepid=(?!0(?:[,\s]|$)|off(?:[,\s]|$))/.test(line))) throw new Error("procfs hides processes");
  for (const entry of await fs.promises.readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    checkDeadline();
    const pid = Number(entry), processDir = `/proc/${pid}`;
    const identity = captureProcessIdentity(pid);
    if (!processIdentityMayRun(identity)) continue;
    counts.processes++;
    let argv: string[] = [], comm = "";
    const description = () => `PID ${pid} (${path.basename(argv[0] || comm || "command unavailable").replace(/[\x00-\x1f\x7f]/g, "?").slice(0, 80)})`;
    try {
      comm = (await fs.promises.readFile(`${processDir}/comm`, "utf8")).trim();
      argv = (await fs.promises.readFile(`${processDir}/cmdline`, "utf8")).split("\0").filter(Boolean);
      const git = [comm, path.basename(argv[0] ?? "")].some(name => /^git(?:-|$)/.test(name));
      if (git) {
        const rawCwd = await fs.promises.readlink(`${processDir}/cwd`);
        const cwd = rawCwd.replace(/ \(deleted\)$/, "");
        if (await gitTargetsCheckout(argv, cwd, processDir, worktree, gitDir) && processIdentityMayRun(identity)) {
          return { holder: `${description()} is running Git against this checkout`, counts };
        }
      }
      for (const fd of await fs.promises.readdir(`${processDir}/fd`)) {
        checkDeadline();
        counts.descriptors++;
        try {
          const descriptor = await fs.promises.stat(`${processDir}/fd/${fd}`, { bigint: true });
          if (sameInode(index, descriptor) && processIdentityMayRun(identity)) {
            return { holder: `${description()} holds an open descriptor on index.lock`, counts };
          }
        } catch (error) { if (!gone(error)) throw error; }
      }
    } catch {
      checkDeadline();
      if (!processIdentityMayRun(identity)) continue;
      const status = await fs.promises.readFile(`${processDir}/status`, "utf8").catch(() => "");
      if (!processIdentityMayRun(identity) || /^Kthread:\s+1$/m.test(status)) continue;
      // A readable command still can hold a descriptor, including one
      // opened with O_PATH, which does not participate in Linux write leases.
      // Keep scanning so an observed holder takes precedence in the refusal.
      possibleHolders.push({ identity, detail: `open-file or Git evidence for ${description()} is unavailable` });
      counts.inaccessibleDescriptorTables++;
    }
  }
  return { holder: possibleHolders.find(({ identity }) => processIdentityMayRun(identity))?.detail ?? null, counts };
}

/** Supplement the complete census with a Linux lease against late data opens.
 * SIGURG is ignored by default. F_GETLEASE reports a pending break as unlocked. */
function lockLease() {
  const ffi = createRequire(import.meta.url)(`bun:${"ffi"}`) as typeof import("bun:ffi");
  return ffi.dlopen("libc.so.6", { fcntl: { args: ["i32", "i32", "i32"], returns: "i32" } });
}
const F_SETSIG = 10, F_SETLEASE = 1024, F_GETLEASE = 1025, F_WRLCK = 1;

function checkoutGitDir(cwd: string): string | null {
  const dotGit = path.join(cwd, ".git");
  const entry = stat(dotGit);
  if (entry?.isDirectory()) return dotGit;
  if (entry?.isFile()) {
    const pointer = /^gitdir: (.+)\r?$/m.exec(fs.readFileSync(dotGit, "utf8"))?.[1]?.trim();
    if (pointer) return path.resolve(cwd, pointer);
  }
  return null;
}

/** Clear one standard index lock. With no candidate, do only checkout-local
 * metadata reads. An alternate Git index or directory stays outside this scope. */
export async function recoverLaneIndexLock(lane: Lane, cwd: string, exec: ExecPort, operation: string,
  env?: Partial<NodeJS.ProcessEnv>, options?: ExecOptions, context?: RecoveryContext): Promise<Recovery> {
  const logical = path.resolve(cwd);
  if (![path.resolve(lane.repoDir), path.resolve(lane.worktreeDir)].includes(logical)) return { removed: false };
  if (["GIT_DIR", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"].some(name =>
    Object.hasOwn(env ?? {}, name) ? env?.[name] : process.env[name])) return { removed: false };
  const leaseSignal = currentOperationLease()?.abort.signal;
  const signal = leaseSignal && options?.signal ? AbortSignal.any([leaseSignal, options.signal]) : leaseSignal ?? options?.signal;
  try {
    const hint = checkoutGitDir(logical);
    const index = hint && stat(path.join(hint, "index.lock"));
    if (!hint || !index) return { removed: false };
    if (process.platform !== "linux" || procBackend.name !== "linux") return { error: "index.lock recovery requires Linux open-file evidence" };
    const uid = BigInt(process.geteuid!());
    if (!index.isFile() || index.nlink !== 1n || index.uid !== uid) return { error: UNBOUND };
    const worktree = canonical(logical), gitDir = canonical(hint);
    const lock = path.join(gitDir, "index.lock");
    const rejected = context?.rejectedPath;
    if (rejected) {
      const targets = [logical, lane.repoDir].some(cwd => {
        try { return canonical(path.resolve(cwd, path.dirname(rejected))) === gitDir; }
        catch (error) { if (gone(error)) return false; throw error; }
      });
      if (path.basename(rejected) !== "index.lock" || !targets) return { error: UNBOUND };
    }
    const directory = stat(gitDir);
    if (!directory?.isDirectory() || directory.uid !== uid) return { error: UNBOUND };
    const probe = { ...options, signal, stdoutEncoding: "utf8" as const, timeoutMs: Math.min(options?.timeoutMs ?? 5_000, 5_000) };
    const actual = await exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-path", "index"], cwd, env, probe);
    const [root, indexFile] = actual.stdout.trimEnd().split("\n");
    if (actual.code !== 0 || !root || canonical(root) !== worktree || !indexFile
      || canonical(path.dirname(indexFile)) !== gitDir || path.basename(indexFile) !== "index") return { error: UNBOUND };
    const main = logical === path.resolve(lane.repoDir) && gitDir === path.join(worktree, ".git");
    let commonDir: string | undefined;
    if (!main) {
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], lane.repoDir, undefined, probe);
      if (common.code !== 0 || !path.isAbsolute(common.stdout.trim())) return { error: UNBOUND };
      commonDir = canonical(common.stdout.trim());
    }
    const bound = () => {
      const current = stat(gitDir);
      const location = checkoutGitDir(worktree);
      if (!current || !sameInode(directory, current) || canonical(logical) !== worktree
        || !location || canonical(location) !== gitDir) return false;
      if (main) return true;
      const registration = worktreeRegistration(worktree);
      if (!registration || canonical(registration.admin) !== gitDir
        || path.dirname(gitDir) !== path.join(commonDir!, "worktrees")) return false;
      const owner = readWorktreeProvenance(worktree, { commonDir });
      return owner ? owner.creator === "pipeline" && owner.id === lane.id : context?.verifyInitializing?.() === true;
    };
    if (signal?.aborted || !bound()) return { error: UNBOUND };
    const { holder, counts } = await performanceSpans.wait("proc.scan", () => indexLockHolder(index, gitDir, worktree, signal));
    if (holder) return { error: `index.lock recovery blocked: ${holder}` };
    if (context?.inspectOnly) return { error: "index.lock appeared again; retry with fresh evidence" };
    const stillAuthorized = async () => (await exec.revalidateIndexLockRecovery?.()) !== false && !signal?.aborted && bound();
    if (!await stillAuthorized()) return { error: UNBOUND };

    const dirFd = fs.openSync(gitDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      const anchored = `/proc/self/fd/${dirFd}/index.lock`;
      if (!sameInode(directory, fs.fstatSync(dirFd, { bigint: true })) || !unchanged(index, stat(anchored))) return { error: CHANGED };
      const lockFd = fs.openSync(anchored, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        if (!unchanged(index, fs.fstatSync(lockFd, { bigint: true }))) return { error: CHANGED };
        const lease = lockLease();
        try {
          const { fcntl } = lease.symbols;
          if (fcntl(lockFd, F_SETSIG, constants.signals.SIGURG) === 0 && fcntl(lockFd, F_SETLEASE, F_WRLCK) === 0) {
            const artifacts = pipelineArtifactsDir(lane.id);
            await fs.promises.mkdir(artifacts, { recursive: true, mode: 0o700 });
            const journal = await fs.promises.open(path.join(artifacts, "git-recovery.ndjson"),
              fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
            try {
              const record = await journal.stat({ bigint: true });
              if (!record.isFile() || record.uid !== uid || record.nlink !== 1n) return { error: UNBOUND };
              await journal.appendFile(JSON.stringify({ event: "index.lock recovery proof", at: new Date().toISOString(), operation,
                path: lock, device: String(index.dev), inode: String(index.ino), size: String(index.size), mtimeNs: String(index.mtimeNs), ...counts }) + "\n");
              await journal.sync();
            } finally { await journal.close(); }
            const artifactDir = await fs.promises.open(artifacts, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
            try { await artifactDir.sync(); } finally { await artifactDir.close(); }
            await context?.recordIntent?.();
            if (!await stillAuthorized()) return { error: UNBOUND };
            const exclusive = fcntl(lockFd, F_GETLEASE, 0) === F_WRLCK;
            // Another Git writer must create this name exclusively. Keep the
            // last inode comparison and unlink on the pinned directory together.
            if (!unchanged(index, stat(anchored))) return { error: CHANGED };
            if (!exclusive) return { error: "index.lock recovery blocked: another process requested the lock inode" };
            fs.unlinkSync(anchored);
            return { removed: true };
          }
        } finally { lease.close(); }
      } finally { fs.closeSync(lockFd); }
    } finally { fs.closeSync(dirFd); }
    const late = await performanceSpans.wait("proc.scan", () => indexLockHolder(index, gitDir, worktree, signal));
    return { error: `index.lock recovery blocked: ${late.holder ?? "an exclusive kernel lease on the lock inode is unavailable"}` };
  } catch {
    return { error: "index.lock recovery could not verify or record the lock state" };
  }
}

/** Git receives one attempt after preflight. If a lock appears during the
 * first call, retry a direct index-lock refusal once under the same authority. */
export function withLaneIndexLockRecovery(lane: Lane, exec: ExecPort, verifyInitializing?: () => boolean): ExecPort {
  const rejectedIndexLock = (result: ExecResult) => {
    if (result.code === 0 || result.code === null) return;
    const lock = /^(?:fatal|error): Unable to create '([^\r\n]+)': File exists\b/i.exec(result.stderr.trimStart())?.[1];
    if (lock && path.basename(lock) === "index.lock") return lock;
  };
  const guarded: ExecPort = async (command, args, cwd, env, options) => {
    const operation = args[0];
    if (command !== "git" || !WRITES_INDEX.has(operation ?? "")) return exec(command, args, cwd, env, options);
    const refused = (stderr: string): ExecResult => ({ code: 1, stdout: "", stderr });
    const recovery = await recoverLaneIndexLock(lane, cwd, exec, operation!, env, options, { verifyInitializing });
    if ("error" in recovery) return refused(recovery.error);
    const result = await exec(command, args, cwd, env, options);
    // A push can report a hook's diagnostic after it has started. Its remote
    // effects remain subject to the publisher's reconciliation, never replay.
    const rejectedPath = rejectedIndexLock(result);
    if (!rejectedPath) return result;
    const retry = await recoverLaneIndexLock(lane, cwd, exec, operation!, env, options,
      { verifyInitializing, rejectedPath, inspectOnly: recovery.removed || operation === "push" });
    if ("error" in retry) return { ...result, stderr: retry.error };
    if (!retry.removed) return result;
    const again = await exec(command, args, cwd, env, options);
    const another = rejectedIndexLock(again);
    if (!another) return again;
    const detail = await recoverLaneIndexLock(lane, cwd, exec, operation!, env, options,
      { verifyInitializing, rejectedPath: another, inspectOnly: true });
    return "error" in detail ? { ...again, stderr: detail.error } : again;
  };
  guarded.revalidateIndexLockRecovery = exec.revalidateIndexLockRecovery;
  return guarded;
}
