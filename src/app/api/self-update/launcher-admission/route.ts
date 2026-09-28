import { NextResponse, type NextRequest } from "next/server";
import { selfUpdateService } from "@/lib/selfUpdate/instance";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = request.nextUrl.searchParams.get("requestId") ?? "";
  const gateId = request.nextUrl.searchParams.get("gateId") ?? "";
  if (!/^[a-f0-9-]{36}$/i.test(requestId) || !/^[a-f0-9-]{36}$/i.test(gateId)) {
    return NextResponse.json({ admitted: false }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  const admitted = await selfUpdateService().admitAutoRestart(requestId, gateId);
  return NextResponse.json({ admitted }, { status: admitted ? 200 : 409, headers: { "cache-control": "no-store" } });
}
