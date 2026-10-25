"use client";

import { ArrowLeft, Folder, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useLocale } from "@/lib/i18n";
import type { Workspace } from "@/lib/team/contract";

import { BUTTON, Field, INPUT, teamRequest } from "./ui";
import { ProjectChecklist, projectRows, smtAge } from "./WorkspacesTab";
import { WORKSPACE_MENU_LABEL, WORKSPACE_PATHS, WorkspaceDot, workspaceErrorText, WorkspacePopover } from "./WorkspaceSwitch";
import type { TeamWorkspaces } from "./workspaceFilter";
import { deleteWorkspace, placeProject, refreshWorkspaces, updateWorkspace, useWorkspaces, workspaceNameProblem } from "./workspacesClient";

/*
 * `/team/workspaces/<id>` (docs/design/workspaces.md §13.5 D6, D7, P6): one
 * workspace, its name and its projects. The owner renames it, adds and
 * removes projects, and deletes it once it is empty; anyone else reads it.
 * Membership and workspace roles are managed beside projects. The accounts, chat, worker share, usage and fence sections of the
 * prototype come with the later slices.
 */

/* The form field at the height of the title line (32 px; 48 on the phone). */
const RENAME_INPUT = INPUT.replace("h-10 ", "h-8 ");

export function WorkspacePage({ id }: { id: string }) {
  const { t } = useLocale();
  const answer = useWorkspaces({ catalog: true });
  const workspace = answer?.mode === "team" ? answer.workspaces.find((candidate) => candidate.id === id) ?? null : null;
  return (
    <div className="h-full overflow-y-auto bg-canvas" data-workspace-page={answer ? (workspace ? "ready" : answer.mode === "team" ? "gone" : "solo") : "loading"}>
      <div className="mx-auto flex max-w-[960px] flex-col gap-4 px-6 py-5 max-sm:px-3 max-sm:py-3">
        {!answer ? (
          <>
            <BackLink />
            <div className="py-10 text-center text-ui text-muted">{t("common.loadingCap")}</div>
          </>
        ) : answer.mode !== "team" ? (
          /* A solo install has no workspaces: the Team page is where a team starts. */
          <>
            <BackLink />
            <p className="rounded-surface border border-border bg-card px-4 py-3 text-ui text-secondary" data-workspace-solo="">
              {t("team.soloSubtitle")}{" "}
              <a href="/team" className="font-semibold text-accent hover:underline">{t("team.menu")}</a>
            </p>
          </>
        ) : !workspace ? (
          <>
            <BackLink />
            <p className="rounded-surface border border-border bg-card px-4 py-3 text-ui text-secondary" data-workspace-gone="">
              {t("workspaces.error.gone")}{" "}
              <a href={WORKSPACE_PATHS.manage} className="font-semibold text-accent hover:underline">{t("workspaces.manage")}</a>
            </p>
          </>
        ) : (
          <WorkspaceBody view={answer} workspace={workspace} />
        )}
      </div>
    </div>
  );
}

function BackLink() {
  const { t } = useLocale();
  return (
    /* A plain link, as the Team page's own back link is: the board is a full page load from here. */
    // eslint-disable-next-line @next/next/no-html-link-for-pages
    <a
      href="/"
      data-workspace-back=""
      className="flex h-8 items-center gap-1.5 self-start rounded-control border border-border bg-card px-2.5 text-ui font-semibold text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11"
    >
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
      {t("activity.back")}
    </a>
  );
}

function WorkspaceBody({ view, workspace }: { view: TeamWorkspaces; workspace: Workspace }) {
  const { t, locale } = useLocale();
  const owner = view.canManage;
  const { ready, rows } = projectRows(view);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<{ at: string; text: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const addTrigger = useRef<HTMLButtonElement | null>(null);
  const empty = workspace.projects.length === 0;
  const count = t("mobile2.projects.count", { count: workspace.projects.length });

  const rename = () => {
    if (renaming === null) return;
    const refused = workspaceNameProblem(view, renaming, workspace.id);
    if (refused) return setError({ at: "rename", text: workspaceErrorText(t, refused) });
    const name = renaming;
    setRenaming(null);
    setError(null);
    void updateWorkspace(workspace.id, { name }).then((result) => {
      if (!result.ok) {
        setRenaming(name);
        setError({ at: "rename", text: workspaceErrorText(t, result.code) });
      }
    });
  };
  const remove = () => {
    setError(null);
    void deleteWorkspace(workspace.id).then((result) => {
      if (result.ok) window.location.assign(WORKSPACE_PATHS.manage);
      else setError({ at: "delete", text: workspaceErrorText(t, result.code) });
    });
  };
  const place = (project: string, workspaceId: string | null) => {
    setError(null);
    void placeProject(project, workspaceId).then((result) => {
      if (!result.ok) setError({ at: project, text: workspaceErrorText(t, result.code) });
    });
  };
  const alert = (at: string) => (error?.at === at ? <p role="alert" className="text-label font-semibold text-danger">{error.text}</p> : null);

  return (
    <>
      {/* Every piece of the header's first line is 32 px tall and the line starts
          at the top, so the inline rename field moves neither the actions nor the
          sections below it. */}
      <header className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <BackLink />
        {/* While renaming, the phone gives the field the whole content width under the back link. */}
        <div className={`min-w-0 flex-1 basis-[240px] ${renaming !== null ? "max-sm:basis-full" : ""}`}>
          {renaming !== null ? (
            <form className="flex min-h-8 flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); rename(); }}>
              <WorkspaceDot color={workspace.color} size={10} />
              {/* The field keeps room for a whole name; Save and Cancel wrap under it together,
                  and on the phone the field fills the line beside the dot (10 px and an 8 px gap). */}
              <input
                className={`${RENAME_INPUT} min-w-[200px] max-w-[320px] flex-1 max-sm:max-w-none max-sm:basis-[calc(100%-18px)]`}
                value={renaming}
                autoFocus
                maxLength={80}
                aria-label={t("workspaces.create.name")}
                onChange={(event) => { setRenaming(event.target.value); setError(null); }}
                onKeyDown={(event) => { if (event.key === "Escape") { setRenaming(null); setError(null); } }}
                data-workspace-rename-field=""
              />
              <span className="flex items-center gap-2">
                <button type="submit" className={BUTTON.small}>{t("team.member.save")}</button>
                <button type="button" className={BUTTON.text} onClick={() => { setRenaming(null); setError(null); }}>{t("common.cancel")}</button>
              </span>
            </form>
          ) : (
            <h1 className="flex min-h-8 min-w-0 items-center gap-2 text-title font-bold text-primary max-sm:min-h-12" data-workspace-title="">
              <WorkspaceDot color={workspace.color} size={10} />
              <span className="min-w-0 truncate">{workspace.name}</span>
            </h1>
          )}
          <p className="text-[11.5px] text-muted" data-workspace-sub="">{t("workspaces.page.sub", { projects: count })}</p>
          {alert("rename")}
        </div>
        {owner ? (
          <div className="flex flex-wrap items-start gap-2">
            {renaming === null ? (
              <button type="button" className={BUTTON.small} onClick={() => setRenaming(workspace.name)} data-workspace-rename="">{t("workspaces.rename")}</button>
            ) : null}
            {/* The reason stands under Delete, as the sub line stands under the title, so the
                group stays narrow enough to share the first line on the desktop. */}
            <div className="flex flex-col items-start gap-1">
              <button type="button" className={BUTTON.danger} disabled={!empty} aria-describedby={empty ? undefined : "workspace-delete-blocked"} onClick={remove} data-workspace-delete="">
                {t("workspaces.delete")}
              </button>
              {empty ? null : <span id="workspace-delete-blocked" className="text-[11.5px] text-muted" data-workspace-delete-blocked="">{t("workspaces.deleteBlocked")}</span>}
            </div>
          </div>
        ) : null}
      </header>
      {alert("delete")}
      <WorkspaceMembers key={workspace.id} id={workspace.id} />

      <section aria-labelledby="workspace-projects-title" className="flex flex-col gap-1.5">
        <div className="flex min-h-8 items-center gap-2 px-1">
          <h2 id="workspace-projects-title" className="min-w-0 flex-1 text-label font-semibold text-secondary">{t("workspaces.create.projects")}</h2>
          {owner ? (
            <button
              ref={addTrigger}
              type="button"
              aria-haspopup="menu"
              aria-expanded={adding}
              className={BUTTON.small}
              onClick={() => setAdding((value) => !value)}
              data-workspace-add=""
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />{t("workspaces.page.add")}
            </button>
          ) : null}
        </div>
        {empty ? (
          <p className="rounded-surface border border-dashed border-border px-4 py-3 text-ui text-muted" data-workspace-empty="">{t("workspaces.page.empty")}</p>
        ) : (
          <ul className="overflow-hidden rounded-surface border border-border bg-card" data-workspace-projects="">
            {workspace.projects.map((project) => {
              const row = rows.get(project);
              const age = row ? smtAge(row.smt, locale) : "";
              return (
                <li key={project} data-workspace-project={project} className="border-b border-border last:border-b-0">
                  <div className="flex min-h-11 items-center gap-3 px-4 py-2 max-sm:flex-wrap max-sm:gap-y-1 max-sm:px-3">
                    <Folder className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-ui font-semibold text-primary">{row?.displayName ?? project}</span>
                    {age ? <span className="shrink-0 text-label text-muted">{age}</span> : null}
                    {/* A bordered button like the page's other actions; on the phone it takes
                        its own line, starting where the name starts. */}
                    {owner ? <span aria-hidden className="hidden max-sm:block max-sm:h-0 max-sm:basis-full" /> : null}
                    {owner ? (
                      <button type="button" className={`${BUTTON.small} max-sm:ml-7`} onClick={() => place(project, null)} data-workspace-remove="">
                        {t("workspaces.page.remove")}
                      </button>
                    ) : null}
                  </div>
                  {error?.at === project ? <p role="alert" className="px-4 pb-2 text-label font-semibold text-danger">{error.text}</p> : null}
                </li>
              );
            })}
          </ul>
        )}
        {!ready ? <p className="px-1 text-label text-muted">{t("workspaces.catalogLoading")}</p> : null}
      </section>

      {adding ? (
        <WorkspacePopover anchor={addTrigger} label={t("workspaces.page.add")} onClose={() => setAdding(false)} testId="add" width={320}>
          <div className={WORKSPACE_MENU_LABEL}>{t("workspaces.page.add")}</div>
          {[...rows.values()].some((row) => !workspace.projects.includes(row.project)) ? (
            <ProjectChecklist view={view} rows={rows} checked={new Set()} exclude={workspace.id} onToggle={(project) => place(project, workspace.id)} />
          ) : (
            <p className="px-2 pb-2 text-ui text-muted">{t("workspaces.page.nothingToAdd")}</p>
          )}
        </WorkspacePopover>
      ) : null}
    </>
  );
}

type WorkspacePerson = { id: string; name: string; owner: boolean; role: "member" | "manager" | null };
type MembershipView = { canManage: boolean; members: WorkspacePerson[]; candidates: WorkspacePerson[] };

function WorkspaceMembers({ id }: { id: string }) {
  const { t } = useLocale();
  const [view, setView] = useState<MembershipView | null>(null);
  const [selected, setSelected] = useState("");
  const [role, setRole] = useState<"member" | "manager">("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const load = useCallback(async () => {
    const answer = await teamRequest<MembershipView>(`/api/team/workspaces/${id}/members`);
    if (answer.ok) { setView(answer.body); return true; }
    setView(null);
    setError(true);
    return false;
  }, [id]);
  useEffect(() => {
    let mounted = true;
    void Promise.resolve().then(() => { if (mounted) void load(); });
    return () => { mounted = false; };
  }, [load]);
  const write = async (memberId: string, nextRole: "member" | "manager" | null) => {
    setBusy(true);
    setError(false);
    const answer = await teamRequest(`/api/team/workspaces/${id}/members`, { method: nextRole ? "PUT" : "DELETE", body: { memberId, ...(nextRole ? { role: nextRole } : {}) } });
    if (answer.ok) { await refreshWorkspaces(); if (await load()) setSelected(""); }
    else setError(true);
    setBusy(false);
  };
  return (
    <section aria-labelledby="workspace-members-title" className="flex flex-col gap-2" data-workspace-members="">
      <h2 id="workspace-members-title" className="px-1 text-label font-semibold text-secondary">{t("team.tabs.members")}</h2>
      {!view ? <button type="button" className={BUTTON.small} disabled={!error} onClick={() => { setError(false); void load(); }}>{t(error ? "workspaces.members.retry" : "common.loadingCap")}</button> : <>
        <ul className="overflow-hidden rounded-surface border border-border bg-card">
          {view.members.map(person => <li key={person.id} className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 last:border-b-0" data-workspace-member={person.id}>
            <span className="min-w-0 flex-1 basis-32 break-words text-ui font-semibold text-primary">{person.name}</span>
            {view.canManage && !person.owner ? <>
              <select className={`${INPUT.replace("w-full", "w-auto")} max-w-full`} aria-label={t("workspaces.members.roleFor", { name: person.name })} value={person.role ?? "member"} disabled={busy} onChange={event => void write(person.id, event.target.value as "member" | "manager")} data-workspace-member-role="">
                <option value="member">{t("team.role.member")}</option><option value="manager">{t("workspaces.members.manager")}</option>
              </select>
              <button type="button" className={BUTTON.small} disabled={busy} onClick={() => void write(person.id, null)} data-workspace-member-remove="">{t("workspaces.members.remove")}</button>
            </> : <span className="text-label text-secondary">{t(person.owner ? "team.role.owner" : person.role === "manager" ? "workspaces.members.manager" : "team.role.member")}</span>}
          </li>)}
        </ul>
        {view.canManage && view.candidates.length > 0 ? <form className="flex flex-wrap items-end gap-2 rounded-surface border border-border bg-card p-3" onSubmit={event => { event.preventDefault(); if (selected) void write(selected, role); }} data-workspace-member-add="">
          <div className="min-w-0 flex-1 basis-48"><Field label={t("workspaces.members.person")}>
            <select className={`${INPUT} w-full min-w-0`} title={view.candidates.find(person => person.id === selected)?.name ?? t("workspaces.members.choose")} value={selected} disabled={busy} onChange={event => setSelected(event.target.value)} data-workspace-member-choice="">
              <option value="">{t("workspaces.members.choose")}</option>
              {view.candidates.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
            </select>
          </Field></div>
          <Field label={t("workspaces.members.role")}><select className={INPUT} value={role} disabled={busy} onChange={event => setRole(event.target.value as "member" | "manager")} data-workspace-member-add-role="">
            <option value="member">{t("team.role.member")}</option><option value="manager">{t("workspaces.members.manager")}</option>
          </select></Field>
          <button type="submit" className={BUTTON.smallPrimary} disabled={busy || !selected} data-workspace-member-submit="">{t("workspaces.members.add")}</button>
        </form> : null}
      </>}
      {error ? <p role="alert" className="text-ui text-danger">{t("workspaces.error.failed")}</p> : null}
    </section>
  );
}
