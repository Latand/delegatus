import type { promises as fsp } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { classifyArtifact } from "@/lib/artifact/classify";
import { evidenceHtmlImageSourcesWithinBudget, transformEvidenceHtmlWithinBudget } from "@/lib/artifact/evidenceHtml";
import { frameCsp, frameMime, verifyFrameScope } from "@/lib/artifact/frameScope";
import { admittedAs, evidenceFrameAdmission, lexicalAllowedRoots, realpathAdmitted, openAdmitted, realAllowedRoots, streamWindowUntil, underRoot } from "@/lib/artifact/localFile";
import { artifactEtag, artifactLimits, SNIFF_BYTES, sniffAgrees } from "@/lib/artifact/serve";
import { rejectForeignHost } from "@/lib/sameOrigin";
import { existingTeamStore } from "@/lib/team/store";
import { workspaceScope } from "@/lib/team/workspaceAccess";
import { projectForCwd } from "@/lib/scanner/describe";

import { readEvidenceHtml } from "./readEvidenceHtml";

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

function requestBoundaryError(signal: AbortSignal, deadline: number): Error | null {
  if (signal.aborted) return new Error("client aborted");
  if (Date.now() >= deadline) return new Error("artifact time budget exceeded");
  return null;
}

/** Race non-cancellable I/O against the request's one deadline and disconnect. */
function withinRequest<T>(operation: Promise<T>, signal: AbortSignal, deadline: number, onAbandoned?: () => void): Promise<T> {
  const expired = requestBoundaryError(signal, deadline);
  if (expired) {
    void operation.then(() => onAbandoned?.(), () => onAbandoned?.());
    return Promise.reject(expired);
  }
  let operationSettled = false;
  const observed = Promise.resolve(operation).then(value => {
    operationSettled = true;
    return value;
  }, error => {
    operationSettled = true;
    throw error;
  });
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) {
        if (!operationSettled) void observed.then(() => onAbandoned?.(), () => onAbandoned?.());
        reject(error);
      } else resolve(value as T);
    };
    const onAbort = () => finish(new Error("client aborted"));
    const timer = setTimeout(() => finish(new Error("artifact time budget exceeded")), Math.max(0, deadline - Date.now()));
    signal.addEventListener("abort", onAbort, { once: true });
    observed.then(value => finish(undefined, value), error => finish(error instanceof Error ? error : new Error(String(error))));
    if (signal.aborted) onAbort();
  });
}

async function inlineScopedImages(source: string, base: string, scope: string, maxBytes: number, host: string, signal: AbortSignal, deadline: number): Promise<Map<string, string>> {
  const baseUrl = new URL(base);
  const scopeRoot = `${baseUrl.origin}/api/artifact/frame/${scope}/`;
  const images = new Map<string, string>();
  let total = 0;
  for (const sourceUrl of (await evidenceHtmlImageSourcesWithinBudget(source, deadline, signal)).slice(0, 32)) {
    if (signal.aborted) throw new Error("client aborted");
    if (Date.now() >= deadline) throw new Error("artifact time budget exceeded");
    if (sourceUrl.startsWith("data:image/")) continue;
    if (sourceUrl.includes("\\")) continue;
    let target: URL;
    try { target = new URL(sourceUrl, baseUrl); } catch { continue; }
    if (target.origin !== baseUrl.origin || !target.href.startsWith(scopeRoot)) continue;
    // Decide from the path before dispatching the internal GET. An HTML image
    // target would recursively enter this renderer and open another report.
    const targetType = classifyArtifact(target.pathname);
    if (targetType?.kind !== "image" || !/^image\/(?:png|jpeg|gif|webp|avif|bmp)$/.test(targetType.mime)) continue;
    const response = await getFrame(new NextRequest(target, { headers: {
      host,
      origin: "null",
      "sec-fetch-site": "cross-site",
      "sec-fetch-dest": "image",
    }, signal }), deadline);
    const mime = response.headers.get("content-type")?.split(";", 1)[0] ?? "";
    const length = Number(response.headers.get("content-length"));
    if (!response.ok || !/^image\/(?:png|jpeg|gif|webp|avif|bmp)$/.test(mime)
      || !Number.isSafeInteger(length) || length < 0 || total + length > maxBytes) {
      await response.body?.cancel().catch(() => {});
      continue;
    }
    const bytes = new Uint8Array(await withinRequest(response.arrayBuffer(), signal, deadline));
    if (signal.aborted) throw new Error("client aborted");
    if (Date.now() >= deadline) throw new Error("artifact time budget exceeded");
    if (bytes.length !== length || total + bytes.length > maxBytes) continue;
    total += bytes.length;
    images.set(sourceUrl, `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`);
  }
  return images;
}

async function getFrame(req: NextRequest, deadline: number): Promise<NextResponse> {
  const limits = artifactLimits();
  const bounded = <T,>(operation: Promise<T>, onAbandoned?: () => void) => withinRequest(operation, req.signal, deadline, onAbandoned);
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
  let cspOrigin: string;
  try {
    const authority = new URL(`${protocol}://${requestHost ?? requestUrl.host}`);
    cspOrigin = authority.origin;
  }
  catch { return refuse(400, "invalid request authority"); }
  const ipv6Authority = new URL(cspOrigin).hostname.includes(":");
  const evidenceBase = kind === "evidence" && !ipv6Authority ? `${cspOrigin}/api/artifact/frame/${scope}/` : undefined;
  const csp = frameCsp(scope, cspOrigin, kind === "evidence", Boolean(evidenceBase), kind === "evidence" && ipv6Authority);

  const abs = path.resolve(directory, ...inside);
  const roots = lexicalAllowedRoots();
  let canonicalEvidenceRoots = roots;
  if (kind === "evidence") {
    if (!grant.evidenceRoot || !grant.evidenceRootPath || !roots.evidenceReports.includes(grant.evidenceRootPath)
      || !underRoot(directory, grant.evidenceRoot)) return refuse(403, "outside the admitted evidence root");
    try {
      if (await bounded(fs.realpath(grant.evidenceRootPath)) !== grant.evidenceRoot) return refuse(403, "evidence root changed");
    } catch (error) {
      const message = (error as Error).message;
      if (message === "client aborted" || message === "artifact time budget exceeded") throw error;
      return refuse(403, "evidence root unavailable");
    }
    canonicalEvidenceRoots = {
      ...roots,
      evidence: [...roots.evidence, grant.evidenceRoot],
      evidenceReports: [...roots.evidenceReports, grant.evidenceRoot],
    };
  }
  const admission = kind === "evidence" ? evidenceFrameAdmission(abs, canonicalEvidenceRoots) : admittedAs(abs, roots);
  if (!underRoot(abs, directory) || !admission) return refuse(403, "outside the report directory");

  const classified = classifyArtifact(abs);
  if (!classified) return refuse(415, "not a previewable file type");

  let real: string;
  try {
    real = await bounded(fs.realpath(abs));
    const resolvedRoots = await bounded(realAllowedRoots());
    if (kind === "evidence" && (!grant.evidenceRoot || !resolvedRoots.evidenceReports.includes(grant.evidenceRoot)))
      return refuse(403, "evidence root changed");
    if (!realpathAdmitted(admission, real, resolvedRoots)) return refuse(403, "outside the allowed roots");
  } catch (error) {
    const message = (error as Error).message;
    if (message === "client aborted" || message === "artifact time budget exceeded") throw error;
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
    const opening = openAdmitted(real);
    handle = await bounded(opening, () => { void opening.then(opened => opened.close().catch(() => {}), () => {}); });
  } catch (error) {
    const message = (error as Error).message;
    if (message === "client aborted" || message === "artifact time budget exceeded") throw error;
    const code = (error as NodeJS.ErrnoException).code;
    return refuse(code === "ENOENT" || code === "EISDIR" ? 404 : 403, "file not readable");
  }
  let handleOperations = 0;
  let closeRequested = false;
  let closeStarted = false;
  const closeHandle = async () => {
    closeRequested = true;
    if (handleOperations > 0 || closeStarted) return;
    closeStarted = true;
    await handle.close().catch(() => {});
  };
  const handleOperation = <T,>(operation: Promise<T>) => {
    handleOperations++;
    const observed = Promise.resolve(operation).then(value => {
      handleOperations--;
      if (closeRequested) void closeHandle();
      return value;
    }, error => {
      handleOperations--;
      if (closeRequested) void closeHandle();
      throw error;
    });
    return bounded(observed, () => { closeRequested = true; });
  };
  try {
    const stat = await handleOperation(handle.stat());
    if (!stat.isFile()) {
      await closeHandle();
      return refuse(404, "not a regular file");
    }
    if (stat.size > limits.maxBytes) {
      await closeHandle();
      return refuse(413, "file exceeds the configured byte bound");
    }
    /* The same content check /api/artifact applies: a renamed binary or a
       file whose signature disagrees with its extension is refused here too. */
    const head = Buffer.alloc(Math.min(SNIFF_BYTES, stat.size));
    if (head.length > 0) await handleOperation(handle.read(head, 0, head.length, 0));
    if (!sniffAgrees(classified.mime, head)) {
      await closeHandle();
      return refuse(415, "file content does not match its extension");
    }
    if (!verifyFrameScope(scope)) {
      await closeHandle();
      return refuse(403, "this report link has expired; reopen the preview");
    }
    const responseType = frameMime(path.extname(real).slice(1), classified.mime);
    let body: string | null = null;
    let responseLength = stat.size;
    if (kind === "evidence" && /\.html?$/i.test(real)) {
      let source: Buffer;
      try {
        source = await readEvidenceHtml(handle, limits.maxBytes, req.signal, deadline, handleOperation);
      } catch (error) {
        const message = (error as Error).message;
        if (message === "artifact exceeds the configured byte bound") {
          await closeHandle();
          return refuse(413, message);
        }
        if (message === "artifact time budget exceeded") {
          await closeHandle();
          return refuse(408, message);
        }
        if (message === "client aborted") {
          await closeHandle();
          return new NextResponse(null, { status: 499, headers: HEADERS_BASE });
        }
        throw error;
      }
      let images: Map<string, string> | undefined;
      if (ipv6Authority) {
        try {
          images = await inlineScopedImages(source.toString("utf8"), evidenceBase ?? `${cspOrigin}/api/artifact/frame/${scope}/`, scope,
            limits.maxBytes, req.headers.get("host") ?? requestUrl.host, req.signal, deadline);
        } catch (error) {
          const message = (error as Error).message;
          await closeHandle();
          if (message === "client aborted") return new NextResponse(null, { status: 499, headers: HEADERS_BASE });
          if (message === "artifact time budget exceeded") return refuse(408, message);
          throw error;
        }
      }
      try {
        body = await transformEvidenceHtmlWithinBudget(source.toString("utf8"), ipv6Authority ? undefined : evidenceBase,
          images, deadline, req.signal);
      } catch (error) {
        const message = (error as Error).message;
        await closeHandle();
        if (message === "client aborted") return new NextResponse(null, { status: 499, headers: HEADERS_BASE });
        if (message === "artifact time budget exceeded") return refuse(408, message);
        throw error;
      }
      if (Date.now() >= deadline) {
        await closeHandle();
        return refuse(408, "artifact time budget exceeded");
      }
      responseLength = Buffer.byteLength(body, "utf8");
    }
    const headers = new Headers({
      ...HEADERS_BASE,
      ...(kind === "evidence" ? { "permissions-policy": "autoplay=(), camera=(), geolocation=(), microphone=(), payment=(), usb=()" } : {}),
      "content-security-policy": csp,
      ...corsFor(req),
      "content-type": responseType,
      "content-length": String(responseLength),
      etag: artifactEtag(stat),
    });
    if (body !== null) {
      await closeHandle();
      return new NextResponse(body, { status: 200, headers });
    }
    if (stat.size === 0) {
      await closeHandle();
      return new NextResponse(null, { status: 200, headers });
    }
    return new NextResponse(streamWindowUntil(handle, 0, stat.size - 1, req.signal, deadline), { status: 200, headers });
  } catch (error) {
    await closeHandle();
    throw error;
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const deadline = Date.now() + artifactLimits().timeBudgetMs;
  try {
    return await getFrame(req, deadline);
  } catch (error) {
    const message = (error as Error).message;
    if (message === "client aborted") return new NextResponse(null, { status: 499, headers: HEADERS_BASE });
    if (message === "artifact time budget exceeded") return refuse(408, message);
    throw error;
  }
}
