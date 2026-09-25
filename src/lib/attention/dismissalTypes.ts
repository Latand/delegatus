/**
 * What a needs-you dismissal is (docs/design/needs-attention.md §5), in the
 * shapes the server writes and every surface reads. Browser-safe: no store and
 * no filesystem here, so the board's reason model can import it.
 *
 * A dismissal says one thing: whoever made it has seen the reasons a subject
 * carries up to this instant, so stop flagging them. Nothing else moves. No
 * question is answered, no lane changes state and no message is dropped, and a
 * reason that starts later comes back on its own.
 */

/** Who cleared it, attributed on the server and never taken from the caller.
    An agent's is the same shape the attention record's `raisedBy` carries. */
export type DismissedBy =
  | { kind: "operator"; surface?: "desktop" | "phone" }
  | { kind: "manager" | "agent" | "gateway" | "unidentified"; conversationId: string | null; role: string | null };

/** The reasons a conversation can need the operator for (§4). */
export type ConversationReasonKind = "decision" | "question" | "plan" | "permission" | "delivery";

/** The reasons a lane can need the operator for: a decision, a spent review
    budget, and a completed lane's merge that stopped (#2187 §4.6). */
export type LaneReasonKind = "lane-decision" | "lane-review" | "lane-merge";

/** A conversation's dismissal as `/api/files` projects it onto the entry. */
export interface AttentionDismissalMark {
  /** Server clock, ISO. */
  at: string;
  by: DismissedBy;
  /** The reason on screen when it was cleared, when the surface said. A mark
      that names one covers that reason and nothing else, so a card drawn
      before a new signal arrived cannot clear it. A mark without one (an
      agent's call) covers what started at or before `at`. */
  reasonId?: string | null;
}

/** One subject a dismissal touched. */
export type DismissalSubject =
  | { kind: "conversation"; conversationId: string }
  | { kind: "pipeline"; pipelineId: string };

/** What the caller asks to clear. A task expands to the subjects its card
    drew, when the caller names them, and otherwise to everything on it. */
export type DismissalTarget =
  | { kind: "conversation"; conversationId?: string; path?: string; reasonId?: string | null }
  | { kind: "pipeline"; pipelineId: string; laneMovedAt?: number | null }
  | { kind: "task"; taskId: string; subjects?: DismissalSubjectRequest[] }
  /** A card no task owns: the subjects it drew, and nothing else. The
      operator's route takes it; the MCP tool names one of the three above. */
  | { kind: "subjects"; subjects: DismissalSubjectRequest[] };

/** A subject named by a card: the member conversation (by id or path) with
    the reason the card drew for it, or a lane with the movement the card drew
    it at (`laneMovedAt`, epoch ms, null for a lane that never ran a round).
    A lane that moved since is not cleared. */
export type DismissalSubjectRequest =
  | { kind: "conversation"; conversationId?: string; path?: string; reasonId?: string | null; reason?: ConversationReasonKind | null }
  | { kind: "pipeline"; pipelineId: string; laneMovedAt?: number | null };

export interface DismissalOutcome {
  dismissed: DismissalSubject[];
  /** Subjects with nothing to clear: a lane that asks nothing, or one already
      cleared for the decision it waits on. Not an error. */
  alreadyClear: DismissalSubject[];
  /** Lanes that moved after the surface drew them: nothing was stamped, and
      they ask for what they wait on now. Not an error. */
  changed: DismissalSubject[];
  at: string;
  by: DismissedBy;
  undo: boolean;
}

const nullableString = (value: unknown): boolean => value === null || typeof value === "string";

/** The stored attribution's shape, for the stores that validate records. */
export function isDismissedBy(value: unknown): value is DismissedBy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const by = value as Record<string, unknown>;
  if (by.kind === "operator") return by.surface === undefined || by.surface === "desktop" || by.surface === "phone";
  return (by.kind === "manager" || by.kind === "agent" || by.kind === "gateway" || by.kind === "unidentified")
    && nullableString(by.conversationId) && nullableString(by.role);
}

/** Whether an attribution names the operator. */
export function dismissedByOperator(by: DismissedBy | null | undefined): boolean {
  return by?.kind === "operator";
}
