import { NextRequest, NextResponse } from "next/server";

import { claudeLoginSupervisor } from "@/lib/accounts/claudeLogin";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ operationId: string }> }) {
  const rejected = rejectCrossOrigin(req); if (rejected) return rejected;
  try {
    const { operationId } = await ctx.params;
    // The supervisor persists its canceling transition under its own short
    // account lease and checks process identity before each termination signal.
    return NextResponse.json({ login: await claudeLoginSupervisor.cancel(operationId) });
  }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "could not cancel login" }, { status: 404 }); }
}
