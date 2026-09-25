import type { TaskStatus } from "@/lib/tasks/types";

export type KanbanLayoutMode = "wide" | "narrow" | "scroll" | "tabs";

/** Prototype `layoutMode`, measured on the board's own width. Below 768 px the
    desktop board is tabbed; the phone layout starts below 640 px and never
    mounts this component. */
export function kanbanLayoutMode(width: number): KanbanLayoutMode {
  if (width >= 1400) return "wide";
  if (width >= 1200) return "narrow";
  if (width >= 768) return "scroll";
  return "tabs";
}

/** The grid's four column tracks, written onto the board as `--c-<status>`.
    Only the grid modes have tracks; the scroller and the tabs lay their
    columns out as flex items.

    A project board in the wide mode balances its columns: each shelf grows
    from its 264 px by an equal third of 35 % of what Assigned held beyond the
    shelves, so Assigned keeps 65 % of the width it had with the shelves
    capped (`--shelf-balanced` in kanbanBoard.css), and never less than
    `--work-min`. The narrow mode keeps its fixed 220 px shelves, and the
    cross-project Overview keeps its capped shelves.

    A shelf holding reading (an open conversation, an agent draft, `+ Task`
    composing) gets at least the reading width and never less than a balanced
    shelf. The wide share (#1841) goes to the shelf the operator widened, and
    Assigned takes a shelf's track. */
export function kanbanColumnTracks(
  mode: KanbanLayoutMode,
  { overview, wide, reading }: { overview: boolean; wide: TaskStatus | null; reading: ReadonlySet<TaskStatus> },
): Record<`--c-${TaskStatus}`, string> | null {
  if (mode !== "wide" && mode !== "narrow") return null;
  const balanced = mode === "wide" && !overview;
  const shelf = mode === "narrow" ? "220px" : balanced ? "minmax(232px, var(--shelf-balanced))" : "minmax(232px, var(--shelf-w))";
  const work = mode === "narrow" ? "minmax(440px, 1fr)" : "minmax(var(--work-min), 1fr)";
  const tracks: Record<`--c-${TaskStatus}`, string> = { "--c-inbox": shelf, "--c-assigned": work, "--c-blocked": shelf, "--c-done": shelf };
  if (reading.size) {
    tracks["--c-assigned"] = "minmax(440px, 1fr)";
    for (const status of reading) tracks[`--c-${status}`] = balanced ? "minmax(420px, max(460px, var(--shelf-balanced)))" : "minmax(420px, 460px)";
  }
  if (wide) {
    tracks["--c-assigned"] = shelf;
    tracks[`--c-${wide}`] = work;
  }
  return tracks;
}

/** The columns' mode beside a seat docked at the side (#1841). The seat is the
    operator's choice, so it never costs them the columns: where the board
    alone would still show them, what the seat leaves scrolls rather than
    folding into tabs. */
export function kanbanLayoutModeBeside(width: number, seatWidth: number): KanbanLayoutMode {
  const mode = kanbanLayoutMode(width - seatWidth);
  return mode === "tabs" && seatWidth > 0 && kanbanLayoutMode(width) !== "tabs" ? "scroll" : mode;
}

/** The open-agents rail at the board's side: its names and roles, or the
    count alone. */
export type OpenRailTier = "full" | "compact";

/** The rail's width in each tier, padding included; the stylesheet draws
    inside it. */
export const OPEN_RAIL_WIDTH: Readonly<Record<OpenRailTier, number>> = { full: 200, compact: 48 };

/** The rail takes its own strip beside the columns, so it covers nothing on
    them. It shows its names while that strip leaves the columns the mode they
    would have beside the count alone, and keeps a scrolling board at least
    768 px wide; otherwise it is the count. */
export function openRailTier(width: number): OpenRailTier {
  const full = width - OPEN_RAIL_WIDTH.full;
  return full >= 768 && kanbanLayoutMode(full) === kanbanLayoutMode(width - OPEN_RAIL_WIDTH.compact) ? "full" : "compact";
}
