import fs from "node:fs";

import { runGithubCliRead } from "@/lib/forge/githubCli";
import { githubReadDiagnostic } from "@/lib/forge/githubReadFailure";
import {
  canonicalProject,
  isRemoteRepositoryIdentity,
  recordedProjectRemote,
  recordProjectRemote,
  type RemoteProjectMove,
} from "@/lib/projects/aliases";
import {
  isRepositoryProjectId,
  projectIdentityFromRepositoryRoot,
  projectIdentityFromRemote,
  type RepositoryProjectIdentity,
} from "@/lib/projects/identity";
import { recordProjectSuccessions, type ProjectSuccession } from "@/lib/projects/succession";
import { projectRootForCwd } from "@/lib/scanner/describe";

/**
 * A renamed or transferred repository keeps its board (rename-delegatus.md
 * §2.3).
 *
 * A repository's project key is a hash of its `origin`, so renaming the
 * repository on GitHub and updating a checkout's `origin` mints a new key, and
 * everything recorded under the old one (the seat, its tasks, the board)
 * would be stranded. A changed remote is not by itself evidence of a rename:
 * a checkout re-pointed at a fork or an unrelated repository changes its
 * remote the same way, and merging those boards is wrong (#2035).
 *
 * The proof is the forge's: GitHub answers the old name of a renamed or
 * transferred repository with the same numeric repository id as the new name,
 * and a fork has an id of its own. The old remote comes from the per-machine
 * ledger `state/project-remotes.json`, since the old key cannot be reversed.
 * A proven pair becomes an ordinary {@link ProjectSuccession}: the alias, the
 * board migration and one `project_moved` line, recorded once.
 *
 * Only `github.com` remotes are judged; any other forge gets no alias and
 * behaves as before.
 */

/** A remote-to-remote move waiting for the forge's answer. */
export interface ForgeRenameCandidate {
  source: string;
  sourceRemote: string;
  target: string;
  targetRemote: string;
  displayName: string;
}

export type ForgeRepositoryLookup =
  | { status: "found"; id: number; fullName?: string }
  | { status: "missing" }
  | { status: "unreachable" };

/** Ask the forge for one `owner/name`. */
export type ForgeLookup = (fullName: string) => Promise<ForgeRepositoryLookup>;

export type ForgeRenameDecision = "proven" | "refused" | "undecided";

const GITHUB_REPOSITORY = /^github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/;

function githubFullName(remote: string): string | null {
  return GITHUB_REPOSITORY.exec(remote)?.[1] ?? null;
}

/** The candidate a remote-to-remote move owes the forge, or null when there is
    nothing to ask: the old key's remote was never seen here, either side is
    off GitHub, or the move is already recorded. */
export function forgeRenameCandidate(source: string, target: RepositoryProjectIdentity): ForgeRenameCandidate | null {
  if (!isRepositoryProjectId(source) || source === target.project) return null;
  if (!isRemoteRepositoryIdentity(target)) return null;
  if (canonicalProject(source) === target.project) return null;
  const sourceRemote = recordedProjectRemote(source);
  if (!sourceRemote || sourceRemote === target.canonicalRemote) return null;
  if (!githubFullName(sourceRemote) || !githubFullName(target.canonicalRemote)) return null;
  return {
    source,
    sourceRemote,
    target: target.project,
    targetRemote: target.canonicalRemote,
    displayName: target.displayName,
  };
}

/** The candidate a project key owes, judged from one folder it was used in:
    the folder's repository now resolves to a different remote id. */
export function forgeRenameCandidateFor(project: string, folder: string | null | undefined): ForgeRenameCandidate | null {
  const cwd = folder?.trim();
  if (!cwd) return null;
  try {
    if (!fs.statSync(cwd).isDirectory()) return null;
  } catch {
    return null;
  }
  const root = projectRootForCwd(cwd);
  const identity = root ? projectIdentityFromRepositoryRoot(root) : null;
  return identity ? forgeRenameCandidate(project.trim(), identity) : null;
}

/** The candidates the durable alias pass handed over instead of aliasing. */
export function forgeRenameCandidatesFromMoves(moves: readonly RemoteProjectMove[]): ForgeRenameCandidate[] {
  return moves
    .map((move) => forgeRenameCandidate(move.source, move.target))
    .filter((candidate): candidate is ForgeRenameCandidate => candidate !== null);
}

function repositoryAnswer(body: { id?: unknown; full_name?: unknown }): ForgeRepositoryLookup | null {
  if (typeof body.id !== "number" || !Number.isSafeInteger(body.id) || body.id <= 0) return null;
  return { status: "found", id: body.id,
    ...(typeof body.full_name === "string" && githubFullName(`github.com/${body.full_name}`)
      ? { fullName: body.full_name } : {}) };
}

const LOOKUP_TIMEOUT_MS = 10_000;
const RETRY_MS = 3 * 60_000;
const MAX_RETRY_ENTRIES = 1024;

const lastDiagnostic = new Map<ReturnType<typeof githubReadDiagnostic>["cause"], number>();
const defaultGithubRead = (args: string[]) => runGithubCliRead(args, { timeout: LOOKUP_TIMEOUT_MS });
type RepositoryRequest = (url: string, init: RequestInit) => Promise<Response>;

async function restLookup(fullName: string, request: RepositoryRequest): Promise<ForgeRepositoryLookup> {
  try {
    const response = await request(`https://api.github.com/repos/${fullName}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "delegatus-forge-rename" },
      redirect: "follow",
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    // The public endpoint can also return 404 for a private repository.
    // Only a successful public response can supply evidence after gh failed.
    if (!response.ok) return { status: "unreachable" };
    const body = await response.json() as { id?: unknown; full_name?: unknown };
    return repositoryAnswer(body) ?? { status: "unreachable" };
  } catch {
    return { status: "unreachable" };
  }
}

/** `gh api` when `gh` is installed and signed in (it sees private
    repositories), else an unauthenticated REST request, which is enough for a
    public repository. Both follow GitHub's redirect from a former name. */
export async function githubRepositoryLookup(fullName: string, {
  run = defaultGithubRead, request = fetch, log = console.warn,
}: { run?: typeof defaultGithubRead; request?: RepositoryRequest; log?: (message: string) => void } = {}): Promise<ForgeRepositoryLookup> {
  try {
    const answer = repositoryAnswer(JSON.parse(await run(["api", `repos/${fullName}`, "--jq", "{id, full_name}"])));
    if (answer) return answer;
    throw new SyntaxError("Missing repository id in GitHub response");
  } catch (error) {
    const diagnostic = githubReadDiagnostic(error);
    if (diagnostic.cause === "not-found") return { status: "missing" };
    const answer = await restLookup(fullName, request);
    if (answer.status === "unreachable") {
      const now = Date.now();
      if (now - (lastDiagnostic.get(diagnostic.cause) ?? -Infinity) >= RETRY_MS) {
        lastDiagnostic.set(diagnostic.cause, now);
        log(`[forge rename] ${diagnostic.message}`);
      }
    }
    return answer;
  }
}

const decisions = new Map<string, Exclude<ForgeRenameDecision, "undecided">>();
const pendingChecks = new Set<string>();
const retryAfter = new Map<string, number>();
let activeLookup: ForgeLookup = githubRepositoryLookup;
let queue: Promise<unknown> = Promise.resolve();

function decisionKey(candidate: ForgeRenameCandidate): string {
  return `${candidate.sourceRemote}\0${candidate.targetRemote}`;
}

/**
 * Ask the forge whether the two remotes are one repository. Equal ids prove
 * the rename; different ids, or no repository at the old name, refuse it; a
 * lookup that could not be answered decides nothing. Proofs and refusals are
 * held for the life of the process, so a decided pair requires no more reads.
 */
export async function decideForgeRename(
  candidate: ForgeRenameCandidate,
  lookup: ForgeLookup = activeLookup,
): Promise<ForgeRenameDecision> {
  const key = decisionKey(candidate);
  const held = decisions.get(key);
  if (held) return held;
  const oldName = githubFullName(candidate.sourceRemote);
  const newName = githubFullName(candidate.targetRemote);
  if (!oldName || !newName) return "refused";
  try {
    const [before, after] = await Promise.all([lookup(oldName), lookup(newName)]);
    if (before.status === "unreachable" || after.status === "unreachable") return "undecided";
    const decision = before.status === "found" && after.status === "found" && before.id === after.id ? "proven" : "refused";
    decisions.set(key, decision);
    return decision;
  } catch {
    return "undecided";
  }
}

/**
 * Judge every candidate and record the proven ones as successions. Returns
 * what this call recorded; a replay records nothing. Network work happens
 * here, so a caller runs this detached, after its own persistence, and never
 * under a pipeline lease.
 */
export async function recordForgeRenames(
  candidates: Iterable<ForgeRenameCandidate | null>,
  lookup: ForgeLookup = activeLookup,
): Promise<ProjectSuccession[]> {
  const unique = new Map<string, ForgeRenameCandidate>();
  for (const candidate of candidates) {
    if (candidate && !unique.has(candidate.source)) unique.set(candidate.source, candidate);
  }
  const proven: ProjectSuccession[] = [];
  for (const candidate of unique.values()) {
    if (await decideForgeRename(candidate, lookup) !== "proven") continue;
    proven.push({ source: candidate.source, target: candidate.target, displayName: candidate.displayName });
  }
  return proven.length > 0 ? recordProjectSuccessions(proven) : [];
}

/**
 * The catalog's entry: share pending checks across scans and give the forge
 * time to recover before asking again. The scan continues with local identity.
 */
export function scheduleForgeRenames(candidates: readonly ForgeRenameCandidate[]): void {
  const now = Date.now();
  const pending = new Map<string, ForgeRenameCandidate>();
  for (const candidate of candidates) {
    const key = decisionKey(candidate);
    if (pendingChecks.has(key) || now < (retryAfter.get(key) ?? 0)) continue;
    retryAfter.delete(key);
    pendingChecks.add(key);
    pending.set(key, candidate);
  }
  if (!pending.size) return;
  queue = queue
    .then(() => recordForgeRenames(pending.values()))
    .catch(() => {
      console.error("[project catalog] forge rename check deferred; a later scan will retry");
    }).finally(() => {
      const next = Date.now() + RETRY_MS;
      for (const key of pending.keys()) {
        pendingChecks.delete(key);
        retryAfter.set(key, next);
      }
      while (retryAfter.size > MAX_RETRY_ENTRIES) retryAfter.delete(retryAfter.keys().next().value!);
    });
}

/** Test seam: the forge the catalog asks (null restores GitHub). */
export function setForgeLookupForTests(lookup: ForgeLookup | null): void {
  activeLookup = lookup ?? githubRepositoryLookup;
}

/** Test seam: wait for every scheduled pass. */
export async function forgeRenamesSettledForTests(): Promise<void> {
  await queue;
}

/** Test seam: forget the per-process forge decisions. */
export function resetForgeRenameDecisionsForTests(): void {
  decisions.clear();
  sharedChecks.clear();
  retryAfter.clear();
  lastDiagnostic.clear();
}

const sharedChecks = new Map<string, number>();
const SHARED_CHECK_TTL_MS = 86_400_000;

/** Discover a forge rename even when the checkout still uses its former
 * origin. Reserve the TTL before queuing, so repeated exchange reads share
 * one detached check. Unanswered checks retry after the same bounded TTL. */
export function scheduleSharedForgeRenames(projects: readonly string[]): void {
  const now = Date.now();
  const pending: Array<{ source: string; remote: string }> = [];
  for (const source of new Set(projects.map(canonicalProject))) {
    const remote = recordedProjectRemote(source);
    if (!remote || !githubFullName(remote)) continue;
    const held = sharedChecks.get(source);
    if (held !== undefined && now - held < SHARED_CHECK_TTL_MS) continue;
    sharedChecks.set(source, now);
    pending.push({ source, remote });
  }
  if (!pending.length) return;
  queue = queue.then(async () => {
    for (const { source, remote } of pending) {
      if (canonicalProject(source) !== source) continue;
      try {
        const answer = await activeLookup(githubFullName(remote)!);
        if (answer.status !== "found" || !answer.fullName || !githubFullName(`github.com/${answer.fullName}`)) continue;
        const target = projectIdentityFromRemote(`https://github.com/${answer.fullName}`, "/");
        if (!target || target.project === source) continue;
        const candidate: ForgeRenameCandidate = {
          source, sourceRemote: remote, target: target.project,
          targetRemote: target.canonicalRemote, displayName: target.displayName,
        };
        // A detached check must re-prove both names on each TTL, including a
        // previously refused pair whose old name now redirects correctly.
        decisions.delete(decisionKey(candidate));
        if (await decideForgeRename(candidate) !== "proven") continue;
        recordProjectRemote(target);
        if (recordedProjectRemote(target.project) !== target.canonicalRemote) continue;
        await recordForgeRenames([candidate]);
      } catch {
        // A failed lookup or persistence never blocks the shared-list read.
      }
    }
  }).catch(() => {
    console.error("[project catalog] shared forge rename check deferred");
  });
}
