import { NextRequest, NextResponse } from "next/server";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { ArchiveReadError } from "@/lib/reviewHistory/reader";

const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
export function archiveResponse(request: NextRequest, read: () => unknown, attachment = false): NextResponse {
  const rejected = rejectCrossOrigin(request);
  if (rejected) {
    for (const [key, value] of Object.entries(headers)) rejected.headers.set(key, value);
    return rejected;
  }
  try {
    const result = read();
    if (result === null) return NextResponse.json({ error: "Review history not found" }, { status: 404, headers });
    const body = JSON.stringify(result);
    if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new ArchiveReadError("ARCHIVE_TOO_LARGE", 413);
    return new NextResponse(body, { headers: { ...headers, "Content-Type": "application/json; charset=utf-8", ...(attachment ? { "Content-Disposition": 'attachment; filename="review-history.json"' } : {}) } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof ArchiveReadError ? error.code : "ARCHIVE_UNAVAILABLE" }, { status: error instanceof ArchiveReadError ? error.status : 503, headers });
  }
}
export function archiveId(id: string): string {
  if (!id || id.length > 200 || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new ArchiveReadError("ARCHIVE_UNAVAILABLE", 400);
  return id;
}
