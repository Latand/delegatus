import type { TFunction } from "@/lib/i18n";
import { conversationFrameRole, type FrameRole } from "@/lib/roleFrames";
import type { PipelineStage } from "@/lib/pipelines/types";
import { mobileRowState, type MobileRowDot, type MobileRowState, type MobileRowStateKey } from "@/components/mobile/mobileBoardModel";

import { isSettledLaunchPlaceholder } from "@/components/launchHistoryModel";

import { readerFrameRole, readerNames, type ReaderView } from "./KanbanReaders";

/**
 * The agents open on the board, for the agent window's list: every
 * conversation the operator opened, in the order they were opened, each with
 * the short name, role and state its reader shows, then every stage whose
 * first message the operator opened before the stage started, in the order
 * they were opened. One a Stages pane shows without being opened is not listed.
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
  activity?: MobileRowState["activity"];
  /** A launch placeholder that settled: it reads the phone's finished word. */
  settledLaunch?: boolean;
  /** A stage's first message says its state in the words its head uses. */
  stateWord?: string;
}

/* A stage's first message open in the window. Its key starts with a word and
   a tab, which no conversation identity (an id or a transcript path) does. */
const STAGE_DRAFT_AGENT = "stage\t";

export const stageDraftAgentKey = (cardId: string, pipelineId: string, stageId: string) => `${STAGE_DRAFT_AGENT}${cardId}\t${pipelineId}\t${stageId}`;

export function isStageDraftAgent(key: string | null | undefined): key is string {
  return typeof key === "string" && key.startsWith(STAGE_DRAFT_AGENT);
}

export function parseStageDraftAgent(key: string): { cardId: string; pipelineId: string; stageId: string } | null {
  if (!isStageDraftAgent(key)) return null;
  const [cardId = "", pipelineId = "", stageId = ""] = key.slice(STAGE_DRAFT_AGENT.length).split("\t");
  return cardId && pipelineId && stageId ? { cardId, pipelineId, stageId } : null;
}

/** A first message's row: the stage's name with its card's title, its role, a
    dot that is not live, and the state word of the draft's own head. */
export function stageDraftAgent(key: string, input: { name: string; card: string; stage: PipelineStage; stateWord: string }): OpenAgent {
  return {
    key,
    name: input.name,
    card: input.card !== input.name ? input.card : null,
    role: conversationFrameRole({ stage: input.stage }),
    tone: "neutral",
    live: false,
    state: "waiting",
    stateWord: input.stateWord,
  };
}

/** The state word a first message's head says: waiting for its stage, its stage started, or its pipeline ended. */
export function stageDraftStateKey(started: boolean, ended: boolean): "kanban.draft.state" | "kanban.draft.stateStarted" | "kanban.draft.stateEnded" {
  return ended ? "kanban.draft.stateEnded" : started ? "kanban.draft.stateStarted" : "kanban.draft.state";
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
      activity: row.activity,
      settledLaunch: isSettledLaunchPlaceholder(view.file),
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
