import { performance } from "node:perf_hooks";

const DEFAULT_BATCH_SIZE = 16;
const DEFAULT_TIME_BUDGET_MS = 32;

export interface CooperativeSliceOptions {
  now?: () => number;
  turn?: (signal?: AbortSignal) => Promise<void>;
}

/** Share one elapsed-work budget across phases. A cheap checkpoint stays
 * synchronous; only exhausted slices enter the runtime's cooperative queue. */
export function cooperativeSlice(signal: AbortSignal, options: CooperativeSliceOptions = {}): () => Promise<void> | undefined {
  const now = options.now ?? (() => performance.now());
  const turn = options.turn ?? yieldToRuntime;
  let started = now();
  return () => {
    signal.throwIfAborted();
    if (now() - started < DEFAULT_TIME_BUDGET_MS) return;
    return turn(signal).then(() => { signal.throwIfAborted(); started = now(); });
  };
}

export interface CooperativeBatchOptions {
  batchSize?: number;
  timeBudgetMs?: number;
}

/*
 * One queue for every cooperative yield of the process
 * (docs/design/viewer-stalls-root-cause.md, section 3.3).
 *
 * A job that yields gives the loop a turn and expects its next slice soon
 * after. While each yield armed its own `setImmediate`, the runtime ran every
 * immediate queued before a turn inside that turn: N jobs that each bound
 * their own slice to 12 ms resumed back to back and stalled the loop for
 * N times 12 ms, 94 % of the time once N passed a few dozen. A job's budget
 * bounded its slice and said nothing about the turn.
 *
 * Here the turn has a budget of its own. A turn resumes the job that has
 * waited longest. When a resumed job yields again, its slice is over: if the
 * turn still has budget left, the next job that was already waiting when the
 * turn began shares it, and otherwise the rest wait for the next turn. So
 * short slices still share a turn, which keeps their throughput, a slice
 * longer than the budget has the turn to itself, and timers and requests run
 * between turns however many jobs wait. A job is never resumed in the turn
 * it yielded in.
 */
const TURN_BUDGET_MS = 4;
/** Resumed slots the queue may hold before it drops them. */
const RESUMED_SLOTS_KEPT = 1_024;

interface Waiter {
  resume: () => void;
  /** Position in the order of yields. */
  sequence: number;
  queuedAt: number;
  /** Set when the wait was withdrawn; the queue skips it. */
  withdrawn?: true;
}

interface CooperativeQueue {
  waiting: Waiter[];
  head: number;
  turnArmed: boolean;
  turnStartedAt: number;
  /** The last yield made before the running turn began: later ones wait for a later turn. */
  turnLimit: number;
  queued: number;
  /* Lifetime counters and the maxima of the current observation window. */
  resumed: number;
  turns: number;
  windowMaxDepth: number;
  windowLongestWaitMs: number;
}

/* On the process, not the module: a server build may load this module more
   than once, and two queues would each spend a budget in the same turn. */
const shared = globalThis as typeof globalThis & { __delegatusCooperativeQueue?: CooperativeQueue };
const queue = shared.__delegatusCooperativeQueue ??= {
  waiting: [], head: 0, turnArmed: false, turnStartedAt: Number.NEGATIVE_INFINITY, turnLimit: 0, queued: 0,
  resumed: 0, turns: 0, windowMaxDepth: 0, windowLongestWaitMs: 0,
};

function depth(): number {
  return queue.waiting.length - queue.head;
}

function armTurn(): void {
  if (queue.turnArmed) return;
  queue.turnArmed = true;
  setImmediate(runTurn);
}

function runTurn(): void {
  queue.turnArmed = false;
  queue.turnStartedAt = performance.now();
  queue.turnLimit = queue.queued;
  queue.turns += 1;
  resumeNext();
}

/** Resumes the longest-waiting job this turn may still take, and keeps a turn armed while any job waits. */
function resumeNext(): void {
  while (queue.head < queue.waiting.length) {
    const waiter = queue.waiting[queue.head]!;
    if (!waiter.withdrawn && waiter.sequence > queue.turnLimit) break;
    queue.waiting[queue.head] = undefined as unknown as Waiter;
    queue.head += 1;
    if (waiter.withdrawn) continue;
    queue.resumed += 1;
    queue.windowLongestWaitMs = Math.max(queue.windowLongestWaitMs, performance.now() - waiter.queuedAt);
    waiter.resume();
    break;
  }
  if (queue.head >= queue.waiting.length) {
    queue.waiting = [];
    queue.head = 0;
    return;
  }
  /* A queue that never empties, which is what a saturated process has, would
     otherwise keep every slot it ever resumed. */
  if (queue.head >= RESUMED_SLOTS_KEPT && queue.head * 2 >= queue.waiting.length) {
    queue.waiting = queue.waiting.slice(queue.head);
    queue.head = 0;
  }
  armTurn();
}

/**
 * Gives the event loop a turn and resumes the caller in a later turn, after
 * the jobs that yielded before it. A `signal` withdraws the wait: the promise
 * rejects with the signal's reason and the queue passes over it.
 */
export function yieldToRuntime(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const waiter: Waiter = { resume: resolve, sequence: queue.queued += 1, queuedAt: performance.now() };
    if (signal) {
      const withdraw = () => {
        waiter.withdrawn = true;
        reject(signal.reason);
      };
      signal.addEventListener("abort", withdraw, { once: true });
      waiter.resume = () => {
        signal.removeEventListener("abort", withdraw);
        resolve();
      };
    }
    queue.waiting.push(waiter);
    queue.windowMaxDepth = Math.max(queue.windowMaxDepth, depth());
    /* The caller's slice ends here. Inside a turn that still has budget, the
       next job that waited before the turn began takes over at once. */
    if (performance.now() - queue.turnStartedAt < TURN_BUDGET_MS) resumeNext();
    armTurn();
  });
}

export interface CooperativeQueueObservation {
  /** Slices resumed since the process started. */
  resumed: number;
  /** Loop turns the queue used to resume them. */
  turns: number;
  /** Jobs waiting for a slice now. */
  depth: number;
  /** The most jobs that waited at once since the last observation. */
  maxDepth: number;
  /** The longest a job waited for its slice since the last observation. */
  longestWaitMs: number;
}

/**
 * What the loop monitor reads on each of its ticks. The counters only grow,
 * so two observations bound the slices resumed between them; the maxima cover
 * the time since the previous observation and start again from this one.
 */
export function observeCooperativeQueue(): CooperativeQueueObservation {
  const observation = {
    resumed: queue.resumed, turns: queue.turns, depth: depth(),
    maxDepth: queue.windowMaxDepth, longestWaitMs: Math.round(queue.windowLongestWaitMs),
  };
  queue.windowMaxDepth = depth();
  queue.windowLongestWaitMs = 0;
  return observation;
}

export async function forEachCooperatively<T>(
  values: readonly T[],
  visit: (value: T, index: number) => void | Promise<void>,
  options: CooperativeBatchOptions = {},
): Promise<void> {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE));
  const timeBudgetMs = Math.max(1, options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
  let batchStartedAt = performance.now();
  let batchCount = 0;
  for (let index = 0; index < values.length; index += 1) {
    await visit(values[index]!, index);
    batchCount += 1;
    if (index + 1 >= values.length) continue;
    if (batchCount < batchSize && performance.now() - batchStartedAt < timeBudgetMs) continue;
    await yieldToRuntime();
    batchStartedAt = performance.now();
    batchCount = 0;
  }
}

export async function mapCooperatively<T, U>(
  values: readonly T[],
  visit: (value: T, index: number) => U | Promise<U>,
  options: CooperativeBatchOptions = {},
): Promise<U[]> {
  const mapped = new Array<U>(values.length);
  await forEachCooperatively(values, async (value, index) => {
    mapped[index] = await visit(value, index);
  }, options);
  return mapped;
}
