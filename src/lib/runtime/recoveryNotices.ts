import type { MessageOrigin } from "./messageOrigin";

/*
 * The messages Delegatus itself writes into a conversation it re-hosted after
 * a restart or a release. They arrive in the transcript as role=user records,
 * so every reader that tells the operator's input from anything else needs
 * their text: the activity dashboard's classifier excludes them, including the
 * ones written before they carried an origin (docs/design/activity-dashboard.md,
 * "Only real operator input counts").
 *
 * Pure on purpose: the classifier runs in the exporter, far from the runtime.
 */

/** Delivery authorship of a recovery notice: the Viewer, never the operator.
    A send with no origin is stamped operator by the Codex host. */
export const RECOVERY_NOTICE_ORIGIN: MessageOrigin = { kind: "agent", role: "startup-recovery" };

/** The standing prompt startup sends to every interrupted Codex conversation. */
export const INTERRUPTED_CODEX_CONTINUATION_TEXT = "Continue the interrupted turn from the transcript.";

/** The opening sentence of an interruption obligation's continuation, by the
    reason the turn was cut. */
export const VIEWER_RELEASE_INTERRUPTION_OPENING =
  "A Viewer deployment interrupted your turn while it was in flight: the Viewer that hosted you was replaced and this conversation was re-hosted by its successor.";
export const VIEWER_RESTART_INTERRUPTION_OPENING = "Viewer restarted and severed your structured host mid-turn.";

/** Whether a user record's text, its delivery marker already dropped, is one
    of these notices. */
export function isRecoveryNotice(body: string): boolean {
  const text = body.trim();
  return text === INTERRUPTED_CODEX_CONTINUATION_TEXT
    || text.startsWith(VIEWER_RELEASE_INTERRUPTION_OPENING)
    || text.startsWith(VIEWER_RESTART_INTERRUPTION_OPENING);
}
