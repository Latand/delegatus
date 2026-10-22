import type { RuntimeSession } from "@/components/runtime/runtimeModel";

import type { CueRequest } from "./cues";

/**
 * S2 and S8 from the runtime stream (docs/design/sound-redesign.md §4.4).
 *
 * The tab-wide runtime bus carries every structured session's `item` and
 * `turn-ended` events, hidden desktop tabs included. Its subscribers receive
 * store snapshots without event detail, and `updateSession` replaces only the
 * changed session object, so the watcher compares session objects by identity
 * and examines only the sessions that changed: the work per notification
 * scales with what changed.
 *
 * - S2: a tool item id not seen before, in a session whose conversation has
 *   no live feed in this tab. Every live session is exactly one of S1 (its
 *   feed is running here) or S2 (it is not).
 * - S8: the end of the turn that carries this tab's message, or the first
 *   turn of this tab's launch.
 */

export type ReplyPolicy = "queue" | "steer-if-active" | "interrupt-active" | "launch";

interface AwaitedReply {
  activeTurnId: string | null;
  settledTurnId: string | null;
  policy: ReplyPolicy;
  at: number;
}

export const AWAITING_REPLY_CAPACITY = 64;
export const AWAITING_REPLY_TTL_MS = 2 * 3_600_000;

export interface AwaitingReplies {
  /**
   * Record that this tab is about to write to a conversation, with the turn
   * ids it shows at that moment. Returns the undo for a refused send.
   */
  expect(conversationId: string, turns: { activeTurnId: string | null; settledTurnId: string | null }, policy: ReplyPolicy): () => void;
  /** The reply this session's latest end earns, if any; settles the wait. */
  settle(session: RuntimeSession): CueRequest | null;
  /** Conversations waiting (tests, diagnostics). */
  size(): number;
}

/**
 * The «awaiting reply» set. The ordinary composer send interrupts a running
 * turn (policy `interrupt-active`), and the answer comes in a NEW turn, so a
 * wait is answered only by a turn other than both recorded ids that ended
 * `completed`. Comparing settled ids rather than waiting for a running
 * snapshot also covers a turn that starts and ends inside one batched
 * notification. Under `steer-if-active` the host may fold the message into
 * the running turn, so that turn completing answers too. A later turn ending
 * `interrupted` (a second send, the operator's own stop) keeps the wait;
 * `error` ends it silently.
 */
export function createAwaitingReplies(now: () => number = Date.now): AwaitingReplies {
  /** Insertion-ordered: the oldest wait is evicted first. */
  const waits = new Map<string, AwaitedReply>();
  const prune = (): void => {
    const clock = now();
    for (const [id, wait] of waits) if (clock - wait.at > AWAITING_REPLY_TTL_MS) waits.delete(id);
  };
  return {
    expect(conversationId, turns, policy) {
      prune();
      const wait: AwaitedReply = { ...turns, policy, at: now() };
      waits.delete(conversationId);
      waits.set(conversationId, wait);
      while (waits.size > AWAITING_REPLY_CAPACITY) waits.delete(waits.keys().next().value!);
      return () => {
        if (waits.get(conversationId) === wait) waits.delete(conversationId);
      };
    },

    settle(session) {
      const wait = waits.get(session.conversationId);
      if (!wait) return null;
      if (now() - wait.at > AWAITING_REPLY_TTL_MS) {
        waits.delete(session.conversationId);
        return null;
      }
      const ended = session.settledTurnId ?? null;
      if (!ended || ended === wait.settledTurnId) return null;
      const folded = wait.policy === "steer-if-active" && ended === wait.activeTurnId;
      if (ended === wait.activeTurnId && !folded) return null;
      const outcome = session.lastTurnOutcome ?? null;
      if (outcome === "interrupted") return null;
      waits.delete(session.conversationId);
      if (outcome !== "completed") return null;
      return { cue: "reply", eventId: `reply:${session.conversationId}:${ended}` };
    },

    size: () => waits.size,
  };
}

/** The tab's one awaiting set: the composer's sends and the new-agent card's launches fill it. */
export const awaitingReplies = createAwaitingReplies();

/** Tool item ids remembered per session; a turn's hot window is 32 items. */
const SEEN_TOOLS_PER_SESSION = 256;

export interface FleetCueWatcherOptions {
  hasLiveFeed(conversationId: string): boolean;
  awaiting: AwaitingReplies;
  play(request: CueRequest): void;
}

export interface FleetCueWatcher {
  /** One store notification: the current session map. */
  observe(sessions: Readonly<Record<string, RuntimeSession>>): void;
}

function toolItemIds(session: RuntimeSession): string[] {
  const ids: string[] = [];
  for (const item of session.liveTurn?.items ?? []) if (item.tool && item.itemId) ids.push(item.itemId);
  return ids;
}

export function createFleetCueWatcher(options: FleetCueWatcherOptions): FleetCueWatcher {
  let previous: Readonly<Record<string, RuntimeSession>> | null = null;
  const seenTools = new Map<string, Set<string>>();

  const remember = (conversationId: string, itemId: string): boolean => {
    let seen = seenTools.get(conversationId);
    if (!seen) {
      seen = new Set();
      seenTools.set(conversationId, seen);
    }
    if (seen.has(itemId)) return false;
    seen.add(itemId);
    if (seen.size > SEEN_TOOLS_PER_SESSION) seen.delete(seen.values().next().value!);
    return true;
  };

  /** Sessions with a running turn whose feed is not live here: S2's pace. */
  const agentsOffScreen = (sessions: Readonly<Record<string, RuntimeSession>>): number => {
    let count = 0;
    for (const session of Object.values(sessions)) {
      if (session.turn === "running" && !options.hasLiveFeed(session.conversationId)) count += 1;
    }
    return count;
  };

  return {
    observe(sessions) {
      if (previous === sessions) return;
      if (previous === null) {
        for (const session of Object.values(sessions)) {
          for (const itemId of toolItemIds(session)) remember(session.conversationId, itemId);
        }
        previous = sessions;
        return;
      }
      let offScreen: number | null = null;
      for (const [id, session] of Object.entries(sessions)) {
        if (previous[id] === session) continue;
        const live = options.hasLiveFeed(session.conversationId);
        for (const itemId of toolItemIds(session)) {
          if (!remember(session.conversationId, itemId) || live) continue;
          offScreen ??= agentsOffScreen(sessions);
          options.play({ cue: "distant-typing", eventId: `distant:${session.conversationId}:${itemId}`, agentsOffScreen: Math.max(1, offScreen) });
        }
        const reply = options.awaiting.settle(session);
        if (reply) options.play(reply);
      }
      for (const id of seenTools.keys()) if (!(id in sessions)) seenTools.delete(id);
      previous = sessions;
    },
  };
}
