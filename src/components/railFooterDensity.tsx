import type { ReactNode } from "react";

/**
 * How much room a rail footer block takes (docs/design/sidebar-redesign.md).
 * `full` is the footer the product ships; `line` and `gauge` exist for the
 * sidebar design prototypes and nothing in the product asks for them.
 * A line is one row per block in a shared three-column grid; a gauge is one
 * square per block for a rail too narrow for words.
 */
export type RailFooterDensity = "full" | "line" | "gauge";

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
export function MeterLine({ label, value, percent, color }: { label: ReactNode; value: ReactNode; percent: number | null; color: string }) {
  return (
    <span data-meter-line="" className="flex h-[22px] items-center gap-2">
      <span data-meter-label="" className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-primary">{label}</span>
      <span data-meter-value="" className="shrink-0 text-[11px] tabular-nums text-muted">{value}</span>
      <ReserveBar percent={percent} color={color} />
    </span>
  );
}

/** One footer square: a mark above its bar, and a second bar when the block has two readings. */
export function MeterGauge({ mark, percent, color, second }: { mark: ReactNode; percent: number | null; color: string; second?: { percent: number; color: string } }) {
  return (
    <span className={`flex w-10 flex-col items-center justify-center ${second ? "h-10 gap-[3px]" : "h-9 gap-[5px]"}`}>
      <span className="flex h-3.5 items-center text-[9.5px] font-bold leading-none text-secondary">{mark}</span>
      <ReserveBar percent={percent} color={color} className="w-6" />
      {second ? <ReserveBar percent={second.percent} color={second.color} className="w-6" /> : null}
    </span>
  );
}

export const GAUGE_BUTTON = "flex items-center justify-center rounded-[9px] hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
