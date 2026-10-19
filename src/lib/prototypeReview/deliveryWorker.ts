import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { runsElsewhere } from "@/lib/links/linked";
import { loadTasksForList, taskFeedSource } from "@/lib/tasks/store";
import { viewerReleaseOwnsTraffic } from "@/lib/viewerReleaseTraffic";
import { attemptPrototypeDelivery, prototypeDelivery, type PrototypeDeliveryPorts } from "./decision";
import type { PrototypeDecision, PrototypeReviewRound } from "./types";
import { seatRoundPageWithCursor } from "./seatRounds";
import { prototypeWorld } from "./world";
import { postPrototypeReviewToTelegram } from "./telegramPost";
import { reconcileReviewPolls, reviewPollsNeedRecovery } from "@/lib/telegram/bot/reviewPolls";
import { telegramBotService } from "@/lib/telegram/bot/service";

/*
 * The background delivery of saved prototype decisions.
 *
 * A decision is answered as soon as it is recorded; its message goes to the
 * project's seat from here. Each owed decision is attempted at once, then on a
 * backoff while its attempts fail, then every few seconds while the seat holds
 * it queued behind a running turn. Every Viewer boot sweeps the store and
 * attempts each owed decision within its persisted attempt and age budgets.
 * A decision saved during a deploy resumes once the Viewer is back. Exhausted
 * deliveries stay saved and join the seat wake agenda. Attempts are idempotent by the decision's
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
const EXHAUSTED_RECEIPT_RECHECK_MS = 60_000;

interface Running { again: boolean; done: Promise<void> }
interface WorkerState {
  owed: Map<string, string | null>;
  due: Map<string, number>;
  running: Map<string, Running>;
  scannedAt: number;
  scanAfter?: string;
  seatScanAfter?: string;
  postTaskAfter?: string;
  postTaskRoundAfter?: string;
  pollTaskAfter?: string;
  pollTaskRoundAfter?: string;
  postSeatAfter?: string;
  postSeatRoundAfter?: string;
  pollSeatAfter?: string;
  pollSeatRoundAfter?: string;
  preferSeatPost?: boolean;
  preferSeatPoll?: boolean;
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
  if (delivery.exhaustedAt) return EXHAUSTED_RECEIPT_RECHECK_MS;
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
    } finally {
      state.running.delete(reviewId);
      if (!state.owed.has(reviewId)) state.due.delete(reviewId);
    }
  })();
  return entry.done;
}

/** A decision was recorded, changed or asked to be retried: attempt it now. */
export function deliverPrototypeDecision(taskId: string | null, reviewId: string, ports: PrototypeDeliveryPorts = productionPorts()): Promise<void> {
  return run(taskId, reviewId, ports);
}

/** A production tick reads one indexed task page. A boot/explicit sweep
 * completes the cursor with a yield between pages. New decisions enter `owed`
 * immediately, so a page boundary never loses work recorded while yielding. */
async function scan(state: WorkerState, now: number, bounded: boolean): Promise<void> {
  const source = taskFeedSource();
  const inspect = (task: ReturnType<typeof loadTasksForList>[number]) => {
    const elsewhere = runsElsewhere(task);
    for (const round of task.prototypeReviews ?? []) {
      if (!elsewhere && round.decision && round.decision.delivery.state !== "sent") state.owed.set(round.id, task.id);
      else { state.owed.delete(round.id); state.due.delete(round.id); }
    }
  };
  if (!source) {
    for (const task of loadTasksForList()) inspect(task);
    state.scannedAt = now;
  } else for (;;) {
    const page = withViewerOperation("prototype.state", () => source.keyRange(state.scanAfter ?? "t:", "t;", 16));
    for (const task of page) inspect(task);
    if (page.length < 16) { state.scanAfter = undefined; state.scannedAt = now; break; }
    state.scanAfter = `t:${page.at(-1)!.id}`;
    if (bounded) break;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  for (;;) {
    const page = withViewerOperation("prototype.state", () => seatRoundPageWithCursor(state.seatScanAfter));
    for (const round of page.rounds) {
      if (round.decision && round.decision.delivery.state !== "sent") state.owed.set(round.id, null);
      else { state.owed.delete(round.id); state.due.delete(round.id); }
    }
    if (page.scanned < 16) { state.seatScanAfter = undefined; break; }
    state.seatScanAfter = page.cursor;
    if (bounded) break;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

type DeliveryKind = "post" | "poll";

/** Visit one indexed task page at a time. If the page still has eligible
    rounds after the batch, keep its task cursor and resume after the last
    visited round before moving to the next task page. */
function taskDeliveryBatch(state: WorkerState, kind: DeliveryKind, limit: number): PrototypeReviewRound[] {
  const source = taskFeedSource();
  const after = kind === "post" ? state.postTaskAfter : state.pollTaskAfter;
  const roundAfter = kind === "post" ? state.postTaskRoundAfter : state.pollTaskRoundAfter;
  const tasks = source ? withViewerOperation("prototype.state", () => source.keyRange(after ?? "t:", "t;", 16)) : loadTasksForList();
  const candidates = tasks.flatMap(task => task.prototypeReviews ?? []).filter(round =>
    (kind === "post" ? round.telegramPost?.state === "pending" : reviewPollsNeedRecovery(round))
      && (roundAfter === undefined || round.id > roundAfter))
    .sort((left, right) => left.id.localeCompare(right.id));
  const selected = candidates.slice(0, limit);
  if (source && selected.length === limit) {
    if (kind === "post") state.postTaskRoundAfter = selected.at(-1)!.id;
    else state.pollTaskRoundAfter = selected.at(-1)!.id;
  } else {
    const next = source && tasks.length === 16 ? `t:${tasks.at(-1)!.id}` : undefined;
    if (kind === "post") { state.postTaskAfter = next; state.postTaskRoundAfter = undefined; }
    else { state.pollTaskAfter = next; state.pollTaskRoundAfter = undefined; }
    if (!source) {
      if (kind === "post") state.postTaskRoundAfter = selected.length === limit ? selected.at(-1)!.id : undefined;
      else state.pollTaskRoundAfter = selected.length === limit ? selected.at(-1)!.id : undefined;
    }
  }
  return selected;
}

/** Seat rounds use the same page/round split so a busy first page cannot
    permanently hide later rounds. */
function seatDeliveryBatch(state: WorkerState, kind: DeliveryKind, limit: number): PrototypeReviewRound[] {
  const after = kind === "post" ? state.postSeatAfter : state.pollSeatAfter;
  const roundAfter = kind === "post" ? state.postSeatRoundAfter : state.pollSeatRoundAfter;
  const page = withViewerOperation("prototype.state", () => seatRoundPageWithCursor(after, 16));
  const candidates = page.rounds.filter(round =>
    (kind === "post" ? round.telegramPost?.state === "pending" : reviewPollsNeedRecovery(round))
      && (roundAfter === undefined || round.id > roundAfter))
    .sort((left, right) => left.id.localeCompare(right.id));
  const selected = candidates.slice(0, limit);
  if (selected.length === limit) {
    if (kind === "post") state.postSeatRoundAfter = selected.at(-1)!.id;
    else state.pollSeatRoundAfter = selected.at(-1)!.id;
  } else {
    const next = page.scanned === 16 ? page.cursor : undefined;
    if (kind === "post") { state.postSeatAfter = next; state.postSeatRoundAfter = undefined; }
    else { state.pollSeatAfter = next; state.pollSeatRoundAfter = undefined; }
  }
  return selected;
}

function deliveryBatch(state: WorkerState, kind: DeliveryKind): PrototypeReviewRound[] {
  const seatFirst = kind === "post" ? state.preferSeatPost === true : state.preferSeatPoll === true;
  if (kind === "post") state.preferSeatPost = !seatFirst;
  else state.preferSeatPoll = !seatFirst;
  const first = seatFirst ? seatDeliveryBatch(state, kind, 16) : taskDeliveryBatch(state, kind, 16);
  const remaining = 16 - first.length;
  if (!remaining) return first;
  const second = seatFirst ? taskDeliveryBatch(state, kind, remaining) : seatDeliveryBatch(state, kind, remaining);
  return [...first, ...second];
}

/** Attempts every owed decision that is due (all of them with `force`) and waits for them. */
export async function sweepPrototypeDeliveries(ports: PrototypeDeliveryPorts = productionPorts(), options: { force?: boolean; rescan?: boolean; limit?: number } = {}): Promise<void> {
  const state = workerState();
  const now = ports.now();
  if (options.rescan !== false) await scan(state, now, options.limit !== undefined);
  const attempts: Promise<void>[] = [];
  if (options.rescan !== false) {
    const posts = deliveryBatch(state, "post");
    for (const round of posts) {
      attempts.push(postPrototypeReviewToTelegram(round, round.telegramPost!.key).then(() => {}, () => {}));
    }
    const polls = deliveryBatch(state, "poll");
    for (const round of polls) {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (telegramBotService().hasReviewPollWork(round.id, round.telegramPost!.key)) continue;
      attempts.push(reconcileReviewPolls(round).catch(() => console.warn("Telegram review polls reconciliation deferred", "storage_unavailable")));
    }
  }
  const entries = state.owed.entries();
  const visits = Math.min(state.owed.size, options.limit ?? Number.POSITIVE_INFINITY);
  for (let n = 0; n < visits; n++) {
    const next = entries.next().value;
    if (!next) break;
    const [reviewId, taskId] = next;
    // Move visited entries behind their peers so a permanently pending first
    // page cannot starve another decision, even when every attempt is due.
    if (options.limit !== undefined) { state.owed.delete(reviewId); state.owed.set(reviewId, taskId); }
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
    const rescan = state.scanAfter !== undefined || state.seatScanAfter !== undefined || now - state.scannedAt >= RESCAN_MS;
    if (!rescan && state.owed.size === 0) return;
    // A predecessor release left running beside its successor stops attempting; the successor's boot swept the store.
    if (!viewerReleaseOwnsTraffic()) return;
    await sweepPrototypeDeliveries(ports, { rescan, limit: 16 })
      .catch(error => console.error("[prototype delivery] sweep failed", error instanceof Error ? error.message : String(error)));
  } catch (error) {
    console.error("[prototype delivery] sweep failed", error instanceof Error ? error.message : String(error));
  } finally { state.ticking = false; }
}

/** At Viewer start, take one bounded page; the clock continues its cursor. */
export function startPrototypeDeliveryWorker(ports: PrototypeDeliveryPorts = productionPorts()): void {
  const state = workerState();
  if (state.timer) return;
  state.timer = setInterval(() => { void tick(ports); }, TICK_MS);
  state.timer.unref?.();
  void sweepPrototypeDeliveries(ports, { force: true, limit: 16 })
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
  state.scanAfter = undefined;
  state.seatScanAfter = undefined;
  state.postTaskAfter = undefined; state.postTaskRoundAfter = undefined;
  state.pollTaskAfter = undefined; state.pollTaskRoundAfter = undefined;
  state.postSeatAfter = undefined; state.postSeatRoundAfter = undefined;
  state.pollSeatAfter = undefined; state.pollSeatRoundAfter = undefined;
  state.preferSeatPost = undefined; state.preferSeatPoll = undefined;
}
