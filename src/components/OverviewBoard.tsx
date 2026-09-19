"use client";

import { useMemo } from "react";

import { useIsMobile } from "@/hooks/useIsMobile";
import { projectDisplayName } from "@/lib/displayNames";
import { useLocale } from "@/lib/i18n";
import type { Flow } from "@/lib/flows/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry, ProjectCatalogEntry } from "@/lib/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { Workflow } from "@/lib/workflows/types";

import { CatalogFailureNotice } from "./CatalogFailureNotice";
import { FolderPlus, Search } from "./icons";
import { KeepAwakeMenuRow } from "./KeepAwakeControl";
import { MobileMenuSheet, type MobileMenuEntry } from "./mobile/MobileMenuSheet";
import { MobileAccountsScreen, MobileBarTitle, MobileShell, type MobileShellHost } from "./mobile/MobileShell";
import { topScreen, useMobileNav, useMobileNavStore, type MobileSheetName } from "./mobile/mobileNav";
import { OverviewKanban } from "./OverviewKanban";
import { SoundToggle } from "./SoundToggle";
import { buildProjectSummaries } from "./projectModel";
import { CREATE_PROJECT_FORM_EVENT } from "./ProjectRail";

const noop = () => {};

interface Props {
  files: FileEntry[];
  projectCatalog: ProjectCatalogEntry[];
  projectDisplayNames?: Readonly<Record<string, string>>;
  pipelines: Pipeline[];
  /** Active workflows: their stamped projects get a card even without files. */
  workflows: Workflow[];
  /** Shelved projects: their cards stay off the board until unarchived or live again. */
  archivedProjects: ReadonlySet<string>;
  /** Every stored task the Viewer polls, for every project (#1820). The board
      below takes them as one payload; nothing here fetches per project. */
  tasks?: readonly BoardTask[];
  /** The review flows the Viewer already resolved. */
  flows?: Flow[];
  /** Whether the scan has settled; the board holds a skeleton until it has. */
  loaded?: boolean;
  /** Attention clock owned by Viewer — keeps summary badges in step with the queue. */
  now: number;
  /** Consecutive `/api/files` failures (issue #696). Above zero the board is
      showing an unconfirmed catalog, so the idle empty-state copy is a lie. */
  catalogFailures?: number;
  onSelectProject: (project: string) => void;
  /** Opens the global message search (issue #1054). The affordance sits in the
      board chrome on every screen, so the operator never has to be somewhere
      particular to search what they have sent. */
  onOpenSearch?: () => void;
  /** The phone shell's host (mobile v2 lane 1): the queue count for the bar's
      badge, the arrival for the banner slot and the sheets the Viewer owns.
      Absent on the desktop. */
  mobileShell?: MobileShellHost | null;
}

const NO_TASKS: readonly BoardTask[] = [];
const NO_FLOWS: Flow[] = [];

/**
 * The Overview (#1820): the kanban board a project renders, over every
 * project at once, showing only the cards a worker is working on right now.
 *
 * This page owns the chrome — the title bar with its live count, the failed
 * catalog notice and the first run — and hands `OverviewKanban` the projects
 * it decided to show. It draws no cards of its own: the project-summary grid
 * that used to live here was a second, smaller board beside the real one, and
 * the rail already lists the projects it listed.
 */
export function OverviewBoard({ files, projectCatalog, projectDisplayNames = {}, pipelines, workflows, archivedProjects, tasks = NO_TASKS, flows = NO_FLOWS, loaded = true, now, catalogFailures = 0, onSelectProject, onOpenSearch, mobileShell = null }: Props) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const mobileNav = useMobileNavStore();
  const mobileNavState = useMobileNav();
  const degraded = catalogFailures > 0;
  const allSummaries = useMemo(
    () => buildProjectSummaries(files, now, workflows, projectCatalog, pipelines, projectDisplayNames),
    [files, now, workflows, projectCatalog, pipelines, projectDisplayNames],
  );
  const summaries = useMemo(
    () => allSummaries.filter((summary) => !archivedProjects.has(summary.project)),
    [allSummaries, archivedProjects],
  );
  const archivedCount = allSummaries.length - summaries.length;
  const totalLive = useMemo(() => summaries.reduce((sum, s) => sum + s.liveCount, 0), [summaries]);
  const liveProjects = summaries.filter((s) => s.liveCount > 0).length;
  /* The board's scope. Stable by membership, so a poll that returns the same
     projects never re-groups the whole file list. */
  const projects = useMemo(() => summaries.map((summary) => summary.project), [summaries]);
  /* The name the rail and the dashboard header show for the same project: the
     Viewer's own map first, the summary's derivation (a transcript's stamped
     `projectName`, the catalog, the key) after it. */
  const names = useMemo(
    () => Object.fromEntries(summaries.map((summary) => [
      summary.project,
      projectDisplayNames[summary.project] ? projectDisplayName(summary.project, projectDisplayNames[summary.project]) : summary.displayName,
    ] as const)),
    [summaries, projectDisplayNames],
  );

  const grid = (
    <div data-testid="overview-body" className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Issue #696: a failed fetch and a genuinely empty installation must
          not render the same screen. While the catalog is unreachable the
          board states the failure and offers the recovery action; the
          first-run panel is held back until a fetch actually succeeds. */}
      {degraded ? (
        <CatalogFailureNotice failures={catalogFailures} className={`shrink-0 px-3 ${projects.length ? "pt-2" : "mt-[12vh]"}`} />
      ) : null}
      {projects.length ? (
        <OverviewKanban
          projects={projects}
          displayNames={names}
          files={files}
          tasks={tasks}
          flows={flows}
          pipelines={pipelines}
          loaded={loaded}
          catalogFailures={catalogFailures}
          onSelectProject={onSelectProject}
          onOpenConversations={onOpenSearch ?? noop}
        />
      ) : degraded || allSummaries.length ? null : (
        /* First run (issue #1162). A board with nothing on it used to state
           the fact and stop there; it now says where sessions come from and
           offers the one next step. The button steers the rail's existing
           create form rather than opening a second creation path.
           `allSummaries`, not the archived-filtered list: an installation
           whose only projects are shelved has had projects, and the header
           says so — «No projects yet» would contradict its own «1 archived»
           two rows above. */
        <div
          data-testid="overview-first-run"
          className="mt-[14vh] flex flex-col items-center gap-2.5 px-4 text-center"
        >
          <span className="text-[15px] font-bold text-primary">{t("overview.firstRunTitle")}</span>
          <span className="max-w-[440px] text-[12px] text-secondary">{t("overview.firstRunBody")}</span>
          <button
            type="button"
            data-testid="overview-create-project"
            className="inline-flex min-h-11 items-center gap-1.5 rounded-[10px] border border-accent/45 bg-card px-4 text-[13px] font-bold text-accent shadow-1 hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onClick={() => {
              /* Desktop: the rail is mounted beside the board, so it hears
                 this and opens the create form it already owns. Phone: the
                 project switcher sheet opens with its create form already
                 open on a first run (mobile v2 lane 1). One tap either way. */
              if (isMobile) mobileNav.openSheet("projects");
              else window.dispatchEvent(new Event(CREATE_PROJECT_FORM_EVENT));
            }}
          >
            <FolderPlus className="h-4 w-4" aria-hidden /> {t("overview.firstRunCreate")}
          </button>
          <span className="max-w-[440px] text-[11.5px] text-muted">{t("overview.firstRunElsewhere")}</span>
        </div>
      )}
    </div>
  );

  if (isMobile) {
    /* The phone (mobile v2 lane 1): the shell's bar with «Overview» as the
       title cell (it opens the project switcher), the badge, search and ⋯; the
       menu holds the device-local settings. */
    const renderSheet = (name: MobileSheetName, close: () => void) => {
      if (name === "menu") {
        const entries: MobileMenuEntry[] = [
          {
            kind: "custom",
            key: "sound",
            node: (
              <div className="flex min-h-11 items-center gap-2 px-4">
                <span className="min-w-0 flex-1 text-body font-semibold text-primary">{t("mobile2.menu.sound")}</span>
                <SoundToggle />
              </div>
            ),
          },
          { kind: "custom", key: "awake", node: <div className="px-2.5"><KeepAwakeMenuRow /></div> },
        ];
        return <MobileMenuSheet title={t("rail.overview")} entries={entries} onClose={close} />;
      }
      return mobileShell?.renderSheet(name, close) ?? null;
    };
    if (topScreen(mobileNavState).kind === "accounts") return <MobileAccountsScreen host={mobileShell} renderSheet={renderSheet} />;
    return (
      <MobileShell
        screen="board"
        title={<MobileBarTitle>{t("rail.overview")}</MobileBarTitle>}
        titleLabel={t("mobile2.bar.switchProject")}
        titleOpens={mobileShell ? "projects" : undefined}
        host={mobileShell}
        onOpenSearch={onOpenSearch}
        searchTestId="overview-search"
        renderSheet={renderSheet}
      >
        {grid}
      </MobileShell>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Issue #701 kept the 320px reflow out; the clip is x-only so it cannot
          take the y axis with it. The bar's own mobile children are 44px tall
          against this 40px row (the Orchestrator pill and the attention badge),
          and a plain `overflow-hidden` sliced 2px off both — on the exact
          surface #701 was meant to make usable. `overflow-x-clip` leaves the y
          axis visible, so the pills overhang as they did before. */}
      <div className="flex h-10 shrink-0 items-center gap-2.5 overflow-x-clip border-b border-border bg-card px-4">
        <h1 className="min-w-0 shrink truncate text-[13.5px] font-bold">{t("rail.overview")}</h1>
        {/* Issue #701: the subtitle is dropped below 360px instead of wrapping
            into this fixed 40px bar, where it overprinted the title and the
            header actions and pushed the board past the viewport. Above
            360px it truncates rather than growing the row. */}
        <span
          className={`hidden min-w-0 shrink truncate text-[11.5px] min-[360px]:block ${degraded ? "font-semibold text-danger" : "text-muted"}`}
          data-degraded={degraded ? "true" : undefined}
        >
          {/* Issue #696: a failed catalog fetch never borrows the affirmative
              "nothing is running right now" copy. */}
          {degraded
            ? t("catalog.unreachable")
            : totalLive
              ? t("overview.branchesLiveIn", { count: totalLive, projects: t("overview.projects", { count: liveProjects }) })
              : t("common.nothingRunning")}
          {!degraded && archivedCount ? ` ${t("overview.archived", { count: archivedCount })}` : ""}
          {/* The board below is filtered, permanently. Saying so here is what
              keeps «3 of 41» in a column head from reading as a bug (#1820). */}
          {!degraded && projects.length ? ` · ${t("overview.workingOnly")}` : ""}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {onOpenSearch ? (
            <button
              type="button"
              data-testid="overview-search"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border border-border bg-canvas text-muted hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              aria-label={t("search.open")}
              title={t("search.open")}
              onClick={onOpenSearch}
            >
              <Search className="h-4 w-4" aria-hidden />
            </button>
          ) : null}
        </span>
      </div>
      {grid}
    </div>
  );
}
