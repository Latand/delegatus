import type { SessionKey } from "@/lib/agent/sessionKey";

/** Recovery may report its own verified dead-host cleanup under the operation
 * lock. The caller accepts that exact transition before fencing admission again. */
export type DeliveryAdmissionGuard = (reconciledDeadHost?: SessionKey) => void;

export interface DeliveryAdmissionRefusalDetails {
  status: 409 | 503;
  error: string;
  successorConversationId?: string;
  project?: string;
  revokedAt?: string;
  revokedSeatEpoch?: number;
}

/** An in-process authorization fence, checked synchronously at fresh admission.
 * It never rides the durable command: an admitted operation keeps its recovery. */
export class DeliveryAdmissionRefusedError extends Error {
  constructor(readonly code: string, readonly details?: DeliveryAdmissionRefusalDetails) { super(code); }
}
