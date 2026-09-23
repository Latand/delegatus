import { NextResponse } from "next/server";

import { readLimits } from "@/lib/limits";
import type { LimitsPayload } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Claude Code, Codex and Copilot plan rate limits: GET /api/limits */
export async function GET(): Promise<NextResponse<LimitsPayload>> {
  return NextResponse.json(await readLimits());
}
