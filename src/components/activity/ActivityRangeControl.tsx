"use client";

import { CalendarRange, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { Z } from "@/components/layers";
import type { MessageKey, TFunction, Locale } from "@/lib/i18n";

import { clampDates, RANGE_PRESETS, validDate, type PageRange } from "./pageParams";
import { datesLabel } from "./tokenParts";

/*
 * The range of the whole Activity page, both tabs
 * (docs/design/activity-token-usage.md §9.1): four presets and «Період…»,
 * whose popover holds two native date fields, «Від» and «До». On the phone
 * it opens inline under the presets and pushes the page down. The range
 * applies as soon as both dates are valid; a span over a year keeps its end
 * and starts a year before it, as the server would clamp it.
 */

export type { PageRange } from "./pageParams";

export function ActivityRangeControl({ range, shown, today, onChange, locale, t, phone = false }: {
  range: PageRange;
  /** The dates the page is drawing, to start the fields from. */
  shown: { from: string; to: string } | null;
  /** Today in the page's zone: the last date a field offers. */
  today: string | null;
  onChange(range: PageRange): void;
  locale: Locale;
  t: TFunction;
  phone?: boolean;
}) {
  const root = useRef<HTMLDivElement | null>(null);
  const customButton = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ from: "", to: "" });
  const dialogId = useId();

  useEffect(() => {
    if (!open || phone) return;
    const onPointerDown = (event: Event) => {
      if (event.target instanceof Node && root.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, phone]);

  const close = () => {
    setOpen(false);
    customButton.current?.focus();
  };
  const custom = range.preset === null;
  const segment = (selected: boolean) => `${phone ? "h-11 min-w-0 flex-auto px-1.5" : "h-7 px-3"} whitespace-nowrap rounded-[6px] text-[12px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${selected ? "bg-canvas text-primary" : "text-muted hover:text-primary"}`;
  const apply = (next: { from: string; to: string }) => {
    setDraft(next);
    if (validDate(next.from) && validDate(next.to)) {
      const clamped = clampDates(next.from, next.to);
      if (clamped.from !== next.from || clamped.to !== next.to) setDraft(clamped);
      onChange({ preset: null, ...clamped });
    }
  };
  const start = () => {
    const base = custom ? { from: range.from, to: range.to } : shown ?? { from: "", to: "" };
    setDraft(base);
    setOpen((value) => !value);
  };

  return (
    <div ref={root} className={`relative ${phone ? "w-full" : "shrink-0"}`} data-activity-range={open ? "open" : "closed"}>
      <div className={`flex rounded-[8px] border border-border bg-card p-[2px] ${phone ? "w-full" : ""}`} role="group" aria-label={t("activity.rangeAria")}>
        {RANGE_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            aria-pressed={range.preset === preset}
            onClick={() => { setOpen(false); onChange({ preset }); }}
            className={segment(range.preset === preset)}
            data-activity-option={preset}
          >
            {t(`activity.range.${preset}` as MessageKey)}
          </button>
        ))}
        <button
          ref={customButton}
          type="button"
          aria-pressed={custom}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? dialogId : undefined}
          onClick={start}
          className={`${segment(custom)} inline-flex items-center justify-center gap-1.5`}
          data-activity-option="custom"
        >
          {phone ? null : <CalendarRange className="h-3.5 w-3.5" aria-hidden />}
          {custom ? datesLabel(range.from, range.to, locale) : t("activity.range.custom")}
        </button>
      </div>
      {open ? (
        <div
          id={dialogId}
          role="dialog"
          aria-label={t("activity.range.dialog")}
          className={phone ? "mt-2 rounded-[10px] border border-border bg-raised p-3" : `absolute right-0 top-full ${Z.popover} mt-1 w-[300px] rounded-[10px] border border-border bg-raised p-3 shadow-2`}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
          data-activity-range-popover=""
        >
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-semibold text-primary">{t("activity.range.title")}</span>
            <button type="button" onClick={close} aria-label={t("activity.range.close")} className="flex h-7 w-7 items-center justify-center rounded-[6px] text-muted hover:bg-sunken hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11 max-sm:w-11">
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {(["from", "to"] as const).map((side) => (
              <label key={side} className="flex min-w-0 flex-col gap-1 text-[11px] font-semibold text-secondary">
                {t(side === "from" ? "activity.range.from" : "activity.range.to")}
                <input
                  type="date"
                  value={draft[side]}
                  max={today ?? undefined}
                  onChange={(event) => apply({ ...draft, [side]: event.target.value })}
                  className="h-8 w-full min-w-0 rounded-[8px] border border-border bg-card px-2 text-[12.5px] font-normal tabular-nums text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11"
                  data-activity-range-input={side}
                />
              </label>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-snug text-muted">{t("activity.range.hint")}</p>
        </div>
      ) : null}
    </div>
  );
}
