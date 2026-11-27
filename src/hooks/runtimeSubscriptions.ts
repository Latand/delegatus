export interface RuntimeSubscription {
  /** An empty key set listens only for a snapshot or a change of global authority. */
  keys?: { conversation?: string | null; artifact?: string | null; operation?: string | null; flow?: string | null; deployments?: boolean; deliveries?: ReadonlySet<string> };
  /** Include health observations that only advance the last-event clock. */
  activity?: boolean;
}

export const GLOBAL_RUNTIME_GATES: RuntimeSubscription = { keys: {} };
export const WITH_RUNTIME_ACTIVITY: RuntimeSubscription = { activity: true };

export const RUNTIME_DEPLOYMENTS: RuntimeSubscription = { keys: { deployments: true } };
