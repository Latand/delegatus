"use client";

import { Check, CheckCheck, ChevronDown, ChevronUp, CircleCheck, Expand, Gauge, GitMerge, Globe, Rocket, TriangleAlert, type LucideIcon } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { ImageGalleryProvider, Lightbox, type GalleryImage } from "@/components/feed/Lightbox";
import { TaskIcon } from "@/components/tasks/TaskIcon";
import { projectTitle } from "@/lib/displayNames";
import type { DoneItemV1 } from "@/lib/done/types";
import { useLocale, type Locale, type TFunction } from "@/lib/i18n";

import { acknowledgeDone } from "./doneItems";

/*
 * «Готово» (docs/design/done-section.md §4.3): the last block of «Чекають на
 * вас», on the desktop panel and in the phone sheet alike. Visible changes come
 * first, each with the frame its lane rendered; then deploys and publications;
 * then two groups, technical fixes and work finished without a PR, which one
 * button accepts whole and which open to their members; then incidents and
 * account limits. Decisions stay above it, and once everything here is
 * accepted the panel is the decisions list it was.
 *
 * Accepting is one durable write per click (`acknowledgeDone`), gone from
 * every count at once. While the panel is open an accepted row stays where it
 * was as «… · прийнято» with «Повернути»; it leaves when the panel closes,
 * because this component holds those receipts and closes with it.
 */

export type DoneSurface = "desktop" | "phone";

export interface DoneSectionProps {
  /** The items still waiting, newest first. */
  items: readonly DoneItemV1[];
  /** The project on screen; a row of another names its project. */
  current: string | null;
  projectNames: Readonly<Record<string, string>>;
  surface: DoneSurface;
  /** Test seam. */
  acknowledge?: typeof acknowledgeDone;
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

/** A short name for a receipt: the sentence, cut, with its PR. */
function shortName(t: TFunction, item: DoneItemV1): string {
  const sentence = doneSentence(t, item);
  const cut = sentence.length > 48 ? `${sentence.slice(0, 47).trimEnd()}…` : sentence;
  return item.refs.pr && !cut.includes(`#${item.refs.pr.number}`) ? `${cut} #${item.refs.pr.number}` : cut;
}

export function DoneSection({ items, current, projectNames, surface, acknowledge = acknowledgeDone }: DoneSectionProps) {
  const { t, locale } = useLocale();
  const phone = surface === "phone";
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
    else if (item.kind === "deploy") parts.push(<span key="when">{t("done.meta.deploy", { sha: (item.refs.sha ?? "").slice(0, 8), time })}</span>);
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
    : "inline-flex h-7 shrink-0 items-center gap-1 rounded-[6px] border border-border px-2 text-[11px] font-semibold text-primary hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

  const receipt = (key: string, title: string, onUndo: () => void, extra: Record<string, string> = {}) => (
    <div key={key} className={`flex min-w-0 items-center gap-2.5 ${rowPad}`} {...extra}>
      <span className={`${tile} bg-success-soft text-success`}><Check className={tileIcon} aria-hidden /></span>
      <span className={`min-w-0 flex-1 truncate ${phone ? "text-body" : "text-[12px]"} text-muted`}>{title}</span>
      <button type="button" className={quiet} data-done-undo={key} aria-label={t("done.undoAria", { title })} onClick={onUndo}>{t("done.undo")}</button>
    </div>
  );

  /* «Прийняти»: a check with its word on the desktop, the frames' square check on the phone. */
  const accept = (item: DoneItemV1) => (
    <button type="button" className={acceptButton} data-done-accept={item.key} aria-label={t("done.acceptAria", { title: doneSentence(t, item) })} onClick={() => run([item])}>
      <Check className={phone ? "h-[18px] w-[18px]" : "h-3.5 w-3.5"} aria-hidden />
      {phone ? null : <span>{t("done.accept")}</span>}
    </button>
  );

  const single = (item: DoneItemV1) => {
    if (accepted(item)) return receipt(item.key, t("done.accepted", { title: shortName(t, item) }), () => run([item], true), { "data-done-receipt": item.key });
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
            {accept(item)}
          </div>
        </div>
      );
    }
    const look = LOOK_ICON[item.look] ?? { icon: CircleCheck, tone: "text-muted" };
    const Icon = look.icon;
    /* The desktop column is narrow: «Прийняти» goes under the words, as on a
       visible row; the phone's square check stands at the row's end. */
    return (
      <div key={item.key} className={`flex min-w-0 items-start gap-2.5 ${rowPad}`} data-done-row={item.key} data-done-look={item.look}>
        <span className={`${tile} ${look.tone}`}><Icon className={tileIcon} aria-hidden /></span>
        <div className={`flex min-w-0 flex-1 flex-col ${phone ? "gap-0.5" : "items-start gap-1"}`}>
          <span className={`line-clamp-2 ${sentenceClass}`} data-done-sentence="">{sentence}</span>
          <span className={metaClass} data-done-meta="">{meta(item)}</span>
          {phone ? null : accept(item)}
        </div>
        {phone ? accept(item) : null}
      </div>
    );
  };

  const group = (id: GroupId, members: readonly DoneItemV1[]) => {
    if (!members.length) return null;
    const name = t(id === "technical" ? "done.group.technical" : "done.group.closed");
    const waiting = members.filter((member) => !accepted(member));
    const taken = members.length - waiting.length;
    if (!waiting.length) {
      return receipt(`group:${id}`, t("done.accepted", { title: `${name} · ${members.length}` }), () => run(members, true), { "data-done-group-receipt": id });
    }
    const Icon = GROUP_ICON[id];
    const expanded = open.has(id);
    /* The first three sentences, each cut at a word, and how many more. */
    const preview = waiting.slice(0, 3).map((member) => {
      const sentence = doneSentence(t, member);
      if (sentence.length <= 34) return sentence;
      const room = sentence.slice(0, 33);
      const space = room.lastIndexOf(" ");
      return `${(space > 16 ? room.slice(0, space) : room).trimEnd()}…`;
    }).join(", ") + (waiting.length > 3 ? ` ${t("done.group.more", { count: waiting.length - 3 })}` : "");
    const acceptGroup = (
      <button type="button" className={acceptButton} data-done-accept-group={id} aria-label={`${name}: ${t("done.acceptCount", { count: waiting.length })}`} onClick={() => run(waiting)}>
        <CheckCheck className={phone ? "h-[18px] w-[18px]" : "h-3.5 w-3.5"} aria-hidden />
        <span className="tabular-nums">{phone ? waiting.length : t("done.acceptCount", { count: waiting.length })}</span>
      </button>
    );
    return (
      <div key={`group:${id}`} className="min-w-0" data-done-group={id} data-done-group-count={waiting.length}>
        <div className={`flex min-w-0 items-start gap-2.5 ${rowPad}`}>
          <span className={`${tile} text-info`}><Icon className={tileIcon} aria-hidden /></span>
          <div className={`flex min-w-0 flex-1 flex-col ${phone ? "gap-0.5" : "items-start gap-1"}`}>
            <span className={sentenceClass} data-done-group-title="">
              {name} · {taken ? t("done.group.partial", { left: waiting.length, total: members.length }) : members.length}
            </span>
            <span className={`line-clamp-2 ${metaClass}`} data-done-group-line="">{taken ? t("done.group.acceptedCount", { count: taken }) : preview}</span>
            {phone ? null : acceptGroup}
          </div>
          {phone ? acceptGroup : null}
          <button
            type="button"
            className={phone ? "inline-flex min-h-11 w-11 shrink-0 items-center justify-center rounded-[8px] text-muted active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" : "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-muted hover:bg-canvas hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"}
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

  const looks = (wanted: ReadonlyArray<DoneItemV1["look"]>) => all.filter((item) => wanted.includes(item.look));
  const heldAll = items.length === 0;
  const head = (
    <div className={`flex min-w-0 items-center gap-1 ${phone ? "min-h-11 pl-4 pr-2" : "pl-1.5 pr-1"}`}>
      <h3 className={`m-0 flex min-w-0 flex-1 items-center gap-1.5 ${phone ? "text-label" : "py-1.5 text-label"} font-semibold text-secondary`} data-done-title="">
        <span className="min-w-0 truncate">{t("done.title")}</span>
        <span className="text-caption font-semibold tabular-nums text-muted" data-done-count="">{items.length}</span>
      </h3>
      {items.length ? (
        <button
          type="button"
          className={phone ? "inline-flex min-h-11 shrink-0 items-center rounded-[8px] px-2 text-ui font-semibold text-accent active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" : "shrink-0 rounded-[6px] px-2 py-0.5 text-[11px] font-semibold text-accent hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"}
          data-done-accept-all=""
          title={t("done.acceptAllTitle")}
          onClick={() => run(items)}
        >
          {t("done.acceptAll", { count: items.length })}
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
    <section className={phone ? "flex flex-col border-t border-border pt-1" : "mt-1 border-t border-border pt-1"} data-done-section={surface} aria-label={t("done.title")}>
      {head}
      {error ? <p className={`m-0 ${phone ? "px-4 py-1.5 text-label" : "px-2.5 py-1.5 text-[11px]"} text-danger`} role="status" data-done-error="">{error}</p> : null}
      {heldAll ? receipt("all", t("done.allAccepted", { count: all.length }), () => run(all, true), { "data-done-all-accepted": "" }) : (
        <>
          {looks(["visible"]).map(single)}
          {looks(["deploy", "publication"]).map(single)}
          {group("technical", looks(["technical"]))}
          {group("closed", looks(["closed"]))}
          {looks(["incident", "limit"]).map(single)}
        </>
      )}
      {lightbox}
    </section>
  );
}
