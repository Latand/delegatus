/**
 * The host rows a startup pass holds for their restart cut evidence
 * (docs/design/restart-cut-recognition.md): evidence that could not be
 * decided, or that moved after it was. Until the deferral re-probe decides
 * such a row or reaches its cap, nothing replaces the predecessor's ownership
 * of it, and that includes the on-demand recovery a queued message asks for.
 * The message stays queued and is tried again. Stage recovery holds until
 * the evidence is resolved, including after the pending-work cap.
 *
 * Kept on the process object: instrumentation and routes can load separate
 * module instances in standalone.
 */
const shared = process as typeof process & {
  __llvRestartCutHeldHostKeys?: Set<string>;
  __llvRestartCutUnresolvedHostKeys?: Set<string>;
};

function heldHostKeys(): Set<string> {
  return shared.__llvRestartCutHeldHostKeys ??= new Set();
}

function unresolvedHostKeys(): Set<string> {
  return shared.__llvRestartCutUnresolvedHostKeys ??= new Set();
}

export function holdRestartCutRow(hostKey: string, options: { admitPendingWork?: boolean } = {}): void {
  unresolvedHostKeys().add(hostKey);
  if (!options.admitPendingWork) heldHostKeys().add(hostKey);
}

/** A pass decided the row: nothing holds it any more. */
export function releaseRestartCutRow(hostKey: string): void {
  heldHostKeys().delete(hostKey);
  unresolvedHostKeys().delete(hostKey);
}

/** Replaces the held set with what a completed pass still holds. */
export function setRestartCutHeldRows(hostKeys: Iterable<string>, options: { admitPendingWork?: boolean } = {}): void {
  const unresolved = new Set(hostKeys);
  shared.__llvRestartCutUnresolvedHostKeys = unresolved;
  shared.__llvRestartCutHeldHostKeys = options.admitPendingWork ? new Set() : new Set(unresolved);
}

export function restartCutEvidenceHolds(hostKey: string): boolean {
  return heldHostKeys().has(hostKey);
}

/** Automatic stage replay requires resolved evidence, regardless of queue admission. */
export function restartCutEvidenceUnresolved(hostKey: string): boolean {
  return unresolvedHostKeys().has(hostKey);
}
