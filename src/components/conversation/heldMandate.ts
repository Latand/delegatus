import type { MandateDelivery } from "@/lib/runtime/messageOrigin";

/**
 * A seat's mandate card across the adoption of its live conversation.
 *
 * The server strips `prompt` and `mandate` from the launch facts when the live
 * conversation is adopted, a poll before the transcript's own record of the
 * mandate has rendered, and a surface that re-resolves the conversation at that
 * moment (the phone's focus view) mounts a new feed that never saw them. The
 * last pair a feed rendered is therefore kept here by launch id, outside any
 * one mount, so the card stays the seat's first message until the transcript's
 * record takes its place.
 */
export interface HeldMandate {
  launchId: string;
  text: string;
  ts: number | undefined;
  mandate: MandateDelivery;
}

const KEEP = 32;
const held = new Map<string, HeldMandate>();

export function holdMandate(card: HeldMandate): void {
  held.delete(card.launchId);
  held.set(card.launchId, card);
  for (const oldest of held.keys()) {
    if (held.size <= KEEP) break;
    held.delete(oldest);
  }
}

export function heldMandateFor(launchId: string | null | undefined): HeldMandate | null {
  return launchId ? held.get(launchId) ?? null : null;
}

export function resetHeldMandatesForTests(): void {
  held.clear();
}
