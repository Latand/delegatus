import { DeliveryWake } from "./deliveryWake";

/* Startup adoption and route handlers can run in separate Next bundle realms.
   The Node process object carries the kick across those realm boundaries. */
const signalStore = process as typeof process & {
  __llvStructuredDeliveryKick?: ((freshAdmission?: boolean, conversationId?: string) => void | Promise<void>) | null;
  __llvStructuredDeliveryRequest?: (() => void | Promise<void>) | null;
  __llvStructuredDeliveryRequestRun?: { token: object; owner: () => void | Promise<void>; acknowledgement: Promise<void>;
    wake: DeliveryWake; outcome: { settled: boolean } } | null;
};

export function setStructuredDeliveryKick(next: ((freshAdmission?: boolean, conversationId?: string) => void | Promise<void>) | null,
  request?: () => void | Promise<void>): void {
  signalStore.__llvStructuredDeliveryKick = next;
  signalStore.__llvStructuredDeliveryRequest = next ? request ?? null : null;
  signalStore.__llvStructuredDeliveryRequestRun = null;
}

/** The controller's admission guard settles before its caller returns; the
 * delivery executor owns the subsequent wake. Legacy registrations have no
 * separate guard and retain their fire-and-forget wake. */
export function requestStructuredDeliveryQueue(waitMs = 5_000): void | Promise<void> {
  const owner = signalStore.__llvStructuredDeliveryRequest;
  if (owner) {
    const running = signalStore.__llvStructuredDeliveryRequestRun;
    if (running?.owner === owner) {
      if (!running.outcome.settled) running.wake.schedule(Math.max(0, Number.isFinite(waitMs) ? waitMs : 5_000));
      return running.acknowledgement;
    }
    const token = {};
    let expired = false;
    let wake!: DeliveryWake;
    const outcome = { settled: false };
    const work = Promise.resolve().then(owner);
    const acknowledgement = new Promise<void>((resolve, reject) => {
      wake = new DeliveryWake(() => { expired = true; outcome.settled = true; resolve(); });
      wake.schedule(Math.max(0, Number.isFinite(waitMs) ? waitMs : 5_000));
      const finish = () => {
        outcome.settled = true;
        wake.cancel();
        if (signalStore.__llvStructuredDeliveryRequestRun?.token === token) signalStore.__llvStructuredDeliveryRequestRun = null;
      };
      void work.then(() => { finish(); resolve(); }, error => {
        finish();
        if (expired) console.error("[structured delivery] deferred guard failed", error);
        reject(error);
      });
    });
    // After the acknowledgement's deadline, callers share its settled result
    // until the owned guard ends. No new timer or awaiter joins a stuck guard.
    signalStore.__llvStructuredDeliveryRequestRun = { token, owner, acknowledgement, wake, outcome };
    return acknowledgement;
  }
  void Promise.resolve(signalStore.__llvStructuredDeliveryKick?.()).catch(error => {
    console.error("[structured delivery] requested wake failed", error);
  });
}

export function kickStructuredDeliveryQueue(freshAdmission = false, conversationId?: string): void | Promise<void> {
  return freshAdmission ? signalStore.__llvStructuredDeliveryKick?.(true, conversationId) : signalStore.__llvStructuredDeliveryKick?.();
}
