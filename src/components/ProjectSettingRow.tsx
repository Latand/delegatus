"use client";

import { useId, type ButtonHTMLAttributes, type HTMLAttributes } from "react";

/*
 * One per-project switch row with one muted line under it (#2187 §6): the
 * board's ⋯ menu and the phone's ⋯ sheet draw the project's settings with it;
 * the phone's is 44 px tall. `rowProps` and `switchProps` carry each setting's
 * own data attributes.
 */
export function ProjectSettingRow({ label, hint, enabled, disabled, failed, variant, blocked = false, rowProps, switchProps }: {
  label: string;
  hint: string;
  enabled: boolean;
  disabled: boolean;
  failed: boolean;
  variant: "menu" | "sheet" | "inline";
  /** On, and something else stops it working: the switch turns amber, so it does not read as working. */
  blocked?: boolean;
  rowProps?: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string | undefined>;
  switchProps: { onClick: () => void } & Record<`data-${string}`, string | undefined>;
}) {
  const hintId = useId();
  const sheet = variant === "sheet";
  return (
    <div {...rowProps} className={sheet ? "flex flex-col gap-0.5 px-4 py-1" : variant === "inline" ? "flex flex-col gap-0.5" : "flex flex-col gap-0.5 px-2 py-1"}>
      <div className={`flex items-center gap-2 ${sheet ? "min-h-11" : "min-h-8"}`}>
        <span className={`min-w-0 flex-1 font-semibold text-primary ${sheet ? "text-body" : "text-[12px]"}`}>{label}</span>
        <SettingSwitch enabled={enabled} blocked={blocked} size={sheet ? "sheet" : "row"} aria-label={label} aria-describedby={hintId} disabled={disabled} {...switchProps} />
      </div>
      <span id={hintId} role="status" className={`text-[11px] leading-snug ${failed ? "text-danger" : "text-muted"}`}>{hint}</span>
    </div>
  );
}

/**
 * The board's switch, as the per-project rows draw it. `size` is its hit area:
 * 24 px in a row, 44 px in the phone's sheet, and `responsive` takes the row's
 * size on the desktop and the sheet's on the phone.
 */
export function SettingSwitch({ enabled, blocked = false, size = "row", className = "", ...button }: {
  enabled: boolean;
  /** On, and something else stops it working: the switch turns amber, so it does not read as working. */
  blocked?: boolean;
  size?: "row" | "sheet" | "responsive";
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "role" | "aria-checked" | "type"> & Record<`data-${string}`, string | undefined>) {
  const hit = size === "sheet" ? "h-11 w-12" : size === "responsive" ? "h-6 w-9 max-sm:h-11 max-sm:w-12" : "h-6 w-9";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      {...button}
      className={`relative flex shrink-0 items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-45 ${hit} rounded-full ${className}`}
    >
      {/* Off is an outlined track with a muted knob: a card-coloured knob on the well vanishes in the dark theme. */}
      <span aria-hidden className={`block h-5 w-9 rounded-full border transition-colors ${enabled ? blocked ? "border-warning bg-warning" : "border-accent bg-accent" : "border-strong bg-well"}`}>
        <span className={`mt-[1px] block h-4 w-4 rounded-full shadow transition-transform ${enabled ? "translate-x-[17px] bg-card" : "translate-x-[1px] bg-muted"}`} />
      </span>
    </button>
  );
}
