import { canonicalProject } from "@/lib/projects/aliases";
import { viewerOwnProject } from "@/lib/projects/viewerIdentity";

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
 * the Viewer's key comes from {@link viewerOwnProject}, the resolver the deploy
 * refusal (#1321) answers the same question with. That sharing is the point:
 * the section is delivered to exactly the seat `deploy_exact_sha` would act
 * for, and the two can never disagree — including in a packaged release, which
 * carries no `.git` and names itself from its bundled repository metadata.
 * Both sides are then resolved through the operator's project aliases, because
 * a renamed project reaches the seat route under its alias target and the raw
 * identity would no longer match it.
 */

export { viewerOwnProject };

/** Whether a seat's project is the Viewer's own. An unresolved project on
    either side answers false: the caller's question is "may this seat be told
    how to deploy the Viewer", and an unknown is not a yes. */
export function isViewerOwnProject(project: string | null | undefined): boolean {
  const seat = project?.trim();
  if (!seat) return false;
  const viewer = viewerOwnProject();
  return viewer !== null && canonicalProject(seat) === viewer;
}
