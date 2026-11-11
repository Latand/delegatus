import type { SpawnReceipt } from "@/lib/agent/registry";
import { existingTeamStore, type TeamStore } from "./store";

export const MEMBER_REVOCATION_HOLD = "member access revoked; launch held — start a new launch after access is restored";

/** The tombstone survives restoration. Old queued work never regains authority. */
export function assertMemberLaunchAllowed(receipt: Pick<SpawnReceipt, "launchProfile" | "memberRevocationId">, store?: TeamStore | null): void {
  const memberId = receipt.launchProfile.workspace?.memberId;
  if (!memberId || receipt.launchProfile.workspace?.fromMessage) return;
  const authority = store === undefined ? existingTeamStore() : store;
  const member = authority?.member(memberId);
  const revocation = authority?.latestMemberRevocation(memberId) ?? null;
  if (!member || member.status !== "active" || (receipt.memberRevocationId ?? null) !== revocation) throw new Error(MEMBER_REVOCATION_HOLD);
}

/** Captured by the receipt writer, never copied from a submitted profile. */
export function memberLaunchRevocationId(memberId: string): string | null {
  return existingTeamStore()?.latestMemberRevocation(memberId) ?? null;
}
