"use client";

import { ArrowRightLeft, Folder, MoreHorizontal, Plus } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { BAR_MENU_ROW } from "@/components/ProjectBar";
import { projectDisplayName } from "@/lib/displayNames";
import { useLocale } from "@/lib/i18n";
import { MEMBER_COLOR_HEX, MEMBER_COLOR_INK, MEMBER_COLORS, type MemberColor, type Workspace, type WorkspaceCatalogProject } from "@/lib/team/contract";

import { BUTTON, Field, INPUT, relativeTime, TeamDialog } from "./ui";
import { MoveToMenu, WORKSPACE_PATHS, workspaceErrorText, WorkspacePopover } from "./WorkspaceSwitch";
import type { TeamWorkspaces } from "./workspaceFilter";
import {
  createWorkspace,
  deleteWorkspace,
  mintWorkspaceId,
  nextWorkspaceColor,
  placeProject,
  updateWorkspace,
  useWorkspaces,
  workspaceNameProblem,
} from "./workspacesClient";

/*
 * Team → Workspaces (docs/design/workspaces.md §13.5 D4, D5, P4, P5): the
 * workspaces with their projects, the projects in none, and the owner's New
 * workspace dialog. A member reads the same rows without the controls.
 */

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
const ROW_MENU_BUTTON = `flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-muted hover:bg-sunken hover:text-primary max-sm:h-11 max-sm:w-11 ${FOCUS}`;

export type CatalogRows = { ready: boolean; projects: WorkspaceCatalogProject[] };

/** Every project with its name and age: the catalog's rows, and any key a
    workspace holds that the catalog does not list. */
export function projectRows(view: TeamWorkspaces): { ready: boolean; rows: Map<string, WorkspaceCatalogProject> } {
  const rows = new Map((view.catalog?.projects ?? []).map((row) => [row.project, row] as const));
  for (const workspace of view.workspaces) {
    for (const project of workspace.projects) if (!rows.has(project)) rows.set(project, { project, displayName: projectDisplayName(project), smt: 0 });
  }
  return { ready: view.catalog?.ready ?? false, rows };
}

/** The colour tile a workspace row leads with: its colour and initial. */
export function WorkspaceTile({ workspace, size = 32 }: { workspace: Pick<Workspace, "name" | "color">; size?: number }) {
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-control text-ui font-bold"
      style={{ width: size, height: size, backgroundColor: MEMBER_COLOR_HEX[workspace.color], color: MEMBER_COLOR_INK[workspace.color] }}
    >
      {[...workspace.name][0]?.toUpperCase() ?? "?"}
    </span>
  );
}

export function smtAge(smt: number, locale: "en" | "uk"): string {
  return smt > 0 ? relativeTime(new Date(smt * 1000).toISOString(), locale) : "";
}

export function WorkspacesTab({ initialCreate = false }: { initialCreate?: boolean }) {
  const { t, locale } = useLocale();
  const answer = useWorkspaces({ catalog: true });
  const [creating, setCreating] = useState<{ draft: CreateDraft | null; error: string | null } | null>(initialCreate ? { draft: null, error: null } : null);
  const [renaming, setRenaming] = useState<{ workspace: Workspace; draft: string; error: string | null } | null>(null);
  const [error, setError] = useState<{ at: string; text: string } | null>(null);
  if (!answer || answer.mode !== "team") return <div className="py-10 text-center text-ui text-muted">{t("common.loadingCap")}</div>;
  const view = answer;
  const owner = view.canManage;
  const { ready, rows } = projectRows(view);
  const placed = new Set(view.workspaces.flatMap((workspace) => workspace.projects));
  const unassigned = [...rows.values()].filter((row) => !placed.has(row.project));

  const create = (draft: CreateDraft) => {
    setCreating(null);
    void createWorkspace(draft).then((result) => {
      /* A refusal opens the dialog again on what was typed, with the reason. */
      if (!result.ok) setCreating({ draft, error: workspaceErrorText(t, result.code) });
    });
  };
  const rename = (workspace: Workspace, name: string) => {
    setRenaming(null);
    void updateWorkspace(workspace.id, { name }).then((result) => {
      if (!result.ok) setRenaming({ workspace, draft: name, error: workspaceErrorText(t, result.code) });
    });
  };
  const remove = (workspace: Workspace) => {
    setError(null);
    void deleteWorkspace(workspace.id).then((result) => {
      if (!result.ok) setError({ at: workspace.id, text: workspaceErrorText(t, result.code) });
    });
  };
  const move = (project: string, workspaceId: string) => {
    setError(null);
    void placeProject(project, workspaceId).then((result) => {
      if (!result.ok) setError({ at: project, text: workspaceErrorText(t, result.code) });
    });
  };

  return (
    <div className="flex flex-col gap-4" data-team-workspaces="">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="min-w-0 flex-1 text-ui text-secondary">{t("workspaces.lead")}</p>
        {owner ? (
          <button type="button" className={BUTTON.smallPrimary} onClick={() => setCreating({ draft: null, error: null })} data-workspace-create-open="">
            <Plus className="h-3.5 w-3.5" aria-hidden />{t("workspaces.new")}
          </button>
        ) : null}
      </div>

      {view.workspaces.length ? (
        <ul className="overflow-hidden rounded-surface border border-border bg-card" aria-label={t("workspaces.heading")}>
          {view.workspaces.map((workspace) => (
            <WorkspaceRow
              key={workspace.id}
              workspace={workspace}
              names={workspace.projects.map((project) => rows.get(project)?.displayName ?? projectDisplayName(project))}
              owner={owner}
              error={error?.at === workspace.id ? error.text : null}
              onRename={() => setRenaming({ workspace, draft: workspace.name, error: null })}
              onDelete={() => remove(workspace)}
            />
          ))}
        </ul>
      ) : (
        <p className="rounded-surface border border-dashed border-border px-4 py-3 text-ui text-muted" data-workspace-none="">{t("workspaces.none")}</p>
      )}

      <section aria-labelledby="workspaces-unassigned-title">
        <h2 id="workspaces-unassigned-title" className="mb-1.5 px-1 text-label font-semibold text-secondary">
          {t("workspaces.unassignedTitle")} · {unassigned.length}
        </h2>
        {!ready ? (
          <p className="px-1 text-ui text-muted" data-workspace-catalog-loading="">{t("workspaces.catalogLoading")}</p>
        ) : unassigned.length ? (
          <ul className="overflow-hidden rounded-surface border border-border bg-card" data-workspace-unassigned="">
            {unassigned.map((row) => (
              <UnassignedRow
                key={row.project}
                row={row}
                age={smtAge(row.smt, locale)}
                workspaces={owner ? view.workspaces : null}
                error={error?.at === row.project ? error.text : null}
                onMove={(workspaceId) => move(row.project, workspaceId)}
              />
            ))}
          </ul>
        ) : null}
      </section>

      {creating ? (
        <CreateWorkspaceDialog
          view={view}
          rows={rows}
          initial={creating.draft}
          error={creating.error}
          onClose={() => setCreating(null)}
          onCreate={create}
        />
      ) : null}
      {renaming ? (
        <RenameWorkspaceDialog
          view={view}
          workspace={renaming.workspace}
          initial={renaming.draft}
          error={renaming.error}
          onClose={() => setRenaming(null)}
          onRename={(name) => rename(renaming.workspace, name)}
        />
      ) : null}
    </div>
  );
}

function WorkspaceRow({ workspace, names, owner, error, onRename, onDelete }: {
  workspace: Workspace;
  names: string[];
  owner: boolean;
  error: string | null;
  onRename: () => void;
  onDelete: () => void;
}) {
  const { t } = useLocale();
  const [menuOpen, setMenuOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const empty = workspace.projects.length === 0;
  return (
    <li data-workspace-row={workspace.id} className="border-b border-border last:border-b-0">
      <div className="flex items-center gap-3 px-4 py-3 max-sm:px-3">
        <WorkspaceTile workspace={workspace} />
        <div className="min-w-0 flex-1">
          <a href={WORKSPACE_PATHS.page(workspace.id)} className={`block min-w-0 truncate rounded-[4px] text-body font-semibold text-primary hover:underline ${FOCUS}`} data-workspace-row-name="">
            {workspace.name}
          </a>
          <p className="mt-0.5 min-w-0 truncate text-label text-muted" data-workspace-row-projects="">
            {t("mobile2.projects.count", { count: workspace.projects.length })}{names.length ? ` · ${names.join(", ")}` : ""}
          </p>
        </div>
        {owner ? (
          <button
            ref={trigger}
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={t("workspaces.actions", { name: workspace.name })}
            data-workspace-row-menu=""
            className={ROW_MENU_BUTTON}
            onClick={() => setMenuOpen((value) => !value)}
          >
            <MoreHorizontal className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
      </div>
      {error ? <p role="alert" className="px-4 pb-2 text-label font-semibold text-danger">{error}</p> : null}
      {menuOpen ? (
        <WorkspacePopover anchor={trigger} label={t("workspaces.actions", { name: workspace.name })} onClose={() => setMenuOpen(false)} testId="row" width={248}>
          <a role="menuitem" href={WORKSPACE_PATHS.page(workspace.id)} className={BAR_MENU_ROW} data-workspace-action="open">{t("workspaces.open")}</a>
          <button type="button" role="menuitem" className={BAR_MENU_ROW} data-workspace-action="rename" onClick={() => { setMenuOpen(false); onRename(); }}>{t("workspaces.rename")}</button>
          <button type="button" role="menuitem" className={`${BAR_MENU_ROW} ${empty ? "text-danger" : ""}`} disabled={!empty} aria-describedby={empty ? undefined : `workspace-delete-blocked-${workspace.id}`} data-workspace-action="delete" onClick={() => { setMenuOpen(false); onDelete(); }}>
            {t("workspaces.delete")}
          </button>
          {empty ? null : <p id={`workspace-delete-blocked-${workspace.id}`} className="px-2 pb-1.5 text-[11px] text-muted">{t("workspaces.deleteBlocked")}</p>}
        </WorkspacePopover>
      ) : null}
    </li>
  );
}

function UnassignedRow({ row, age, workspaces, error, onMove }: {
  row: WorkspaceCatalogProject;
  age: string;
  /** The owner's targets; null for a member, who gets no control. */
  workspaces: readonly Workspace[] | null;
  error: string | null;
  onMove: (workspaceId: string) => void;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  return (
    <li data-workspace-unassigned-row={row.project} className="border-b border-border last:border-b-0">
      <div className="flex items-center gap-3 px-4 py-2.5 max-sm:px-3">
        <Folder className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="min-w-0 truncate text-ui font-semibold text-primary">{row.displayName}</p>
          {age ? <p className="text-label text-muted">{age}</p> : null}
        </div>
        {workspaces?.length ? (
          <button
            ref={trigger}
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            data-workspace-move-open=""
            className={BUTTON.small}
            onClick={() => setOpen((value) => !value)}
          >
            <ArrowRightLeft className="h-3.5 w-3.5" aria-hidden />{t("workspaces.moveTo")}
          </button>
        ) : null}
      </div>
      {error ? <p role="alert" className="px-4 pb-2 text-label font-semibold text-danger">{error}</p> : null}
      {open && workspaces ? <MoveToMenu workspaces={workspaces} anchor={trigger} onClose={() => setOpen(false)} onPick={(id) => { setOpen(false); onMove(id); }} /> : null}
    </li>
  );
}

export interface CreateDraft {
  id: string;
  name: string;
  color: MemberColor;
  projects: string[];
}

/** The checklist of projects (D5's, and the workspace page's Add project):
    those in no workspace first, then those another workspace holds, named. */
export function ProjectChecklist({ view, rows, checked, onToggle, exclude = null }: {
  view: TeamWorkspaces;
  rows: ReadonlyMap<string, WorkspaceCatalogProject>;
  checked: ReadonlySet<string>;
  onToggle: (project: string) => void;
  /** The workspace whose own projects are left out. */
  exclude?: string | null;
}) {
  const { t } = useLocale();
  const holder = useMemo(() => {
    const map = new Map<string, Workspace>();
    for (const workspace of view.workspaces) for (const project of workspace.projects) map.set(project, workspace);
    return map;
  }, [view]);
  const list = [...rows.values()]
    .filter((row) => !exclude || holder.get(row.project)?.id !== exclude)
    .sort((a, b) => Number(holder.has(a.project)) - Number(holder.has(b.project)));
  return (
    <div className="flex max-h-[min(40dvh,288px)] flex-col overflow-y-auto rounded-control border border-border bg-canvas p-1" data-workspace-checklist="">
      {list.map((row) => {
        const held = holder.get(row.project);
        return (
          <label key={row.project} data-workspace-check={row.project} className="flex min-h-9 cursor-pointer items-center gap-2 rounded-[6px] px-2 hover:bg-sunken max-sm:min-h-11">
            <input type="checkbox" checked={checked.has(row.project)} onChange={() => onToggle(row.project)} className="h-4 w-4 shrink-0 accent-accent max-sm:h-5 max-sm:w-5" />
            <span className="min-w-0 flex-1 truncate text-ui font-semibold text-primary">{row.displayName}</span>
            <span className="max-w-[45%] shrink-0 truncate text-label text-muted">{held ? t("workspaces.inWs", { ws: held.name }) : t("workspaces.unassigned")}</span>
          </label>
        );
      })}
    </div>
  );
}

export function ColourSwatches({ value, onChange, label }: { value: MemberColor; onChange: (color: MemberColor) => void; label: string }) {
  const { t } = useLocale();
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
      {MEMBER_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          aria-label={t(`kanban.color.${color}`)}
          data-workspace-color={color}
          onClick={() => onChange(color)}
          className={`flex h-8 w-8 items-center justify-center rounded-full ${FOCUS} max-sm:h-11 max-sm:w-11 ${value === color ? "ring-2 ring-primary ring-offset-2 ring-offset-card" : ""}`}
        >
          <span className="h-6 w-6 rounded-full" style={{ backgroundColor: MEMBER_COLOR_HEX[color] }} />
        </button>
      ))}
    </div>
  );
}

function CreateWorkspaceDialog({ view, rows, initial, error, onClose, onCreate }: {
  view: TeamWorkspaces;
  rows: ReadonlyMap<string, WorkspaceCatalogProject>;
  initial: CreateDraft | null;
  error: string | null;
  onClose: () => void;
  onCreate: (draft: CreateDraft) => void;
}) {
  const { t } = useLocale();
  /* The id is minted once per dialog, so a resubmission after a refusal is the same create. */
  const [id] = useState(() => initial?.id ?? mintWorkspaceId());
  const [name, setName] = useState(initial?.name ?? "");
  const [color, setColor] = useState<MemberColor>(initial?.color ?? nextWorkspaceColor(view.workspaces));
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set(initial?.projects ?? []));
  const [problem, setProblem] = useState<string | null>(error);
  const submit = () => {
    const refused = workspaceNameProblem(view, name);
    if (refused) return setProblem(workspaceErrorText(t, refused));
    onCreate({ id, name, color, projects: [...checked] });
  };
  return (
    <TeamDialog title={t("workspaces.new")} onClose={onClose} closeLabel={t("common.close")} testId="workspace-create">
      <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <Field label={t("workspaces.create.name")}>
          <input className={INPUT} value={name} autoFocus maxLength={80} onChange={(event) => { setName(event.target.value); setProblem(null); }} data-workspace-create-name="" />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-label font-semibold text-secondary">{t("workspaces.create.colour")}</span>
          <ColourSwatches value={color} onChange={setColor} label={t("workspaces.create.colour")} />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-label font-semibold text-secondary" id="workspace-create-projects">{t("workspaces.create.projects")}</span>
          <ProjectChecklist
            view={view}
            rows={rows}
            checked={checked}
            onToggle={(project) => setChecked((held) => {
              const next = new Set(held);
              if (next.has(project)) next.delete(project);
              else next.add(project);
              return next;
            })}
          />
          <span className="text-caption leading-snug text-muted">{t("workspaces.create.projectsHint")}</span>
        </div>
        {problem ? <p role="alert" className="rounded-control bg-danger-soft px-3 py-2 text-ui text-danger" data-workspace-create-error="">{problem}</p> : null}
        <div className="flex justify-end gap-2 max-sm:grid max-sm:grid-cols-2">
          <button type="button" className={BUTTON.secondary} onClick={onClose}>{t("common.cancel")}</button>
          <button type="submit" className={BUTTON.primary} data-workspace-create-submit="">{t("workspaces.create.submit")}</button>
        </div>
      </form>
    </TeamDialog>
  );
}

function RenameWorkspaceDialog({ view, workspace, initial, error, onClose, onRename }: {
  view: TeamWorkspaces;
  workspace: Workspace;
  initial: string;
  error: string | null;
  onClose: () => void;
  onRename: (name: string) => void;
}) {
  const { t } = useLocale();
  const [name, setName] = useState(initial);
  const [problem, setProblem] = useState<string | null>(error);
  const submit = () => {
    const refused = workspaceNameProblem(view, name, workspace.id);
    if (refused) return setProblem(workspaceErrorText(t, refused));
    onRename(name);
  };
  return (
    <TeamDialog title={t("workspaces.rename")} onClose={onClose} closeLabel={t("common.close")} testId="workspace-rename">
      <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <Field label={t("workspaces.create.name")}>
          <input className={INPUT} value={name} autoFocus maxLength={80} onChange={(event) => { setName(event.target.value); setProblem(null); }} data-workspace-rename-name="" />
        </Field>
        {problem ? <p role="alert" className="rounded-control bg-danger-soft px-3 py-2 text-ui text-danger">{problem}</p> : null}
        <div className="flex justify-end gap-2 max-sm:grid max-sm:grid-cols-2">
          <button type="button" className={BUTTON.secondary} onClick={onClose}>{t("common.cancel")}</button>
          <button type="submit" className={BUTTON.primary}>{t("team.member.save")}</button>
        </div>
      </form>
    </TeamDialog>
  );
}
