import { NextResponse } from "next/server";

import { engineCliPresence } from "@/lib/accounts/engineConnection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The setup guide's "Check again" (#1876): re-probes both engines' commands,
    bypassing the one-minute cache `GET /api/accounts` answers from. */
export async function GET(): Promise<NextResponse> {
  const [claude, codex] = await Promise.all([engineCliPresence("claude", { fresh: true }), engineCliPresence("codex", { fresh: true })]);
  return NextResponse.json({ claude, codex });
}
