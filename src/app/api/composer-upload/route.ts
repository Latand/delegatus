import type { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { teamActor } from "@/lib/team";
import { ComposerUploadError, composerUploadOwner, receiveComposerUpload } from "@/lib/composerUploads";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Like /api/streams, this route runs the real perimeter itself: Next's proxy
// body clone would otherwise buffer the entire upload before the first write.
export async function POST(request: NextRequest): Promise<Response> {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return rejected;
  const gate = proxy(request);
  if (gate.headers.get("x-middleware-next") !== "1") return gate;
  try {
    const owner = composerUploadOwner(teamActor(request));
    if (!request.body) throw new ComposerUploadError("attachment is empty");
    const length = request.headers.get("content-length");
    const upload = await withViewerOperation("composer.upload", () => receiveComposerUpload(request.body!, owner, {
      ...(length !== null ? { expectedBytes: Number(length) } : {}),
      signal: request.signal,
      authorize() {
        const answer = proxy(request);
        if (answer.headers.get("x-middleware-next") !== "1" || composerUploadOwner(teamActor(request)) !== owner) {
          throw new ComposerUploadError("attachment upload authorization changed; attach the file again", 403);
        }
      },
    }));
    return Response.json({ upload }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof ComposerUploadError ? error.message : "attachment upload failed; try attaching the file again" }, {
      status: error instanceof ComposerUploadError ? error.status : request.signal.aborted ? 408 : 500,
    });
  }
}
