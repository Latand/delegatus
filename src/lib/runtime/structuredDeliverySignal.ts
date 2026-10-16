/* Startup adoption and route handlers can run in separate Next bundle realms.
   The Node process object carries the kick across those realm boundaries. */
const signalStore = process as typeof process & {
  __llvStructuredDeliveryKick?: ((freshAdmission?: boolean) => void | Promise<void>) | null;
};

export function setStructuredDeliveryKick(next: ((freshAdmission?: boolean) => void | Promise<void>) | null): void {
  signalStore.__llvStructuredDeliveryKick = next;
}

export function kickStructuredDeliveryQueue(freshAdmission = false): void | Promise<void> {
  return freshAdmission ? signalStore.__llvStructuredDeliveryKick?.(true) : signalStore.__llvStructuredDeliveryKick?.();
}
