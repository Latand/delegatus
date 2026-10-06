import { NextResponse } from "next/server";

import { NoHealthyClaudeAccountError } from "@/lib/accounts/spawnHealth";
import { AccountMutationBusyError, isAccountAdmissionRetryable } from "@/lib/accounts/accountMutation";

export function spawnAccountErrorResponse(error: unknown): NextResponse<{ error: string; retrySafe: true }> | null {
  if (isAccountAdmissionRetryable(error)) return NextResponse.json({
    error: error.message,
    code: error instanceof AccountMutationBusyError ? "account_store_busy" : "account_admission_changed",
    retrySafe: true,
    retryable: true,
  }, { status: 503 });
  if (!(error instanceof NoHealthyClaudeAccountError)) return null;
  return NextResponse.json({ error: error.message, retrySafe: true }, { status: 503 });
}
