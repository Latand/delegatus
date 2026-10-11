import { knownRelay } from "./knownRelays";
import type { PairedRelay } from "./store";

type SelectableRelay = Pick<PairedRelay, "id" | "origin" | "owner" | "paused" | "targets">;
export type OwnerDestinationReason = "no_relay" | "paused" | "no_target" | "invalid_owner" | "not_configured";

/** The operator chose the first enabled Celestia target, preferring owner tier.
 * Array order is the relay store's order, including ties across pairings. */
export function selectOwnerDestination<T extends SelectableRelay>(relays: readonly T[],
  origin = knownRelay("celestia")!.origin): { relay: T; targetId: string; chatId: string; reason?: never }
    | { reason: OwnerDestinationReason; relay?: never; targetId?: never; chatId?: never } {
  const paired = relays.filter(r => r.origin === origin);
  if (!paired.length) return { reason: "no_relay" };
  const active = paired.filter(r => !r.paused);
  if (!active.length) return { reason: "paused" };
  const candidates = active.flatMap(relay => relay.targets
    .filter(t => t.enabled && t.answered_by === "install")
    .map(target => ({ relay, target })));
  const selected = candidates.find(c => c.target.ownerTier === true) ?? candidates[0];
  if (!selected) return { reason: "no_target" };
  const { relay, target } = selected;
  const id = relay.owner.id;
  if (relay.owner.namespace !== "telegram" || !/^[1-9]\d*$/.test(id)
    || !Number.isSafeInteger(Number(id))) return { reason: "invalid_owner" };
  // An unconfigured target is absent from the relay claim. Keep the operator's
  // first-target selection, but do not post a review whose reply cannot arrive.
  if (!target.engine || !target.model) return { reason: "not_configured" };
  return { relay, targetId: target.id, chatId: id };
}
