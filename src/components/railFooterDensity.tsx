import type { ReactNode } from "react";

/**
 * How much room a rail footer block takes (docs/design/sidebar-redesign.md).
 * `line` is the desktop sidebar's system block: one row per reading in a
 * shared three-column grid. `detail` is the same block after "All windows":
 * the same rows, and under each account every limit window with its reset.
 * `full` is the phone's drawing of the memory and Telegram blocks, which the
 * sidebar does not use.
 */
export type RailFooterDensity = "full" | "line" | "detail";

/** The drawings of a block only the desktop sidebar mounts: the limits and Copilot lines. */
export type SidebarFooterDensity = Exclude<RailFooterDensity, "full">;

/** Where a footer line starts: the left edge the rail's project names and section labels share. */
export const LINE_EDGE = "pl-[19px] pr-3";

/**
 * The share of a resource still left: a shorter bar is worse in every block.
 * It always stands beside a reading that names the same share ("9.0 GiB free",
 * "left 12%"), so the number and the bar say one thing.
 */
export function ReserveBar({ percent, color, className = "w-10" }: { percent: number | null; color: string; className?: string }) {
  const share = percent === null ? null : Math.max(0, Math.min(100, percent));
  return (
    <span aria-hidden data-meter-bar={share === null ? "" : Math.round(share)} className={`block h-[4px] shrink-0 overflow-hidden rounded-full bg-sunken ${className}`}>
      {share === null ? null : <span className="block h-full rounded-full" style={{ width: `${share}%`, backgroundColor: color }} />}
    </span>
  );
}

/** One footer line: a name in the first column, what is left and its bar at the right edge. */
export function MeterLine({ label, value, percent, color, bar = true }: { label: ReactNode; value: ReactNode; percent: number | null; color: string; bar?: boolean }) {
  return (
    <span data-meter-line="" className="flex h-[22px] items-center gap-2">
      <span data-meter-label="" className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-primary">{label}</span>
      <span data-meter-value="" className="shrink-0 text-[11px] tabular-nums text-muted">{value}</span>
      {bar ? <ReserveBar percent={percent} color={color} /> : null}
    </span>
  );
}

/**
 * One limit window behind "All windows": its name, what is left and the bar of
 * that share on the grid of the lines above it, then when it resets.
 */
export function WindowLine({ label, left, value, color, note }: { label: string; left: number; value: ReactNode; color: string; note?: ReactNode }) {
  return (
    <span data-meter-window="" className="block">
      <span data-meter-line="" className="flex h-[20px] items-center gap-2">
        <span data-meter-label="" className="min-w-0 flex-1 truncate text-[11px] text-secondary">{label}</span>
        <span data-meter-value="" className="shrink-0 text-[11px] tabular-nums text-muted">{value}</span>
        <ReserveBar percent={left} color={color} />
      </span>
      {/* A reset with the hour an old reading was taken runs to a second line; it is never cut. */}
      {note ? <span data-meter-note="" className="-mt-0.5 block break-words pb-1 text-[10px] leading-[13px] text-muted">{note}</span> : null}
    </span>
  );
}
