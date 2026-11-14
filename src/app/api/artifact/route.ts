import { workspaceRoute, requestWorkspaceScope, workspaceDenied } from "@/lib/team/workspaceRoute";
import { projectForCwd } from "@/lib/scanner/describe";
import type { promises as fsp } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { classifyArtifact } from "@/lib/artifact/classify";
import { frameUrl, mintFrameScope } from "@/lib/artifact/frameScope";
import { requestSession } from "@/lib/team/sessions";
import { existingTeamStore } from "@/lib/team/store";
import { artifactEtag, artifactLimits, artifactResponseHeaders, parseByteRange, SNIFF_BYTES, sniffAgrees } from "@/lib/artifact/serve";
import { admittedAs, lexicalAllowedRoots, keptPictureProject, openAdmitted, readablePlace, realAllowedRoots, realpathAdmitted, resolveLocal, streamWindow } from "@/lib/artifact/localFile";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The ONE narrow resource route behind the issue #875 document preview: serves
 * the bytes of a single previewable artifact (PDF, inert image, bounded text)
 * that a conversation linked, and nothing else.
 *
 * Access model — identical to /api/image, the existing local-bytes route: the
 * same-origin/Host gate IS the operator authority on this loopback service
 * (see `page.tsx`), and the allowed-root policy confines reads to the
 * recorded project folders, their checkouts, manual projects and stage scratch.
 * Evidence roots and the report picture store serve raster images only.
 * The home directory itself is never an allowed root.
 *
 * Containment is enforced twice (lexical resolve, then realpath) so neither
 * `..` traversal nor a symlink under a root may reach outside it; the final open
 * is O_NOFOLLOW against the resolved real path and is kept only when the open
 * file lies at that path (`openAdmitted`), so a directory swapped for a link
 * after the check reads nothing; and everything after — the
 * regular-file check, the size bound, the validator, the sniff and every
 * streamed byte — reads through that one file descriptor, so a rename or
 * replacement mid-response can never splice a different file's bytes in.
 */

type FailCode =
  | "access-denied"
  | "not-found"
  | "not-a-file"
  | "unsupported"
  | "mime-mismatch"
  | "too-large"
  | "changed";

interface FailBody extends ApiError {
  code: FailCode;
}

const FAIL_STATUS: Record<FailCode, number> = {
  "access-denied": 403,
  "not-found": 404,
  "not-a-file": 404,
  unsupported: 415,
  "mime-mismatch": 415,
  "too-large": 413,
  changed: 412,
};

function fail(code: FailCode, error: string): NextResponse<FailBody> {
  return NextResponse.json({ error, code }, { status: FAIL_STATUS[code] });
}

async function workspaceGET(req: NextRequest): Promise<NextResponse<FailBody> | NextResponse> {
  /* Same gate as every other loopback route: a drive-by page or DNS rebind
     must not pull local file bytes out of this service. */
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  const raw = req.nextUrl.searchParams.get("path") ?? "";
  if (!raw) return NextResponse.json({ error: "path is required" }, { status: 400 });

  /* A picture a report named is read from its kept copy once it is gone. */
  const requested = resolveLocal(raw);
  const abs = readablePlace(requested);
  const admission = admittedAs(abs, lexicalAllowedRoots());
  if (!admission) return fail("access-denied", "path is outside the allowed roots");

  const classified = classifyArtifact(abs);
  if (!classified) return fail("unsupported", "not a previewable artifact type");
  const { kind, mime } = classified;
  const name = path.basename(abs);

  /* Resolve symlinks, then re-check containment: ~/x.pdf → /anywhere must not
     read outside the roots. The roots themselves are realpathed so a symlinked
     allowed directory compares canonically. */
  let real: string;
  try {
    real = await fs.realpath(abs);
  } catch {
    return fail("not-found", "file not found");
  }
  if (!realpathAdmitted(admission, real, await realAllowedRoots())) return fail("access-denied", "path is outside the allowed roots");

  const workspace = requestWorkspaceScope(req);
  /* A kept copy belongs to the project its picture lay in. */
  const kept = keptPictureProject(requested, abs);
  if (workspace && !workspace.canReadFile(kept === undefined ? projectForCwd(path.dirname(real)) : kept)) return workspaceDenied();
  /* realpath resolved every link above; a link appearing at the final
     component or at any directory above it between then and now is a race,
     refused. A FIFO does not wedge the open — its fstat below rejects it. */
  let handle: fsp.FileHandle;
  try {
    handle = await openAdmitted(real);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return fail("not-found", "file not found");
    if (code === "ELOOP" || code === "EMLINK") return fail("access-denied", "path is outside the allowed roots");
    if (code === "EISDIR") return fail("not-a-file", "not a regular file");
    return fail("access-denied", "file is not readable");
  }

  /* Everything below reads through the pinned descriptor. */
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      await handle.close();
      return fail("not-a-file", "not a regular file");
    }

    const etag = artifactEtag(stat);
    const limits = artifactLimits();
    const download = req.nextUrl.searchParams.get("download") === "1";

    /* Before meta as well: a mismatched file must fail at open time with the
       explicit unsupported state, not after a pane mounted around it. */
    const head = Buffer.alloc(Math.min(SNIFF_BYTES, stat.size));
    if (head.length > 0) await handle.read(head, 0, head.length, 0);
    if (!sniffAgrees(mime, head)) {
      await handle.close();
      return fail("mime-mismatch", "file content does not match its extension");
    }

    if (req.nextUrl.searchParams.get("mode") === "meta") {
      await handle.close();
      /* An HTML report is shown as a browser would show it, in a sandboxed
         frame fed by the frame route; the scope minted here is the only way
         to reach that route, and it covers this report's directory alone. */
      const live = requestSession(req);
      if (/\.html?$/i.test(real) && existingTeamStore()?.hasActiveOwner() && !live)
        return NextResponse.json({ error: "sign in to open a report frame", code: "member_required" }, { status: 401 });
      const frame = /\.html?$/i.test(real) ? frameUrl(mintFrameScope(path.dirname(real), Date.now(), live?.session.id ?? null), path.basename(real)) : undefined;
      return NextResponse.json(
        { name, kind, mime, size: stat.size, mtimeMs: Math.round(stat.mtimeMs), etag, ...(frame ? { frame } : {}) },
        { headers: { "cache-control": "private, no-store" } },
      );
    }

    const ifMatch = req.headers.get("if-match");
    if (ifMatch !== null && ifMatch !== etag) {
      await handle.close();
      return fail("changed", "file changed since the preview opened");
    }

    if (stat.size > limits.maxBytes) {
      await handle.close();
      return fail("too-large", "artifact exceeds the configured byte bound");
    }

    const headers = artifactResponseHeaders(mime, etag, name, download);
    const range = parseByteRange(req.headers.get("range"), stat.size);
    if (range === "unsatisfiable") {
      await handle.close();
      headers.set("content-range", `bytes */${stat.size}`);
      return new NextResponse(null, { status: 416, headers });
    }

    const window = range ?? { start: 0, end: stat.size - 1 };
    const length = stat.size === 0 ? 0 : window.end - window.start + 1;
    headers.set("content-length", String(Math.max(length, 0)));
    if (range) headers.set("content-range", `bytes ${range.start}-${range.end}/${stat.size}`);
    if (length <= 0) {
      await handle.close();
      return new NextResponse(null, { status: range ? 206 : 200, headers });
    }
    const body = streamWindow(handle, window.start, window.end, req.signal, limits.timeBudgetMs);
    return new NextResponse(body, { status: range ? 206 : 200, headers });
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

export const GET = workspaceRoute("/api/artifact", workspaceGET);
