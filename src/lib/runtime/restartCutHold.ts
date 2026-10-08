/**
 * The host rows a startup pass holds for their restart cut evidence
 * (docs/design/restart-cut-recognition.md): evidence that could not be
 * decided, or that moved after it was. Until the deferral re-probe decides
 * such a row or reaches its cap, nothing replaces the predecessor's ownership
 * of it, and that includes the on-demand recovery a queued message asks for.
 * The message stays queued and is tried again.
 *
 * Kept on the process object: instrumentation and routes can load separate
 * module instances in standalone.
 */
const shared = process as typeof process & { __llvRestartCutHeldHostKeys?: Set<string> };

function heldHostKeys(): Set<string> {
  return shared.__llvRestartCutHeldHostKeys ??= new Set();
}

export function holdRestartCutRow(hostKey: string): void {
  heldHostKeys().add(hostKey);
}

/** A pass decided the row: nothing holds it any more. */
export function releaseRestartCutRow(hostKey: string): void {
  heldHostKeys().delete(hostKey);
}

/** Replaces the held set with what a completed pass still holds. */
export function setRestartCutHeldRows(hostKeys: Iterable<string>): void {
  shared.__llvRestartCutHeldHostKeys = new Set(hostKeys);
}

export function restartCutEvidenceHolds(hostKey: string): boolean {
  return heldHostKeys().has(hostKey);
}
