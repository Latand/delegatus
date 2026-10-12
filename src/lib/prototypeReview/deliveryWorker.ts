import { runsElsewhere } from "@/lib/links/linked";
import { loadTasksForList } from "@/lib/tasks/store";
import { viewerReleaseOwnsTraffic } from "@/lib/viewerReleaseTraffic";
import { attemptPrototypeDelivery, prototypeDelivery, type PrototypeDeliveryPorts } from "./decision";
import type { PrototypeDecision } from "./types";
import { loadSeatRounds } from "./seatRounds";
import { prototypeWorld } from "./world";

/*
 * The background delivery of saved prototype decisions.
 *
 * A decision is answered as soon as it is recorded; its message goes to the
 * project's seat from here. Each owed decision is attempted at once, then on a
 * backoff while its attempts fail, then every few seconds while the seat holds
 * it queued behind a running turn. Every Viewer boot sweeps the store and
 * attempts each owed decision, so a decision saved during a deploy or a restart
 * goes out once the Viewer is back. Attempts are idempotent by the decision's
 * message key and serialized by the round's decision lock.
 *
 * The state lives on `globalThis`: the route bundle that records a decision
 * and the instrumentation bundle that runs the clock load this module apart.
 */

/** Between failed or unconfirmed attempts, by how many have failed in a row. */
export const PROTOTYPE_DELIVERY_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000] as const;
/** A message the seat admitted and has not yet taken: asked about this often. */
export const PROTOTYPE_DELIVERY_IN_FLIGHT_MS = 3_000;
/** A project with no seat: looked for one this often. */
export const PROTOTYPE_DELIVERY_SEAT_POLL_MS = 10_000;
/** The clock, and the full rescan that catches a decision another process recorded. */
const TICK_MS = 1_000;
const RESCAN_MS = 60_000;

interface Running { again: boolean; done: Promise<void> }
interface WorkerState {
  owed: Map<string, string | null>;
  due: Map<string, number>;
  running: Map<string, Running>;
  scannedAt: number;
  ticking: boolean;
  timer?: ReturnType<typeof setInterval>;
}
const KEY = Symbol.for("delegatus.prototypeDeliveryWorker");
function workerState(): WorkerState {
  const host = globalThis as typeof globalThis & { [KEY]?: WorkerState };
  return host[KEY] ??= { owed: new Map(), due: new Map(), running: new Map(), scannedAt: Number.NEGATIVE_INFINITY, ticking: false };
}
const productionPorts = (): PrototypeDeliveryPorts => ({ delivery: prototypeDelivery, world: prototypeWorld, now: Date.now });

/** How long after an attempt the next one is due, from what the attempt left. */
export function prototypeDeliveryDelay(delivery: PrototypeDecision["delivery"]): number {
  if (delivery.state === "sent") return Number.POSITIVE_INFINITY;
  if (!delivery.conversationId) return PROTOTYPE_DELIVERY_SEAT_POLL_MS;
  const failures = delivery.failures ?? 0;
  if (!failures) return PROTOTYPE_DELIVERY_IN_FLIGHT_MS;
  return PROTOTYPE_DELIVERY_BACKOFF_MS[Math.min(failures, PROTOTYPE_DELIVERY_BACKOFF_MS.length) - 1]!;
}

/** Runs attempts for one round until nothing new asked for another; one runner per round in this process. */
function run(taskId: string | null, reviewId: string, ports: PrototypeDeliveryPorts): Promise<void> {
  const state = workerState();
  const held = state.running.get(reviewId);
  if (held) { held.again = true; return held.done; }
  const entry: Running = { again: false, done: Promise.resolve() };
  state.owed.set(reviewId, taskId);
  state.running.set(reviewId, entry);
  entry.done = (async () => {
    await Promise.resolve();
    try {
      do {
        entry.again = false;
        let decision: PrototypeDecision | null;
        try {
          decision = await attemptPrototypeDelivery(taskId, reviewId, ports);
        } catch (error) {
          console.error("[prototype delivery] attempt failed", error instanceof Error ? error.message : String(error));
          state.due.set(reviewId, ports.now() + PROTOTYPE_DELIVERY_BACKOFF_MS[0]);
          continue;
        }
        if (!decision || decision.delivery.state === "sent") {
          state.owed.delete(reviewId); state.due.delete(reviewId);
        } else state.due.set(reviewId, ports.now() + prototypeDeliveryDelay(decision.delivery));
      } while (entry.again);
    } finally { state.running.delete(reviewId); }
  })();
  return entry.done;
}

/** A decision was recorded, changed or asked to be retried: attempt it now. */
export function deliverPrototypeDecision(taskId: string | null, reviewId: string, ports: PrototypeDeliveryPorts = productionPorts()): void {
  void run(taskId, reviewId, ports);
}

/** Every decision on this installation whose message is still owed. */
function scan(state: WorkerState, now: number): void {
  const owed = new Map<string, string | null>();
  for (const task of loadTasksForList()) {
    if (runsElsewhere(task)) continue;
    for (const round of task.prototypeReviews ?? []) {
      if (round.decision && round.decision.delivery.state !== "sent") owed.set(round.id, task.id);
    }
  }
  for (const round of loadSeatRounds()) {
    if (round.decision && round.decision.delivery.state !== "sent") owed.set(round.id, null);
  }
  state.owed = owed;
  for (const reviewId of [...state.due.keys()]) if (!owed.has(reviewId)) state.due.delete(reviewId);
  state.scannedAt = now;
}

/** Attempts every owed decision that is due (all of them with `force`) and waits for them. */
export async function sweepPrototypeDeliveries(ports: PrototypeDeliveryPorts = productionPorts(), options: { force?: boolean; rescan?: boolean } = {}): Promise<void> {
  const state = workerState();
  const now = ports.now();
  if (options.rescan !== false) scan(state, now);
  const attempts: Promise<void>[] = [];
  for (const [reviewId, taskId] of state.owed) {
    if (state.running.has(reviewId)) { attempts.push(state.running.get(reviewId)!.done); continue; }
    if (!options.force && (state.due.get(reviewId) ?? 0) > now) continue;
    attempts.push(run(taskId, reviewId, ports));
  }
  await Promise.all(attempts);
}

async function tick(ports: PrototypeDeliveryPorts): Promise<void> {
  const state = workerState();
  if (state.ticking) return;
  state.ticking = true;
  try {
    const now = ports.now();
    const rescan = now - state.scannedAt >= RESCAN_MS;
    if (!rescan && ![...state.owed.keys()].some(reviewId => !state.running.has(reviewId) && (state.due.get(reviewId) ?? 0) <= now)) return;
    // A predecessor release left running beside its successor stops attempting; the successor's boot swept the store.
    if (!viewerReleaseOwnsTraffic()) return;
    void sweepPrototypeDeliveries(ports, { rescan })
      .catch(error => console.error("[prototype delivery] sweep failed", error instanceof Error ? error.message : String(error)));
  } catch (error) {
    console.error("[prototype delivery] sweep failed", error instanceof Error ? error.message : String(error));
  } finally { state.ticking = false; }
}

/** At the Viewer's start: every owed decision is attempted once, then the clock runs. */
export function startPrototypeDeliveryWorker(ports: PrototypeDeliveryPorts = productionPorts()): void {
  const state = workerState();
  if (state.timer) return;
  state.timer = setInterval(() => { void tick(ports); }, TICK_MS);
  state.timer.unref?.();
  void sweepPrototypeDeliveries(ports, { force: true })
    .catch(error => console.error("[prototype delivery] boot sweep failed", error instanceof Error ? error.message : String(error)));
}

/** Tests only: wait for every attempt in flight, then forget the schedule and stop the clock. */
export async function settlePrototypeDeliveriesForTests(): Promise<void> {
  const state = workerState();
  while (state.running.size) await Promise.all([...state.running.values()].map(entry => entry.done));
}
export async function resetPrototypeDeliveryWorkerForTests(): Promise<void> {
  await settlePrototypeDeliveriesForTests();
  const state = workerState();
  if (state.timer) clearInterval(state.timer);
  state.timer = undefined;
  state.owed.clear(); state.due.clear();
  state.scannedAt = Number.NEGATIVE_INFINITY;
}
