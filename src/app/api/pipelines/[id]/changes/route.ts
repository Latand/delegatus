import type { NextRequest, NextResponse } from "next/server";

import { laneChangesGET } from "@/lib/laneReview/http";
import { laneReviewDependencies } from "@/lib/laneReview/dependencies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A lane's changed files over a pinned base/head, or one file's diff
    (docs/design/lane-diff-comments.md §1). The operator's only. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await ctx.params;
  return laneChangesGET(req, id, laneReviewDependencies);
}
