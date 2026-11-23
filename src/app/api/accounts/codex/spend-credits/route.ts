import { NextRequest, NextResponse } from "next/server";
import { directOperatorActivityAuthority } from "@/lib/agent/operatorAuthority";
import { internalServiceClaim } from "@/lib/agent/callerClaims";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { afterAccountMutationAdmission, AccountMutationBusyError } from "@/lib/accounts/accountMutation";
import { setCodexAccountSpendCredits, UnknownAccountError } from "@/lib/accounts/codex";
import { agentRegistry } from "@/lib/agent/registry";
import { kickStructuredDeliveryQueue } from "@/lib/runtime/structuredDeliverySignal";

export const runtime = "nodejs";

export async function PATCH(req: NextRequest) {
  const rejected = rejectCrossOrigin(req); if (rejected) return rejected;
  const authority = directOperatorActivityAuthority(req);
  if (!authority.ok) return NextResponse.json({ error: authority.error }, { status: authority.status });
  if (internalServiceClaim(req).claim === "valid") return NextResponse.json({ error: "only the operator may change paid spending" }, { status: 403 });
  let body: { accountId?: unknown; spendCredits?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (!body || typeof body.accountId !== "string" || typeof body.spendCredits !== "boolean") {
    return NextResponse.json({ error: "accountId and boolean spendCredits are required" }, { status: 400 });
  }
  try {
    const admitted = await afterAccountMutationAdmission(() => {
      const currentAuthority = directOperatorActivityAuthority(req);
      if (!currentAuthority.ok) return currentAuthority;
      setCodexAccountSpendCredits(body.accountId as string, body.spendCredits as boolean);
      return { ok: true as const };
    }, { caller: "Codex paid spending", holder: "Codex account setting" });
    if (!admitted.ok) return NextResponse.json({ error: admitted.error }, { status: admitted.status });
    agentRegistry().invalidateAccountCreditGuard();
    void Promise.resolve(kickStructuredDeliveryQueue()).catch(error => console.error("[paid spending] guard reconciliation deferred", error));
    return NextResponse.json({ accountId: body.accountId, spendCredits: body.spendCredits });
  } catch (error) {
    return NextResponse.json({ error: "could not update paid spending" },
      { status: error instanceof UnknownAccountError ? 404 : error instanceof AccountMutationBusyError ? 503 : 409 });
  }
}
