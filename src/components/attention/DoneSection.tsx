"use client";

import { Check, CheckCheck, ChevronDown, ChevronRight, ChevronUp, CircleCheck, Expand, Gauge, GitMerge, Globe, Rocket, TriangleAlert, type LucideIcon } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { ImageGalleryProvider, Lightbox, type GalleryImage } from "@/components/feed/Lightbox";
import { TaskIcon } from "@/components/tasks/TaskIcon";
import { projectTitle } from "@/lib/displayNames";
import type { DoneItemV1 } from "@/lib/done/types";
import { useLocale, type Locale, type TFunction } from "@/lib/i18n";

import { acknowledgeDone } from "./doneItems";

/*
 * «Готово» (docs/design/done-section.md §4.3): pinned at the top of «Чекають
 * на вас» (the desktop panel and the phone sheet) and of the orchestrator's
 * report log, the same list from the one store in every place. Newest first:
 * a single row stands at its own time and a group at its newest member's, so
 * each new outcome arrives at the top. Technical fixes and work finished
 * without a PR stay two groups, which one button accepts whole and which open
 * to their members. The head says «Готово · N» and «Бачив усе», and folds the
 * list to itself; the list scrolls inside its own band, so it is never
 * scrolled away under what follows.
 *
 * Accepting is one durable write per click (`acknowledgeDone`), gone from
 * every count and every place at once. While the list is open an accepted row
 * stays where it was as «… · прийнято» with «Повернути»; it leaves when the
 * surface closes, because this component holds those receipts and closes
 * with it.
 */

export type DoneSurface = "desktop" | "phone";
/** Where the list is pinned: «Чекають на вас» or the report log. */
export type DonePlace = "needs-you" | "reports";

export interface DoneSectionProps {
  /** The items still waiting, newest first. */
  items: readonly DoneItemV1[];
  /** The project on screen; a row of another names its project. */
  current: string | null;
  projectNames: Readonly<Record<string, string>>;
  surface: DoneSurface;
  place: DonePlace;
  /** The section's height limit (a flex column's child), so its rows scroll
      inside it under the head. Absent: the list takes its full height (the
      phone sheet, which scrolls whole). */
  band?: string;
  /** Test seam. */
  acknowledge?: typeof acknowledgeDone;
}

const FOLD_KEY = (place: DonePlace, surface: DoneSurface) => `llvDoneFolded:${place}:${surface}`;

function readFolded(place: DonePlace, surface: DoneSurface): boolean {
  try {
    return window.localStorage.getItem(FOLD_KEY(place, surface)) === "1";
  } catch {
    return false;
  }
}

function writeFolded(place: DonePlace, surface: DoneSurface, folded: boolean): void {
  try {
    if (folded) window.localStorage.setItem(FOLD_KEY(place, surface), "1");
    else window.localStorage.removeItem(FOLD_KEY(place, surface));
  } catch {
    /* private mode: the fold lasts while the surface is open */
  }
}

type GroupId = "technical" | "closed";
const GROUP_ICON: Record<GroupId, LucideIcon> = { technical: GitMerge, closed: CircleCheck };
const LOOK_ICON: Partial<Record<DoneItemV1["look"], { icon: LucideIcon; tone: string }>> = {
  deploy: { icon: Rocket, tone: "text-success" },
  publication: { icon: Globe, tone: "text-info" },
  incident: { icon: TriangleAlert, tone: "text-warning" },
  limit: { icon: Gauge, tone: "text-warning" },
};

const newestFirst = (left: DoneItemV1, right: DoneItemV1) => Date.parse(right.at) - Date.parse(left.at) || left.key.localeCompare(right.key);

const FORMATS = new Map<string, Intl.DateTimeFormat>();
function clock(iso: string | null | undefined, locale: Locale): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const today = date.toDateString() === new Date().toDateString();
  const id = `${locale}:${today}`;
  let format = FORMATS.get(id);
  if (!format) {
    format = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "en-GB", today ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    FORMATS.set(id, format);
  }
  return format.format(date);
}

/** The account a limit row names: its label, after its engine. */
function accountName(item: DoneItemV1): string {
  const account = item.refs.account;
  if (!account) return "";
  const engine = account.engine.charAt(0).toUpperCase() + account.engine.slice(1);
  const label = account.label?.trim();
  if (!label) return engine;
  return label.toLowerCase().startsWith(account.engine.toLowerCase()) ? label : `${engine} ${label}`;
}

/** The row's sentence (§4.1): Delegatus's own words, or a dictionary template. */
export function doneSentence(t: TFunction, item: DoneItemV1): string {
  if (item.kind === "deploy") return t(item.refs.phase === "succeeded" ? "done.deploy.succeeded" : item.refs.phase === "rolled-back" ? "done.deploy.rolledBack" : "done.deploy.failed");
  if (item.kind === "limit") {
    const window = item.refs.account?.window === "weekly" ? t("limits.windowWeekly") : item.refs.account?.window === "session" ? t("limits.windowSession") : item.refs.account?.window ?? "";
    return t("done.limit.title", { account: accountName(item), window });
  }
  return item.title || (item.refs.pr ? `#${item.refs.pr.number}` : "");
}

/** A receipt's name: the sentence's first clause («Лендінг» of «Лендінг:
    картки…»), cut at a word when it is still long. */
function receiptName(sentence: string): string {
  const clause = sentence.split(/[;:.!?]\s|[;:!?]$|\.$/)[0]!.trim() || sentence;
  if (clause.length <= 36) return clause;
  const room = clause.slice(0, 36);
  const space = room.lastIndexOf(" ");
  return `${(space > 12 ? room.slice(0, space) : room).trimEnd()}…`;
}

/** A receipt's PR, when its sentence does not already name it. */
function receiptPr(t: TFunction, item: DoneItemV1): string {
  return item.refs.pr && !doneSentence(t, item).includes(`#${item.refs.pr.number}`) ? `#${item.refs.pr.number}` : "";
}

/** A group's topic for one member (§4.3): the sentence's first clause, cut at
    a word to at most three words, with no ellipsis, so a list of topics reads
    as one line of words. */
function topic(sentence: string): string {
  const clause = sentence.split(/[;:.!?]\s|[;:!?]$|\.$|,\s/)[0]!.replace(/[«»"“”]/g, "").trim();
  const words = clause.split(/\s+/).filter(Boolean);
  let out = words[0] ?? "";
  for (const word of words.slice(1, 3)) {
    if (out.length + 1 + word.length > 22) break;
    out = `${out} ${word}`;
  }
  out = out.replace(/[,;:.!?…-]+$/, "");
  /* A short last word («лише», «for») leaves the topic hanging; drop it. */
  let kept = out.split(" ");
  if (kept.length > 2 && kept.at(-1)!.length <= 4) kept = kept.slice(0, -1);
  /* So does an adjective without its noun («Прибрано порожній»): take the noun
     when it still fits, otherwise drop the adjective. */
  if (kept.length > 1 && /(?:ий|ій|ові|ого|их)$/u.test(kept.at(-1)!)) {
    const noun = words[kept.length]?.replace(/[,;:.!?…-]+$/, "");
    kept = noun && kept.join(" ").length + 1 + noun.length <= 26 ? [...kept, noun] : kept.slice(0, -1);
  }
  return kept.join(" ");
}

/** After the first topic a capital starts no sentence: lower-case it, unless the
    word is an acronym or, in Ukrainian copy, a Latin name (Claude, Codex). */
function lowerTopic(text: string, locale: Locale): string {
  const first = text.split(" ")[0] ?? "";
  if (!/^\p{Lu}[\p{Ll}'’-]*$/u.test(first)) return text;
  if (locale === "uk" && /^[A-Za-z]/.test(first)) return text;
  return text.charAt(0).toLocaleLowerCase(locale) + text.slice(1);
}

/** The collapsed group's line: topics while they fit two short lines, then «і
    ще N» for the rest, which is never cut. */
const TOPIC_BUDGET = 46;
export function groupTopics(t: TFunction, locale: Locale, members: readonly DoneItemV1[]): { topics: string; more: string | null } {
  const topics: string[] = [];
  let length = 0;
  for (const member of members) {
    const text = topic(doneSentence(t, member));
    if (!text) continue;
    const next = topics.length ? lowerTopic(text, locale) : text;
    if (topics.length && length + 2 + next.length > TOPIC_BUDGET) break;
    topics.push(next);
    length += (topics.length > 1 ? 2 : 0) + next.length;
  }
  const rest = members.length - topics.length;
  return { topics: topics.join(", "), more: rest > 0 ? t("done.group.more", { count: rest }) : null };
}

export function DoneSection({ items, current, projectNames, surface, place, band, acknowledge = acknowledgeDone }: DoneSectionProps) {
  const { t, locale } = useLocale();
  const phone = surface === "phone";
  /* Folded to its head, remembered per place on this device. */
  const [folded, setFolded] = useState(() => (typeof window === "undefined" ? false : readFolded(place, surface)));
  const toggleFolded = () => {
    writeFolded(place, surface, !folded);
    setFolded(!folded);
  };
  /* Accepted while this panel is open: drawn as receipts until it closes. */
  const [held, setHeld] = useState<ReadonlyMap<string, DoneItemV1>>(() => new Map());
  const [open, setOpen] = useState<ReadonlySet<GroupId>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<DoneItemV1 | null>(null);

  const all = useMemo(() => {
    const keys = new Set(items.map((item) => item.key));
    return [...items, ...[...held.values()].filter((item) => !keys.has(item.key))].sort(newestFirst);
  }, [items, held]);
  const accepted = useCallback((item: DoneItemV1) => held.has(item.key) && !items.some((entry) => entry.key === item.key), [held, items]);

  const run = useCallback((list: readonly DoneItemV1[], undo = false) => {
    if (!list.length) return;
    const apply = (reverse: boolean) => setHeld((previous) => {
      const next = new Map(previous);
      for (const item of list) {
        if (undo !== reverse) next.delete(item.key);
        else next.set(item.key, item);
      }
      return next;
    });
    apply(false);
    setError(null);
    void acknowledge(list, { undo, surface }).then((outcome) => {
      if (outcome.ok) return;
      apply(true);
      setError(t("done.failed", { error: outcome.error }));
    });
  }, [acknowledge, surface, t]);

  if (!all.length) return null;

  const meta = (item: DoneItemV1): ReactNode => {
    const time = clock(item.at, locale);
    const project = item.project && item.project !== current ? projectTitle(item.project, projectNames[item.project]) : null;
    const parts: ReactNode[] = [];
    if (project) parts.push(<span key="project" className="font-semibold">{project}</span>);
    if (item.kind === "pr" && item.refs.pr) {
      parts.push(<a key="pr" href={item.refs.pr.url} target="_blank" rel="noreferrer" className="font-semibold text-accent hover:underline" data-done-pr={item.refs.pr.number}>#{item.refs.pr.number}</a>);
      parts.push(<span key="when">{t("done.meta.merged", { time })}</span>);
    } else if (item.kind === "pipeline") parts.push(<span key="when">{t("done.meta.laneDone", { time })}</span>);
    else if (item.kind === "task") parts.push(<span key="when">{t("done.meta.taskDone", { time })}</span>);
    else if (item.kind === "deploy") parts.push(<span key="when">{t("done.meta.deploy", { time })}</span>);
    else if (item.kind === "report") parts.push(<span key="when">{t(item.look === "publication" ? "done.meta.publication" : "done.meta.incident", { time })}</span>);
    else if (item.kind === "limit" && item.refs.limit) {
      const limit = item.refs.limit;
      const line = limit.to
        ? t("done.limit.closed", { from: clock(limit.from, locale), to: clock(limit.to, locale) })
        : t("done.limit.open", { from: clock(limit.from, locale) });
      parts.push(<span key="when">{limit.lanes ? `${line} ${t("done.limit.lanes", { count: limit.lanes })}` : line}</span>);
    }
    return parts.flatMap((part, index) => (index ? [<span key={`sep-${index}`} aria-hidden className="opacity-60"> · </span>, part] : [part]));
  };

  const sentenceClass = phone ? "text-body font-semibold leading-[1.3] text-primary [overflow-wrap:anywhere]" : "text-[12px] font-semibold leading-[1.35] text-primary [overflow-wrap:anywhere]";
  const metaClass = phone ? "text-label font-medium text-muted [overflow-wrap:anywhere]" : "text-[11px] text-muted [overflow-wrap:anywhere]";
  const rowPad = phone ? "px-4 py-2.5" : "px-2.5 py-2";
  const tile = phone ? "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] bg-canvas" : "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] bg-canvas";
  const tileIcon = phone ? "h-5 w-5" : "h-3.5 w-3.5";
  const quiet = phone
    ? "inline-flex min-h-11 shrink-0 items-center rounded-[8px] px-3 text-label font-semibold text-muted active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
    : "shrink-0 rounded-[6px] px-2 py-0.5 text-[11px] font-semibold text-muted hover:bg-canvas hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
  const acceptButton = phone
    ? "inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-[8px] border border-border px-3 text-label font-semibold text-primary active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    : "inline-flex h-6 min-w-6 shrink-0 items-center justify-center gap-1 rounded-[6px] border border-border px-1 text-[11px] font-semibold text-muted hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

  /* A receipt: a short name that wraps rather than clips, and «прийнято»
     whole at its end; the «·» before it stays on the name's line. A group
     says «Технічні виправлення: 10 прийнято», so a wrap falls after the colon. */
  const receipt = (key: string, title: string, onUndo: () => void, extra: Record<string, string> = {}, tail: string | null = "", body?: ReactNode) => (
    <div key={key} className={`flex min-w-0 items-center gap-2.5 ${rowPad}`} {...extra}>
      <span className={`${tile} bg-success-soft text-success`}><Check className={tileIcon} aria-hidden /></span>
      <span className={`min-w-0 flex-1 ${phone ? "text-body" : "text-[12px]"} leading-[1.35] text-muted [overflow-wrap:anywhere]`} data-done-receipt-text="">
        {body ?? <>
          {title}
          {tail === null ? null : <>{tail ? ` ${tail}` : ""}{"\u00a0· "}<span className="whitespace-nowrap">{t("done.acceptedMark")}</span></>}
        </>}
      </span>
      <button type="button" className={quiet} data-done-undo={key} aria-label={t("done.undoAria", { title: tail ? `${title} ${tail}` : title })} onClick={onUndo}>{t("done.undo")}</button>
    </div>
  );

  /* «Прийняти»: the square check an expanded group's members carry, at the
     right end of the row's first line, a finger's target on the phone. */
  const accept = (item: DoneItemV1) => (
    <button type="button" className={acceptButton} data-done-accept={item.key} aria-label={t("done.acceptAria", { title: doneSentence(t, item) })} title={t("done.accept")} onClick={() => run([item])}>
      <Check className={phone ? "h-[18px] w-[18px]" : "h-3.5 w-3.5"} aria-hidden />
    </button>
  );

  const single = (item: DoneItemV1) => {
    if (accepted(item)) return receipt(item.key, receiptName(doneSentence(t, item)), () => run([item], true), { "data-done-receipt": item.key }, receiptPr(t, item));
    const sentence = doneSentence(t, item);
    if (item.look === "visible" && item.frame) {
      return (
        <div key={item.key} className={`flex min-w-0 items-start gap-3 ${rowPad}`} data-done-row={item.key} data-done-look={item.look}>
          <button
            type="button"
            className={`relative shrink-0 overflow-hidden rounded-[6px] border border-border bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${phone ? "h-[96px] w-[128px]" : "h-[68px] w-[104px]"}`}
            data-done-thumb={item.key}
            aria-label={t("done.thumbOpen", { title: sentence })}
            onClick={() => setViewer(item)}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- a same-origin route serves the frame; the image optimizer has nothing to add. */}
            <img src={item.frame.src} alt="" loading="lazy" className="h-full w-full object-cover object-top" />
            <span aria-hidden className="absolute bottom-1 right-1 inline-flex h-5 w-5 items-center justify-center rounded-[4px] bg-black/65 text-white"><Expand className="h-3 w-3" /></span>
          </button>
          <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
            <span className={`line-clamp-3 ${sentenceClass}`} data-done-sentence="">{sentence}</span>
            <span className={metaClass} data-done-meta="">{meta(item)}</span>
          </div>
          {accept(item)}
        </div>
      );
    }
    const look = LOOK_ICON[item.look] ?? { icon: CircleCheck, tone: "text-muted" };
    const Icon = look.icon;
    /* The check stands at the row's end, beside the sentence's first line. */
    return (
      <div key={item.key} className={`flex min-w-0 items-start gap-2.5 ${rowPad}`} data-done-row={item.key} data-done-look={item.look}>
        <span className={`${tile} ${look.tone}`}><Icon className={tileIcon} aria-hidden /></span>
        <div className={`flex min-w-0 flex-1 flex-col ${phone ? "gap-0.5" : "gap-1"}`}>
          <span className={`line-clamp-2 ${sentenceClass}`} data-done-sentence="">{sentence}</span>
          <span className={metaClass} data-done-meta="">{meta(item)}</span>
        </div>
        {accept(item)}
      </div>
    );
  };

  const group = (id: GroupId, members: readonly DoneItemV1[]) => {
    if (!members.length) return null;
    const name = t(id === "technical" ? "done.group.technical" : "done.group.closed");
    const waiting = members.filter((member) => !accepted(member));
    const taken = members.length - waiting.length;
    if (!waiting.length) {
      const count = t("done.group.acceptedCount", { count: members.length });
      return receipt(`group:${id}`, `${name}: ${count}`, () => run(members, true), { "data-done-group-receipt": id }, null, <>{name}: <span className="whitespace-nowrap">{count}</span></>);
    }
    const Icon = GROUP_ICON[id];
    const expanded = open.has(id);
    /* Collapsed: short topics and «і ще N»; expanded, the members say it
       themselves, so the line keeps only what was accepted. The phone moves a
       partial count onto that line, where «6 з 10» never breaks. */
    const { topics, more } = groupTopics(t, locale, waiting);
    const partial = taken ? t("done.group.partial", { left: waiting.length, total: members.length }) : null;
    const countInLine = phone && partial !== null;
    const line: ReactNode = taken
      ? <>{countInLine ? <span className="whitespace-nowrap">{partial} · </span> : null}<span className="whitespace-nowrap">{t("done.group.acceptedCount", { count: taken })}</span></>
      : expanded ? null : <>{topics}{more ? <>{topics ? " " : ""}<span className="whitespace-nowrap">{more}</span></> : null}</>;
    const acceptGroup = (
      <button type="button" className={acceptButton} data-done-accept-group={id} aria-label={`${name}: ${t("done.acceptCount", { count: waiting.length })}`} title={t("done.acceptCount", { count: waiting.length })} onClick={() => run(waiting)}>
        <CheckCheck className={phone ? "h-[18px] w-[18px]" : "h-3.5 w-3.5"} aria-hidden />
        <span className="tabular-nums">{waiting.length}</span>
      </button>
    );
    return (
      <div key={`group:${id}`} className="min-w-0" data-done-group={id} data-done-group-count={waiting.length}>
        <div className={`flex min-w-0 items-start gap-2.5 ${rowPad}`}>
          <span className={`${tile} text-info`}><Icon className={tileIcon} aria-hidden /></span>
          <div className={`flex min-w-0 flex-1 flex-col ${phone ? "gap-0.5" : "gap-1"}`}>
            <span className={sentenceClass} data-done-group-title="">
              {name}{countInLine ? null : <span className="whitespace-nowrap"> · {partial ?? members.length}</span>}
            </span>
            {line ? <span className={metaClass} data-done-group-line="">{line}</span> : null}
          </div>
          {acceptGroup}
          <button
            type="button"
            className={phone ? "-ml-1.5 inline-flex min-h-11 w-11 shrink-0 items-center justify-center rounded-[8px] text-muted active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" : "-ml-1.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] text-muted hover:bg-canvas hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"}
            aria-expanded={expanded}
            aria-label={t(expanded ? "done.group.collapse" : "done.group.expand", { group: name })}
            data-done-group-toggle={id}
            onClick={() => setOpen((previous) => {
              const next = new Set(previous);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })}
          >
            {expanded ? <ChevronUp className={phone ? "h-5 w-5" : "h-3.5 w-3.5"} aria-hidden /> : <ChevronDown className={phone ? "h-5 w-5" : "h-3.5 w-3.5"} aria-hidden />}
          </button>
        </div>
        {expanded ? (
          <ul className={`m-0 flex list-none flex-col p-0 ${phone ? "pb-1.5 pl-[68px] pr-3" : "pb-1 pl-[46px] pr-2.5"}`}>
            {members.map((member) => {
              const done = accepted(member);
              const sentence = doneSentence(t, member);
              const project = member.project && member.project !== current ? projectTitle(member.project, projectNames[member.project]) : null;
              return (
                <li key={member.key} className={`flex min-w-0 items-start gap-2 ${phone ? "py-1.5" : "py-1"}`} data-done-member={member.key} data-done-accepted={done ? "" : undefined}>
                  <TaskIcon icon={member.icon} title={sentence} size={phone ? 18 : 14} className="mt-0.5" />
                  <span className={`min-w-0 flex-1 ${phone ? "text-body" : "text-[11.5px]"} leading-[1.35] [overflow-wrap:anywhere] ${done ? "text-muted" : "text-primary"}`}>
                    {project ? <span className="font-semibold">{project} · </span> : null}
                    {member.refs.pr ? <><a href={member.refs.pr.url} target="_blank" rel="noreferrer" className="font-semibold text-accent hover:underline" data-done-pr={member.refs.pr.number}>#{member.refs.pr.number}</a>{" "}</> : null}
                    {sentence}
                  </span>
                  <button
                    type="button"
                    aria-pressed={done}
                    aria-label={t(done ? "done.undoAria" : "done.acceptAria", { title: sentence })}
                    data-done-member-check={member.key}
                    className={`inline-flex shrink-0 items-center justify-center rounded-[6px] border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${phone ? "h-11 w-11" : "h-6 w-6"} ${done ? "border-transparent bg-success-soft text-success" : "border-border text-muted hover:border-accent/45 hover:text-accent"}`}
                    onClick={() => run([member], done)}
                  >
                    <Check className={phone ? "h-[18px] w-[18px]" : "h-3.5 w-3.5"} aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    );
  };

  /* Newest first: a row at its own time, a group at its newest member's, so
     a new outcome lands on top and an accepted one keeps its place. */
  const blocks: Array<{ key: string; at: number; node: ReactNode }> = [];
  const groups: Record<GroupId, DoneItemV1[]> = { technical: [], closed: [] };
  for (const item of all) {
    if (item.look === "technical" || item.look === "closed") groups[item.look].push(item);
    else blocks.push({ key: item.key, at: Date.parse(item.at), node: single(item) });
  }
  for (const id of ["technical", "closed"] as const) {
    const members = groups[id];
    if (members.length) blocks.push({ key: `group:${id}`, at: Math.max(...members.map((member) => Date.parse(member.at))), node: group(id, members) });
  }
  blocks.sort((left, right) => right.at - left.at || left.key.localeCompare(right.key));
  const heldAll = items.length === 0;
  const FoldIcon = folded ? ChevronRight : ChevronDown;
  const head = (
    <div className={`flex min-w-0 items-center gap-1 ${phone ? "min-h-11 pl-1 pr-2" : "pr-1"}`}>
      <h3 className="m-0 flex min-w-0 flex-1" data-done-title="">
        <button
          type="button"
          className={`flex min-w-0 flex-1 items-center gap-1.5 text-left text-label font-semibold text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 ${phone ? "min-h-11 rounded-[8px] pl-3" : "rounded-[6px] py-1.5 pl-1.5 hover:bg-canvas"}`}
          aria-expanded={!folded}
          aria-label={t(folded ? "done.unfold" : "done.fold", { count: items.length })}
          data-done-fold={folded ? "folded" : "open"}
          onClick={toggleFolded}
        >
          <FoldIcon className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 truncate">{t("done.title")}</span>
          <span className="text-caption font-semibold tabular-nums text-muted" data-done-count="">{items.length}</span>
        </button>
      </h3>
      {items.length ? (
        <button
          type="button"
          className={phone ? "inline-flex min-h-11 shrink-0 items-center rounded-[8px] px-2 text-ui font-semibold text-accent active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" : "shrink-0 rounded-[6px] px-2 py-0.5 text-[11px] font-semibold text-accent hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"}
          data-done-accept-all=""
          title={t("done.acceptAllTitle")}
          onClick={() => run(items)}
        >
          {t("done.acceptAll")}
        </button>
      ) : null}
    </div>
  );

  const lightbox = viewer?.frame ? (() => {
    const sentence = doneSentence(t, viewer);
    const image: GalleryImage = { src: viewer.frame.src, alt: sentence, caption: sentence, detail: viewer.frame.caption || undefined, ...(viewer.frame.before ? { before: { src: viewer.frame.before, alt: sentence, caption: sentence } } : {}) };
    return (
      <ImageGalleryProvider value={() => [image]}>
        <Lightbox src={image.src} alt={image.alt} caption={image.caption} detail={image.detail} onClose={() => setViewer(null)} />
      </ImageGalleryProvider>
    );
  })() : null;

  return (
    <section
      className={`flex min-h-0 shrink-0 flex-col border-b border-border ${phone ? "" : "mx-1.5 mt-0.5 pb-0.5"} ${band ?? ""}`}
      data-done-section={surface}
      data-done-place={place}
      data-done-folded={folded ? "" : undefined}
      aria-label={t("done.title")}
    >
      {head}
      {folded ? null : (
        <div className={`min-h-0 ${band ? "flex-1 overflow-y-auto overscroll-y-contain" : ""}`} data-done-list="">
          {error ? <p className={`m-0 ${phone ? "px-4 py-1.5 text-label" : "px-2.5 py-1.5 text-[11px]"} text-danger`} role="status" data-done-error="">{error}</p> : null}
          {heldAll ? receipt("all", t("done.allAccepted", { count: all.length }), () => run(all, true), { "data-done-all-accepted": "" }, null) : blocks.map((block) => block.node)}
        </div>
      )}
      {lightbox}
    </section>
  );
}
