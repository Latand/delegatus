import fs from "node:fs";
import path from "node:path";

/**
 * Which linked worktrees Delegatus itself created (security audit of 1.15.0,
 * finding 3).
 *
 * The worktree sweep removes only checkouts Delegatus made. A record of that
 * is written when the worktree is added, into the checkout's own Git
 * administrative directory (`<common dir>/worktrees/<name>/`), so it lives
 * and dies with that one registration: `git worktree remove` and `prune`
 * delete it with the directory, and a checkout added by hand later at the
 * same path gets a fresh directory with no record. It names what Git wrote
 * into the registration's `gitdir` back link at that moment, so a checkout
 * that was moved no longer matches and is not claimed either.
 *
 * Imports only Node built-ins: `scripts/merge-batch.ts` records its own
 * checkouts with it.
 */

export const WORKTREE_PROVENANCE_FILE = "delegatus-provenance.json";

export type WorktreeCreator = "pipeline" | "workflow" | "merge-batch";

export type WorktreeProvenance = {
  version: 1;
  creator: WorktreeCreator;
  /** The pipeline, workflow or merge batch that added the checkout. */
  id: string;
  /** The registration's `gitdir` back link as Git wrote it. */
  gitdir: string;
  createdAt: string;
};

const CREATORS: ReadonlySet<string> = new Set<WorktreeCreator>(["pipeline", "workflow", "merge-batch"]);

type Access = (file: string) => string;
const direct: Access = (file) => file;

function samePath(left: string, right: string, accessible: Access): boolean {
  if (path.resolve(left) === path.resolve(right)) return true;
  try { return fs.realpathSync(accessible(left)) === fs.realpathSync(accessible(right)); }
  catch { return false; }
}

/** The checkout's administrative directory and the back link Git keeps in
    it, or null unless the two point at each other. */
function registration(worktree: string, accessible: Access): { admin: string; gitdir: string } | null {
  try {
    const dotGit = path.join(worktree, ".git");
    if (!fs.lstatSync(accessible(dotGit)).isFile()) return null;
    const pointer = /^gitdir: (.+)$/m.exec(fs.readFileSync(accessible(dotGit), "utf8"))?.[1]?.trim();
    if (!pointer) return null;
    const admin = path.resolve(worktree, pointer);
    const gitdir = fs.readFileSync(accessible(path.join(admin, "gitdir")), "utf8").trim();
    if (!gitdir || !samePath(path.resolve(admin, gitdir), dotGit, accessible)) return null;
    return { admin, gitdir };
  } catch {
    return null;
  }
}

/** Records that `creator` added this checkout. Call right after `git
    worktree add` succeeds. Create-only: a retry that adopts the checkout it
    made earlier keeps the first record. Never throws; false when nothing
    could be recorded, which leaves the checkout to its owner. */
export function recordWorktreeProvenance(worktree: string, owner: { creator: WorktreeCreator; id: string }, now: Date = new Date()): boolean {
  const found = registration(path.resolve(worktree), direct);
  if (!found) return false;
  const file = path.join(found.admin, WORKTREE_PROVENANCE_FILE);
  if (fs.existsSync(file)) return readWorktreeProvenance(worktree) !== null;
  const record: WorktreeProvenance = { version: 1, creator: owner.creator, id: owner.id, gitdir: found.gitdir, createdAt: now.toISOString() };
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(record) + "\n", { mode: 0o600, flag: "wx" });
    // A link refuses an existing name, so a concurrent writer's record stays.
    fs.linkSync(temporary, file);
    return true;
  } catch {
    return readWorktreeProvenance(worktree) !== null;
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* Never created, or already gone. */ }
  }
}

/** The creation record of a linked checkout of the repository whose common
    Git directory is `commonDir`, or null when there is none, it is
    malformed, or it was written for another registration. */
export function readWorktreeProvenance(worktree: string, options: { commonDir?: string; accessible?: Access } = {}): WorktreeProvenance | null {
  const accessible = options.accessible ?? direct;
  const found = registration(path.resolve(worktree), accessible);
  if (!found) return null;
  if (options.commonDir && !samePath(path.dirname(found.admin), path.join(options.commonDir, "worktrees"), accessible)) return null;
  try {
    const file = accessible(path.join(found.admin, WORKTREE_PROVENANCE_FILE));
    if (!fs.lstatSync(file).isFile()) return null;
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<WorktreeProvenance> | null;
    if (!record || record.version !== 1 || typeof record.creator !== "string" || !CREATORS.has(record.creator)
      || typeof record.id !== "string" || !record.id || record.gitdir !== found.gitdir || typeof record.createdAt !== "string") return null;
    return record as WorktreeProvenance;
  } catch {
    return null;
  }
}
