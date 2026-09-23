import { NextRequest, NextResponse } from "next/server";

import { copilotModelCatalog } from "@/lib/agent/copilotModels";
import { activeCopilotAccountId, listCopilotAccounts } from "@/lib/accounts/copilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const requested = request.nextUrl.searchParams.get("account")?.trim() || activeCopilotAccountId();
  const account = listCopilotAccounts().find((candidate) => candidate.id === requested);
  if (!account) return NextResponse.json({ error: "Copilot account was not found" }, { status: 404 });
  return NextResponse.json(copilotModelCatalog(account.id, account.sessionStateDir));
}
