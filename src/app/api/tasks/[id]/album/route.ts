import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { clampAlbumLimit, readTaskAlbum, type AlbumPage } from "@/lib/taskAlbum/album";
import { productionAlbumDeps } from "@/lib/taskAlbum/world";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TaskRouteContext = {
  params: Promise<{ id: string }>;
};

/**
 * A task's album: every picture its agents looked at, were handed or
 * named, newest first, one page at a time. `cursor` continues the previous
 * page; `limit` is clamped. The answer carries when the operator last opened
 * the album, so the pictures new since then can be marked.
 */
export async function GET(req: NextRequest, context: TaskRouteContext): Promise<NextResponse<AlbumPage | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  const { id } = await context.params;
  const deps = productionAlbumDeps();
  if (!deps.world.task(id)) return NextResponse.json({ error: "task not found" }, { status: 404 });
  const page = await readTaskAlbum(id, {
    cursor: req.nextUrl.searchParams.get("cursor"),
    limit: clampAlbumLimit(req.nextUrl.searchParams.get("limit") ?? undefined),
  }, deps);
  return NextResponse.json(page, { headers: { "cache-control": "private, no-store" } });
}

/** The operator opened the album: everything in it up to now is seen. */
export async function POST(req: NextRequest, context: TaskRouteContext): Promise<NextResponse<{ ok: true; lastOpenedAt: number } | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  const { id } = await context.params;
  const deps = productionAlbumDeps();
  if (!deps.world.task(id)) return NextResponse.json({ error: "task not found" }, { status: 404 });
  const lastOpenedAt = deps.seen.markOpened(id, Date.now());
  return NextResponse.json({ ok: true, lastOpenedAt });
}
