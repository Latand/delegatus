import { NextResponse, type NextRequest } from "next/server";

import { operatorBrowserRequest } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { accessKeyWithheld } from "@/lib/team";

/*
 * Who may read a key's value (docs/design/keys-settings.md §9). Every reveal,
 * copy, export, import and replace is the operator's own action in a
 * Delegatus page:
 *
 * - the perimeter first: same origin and a pinned Host (`rejectCrossOrigin`);
 * - no agent: a caller presenting any spawn capability, valid or not, is
 *   refused, and so is a Viewer service's own request;
 * - a browser page: a browser stamps `sec-fetch-site: same-origin` on the
 *   page's own fetch, which a page elsewhere cannot forge and a spawned
 *   process's plain request does not carry (`operatorBrowserRequest`);
 * - on a team install, the owner only: a member sees states, never values.
 *
 * A process of the operator's own uid can still read the 0600 files directly,
 * and forge the browser's header; these routes add no reach on the machine
 * itself, and they never hand a value to anything that named itself an agent.
 */

const NO_STORE = { "Cache-Control": "no-store" };

export function keysJson<T>(body: T, status = 200): NextResponse<T> {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** Whether this request is the operator (or the team's owner) in a Delegatus page. */
export function keysOwnerRequest(req: NextRequest): boolean {
  if (req.headers.has(VIEWER_SPAWN_CAPABILITY_HEADER)) return false;
  if (!operatorBrowserRequest(req)) return false;
  return !accessKeyWithheld(req);
}

/** The refusal to answer, or null when the caller may read and write keys. */
export function keysOwnerGate(req: NextRequest): NextResponse | null {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  if (req.headers.has(VIEWER_SPAWN_CAPABILITY_HEADER) || !operatorBrowserRequest(req)) {
    return keysJson({ error: "keys are shown and changed only from a Delegatus page", code: "operator_only" }, 403);
  }
  if (accessKeyWithheld(req)) return keysJson({ error: "only the owner can do this", code: "owner_required" }, 403);
  return null;
}

/** A request body read with a bound, so a large body never sits in memory; no error carries any of it. */
export async function readBoundedJson(req: NextRequest, limit: number): Promise<Record<string, unknown> | null> {
  const reader = req.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

/** One line per operator action, with the key and the action and never a value. */
export function auditKeyAction(action: "reveal" | "copy" | "export" | "import" | "replace", ids: readonly string[]): void {
  console.info(`[keys] ${action} ${ids.join(",") || "-"}`);
}
