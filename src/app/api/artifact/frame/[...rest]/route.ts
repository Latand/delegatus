import type { promises as fsp } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { classifyArtifact } from "@/lib/artifact/classify";
import { containEvidenceHtml } from "@/lib/artifact/evidenceHtml";
import { frameCsp, frameMime, verifyFrameScope } from "@/lib/artifact/frameScope";
import { admittedAs, evidenceFrameAdmission, lexicalAllowedRoots, realpathAdmitted, openAdmitted, realAllowedRoots, streamWindow, underRoot } from "@/lib/artifact/localFile";
import { artifactEtag, artifactLimits, SNIFF_BYTES, sniffAgrees } from "@/lib/artifact/serve";
import { rejectForeignHost } from "@/lib/sameOrigin";
import { existingTeamStore } from "@/lib/team/store";
import { workspaceScope } from "@/lib/team/workspaceAccess";
import { projectForCwd } from "@/lib/scanner/describe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The HTML report frame: `/api/artifact/frame/<scope>/<path inside the scope>`.
 *
 * Serves an agent's HTML report and the relative CSS, images and scripts it
 * pulls in, so the preview can show the report the way a browser would. The
 * preview's iframe is sandboxed without `allow-same-origin`, and every
 * response here carries the same sandbox as a CSP, so the document runs in an
 * opaque origin whether it is framed or opened in its own tab: it cannot read
 * the viewer's DOM, storage or cookies, and its requests to the viewer's API
 * arrive cross-origin and are refused by the same-origin gate.
 *
 * Those same cross-origin requests are why this route cannot use that gate
 * itself. It authorizes by the scope in the path instead (see frameScope.ts):
 * a signed, expiring grant for ONE directory, minted only by the same-origin
 * meta read of /api/artifact. Project and scratch roots serve previewable types.
 * Restricted evidence roots serve HTML and rasters here. Every read stays
 * inside the report's directory tree, checked lexically and again after
 * realpath, with content checked on the pinned descriptor.
 *
 * A successful response admits the frame's opaque origin by CORS
 * (`Access-Control-Allow-Origin: null`, never with credentials), because
 * module scripts and `fetch()` from an origin-less document are CORS requests
 * and would otherwise be blocked. That grants nothing the scope did not: the
 * bytes are the ones this response already serves to a `<script src>`, and
 * the viewer's own routes still refuse the frame.
 */

const HEADERS_BASE = {
  "x-content-type-options": "nosniff",
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy": "sandbox allow-scripts",
};

function refuse(status: number, message: string): NextResponse {
  return new NextResponse(message, {
    status,
    headers: { ...HEADERS_BASE, "content-type": "text/plain; charset=utf-8" },
  });
}

/** CORS for the report's own opaque origin, on authorized responses only. */
function corsFor(req: NextRequest): Record<string, string> {
  return req.headers.get("origin") === "null" ? { "access-control-allow-origin": "null", vary: "origin" } : { vary: "origin" };
}

function segmentsOf(pathname: string): string[] | null {
  const prefix = "/api/artifact/frame/";
  if (!pathname.startsWith(prefix)) return null;
  const segments: string[] = [];
  for (const raw of pathname.slice(prefix.length).split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    /* No climbing out, no smuggled separators, no NUL. */
    if (segment === "" || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\0")) return null;
    segments.push(segment);
  }
  return segments;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const hostRejection = rejectForeignHost(req);
  if (hostRejection) return hostRejection;

  const segments = segmentsOf(req.nextUrl.pathname);
  if (!segments || segments.length < 2) return refuse(404, "not found");
  const [scope, ...inside] = segments as [string, ...string[]];
  const grant = verifyFrameScope(scope);
  if (!grant) return refuse(403, "this report link has expired; reopen the preview");
  const { directory, kind } = grant;
  const forwardedProtocol = req.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim();
  const requestUrl = new URL(req.url);
  const protocol = forwardedProtocol === "https" ? "https" : requestUrl.protocol.slice(0, -1);
  const requestHost = req.headers.get("host");
  // CSP host matching does not support IPv6 literals. For loopback IPv6,
  // scope relative asset URLs to the equivalent localhost authority instead.
  let cspOrigin: string;
  let ipv6Loopback = false;
  try {
    const authority = new URL(`${protocol}://${requestHost ?? requestUrl.host}`);
    ipv6Loopback = authority.hostname.replace(/^\[|\]$/g, "") === "::1";
    cspOrigin = ipv6Loopback
      ? `${protocol}://localhost${authority.port ? `:${authority.port}` : ""}`
      : authority.origin;
  }
  catch { return refuse(400, "invalid request authority"); }
  const evidenceBase = kind === "evidence" && ipv6Loopback ? `${cspOrigin}/api/artifact/frame/${scope}/` : undefined;
  const csp = frameCsp(scope, cspOrigin, kind === "evidence", Boolean(evidenceBase));

  const abs = path.resolve(directory, ...inside);
  const roots = lexicalAllowedRoots();
  let canonicalEvidenceRoots = roots;
  if (kind === "evidence") {
    if (!grant.evidenceRoot || !grant.evidenceRootPath || !roots.evidence.includes(grant.evidenceRootPath)
      || !underRoot(directory, grant.evidenceRoot)) return refuse(403, "outside the admitted evidence root");
    try {
      if (await fs.realpath(grant.evidenceRootPath) !== grant.evidenceRoot) return refuse(403, "evidence root changed");
    } catch { return refuse(403, "evidence root unavailable"); }
    canonicalEvidenceRoots = { ...roots, evidence: [...new Set([...roots.evidence, grant.evidenceRoot])] };
  }
  const admission = kind === "evidence" ? evidenceFrameAdmission(abs, canonicalEvidenceRoots) : admittedAs(abs, roots);
  if (!underRoot(abs, directory) || !admission) return refuse(403, "outside the report directory");

  const classified = classifyArtifact(abs);
  if (!classified) return refuse(415, "not a previewable file type");

  let real: string;
  try {
    real = await fs.realpath(abs);
    const resolvedRoots = await realAllowedRoots();
    if (kind === "evidence" && grant.evidenceRoot && !resolvedRoots.evidence.includes(grant.evidenceRoot))
      resolvedRoots.evidence = [...resolvedRoots.evidence, grant.evidenceRoot];
    if (!realpathAdmitted(admission, real, resolvedRoots)) return refuse(403, "outside the allowed roots");
  } catch {
    return refuse(404, "file not found");
  }
  // The metadata route signs the canonical directory. A later symlink in
  // its place cannot move that grant to a different directory.
  if (!underRoot(real, directory)) return refuse(403, "outside the report directory");

  /* A signed session proves who opened the report, not that the member still
     has access to its workspace. Re-evaluate file permission for every page
     and asset request so removing a workspace placement revokes live grants. */
  if (grant.sessionId) {
    const store = existingTeamStore();
    const session = store?.session(grant.sessionId);
    const targetProject = projectForCwd(path.dirname(real));
    if (!store || !session || !workspaceScope(store, session.memberId).canReadFile(targetProject))
      return refuse(403, "workspace file access was revoked");
  }

  /* Kept only when the open file lies at the resolved path: a directory
     swapped for a link after the checks above reads nothing. */
  let handle: fsp.FileHandle;
  try {
    handle = await openAdmitted(real);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return refuse(code === "ENOENT" || code === "EISDIR" ? 404 : 403, "file not readable");
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      await handle.close();
      return refuse(404, "not a regular file");
    }
    const limits = artifactLimits();
    if (stat.size > limits.maxBytes) {
      await handle.close();
      return refuse(413, "file exceeds the configured byte bound");
    }
    /* The same content check /api/artifact applies: a renamed binary or a
       file whose signature disagrees with its extension is refused here too. */
    const head = Buffer.alloc(Math.min(SNIFF_BYTES, stat.size));
    if (head.length > 0) await handle.read(head, 0, head.length, 0);
    if (!sniffAgrees(classified.mime, head)) {
      await handle.close();
      return refuse(415, "file content does not match its extension");
    }
    if (!verifyFrameScope(scope)) {
      await handle.close();
      return refuse(403, "this report link has expired; reopen the preview");
    }
    const responseType = frameMime(path.extname(real).slice(1), classified.mime);
    let body: Uint8Array | null = null;
    let responseLength = stat.size;
    if (kind === "evidence" && /\.html?$/i.test(real)) {
      body = Buffer.from(containEvidenceHtml((await handle.readFile()).toString("utf8"), evidenceBase), "utf8");
      responseLength = body.byteLength;
    }
    const headers = new Headers({
      ...HEADERS_BASE,
      "content-security-policy": csp,
      ...corsFor(req),
      "content-type": responseType,
      "content-length": String(responseLength),
      etag: artifactEtag(stat),
    });
    if (body) {
      await handle.close();
      return new NextResponse(body, { status: 200, headers });
    }
    if (stat.size === 0) {
      await handle.close();
      return new NextResponse(null, { status: 200, headers });
    }
    return new NextResponse(streamWindow(handle, 0, stat.size - 1, req.signal, limits.timeBudgetMs), { status: 200, headers });
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}
