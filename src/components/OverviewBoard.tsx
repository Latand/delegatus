"use client";

import { Bot, EyeOff } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useIsMobile } from "@/hooks/useIsMobile";
import { reachLineText, useServerReach } from "@/hooks/serverReach";
import { projectDisplayName } from "@/lib/displayNames";
import { useLocale } from "@/lib/i18n";
import type { Flow } from "@/lib/flows/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry, ProjectCatalogEntry } from "@/lib/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { Workflow } from "@/lib/workflows/types";

import { CatalogFailureNotice } from "./CatalogFailureNotice";
import { KanbanSkeleton, PhoneKanbanSkeleton } from "./skeletons";
import { FolderPlus, Search } from "./icons";
import { KeepAwakeMenuRow } from "./KeepAwakeControl";
import { MobileMenuSheet, type MobileMenuEntry } from "./mobile/MobileMenuSheet";
import { activityMobileMenuEntry } from "./activity/menuEntry";
import { onboardingMobileMenuEntries } from "./onboarding/menuEntries";
import { selfUpdateMobileMenuEntry } from "./selfUpdate/menuEntry";
import { openOnboarding } from "./onboarding/useOnboarding";
import { StartSchematic } from "./onboarding/TourSchematics";
import { useSeatConversations } from "./orchestrator/useOrchestratorSeat";
import { MobileAccountsScreen, MobileBarTitle, MobileShell, type MobileShellHost } from "./mobile/MobileShell";
import { topScreen, useMobileNav, useMobileNavStore, type MobileSheetName } from "./mobile/mobileNav";
import { OverviewKanban, type OverviewPhoneDoors } from "./OverviewKanban";
import { SoundToggle } from "./SoundToggle";
import { buildProjectSummaries } from "./projectModel";

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
  /** The rows are a restored earlier answer, not yet confirmed (#2071): the
      board draws them, and the first run still waits for `loaded`. */
  cached?: boolean;
  /** Whether a screen stacked over the phone's Overview that no project draws
      is truly unplaceable: the answer that names every task, lane and
      conversation is in, and no link is still resolving. Until then a stack
      restored by a reload (#2105) is only waiting for its data. */
  placesKnown?: boolean;
  /** Attention clock owned by Viewer — keeps summary badges in step with the queue. */
  now: number;
  /** Each project's needs-you count, from the one queue the header and the
      panel read, so the badge here carries the panel section's number. */
  needsYouCounts?: ReadonlyMap<string, number>;
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
  /** The Viewer's half of a conversation a card opens on the phone (#2098):
      it pushes the conversation's screen over the Overview and puts the
      conversation on its own project's board, which draws that screen. */
  onOpenConversation?: (file: FileEntry) => void;
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
export function OverviewBoard({ files, projectCatalog, projectDisplayNames = {}, pipelines, workflows, archivedProjects, tasks = NO_TASKS, flows = NO_FLOWS, loaded = true, cached = false, placesKnown = loaded, now, needsYouCounts, catalogFailures = 0, onSelectProject, onOpenSearch, mobileShell = null, onOpenConversation }: Props) {
  const { t, locale } = useLocale();
  const isMobile = useIsMobile();
  const mobileNav = useMobileNavStore();
  const mobileNavState = useMobileNav();
  /* A reconnect in progress with a board on screen is said quietly (#2071
     D7); the failure notice and the red line are for a long outage, or for
     an empty screen that has nothing else to say. */
  const reach = useServerReach();
  const reconnecting = reach.kind === "reconnecting";
  const degraded = catalogFailures > 0;
  const allSummaries = useMemo(
    () => buildProjectSummaries(files, now, workflows, projectCatalog, pipelines, projectDisplayNames, needsYouCounts),
    [files, now, workflows, projectCatalog, pipelines, projectDisplayNames, needsYouCounts],
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

  /* The phone's Overview is the phone kanban (#2098), and a card opens what
     a project's card opens: its task, its pipeline or its conversation, each
     a screen pushed over the Overview, so ‹ comes back to this column. The
     board tells the ⋯ menu how many tasks it is not drawing. */
  const [hiddenCount, setHiddenCount] = useState(0);
  /* The phone kanban is drawn once there are projects and an answer, the
     condition `OverviewKanban` holds its skeleton on; the Hidden tasks sheet
     is the board's, so its ⋯ row waits for it. */
  const boardDrawn = projects.length > 0 && (loaded || cached);
  /* A screen over the Overview is drawn by its own project's dashboard. One
     the Viewer cannot place (a task deleted while its screen sat in the
     history, reached again by Forward) leaves the Overview drawn under a
     stack that names it, and every later door would land above it and never
     show: the stack goes home instead. Nothing opened on purpose lands here
     before its data does: a task and a lane come from the payload the door
     was drawn from, and a conversation opened over the Overview carries its
     project from the open (`openOverOverview`), whether or not the poll has
     carried its file yet. A reload is the one arrival ahead of its data: the
     stack comes back from the entry before any answer names its projects, so
     it is judged only once the answer is in (#2105). */
  const stranded = isMobile && placesKnown && !["board", "accounts"].includes(topScreen(mobileNavState).kind);
  useEffect(() => {
    if (stranded) mobileNav.home();
  }, [stranded, mobileNav]);
  const phoneDoors = useMemo<OverviewPhoneDoors | null>(
    () => (isMobile ? {
      onOpenTask: (task) => mobileNav.push({ kind: "task", id: task.id }),
      onOpenPipeline: (pipeline) => mobileNav.push({ kind: "pipeline", id: pipeline.id }),
      onOpenConversation: (file) => (onOpenConversation ? onOpenConversation(file) : mobileNav.push({ kind: "chat", id: file.path })),
      onHiddenCount: setHiddenCount,
    } : null),
    [isMobile, mobileNav, onOpenConversation],
  );

  /* Before any orchestrator exists on this install, the Overview leads with
     one (#2166 §3.5). "Exists" is the seat record's whole history, every
     project's active, pending and revoked seats: the band goes away for good
     with the first seat, as the phone's invitation does, and a read that has
     not answered (or failed) shows no band. */
  const seatRefs = useSeatConversations(projects.length > 0);
  const retired = seatRefs?.previous;
  const noSeatEver = seatRefs != null && retired != null
    && seatRefs.conversationIds.length === 0
    && seatRefs.paths.length === 0
    && retired.conversationIds.length === 0;

  const grid = (
    <div data-testid="overview-body" className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Issue #696: a failed fetch and a genuinely empty installation must
          not render the same screen. While the catalog is unreachable the
          board states the failure and offers the recovery action; the
          first-run panel is held back until a fetch actually succeeds. */}
      {degraded && !(reconnecting && projects.length) ? (
        <CatalogFailureNotice failures={catalogFailures} className={`shrink-0 px-3 ${projects.length ? "pt-2" : "mt-[12vh]"}`} />
      ) : null}
      {/* The phone's band sits above the tabs; the desktop's rides the board's
          own slot above its columns, where a project draws its seat. */}
      {isMobile && projects.length > 0 && noSeatEver ? <OrchestratorBand phone /> : null}
      {projects.length ? (
        <OverviewKanban
          projects={projects}
          displayNames={names}
          files={files}
          tasks={tasks}
          flows={flows}
          pipelines={pipelines}
          loaded={loaded || cached}
          catalogFailures={catalogFailures}
          onSelectProject={onSelectProject}
          onOpenConversations={onOpenSearch ?? noop}
          phone={phoneDoors}
          lead={!isMobile && noSeatEver ? <OrchestratorBand phone={false} /> : null}
        />
      ) : degraded || allSummaries.length ? null : !loaded ? (
        /* Not answered yet (#2071): the shape of the board, never the first
           run, which is a claim that nothing exists. */
        isMobile ? <PhoneKanbanSkeleton seat={false} /> : <KanbanSkeleton overview />
      ) : (
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
            /* The setup guide on its Project step (#2166 §3.5), whose form is
               the rail's own: the path goes on to the project's orchestrator. */
            onClick={() => openOnboarding("guide", "project")}
          >
            <FolderPlus className="h-4 w-4" aria-hidden /> {t("overview.firstRunCreate")}
          </button>
          <span className="max-w-[440px] text-[11.5px] text-muted">{t("overview.firstRunElsewhere")}</span>
          {/* #1876: the setup guide, for someone who closed it on the way in. */}
          <button
            type="button"
            data-testid="overview-setup-guide"
            className="inline-flex min-h-11 items-center text-[12px] font-semibold text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onClick={() => openOnboarding("guide")}
          >
            {t("onboarding.overviewEntry")}
          </button>
        </div>
      )}
    </div>
  );

  if (isMobile) {
    /* The phone (mobile v2 lane 1): the shell's bar with «Overview» as the
       title cell (it opens the project switcher), the badge, search and ⋯; the
       menu holds the hidden tasks (#2098, as a project's does), the
       device-local settings and Activity. */
    const renderSheet = (name: MobileSheetName, close: () => void) => {
      if (name === "menu") {
        const entries: MobileMenuEntry[] = [
          ...(boardDrawn ? [
            {
              kind: "row" as const,
              key: "hidden",
              icon: <EyeOff className="h-[18px] w-[18px]" aria-hidden />,
              label: t("kanban.hiddenTitle"),
              trailing: hiddenCount ? String(hiddenCount) : undefined,
              opens: "hidden" as const,
              onSelect: () => mobileNav.openSheet("hidden"),
            },
            { kind: "divider" as const, key: "d-board" },
          ] : []),
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
          { kind: "divider", key: "d-setup" },
          activityMobileMenuEntry(t, mobileNav),
          ...onboardingMobileMenuEntries(t, close),
          selfUpdateMobileMenuEntry(t, close),
        ];
        return <MobileMenuSheet title={t("rail.overview")} entries={entries} onClose={close} />;
      }
      return mobileShell?.renderSheet(name, close) ?? null;
    };
    if (topScreen(mobileNavState).kind === "accounts") return <MobileAccountsScreen host={mobileShell} renderSheet={renderSheet} />;
    return (
      <MobileShell
        screen="board"
        /* The board under the title is narrowed to live work, for good
           (#1820): the bar says so once, where a project names its state. */
        title={<MobileBarTitle meta={cached && !loaded ? t("dash.updating") : projects.length ? t("mobile2.overview.workingNow") : undefined}>{t("rail.overview")}</MobileBarTitle>}
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
          className={`hidden min-w-0 shrink truncate text-[11.5px] min-[360px]:block ${degraded && !reconnecting ? "font-semibold text-danger" : "text-muted"}`}
          data-degraded={degraded ? "true" : undefined}
          data-reach={reach.kind}
        >
          {/* Issue #696: a failed catalog fetch never borrows the affirmative
              "nothing is running right now" copy. */}
          {reconnecting
            ? reachLineText(t, locale, reach)
            : degraded
            ? t("catalog.unreachable")
            : !loaded && !cached
              ? t("common.loadingCap")
              : !loaded
                ? t("dash.updating")
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

/**
 * The Overview's first-run band (#2166 §3.5), built from the setup guide's
 * "Start here" band: its schematic, one heading, the one sentence, and the one
 * filled button, which opens the guide on its orchestrator step. It has no
 * dismiss; it leaves when the first seat exists.
 *
 * One inset for the whole band (#2185): 12 px on every side, the schematic, the
 * text and the button 12 px apart. On the desktop it stands on the board's own
 * edges, the columns' left and right and the board's stack gap above it, and
 * `kb-lead` keeps the board's button reset off its button, as `.seat` does; on
 * the phone it sits above the tabs, the button under the text at full width
 * and 44 px tall.
 */
function OrchestratorBand({ phone }: { phone: boolean }) {
  const { t } = useLocale();
  return (
    <section
      data-overview-orchestrator-band=""
      aria-labelledby="overview-orchestrator-band-title"
      className={`flex shrink-0 gap-3 rounded-[12px] border border-accent/35 bg-accent-soft/40 p-3 ${phone ? "mx-3 mt-2 flex-col" : "kb-lead mx-[var(--kb-edge)] mt-[var(--kb-stack)] items-center"}`}
    >
      {phone ? null : (
        <div className="h-[60px] w-24 shrink-0 overflow-hidden rounded-[8px] bg-sunken">
          <StartSchematic />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h2 id="overview-orchestrator-band-title" className="text-ui font-semibold text-primary">{t("overview.bandTitle")}</h2>
        <p className="text-ui leading-[1.45] text-secondary">{t("orchPanel.intro")}</p>
      </div>
      <button
        type="button"
        data-overview-orchestrator-create=""
        /* The guide at the first of Engines, Project and Orchestrator that
           is not done (#2166 §3.5): it ends on this orchestrator. */
        onClick={() => openOnboarding("guide")}
        className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[8px] bg-brand px-4 text-ui font-semibold text-on-brand hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${phone ? "h-11" : "h-9"}`}
      >
        <Bot className="h-4 w-4" aria-hidden /> {t("overview.bandCreate")}
      </button>
    </section>
  );
}
