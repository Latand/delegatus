import type { TFunction } from "@/lib/i18n";
import type { FrameRole } from "@/lib/roleFrames";
import { mobileRowState, type MobileRowDot, type MobileRowStateKey } from "@/components/mobile/mobileBoardModel";

import { readerFrameRole, readerNames, type ReaderView } from "./KanbanReaders";

/**
 * The agents open on the board, for the rail at its side: every reader the
 * operator opened in a card, in the order they were opened, each with the
 * short name, role and state its reader shows. A conversation no card holds,
 * open only in the whole window, and one a Stages pane shows without a reader
 * of its own are not open on the board and are not listed.
 */
export interface OpenAgent {
  key: string;
  name: string;
  /** The card the agent is open on, when that says more than the name. */
  card: string | null;
  role: FrameRole;
  /** The reader header's dot: its tone and whether the agent is at work. */
  tone: MobileRowDot;
  live: boolean;
  state: MobileRowStateKey;
}

export function openAgents(t: TFunction, views: readonly ReaderView[], open: readonly { key: string }[], now: number): OpenAgent[] {
  const byKey = new Map(views.map((view) => [view.readerKey, view] as const));
  return open.flatMap(({ key }) => {
    const view = byKey.get(key);
    if (!view) return [];
    const row = mobileRowState(view.file, now);
    const { name, card } = readerNames(t, view);
    return [{
      key,
      name,
      card,
      role: readerFrameRole(view),
      tone: row.dot,
      live: row.key === "working",
      state: row.key,
    }];
  });
}

/** The agent a cycling step lands on: the next (or previous) after the
    current one, round the end; the first (or last) when none is current. */
export function cycleOpenAgent(keys: readonly string[], current: string | null, step: 1 | -1): string | null {
  if (!keys.length) return null;
  const at = current === null ? -1 : keys.indexOf(current);
  if (at < 0) return step === 1 ? keys[0]! : keys[keys.length - 1]!;
  return keys[(at + step + keys.length) % keys.length]!;
}
