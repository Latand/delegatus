import { canonicalProject } from "@/lib/projects/aliases";
import { projectIdentityFromRepositoryRoot, repositoryRootForPath } from "@/lib/projects/identity";

/* "Is this seat's project the Viewer's own?" — the one question that decides
 * whether a mandate may carry instructions about deploying Agent Log Viewer
 * (#1745).
 *
 * People run managers for their own projects. A directive that says "YOU decide
 * when to deploy … call deploy_exact_sha" is about the Viewer's own production
 * and about nothing else, so it may only reach the seat of the project this
 * Viewer IS. Everyone else's mandate must say nothing about it.
 *
 * The comparison is between two project KEYS, and both are minted by the same
 * algorithm so there is no second naming scheme: a seat's key comes from the
 * repository identity of its cwd (`describe.ts` → `projectIdentityFrom*`), and
 * the Viewer's key comes from the repository identity of the checkout this
 * process runs out of. Both are then resolved through the operator's project
 * aliases, because a renamed project reaches the seat route under its alias
 * target and the raw identity would no longer match it.
 *
 * TEMPORARY HOME. The deploy refusal in #1321 answers the same question on the
 * server side and resolves it from the release's bundled repository metadata,
 * which keeps working in a packaged release that ships no `.git` of its own.
 * That resolver is the one this should become; it lives behind
 * `src/lib/mcp/**`, which this lane does not own, so the predicate sits here
 * until the two can be folded together. Until then a packaged release names its
 * checkout with `LLV_VIEWER_REPOSITORY_ROOT`; with neither a checkout nor that
 * override, nothing resolves and the section is withheld from every project —
 * the safe direction, and never the reverse.
 */

/** The checkout the running Viewer's own code lives in, named explicitly for a
    packaged release that carries no repository metadata of its own. */
function viewerRepositoryRoot(): string | null {
  const configured = process.env.LLV_VIEWER_REPOSITORY_ROOT?.trim();
  return repositoryRootForPath(configured || process.cwd());
}

/** The canonical project key of the repository this Viewer is, or null when the
    running release cannot name its own checkout. */
export function viewerOwnProject(): string | null {
  const root = viewerRepositoryRoot();
  const identity = root ? projectIdentityFromRepositoryRoot(root) : null;
  return identity ? canonicalProject(identity.project) : null;
}

/** Whether a seat's project is the Viewer's own. An unresolved project on
    either side answers false: the caller's question is "may this seat be told
    how to deploy the Viewer", and an unknown is not a yes. */
export function isViewerOwnProject(project: string | null | undefined): boolean {
  const seat = project?.trim();
  if (!seat) return false;
  const viewer = viewerOwnProject();
  return viewer !== null && canonicalProject(seat) === viewer;
}
