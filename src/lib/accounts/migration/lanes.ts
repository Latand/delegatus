/**
 * Per-conversation lanes and the leased advancement permit of the
 * account-migration coordinator (docs/design/delivery-progress-and-drain.md,
 * B1).
 *
 * A pass starts one lane per conversation it has work for and waits for its
 * lanes no longer than its budget; a lane that outlives its pass keeps its
 * conversation, and a pass that finds it running leaves that conversation to
 * it. Successor creation is shared: one lane at a time advances a switch, and
 * the permit passes to the next lane when the holder's call returns or when
 * the holder has kept it for its lease, whichever comes first. A holder whose
 * lease ran out keeps running in its own lane and holds no other.
 *
 * The state lives on `process` for the reason the actuation sections do: Next
 * evaluates instrumentation and routes in separate bundle realms.
 */

export interface MigrationLane {
  /** A later pass found this conversation's lane running and wants another look. */
  rerun: boolean;
  /** The pass that started this lane stopped waiting for it. */
  outlived: boolean;
}

interface PermitWaiter {
  token: object;
  leaseMs: number;
  grant: () => void;
}

interface LaneState {
  lanes: Map<string, MigrationLane>;
  permit: { holder: object | null; timer: ReturnType<typeof setTimeout> | null; waiters: PermitWaiter[] };
}

const processState = process as typeof process & { __llvMigrationLanes?: LaneState };

function state(): LaneState {
  return processState.__llvMigrationLanes ??= { lanes: new Map(), permit: { holder: null, timer: null, waiters: [] } };
}

/** Whether a coordinator lane is working on the conversation in this process. */
export function migrationLaneRunning(conversationId: string): boolean {
  return state().lanes.has(conversationId);
}

export function migrationLane(conversationId: string): MigrationLane | null {
  return state().lanes.get(conversationId) ?? null;
}

/**
 * Starts the conversation's lane. `ended` runs once it is over, whatever it
 * answered, after the lane has been released.
 */
export function startMigrationLane(
  conversationId: string,
  work: () => Promise<void>,
  ended: (lane: MigrationLane) => void,
): Promise<void> {
  const { lanes } = state();
  const lane: MigrationLane = { rerun: false, outlived: false };
  lanes.set(conversationId, lane);
  return (async () => {
    try {
      await work();
    } finally {
      if (lanes.get(conversationId) === lane) lanes.delete(conversationId);
      ended(lane);
    }
  })();
}

function grant(waiter: PermitWaiter): void {
  const { permit } = state();
  permit.holder = waiter.token;
  if (permit.timer) clearTimeout(permit.timer);
  const timer = setTimeout(() => {
    if (permit.holder === waiter.token) passOn();
  }, waiter.leaseMs);
  (timer as { unref?: () => void }).unref?.();
  permit.timer = timer;
  waiter.grant();
}

function passOn(): void {
  const { permit } = state();
  permit.holder = null;
  if (permit.timer) clearTimeout(permit.timer);
  permit.timer = null;
  const next = permit.waiters.shift();
  if (next) grant(next);
}

/** Runs `work` under the advancement permit, handed over in arrival order. */
export async function withAdvancementPermit<T>(leaseMs: number, work: () => Promise<T>): Promise<T> {
  const { permit } = state();
  const token = {};
  await new Promise<void>((resolve) => {
    const waiter = { token, leaseMs, grant: resolve };
    if (permit.holder === null && permit.waiters.length === 0) grant(waiter);
    else permit.waiters.push(waiter);
  });
  try {
    return await work();
  } finally {
    if (state().permit.holder === token) passOn();
  }
}
