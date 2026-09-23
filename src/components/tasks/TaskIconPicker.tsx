"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { useLocale } from "@/lib/i18n";
import { SUGGESTED_TASK_ICONS } from "@/lib/tasks/taskIconSuggest";

import { TaskIconGlyph } from "./TaskIcon";

type Search = typeof import("@/lib/tasks/taskIcon").searchTaskIcons;

/** Cells one search draws; typing narrows it further. */
const RESULT_LIMIT = 64;

export interface TaskIconPickerProps {
  /** The task's stored icon, marked as chosen. */
  value: string | null;
  /** What the task shows while it has no icon (the title's suggestion); offered first. */
  suggestion?: string | null;
  /** A name, or null for no icon. */
  onPick: (icon: string | null) => void;
  /** Grid columns: the desktop popover draws eight, a phone sheet may draw fewer. */
  columns?: number;
  /** Takes focus on mount; a host that moves focus itself turns it off. */
  autoFocus?: boolean;
}

/**
 * The task icon picker (#2102): a search over lucide's icon names, a grid of
 * the matches and «No icon». Before anything is typed it offers the task's
 * icon, its suggestion and the icons the keyword map uses.
 *
 * It holds no frame and no placement: the desktop board shows it in a
 * `KanbanPopover`, and the phone mounts the same component in its own sheet.
 * The full name list is loaded on first open, never with the page; the grid's
 * drawings come through the task icon loader, only for the cells the grid
 * holds (at most `RESULT_LIMIT`, scrolled out of view or not), never the
 * whole set.
 */
export function TaskIconPicker({ value, suggestion = null, onPick, columns = 8, autoFocus = true }: TaskIconPickerProps) {
  const { t } = useLocale();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<Search | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void import("@/lib/tasks/taskIcon").then((module) => {
      if (live) setSearch(() => module.searchTaskIcons);
    });
    return () => {
      live = false;
    };
  }, []);

  const common = useMemo(
    () => [...new Set([value, suggestion, ...SUGGESTED_TASK_ICONS].filter((name): name is string => Boolean(name)))],
    [value, suggestion],
  );
  const typed = query.trim();
  const found = typed ? (search ? search(typed, RESULT_LIMIT) : null) : null;
  const names = typed ? found?.names ?? [] : common;
  const caption = !typed
    ? t("taskIcon.suggestedHead")
    : !found
      ? t("taskIcon.loading")
      : found.total
        ? t("taskIcon.results", { count: found.total })
        : t("taskIcon.noMatch");

  /* Arrows walk the grid a cell or a row at a time; Home and End reach its ends. */
  const onGridKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const cells = [...(gridRef.current?.querySelectorAll<HTMLButtonElement>("[data-icon-choice]") ?? [])];
    const index = cells.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }[event.key];
    const next = step !== undefined ? index + step : event.key === "Home" ? 0 : event.key === "End" ? cells.length - 1 : null;
    if (next === null || next < 0 || next >= cells.length) return;
    event.preventDefault();
    cells[next]!.focus();
  };

  return (
    <div className="tip" data-task-icon-picker="" style={{ "--tip-columns": columns } as React.CSSProperties}>
      <input
        type="search"
        className="tip-search"
        value={query}
        placeholder={t("taskIcon.search")}
        aria-label={t("taskIcon.search")}
        autoFocus={autoFocus}
        spellCheck={false}
        autoComplete="off"
        data-task-icon-search=""
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && names[0]) {
            event.preventDefault();
            onPick(names[0]);
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            gridRef.current?.querySelector<HTMLButtonElement>("[data-icon-choice]")?.focus();
          }
        }}
      />
      <button type="button" className="tip-none" aria-pressed={value === null} data-icon-choice-none="" title={t("taskIcon.noneHint")} onClick={() => onPick(null)}>
        <span className="tip-none-mark" aria-hidden />
        {t("taskIcon.none")}
      </button>
      <div className="tip-caption" aria-live="polite">{caption}</div>
      <div ref={gridRef} className="tip-grid" role="group" aria-label={t("taskIcon.pickerTitle")} onKeyDown={onGridKey}>
        {names.map((name) => (
          <button
            key={name}
            type="button"
            className="tip-cell"
            aria-pressed={name === value}
            aria-label={name}
            title={name}
            data-icon-choice={name}
            /* What the card shows while nothing is stored. */
            data-suggested={value === null && name === suggestion ? "" : undefined}
            onClick={() => onPick(name)}
            onFocus={() => setActive(name)}
            onMouseEnter={() => setActive(name)}
          >
            <TaskIconGlyph name={name} size={18} />
          </button>
        ))}
      </div>
      <div className="tip-name" data-task-icon-active={active ?? value ?? ""}>{active ?? value ?? "\u00a0"}</div>
    </div>
  );
}
