import type { FocusFrameIndex } from "@/lib/attention/resolve";
import type { FocusRect } from "@/lib/attention/types";
import { conversationIdentity } from "@/lib/accounts/identity";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";
import { stageAttempts } from "@/components/pipelines/pipelineModel";

import { KANBAN_STATUSES, type KanbanCard, type KanbanModel } from "./kanbanModel";

/**
 * The kanban board's half of a focus handoff (#688, #1695 K3 C6).
 *
 * The board has no camera, so a request's anchor resolves to the CARD that
 * holds it, and arrival is read off the page: a card on screen for `show`, and
 * for `open` the conversation's reader, expanded, on screen and settled. The
 * frame rects are the cards' places in the board's own order — enough for the
 * resolution to say `exact` or `approximate`; nothing measures them as pixels.
 */

/** A reader or card must show at least this much of itself to count as seen. */
export const ARRIVAL_MIN_VISIBLE_PX = 48;

export interface ConversationOwner {
  cardId: string;
  file: FileEntry;
  /** The pipeline stage this conversation runs, shown under the card's pipeline. */
  stage: { pipeline: Pipeline; stage: PipelineStage } | null;
}

/**
 * Conversation identity → the card that shows it. A card's own conversations
 * come first; then every loaded attempt of a stage in a pipeline the card
 * carries, so an older attempt opens under the same card as its stage.
 */
export function conversationOwners(cards: readonly KanbanCard[], files: readonly FileEntry[]): Map<string, ConversationOwner> {
  const owners = new Map<string, ConversationOwner>();
  for (const card of cards) {
    for (const member of card.members) {
      const key = conversationIdentity(member.file);
      if (!owners.has(key)) owners.set(key, { cardId: card.id, file: member.file, stage: member.stage });
    }
  }
  const byPath = new Map(files.map((file) => [file.path, file] as const));
  const byConversation = new Map(files.filter((file) => file.conversationId).map((file) => [file.conversationId!, file] as const));
  for (const card of cards) {
    for (const { pipeline } of card.pipelines) {
      for (const stage of pipeline.stages) {
        for (const attempt of stageAttempts(pipeline, stage.id)) {
          const file = (attempt.agentPath ? byPath.get(attempt.agentPath) : undefined)
            ?? (attempt.conversationId ? byConversation.get(attempt.conversationId) : undefined);
          if (!file) continue;
          const key = conversationIdentity(file);
          if (!owners.has(key)) owners.set(key, { cardId: card.id, file, stage: { pipeline, stage } });
        }
      }
    }
  }
  return owners;
}

export function allCards(model: KanbanModel): KanbanCard[] {
  return [...KANBAN_STATUSES.flatMap((status) => model.columns[status].cards), ...model.unlinked];
}

/** Anchor key → the card that holds it, for every anchor a card can stand for. */
export function cardAnchors(cards: readonly KanbanCard[], owners: ReadonlyMap<string, ConversationOwner>): Map<string, string> {
  const anchors = new Map<string, string>();
  for (const owner of owners.values()) {
    if (!anchors.has(owner.file.path)) anchors.set(owner.file.path, owner.cardId);
  }
  for (const card of cards) {
    if (card.task) anchors.set(`task::${card.task.id}`, card.id);
    for (const { pipeline } of card.pipelines) {
      if (!anchors.has(`group::pipeline::${pipeline.id}`)) anchors.set(`group::pipeline::${pipeline.id}`, card.id);
      for (const stage of pipeline.stages) {
        const key = `slot::${pipeline.id}::${stage.id}`;
        if (!anchors.has(key)) anchors.set(key, card.id);
      }
    }
  }
  return anchors;
}

export function kanbanFocusIndex(model: KanbanModel, anchors: ReadonlyMap<string, string>, project: string): FocusFrameIndex {
  const place = new Map<string, FocusRect>();
  KANBAN_STATUSES.forEach((status, column) => {
    model.columns[status].cards.forEach((card, row) => place.set(card.id, { x: column * 1000, y: row * 200, w: 600, h: 180 }));
  });
  model.unlinked.forEach((card, row) => {
    if (!place.has(card.id)) place.set(card.id, { x: 0, y: (model.columns.inbox.cards.length + row) * 200, w: 600, h: 180 });
  });
  const rectOf = (key: string) => {
    const cardId = anchors.get(key);
    return cardId ? place.get(cardId) ?? null : null;
  };
  return {
    project,
    boardRevision: null,
    rectFor: rectOf,
    concreteAnchorKey: (key) => (rectOf(key) ? key : null),
  };
}

function visibleBox(element: Element, clips: readonly Element[]): { width: number; height: number } {
  const rect = element.getBoundingClientRect();
  let top = Math.max(rect.top, 0);
  let bottom = Math.min(rect.bottom, window.innerHeight);
  let left = Math.max(rect.left, 0);
  let right = Math.min(rect.right, window.innerWidth);
  for (const clip of clips) {
    const box = clip.getBoundingClientRect();
    top = Math.max(top, box.top);
    bottom = Math.min(bottom, box.bottom);
    left = Math.max(left, box.left);
    right = Math.min(right, box.right);
  }
  return { width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function onScreen(element: Element, root: Element): boolean {
  /* The full-window reader has the window for its box. */
  const clips: Element[] = element.closest(".reader-full") ? [] : [root];
  if (clips.length) {
    const body = element.closest(".col-body");
    if (!body) return false;
    const column = body.closest(".column");
    if (column && window.getComputedStyle(column).display === "none") return false;
    clips.push(body);
    const page = root.querySelector(".kb-page");
    if (page) clips.push(page);
  }
  const box = visibleBox(element, clips);
  return box.width > 0 && box.height >= ARRIVAL_MIN_VISIBLE_PX;
}

/** The card is in a displayed column and shows at least 48 px of itself. */
export function cardOnScreen(root: HTMLElement, cardId: string, escape: (value: string) => string): boolean {
  const card = root.querySelector(`.card[data-id="${escape(cardId)}"]`);
  return card ? onScreen(card, root) : false;
}

/**
 * The structural reader arrival: the conversation's reader is in a slot (never
 * the park), expanded, shows at least 48 px inside its column body, and its
 * feed has settled — rows, or the empty state an empty transcript settles on.
 * No amount of text is required.
 */
export function readerArrived(root: HTMLElement, slot: HTMLElement | null): boolean {
  if (!slot?.isConnected || !root.contains(slot)) return false;
  const reader = slot.querySelector<HTMLElement>("[data-kanban-reader]");
  if (!reader || reader.dataset.folded === "1") return false;
  const feed = reader.querySelector<HTMLElement>("[data-feed-state]");
  const settled = feed?.dataset.feedState === "items" || feed?.dataset.feedState === "empty";
  return settled && onScreen(reader, root);
}
