type MigrationTick = () => Promise<void>;

/** How often the account-migration controller runs a pass with nobody asking:
    the latest a reservation it holds is looked at again. */
export const ACCOUNT_MIGRATION_PASS_INTERVAL_MS = 60_000;

/** How long one coordinator pass waits for its conversations' lanes before it
    ends; a lane still running keeps its conversation and asks for the next
    pass when it ends (docs/design/delivery-progress-and-drain.md, B1). */
export const HELD_DRAIN_PASS_BUDGET_MS = 5_000;

/** How long one lane may keep the advancement permit before the next waiting
    conversation may start its own switch. */
export const ADVANCEMENT_LEASE_MS = HELD_DRAIN_PASS_BUDGET_MS;

interface ControllerSignalState {
  tick: MigrationTick | null;
  scheduled: boolean;
}

/* Next route handlers and instrumentation can evaluate this module in
   separate bundle realms. Their shared process object carries the controller
   registration and coalescing state across those evaluations. */
const signalHost = process as typeof process & {
  __llvAccountMigrationSignal?: ControllerSignalState;
};

const signal = signalHost.__llvAccountMigrationSignal ??= { tick: null, scheduled: false };

export function registerAccountMigrationTick(tick: MigrationTick): () => void {
  signal.tick = tick;
  return () => {
    if (signal.tick === tick) signal.tick = null;
  };
}

export function requestAccountMigrationTick(): void {
  if (signal.scheduled || signal.tick === null) return;
  signal.scheduled = true;
  queueMicrotask(() => {
    signal.scheduled = false;
    const tick = signal.tick;
    if (tick === null) return;
    void tick().catch((error) => {
      console.error("[account migration controller] requested reconciliation failed", error);
    });
  });
}
