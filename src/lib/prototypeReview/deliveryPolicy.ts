import type { PrototypeDecision } from "./types";

export const PROTOTYPE_DELIVERY_MAX_ATTEMPTS = 10;
export const PROTOTYPE_DELIVERY_MAX_AGE_MS = 30 * 60_000;

/** Persisted counters and timestamps survive both worker and Viewer restarts. */
export function prototypeDeliveryExhausted(decision: PrototypeDecision, now: number): boolean {
  const delivery = decision.delivery;
  return delivery.state !== "sent" && (!!delivery.exhaustedAt
    || (delivery.attempts ?? 0) >= PROTOTYPE_DELIVERY_MAX_ATTEMPTS
    || (delivery.failures ?? 0) >= PROTOTYPE_DELIVERY_MAX_ATTEMPTS
    || now - Date.parse(delivery.startedAt ?? delivery.dispatchedAt ?? decision.at) >= PROTOTYPE_DELIVERY_MAX_AGE_MS);
}
