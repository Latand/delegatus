/*
 * Whether the board's cards start open. A card is closed by default
 * (docs/design/calm-task-cards-build.md §6.1); the evidence fixture and the
 * DOM suites whose subject is not the card face start them open, so their
 * setup reads lane rows, tiles and the foot as before.
 */

let openByDefault = false;

export function setKanbanCardsOpenByDefault(open: boolean): void {
  openByDefault = open;
}

export function kanbanCardsOpenByDefault(): boolean {
  return openByDefault;
}
