import type { ExternalRelayProgress } from "./protocol";

// Delivery cleanup and chain sweeping share the same process-local custody.
const custody = globalThis as typeof globalThis & {
  __llvExternalRelayInflight?: Set<string>;
  __llvExternalRelayUnrecordedAcceptances?: Set<string>;
};
export const relayInflightRequests = custody.__llvExternalRelayInflight ??= new Set<string>();
export const relayUnrecordedAcceptances = custody.__llvExternalRelayUnrecordedAcceptances ??= new Set<string>();
export const relayRequestInFlight = (requestId: string): boolean => relayInflightRequests.has(requestId) || relayUnrecordedAcceptances.has(requestId);

/* What the settings page shows of each relay's recent work: the outcome of
   the last settled request and the last progress label a run produced. It
   lives in memory on globalThis, because the route modules and the
   instrumentation that runs the poller load separate copies of this module,
   and it survives a poll loop being restarted by a settings change. Nothing
   here is written under <state>: a progress label is model commentary. */
export type ExternalRelayActivity = {
  lastOutcome: string | null;
  lastOutcomeAt: string | null;
  lastProgress: { targetId: string; label: string; at: string } | null;
};
const globalActivity = globalThis as typeof globalThis & {
  __llvExternalRelayActivity?: Map<string, ExternalRelayActivity>;
};
const activity = (globalActivity.__llvExternalRelayActivity ??= new Map());
const empty = (): ExternalRelayActivity => ({
  lastOutcome: null,
  lastOutcomeAt: null,
  lastProgress: null,
});
export function relayActivity(relayId: string): ExternalRelayActivity {
  return activity.get(relayId) ?? empty();
}
export function noteRelayOutcome(relayId: string, outcome: string): void {
  activity.set(relayId, {
    ...relayActivity(relayId),
    lastOutcome: outcome,
    lastOutcomeAt: new Date().toISOString(),
  });
}
export function noteRelayProgress(
  relayId: string,
  targetId: string,
  progress: ExternalRelayProgress,
): void {
  activity.set(relayId, {
    ...relayActivity(relayId),
    lastProgress: { targetId, label: progress.label, at: progress.at },
  });
}
export function forgetRelayActivity(relayId: string): void {
  activity.delete(relayId);
}

/* A failure notice travels to the service as an ordinary `answered` completion,
   because the requester does receive a reply. Locally it is recorded under its
   own outcome, so the answer records, the card and the journal tell a
   delivered notice from a delivered answer. Records written before this value
   existed keep `answered` and stay readable. */
export const RELAY_FAILURE_NOTICE_OUTCOME = "failure_notice";
const globalNotices = globalThis as typeof globalThis & { __llvExternalRelayFailureNotices?: WeakSet<object> };
const failureNotices = (globalNotices.__llvExternalRelayFailureNotices ??= new WeakSet());
export function markRelayFailureNotice<T extends object>(completion: T): T {
  failureNotices.add(completion);
  return completion;
}
/** The locally recorded outcome of a completion the runner returned. */
export function relayOutcomeLabel(completion: { outcome: string; reason?: string } | null): string {
  if (!completion) return "lease_lost";
  if (completion.outcome !== "answered") return `${completion.outcome}:${completion.reason}`;
  return failureNotices.has(completion) ? RELAY_FAILURE_NOTICE_OUTCOME : "answered";
}
