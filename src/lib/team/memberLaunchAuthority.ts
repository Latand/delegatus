import type { SpawnReceipt } from "@/lib/agent/registry";
import { existingTeamStore, type TeamStore } from "./store";

export const MEMBER_REVOCATION_HOLD = "member access revoked; launch held — start a new launch after access is restored";

/** The tombstone survives restoration. Old queued work never regains authority. */
export function assertMemberLaunchAllowed(receipt: Pick<SpawnReceipt, "launchProfile" | "createdAt">, store?: TeamStore | null): void {
  const memberId = receipt.launchProfile.workspace?.memberId;
  if (!memberId || receipt.launchProfile.workspace?.fromMessage) return;
  const authority = store === undefined ? existingTeamStore() : store;
  const member = authority?.member(memberId);
  const cutoff = authority?.latestMemberRevocation(memberId);
  if (!member || member.status !== "active" || (cutoff && receipt.createdAt <= cutoff)) throw new Error(MEMBER_REVOCATION_HOLD);
}
