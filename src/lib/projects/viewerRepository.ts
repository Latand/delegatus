import { projectIdentityFromRemote } from "./identity";

/* Delegatus itself was published as Latand/live-log-viewer-next until GitHub
   renamed the repository to Latand/delegatus on 2026-09-23, and GitHub
   redirects the old name. A checkout cloned from the old URL keeps minting the
   old repository key until its origin is re-pointed, and the forge-proven alias
   (`succession.ts`) joins the two keys only after that. Until then the release
   names one remote and the operator's seat sits under the other, so the
   release's own identity has to answer for both. The current name comes first. */
const VIEWER_REPOSITORY_NAMES = ["github.com/Latand/delegatus", "github.com/Latand/live-log-viewer-next"] as const;

/**
 * The repository keys a Delegatus release deployed from `remote` owns, primary
 * first. A remote naming Delegatus under either GitHub name yields the keys of
 * both names; any other remote (a fork, a private mirror) yields only its own.
 * An empty answer means the remote names no repository.
 */
export function viewerRepositoryProjects(remote: string, root: string): string[] {
  const identity = projectIdentityFromRemote(remote, root);
  if (!identity) return [];
  const named = identity.canonicalRemote.toLowerCase();
  if (!VIEWER_REPOSITORY_NAMES.some((name) => name.toLowerCase() === named)) return [identity.project];
  const renamed = VIEWER_REPOSITORY_NAMES
    .map((name) => projectIdentityFromRemote(`https://${name}.git`, root)?.project)
    .filter((project): project is string => Boolean(project));
  return [...new Set([identity.project, ...renamed])];
}
