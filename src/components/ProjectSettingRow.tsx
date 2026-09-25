"use client";

import { useId, type HTMLAttributes } from "react";

/*
 * One per-project switch row with one muted line under it (#2187 §6): the
 * board's ⋯ menu and the phone's ⋯ sheet draw the project's settings with it;
 * the phone's is 44 px tall. `rowProps` and `switchProps` carry each setting's
 * own data attributes.
 */
export function ProjectSettingRow({ label, hint, enabled, disabled, failed, variant, rowProps, switchProps }: {
  label: string;
  hint: string;
  enabled: boolean;
  disabled: boolean;
  failed: boolean;
  variant: "menu" | "sheet" | "inline";
  rowProps?: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string | undefined>;
  switchProps: { onClick: () => void } & Record<`data-${string}`, string | undefined>;
}) {
  const hintId = useId();
  const sheet = variant === "sheet";
  return (
    <div {...rowProps} className={sheet ? "flex flex-col gap-0.5 px-4 py-1" : variant === "inline" ? "flex flex-col gap-0.5" : "flex flex-col gap-0.5 px-2 py-1"}>
      <div className={`flex items-center gap-2 ${sheet ? "min-h-11" : "min-h-8"}`}>
        <span className={`min-w-0 flex-1 font-semibold text-primary ${sheet ? "text-body" : "text-[12px]"}`}>{label}</span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={label}
          aria-describedby={hintId}
          disabled={disabled}
          {...switchProps}
          className={`relative flex shrink-0 items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-45 ${sheet ? "h-11 w-12" : "h-6 w-9"} rounded-full`}
        >
          <span aria-hidden className={`block h-5 w-9 rounded-full border transition-colors ${enabled ? "border-accent bg-accent" : "border-border bg-well"}`}>
            <span className={`mt-[1px] block h-4 w-4 rounded-full bg-card shadow transition-transform ${enabled ? "translate-x-[17px]" : "translate-x-[1px]"}`} />
          </span>
        </button>
      </div>
      <span id={hintId} role="status" className={`text-[11px] leading-snug ${failed ? "text-danger" : "text-muted"}`}>{hint}</span>
    </div>
  );
}
