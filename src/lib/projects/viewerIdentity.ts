import viewerPackageManifest from "../../../package.json";

import { canonicalProject } from "@/lib/projects/aliases";
import { projectIdentityFromRemote } from "@/lib/projects/identity";

/**
 * The canonical project of the Agent Log Viewer this process IS — the one
 * resolver for every question of the form "is this the Viewer's own project?".
 *
 * Two callers ask it and they must never disagree: the deploy refusal (#1321),
 * which decides whether `deploy_exact_sha` may act for a seat, and the mandate
 * delivery (#1745), which decides whether that seat is told how to deploy. A
 * seat told to deploy but refused when it does, or refused a section it is
 * entitled to, is the gap a second resolver opens.
 *
 * An MCP client launches wherever the CALLER works, so the cwd names somebody
 * else's repository, and a PACKAGED RELEASE ships no `.git` of its own to read
 * instead. The one fact that travels with the code is the canonical remote it
 * is deployed from — `LLV_VIEWER_CANONICAL_REMOTE` when the host configures
 * one, else the repository metadata bundled in the Viewer's own manifest —
 * resolved through the SAME repository-key algorithm that names live
 * checkouts, so a clone of that remote and the release built from it land on
 * one project id.
 *
 * Folded through the operator's project aliases because seats are stored
 * alias-resolved: comparing a raw repository id against an aliased seat project
 * would refuse the Viewer's own deploy and withhold its own deploy section.
 */
export function viewerOwnProject(): string | null {
  const configured = process.env.LLV_VIEWER_CANONICAL_REMOTE?.trim();
  const remote = configured || viewerPackageManifest.repository.url.trim();
  const project = projectIdentityFromRemote(remote, process.cwd())?.project ?? null;
  return project ? canonicalProject(project.trim()) : null;
}
