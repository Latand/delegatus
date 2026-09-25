"use client";

import { Check, ChevronDown, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Z } from "@/components/layers";
import type { ActivityProjectRow, ActivityResponse } from "@/lib/activity/report";
import type { Locale, TFunction } from "@/lib/i18n";

import { approxAtLeast, hoursText } from "./format";

/*
 * The header's project picker: every project of the range, searchable by
 * name, since the Projects list folds what does not fit into "+ N more".
 * Choosing one scopes the whole page to it; "All projects" clears it. The
 * keyboard drives it like the directory picker: arrows, Home, End, Enter,
 * Escape.
 */

interface Option {
  project: string | null;
  label: string;
  value: string | null;
}

/** Every token must appear in the name or the key. */
export function matchesProject(label: string, project: string, query: string): boolean {
  const haystack = `${label} ${project}`.toLowerCase();
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean).every((token) => haystack.includes(token));
}

function yourValue(row: ActivityProjectRow, unread: boolean, locale: Locale, t: TFunction): string {
  if (unread || (!row.coverage.complete && row.humanHours === 0)) return "?";
  if (row.humanHours === 0) return "0";
  return `${row.coverage.complete ? "" : "≥ "}${hoursText(row.humanHours, locale, t)}`;
}

export function ActivityProjectPicker({ data, names, selected, unread, onSelect, locale, t }: {
  data: ActivityResponse;
  names: ReadonlyMap<string | null, string>;
  selected: string | null;
  /** None of your input was read for the range. */
  unread: boolean;
  onSelect(project: string | null): void;
  locale: Locale;
  t: TFunction;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  /* The projects the list draws, in its default order: your reported hours,
     then agent time. A row with no project cannot be chosen. */
  const rows = useMemo(() => data.projects
    .filter((row) => row.project !== null && (row.humanMs > 0 || row.wallMs > 0 || row.requests > 0 || !row.coverage.complete))
    .sort((a, b) => b.humanHours - a.humanHours || b.humanMs - a.humanMs || b.wallMs - a.wallMs), [data.projects]);
  const options: Option[] = useMemo(() => {
    const matched = rows
      .map((row) => ({ row, label: names.get(row.project) ?? row.project! }))
      .filter(({ row, label }) => matchesProject(label, row.project!, query))
      .map(({ row, label }) => ({
        project: row.project,
        label,
        value: `${yourValue(row, unread, locale, t)} · ${approxAtLeast(row.wallMs, !row.agentCoverage.complete, t)}`,
      }));
    return query.trim() ? matched : [{ project: null, label: t("activity.filter.all"), value: null }, ...matched];
  }, [rows, names, query, unread, locale, t]);
  const activeIndex = options.length ? Math.min(active, options.length - 1) : 0;

  const show = () => {
    setQuery("");
    setActive(Math.max(0, selected === null ? 0 : rows.findIndex((row) => row.project === selected) + 1));
    setOpen(true);
  };
  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  const choose = (project: string | null) => {
    close();
    if (project !== selected) onSelect(project);
  };

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: Event) => {
      const target = event.target as Node | null;
      if (target && root.current?.contains(target)) return;
      /* No focus restore: the pointer is already somewhere else. */
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  useEffect(() => {
    if (open) document.getElementById(`activity-project-option-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex]);

  const step = (delta: number) => {
    if (!options.length) return;
    setActive((current) => (Math.min(current, options.length - 1) + delta + options.length) % options.length);
  };

  return (
    <div ref={root} className="relative shrink-0" data-activity-picker={open ? "open" : "closed"}>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("activity.filter.aria")}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" || open) return;
          event.preventDefault();
          show();
        }}
        className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-[8px] border border-border bg-card px-2.5 text-[12px] font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        data-activity-picker-trigger=""
      >
        <Search className="h-3.5 w-3.5 text-muted" aria-hidden />
        {t("activity.filter.button")}
        <ChevronDown className="h-3.5 w-3.5 text-muted" aria-hidden />
      </button>
      {open ? (
        <div className={`absolute right-0 top-full ${Z.popover} mt-1 flex max-h-[min(70vh,440px)] w-[360px] flex-col overflow-hidden rounded-[10px] border border-border bg-raised shadow-2`}>
          <input
            ref={input}
            value={query}
            role="combobox"
            aria-expanded="true"
            aria-controls="activity-project-listbox"
            aria-autocomplete="list"
            aria-activedescendant={options[activeIndex] ? `activity-project-option-${activeIndex}` : undefined}
            aria-label={t("activity.filter.searchAria")}
            placeholder={t("activity.filter.search")}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                step(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                step(-1);
              } else if (event.key === "Home") {
                event.preventDefault();
                setActive(0);
              } else if (event.key === "End") {
                event.preventDefault();
                setActive(Math.max(options.length - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                const option = options[activeIndex];
                if (option) choose(option.project);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close();
              } else if (event.key === "Tab") {
                close(false);
              }
            }}
            className="h-9 w-full shrink-0 border-b border-border bg-card px-3 text-[12.5px] text-primary placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
            data-activity-picker-search=""
          />
          <ul id="activity-project-listbox" role="listbox" aria-label={t("activity.view.projects")} className="min-h-0 flex-1 overflow-y-auto py-1">
            {options.map((option, index) => {
              const chosen = option.project === selected;
              return (
                <li
                  key={option.project ?? ""}
                  id={`activity-project-option-${index}`}
                  role="option"
                  aria-selected={chosen}
                  onClick={() => choose(option.project)}
                  onMouseEnter={() => setActive(index)}
                  className={`grid cursor-pointer grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2 border-l-2 px-3 py-1.5 text-[12.5px] ${index === activeIndex ? "bg-accent-soft" : ""} ${chosen ? "border-accent" : "border-transparent"}`}
                  data-activity-picker-option={option.project ?? ""}
                  data-active={index === activeIndex ? "true" : undefined}
                >
                  {chosen ? <Check className="h-3.5 w-3.5 text-accent" aria-hidden /> : <span aria-hidden />}
                  <span className={`truncate ${option.project === null ? "font-semibold text-secondary" : "font-semibold text-primary"}`} title={option.label}>{option.label}</span>
                  {option.value ? <span className="whitespace-nowrap text-[11.5px] tabular-nums text-muted">{option.value}</span> : <span aria-hidden />}
                </li>
              );
            })}
            {options.length ? null : (
              <li role="presentation" className="px-3 py-2 text-[12px] text-muted">{t("activity.filter.noMatch")}</li>
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** The chosen project beside the title; its cross returns to every project. */
export function ActivityScopeChip({ name, onClear, t }: { name: string; onClear(): void; t: TFunction }) {
  return (
    <span
      role="group"
      aria-label={t("activity.filter.showing", { project: name })}
      className="inline-flex h-7 min-w-0 max-w-[280px] shrink items-center gap-1 self-center rounded-full border border-border bg-card pl-2.5 pr-1 text-[12px] font-semibold text-primary"
      data-activity-scope-chip=""
    >
      <span className="truncate" title={name}>{name}</span>
      <button
        type="button"
        onClick={onClear}
        aria-label={t("activity.filter.clear")}
        title={t("activity.filter.clear")}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted hover:bg-sunken hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-8 max-sm:w-8"
        data-activity-scope-clear=""
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
    </span>
  );
}
