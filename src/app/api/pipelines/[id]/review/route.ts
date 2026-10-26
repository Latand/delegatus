import type { NextRequest, NextResponse } from "next/server";

import { laneReviewPOST } from "@/lib/laneReview/http";
import { laneReviewDependencies } from "@/lib/laneReview/dependencies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sends the operator's line comments on a lane's changes to the lane's writer
    as one message (docs/design/lane-diff-comments.md §5). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await ctx.params;
  return laneReviewPOST(req, id, laneReviewDependencies);
}
