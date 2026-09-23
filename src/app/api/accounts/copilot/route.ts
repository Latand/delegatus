import { NextRequest, NextResponse } from "next/server";

import { copilotBinaryGap, resolveCopilotBinary } from "@/lib/agent/cli";
import {
  activeCopilotAccountId,
  copilotLoginCommand,
  createManagedCopilotAccount,
  listCopilotAccounts,
  copilotSignedInUser,
  setActiveCopilotAccount,
  UnknownCopilotAccountError,
} from "@/lib/accounts/copilot";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { accountManager } from "@/lib/accounts/manager";
import { copilotLoginSupervisor } from "@/lib/accounts/copilotLogin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GitHub Copilot accounts (docs/design/copilot-engine.md 3.9, slice 1).
 *
 * A managed account is its own `COPILOT_HOME`; the device-code operation is
 * supervised here while the credential remains in the system keyring.
 */
function copilotAccountsBody() {
  const active = activeCopilotAccountId();
  const gap = copilotBinaryGap();
  const binary = gap ? "copilot" : resolveCopilotBinary();
  return {
    cli: { present: gap === null, reason: gap },
    active: active ?? "",
    accounts: listCopilotAccounts().map((account) => ({
      id: account.id,
      label: account.label,
      kind: account.kind,
      active: account.id === active,
      auth: account.auth,
      "user": copilotSignedInUser(account.home)?.login ?? null,
      loginCommand: account.kind === "managed" ? copilotLoginCommand(account.home, binary) : null,
      login: copilotLoginSupervisor.forAccount(account.id),
    })),
  };
}

export async function GET() {
  return NextResponse.json(copilotAccountsBody());
}

export async function POST(req: NextRequest) {
  const rejected = rejectCrossOrigin(req);
  if (rejected) return rejected;
  let body: { label?: unknown; id?: unknown; action?: unknown; operationId?: unknown };
  try { body = await req.json() as typeof body; } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  try {
    if (body.action === "login") {
      if (typeof body.id !== "string") return NextResponse.json({ error: "id must be a string" }, { status: 400 });
      copilotLoginSupervisor.start(body.id);
      return NextResponse.json(copilotAccountsBody());
    }
    if (body.action === "cancel-login") {
      if (typeof body.operationId !== "string") return NextResponse.json({ error: "operationId must be a string" }, { status: 400 });
      await accountManager.cancelLogin(body.operationId);
      return NextResponse.json(copilotAccountsBody());
    }
    if (body.action === "select") {
      if (typeof body.id !== "string") return NextResponse.json({ error: "id must be a string" }, { status: 400 });
      setActiveCopilotAccount(body.id);
      return NextResponse.json(copilotAccountsBody());
    }
    if (typeof body.label !== "string") return NextResponse.json({ error: "label must be a string" }, { status: 400 });
    const account = createManagedCopilotAccount(body.label);
    return NextResponse.json({ ...copilotAccountsBody(), created: account.id });
  } catch (error) {
    const status = error instanceof UnknownCopilotAccountError ? 404 : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "could not change Copilot accounts" }, { status });
  }
}
