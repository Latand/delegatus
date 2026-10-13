import type { RelayRequestDeadline } from "./deadline";
export type RelayHoldCause = "drain" | "capacity" | "chat";
type Hold = { requestId: string; relayId: string; targetId: string; cause: RelayHoldCause;
  deadline: RelayRequestDeadline; release(): Promise<unknown> };
const globalHolds = globalThis as typeof globalThis & { __llvRelayHolds?: { rows: Map<string, Hold>; releasing: boolean } };
const registry = globalHolds.__llvRelayHolds ??= { rows: new Map(), releasing: false };
export function enterRelayHold(hold: Hold): void { registry.rows.set(hold.requestId, hold); }
export function leaveRelayHold(requestId: string): void { registry.rows.delete(requestId); }
export const releasingRelayHolds = () => registry.releasing;
export function capacityWaiters(relayId: string, targetId: string): number {
  return [...registry.rows.values()].filter(h => h.relayId === relayId && h.targetId === targetId && h.cause === "capacity").length;
}
export function olderCapacityWaiter(relayId: string, targetId: string, requestId: string, deadline: RelayRequestDeadline): boolean {
  for (const h of registry.rows.values()) {
    if (h.requestId === requestId) break;
    if (h.relayId === relayId && h.targetId === targetId && h.cause === "capacity" &&
      h.deadline.at <= deadline.at) return true;
  }
  return [...registry.rows.values()].some(h => h.requestId !== requestId && h.relayId === relayId && h.targetId === targetId && h.cause === "capacity" && h.deadline.at < deadline.at);
}
/** Demotion wakes all held gates, each of which sends one completion attempt. */
export async function declineHeldRelayRequests(timeoutMs = 5000): Promise<void> {
  registry.releasing = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled([...registry.rows.values()].map(h => h.release())),
    new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}
