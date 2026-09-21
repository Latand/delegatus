/*
 * The artifact preview's own URL fragment (issue #884): `#a=<encoded path>`,
 * parallel to — and deliberately distinct from — the `#f=` conversation card
 * deep-link. The fragment carries ONLY the path. Everything that decides
 * whether the path may be read stays where a clicked link already goes:
 * classification in ./classify.ts and authorization in /api/artifact — so a
 * pasted URL can never reach a file a click could not.
 *
 * Agents also hand over `#f=<path to a report>` links, which name a file
 * rather than a transcript; the link resolver (./linkTarget.ts) decides which
 * is which, and a `#f=` naming a file opens this preview as well.
 */

import { resolveLink } from "./linkTarget";

export function formatArtifactFragment(path: string): string {
  return "#a=" + encodeURIComponent(path);
}

/** The linked file a fragment names — `#a=`, or a `#f=` that is not a
    transcript — spelled as `path[:line[:col]][#anchor]`, or null for every
    other fragment. Malformed percent-encoding degrades to the raw payload
    (matching the conversation hash parser) — the server rejects nonsense paths
    explicitly. */
export function parseArtifactFragment(hash: string): string | null {
  const match = hash.match(/^#([af])=(.+)$/);
  if (!match) return null;
  let spelled: string;
  try {
    spelled = decodeURIComponent(match[2]!);
  } catch {
    spelled = match[2]!;
  }
  if (match[1] === "a") return spelled;
  return resolveLink(hash)?.kind === "file" ? spelled : null;
}
