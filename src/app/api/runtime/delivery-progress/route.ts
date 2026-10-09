import { NextResponse } from "next/server";

import { deliveryProgressView } from "@/lib/runtime/deliveryProgressView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What each held message in these conversations is waiting on (incident
    2026-10-06). Ids, codes and times only; message text never leaves here. */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const conversationIds = url.searchParams.getAll("conversationId").filter((id) => id && id.length <= 256).slice(0, 16);
  const operationIds = url.searchParams.getAll("operationId").filter((id) => id && id.length <= 256).slice(0, 64);
  if (conversationIds.length === 0 && operationIds.length === 0) {
    return NextResponse.json({ error: "conversationId or operationId is required" }, { status: 400 });
  }
  return NextResponse.json(deliveryProgressView({ conversationIds, operationIds }), {
    headers: { "cache-control": "no-store" },
  });
}
