import type { Pipeline } from "@/lib/pipelines/types";
import type { TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { KANBAN_STATUSES, type KanbanCard, type KanbanMember, type KanbanModel, type KanbanPipeline } from "@/components/kanban/kanbanModel";
import { pipelineEnded, pipelineNeedsYou } from "@/components/pipelines/pipelineBlockModel";

import { mobileRowState, pipelineHiddenFromBoard, type MobileRowState } from "./mobileBoardModel";

/*
 * The phone's columns (#2072 slice 4; docs/design/phone-kanban.md §3.2, §3.4),
 * as one pure projection over the desktop's own `buildKanbanModel`. Nothing
 * here decides membership, status or counts again: a card is the desktop's
 * card, in the desktop's column, counted the way the desktop counts it. What
 * the phone adds is how a column of five or six visible cards is read:
 *
 * - Everything that needs the operator comes first, in the attention queue's
 *   order — the order the bar's ⚠ sheet and its Next › walk — task cards and
 *   Not on a task rows alike, so a tab's ⚠n counts exactly its first n items.
 *   The rest keep the desktop's order (latest agent work first).
 * - Done shows a window of the newest cards and counts them all.
 * - Inbox ends with Not on a task: the work no recorded task owns, less what
 *   the pin already drew. A draft is not work yet and has no row.
 * - Seat conversations and seat-only tasks never reach a column: the model is
 *   built with the seat, which takes them out (#1841).
 * - A lane the operator set aside — hidden for the decision it waits on
 *   (#1671), or closing inside its receipt's window — needs nothing from them
 *   here either, exactly as the ⚠ queue reads it; a closing lane no task owns
 *   is off the board on the tap.
 * - Each card names the one pipeline its line draws, what the others are
 *   doing, and whether an agents line has anything to say that line does not.
 *
 * i18n-free: it answers with facts, and `MobileKanban` says them.
 */

/** How many Done cards show before «Show 20 more» (§3.2). */
export const DONE_WINDOW = 20;

/** The column a first visit opens on: where the work is (§2.4). */
export const DEFAULT_COLUMN: TaskStatus = "assigned";

export type PhoneCardKind = "task" | "pipeline" | "conversation" | "flow";

/** Why a card needs the operator: one reason, which its badge and edge say. */
export type PhoneNeed =
  | { kind: "pipeline"; pipeline: Pipeline }
  | { kind: "conversation"; member: KanbanMember; state: MobileRowState };

export interface PhoneCard {
  /** The band id, stable across polls. */
  key: string;
  kind: PhoneCardKind;
  card: KanbanCard;
  need: PhoneNeed | null;
  /** The card's one coloured edge: the need's hue. A task's colour label
      takes the edge only when nothing is needed (the component draws it). */
  edge: "warning" | "danger" | null;
  /** The pipeline the card's line draws: the one that needs the operator, else
      the newest unfinished one, else the newest. */
  shown: KanbanPipeline | null;
  /** The card's other pipelines that are still going, by what they do. */
  others: { needs: number; running: number; paused: number };
  /** The card has pipelines and every one of them is over. */
  finished: boolean;
  /** The agents line, when it says something the pipeline line does not: a
      card with no pipeline, or agents working outside the shown pipeline. */
  agents: { working: number; conversations: number; atMs: number } | null;
  /** The conversation a Not on a task row opens and «Open first agent» opens:
      a working one first, else the band's first. */
  firstAgent: FileEntry | null;
}

export interface PhoneColumn {
  status: TaskStatus;
  /** The desktop column's count: every task in it. */
  count: number;
  /** Agents working on the column's cards (and, in Inbox, on its unlinked rows). */
  working: number;
  /** Items that need the operator; they are the column's first `needsYou` items. */
  needsYou: number;
  /** Everything that needs the operator, in attention order. */
  pinned: PhoneCard[];
  /** The column's other task cards, in the desktop's order; Done windowed. */
  cards: PhoneCard[];
  /** Inbox only: Not on a task, after the pin. */
  unlinked: PhoneCard[];
  /** Done cards past the window. */
  more: number;
}

export interface PhoneKanbanModel {
  columns: Record<TaskStatus, PhoneColumn>;
}

export interface PhoneKanbanInput {
  model: KanbanModel;
  /** The attention queue's order as `attentionKey` keys: the order the bar's
      ⚠ sheet lists and its Next › walks. */
  attention?: readonly string[];
  /** How many Done cards the operator has asked to see; `DONE_WINDOW` first. */
  doneShown?: number;
  /** Lanes whose close is on its way (#1671). */
  closing?: readonly string[];
  /** Epoch seconds, for the state of a conversation that needs the operator. */
  now: number;
}

/** The key an attention item carries into `PhoneKanbanInput.attention`. */
export const attentionKey = {
  conversation: (path: string) => `conversation:${path}`,
  pipeline: (id: string) => `pipeline:${id}`,
};

const RUNNING = new Set<Pipeline["state"]>(["running", "provisioning"]);

function kindOf(card: KanbanCard): PhoneCardKind | null {
  if (card.task) return "task";
  if (card.origin === "pipeline") return "pipeline";
  if (card.origin === "flow") return "flow";
  if (card.origin === "conversation") return "conversation";
  return null;
}

/** Which pipeline the card's line draws (§3.4). The summaries arrive newest
    agent work first. */
export function shownPipeline(pipelines: readonly KanbanPipeline[]): KanbanPipeline | null {
  return pipelines.find((summary) => pipelineNeedsYou(summary.pipeline))
    ?? pipelines.find((summary) => !pipelineEnded(summary.pipeline))
    ?? pipelines[0]
    ?? null;
}

function firstAgentOf(card: KanbanCard): FileEntry | null {
  return card.members.find((member) => member.working)?.file
    ?? card.members[0]?.file
    ?? card.mirrors[0]?.file
    ?? null;
}

/** Whether a lane asks the operator for anything now: parked on them, and not
    set aside — hidden for this decision or closing. */
function asks(pipeline: Pipeline, closing: ReadonlySet<string>): boolean {
  return pipelineNeedsYou(pipeline) && !pipelineHiddenFromBoard(pipeline) && !closing.has(pipeline.id);
}

/** Whether the card needs the operator, as the ⚠ queue reads it. */
function cardNeeds(card: KanbanCard, closing: ReadonlySet<string>): boolean {
  return card.members.some((member) => member.needsYou) || card.pipelines.some((summary) => asks(summary.pipeline, closing));
}

function phoneCard(card: KanbanCard, kind: PhoneCardKind, rank: ReadonlyMap<string, number>, now: number, closing: ReadonlySet<string>): PhoneCard {
  const shown = card.pipelines.find((summary) => asks(summary.pipeline, closing)) ?? shownPipeline(card.pipelines);
  const others = { needs: 0, running: 0, paused: 0 };
  for (const summary of card.pipelines) {
    if (summary === shown) continue;
    const state = summary.pipeline.state;
    if (pipelineNeedsYou(summary.pipeline)) others.needs += 1;
    else if (RUNNING.has(state)) others.running += 1;
    else if (state === "paused") others.paused += 1;
  }
  const finished = card.pipelines.length > 0 && card.pipelines.every((summary) => pipelineEnded(summary.pipeline));

  /* One reason, the one that asked first: its words are the badge and its hue
     the edge, so a card never draws two status colours (§3.4). A lane the
     queue does not rank still outranks a conversation it does not rank. */
  let need: PhoneNeed | null = null;
  let best = Infinity;
  for (const summary of card.pipelines) {
    if (!asks(summary.pipeline, closing)) continue;
    const at = rank.get(attentionKey.pipeline(summary.pipeline.id)) ?? Infinity;
    if (!need || at < best) {
      need = { kind: "pipeline", pipeline: summary.pipeline };
      best = at;
    }
  }
  for (const member of card.members) {
    if (!member.needsYou) continue;
    const at = rank.get(attentionKey.conversation(member.file.path)) ?? Infinity;
    if (!need || at < best) {
      need = { kind: "conversation", member, state: mobileRowState(member.file, now) };
      best = at;
    }
  }
  const edge = need?.kind === "conversation" ? need.state.edge ?? "warning" : need ? "warning" : null;

  const shownId = shown?.pipeline.id ?? null;
  const outside = card.members.filter((member) => member.working && member.stage?.pipeline.id !== shownId).length;
  const atMs = card.lastAgentWorkAtMs > 0 ? card.lastAgentWorkAtMs : card.updatedAtMs;
  const working = shown ? outside : card.working;
  /* A conversation that asks draws its own line, which already names the
     agent and its age; the agents line then only adds agents still working. */
  const says = need?.kind === "conversation" ? working > 0 : !shown || outside > 0;
  const agents = kind === "task" && says ? { working, conversations: card.conversations, atMs } : null;
  return { key: card.id, kind, card, need, edge, shown, others, finished, agents, firstAgent: firstAgentOf(card) };
}

/** Where each card stands in the attention queue: its earliest ask. */
function askRank(card: KanbanCard, rank: ReadonlyMap<string, number>, closing: ReadonlySet<string>): number {
  let best = Infinity;
  for (const summary of card.pipelines) {
    if (asks(summary.pipeline, closing)) best = Math.min(best, rank.get(attentionKey.pipeline(summary.pipeline.id)) ?? Infinity);
  }
  for (const member of card.members) {
    if (member.needsYou) best = Math.min(best, rank.get(attentionKey.conversation(member.file.path)) ?? Infinity);
  }
  return best;
}

export function buildPhoneKanban({ model, attention = [], doneShown = DONE_WINDOW, closing: closingIds = [], now }: PhoneKanbanInput): PhoneKanbanModel {
  const closing = new Set(closingIds);
  const rank = new Map<string, number>();
  attention.forEach((key, index) => {
    if (!rank.has(key)) rank.set(key, index);
  });
  /* Unlinked rows the phone can draw, in the desktop's order. */
  const unlinked = model.unlinked.flatMap((card) => {
    const kind = kindOf(card);
    if (!kind || kind === "task") return [];
    /* A lane no task owns leaves with its close, as the queue's row did. */
    if (kind === "pipeline" && card.pipelines.length > 0 && card.pipelines.every((summary) => closing.has(summary.pipeline.id))) return [];
    return [{ card, kind }];
  });
  const columns = Object.fromEntries(KANBAN_STATUSES.map((status) => {
    const column = model.columns[status];
    /* The desktop's order is the tie-break inside the pin: a need the queue
       does not rank keeps its place among the other unranked ones. */
    const candidates = [
      ...column.cards.map((card) => ({ card, kind: "task" as const })),
      ...(status === "inbox" ? unlinked : []),
    ].map((entry, order) => ({ ...entry, order }));
    const pinned = candidates
      .filter((entry) => cardNeeds(entry.card, closing))
      .map((entry) => ({ ...entry, at: askRank(entry.card, rank, closing) }))
      .sort((a, b) => a.at - b.at || a.order - b.order)
      .map((entry) => phoneCard(entry.card, entry.kind, rank, now, closing));
    const rest = column.cards.filter((card) => !cardNeeds(card, closing));
    const windowed = status === "done" ? rest.slice(0, Math.max(0, doneShown)) : rest;
    const loose = status === "inbox" ? unlinked.filter((entry) => !cardNeeds(entry.card, closing)) : [];
    const looseWorking = status === "inbox" ? unlinked.reduce((sum, entry) => sum + entry.card.working, 0) : 0;
    return [status, {
      status,
      count: column.cards.length,
      working: column.working + looseWorking,
      needsYou: pinned.length,
      pinned,
      cards: windowed.map((card) => phoneCard(card, "task", rank, now, closing)),
      unlinked: loose.map((entry) => phoneCard(entry.card, entry.kind, rank, now, closing)),
      more: rest.length - windowed.length,
    } satisfies PhoneColumn];
  })) as Record<TaskStatus, PhoneColumn>;
  return { columns };
}

/** The column an empty column points to (§3.9): the nearest one with work,
    the earlier of two at the same distance. */
export function nearestWithWork(columns: Record<TaskStatus, PhoneColumn>, from: TaskStatus): TaskStatus | null {
  const index = KANBAN_STATUSES.indexOf(from);
  for (let distance = 1; distance < KANBAN_STATUSES.length; distance += 1) {
    for (const candidate of [KANBAN_STATUSES[index - distance], KANBAN_STATUSES[index + distance]]) {
      if (!candidate) continue;
      const column = columns[candidate];
      if (column.count > 0 || column.unlinked.length > 0 || column.pinned.length > 0) return candidate;
    }
  }
  return null;
}

/** Whether a column draws nothing at all. */
export function columnEmpty(column: PhoneColumn): boolean {
  return column.pinned.length === 0 && column.cards.length === 0 && column.unlinked.length === 0 && column.more === 0;
}
