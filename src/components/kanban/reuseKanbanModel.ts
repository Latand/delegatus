import type { KanbanCard, KanbanColumn, KanbanModel } from "./kanbanModel";
import { KANBAN_STATUSES } from "./kanbanModel";

/**
 * A catalog update rebuilds the whole model, and every card in it is a fresh
 * object even when nothing on it changed. A card is memoized on its props, so
 * a fresh object re-renders it, and one changed file row re-rendered all of the
 * board's cards (#2218). The rebuild stays: it is what keeps the model
 * correct. What this adds is identity. A card whose content equals its
 * namesake of the previous model is that namesake, so a card re-renders only
 * when something it shows changed.
 */

/** A level this deep in a card is not data the data layer produced. */
const MAX_DEPTH = 24;

function plain(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Equal content, comparing by reference first: rows the files layer carried
 * over unchanged (`patchRows`) are the same object in both models, so the walk
 * stops at them and only what the rebuild made again is compared. A Map is
 * compared entry by entry and a Set by its members; a Date or a class instance
 * has no content to compare here and is equal only when it is the same object.
 */
export function structurallyEqual(left: unknown, right: unknown, depth = 0): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  if (depth >= MAX_DEPTH) return false;
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) if (!structurallyEqual(left[index], right[index], depth + 1)) return false;
    return true;
  }
  if (left instanceof Map || right instanceof Map) {
    if (!(left instanceof Map && right instanceof Map) || left.size !== right.size) return false;
    for (const [key, value] of left) if (!right.has(key) || !structurallyEqual(value, right.get(key), depth + 1)) return false;
    return true;
  }
  if (left instanceof Set || right instanceof Set) {
    if (!(left instanceof Set && right instanceof Set) || left.size !== right.size) return false;
    for (const value of left) if (!right.has(value)) return false;
    return true;
  }
  if (Array.isArray(right) || !plain(left) || !plain(right)) return false;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key)) return false;
    if (!structurallyEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], depth + 1)) return false;
  }
  return true;
}

function sameElements<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** `next`'s cards, each replaced by its namesake in `previous` when their content is equal. */
function reuseList(cards: readonly KanbanCard[], previousById: ReadonlyMap<string, KanbanCard>, previousList: readonly KanbanCard[] | undefined): KanbanCard[] {
  const reused = cards.map((card) => {
    const earlier = previousById.get(card.id);
    return earlier && structurallyEqual(earlier, card) ? earlier : card;
  });
  return previousList && sameElements(previousList, reused) ? previousList as KanbanCard[] : reused;
}

/**
 * `next` with every card, list and column that holds what it held in
 * `previous` replaced by the previous one; `previous` itself when the whole
 * model is unchanged. Nothing in either model is mutated.
 */
export function reuseKanbanModel(previous: KanbanModel | null, next: KanbanModel): KanbanModel {
  if (!previous) return next;
  const previousById = new Map<string, KanbanCard>();
  const remember = (cards: readonly KanbanCard[]) => { for (const card of cards) previousById.set(card.id, card); };
  for (const status of KANBAN_STATUSES) remember(previous.columns[status].cards);
  remember(previous.unlinked);
  remember(previous.hiddenGroups);

  const columns = {} as Record<(typeof KANBAN_STATUSES)[number], KanbanColumn>;
  for (const status of KANBAN_STATUSES) {
    const was = previous.columns[status];
    const now = next.columns[status];
    const cards = reuseList(now.cards, previousById, was.cards);
    const shown = reuseList(now.shown, previousById, was.shown);
    columns[status] = cards === was.cards && shown === was.shown && now.working === was.working && now.needsYou === was.needsYou
      && now.stopped === was.stopped && now.noReason === was.noReason
      ? was
      : { ...now, cards, shown };
  }
  const unlinked = reuseList(next.unlinked, previousById, previous.unlinked);
  const unlinkedShown = reuseList(next.unlinkedShown, previousById, previous.unlinkedShown);
  const hiddenGroups = reuseList(next.hiddenGroups, previousById, previous.hiddenGroups);
  const resurfaced = next.resurfaced.map((entry) => {
    const earlier = previous.resurfaced.find((candidate) => candidate.card.id === entry.card.id && candidate.reason === entry.reason);
    const card = previousById.get(entry.card.id);
    return earlier && card && structurallyEqual(card, entry.card) ? earlier : { ...entry, card: card && structurallyEqual(card, entry.card) ? card : entry.card };
  });
  const same = KANBAN_STATUSES.every((status) => columns[status] === previous.columns[status])
    && unlinked === previous.unlinked && unlinkedShown === previous.unlinkedShown && hiddenGroups === previous.hiddenGroups
    && sameElements(resurfaced, previous.resurfaced)
    && structurallyEqual(next.offBoard, previous.offBoard) && structurallyEqual(next.seatTasks, previous.seatTasks)
    && structurallyEqual(next.totals, previous.totals);
  if (same) return previous;
  return {
    ...next,
    columns,
    unlinked,
    unlinkedShown,
    offBoard: structurallyEqual(next.offBoard, previous.offBoard) ? previous.offBoard : next.offBoard,
    seatTasks: structurallyEqual(next.seatTasks, previous.seatTasks) ? previous.seatTasks : next.seatTasks,
    hiddenGroups,
    resurfaced: sameElements(resurfaced, previous.resurfaced) ? previous.resurfaced : resurfaced,
    totals: structurallyEqual(next.totals, previous.totals) ? previous.totals : next.totals,
  };
}
