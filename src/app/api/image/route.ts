import fs from "node:fs/promises";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { admittedAs, lexicalAllowedRoots, realAllowedRoots, realpathAdmitted, resolveLocal } from "@/lib/artifact/localFile";
import { SNIFF_BYTES, sniffAgrees } from "@/lib/artifact/serve";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* SVG is deliberately excluded: served inline from the app origin it would run
   embedded same-origin script. Only inert raster formats are embeddable. */
const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
};

/**
 * Serves the bytes of a local image a transcript references by path, so the
 * markdown renderer can embed it inline (Markdown `![alt](/abs/path.png)`).
 * Confined to files with an image extension under the roots the artifact
 * route reads (the home directory and the evidence roots, #2084) — a
 * localhost-only tool, but there is no reason to hand out arbitrary files.
 */
export async function GET(req: NextRequest): Promise<NextResponse<ApiError> | NextResponse> {
  // Same gate as the mutating routes: a drive-by page or DNS-rebind must not
  // pull local image bytes off this loopback service.
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  const raw = req.nextUrl.searchParams.get("path") ?? "";
  if (!raw) return NextResponse.json({ error: "path is required" }, { status: 400 });
  const abs = resolveLocal(raw);

  const admission = admittedAs(abs, lexicalAllowedRoots());
  if (!admission) {
    return NextResponse.json({ error: "path not allowed" }, { status: 403 });
  }
  const mime = MIME[path.extname(abs).toLowerCase()];
  if (!mime) return NextResponse.json({ error: "not an image" }, { status: 400 });

  let data: Buffer;
  try {
    // Resolve symlinks and re-check containment: a symlink under a root with an
    // image extension must not read a file outside it (e.g. ~/x.png → /etc/shadow).
    const real = await fs.realpath(abs);
    if (!realpathAdmitted(admission, real, await realAllowedRoots())) {
      return NextResponse.json({ error: "path not allowed" }, { status: 403 });
    }
    const stat = await fs.stat(real);
    if (!stat.isFile()) return NextResponse.json({ error: "not a file" }, { status: 404 });
    data = await fs.readFile(real);
  } catch {
    return NextResponse.json({ error: "file not found" }, { status: 404 });
  }
  /* The extension names the type; the bytes must agree, as /api/artifact
     requires, so a renamed text file is never handed out as an image. */
  if (!sniffAgrees(mime, data.subarray(0, SNIFF_BYTES))) {
    return NextResponse.json({ error: "content does not match the image type" }, { status: 415 });
  }
  return new NextResponse(new Uint8Array(data), {
    headers: { "content-type": mime, "cache-control": "private, max-age=60", "x-content-type-options": "nosniff" },
  });
}
