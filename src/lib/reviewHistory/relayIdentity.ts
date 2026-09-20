import crypto from "node:crypto";

import type { Flow, Round } from "@/lib/flows/types";

/** The durable structured-delivery identity of a round's relay — the current
    round's by default, or any settled round's when given, so provenance can
    name the reservation each round's relay settled under (#1117). Exported so
    a test can address the exact reservation the delivery journal settles. */
export function relayClientMessageId(flow: Flow, round: Round | undefined = flow.rounds?.at(-1)): string {
  const deliveryAttempt = round?.relayDeliveryAttempt ?? 0;
  const identity = `${flow.id}:${round?.n ?? "legacy"}:${round?.reviewerBindingId ?? "legacy"}`
    + (deliveryAttempt > 0 ? `:retry:${deliveryAttempt}` : "");
  return `flow_relay_${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}
