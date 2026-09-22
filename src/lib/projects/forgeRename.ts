import { execFile } from "node:child_process";
import fs from "node:fs";

import {
  canonicalProject,
  isRemoteRepositoryIdentity,
  recordedProjectRemote,
  type RemoteProjectMove,
} from "@/lib/projects/aliases";
import {
  isRepositoryProjectId,
  projectIdentityFromRepositoryRoot,
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
  | { status: "found"; id: number }
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

const LOOKUP_TIMEOUT_MS = 10_000;

function ghLookup(fullName: string): Promise<ForgeRepositoryLookup | null> {
  return new Promise((resolve) => {
    execFile("gh", ["api", `repos/${fullName}`, "--jq", ".id"], { timeout: LOOKUP_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (!error) {
        const id = Number(String(stdout).trim());
        resolve(Number.isSafeInteger(id) && id > 0 ? { status: "found", id } : null);
        return;
      }
      /* A 404 from an authenticated `gh` is an answer; anything else (no `gh`,
         not logged in, no network) hands the question to plain REST. */
      resolve(/HTTP 404/.test(String(stderr)) ? { status: "missing" } : null);
    });
  });
}

async function restLookup(fullName: string): Promise<ForgeRepositoryLookup> {
  try {
    const response = await fetch(`https://api.github.com/repos/${fullName}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "delegatus-forge-rename" },
      redirect: "follow",
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (response.status === 404) return { status: "missing" };
    if (!response.ok) return { status: "unreachable" };
    const body = await response.json() as { id?: unknown };
    return typeof body.id === "number" && Number.isSafeInteger(body.id) && body.id > 0
      ? { status: "found", id: body.id }
      : { status: "unreachable" };
  } catch {
    return { status: "unreachable" };
  }
}

/** `gh api` when `gh` is installed and signed in (it sees private
    repositories), else an unauthenticated REST request, which is enough for a
    public repository. Both follow GitHub's redirect from a former name. */
export const githubRepositoryLookup: ForgeLookup = async (fullName) => (await ghLookup(fullName)) ?? restLookup(fullName);

const decisions = new Map<string, Exclude<ForgeRenameDecision, "undecided">>();
let activeLookup: ForgeLookup = githubRepositoryLookup;
let queue: Promise<unknown> = Promise.resolve();

function decisionKey(candidate: ForgeRenameCandidate): string {
  return `${candidate.sourceRemote}\0${candidate.targetRemote}`;
}

/**
 * Ask the forge whether the two remotes are one repository. Equal ids prove
 * the rename; different ids, or no repository at the old name, refuse it; a
 * lookup that could not be answered decides nothing, and the next scan asks
 * again. Proofs and refusals are held for the life of the process, so each
 * pair costs at most two requests per boot.
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
  const [before, after] = await Promise.all([lookup(oldName), lookup(newName)]);
  if (before.status === "unreachable" || after.status === "unreachable") return "undecided";
  const decision = before.status === "found" && after.status === "found" && before.id === after.id ? "proven" : "refused";
  decisions.set(key, decision);
  return decision;
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
 * The catalog's entry: judge `candidates` after every pass already queued, so
 * two scans never record the same succession side by side. Never throws; an
 * unanswered pass is simply asked again by a later scan.
 */
export function scheduleForgeRenames(candidates: readonly ForgeRenameCandidate[]): void {
  if (candidates.length === 0) return;
  queue = queue
    .then(() => recordForgeRenames(candidates))
    .catch(() => {
      console.error("[project catalog] forge rename check deferred; a later scan will retry");
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
}
