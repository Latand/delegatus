import { NextRequest, NextResponse } from "next/server";

import { copilotBinaryGap, resolveCopilotBinary } from "@/lib/agent/cli";
import {
  activeCopilotAccountId,
  copilotLoginCommand,
  createManagedCopilotAccount,
  listCopilotAccounts,
  setActiveCopilotAccount,
  UnknownCopilotAccountError,
} from "@/lib/accounts/copilot";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GitHub Copilot accounts (docs/design/copilot-engine.md 3.9, slice 1).
 *
 * A managed account is its own `COPILOT_HOME`; signing it in is the operator's
 * step in a terminal, with the command this answers. The credential itself is
 * never read here, so the auth state stays `unknown` until a launch succeeds or
 * fails on it.
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
      auth: "unknown" as const,
      loginCommand: account.kind === "managed" ? copilotLoginCommand(account.home, binary) : null,
    })),
  };
}

export async function GET() {
  return NextResponse.json(copilotAccountsBody());
}

export async function POST(req: NextRequest) {
  const rejected = rejectCrossOrigin(req);
  if (rejected) return rejected;
  let body: { label?: unknown; id?: unknown; action?: unknown };
  try { body = await req.json() as typeof body; } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  try {
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
