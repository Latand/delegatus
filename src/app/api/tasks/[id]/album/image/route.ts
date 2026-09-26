import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { readTaskAlbumImage } from "@/lib/taskAlbum/album";
import { productionAlbumDeps } from "@/lib/taskAlbum/world";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TaskRouteContext = {
  params: Promise<{ id: string }>;
};

/**
 * The bytes of a picture a task's transcript carries inline (a pasted
 * screenshot, a Read whose file is gone), by the id the task's album gave it.
 * Only a picture that album indexed can be named, so this route reads no
 * transcript line the album did not already point at.
 */
export async function GET(req: NextRequest, context: TaskRouteContext): Promise<NextResponse<ApiError> | NextResponse> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  const { id } = await context.params;
  const imageId = req.nextUrl.searchParams.get("id") ?? "";
  if (!/^[0-9a-f]{20}$/.test(imageId)) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const deps = productionAlbumDeps();
  if (!deps.world.task(id)) return NextResponse.json({ error: "task not found" }, { status: 404 });
  const image = await readTaskAlbumImage(id, imageId, deps);
  if (!image) return NextResponse.json({ error: "image not found" }, { status: 404 });
  return new NextResponse(new Uint8Array(image.data), {
    headers: {
      "content-type": image.media,
      "content-length": String(image.data.length),
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
    },
  });
}
