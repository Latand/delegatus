import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { taskAlbumSummaries, type AlbumSummary } from "@/lib/taskAlbum/album";
import { productionAlbumDeps } from "@/lib/taskAlbum/world";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Tasks one summary answers for; the board asks for the cards it draws. */
const MAX_TASKS = 400;

/**
 * How many pictures each task's album holds and how many are new since the
 * operator last opened it, for the album button on the task cards. `ids` is a
 * comma-separated list of task ids. Indexing shares one byte budget across
 * the tasks, so a cold board fills in over a few reads.
 */
export async function GET(req: NextRequest): Promise<NextResponse<{ tasks: Record<string, AlbumSummary> } | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  const ids = [...new Set((req.nextUrl.searchParams.get("ids") ?? "").split(",").map((id) => id.trim()).filter(Boolean))].slice(0, MAX_TASKS);
  const deps = productionAlbumDeps();
  const known = ids.filter((id) => deps.world.task(id));
  const tasks = await taskAlbumSummaries(known, deps);
  return NextResponse.json({ tasks }, { headers: { "cache-control": "private, no-store" } });
}
