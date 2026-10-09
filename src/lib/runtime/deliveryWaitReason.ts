/**
 * Why an accepted message has not reached its agent yet: the one vocabulary
 * every delivery surface writes and reads.
 *
 * The delivery queue records one of these on each message it holds, the
 * receipt answers it, and the composer translates it. A hold placed while the
 * conversation switches accounts uses the same codes (`switching-accounts`,
 * `switch-after-turn`), so a message waiting on a switch and one waiting on a
 * turn are told apart by one field.
 */
export const DELIVERY_WAIT_REASONS = [
  /** Accepted into the delivery journal; the queue takes it on its next pass. */
  "queued",
  /** No drain pass reached it when one was due; the watchdog started one. */
  "wake-lost",
  /** An earlier delivery step on the same conversation is still running. */
  "conversation-busy",
  /** The agent is mid-turn and the message goes out when the turn ends. */
  "awaiting-turn",
  /** The running turn was interrupted for this message; waiting for it to stop. */
  "interrupting",
  /** The interrupt made no progress for thirty seconds: the host's own evidence
      for this message is being checked and the interrupt issued again under
      the same key. */
  "interrupt-reconciling",
  /** Nothing is hosting the conversation. */
  "awaiting-host",
  /** A host is being started for this message. */
  "recovering-host",
  /** Starting a host was refused by a concurrent attempt; retried on a schedule. */
  "recovery-contended",
  /** The journal or the host's state could not be read; nothing was sent. */
  "evidence-unreadable",
  /** An automatic update holds new deliveries until it hands over. */
  "update-handoff",
  /** An update drain holds new agent-started work. */
  "update-drain",
  /** A compaction of this conversation is in flight. */
  "compacting",
  /** The conversation is switching accounts; the message goes out right after. */
  "switching-accounts",
  /** The switch waits for the running turn to end; the message goes out after it. */
  "switch-after-turn",
  /** The account switch failed and holds the conversation's messages. */
  "switch-failed",
  /** Startup has not registered this conversation's host yet. */
  "startup",
  /** The queue is reading or writing what the hand-over depends on (journal
      status, host state, writer claim, delivery record) and that step has not
      answered; the detail names the step. */
  "checking",
  /** The message is being handed to the agent now. */
  "dispatching",
] as const;

export type DeliveryWaitReason = typeof DELIVERY_WAIT_REASONS[number];

const REASONS: ReadonlySet<string> = new Set(DELIVERY_WAIT_REASONS);

export function isDeliveryWaitReason(value: unknown): value is DeliveryWaitReason {
  return typeof value === "string" && REASONS.has(value);
}

/** Reasons a message leaves within moments when delivery is healthy, so a
    long stay in one is recorded as a stall. */
export const ACTIVE_DELIVERY_PHASES: ReadonlySet<DeliveryWaitReason> = new Set<DeliveryWaitReason>([
  /* Accepted and never reached by a pass, or reached by passes that could
     not read what they need: either one lasting is a stall. */
  "queued",
  "evidence-unreadable",
  "checking",
  "dispatching",
  "interrupting",
  "interrupt-reconciling",
  "recovering-host",
]);
