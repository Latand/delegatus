import { NextResponse } from "next/server";

import { cliInstalls, cliReports } from "@/lib/accounts/engineConnection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The setup guide's "Check again" (#1876): re-probes each program's command,
    bypassing the one-minute cache `GET /api/accounts` answers from. `cliInstalls`
    is what the same runs learned: where each command was found and its version. */
export async function GET(): Promise<NextResponse> {
  const reports = await cliReports({ fresh: true });
  return NextResponse.json({ claude: reports.claude.presence, codex: reports.codex.presence, antigravity: reports.antigravity.presence, cliInstalls: cliInstalls(reports) });
}
