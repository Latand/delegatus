import { constants as FS, type promises as fsp } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { classifyArtifact } from "@/lib/artifact/classify";
import { FRAME_CSP, frameMime, verifyFrameScope } from "@/lib/artifact/frameScope";
import { homeRoot, streamWindow, underRoot } from "@/lib/artifact/localFile";
import { artifactEtag, artifactLimits, SNIFF_BYTES, sniffAgrees } from "@/lib/artifact/serve";
import { rejectForeignHost } from "@/lib/sameOrigin";

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
 * meta read of /api/artifact. What it serves stays inside what /api/artifact
 * already serves — the home root and the previewable types — narrowed to the
 * report's directory tree, checked lexically and again after realpath, and
 * held to the same content check (`sniffAgrees`) on the pinned descriptor.
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
  "content-security-policy": FRAME_CSP,
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
  const directory = verifyFrameScope(scope);
  if (!directory) return refuse(403, "this report link has expired; reopen the preview");

  const abs = path.resolve(directory, ...inside);
  const home = homeRoot();
  if (!underRoot(abs, directory) || !underRoot(abs, home)) return refuse(403, "outside the report directory");

  const classified = classifyArtifact(abs);
  if (!classified) return refuse(415, "not a previewable file type");

  let real: string;
  let realDirectory: string;
  try {
    realDirectory = await fs.realpath(directory);
    real = await fs.realpath(abs);
    if (!underRoot(realDirectory, await fs.realpath(home))) return refuse(403, "outside the allowed roots");
  } catch {
    return refuse(404, "file not found");
  }
  if (!underRoot(real, realDirectory)) return refuse(403, "outside the report directory");

  let handle: fsp.FileHandle;
  try {
    handle = await fs.open(real, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
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
    const headers = new Headers({
      ...HEADERS_BASE,
      ...corsFor(req),
      "content-type": frameMime(path.extname(real).slice(1), classified.mime),
      "content-length": String(stat.size),
      etag: artifactEtag(stat),
    });
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
