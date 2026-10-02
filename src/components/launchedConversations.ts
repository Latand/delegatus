import { conversationIdentity } from "@/lib/accounts/identity";
import type { FileEntry } from "@/lib/types";

/**
 * The conversations this page launched from an agent draft.
 *
 * The draft pane records each launch here (`DraftAgentPane`), and every surface
 * that draws the conversation can keep its geometry steady from the first paint.
 * A draft pane is a window of a fixed height, and its launch becomes a reader
 * in the same place. A reader sized to its content would open short and grow
 * with every row the agent writes, pushing its own composer and every card
 * below it down on each chunk. A launched reader keeps the draft's height
 * instead and scrolls inside it, so the card does not move from the send to
 * the end of the turn. On the phone the strip naming the conversation's task
 * arrives a poll after the pane, so the pane holds the strip's row from the
 * start. A conversation opened by the operator is not recorded here and sizes
 * to its content as before.
 */
const launched = new Set<string>();
const KEEP = 64;

export function markLaunchedConversation(file: Pick<FileEntry, "conversationId" | "path">): void {
  const id = conversationIdentity(file);
  launched.delete(id);
  launched.add(id);
  for (const oldest of launched) {
    if (launched.size <= KEEP) break;
    launched.delete(oldest);
  }
}

/** The clock a launch's hold is counted on. */
export function launchClockMs(): number {
  return Date.now();
}

export function isLaunchedConversation(file: Pick<FileEntry, "conversationId" | "path">): boolean {
  return launched.has(conversationIdentity(file));
}

/** How long a sent draft waits for the card its launch becomes before the board lets it go. */
export const LAUNCH_HOLD_MS = 5_000;
