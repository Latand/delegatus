import type { NextRequest } from "next/server";
import { prototypeMediaGET } from "@/lib/prototypeReview/media";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; reviewId: string; mediaId: string }> };
export async function GET(request: NextRequest,context: Context) {
  const { id,reviewId,mediaId } = await context.params;
  return prototypeMediaGET(request,id,reviewId,mediaId,"video");
}
