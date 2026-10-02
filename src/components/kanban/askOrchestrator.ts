import { addTaskChip, removeTaskChip, type TaskChip } from "@/components/orchestrator/taskChips";

import { expandKanbanSeat } from "./kanbanSeatStore";

/** Calls `callback` on a later animation frame. Injected so a test steps frames by hand. */
type Schedule = (callback: () => void) => void;

const nextFrame: Schedule = (callback) => {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(callback);
  else setTimeout(callback, 0);
};

/**
 * Runs `change`, then puts the card back where the operator saw it.
 *
 * Opening or expanding the orchestrator seat above the columns pushes the board
 * down inside its page scroller, which carries the card away from the pointer
 * that just pressed its button. Two frames later (React has rendered the seat
 * and the browser has laid it out) the page scroller is moved by exactly the
 * distance the card travelled, so the board looks like it never moved. A card
 * that left the page, or one with no page scroller above it, is left alone.
 */
export function holdCardInPlace(card: HTMLElement, change: () => void, schedule: Schedule = nextFrame): void {
  const before = card.getBoundingClientRect().top;
  change();
  schedule(() => schedule(() => {
    const scroller = card.closest<HTMLElement>(".kb-page");
    const moved = card.getBoundingClientRect().top - before;
    if (!scroller || !Number.isFinite(moved) || Math.abs(moved) < 1) return;
    scroller.scrollTop += moved;
  }));
}

/**
 * The card button's whole effect: attach the task to its project's orchestrator
 * composer as a chip and make sure that composer is on screen (the seat expands;
 * the shell opens the dock when the board shows one), without the board moving
 * away from the card. Pressed again, it takes the chip back off. `onAttached`
 * runs once the chip is on: the board says so at the card, because holding the
 * card in place leaves a folded seat's composer above the viewport.
 */
export function askOrchestratorAboutTask(
  card: HTMLElement | null,
  project: string,
  chip: TaskChip,
  attached = false,
  onAttached?: (chip: TaskChip) => void,
): void {
  /* A task already attached is taken back off: the button is a toggle, so the
     operator can undo it on the card they pressed, wherever the composer is. */
  if (attached) {
    removeTaskChip(project, chip.id);
    return;
  }
  const attach = () => {
    expandKanbanSeat(project);
    if (addTaskChip(project, chip)) onAttached?.(chip);
  };
  if (card) holdCardInPlace(card, attach);
  else attach();
}
