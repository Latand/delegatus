import { NextResponse } from "next/server";

import { readAccountBurndown, readBurndown } from "@/lib/limits";
import type { BurndownPayload } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ACCOUNT_ID = 200;

/** Burndown history for the quota chart.
    GET /api/limits/history                       the active account of each engine
    GET /api/limits/history?engine=&account=      any listed account of one engine */
export async function GET(request: Request): Promise<NextResponse<BurndownPayload | { error: string }>> {
  const params = new URL(request.url).searchParams;
  const engine = params.get("engine");
  const account = params.get("account");
  if (engine === null && account === null) return NextResponse.json(await readBurndown());
  if (engine !== "claude" && engine !== "codex") return NextResponse.json({ error: "engine must be claude or codex" }, { status: 400 });
  if (!account || account.length > MAX_ACCOUNT_ID) return NextResponse.json({ error: "account is required" }, { status: 400 });
  const payload = await readAccountBurndown(engine, account);
  if (!payload) return NextResponse.json({ error: "unknown account" }, { status: 404 });
  return NextResponse.json(payload);
}
