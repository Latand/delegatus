/** A launch can wait through a deployment without restarting its budget. */
export const DEPLOY_ADMISSION_BUDGET_MS = 10 * 60_000;

/** Admission waiting precedes the host's separate durable setup window. */
export function structuredSetupStartedAt(receipt: { createdAt: string; hostSetupStartedAt?: string }): number {
  return Date.parse(receipt.hostSetupStartedAt ?? receipt.createdAt);
}
