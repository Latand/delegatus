import { NextRequest, NextResponse } from "next/server";

import { copilotBinaryGap, resolveCopilotBinary } from "@/lib/agent/cli";
import {
  activeCopilotAccountId,
  copilotLoginCommand,
  createManagedCopilotAccount,
  listCopilotAccounts,
  copilotLegacyAccountHidden,
  copilotSignedInUser,
  removeCopilotAccount,
  restoreLegacyCopilotAccount,
  setActiveCopilotAccount,
  UnknownCopilotAccountError,
} from "@/lib/accounts/copilot";
import { AccountMutationBusyError, ACCOUNT_STORE_BUSY_MESSAGE, withAccountMutationLockAsync } from "@/lib/accounts/accountMutation";
import { AccountRemovalBlockedError, accountRemovalBlockers, accountRemovalLiveWork } from "@/lib/accounts/removal";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { COPILOT_LOGIN_PHASES, copilotLoginSupervisor } from "@/lib/accounts/copilotLogin";

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
      "user": copilotSignedInUser(account.home),
      loginCommand: account.kind === "managed" ? copilotLoginCommand(account.home, binary) : null,
      login: copilotLoginSupervisor.forAccount(account.id),
    })),
    /* The default home the operator removed: offered back in account setup. */
    hidden: copilotLegacyAccountHidden() ? [{ id: "default", label: "Default" }] : [],
  };
}

export async function GET() {
  return NextResponse.json(copilotAccountsBody());
}

export async function POST(req: NextRequest) {
  const rejected = rejectCrossOrigin(req);
  if (rejected) return rejected;
  let body: { label?: unknown; id?: unknown; action?: unknown; operationId?: unknown; acceptPlaintext?: unknown };
  try { body = await req.json() as typeof body; } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  try {
    if (body.action === "login") {
      if (typeof body.id !== "string") return NextResponse.json({ error: "id must be a string" }, { status: 400 });
      copilotLoginSupervisor.start(body.id);
      return NextResponse.json(copilotAccountsBody());
    }
    if (body.action === "cancel-login") {
      if (typeof body.operationId !== "string") return NextResponse.json({ error: "operationId must be a string" }, { status: 400 });
      if (!copilotLoginSupervisor.has(body.operationId)) return NextResponse.json({ error: "Copilot login operation was not found" }, { status: 404 });
      copilotLoginSupervisor.cancel(body.operationId);
      return NextResponse.json(copilotAccountsBody());
    }
    if (body.action === "choose-plaintext-storage") {
      if (typeof body.operationId !== "string" || typeof body.acceptPlaintext !== "boolean") {
        return NextResponse.json({ error: "operationId and acceptPlaintext are required" }, { status: 400 });
      }
      if (!copilotLoginSupervisor.has(body.operationId)) return NextResponse.json({ error: "Copilot login operation was not found" }, { status: 404 });
      copilotLoginSupervisor.choosePlaintextStorage(body.operationId, body.acceptPlaintext);
      return NextResponse.json(copilotAccountsBody());
    }
    /* The default home comes back after its removal (it was only hidden;
       nothing in it was touched). */
    if (body.action === "restore") {
      if (body.id !== "default") return NextResponse.json({ error: "only Default can be restored", code: "invalid_request" }, { status: 400 });
      await withAccountMutationLockAsync(() => restoreLegacyCopilotAccount(), { caller: "Copilot Default restore", holder: "Copilot catalog restore" });
      return NextResponse.json({ ...copilotAccountsBody(), restored: { id: "default" } });
    }
    if (body.action === "select") {
      if (typeof body.id !== "string") return NextResponse.json({ error: "id must be a string" }, { status: 400 });
      await withAccountMutationLockAsync(() => setActiveCopilotAccount(body.id as string), { caller: "Copilot account select", holder: "Copilot catalog select" });
      return NextResponse.json(copilotAccountsBody());
    }
    if (typeof body.label !== "string") return NextResponse.json({ error: "label must be a string" }, { status: 400 });
    const account = await withAccountMutationLockAsync(() => createManagedCopilotAccount(body.label as string), { caller: "Copilot account create", holder: "Copilot catalog create" });
    return NextResponse.json({ ...copilotAccountsBody(), created: account.id });
  } catch (error) {
    if (error instanceof AccountMutationBusyError) return NextResponse.json({ error: ACCOUNT_STORE_BUSY_MESSAGE, code: "account_store_busy" }, { status: 503 });
    const status = error instanceof UnknownCopilotAccountError ? 404 : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "could not change Copilot accounts" }, { status });
  }
}

/**
 * Removes a Copilot account (the one remove control every engine shares). A
 * managed home keeps its transcripts where they are; the default home is only
 * hidden. Live work or an open sign-in refuses with what to end first.
 */
export async function DELETE(req: NextRequest) {
  const rejected = rejectCrossOrigin(req);
  if (rejected) return rejected;
  let body: { id?: unknown };
  try { body = await req.json() as typeof body; } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (typeof body?.id !== "string") return NextResponse.json({ error: "account id is invalid", code: "invalid_request" }, { status: 400 });
  const id = body.id;
  try {
    return await withAccountMutationLockAsync(() => {
      const account = listCopilotAccounts().find((candidate) => candidate.id === id);
      if (!account) return NextResponse.json({ error: "Copilot account is unavailable", code: "unknown_account" }, { status: 404 });
      const login = copilotLoginSupervisor.forAccount(account.id);
      const blockers = [
        ...accountRemovalBlockers("copilot", account.id),
        ...(login && COPILOT_LOGIN_PHASES.has(login.phase) ? ["login_pending"] : []),
      ];
      const refusal = (found: string[]) => NextResponse.json({
        error: "Copilot account has active sessions, conversations, or sign-in", code: "account_removal_blocked", blockers: found, ...accountRemovalLiveWork("copilot", account.id),
      }, { status: 409 });
      if (blockers.length > 0) return refusal(blockers);
      try {
        const removal = removeCopilotAccount(account.id);
        return NextResponse.json({
          ...copilotAccountsBody(),
          removed: { id: account.id },
          ...(removal.hidden ? { hidden: { home: removal.home } } : {}),
          cleanupPending: removal.cleanupPending,
          pinsCleared: removal.pinsCleared,
          deliveriesDropped: removal.deliveriesDropped,
        });
      } catch (error) {
        if (error instanceof AccountRemovalBlockedError) return refusal(error.blockers);
        if (error instanceof UnknownCopilotAccountError) return NextResponse.json({ error: "Copilot account is unavailable", code: "unknown_account" }, { status: 404 });
        return NextResponse.json({ error: "Copilot account could not be removed", code: "removal_failed" }, { status: 500 });
      }
    }, { caller: "Copilot account remove", holder: "Copilot catalog remove" });
  } catch (error) {
    if (error instanceof AccountMutationBusyError) return NextResponse.json({ error: ACCOUNT_STORE_BUSY_MESSAGE, code: "account_store_busy" }, { status: 503 });
    return NextResponse.json({ error: "Copilot account could not be removed", code: "removal_failed" }, { status: 500 });
  }
}
