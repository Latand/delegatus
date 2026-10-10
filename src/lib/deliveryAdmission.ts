/** An in-process authorization fence, checked synchronously at fresh admission.
 * It never rides the durable command: an admitted operation keeps its recovery. */
export class DeliveryAdmissionRefusedError extends Error {
  constructor(readonly code: string) { super(code); }
}
