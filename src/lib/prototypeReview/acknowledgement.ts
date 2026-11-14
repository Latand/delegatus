import type { DismissedBy } from "@/lib/attention/dismissalTypes";
import { withFileTransaction } from "@/lib/state/fileTransaction";
import { PrototypeError } from "./input";
import { decisionLock, mutatePrototypeRound, withPrototypeState } from "./store";
import type { PrototypeReviewRound } from "./types";

export class PrototypeAcknowledgementError extends PrototypeError {
  constructor(readonly code: string, message: string) { super(message, 409); }
}

/** Shares the sender's lock: a delivery already in flight settles before this
 * write, and every later worker sees the acknowledgement before dispatch. */
export async function acknowledgePrototypeDelivery(taskId: string | null, reviewId: string, evidence: string, expectedMessageId: string | undefined,
  authorize: (round: PrototypeReviewRound) => DismissedBy) {
  return withFileTransaction(decisionLock(reviewId), "prototype decision is busy", () => withPrototypeState(() =>
    mutatePrototypeRound(taskId, reviewId, round => {
      const by = authorize(round);
      const delivery = round.decision?.delivery;
      if (!delivery) throw new PrototypeAcknowledgementError("ROUND_UNDECIDED", "answer this round before acknowledging its delivery");
      if (delivery.clientMessageId !== expectedMessageId)
        throw new PrototypeAcknowledgementError("DECISION_CHANGED", "this answer changed while acknowledgement waited; read the current round and verify its evidence");
      if (delivery.state === "sent") throw new PrototypeAcknowledgementError("DELIVERY_ALREADY_SENT", "this answer was already delivered successfully");
      if (delivery.acknowledgement) {
        if (delivery.acknowledgement.evidence !== evidence)
          throw new PrototypeAcknowledgementError("ACKNOWLEDGEMENT_CONFLICT", "this answer already has different acknowledgement evidence");
        return { acknowledgement: delivery.acknowledgement, replay: true };
      }
      if (delivery.state === "pending") throw new PrototypeAcknowledgementError("DELIVERY_IN_PROGRESS", "pending delivery must settle before it can be acknowledged");
      delivery.state = "acknowledged";
      delivery.acknowledgement = { at: new Date().toISOString(), by, evidence };
      return { acknowledgement: delivery.acknowledgement, replay: false };
    })));
}
