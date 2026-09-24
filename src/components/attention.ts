import { BRIDGE_ASK_TTL_SECONDS } from "@/lib/bridge/types";
import type { AttentionDismissalMark, ConversationReasonKind } from "@/lib/attention/dismissalTypes";
import type { BridgeAsk, FileEntry } from "@/lib/types";
import { DELIVERY_UNCERTAIN_MS, DELIVERY_WAIT_HELD_MS } from "@/components/runtime/deliveryWait";

import { projectKey } from "./projectModel";

/**
 * The attention queue: which agents need operator attention right now, oldest
 * signal first. Pure derived state over the polled file list — every surface
 * (badge, popover, title, N-cycle, push/toast seen-sets) derives identity from
 * the one `attentionId` helper here so counts and dedupe keys cannot drift.
 *
 * Why a conversation needs the operator is `attentionReason`
 * (docs/design/needs-attention.md §4): one named reason, or none. Only waits
 * that the operator can actually end raise it: an orchestrator's ask, a
 * question, a plan, a permission prompt, and a message that has not arrived
 * for half an hour. A rate-limit wall lifts on its own clock and a quiet turn
 * is usually a long tool call, so both keep their row words and stop raising
 * the state.
 */

/**
 * Attention severity tiers, highest first:
 * - «unowned» — a hosted approval with no attached owner (a first-class alarm,
 *   issue #25 R10-5); always sorts to the queue head.
 * - «blocked» — an ask, a question, a prompt, or an owed message.
 * - «heuristic» — a low-confidence "possibly waiting" signal (turn-ended +
 *   idle + nothing pending); visually distinct, ranks below hard blocks.
 * - «stalled» — kept for the runtime bus's own tiers. The FileEntry-derived
 *   queue no longer emits it: a stalled conversation does not need the
 *   operator (docs/design/needs-attention.md §3, reason 7).
 *
 * The FileEntry-derived queue below only ever emits «blocked»;
 * «unowned»/«heuristic» come from the runtime bus's structured attentions. An
 * orchestrator's open bridge ask (issue #1168) joins the «blocked» tier: a
 * manager that filed `blocked`/`question` is a hard block by its own
 * declaration.
 */
export type AttentionTier = "unowned" | "blocked" | "heuristic" | "stalled";

/** Sort priority per tier (lower = closer to the queue head). */
export const TIER_RANK: Record<AttentionTier, number> = {
  unowned: 0,
  blocked: 1,
  heuristic: 2,
  stalled: 3,
};

export interface AttentionItem {
  /** attentionId(file) — stable while the underlying signal is unchanged. */
  id: string;
  file: FileEntry;
  project: string;
  tier: AttentionTier;
  /** Epoch seconds the wait started: bridgeAsk.at | askedAt | waitingInput.since | admission. */
  since: number;
  /** Why it needs the operator. */
  reason: ConversationReason;
}

/* An interrupted session stops being "yours to answer" after a while: a
   permission prompt from two days ago is dead context. Shared with the
   switchboard's isAwaitingUser so the stalled row and the «waiting» bucket
   agree. */
export const STALLED_ATTENTION_TTL = 2 * 3600;

/** Epoch seconds an ISO timestamp names, or null when it does not parse. */
function isoSeconds(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

/**
 * When the oldest owed message was admitted, once it needs the operator: half
 * an hour unconfirmed (`DELIVERY_UNCERTAIN_MS`, when the composer offers Retry
 * and Discard), or sooner when the record itself says `delivery-uncertain`.
 * Under that it is ordinary long-turn latency (#1213's longest successful wait
 * was 21 minutes), and nothing is asked of anyone.
 */
export function blockingStuckDelivery(file: FileEntry, now: number): number | null {
  const delivery = file.stuckDelivery;
  if (!delivery) return null;
  const since = isoSeconds(delivery.since);
  if (since === null) return null;
  if (delivery.state === "delivery-uncertain") return since;
  return now - since >= DELIVERY_UNCERTAIN_MS / 1000 ? since : null;
}

/** When the oldest owed message was admitted, once it has waited past the
    queue's own wait: the conversation header's «held» (five minutes). */
export function heldStuckDelivery(file: FileEntry, now: number): number | null {
  const delivery = file.stuckDelivery;
  if (!delivery) return null;
  const since = isoSeconds(delivery.since);
  if (since === null) return null;
  return now - since >= DELIVERY_WAIT_HELD_MS / 1000 ? since : null;
}

/** A turn left open with no transcript write for a while, a process behind
    it, and young enough to still matter. The row says «Stalled»; it no longer
    raises needs-you (docs/design/needs-attention.md §3, reason 7). */
export function stalledAttention(file: FileEntry, now: number): boolean {
  return file.activity === "stalled"
    && file.proc === "running"
    && now - file.mtime <= STALLED_ATTENTION_TTL;
}

/**
 * The orchestrator's open ask, or null once the clock has retired it (#1168).
 *
 * The age check has to live HERE and not only on the server that stamped it.
 * `/api/files` serves a cached projection whose key is a function of the scan
 * and the state files, so a payload built while the ask was young keeps being
 * served verbatim; nothing in the log moves when a report merely gets old. The
 * queue is the surface that owns "right now", and it is the only place holding
 * a live clock. An expired ask falls THROUGH to the file's own signals rather
 * than dropping the row.
 */
export function openBridgeAsk(file: FileEntry, now: number): BridgeAsk | null {
  const ask = file.bridgeAsk;
  if (!ask) return null;
  const at = isoSeconds(ask.at);
  if (at === null) return null;
  return now - at <= BRIDGE_ASK_TTL_SECONDS ? ask : null;
}

/**
 * Epoch seconds at which the queue changes on its own, with nothing polled
 * moving: an orchestrator ask crossing its TTL, an owed message crossing the
 * half hour. `/api/files` keeps the array identity while its body is
 * unchanged, so a surface that wants an expiry to actually take effect has to
 * schedule a tick, and both kinds of expiry are the same kind of event.
 */
export function attentionExpiries(files: readonly FileEntry[]): number[] {
  const expiries: number[] = [];
  for (const file of files) {
    const at = file.bridgeAsk ? isoSeconds(file.bridgeAsk.at) : null;
    if (at !== null) expiries.push(at + BRIDGE_ASK_TTL_SECONDS);
    const deliverySince = file.stuckDelivery ? isoSeconds(file.stuckDelivery.since) : null;
    if (deliverySince !== null) expiries.push(deliverySince + DELIVERY_UNCERTAIN_MS / 1000);
  }
  return expiries;
}

/**
 * Why one conversation needs the operator (docs/design/needs-attention.md §4).
 *
 * `since` is when the wait began, the instant the queue sorts by and the row
 * counts from. `raisedAt` is when it began to need the operator, which is what
 * a dismissal that names no reason is compared with; the two differ only for
 * an owed message, which waits for half an hour before it asks anything.
 */
export interface ConversationReason {
  kind: ConversationReasonKind;
  /** The shared attention identity: the push dedupe key and the cycle anchor. */
  id: string;
  since: number;
  raisedAt: number;
  /** Whether `since` came from the signal's own clock. An undated reason is
      covered only by a dismissal that names its id. */
  clocked: boolean;
  /** The agent's own short header for a question, when it wrote one. */
  header: string | null;
  /** The dismissal that covers this reason, or null while it is flagged. */
  dismissal: AttentionDismissalMark | null;
}

/**
 * Whether a recorded dismissal covers this reason (§5, «What brings an item
 * back»). A dismissal that names the reason on screen covers that reason and
 * nothing else: the card may have been drawn before a newer question arrived
 * or before an owed message turned uncertain, and the tap only saw what it
 * drew. One that names none (an agent's call) covers what started at or
 * before it, and never an undated reason. A dismissal whose own time does not
 * parse covers nothing.
 */
export function dismissalCovers(reason: Pick<ConversationReason, "id" | "raisedAt" | "clocked">, dismissal: AttentionDismissalMark | null | undefined): boolean {
  if (!dismissal) return false;
  const at = isoSeconds(dismissal.at);
  if (at === null) return false;
  if (dismissal.reasonId) return dismissal.reasonId === reason.id;
  return reason.clocked && reason.raisedAt <= at;
}

/**
 * The one reason a conversation needs the operator, by signal precedence: an
 * orchestrator's open bridge ask, then a structured question or plan, the
 * screen-scrape permission fallback, and an owed message delivery. Null when
 * none of them holds. A dismissed reason is still returned, with its
 * `dismissal`, so a card can say who cleared it; `attentionId` is what counts.
 *
 * The ids stay byte-identical to the historical inline derivations, so the
 * toast and push dedupe (`push-sent.json`) and the cycle pointer survive.
 */
export function attentionReason(file: FileEntry, now: number = Date.now() / 1000): ConversationReason | null {
  const reason = undismissedReason(file, now);
  if (!reason) return null;
  return { ...reason, dismissal: dismissalCovers(reason, file.attentionDismissal) ? file.attentionDismissal! : null };
}

function undismissedReason(file: FileEntry, now: number): ConversationReason | null {
  /* First, and above the file's own signals (issue #1168). A bridge ask is the
     manager saying, in as many words, that it cannot go on without the
     operator — the one signal on this board that was ESCALATED rather than
     inferred. The report's own key carries through as the queue identity, so
     re-reading the log cannot enqueue the same decision twice. */
  const ask = openBridgeAsk(file, now);
  if (ask) {
    /* `openBridgeAsk` already refused an unparseable time. */
    const at = isoSeconds(ask.at)!;
    return { kind: "decision", id: ask.id, since: at, raisedAt: at, clocked: true, header: null, dismissal: null };
  }
  const pending = file.pendingQuestion;
  if (pending) {
    const asked = isoSeconds(pending.askedAt);
    const since = asked ?? file.mtime;
    return {
      kind: pending.kind === "plan" ? "plan" : "question",
      id: pending.toolUseId,
      since,
      raisedAt: since,
      clocked: asked !== null,
      header: pending.kind === "plan" ? null : pending.questions?.[0]?.header?.trim() || null,
      dismissal: null,
    };
  }
  if (file.waitingInput) {
    const since = file.waitingInput.since;
    return { kind: "permission", id: `${file.path}:waiting:${Math.floor(since)}`, since, raisedAt: since, clocked: true, header: null, dismissal: null };
  }
  const deliverySince = blockingStuckDelivery(file, now);
  if (deliverySince !== null) {
    /* It asks from the moment it crossed the half hour, or from admission when
       the record already calls it uncertain. A card's dismissal names this id,
       which the next message's later admission changes. */
    const raisedAt = file.stuckDelivery?.state === "delivery-uncertain"
      ? deliverySince
      : deliverySince + DELIVERY_UNCERTAIN_MS / 1000;
    return {
      kind: "delivery",
      id: `${file.path}:delivery:${Math.floor(deliverySince)}`,
      since: deliverySince,
      raisedAt,
      clocked: true,
      header: null,
      dismissal: null,
    };
  }
  return null;
}

/**
 * The shared attention identity of a file: its reason's id while that reason
 * is flagged, or null when there is none or it was dismissed. The id doubles
 * as the dedupe key of the toast and push pipelines.
 */
export function attentionId(file: FileEntry, now: number = Date.now() / 1000): string | null {
  const reason = attentionReason(file, now);
  return reason && !reason.dismissal ? reason.id : null;
}

/**
 * Ordered queue of every agent needing operator attention, oldest signal
 * first, id as the tie-breaker. The sort keys are frozen at enqueue (`since`
 * never moves while the id is unchanged), so polls cannot reshuffle the order.
 */
export function buildAttentionQueue(
  files: FileEntry[],
  now: number = Date.now() / 1000,
  project?: string,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const file of files) {
    if (project !== undefined && projectKey(file) !== project) continue;
    const reason = attentionReason(file, now);
    if (!reason || reason.dismissal) continue;
    items.push({ id: reason.id, file, project: projectKey(file), tier: "blocked", since: reason.since, reason });
  }
  return items.sort(
    (a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.since - b.since || a.id.localeCompare(b.id),
  );
}

/**
 * Id-anchored cycle step: the pointer follows its id through reorderings, so
 * an item answered elsewhere silently drops out and the next press serves the
 * next-oldest remaining item (queue head forward, tail backward). Wraps.
 */
export function nextAttention<T extends { id: string }>(
  queue: readonly T[],
  currentId: string | null,
  dir: 1 | -1,
): T | null {
  if (!queue.length) return null;
  const index = currentId === null ? -1 : queue.findIndex((item) => item.id === currentId);
  if (index === -1) return dir === 1 ? queue[0]! : queue[queue.length - 1]!;
  return queue[(index + dir + queue.length) % queue.length]!;
}

/** The one cycle pointer every advancing surface shares — a plain mutable cell
    (a React ref satisfies it as-is). */
export interface AttentionCyclePointer {
  current: string | null;
}

/**
 * Advance the shared cycle pointer over a queue and return the item served.
 * Every advancing surface — the N/Shift-N keys over the project queue, the
 * island's visible Next over the global queue — moves the SAME pointer through
 * this one function, so the routes cannot diverge: whichever advanced last,
 * the next advance continues from that id. Delegates the step itself to
 * `nextAttention` (the sole authority); an empty queue leaves the pointer
 * untouched.
 */
export function advanceAttentionCycle<T extends { id: string }>(
  pointer: AttentionCyclePointer,
  queue: readonly T[],
  dir: 1 | -1,
): T | null {
  const next = nextAttention(queue, pointer.current, dir);
  if (next) pointer.current = next.id;
  return next;
}
