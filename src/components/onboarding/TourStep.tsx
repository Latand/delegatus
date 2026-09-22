"use client";

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";

import { requestOrchestratorDraft } from "@/components/orchestrator/draftPrefill";
import { useOrchestratorSeat } from "@/components/orchestrator/useOrchestratorSeat";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale, type TFunction } from "@/lib/i18n";

import { BoardSchematic, NeedsYouSchematic, PipelineSchematic, SeatSchematic, StartSchematic } from "./TourSchematics";

/**
 * Step 5, Tour (#1876 slice 3, design §2.4): one screen that says what Agent
 * Log Viewer is, in the product's own words, and ends on the first action.
 * Four cards and a "Start here" band on the desktop; a horizontal pager of
 * five pages on the phone. The band's Create opens the chosen project's
 * orchestrator draft on Claude Opus at the chosen effort and closes the guide;
 * it spawns nothing, since the draft's own Confirm is the paid action.
 */

export type TourProject = { project: string; name: string };
export type TourHandle = { /** Advance the phone pager; false once on its last page. */ advance(): boolean };

const REPO = "https://github.com/Latand/live-log-viewer-next";
export const TOUR_GUIDE_URL = `${REPO}#how-agents-are-driven`;
export const TOUR_SEAT_GUIDE_URL = `${REPO}/blob/main/docs/orchestrator.md`;

type Effort = "high" | "medium";

const CARDS: ReadonlyArray<{ id: string; title: Parameters<TFunction>[0]; body: Parameters<TFunction>[0]; Picture: () => React.JSX.Element }> = [
  { id: "1", title: "onboarding.tour.card1.title", body: "onboarding.tour.card1.body", Picture: BoardSchematic },
  { id: "2", title: "onboarding.tour.card2.title", body: "onboarding.tour.card2.body", Picture: SeatSchematic },
  { id: "3", title: "onboarding.tour.card3.title", body: "onboarding.tour.card3.body", Picture: PipelineSchematic },
  { id: "4", title: "onboarding.tour.card4.title", body: "onboarding.tour.card4.body", Picture: NeedsYouSchematic },
];

function seatHeld(status: ReturnType<typeof useOrchestratorSeat>["status"]): boolean {
  return Boolean(status?.seat?.conversationId && status.exists);
}

function StartBand({ projects, initialProject, claudeConnected, onCreated, phone }: {
  projects: readonly TourProject[];
  initialProject: string | null;
  claudeConnected: boolean;
  onCreated: () => void;
  phone: boolean;
}) {
  const { t } = useLocale();
  const [project, setProject] = useState(() => (initialProject && projects.some((entry) => entry.project === initialProject) ? initialProject : projects[0]?.project) ?? "");
  const [effort, setEffort] = useState<Effort>("high");
  const { status } = useOrchestratorSeat(project || null);
  const held = project ? seatHeld(status) : false;
  const name = projects.find((entry) => entry.project === project)?.name ?? project;

  const create = () => {
    if (!project || !claudeConnected) return;
    requestOrchestratorDraft({ project, launch: { engine: "claude", model: "opus", effort } });
    onCreated();
  };
  const openSeat = () => {
    requestOrchestratorDraft({ project, launch: null });
    onCreated();
  };

  const control = "h-8 rounded-[8px] text-ui font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11";
  return (
    <section data-tour-start="" aria-labelledby="tour-start-title" className={`flex gap-4 rounded-[12px] border border-accent/35 bg-accent-soft/40 p-3 ${phone ? "flex-col" : ""}`}>
      <div className={`shrink-0 overflow-hidden rounded-[8px] bg-sunken ${phone ? "aspect-[16/10] w-full" : "h-20 w-32"}`}>
        <StartSchematic />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <h3 id="tour-start-title" className="text-ui font-semibold text-primary">{t("onboarding.tour.card5.title")}</h3>
        <p className="text-ui leading-[1.45] text-secondary">{t("onboarding.tour.card5.body")}</p>
        {projects.length === 0 ? (
          <p data-tour-no-projects="" className="text-ui leading-[1.45] text-warning">{t("onboarding.tour.noProjects")}</p>
        ) : (
          <>
            <div className={`flex gap-2 ${phone ? "flex-col" : "flex-wrap items-end"}`}>
              <label className={`flex flex-col gap-1 ${phone ? "" : "w-[240px]"}`}>
                <span className="text-label font-semibold text-muted">{t("onboarding.tour.project")}</span>
                <select
                  data-tour-project=""
                  value={project}
                  onChange={(event) => setProject(event.currentTarget.value)}
                  className={`${control} min-w-0 border border-border bg-card px-2 text-primary`}
                >
                  {projects.map((entry) => <option key={entry.project} value={entry.project}>{entry.name}</option>)}
                </select>
              </label>
              {held ? null : (
                <div className="flex flex-col gap-1">
                  <span id="tour-effort-label" className="text-label font-semibold text-muted">{t("onboarding.tour.effort")}</span>
                  <div role="radiogroup" aria-labelledby="tour-effort-label" className="flex rounded-[8px] border border-border bg-card p-0.5">
                    {(["high", "medium"] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={effort === value}
                        data-tour-effort={value}
                        onClick={() => setEffort(value)}
                        className={`h-7 flex-1 whitespace-nowrap rounded-[6px] px-2.5 text-ui font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11 ${effort === value ? "bg-accent-soft text-primary" : "text-secondary hover:text-primary"}`}
                      >
                        {t(value === "high" ? "onboarding.tour.effortHigh" : "onboarding.tour.effortMedium")}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {held ? (
                <button type="button" data-tour-open-seat="" onClick={openSeat} className={`${control} border border-border bg-card px-3.5 text-primary hover:bg-sunken`}>
                  {t("onboarding.tour.openIt")}
                </button>
              ) : (
                <button
                  type="button"
                  data-tour-create=""
                  disabled={!claudeConnected}
                  onClick={create}
                  className={`${control} whitespace-nowrap bg-accent px-3.5 text-white hover:opacity-90 disabled:opacity-50`}
                >
                  {t("onboarding.tour.create")}
                </button>
              )}
            </div>
            {held ? (
              <p className="text-ui text-secondary">{t("onboarding.tour.alreadyHas", { project: name })}</p>
            ) : !claudeConnected ? (
              <p className="text-ui text-warning">{t("onboarding.tour.claudeMissing")}</p>
            ) : (
              <p className="text-caption leading-[1.45] text-muted">{t("onboarding.tour.effortNote")}</p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

export function TourStep({ projects, initialProject, claudeConnected, checkMinutes, onCreated, handle }: {
  projects: readonly TourProject[];
  /** The project the guide was opened over, preselected when listed. */
  initialProject: string | null;
  claudeConnected: boolean;
  /** The seat tick's check interval, read from the server. */
  checkMinutes: number;
  /** Create or Open it handed the operator to the draft: the guide closes. */
  onCreated: () => void;
  handle?: Ref<TourHandle>;
}) {
  const { t } = useLocale();
  const phone = useIsMobile();
  const pagerRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  const [pageHeight, setPageHeight] = useState<number | null>(null);
  const total = CARDS.length + 1;

  /* The pager is as tall as the page on screen, so a short card is not
     followed by the empty height of the tallest one. */
  useEffect(() => {
    const pager = pagerRef.current;
    const current = pager?.children[page] as HTMLElement | undefined;
    if (!phone || !current) return;
    const measure = () => setPageHeight(current.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(current);
    return () => observer.disconnect();
  }, [phone, page]);

  useImperativeHandle(handle, () => ({
    advance() {
      if (!phone || page >= total - 1) return false;
      const pager = pagerRef.current;
      pager?.scrollTo?.({ left: (page + 1) * pager.clientWidth, behavior: "smooth" });
      setPage(page + 1);
      return true;
    },
  }), [phone, page, total]);

  /* Swipes move the page the dots and Continue read. */
  useEffect(() => {
    const pager = pagerRef.current;
    if (!phone || !pager) return;
    const onScroll = () => {
      if (!pager.clientWidth) return;
      setPage(Math.max(0, Math.min(total - 1, Math.round(pager.scrollLeft / pager.clientWidth))));
    };
    pager.addEventListener("scroll", onScroll, { passive: true });
    return () => pager.removeEventListener("scroll", onScroll);
  }, [phone, total]);

  const body = (key: Parameters<TFunction>[0]) => t(key, { check: checkMinutes, needsYou: t("attention.needsYou") });
  const cards = CARDS.map(({ id, title, body: bodyKey, Picture }) => (
    <article key={id} data-tour-card={id} className={`flex min-w-0 flex-col gap-2 ${phone ? "w-full shrink-0 snap-start px-0.5" : ""}`}>
      <div className={`overflow-hidden rounded-[8px] bg-sunken ${id === "2" ? "ring-1 ring-accent/35" : ""} ${phone ? "aspect-[16/10] w-full" : "aspect-[16/10]"}`}>
        <Picture />
      </div>
      <h3 className="text-ui font-semibold text-primary">{t(title)}</h3>
      <p className={`leading-[1.45] text-secondary ${phone ? "text-body" : "text-ui"}`}>{body(bodyKey)}</p>
    </article>
  ));
  const band = <StartBand projects={projects} initialProject={initialProject} claudeConnected={claudeConnected} onCreated={onCreated} phone={phone} />;
  const links = (
    <p data-tour-links="" className="flex flex-wrap gap-x-4 gap-y-1 text-ui text-secondary">
      <a href={TOUR_GUIDE_URL} target="_blank" rel="noreferrer" className="rounded-[6px] font-semibold hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center">{t("onboarding.tour.fullGuide")} →</a>
      <a href={TOUR_SEAT_GUIDE_URL} target="_blank" rel="noreferrer" className="rounded-[6px] font-semibold hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center">{t("onboarding.tour.seatGuide")} →</a>
    </p>
  );

  if (phone) {
    return (
      <div data-onboarding-tour="phone" className="flex flex-col gap-3">
        <div
          ref={pagerRef}
          aria-label={t("onboarding.tour.pagerAria")}
          style={pageHeight ? { height: pageHeight } : undefined}
          className="-mx-4 flex snap-x snap-mandatory items-start gap-4 overflow-x-auto overflow-y-hidden scroll-px-4 px-4 transition-[height] duration-150 motion-reduce:transition-none [scrollbar-width:none]"
        >
          {cards}
          <div className="w-full shrink-0 snap-start">{band}</div>
        </div>
        <div className="flex items-center justify-center gap-1.5" aria-hidden>
          {Array.from({ length: total }, (_, index) => (
            <span key={index} data-tour-dot={index === page ? "current" : ""} className={`h-1.5 rounded-full ${index === page ? "w-4 bg-accent" : "w-1.5 bg-border"}`} />
          ))}
        </div>
        <span className="sr-only" aria-live="polite">{t("onboarding.tour.pageAria", { n: page + 1, total })}</span>
        {links}
      </div>
    );
  }

  return (
    <div data-onboarding-tour="desktop" className="flex flex-col gap-4">
      <div className="grid grid-cols-4 gap-2">{cards}</div>
      {band}
      {links}
    </div>
  );
}
