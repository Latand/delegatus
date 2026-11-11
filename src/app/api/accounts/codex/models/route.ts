import { NextRequest, NextResponse } from "next/server";
import { activeCodexAccountId, listCodexAccounts } from "@/lib/accounts/codex";
import { codexServiceTierCatalog } from "@/lib/accounts/codexServiceTiers";
import { allowedAccountIdsForProject } from "@/lib/accounts/projectBindings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const named = request.nextUrl.searchParams.get("account")?.trim();
  const project = request.nextUrl.searchParams.get("project")?.trim();
  const allowed = project ? allowedAccountIdsForProject(project, "codex") : null;
  const requested = named || (project ? null : activeCodexAccountId());
  const accounts = listCodexAccounts().filter(account => (!requested || account.id === requested)
    && (allowed === null || allowed.includes(account.id)));
  if (requested && !accounts.length) return NextResponse.json({ error: "Codex account was not found in the requested pool" }, { status: 404 });
  return NextResponse.json({ accounts: accounts.map(account => ({ id: account.id, label: account.label,
    models: codexServiceTierCatalog(account.home) })) });
}
