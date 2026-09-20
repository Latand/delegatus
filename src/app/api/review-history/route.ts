import type { NextRequest } from "next/server";
import { listReviewHistory } from "@/lib/reviewHistory/boardSelection";
import { ArchiveReadError } from "@/lib/reviewHistory/reader";
import { archiveId, archiveResponse } from "./http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return archiveResponse(request, () => {
    const params = request.nextUrl.searchParams;
    const project = params.get("project")?.trim();
    if (!project || project.length > 256) throw new ArchiveReadError("ARCHIVE_UNAVAILABLE", 400);
    const ids = [...new Set(params.getAll("ids").flatMap(value => value.split(",")).filter(Boolean))];
    if (ids.length > 100) throw new ArchiveReadError("ARCHIVE_TOO_LARGE", 400);
    ids.forEach(archiveId);
    const cursor = params.get("cursor");
    if (cursor && cursor.length > 2048) throw new ArchiveReadError("ARCHIVE_TOO_LARGE", 400);
    const limit = Number(params.get("limit") ?? 25);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ArchiveReadError("ARCHIVE_TOO_LARGE", 400);
    return { archive: true, ...listReviewHistory({ project, ids, query: "", updatedSince: "", includeClosed: true }, cursor, limit) };
  });
}
