import type { NextRequest } from "next/server";
import { readReviewHistory } from "@/lib/reviewHistory/detail";
import { archiveId, archiveResponse } from "../../http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return archiveResponse(request, () => readReviewHistory(archiveId(id), true), true);
}
