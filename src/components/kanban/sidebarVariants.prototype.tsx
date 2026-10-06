"use client";

import { Gauge, LayoutGrid, PanelLeftClose, PanelLeftOpen, Search, User } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { attentionId } from "@/components/attention";
import { DelegatusMark } from "@/components/brand/BrandMark";
import { CatalogFailureNotice } from "@/components/CatalogFailureNotice";
import { EngineMark } from "@/components/EngineMark";
import { FlipRow } from "@/components/FlipRow";
import { Archive, ChevronLeft, ChevronRight, Crown, FolderPlus } from "@/components/icons";
import { Z } from "@/components/layers";
import { LimitsFooter } from "@/components/LimitsFooter";
import { buildProjectSummaries, OVERVIEW, partitionCrownedSummaries, projectKey, type ProjectSummary } from "@/components/projectModel";
import { CreateProjectForm, RAIL_FOOTER_STORAGE_KEY, RailHeaderMenu, RailPrototypeContext, type ProjectRailProps } from "@/components/ProjectRail";
import type { RailFooterDensity } from "@/components/railFooterDensity";
import { ResourcesFooter } from "@/components/ResourcesFooter";
import { BoardRowsSkeleton } from "@/components/skeletons";
import { PRODUCT_NAME } from "@/lib/brand";
import { projectMatchesQuery } from "@/lib/displayNames";
import { useLocale } from "@/lib/i18n";

/*
 * The left sidebar, three numbered design variants (docs/design/sidebar-redesign.md).
 *
 * Design only. The kanban evidence fixture provides one of these through
 * `RailPrototypeContext`; the product never does, so the Viewer keeps drawing
 * today's rail. Every variant receives exactly what today's rail receives and
 * is assembled from the rail's own parts: the header menu, the create form,
 * the crown toggle's request, the resources and limits blocks with their
 * panels, and the summaries `buildProjectSummaries` computes. What a variant
 * changes is where those parts sit and how a project row reads.
 *
 *   1  the full sidebar, tidied: one-line rows with each mark in its own
 *      column, labelled sections on one left edge, and a system block of one
 *      line per reading; `?railask=1` adds variant 3's question line to it,
 *      which is the note's recommendation;
 *   2  a narrow rail of project tiles and gauges; the full sidebar opens beside
 *      it on hover, so the rail stays under the pointer, and docks on request;
 *   3  rows that say what waits on the operator and which engines are working,
 *      with quiet projects folded to one line.
 */

export const RAIL_VARIANTS = [0, 1, 2, 3] as const;
export type RailVariant = (typeof RAIL_VARIANTS)[number];
type Lang = "en" | "uk";

/** The strip that prints the variant's number above the application frame. */
export const RAIL_STRIP_HEIGHT = 32;

const TITLES: Record<Lang, Record<RailVariant, string>> = {
  en: { 0: "Today", 1: "Tidied sidebar, compact system block", 2: "Narrow rail that opens", 3: "Projects that say who waits and who runs" },
  uk: { 0: "Сьогодні", 1: "Впорядкована панель, компактний системний блок", 2: "Вузька рейка, що розкривається", 3: "Проєкти, які кажуть, хто чекає і хто працює" },
};

const COPY = {
  en: {
    pinned: "Pinned", projects: "Projects", system: "System", needsYou: "{n} need you", needsYouOne: "1 needs you", working: "{n} working",
    conversations: "{n} conversations", conversationsOne: "1 conversation", updated: "updated {age}", detail: "Every limit window and its reset", compact: "One line per reading",
    detailShort: "All windows", compactShort: "Compact", withAsk: "with the question line from 3",
    open: "Open the sidebar", dock: "Keep the sidebar open", undock: "Fold the sidebar to a rail", find: "Find a project",
  },
  uk: {
    pinned: "Закріплені", projects: "Проєкти", system: "Система", needsYou: "{n} чекають на вас", needsYouOne: "1 чекає на вас", working: "{n} працює",
    conversations: "розмов: {n}", conversationsOne: "1 розмова", updated: "оновлено {age}", detail: "Усі вікна лімітів і час скидання", compact: "Один рядок на показник",
    detailShort: "Усі вікна", compactShort: "Коротко", withAsk: "із рядком питання з варіанта 3",
    open: "Відкрити панель", dock: "Тримати панель відкритою", undock: "Згорнути панель до рейки", find: "Знайти проєкт",
  },
} as const;
type CopyKey = keyof (typeof COPY)["en"];

function useCopy() {
  const { locale, t } = useLocale();
  const lang: Lang = locale === "uk" ? "uk" : "en";
  const c = useCallback((key: CopyKey, values: Record<string, string | number> = {}) =>
    Object.entries(values).reduce<string>((text, [name, value]) => text.replace(`{${name}}`, String(value)), COPY[lang][key]), [lang]);
  return { c, t, lang };
}

export function parseRailVariant(search: string): RailVariant | null {
  const raw = new URLSearchParams(search).get("railv");
  if (raw === null) return null;
  const value = Number(raw);
  return (RAIL_VARIANTS as readonly number[]).includes(value) ? (value as RailVariant) : null;
}

/** An age short enough for a column: `31s`, `11m`, `3h`, `6d`. */
function shortAge(smt: number, now: number, lang: Lang): string {
  if (!Number.isFinite(smt) || smt <= 0) return "";
  const seconds = Math.max(0, now - smt);
  const [value, unit] = seconds < 90 ? [Math.round(seconds), 0] : seconds < 5_400 ? [Math.round(seconds / 60), 1] : seconds < 129_600 ? [Math.round(seconds / 3_600), 2] : [Math.round(seconds / 86_400), 3];
  return lang === "uk" ? `${value} ${["с", "хв", "год", "д"][unit]}` : `${value}${["s", "m", "h", "d"][unit]}`;
}

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
const SQUARE = `flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[8px] border border-border bg-card text-muted hover:text-primary ${FOCUS}`;

interface RowFacts extends ProjectSummary {
  /** Engines with a live transcript in the project, each once. */
  engines: string[];
  /** The oldest thing in the project that waits on the operator, by its title. */
  asks: string | null;
}

function useRailModel({ files, projectCatalog, projectDisplayNames = {}, pipelines, workflows, archivedProjects, crownedProjects, now, needsYouCounts, loaded, catalogFailures = 0 }: ProjectRailProps) {
  const [query, setQuery] = useState("");
  const crowns = useMemo(() => crownedProjects ?? new Set<string>(), [crownedProjects]);
  const summaries = useMemo(
    () => buildProjectSummaries(files, now, workflows, projectCatalog, pipelines, projectDisplayNames, needsYouCounts),
    [files, now, workflows, projectCatalog, pipelines, projectDisplayNames, needsYouCounts],
  );
  const facts = useMemo(() => {
    const engines = new Map<string, Set<string>>();
    const asks = new Map<string, { title: string; since: number }>();
    for (const file of files) {
      const key = projectKey(file);
      if (file.activity === "live") engines.set(key, (engines.get(key) ?? new Set()).add(file.engine));
      if (attentionId(file, now) !== null) {
        const since = file.waitingInput?.since ?? file.mtime;
        if (!asks.has(key) || since < asks.get(key)!.since) asks.set(key, { title: file.title, since });
      }
    }
    return summaries.map((summary): RowFacts => ({ ...summary, engines: [...(engines.get(summary.project) ?? [])].sort(), asks: asks.get(summary.project)?.title ?? null }));
  }, [summaries, files, now]);
  const visible = useMemo(() => facts.filter((row) => projectMatchesQuery(row.project, query, row.displayName)), [facts, query]);
  const active = useMemo(() => visible.filter((row) => !archivedProjects.has(row.project)), [visible, archivedProjects]);
  const archived = useMemo(() => visible.filter((row) => archivedProjects.has(row.project)), [visible, archivedProjects]);
  const { crowned, rest } = useMemo(() => partitionCrownedSummaries(active, crowns), [active, crowns]);
  return {
    query, setQuery, crowns, crowned, rest, archived, active,
    totalLive: facts.reduce((sum, row) => sum + row.liveCount, 0),
    totalAttention: facts.reduce((sum, row) => sum + row.attentionCount, 0),
    firstRun: loaded && catalogFailures === 0 && !summaries.length,
  };
}
type RailModel = ReturnType<typeof useRailModel>;

/** How many wait on the operator: the person mark the board's Waiting cards carry, and a number. */
function NeedsMark({ count }: { count: number }) {
  const { c } = useCopy();
  if (count <= 0) return null;
  return (
    <span data-rail-needs="" title={count === 1 ? c("needsYouOne") : c("needsYou", { n: count })} className="inline-flex h-[18px] shrink-0 items-center gap-[3px] rounded-full bg-warning-soft px-1 text-[10.5px] font-bold tabular-nums text-warning">
      <User className="h-2.5 w-2.5" strokeWidth={2.6} aria-hidden />
      {count > 99 ? "99+" : count}
    </span>
  );
}

/** How many are working: the green dot of the board header's "N working", and a number. */
function LiveMark({ count }: { count: number }) {
  const { c } = useCopy();
  if (count <= 0) return null;
  return (
    <span data-rail-live="" title={c("working", { n: count })} className="inline-flex shrink-0 items-center gap-1 text-[10.5px] font-bold tabular-nums text-success">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success motion-reduce:animate-none" />
      {count > 99 ? "99+" : count}
    </span>
  );
}

/**
 * The two marks of a one-line row, each in a column of its own, so "waiting"
 * and "working" are read down the list. A column exists while some project
 * carries its mark; a row without the mark keeps the column empty.
 */
function MarkColumns({ needs, live, model }: { needs: number; live: number; model: RailModel }) {
  return (
    <>
      {model.totalAttention ? <span data-rail-slot="needs" className={SLOT_NEEDS}><NeedsMark count={needs} /></span> : null}
      {model.totalLive ? <span data-rail-slot="live" className="flex w-6 shrink-0 items-center"><LiveMark count={live} /></span> : null}
    </>
  );
}
const SLOT_NEEDS = "flex w-8 shrink-0 items-center";
const SLOT_AGE = "w-[30px] shrink-0 text-right text-[10.5px] tabular-nums text-muted";

/* Every label in the list starts where a project's name starts: 11 px inside the list's own 8 px. */
function SectionLabel({ children, count, icon }: { children: ReactNode; count?: number; icon?: ReactNode }) {
  return (
    <div className="flex h-6 items-center gap-1.5 px-[11px] text-[11px] font-bold text-muted">
      <span data-rail-label="">{children}</span>
      {count === undefined ? null : <span className="font-semibold tabular-nums">{count}</span>}
      {icon}
    </div>
  );
}

function CrownToggle({ crowned, onToggle }: { crowned: boolean; onToggle: () => void }) {
  const { t } = useLocale();
  return (
    <button
      type="button"
      className={`group/crown absolute right-1.5 top-[5px] flex h-[22px] w-[22px] items-center justify-center rounded-[7px] border border-border bg-card opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 ${FOCUS}`}
      title={crowned ? t("rail.uncrown") : t("rail.crown")}
      aria-label={crowned ? t("rail.uncrown") : t("rail.crown")}
      aria-pressed={crowned}
      onClick={onToggle}
    >
      <Crown className={`h-3.5 w-3.5 ${crowned ? "fill-crown text-crown" : "text-muted [stroke-dasharray:2_3] group-hover/crown:fill-crown group-hover/crown:text-crown group-hover/crown:[stroke-dasharray:0]"}`} aria-hidden />
    </button>
  );
}

/** `line` is variant 1's row, `ask` adds the question under a row that waits, `rich` is variant 3's row. */
type RowKind = "line" | "ask" | "rich";

function ProjectRow({ row, kind, props, model, crowned }: { row: RowFacts; kind: RowKind; props: ProjectRailProps; model: RailModel; crowned: boolean }) {
  const { c, lang } = useCopy();
  const active = props.selected === row.project;
  const age = shortAge(row.smt, props.now, lang);
  const total = row.conversations === 1 ? c("conversationsOne") : c("conversations", { n: row.conversations });
  const rich = kind === "rich";
  const busy = row.attentionCount > 0 || row.liveCount > 0;
  const waits = row.attentionCount ? (row.attentionCount === 1 ? c("needsYouOne") : c("needsYou", { n: row.attentionCount })) : null;
  /* The question is cut after two lines in the row, so the tooltip carries all of it. */
  const question = kind !== "line" && row.attentionCount ? row.asks : null;
  const title = [row.displayName, waits && question ? `${waits}: ${question}` : waits, row.liveCount ? c("working", { n: row.liveCount }) : null, total, age ? c("updated", { age }) : null].filter(Boolean).join(" · ");
  return (
    <div data-flip-key={row.project} className="group relative">
      <button
        type="button"
        data-rail-project={row.project}
        title={title}
        aria-current={active ? "page" : undefined}
        onClick={() => props.onSelect(row.project)}
        className={`mb-px block w-full rounded-[10px] border px-2.5 text-left ${FOCUS} ${active ? "border-border bg-canvas" : "border-transparent hover:bg-canvas"} ${row.catalogOnly ? "opacity-70" : ""}`}
      >
        <span className={`flex items-center gap-1.5 ${rich && busy ? "pt-1.5" : "min-h-[30px] py-1.5"}`}>
          {/* A name longer than its column takes a second line before it is cut. */}
          <span data-rail-name="" className={`line-clamp-2 min-w-0 flex-1 break-words text-[13px] leading-[18px] ${active ? "font-bold" : "font-semibold"} ${row.catalogOnly ? "text-muted" : ""}`}>{row.displayName}</span>
          {rich ? null : <MarkColumns needs={row.attentionCount} live={row.liveCount} model={model} />}
          <span data-rail-slot="age" className={SLOT_AGE}>{age}</span>
        </span>
        {kind === "ask" && question ? <span data-rail-ask="" className="-mt-0.5 block pb-1.5 text-[11.5px] leading-[15px] text-warning line-clamp-2">{question}</span> : null}
        {rich && busy ? (
          <span className="block pb-1.5 pt-0.5">
            {row.attentionCount ? (
              <span className="flex min-h-5 items-start gap-1.5 py-px">
                <span className={SLOT_NEEDS}><NeedsMark count={row.attentionCount} /></span>
                <span data-rail-ask="" className="min-w-0 pt-px text-[11.5px] leading-[15px] text-warning line-clamp-2">{question ?? waits}</span>
              </span>
            ) : null}
            {row.liveCount ? (
              <span className="flex h-5 items-center gap-1.5">
                {/* The dot stands under the person glyph of the mark above it. */}
                <span className={`${SLOT_NEEDS} pl-[6px]`}><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success motion-reduce:animate-none" /></span>
                <span className="text-[11.5px] font-semibold tabular-nums text-success">{c("working", { n: row.liveCount })}</span>
                <span className="flex items-center gap-1">{row.engines.map((engine) => <EngineMark key={engine} engine={engine} size={12} label={engine} />)}</span>
              </span>
            ) : null}
          </span>
        ) : null}
        {active ? <span className="-mt-0.5 block pb-1.5 text-[10.5px] text-muted">{total}</span> : null}
      </button>
      {props.onToggleCrown ? <CrownToggle crowned={crowned} onToggle={() => props.onToggleCrown!(row.project, !crowned)} /> : null}
    </div>
  );
}

/** Where this browser remembers whether the system block shows every limit window. */
const DETAIL_STORAGE_KEY = "llv:rail-proto-footer-detail:v1";
/** Where this browser remembers whether the narrow rail is docked open. */
const DOCK_STORAGE_KEY = "llv:rail-proto-dock:v1";

/* The prototypes are drawn in the browser only, so the stored choice is read at the first render. */
function useStored(key: string, on: string, off: string): [boolean, () => void] {
  const [value, setValue] = useState(() => {
    try { return window.localStorage.getItem(key) === on; } catch { return false; /* private mode: the default holds for this page */ }
  });
  const toggle = useCallback(() => setValue((current) => {
    try { window.localStorage.setItem(key, current ? off : on); } catch { /* private mode: the choice holds for this page only */ }
    return !current;
  }), [key, on, off]);
  return [value, toggle];
}

/**
 * The rail's footer under the same fold and the same storage key as today's,
 * so a footer the operator folded stays folded. Open, it draws one line per
 * reading; one control swaps that for today's full blocks and back.
 */
function SystemBlock({ gauges = false }: { gauges?: boolean }) {
  const { c, t } = useCopy();
  const [folded, toggleFold] = useStored(RAIL_FOOTER_STORAGE_KEY, "folded", "open");
  const [detail, toggleDetail] = useStored(DETAIL_STORAGE_KEY, "full", "line");
  const density: RailFooterDensity = gauges ? "gauge" : detail ? "full" : "line";
  if (gauges) {
    return (
      <div className="flex shrink-0 flex-col items-center gap-0.5 border-t border-border py-1.5" data-rail-footer={folded ? "folded" : "open"}>
        <button type="button" data-rail-footer-toggle="" aria-expanded={!folded} aria-label={t(folded ? "rail.footerShow" : "rail.footerHide")} title={t(folded ? "rail.footerShow" : "rail.footerHide")} onClick={toggleFold} className={`flex h-6 w-10 items-center justify-center rounded-[8px] text-muted hover:bg-canvas hover:text-primary ${FOCUS}`}>
          {folded ? <Gauge className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3 w-3 rotate-90" aria-hidden />}
        </button>
        {folded ? null : (
          <>
            <ResourcesFooter density="gauge" />
            <LimitsFooter density="gauge" />
          </>
        )}
      </div>
    );
  }
  return (
    <div className="shrink-0" data-rail-footer={folded ? "folded" : "open"}>
      <div className="flex items-center border-t border-border">
        <button type="button" data-rail-footer-toggle="" aria-expanded={!folded} aria-label={t(folded ? "rail.footerShow" : "rail.footerHide")} title={t(folded ? "rail.footerShow" : "rail.footerHide")} onClick={toggleFold} className={`flex h-7 min-w-0 flex-1 items-center gap-1.5 pl-[19px] pr-2 text-left text-[11px] font-bold text-muted hover:bg-canvas ${FOCUS}`}>
          <span data-rail-label="">{t("rail.footerLabel")}</span>
          <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${folded ? "" : "rotate-90"}`} aria-hidden />
        </button>
        {folded ? null : (
          /* The only way to every window and its reset time, so it is named in words. */
          <button type="button" data-rail-footer-detail="" aria-pressed={detail} title={c(detail ? "compact" : "detail")} onClick={toggleDetail} className={`mr-1.5 flex h-[22px] shrink-0 items-center rounded-[7px] px-1.5 text-[10.5px] font-semibold text-muted hover:bg-canvas hover:text-primary ${FOCUS}`}>
            {c(detail ? "compactShort" : "detailShort")}
          </button>
        )}
      </div>
      {folded ? null : (
        <div className={density === "line" ? "pb-1" : ""}>
          <ResourcesFooter density={density} />
          <LimitsFooter density={density} />
        </div>
      )}
    </div>
  );
}

/** `beside` is the header of the sidebar opened next to the narrow rail, which already carries the mark and the menu. */
function RailHeader({ onHide, children, beside = false }: { onHide?: () => void; children?: ReactNode; beside?: boolean }) {
  const { t } = useLocale();
  return (
    <header className={`flex h-10 shrink-0 items-center gap-2 border-b border-border pr-2 text-[13.5px] font-bold ${beside ? "pl-[19px]" : "pl-2"}`}>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        {beside ? null : <DelegatusMark size={20} />}
        <span className="min-w-0 truncate" data-rail-brand="">{PRODUCT_NAME}</span>
      </span>
      {children}
      {onHide ? (
        <button type="button" data-rail-hide="" className={SQUARE} title={t("rail.hide")} aria-label={t("rail.hide")} onClick={onHide}>
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : null}
      {beside ? null : <RailHeaderMenu />}
    </header>
  );
}

/** The whole rail at full width: header, filter and create, the project list, the system block. */
function FullRail({ props, model, kind, headerExtra, start, beside = false }: { props: ProjectRailProps; model: RailModel; kind: RowKind; headerExtra?: ReactNode; start?: "filter" | "create" | "archive" | null; beside?: boolean }) {
  const { c, t } = useCopy();
  const [createOpen, setCreateOpen] = useState(start === "create");
  const [archiveOpen, setArchiveOpen] = useState(start === "archive");
  const filter = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (start === "filter") filter.current?.focus();
  }, [start]);
  const { crowned, rest, archived, crowns, query, setQuery, firstRun } = model;
  const row = (entry: RowFacts) => <ProjectRow key={entry.project} row={entry} kind={kind} props={props} model={model} crowned={crowns.has(entry.project)} />;
  const overview = props.selected === OVERVIEW;
  return (
    <>
      <RailHeader onHide={props.onHide} beside={beside}>{headerExtra}</RailHeader>
      <div className="flex gap-1.5 px-2 pb-1 pt-2">
        <label className={`flex h-[30px] min-w-0 flex-1 items-center gap-1.5 rounded-[9px] border border-border bg-canvas px-2 focus-within:ring-2 focus-within:ring-accent/40`}>
          <Search className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
          <input ref={filter} data-rail-filter="" className="w-full min-w-0 bg-transparent text-[12px] outline-none" placeholder={t("rail.filter")} value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        {props.onCreateProject ? (
          <button
            type="button"
            data-testid="rail-create-project"
            className={`flex h-[30px] shrink-0 items-center justify-center gap-1.5 rounded-[9px] border bg-canvas ${FOCUS} ${firstRun ? "border-accent/45 px-2.5 text-[12px] font-semibold text-accent hover:bg-accent/10" : `w-[30px] border-border hover:text-primary ${createOpen ? "text-primary" : "text-muted"}`}`}
            title={t("rail.createProject")}
            aria-label={t("rail.createProject")}
            aria-expanded={createOpen}
            onClick={() => setCreateOpen((value) => !value)}
          >
            <FolderPlus className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {firstRun ? <span className="truncate">{t("rail.createProject")}</span> : null}
          </button>
        ) : null}
      </div>
      {createOpen && props.onCreateProject ? (
        <CreateProjectForm onCreate={props.onCreateProject} onCreated={(project) => { setCreateOpen(false); props.onSelect(project); }} onCancel={() => setCreateOpen(false)} />
      ) : null}
      <nav className="flex-1 overflow-y-auto px-2 pb-2 pt-1" aria-label={t("rail.projects")}>
        <button
          type="button"
          data-rail-overview=""
          aria-current={overview ? "page" : undefined}
          onClick={() => props.onSelect(OVERVIEW)}
          className={`mb-1 flex min-h-[32px] w-full items-center gap-1.5 rounded-[10px] border px-2.5 py-1.5 text-left ${FOCUS} ${overview ? "border-border bg-canvas" : "border-transparent hover:bg-canvas"}`}
        >
          {/* The grid follows the word, so Overview starts on the edge every name starts on. */}
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span data-rail-label="" className={`min-w-0 truncate text-[13px] ${overview ? "font-bold" : "font-semibold"}`}>{t("rail.overview")}</span>
            <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
          </span>
          {kind === "rich" ? <><NeedsMark count={model.totalAttention} /><LiveMark count={model.totalLive} /></> : <><MarkColumns needs={model.totalAttention} live={model.totalLive} model={model} /><span className={SLOT_AGE} /></>}
        </button>
        {crowned.length ? <SectionLabel icon={<Crown className="h-3 w-3 fill-crown text-crown" aria-hidden />}>{c("pinned")}</SectionLabel> : null}
        <FlipRow>
          {crowned.map(row)}
          {crowned.length || rest.length ? <div data-flip-key="__projects-label__" className={crowned.length ? "mt-1.5" : ""}><SectionLabel count={rest.length}>{c("projects")}</SectionLabel></div> : null}
          {rest.map(row)}
        </FlipRow>
        {archived.length ? (
          <>
            <button type="button" data-rail-archive="" className={`mt-1.5 flex h-6 w-full items-center gap-1.5 rounded-[8px] px-[11px] text-left text-[11px] font-bold text-muted hover:bg-canvas ${FOCUS}`} aria-expanded={archiveOpen} onClick={() => setArchiveOpen((value) => !value)}>
              <span data-rail-label="">{t("rail.archive")}</span>
              <span className="font-semibold tabular-nums">{archived.length}</span>
              <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${archiveOpen ? "rotate-90" : ""}`} aria-hidden />
            </button>
            {archiveOpen ? archived.map((entry) => <ProjectRow key={entry.project} row={entry} kind={kind === "rich" ? "rich" : "line"} props={{ ...props, onToggleCrown: undefined }} model={model} crowned={crowns.has(entry.project)} />) : null}
          </>
        ) : null}
        {!model.active.length && !archived.length ? (
          (props.catalogFailures ?? 0) > 0 ? <CatalogFailureNotice failures={props.catalogFailures ?? 0} size="inline" />
            : props.loaded ? (query.trim() ? <div className="px-3 py-4 text-center text-[12px] text-muted">{t("common.nothingFound")}</div> : null)
              : <BoardRowsSkeleton variant="rail" rows={6} className="flex-none" />
        ) : null}
      </nav>
      <SystemBlock />
    </>
  );
}

/** `?railask=1`: variant 1 with the question line of variant 3, the combination the note recommends. */
const WITH_ASK = () => typeof location !== "undefined" && new URLSearchParams(location.search).get("railask") === "1";

function Variant1(props: ProjectRailProps) {
  const model = useRailModel(props);
  return (
    <aside data-rail-variant="1" className="flex w-[248px] shrink-0 flex-col border-r border-border bg-card">
      <FullRail props={props} model={model} kind={WITH_ASK() ? "ask" : "line"} />
    </aside>
  );
}

function Variant3(props: ProjectRailProps) {
  const model = useRailModel(props);
  return (
    <aside data-rail-variant="3" className="flex w-[264px] shrink-0 flex-col border-r border-border bg-card">
      <FullRail props={props} model={model} kind="rich" />
    </aside>
  );
}

/** Two letters that stand for a project on a tile: the initials of its first two words, or its first two letters. */
function monogram(name: string): string {
  const words = name.split(/[\s\-_./]+/).filter(Boolean);
  const letters = words.length > 1 ? `${[...words[0]!][0]}${[...words[1]!][0]}` : [...(words[0] ?? "?")].slice(0, 2).join("");
  return letters.toUpperCase();
}

function Tile({ row, props }: { row: RowFacts; props: ProjectRailProps }) {
  const { c, lang } = useCopy();
  const active = props.selected === row.project;
  const title = [row.displayName, row.attentionCount ? (row.attentionCount === 1 ? c("needsYouOne") : c("needsYou", { n: row.attentionCount })) : null, row.liveCount ? c("working", { n: row.liveCount }) : null, row.conversations === 1 ? c("conversationsOne") : c("conversations", { n: row.conversations }), shortAge(row.smt, props.now, lang)].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      data-flip-key={row.project}
      data-rail-project={row.project}
      title={title}
      aria-label={title}
      aria-current={active ? "page" : undefined}
      onClick={() => props.onSelect(row.project)}
      className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border text-[11px] font-bold tracking-[0.02em] ${FOCUS} ${active ? "border-strong bg-card text-primary shadow-1" : "border-border bg-canvas text-secondary hover:border-strong hover:text-primary"} ${row.catalogOnly ? "opacity-60" : ""}`}
    >
      {monogram(row.displayName)}
      {row.attentionCount ? (
        <span className="absolute -right-1 -top-1 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-warning px-[3px] text-[9.5px] font-bold leading-none tabular-nums text-card">{row.attentionCount > 9 ? "9+" : row.attentionCount}</span>
      ) : null}
      {row.liveCount ? <span className="absolute -bottom-[3px] -right-[3px] h-2.5 w-2.5 animate-pulse rounded-full border-2 border-card bg-success motion-reduce:animate-none" /> : null}
      {active ? <span aria-hidden className="absolute -left-[10px] top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" /> : null}
    </button>
  );
}

/**
 * The narrow rail. At rest it is 56 px of tiles and gauges. Resting the pointer
 * on it, or any of its three "open" controls, lays the full sidebar beside it,
 * over the board and without moving the board. The rail itself is never
 * covered, so a click that follows the pause lands on the tile or the gauge
 * under the pointer; that click also closes the sidebar, since the choice is
 * made. The dock control keeps the sidebar open in the layout.
 * `?railopen=1` holds it open for a frame.
 */
function Variant2(props: ProjectRailProps) {
  const { c, t } = useCopy();
  const model = useRailModel(props);
  const [docked, toggleDock] = useStored(DOCK_STORAGE_KEY, "docked", "rail");
  const held = typeof location !== "undefined" && new URLSearchParams(location.search).get("railopen") === "1";
  const [peek, setPeek] = useState<null | "hover" | "filter" | "create" | "archive">(held ? "hover" : null);
  const shell = useRef<HTMLElement | null>(null);
  /* The rail's own tiles, gauges and menu: they act in place. */
  const acting = useRef<HTMLDivElement | null>(null);
  const flyout = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const later = (next: typeof peek, delay: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setPeek((current) => {
      /* A form or a panel the operator opened inside the sidebar keeps it open. */
      if (next === null && (held || flyout.current?.querySelector('[aria-expanded="true"]:not([data-rail-footer-toggle]):not([data-rail-archive]), form, [data-rail-filter]:focus'))) return current;
      /* A panel or the menu opened from the rail uses the space beside the rail. */
      if (next !== null && current === null && acting.current?.querySelector('[aria-expanded="true"]:not([data-rail-footer-toggle])')) return current;
      return next;
    }), delay);
  };
  const shut = () => {
    if (timer.current) clearTimeout(timer.current);
    if (!held) setPeek(null);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (!peek || docked) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !held) setPeek(null); };
    const onDown = (event: PointerEvent) => { if (!held && shell.current && !shell.current.contains(event.target as Node)) setPeek(null); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("pointerdown", onDown); };
  }, [peek, docked, held]);

  const dock = (
    <button type="button" data-rail-dock="" aria-pressed={docked} className={SQUARE} title={c(docked ? "undock" : "dock")} aria-label={c(docked ? "undock" : "dock")} onClick={() => { toggleDock(); setPeek(null); }}>
      {docked ? <PanelLeftClose className="h-3.5 w-3.5" aria-hidden /> : <PanelLeftOpen className="h-3.5 w-3.5" aria-hidden />}
    </button>
  );
  if (docked) {
    return (
      <aside data-rail-variant="2" data-rail-state="docked" className="flex w-[248px] shrink-0 flex-col border-r border-border bg-card">
        <FullRail props={props} model={model} kind="line" headerExtra={dock} />
      </aside>
    );
  }
  const railButton = `flex h-8 w-9 items-center justify-center rounded-[9px] text-muted hover:bg-canvas hover:text-primary ${FOCUS}`;
  const overview = props.selected === OVERVIEW;
  return (
    <aside
      ref={shell}
      data-rail-variant="2"
      data-rail-state={peek ? "open" : "rail"}
      className="relative flex w-14 shrink-0 flex-col border-r border-border bg-card"
      onPointerEnter={() => later(peek ?? "hover", 140)}
      onPointerLeave={() => later(null, 260)}
    >
      <style>{"[data-rail-menu-slot] [data-rail-menu-panel]{left:100%;right:auto;top:auto;bottom:0;margin-left:14px}"}</style>
      <div className="flex h-10 shrink-0 items-center justify-center border-b border-border"><DelegatusMark size={20} /></div>
      <div className="flex shrink-0 flex-col items-center gap-0.5 pb-1 pt-1.5">
        <button type="button" data-rail-open="" className={railButton} title={c("open")} aria-label={c("open")} aria-expanded={peek !== null} onClick={() => setPeek("hover")}><PanelLeftOpen className="h-4 w-4" aria-hidden /></button>
        <button type="button" data-rail-open-filter="" className={railButton} title={c("find")} aria-label={c("find")} onClick={() => setPeek("filter")}><Search className="h-4 w-4" aria-hidden /></button>
        {props.onCreateProject ? <button type="button" data-rail-open-create="" className={railButton} title={t("rail.createProject")} aria-label={t("rail.createProject")} onClick={() => setPeek("create")}><FolderPlus className="h-4 w-4" aria-hidden /></button> : null}
      </div>
      <div ref={acting} className="flex min-h-0 flex-1 flex-col" onClickCapture={shut}>
        <nav className="flex flex-1 flex-col items-center gap-1 overflow-y-auto border-t border-border px-1 pb-2 pt-2 [scrollbar-width:none]" aria-label={t("rail.projects")}>
          <button type="button" data-rail-overview="" title={t("rail.overview")} aria-label={t("rail.overview")} aria-current={overview ? "page" : undefined} onClick={() => props.onSelect(OVERVIEW)} className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border ${FOCUS} ${overview ? "border-strong bg-canvas text-primary shadow-1" : "border-transparent text-muted hover:bg-canvas hover:text-primary"}`}>
            <LayoutGrid className="h-4 w-4" aria-hidden />
          </button>
          <span className="my-0.5 h-px w-6 shrink-0 bg-border" />
          <FlipRow className="flex flex-col items-center gap-1">
            {model.crowned.length ? <Crown data-flip-key="__crown-label__" className="h-3 w-3 shrink-0 fill-crown text-crown" aria-label={c("pinned")} data-testid="crown-marker" /> : null}
            {model.crowned.map((row) => <Tile key={row.project} row={row} props={props} />)}
            {model.crowned.length && model.rest.length ? <span data-flip-key="__crown-divider__" className="my-0.5 h-px w-6 shrink-0 bg-border" /> : null}
            {model.rest.map((row) => <Tile key={row.project} row={row} props={props} />)}
          </FlipRow>
          {model.archived.length ? (
            <button type="button" data-rail-archive="" title={`${t("rail.archive")} ${model.archived.length}`} aria-label={`${t("rail.archive")} ${model.archived.length}`} onClick={() => setPeek("archive")} className={`relative mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-muted hover:bg-canvas hover:text-primary ${FOCUS}`}>
              <Archive className="h-4 w-4" aria-hidden />
              <span className="absolute -right-1 -top-1 text-[9.5px] font-bold tabular-nums text-muted">{model.archived.length}</span>
            </button>
          ) : null}
        </nav>
        <SystemBlock gauges />
        <div data-rail-menu-slot="" className="flex shrink-0 items-center justify-center border-t border-border py-1.5"><RailHeaderMenu /></div>
      </div>
      {peek ? (
        <div ref={flyout} data-rail-flyout="" className={`absolute inset-y-0 left-full flex w-[248px] flex-col border-r border-border bg-card shadow-2 ${Z.popover}`}>
          <FullRail key={peek} props={props} model={model} kind="line" headerExtra={dock} start={peek === "hover" ? null : peek} beside />
        </div>
      ) : null}
    </aside>
  );
}

const DRAWINGS = { 1: Variant1, 2: Variant2, 3: Variant3 } as const;

export function RailPrototypeFrame({ variant, children }: { variant: RailVariant; children: ReactNode }) {
  const { locale } = useLocale();
  const lang: Lang = locale === "uk" ? "uk" : "en";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div data-rail-variant-strip={variant} className="flex shrink-0 items-center gap-2.5 bg-brand px-3 text-on-brand" style={{ height: RAIL_STRIP_HEIGHT }}>
        <span className="text-[17px] font-bold tabular-nums leading-none">{variant}</span>
        <span className="text-[12.5px] font-semibold">{TITLES[lang][variant]}{variant === 1 && WITH_ASK() ? `, ${COPY[lang].withAsk}` : ""}</span>
      </div>
      <div className="min-h-0 flex-1">
        <RailPrototypeContext.Provider value={variant === 0 ? null : DRAWINGS[variant]}>{children}</RailPrototypeContext.Provider>
      </div>
    </div>
  );
}
