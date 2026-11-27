import type { NextRequest } from "next/server";
import { secretOperatorPOST } from "@/lib/secretRequests/operatorHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return secretOperatorPOST(request, params, "decline");
}
