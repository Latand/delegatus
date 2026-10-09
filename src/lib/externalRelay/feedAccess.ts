import type { NextRequest } from "next/server";

import { pathAllowed } from "@/lib/scanner/roots";

import { isRelayTranscript } from "./conversationView";
import { guardRelayRoute } from "./routeGuard";

/**
 * The paths a feed read may serve to this request: the scanner's roots, and
 * for the operator alone the transcript of a relay chat conversation, so the
 * conversation opens in the agent window. An agent's request, a cross-origin
 * one and a staging Viewer get the roots and nothing more, which keeps those
 * transcripts out of every agent's reach as relay-slice3.md §4.6 requires.
 */
export function feedPathAllowed(request: NextRequest): (pathname: string) => boolean {
  let operator: boolean | null = null;
  return (pathname) => {
    if (pathAllowed(pathname)) return true;
    operator ??= guardRelayRoute(request) === null;
    return operator && isRelayTranscript(pathname);
  };
}
