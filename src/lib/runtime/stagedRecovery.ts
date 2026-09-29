/** Durable post-stage recovery evidence lives on the original receipt. Keeping
 * it in the existing error envelope also preserves it across older readers. */
export const STAGED_RECOVERY_PREFIX = "structured launch recovery: ";

export interface StagedLaunchRecovery {
  phase: "unpublished" | "uncertain" | "delivered";
  startedAt: number;
  checks: number;
  nextTryAt: number;
  reason: string;
  stopped?: boolean;
}

export function stagedLaunchRecovery(receipt: { error?: string | null } | null | undefined): StagedLaunchRecovery | null {
  if (!receipt?.error?.startsWith(STAGED_RECOVERY_PREFIX)) return null;
  try {
    const value = JSON.parse(receipt.error.slice(STAGED_RECOVERY_PREFIX.length)) as StagedLaunchRecovery;
    return ["unpublished", "uncertain", "delivered"].includes(value.phase)
      && Number.isFinite(value.startedAt) && Number.isFinite(value.nextTryAt)
      && Number.isSafeInteger(value.checks) && value.checks >= 0 && typeof value.reason === "string" ? value : null;
  } catch { return null; }
}
