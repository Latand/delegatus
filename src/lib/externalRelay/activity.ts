import type { ExternalRelayProgress } from "./protocol";

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
