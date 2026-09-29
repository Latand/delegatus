"use client";

import { Check, ChevronDown, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Z } from "@/components/layers";
import { MemberAvatar } from "@/components/team/MemberAvatar";
import type { ActivityMemberRow, ActivityResponse } from "@/lib/activity/report";
import type { Locale, MessageKey, TFunction } from "@/lib/i18n";

import { hostName, hoursText, minutesText, nameList, projectName } from "./format";

/*
 * The owner's view of every member (docs/design/activity-dashboard.md, "The
 * owner's view of every member"): a filter beside the project picker that
 * chooses whose input the page counts (the owner's own by default, one
 * member, or every member added up), and, under "All members", one card per
 * person with their report hours and the projects they went to. Only the
 * owner, or a solo host's operator, is sent the members; anyone else sees
 * neither.
 */

/** `all`, a member id, or null for the viewer's own input. */
export type MemberChoice = string | null;

export const ALL_MEMBERS = "all";

/** The 403 code GET /api/activity answers a member who names someone else
    (`ACTIVITY_MEMBER_FORBIDDEN` in src/lib/activity/report.ts, which this
    client module cannot import). */
export const MEMBER_FORBIDDEN = "activity_member_forbidden";

export function memberFromSearch(search: string): MemberChoice {
  const value = new URLSearchParams(search).get("member")?.trim();
  return value ? value : null;
}

export function memberLabel(row: Pick<ActivityMemberRow, "id" | "name">, t: TFunction): string {
  if (row.name) return row.name;
  if (row.id === "operator") return t("activity.member.operator");
  return t("activity.member.unlisted", { id: row.id.slice(-4) });
}

/** Their report hours: `≥` where a host holding their input was not read
    for them or a day of theirs is flagged, and "Not covered" where a host was
    not read and the bound would be zero. */
export function memberHours(row: ActivityMemberRow, locale: Locale, t: TFunction): string {
  if (!row.coverage.complete && row.humanMs === 0) return t("activity.member.notCovered");
  const lower = !row.coverage.complete || row.missingSourceDays > 0;
  return `${lower ? "≥ " : ""}${hoursText(row.humanHours, locale, t)}`;
}

function initialsOf(label: string): string {
  return label.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]!.toUpperCase()).join("") || "?";
}

/** A member's mark; the roster's colour and initials, or a neutral circle for
    an author the roster does not name. */
export function MemberMark({ row, size, t }: { row: Pick<ActivityMemberRow, "id" | "name" | "color" | "initials">; size: number; t: TFunction }) {
  const label = memberLabel(row, t);
  if (row.color) return <MemberAvatar name={label} initials={row.initials ?? initialsOf(label)} color={row.color} size={size} />;
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 select-none items-center justify-center rounded-full bg-sunken font-bold leading-none text-secondary"
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.42)) }}
    >
      {size >= 20 ? initialsOf(label) : null}
    </span>
  );
}

/** Whose input the figures count, as the hero's label reads it. */
export function countedLabel(data: ActivityResponse, t: TFunction): string | null {
  if (data.member.selection === "all") return t("activity.member.everyone");
  if (data.member.selection === "self") return null;
  const row = data.member.members.find((entry) => entry.id === data.member.memberId);
  return row ? memberLabel(row, t) : memberLabel({ id: data.member.memberId ?? "", name: null }, t);
}

/** The messages that name the counted person as the viewer ("You", "Your
    time"), each beside its wording for someone else's input or everyone's. */
export const OTHERS_WORDING: Readonly<Partial<Record<MessageKey, MessageKey>>> = {
  "activity.subtitle": "activity.others.subtitle",
  "activity.sort.human": "activity.others.sort.human",
  "activity.legend.human": "activity.others.legend.human",
  "activity.tile.human": "activity.others.tile.human",
  "activity.tile.splitSub": "activity.others.tile.splitSub",
  "activity.gap.incompleteTitle": "activity.others.gap.incompleteTitle",
  "activity.day.aria": "activity.others.day.aria",
  "activity.tooltip.human": "activity.others.tooltip.human",
  "activity.tooltip.noHuman": "activity.others.tooltip.noHuman",
  "activity.breakdown.host": "activity.others.breakdown.host",
  "activity.breakdown.surface": "activity.others.breakdown.surface",
  "activity.breakdown.kind": "activity.others.breakdown.kind",
  "activity.counted.methodEpisodes": "activity.others.counted.methodEpisodes",
  "activity.counted.halfHour": "activity.others.counted.halfHour",
  "activity.counted.parallel": "activity.others.counted.parallel",
  "activity.counted.operatorOnly": "activity.others.counted.operatorOnly",
  "activity.counted.agent": "activity.others.counted.agent",
  "activity.counted.hosts": "activity.others.counted.hosts",
  "activity.trust.none": "activity.others.trust.none",
  "activity.fig.you": "activity.others.fig.you",
  "activity.fig.splitUnknown": "activity.others.fig.splitUnknown",
  "activity.chart.aria": "activity.others.chart.aria",
  "activity.chart.ariaToday": "activity.others.chart.ariaToday",
  "activity.chart.pair": "activity.others.chart.pair",
  "activity.rhythm.aria": "activity.others.rhythm.aria",
  "activity.rhythm.you": "activity.others.rhythm.you",
  "activity.rhythm.alone": "activity.others.rhythm.alone",
  "activity.col.you": "activity.others.col.you",
  "activity.detail.note": "activity.others.detail.note",
  "activity.tip.lower": "activity.others.tip.lower",
  "activity.tip.unclearNote": "activity.others.tip.unclearNote",
  "activity.tip.unclearAny": "activity.others.tip.unclearAny",
  "activity.drawer.flagLower": "activity.others.drawer.flagLower",
  "activity.drawer.flagBoth": "activity.others.drawer.flagBoth",
  "activity.drawer.m1": "activity.others.drawer.m1",
  "activity.drawer.m1Episodes": "activity.others.drawer.m1Episodes",
  "activity.drawer.m3": "activity.others.drawer.m3",
  "activity.drawer.m4": "activity.others.drawer.m4",
  "activity.drawer.excluded": "activity.others.drawer.excluded",
};

/** The page's wording for the input it counts: the viewer's own reads as
    before, and one member's or every member's reads "Human time" and names
    them where a label has room, so the owner reading another member's page
    is never told "You" worked it. */
export function countedWording(data: ActivityResponse | null, t: TFunction): TFunction {
  const person = data ? countedLabel(data, t) : null;
  if (person === null) return t;
  return (key, params) => {
    const other = OTHERS_WORDING[key];
    return other ? t(other, { person, ...params }) : t(key, params);
  };
}

interface Option {
  value: MemberChoice;
  row: ActivityMemberRow | null;
  label: string;
  detail: string;
}

export function ActivityMemberFilter({ data, selected, onSelect, locale, t, wide = false }: {
  data: ActivityResponse;
  selected: MemberChoice;
  onSelect(member: MemberChoice): void;
  locale: Locale;
  t: TFunction;
  /** The narrow page's header: on a phone the trigger fills its row and the
      list its width, with 44 px targets. */
  wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  const members = data.member.members;
  const self = members.find((row) => row.self) ?? null;
  const total = members.reduce((sum, row) => sum + row.humanHours, 0);
  const lower = members.some((row) => !row.coverage.complete || row.missingSourceDays > 0);
  const options: Option[] = [
    { value: ALL_MEMBERS, row: null, label: t("activity.member.all"), detail: `${lower ? "≥ " : ""}${hoursText(total, locale, t)}` },
    ...members.map((row) => ({
      value: row.self ? null : row.id,
      row,
      label: row.self ? t("activity.member.me", { name: memberLabel(row, t) }) : memberLabel(row, t),
      detail: memberHours(row, locale, t),
    })),
  ];
  const chosen = selected === ALL_MEMBERS ? options[0]! : options.find((option) => option.row && option.row.id === (selected ?? self?.id)) ?? null;
  const chosenIndex = chosen ? options.indexOf(chosen) : 0;

  const show = () => {
    setActive(chosenIndex);
    setOpen(true);
  };
  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  const choose = (option: Option) => {
    close();
    if (option.value !== selected) onSelect(option.value);
  };

  useEffect(() => {
    if (open) list.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: Event) => {
      const target = event.target as Node | null;
      if (target && root.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  const triggerLabel = chosen?.row ? memberLabel(chosen.row, t) : chosen ? chosen.label : memberLabel({ id: selected ?? "", name: null }, t);

  return (
    <div ref={root} className={`relative shrink-0 ${wide ? "max-sm:w-full" : ""}`} data-activity-members={open ? "open" : "closed"}>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("activity.member.aria", { member: triggerLabel })}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" || open) return;
          event.preventDefault();
          show();
        }}
        className={`flex items-center gap-1.5 whitespace-nowrap rounded-[8px] border border-border bg-card px-2.5 text-[12px] font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 h-8 max-w-[220px] ${wide ? "max-sm:h-11 max-sm:w-full max-sm:max-w-none" : ""}`}
        data-activity-members-trigger={selected ?? "self"}
      >
        {chosen?.row ? <MemberMark row={chosen.row} size={16} t={t} /> : <Users className="h-3.5 w-3.5 text-muted" aria-hidden />}
        <span className={`truncate ${wide ? "max-sm:flex-1 max-sm:text-left" : ""}`}>{triggerLabel}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
      </button>
      {open ? (
        <div className={`absolute right-0 w-[300px] ${wide ? "max-sm:left-0 max-sm:w-auto" : ""} top-full ${Z.popover} mt-1 overflow-hidden rounded-[10px] border border-border bg-raised shadow-2`}>
          <ul
            ref={list}
            role="listbox"
            tabIndex={-1}
            aria-label={t("activity.member.listAria")}
            aria-activedescendant={`activity-member-option-${active}`}
            className="max-h-[min(70vh,420px)] overflow-y-auto py-1 focus-visible:outline-none"
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const delta = event.key === "ArrowDown" ? 1 : -1;
                setActive((current) => (current + delta + options.length) % options.length);
              } else if (event.key === "Home" || event.key === "End") {
                event.preventDefault();
                setActive(event.key === "Home" ? 0 : options.length - 1);
              } else if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                choose(options[active]!);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close();
              } else if (event.key === "Tab") {
                close(false);
              }
            }}
          >
            {options.map((option, index) => {
              const isChosen = option === chosen;
              return (
                <li
                  key={option.row?.id ?? ALL_MEMBERS}
                  id={`activity-member-option-${index}`}
                  role="option"
                  aria-selected={isChosen}
                  onClick={() => choose(option)}
                  onMouseEnter={() => setActive(index)}
                  className={`grid cursor-pointer grid-cols-[14px_20px_minmax(0,1fr)_auto] items-center gap-2 border-l-2 px-3 text-[12.5px] py-1.5 ${wide ? "max-sm:min-h-11" : ""} ${index === active ? "bg-accent-soft" : ""} ${isChosen ? "border-accent" : "border-transparent"}`}
                  data-activity-member-option={option.row?.id ?? ALL_MEMBERS}
                >
                  {isChosen ? <Check className="h-3.5 w-3.5 text-accent" aria-hidden /> : <span aria-hidden />}
                  {option.row ? <MemberMark row={option.row} size={20} t={t} /> : <Users className="h-4 w-4 justify-self-center text-muted" aria-hidden />}
                  <span className="truncate font-semibold text-primary" title={option.label}>{option.label}</span>
                  <span className={`whitespace-nowrap text-[11.5px] tabular-nums ${option.row && !option.row.coverage.complete && option.row.humanMs === 0 ? "text-warning" : "text-muted"}`}>{option.detail}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

const PROJECTS_SHOWN = 3;

/** Under "All members": who worked how many report hours, on which projects. */
export function ActivityMemberBreakdown({ data, onSelect, locale, t }: {
  data: ActivityResponse;
  onSelect(member: MemberChoice): void;
  locale: Locale;
  t: TFunction;
}) {
  if (data.member.selection !== "all") return null;
  const hosts = (ids: readonly string[]) => nameList(ids.map((host) => hostName(host, data.coverage.hosts, t)), t);
  return (
    <section
      className="rounded-[12px] border border-border bg-card px-[22px] pb-4 pt-4 shadow-1 max-sm:px-4"
      aria-label={t("activity.member.breakdown")}
      data-activity-member-breakdown=""
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-[13px] font-semibold text-primary">{t("activity.member.breakdown")}</h2>
        <p className="text-[11.5px] text-muted" data-activity-member-not-split="">{t("activity.member.notSplit")}</p>
      </div>
      <ul className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
        {data.member.members.map((row) => {
          const label = memberLabel(row, t);
          const missing = !row.coverage.complete;
          const shown = row.projects.slice(0, PROJECTS_SHOWN);
          return (
            <li key={row.id} data-activity-member-row={row.id} data-covered={missing ? "false" : "true"}>
              <button
                type="button"
                onClick={() => onSelect(row.self ? null : row.id)}
                aria-label={t("activity.member.open", { member: label })}
                className="flex h-full w-full flex-col gap-2 rounded-[10px] border border-border bg-canvas px-3.5 py-3 text-left hover:border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <span className="flex w-full items-center gap-2.5">
                  <MemberMark row={row} size={28} t={t} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold text-primary">{row.self ? t("activity.member.me", { name: label }) : label}</span>
                    <span className="block text-[11.5px] text-muted">
                      {t("activity.member.requests", { count: row.requests })}
                      {row.humanMs > 0 ? ` · ${minutesText(row.humanMs, t)}` : ""}
                    </span>
                  </span>
                  <span
                    className={`whitespace-nowrap text-[18px] font-semibold tabular-nums ${missing && row.humanMs === 0 ? "text-[13px] text-warning" : "text-primary"}`}
                    data-activity-member-hours=""
                  >
                    {memberHours(row, locale, t)}
                  </span>
                </span>
                {missing ? (
                  <span className="text-[11.5px] leading-snug text-warning" data-activity-member-gap="">
                    {t("activity.member.notReadOn", { hosts: hosts(row.coverage.missingHosts) })}
                  </span>
                ) : null}
                {shown.length ? (
                  <span className="flex flex-col gap-1 border-t border-border pt-2">
                    {shown.map((entry) => (
                      <span key={entry.project ?? ""} className="flex items-baseline justify-between gap-3 text-[12px]">
                        <span className="truncate text-secondary">{projectName(entry.project, entry.name, t)}</span>
                        <span className="whitespace-nowrap tabular-nums text-primary">{hoursText(entry.humanHours, locale, t)}</span>
                      </span>
                    ))}
                    {row.projects.length > PROJECTS_SHOWN ? (
                      <span className="text-[11.5px] text-muted">{t("activity.member.moreProjects", { count: row.projects.length - PROJECTS_SHOWN })}</span>
                    ) : null}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
