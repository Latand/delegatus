"use client";

import { Archive, Check, ChevronRight, Crown, Folder, FolderPlus, Hand, Layers, Loader2, MoreHorizontal, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";

import { Badge } from "@/components/ui/Badge";
import type { CreateProjectOutcome, CreateProjectRequestOptions } from "@/hooks/useProjectCuration";
import { useLocale } from "@/lib/i18n";
import type { FileEntry, ProjectCatalogEntry } from "@/lib/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { Workflow } from "@/lib/workflows/types";

import { requestFilesRefresh } from "@/lib/filesEvents";

import { ProjectActionsSheetBody } from "../projectActions/ProjectActionsSheet";
import { projectRights, type ProjectRowActions } from "../projectActions/rights";
import { buildProjectSummaries, OVERVIEW, partitionCrownedSummaries, projectKey, type ProjectSummary } from "../projectModel";
import { MobileWorkspaceSwitch, WorkspaceDot, workspaceErrorText, type WorkspaceCounts, type WorkspaceRailState } from "../team/WorkspaceSwitch";
import { groupAll, workspaceScope } from "../team/workspaceFilter";
import { workingAgentCounts } from "../workingAgents";
import { ResourcesFooter } from "../ResourcesFooter";
import { BoardRowsSkeleton } from "../skeletons";
import { fmtAge } from "../utils";
import { MobileSheet, MobileSheetDivider, MobileSheetRow, MobileSheetSection } from "./MobileSheet";

/*
 * The project switcher (docs/design/mobile-v2/README.md §3.1, §4.1): the
 * board's title cell opens it over the board. Overview, the crowned projects,
 * the rest, an Archive fold and Create project — dense 44 px rows, the current
 * one checked, each row one tap that replaces the board. The hamburger and the
 * drawer that held the desktop rail are gone (§6).
 *
 * A project's menu (docs/design/project-rail-context-menu/README.md, variant
 * 2): a long press on any row, or the ⋯ on the open project's row, shows its
 * actions in the list's place. The first time the list opens, one line says
 * so, and never again in this browser.
 */

/** Where this browser remembers that the long-press hint was shown. */
export const PROJECT_MENU_HINT_STORAGE_KEY = "llv:project-menu-hint:v1";

type CreateProject = (name: string, root: string, options?: CreateProjectRequestOptions) => Promise<CreateProjectOutcome>;

export interface MobileProjectSheetProps {
  files: FileEntry[];
  projectCatalog: ProjectCatalogEntry[];
  projectDisplayNames?: Readonly<Record<string, string>>;
  pipelines: Pipeline[];
  workflows: Workflow[];
  archivedProjects: ReadonlySet<string>;
  crownedProjects?: ReadonlySet<string>;
  selected: string;
  /** The attention clock the Viewer owns. */
  now: number;
  /** Each project's needs-you count, from the one queue the header and the
      panel read, so the badge here carries the panel section's number. */
  needsYouCounts?: ReadonlyMap<string, number>;
  loaded: boolean;
  catalogFailures?: number;
  onSelect: (project: string) => void;
  onCreateProject?: CreateProject;
  onClose: () => void;
  /** A team install's workspaces (docs/design/workspaces.md §13.5 P2, P3).
      Absent, the sheet is exactly what it was. */
  workspace?: WorkspaceRailState;
  /** Rename, archive and restore from a project's menu. */
  actions?: ProjectRowActions;
  onToggleCrown?: (project: string, crowned: boolean) => void;
  /** Each project's folder, beside the catalog's own, for Rename. */
  projectCwds?: Readonly<Record<string, string>>;
}

/** A press held for half a second (or the browser's own long press, which arrives as contextmenu) opens a row's menu; the click it ends in does nothing else. */
function LongPress({ onLong, children, project }: { onLong: () => void; children: ReactNode; project: string }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  const fire = () => { if (fired.current) return; fired.current = true; clear(); onLong(); };
  useEffect(() => clear, []);
  return (
    <div
      data-mobile2-longpress={project}
      className="select-none [-webkit-touch-callout:none]"
      onPointerDown={(event) => { fired.current = false; start.current = { x: event.clientX, y: event.clientY }; clear(); timer.current = setTimeout(fire, 500); }}
      onPointerMove={(event) => { if (start.current && Math.hypot(event.clientX - start.current.x, event.clientY - start.current.y) > 8) clear(); }}
      onPointerUp={clear}
      onPointerCancel={clear}
      onContextMenu={(event) => { event.preventDefault(); fire(); }}
      onClickCapture={(event) => { if (fired.current) { event.preventDefault(); event.stopPropagation(); fired.current = false; } }}
    >
      {children}
    </div>
  );
}

function hintSeen(): boolean {
  try { return window.localStorage.getItem(PROJECT_MENU_HINT_STORAGE_KEY) === "seen"; } catch { return true; }
}

const EMPTY_CROWNS: ReadonlySet<string> = new Set();

export function MobileProjectSheet({
  files,
  projectCatalog,
  projectDisplayNames = {},
  pipelines,
  workflows,
  archivedProjects,
  crownedProjects = EMPTY_CROWNS,
  selected,
  now,
  needsYouCounts,
  loaded,
  catalogFailures = 0,
  onSelect,
  onCreateProject,
  onClose,
  workspace,
  actions,
  onToggleCrown,
  projectCwds,
}: MobileProjectSheetProps) {
  const { t } = useLocale();
  const summaries = useMemo(
    () => buildProjectSummaries(files, now, workflows, projectCatalog, pipelines, projectDisplayNames, needsYouCounts, workingAgentCounts(files, now)),
    [files, now, workflows, projectCatalog, pipelines, projectDisplayNames, needsYouCounts],
  );
  /* A chosen workspace narrows the list before the crowned, rest and archive
     split, as the rail does. */
  const scope = useMemo(() => (workspace ? workspaceScope(workspace.view, workspace.chosen) : null), [workspace]);
  const scoped = useMemo(() => (scope ? summaries.filter((summary) => scope.has(summary.project)) : summaries), [summaries, scope]);
  const active = useMemo(() => scoped.filter((summary) => !archivedProjects.has(summary.project)), [scoped, archivedProjects]);
  const archived = useMemo(() => scoped.filter((summary) => archivedProjects.has(summary.project)), [scoped, archivedProjects]);
  const { crowned, rest } = useMemo(() => partitionCrownedSummaries(active, crownedProjects), [active, crownedProjects]);
  const counts = useMemo<WorkspaceCounts | null>(() => (workspace ? {
    all: summaries.length,
    byWorkspace: new Map(groupAll(summaries, workspace.view).flatMap((section) => (section.workspace ? [[section.workspace.id, section.rows.length] as const] : []))),
  } : null), [summaries, workspace]);
  /* In All every project stands under its own workspace, a crowned one first
     with its crown, so each heading counts what the switcher counts (§13.5 P3). */
  const sections = useMemo(() => (workspace && !scope ? groupAll([...crowned, ...rest], workspace.view) : null), [workspace, scope, crowned, rest]);
  const [switchOpen, setSwitchOpen] = useState(false);
  /* A refusal that came back after the project's menu closed stands under its row. */
  const [rowError, setRowError] = useState<{ project: string; text: string } | null>(null);
  const move = (project: string, workspaceId: string | null) => {
    if (!workspace) return;
    setRowError(null);
    void workspace.place(project, workspaceId).then((result) => {
      if (!result.ok) setRowError({ project, text: workspaceErrorText(t, result.code) });
    });
  };
  /* The project whose menu stands in the list's place. */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const working = useMemo(() => new Set(files.filter((file) => file.proc === "running" || file.activity === "live").map((file) => projectKey(file))), [files]);
  const roots = useMemo(() => {
    const known = new Map<string, string>();
    for (const entry of projectCatalog) if (entry.projectRoot) known.set(entry.project, entry.projectRoot);
    for (const [project, cwd] of Object.entries(projectCwds ?? {})) if (!known.has(project)) known.set(project, cwd);
    return known;
  }, [projectCatalog, projectCwds]);
  const menuSummary = menuFor ? summaries.find((summary) => summary.project === menuFor) ?? null : null;
  /* The long-press hint, once per browser: read when the list first opens, remembered at once. */
  const [hint, setHint] = useState(false);
  const canMenu = Boolean(actions || onToggleCrown || workspace);
  useEffect(() => {
    if (!canMenu || !summaries.length || hintSeen()) return;
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- one read of this browser's storage once the list has rows */
    setHint(true);
    try { window.localStorage.setItem(PROJECT_MENU_HINT_STORAGE_KEY, "seen"); } catch { /* private mode: shown again next time */ }
  }, [canMenu, summaries.length]);
  /* While the switcher is open over a chosen workspace, its rows stand in for the list. */
  const listHidden = switchOpen && scope !== null;
  /* A first run (the catalog answered with no project at all) opens the create
     form itself: the only reason to have opened this sheet is what that form
     does (the rail's own rule, issue #1162). */
  const firstRun = loaded && catalogFailures === 0 && summaries.length === 0;
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(firstRun && Boolean(onCreateProject));

  const row = (summary: ProjectSummary, quiet = false) => {
    const current = summary.project === selected;
    const isCrowned = crownedProjects.has(summary.project);
    /* The open project's ⋯ stands on its row, in its check's place: a phone has no hover to show it later. */
    const door = canMenu && current;
    const sheetRow = (
      <MobileSheetRow
        key={summary.project}
        icon={isCrowned ? <Crown className="h-[18px] w-[18px] fill-crown text-crown" aria-hidden /> : <Folder className="h-[18px] w-[18px]" aria-hidden />}
        label={summary.displayName}
        selected={current}
        ariaLabel={t("mobile2.projects.select", { name: summary.displayName })}
        attrs={{ "data-mobile2-project": summary.project, "data-mobile2-quiet": quiet ? "1" : undefined }}
        trailing={
          <>
            {/* Working is the green ● count the rail row, the board header and
                its columns draw, whichever row is selected. */}
            {summary.liveCount ? (
              <span data-mobile2-working="" className="inline-flex items-center gap-1 font-bold tabular-nums text-success">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success motion-reduce:animate-none" aria-hidden />
                {t("mobile2.projects.live", { count: summary.liveCount })}
              </span>
            ) : (
              <span className={quiet ? "text-muted" : ""}>
                {summary.smt ? t("mobile2.projects.quietSince", { age: fmtAge(summary.smt) }) : t("mobile2.projects.quiet")}
              </span>
            )}
            {summary.attentionCount ? (
              <Badge tone="warning">
                <TriangleAlert className="h-[11px] w-[11px]" aria-hidden /> {summary.attentionCount}
              </Badge>
            ) : null}
            {door ? <span className="w-[26px] shrink-0" aria-hidden /> : current ? <Check className="h-[18px] w-[18px] text-accent" aria-hidden /> : null}
          </>
        }
        onSelect={() => onSelect(summary.project)}
      />
    );
    const label = t("rail.row.actions", { name: summary.displayName });
    return (
      <div key={summary.project} data-mobile2-project-row={summary.project}>
        <div className="relative">
          {canMenu ? <LongPress project={summary.project} onLong={() => { setRowError(null); setHint(false); setMenuFor(summary.project); }}>{sheetRow}</LongPress> : sheetRow}
          {door ? (
            <button
              type="button"
              data-mobile2-project-menu={summary.project}
              aria-haspopup="menu"
              aria-label={label}
              title={label}
              onClick={() => { setRowError(null); setHint(false); setMenuFor(summary.project); }}
              className="absolute right-[3px] top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-[8px] text-accent active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <MoreHorizontal className="h-5 w-5" aria-hidden />
            </button>
          ) : null}
        </div>
        {rowError?.project === summary.project ? <p role="alert" data-mobile2-row-error="" className="px-4 pb-2 text-label font-semibold text-danger">{rowError.text}</p> : null}
      </div>
    );
  };

  if (menuSummary) {
    const project = menuSummary.project;
    const back = (error?: string) => {
      setMenuFor(null);
      if (error) setRowError({ project, text: error });
    };
    return (
      <MobileSheet name="projects" title={menuSummary.displayName} onClose={() => back()}>
        <ProjectActionsSheetBody
          key={project}
          target={{ project, name: menuSummary.displayName, root: roots.get(project) ?? null, crowned: crownedProjects.has(project), archived: archivedProjects.has(project), working: working.has(project) }}
          view={workspace?.view ?? null}
          rights={projectRights(workspace?.view, project)}
          actions={actions}
          loaded={loaded}
          onToggleCrown={onToggleCrown}
          onMove={workspace ? move : undefined}
          onDone={back}
          onDeleted={(deleted) => {
            setMenuFor(null);
            requestFilesRefresh();
            if (selected === deleted) onSelect(OVERVIEW);
          }}
        />
      </MobileSheet>
    );
  }

  return (
    /* The phone has no rail, so the rail's resources block rides at the foot of
       the sheet that stands in for it: memory pressure, the agent hosts and
       what Delegatus itself holds stay one tap away (#1817). */
    <MobileSheet
      name="projects"
      title={t("mobile2.projects.title")}
      onClose={onClose}
      footer={<div className="-mx-4 min-w-0 flex-1"><ResourcesFooter /></div>}
    >
      {workspace && counts ? (
        <>
          <MobileWorkspaceSwitch
            state={{ ...workspace, choose: (next) => { setSwitchOpen(false); workspace.choose(next); } }}
            counts={counts}
            expanded={switchOpen}
            onToggle={() => setSwitchOpen((value) => !value)}
          />
          <MobileSheetDivider />
        </>
      ) : null}
      <MobileSheetRow
        icon={<Layers className="h-[18px] w-[18px]" aria-hidden />}
        label={t("mobile2.projects.overview")}
        selected={selected === OVERVIEW}
        attrs={{ "data-mobile2-project": OVERVIEW }}
        trailing={
          <>
            <span>{t("mobile2.projects.count", { count: active.length })}</span>
            {selected === OVERVIEW ? <Check className="h-[18px] w-[18px] text-accent" aria-hidden /> : null}
          </>
        }
        onSelect={() => onSelect(OVERVIEW)}
      />
      <MobileSheetDivider />
      {hint ? (
        <div data-mobile2-project-hint="" className="flex items-center gap-3 pl-4">
          <Hand className="h-[18px] w-[18px] shrink-0 text-secondary" aria-hidden />
          <span className="min-w-0 flex-1 text-label font-medium text-secondary">{t("rail.row.hint")}</span>
          <button
            type="button"
            data-mobile2-project-hint-dismiss=""
            aria-label={t("rail.row.hintDismiss")}
            title={t("rail.row.hintDismiss")}
            onClick={() => setHint(false)}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[8px] text-secondary active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : null}
      {listHidden || sections ? null : crowned.map((summary) => row(summary))}
      {listHidden ? null : sections ? sections.map((section) => (
        <div key={section.workspace?.id ?? "unassigned"} data-mobile2-workspace-section={section.workspace?.id ?? "unassigned"}>
          <MobileSheetSection count={section.rows.length}>
            {section.workspace ? <WorkspaceDot color={section.workspace.color} size={8} /> : null}
            <span className="min-w-0 truncate">{section.workspace ? section.workspace.name : t("workspaces.unassigned")}</span>
          </MobileSheetSection>
          {section.rows.map((summary) => row(summary))}
        </div>
      )) : rest.map((summary) => row(summary))}
      {scope && !listHidden && loaded && !active.length && !archived.length ? (
        <div data-mobile2-workspace-empty="" className="px-4 py-3 text-ui text-muted">{t("workspaces.page.empty")}</div>
      ) : null}
      {!loaded && !summaries.length ? <BoardRowsSkeleton variant="list" rows={4} className="flex-none" /> : null}
      {catalogFailures > 0 && !summaries.length ? <div className="px-4 py-3 text-ui font-semibold text-danger">{t("catalog.unreachable")}</div> : null}
      <MobileSheetDivider />
      {archived.length ? (
        <MobileSheetRow
          icon={<Archive className="h-[18px] w-[18px]" aria-hidden />}
          label={t("mobile2.projects.archive")}
          attrs={{ "data-mobile2-project-archive": archiveOpen ? "open" : "closed" }}
          trailing={
            <>
              <span>{t("mobile2.projects.count", { count: archived.length })}</span>
              <ChevronRight className={`h-4 w-4 transition-transform motion-reduce:transition-none ${archiveOpen ? "rotate-90" : ""}`} aria-hidden />
            </>
          }
          onSelect={() => setArchiveOpen((value) => !value)}
        />
      ) : null}
      {archiveOpen ? archived.map((summary) => row(summary, true)) : null}
      {onCreateProject ? (
        <MobileSheetRow
          icon={<FolderPlus className="h-[18px] w-[18px]" aria-hidden />}
          label={t("mobile2.projects.create")}
          attrs={{ "data-mobile2-project-create": createOpen ? "open" : "closed" }}
          onSelect={() => setCreateOpen((value) => !value)}
        />
      ) : null}
      {createOpen && onCreateProject ? (
        <CreateProjectRows
          onCreate={onCreateProject}
          onCreated={(project) => {
            setCreateOpen(false);
            onSelect(project);
          }}
        />
      ) : null}
    </MobileSheet>
  );
}

/** The create form as sheet rows: a name, a root directory, one Create
    control. A path typed here goes to the server as is; a refused one is
    named back on the row. */
function CreateProjectRows({ onCreate, onCreated }: { onCreate: CreateProject; onCreated: (project: string) => void }) {
  const { t } = useLocale();
  const [name, setName] = useState("");
  const [root, setRoot] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = "min-h-11 w-full rounded-[8px] border border-border bg-sunken px-3 text-[16px] text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedRoot = root.trim();
    const trimmedName = name.trim() || trimmedRoot.split("/").filter(Boolean).pop() || "";
    if (!trimmedRoot || busy) return;
    setBusy(true);
    setError(null);
    const outcome = await onCreate(trimmedName, trimmedRoot);
    setBusy(false);
    if (outcome.ok) {
      onCreated(outcome.project);
      return;
    }
    setError(outcome.message || t("mobile2.projects.createFailed"));
  };
  return (
    <form className="flex flex-col gap-2 px-4 pb-2 pt-1" data-mobile2-project-form onSubmit={submit}>
      <label className="flex flex-col gap-1 text-label font-semibold text-secondary">
        {t("mobile2.projects.createName")}
        <input className={field} value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" />
      </label>
      <label className="flex flex-col gap-1 text-label font-semibold text-secondary">
        {t("mobile2.projects.createRoot")}
        <input className={field} value={root} onChange={(event) => setRoot(event.target.value)} autoComplete="off" spellCheck={false} />
      </label>
      {error ? <span role="alert" className="text-label font-semibold text-danger">{error}</span> : null}
      <button
        type="submit"
        disabled={busy || !root.trim()}
        className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[8px] bg-brand px-4 text-body font-semibold text-on-brand disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <FolderPlus className="h-4 w-4" aria-hidden />}
        {t("mobile2.projects.createSubmit")}
      </button>
    </form>
  );
}
