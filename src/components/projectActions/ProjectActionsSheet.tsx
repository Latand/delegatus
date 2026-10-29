"use client";

import { ArrowRightLeft, Check, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Archive, ArchiveRestore, ChevronLeft, ChevronRight, Crown, PencilLine, Trash2 } from "@/components/icons";
import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { MobileSheetDivider, MobileSheetRow, MobileSheetSection } from "../mobile/MobileSheet";
import { deleteProjectFiles, loadProjectConversations } from "../ProjectTrash";
import { WorkspaceDot } from "../team/WorkspaceSwitch";
import type { TeamWorkspaces } from "../team/workspaceFilter";
import { readProjectName } from "./presentationClient";
import { PathText, type ProjectMenuTarget } from "./ProjectRowMenu";
import { pathParts, refusalText, workspaceName, type ProjectRights, type ProjectRowActions } from "./rights";

/*
 * The project row's menu on the phone (variant 2): the same rows as the
 * desktop menu, each with its second line, drawn as rows of the project sheet
 * in the list's place. Move to…, Rename, Archive and Delete are pages of the
 * sheet with a Back row on top.
 */

type Page = "rest" | "move" | "rename" | "archive" | "delete";
type NameRead = { state: "reading" } | { state: "failed" } | { state: "answered"; name: string | null };

const BUTTON = "inline-flex min-h-11 flex-1 items-center justify-center rounded-[8px] px-4 text-body font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60";
const FIELD = "min-h-11 w-full rounded-[8px] border border-border bg-sunken px-3 text-[16px] font-semibold text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:text-muted";
/* A sheet row the person may not use: announced as unavailable and still readable with its reason. */
const CLOSED = { "aria-disabled": "true" } as unknown as Record<`data-${string}`, string>;

/** A sheet row's label with a line under it: what the row changes, or why it is closed. */
function TwoLines({ title, line, off = false, danger = false }: { title: string; line: string; off?: boolean; danger?: boolean }) {
  return (
    <span className="flex flex-col whitespace-normal py-1.5">
      <span className={off ? "text-muted" : danger ? "text-danger" : undefined}>{title}</span>
      <span data-row-menu-why={off ? "off" : "hint"} className={`text-label font-medium ${off ? "text-secondary" : "text-muted"}`}>{line}</span>
    </span>
  );
}

export function ProjectActionsSheetBody({ target, view, rights, actions, loaded, onToggleCrown, onMove, onDone, onDeleted }: {
  target: ProjectMenuTarget;
  view: TeamWorkspaces | null;
  rights: ProjectRights;
  actions?: ProjectRowActions;
  loaded: boolean;
  onToggleCrown?: (project: string, crowned: boolean) => void;
  onMove?: (project: string, workspaceId: string | null) => void;
  /** Back to the project list; a refusal that came after is shown there under the row. */
  onDone: (error?: string) => void;
  onDeleted: (project: string) => void;
}) {
  const { t } = useLocale();
  const [page, setPage] = useState<Page>("rest");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doomed, setDoomed] = useState<FileEntry[] | null>(null);
  const [value, setValue] = useState(target.name);
  const [named, setNamed] = useState<NameRead>({ state: "reading" });
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!actions) return;
    const abort = new AbortController();
    readProjectName(target.project, abort.signal).then(
      (name) => setNamed({ state: "answered", name }),
      () => { if (!abort.signal.aborted) setNamed({ state: "failed" }); },
    );
    return () => abort.abort();
  }, [actions, target.project]);
  useEffect(() => { if (page === "rename") input.current?.focus(); }, [page]);

  const go = (next: Page) => { setPage(next); setError(null); setBusy(false); };
  const back = <MobileSheetRow icon={<ChevronLeft className="h-[18px] w-[18px]" aria-hidden />} label={t("headerMenu.back")} attrs={{ "data-row-menu-back": "" }} disabled={busy} onSelect={() => { setDoomed(null); go("rest"); }} />;
  const errorLine = error ? <p role="alert" data-row-menu-error="" className="px-4 pb-2 text-label font-semibold text-danger">{error}</p> : null;

  if (page === "move" && view) {
    return (
      <div data-row-menu-page="move">
        {back}
        <MobileSheetSection>{t("workspaces.moveTo")}</MobileSheetSection>
        {rights.targets.map((id) => {
          const workspace = id ? view.workspaces.find((entry) => entry.id === id) ?? null : null;
          return (
            <MobileSheetRow
              key={id ?? "unassigned"}
              icon={workspace ? <WorkspaceDot color={workspace.color} size={12} /> : <span aria-hidden />}
              label={workspace ? workspace.name : t("workspaces.unassigned")}
              checked={rights.current === id}
              attrs={{ "data-row-menu-space": id ?? "unassigned" }}
              trailing={rights.current === id ? <Check className="h-[18px] w-[18px] text-accent" aria-hidden /> : null}
              onSelect={() => { if (rights.current !== id) onMove?.(target.project, id); onDone(); }}
            />
          );
        })}
      </div>
    );
  }

  if (page === "rename" && actions) {
    const save = async () => {
      if (busy) return;
      const next = value.trim();
      if (!next) { setError(t("rail.row.emptyName")); return; }
      if (next === target.name) { onDone(); return; }
      setBusy(true);
      setError(null);
      const result = await actions.rename(target.project, next);
      setBusy(false);
      if (result.ok) onDone();
      else setError(refusalText(t, result.code, "rail.row.ownerRenames"));
    };
    return (
      <div data-row-menu-page="rename">
        {back}
        <form className="flex flex-col gap-2 px-4 pb-2 pt-1" data-project-rename="" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <label className="flex flex-col gap-1 text-label font-semibold text-secondary">
            {t("rail.row.name")}
            <input ref={input} data-project-rename-input="" className={FIELD} value={value} maxLength={80} disabled={busy} autoComplete="off" aria-invalid={error ? true : undefined} onChange={(event) => { setValue(event.target.value); setError(null); }} />
          </label>
          {error ? (
            <span role="alert" data-project-rename-error="" className="text-label font-semibold text-danger">{error}</span>
          ) : (
            <span data-project-rename-folder="" className="text-label text-muted">
              {target.root ? <>{t("rail.row.folderLead")} <PathText path={target.root} /></> : t("rail.row.renameHint")}
            </span>
          )}
          <div className="flex gap-2">
            <button type="button" data-project-rename-cancel="" className={`${BUTTON} border border-border bg-card text-secondary`} disabled={busy} onClick={() => go("rest")}>{t("common.cancel")}</button>
            <button type="submit" data-project-rename-save="" className={`${BUTTON} bg-brand text-on-brand`} disabled={busy}>{busy ? t("rail.row.saving") : t("rail.row.save")}</button>
          </div>
        </form>
      </div>
    );
  }

  if (page === "archive" || page === "delete") {
    const deleting = page === "delete";
    const confirm = async () => {
      if (busy || (deleting && !doomed)) return;
      setBusy(true);
      setError(null);
      if (deleting && doomed) {
        const failed = await deleteProjectFiles(target.project, doomed);
        setBusy(false);
        if (failed) { setError(t("trash.notDeleted", { failed, total: doomed.length })); return; }
        onDeleted(target.project);
        return;
      }
      if (!actions) return;
      const result = await actions.archive(target.project);
      setBusy(false);
      if (result.ok) onDone();
      else setError(refusalText(t, result.code, "rail.row.ownerArchives"));
    };
    return (
      <div data-row-menu-page={page}>
        {back}
        <div className="flex flex-col gap-1 px-4 pb-2 pt-1">
          <p data-row-menu-question="" className="text-body font-semibold text-primary">{t(deleting ? "rail.row.deleteTitle" : "rail.row.archiveTitle", { name: target.name })}</p>
          {deleting && !doomed ? (
            busy ? <p className="text-label text-muted">{t("rail.row.counting")}</p> : null
          ) : (
            <p className="text-label text-secondary">{deleting ? t("rail.row.deleteBody", { count: doomed?.length ?? 0 }) : t("rail.row.archiveBody")}</p>
          )}
        </div>
        {errorLine}
        <div className="flex gap-2 px-4 pb-2">
          <button type="button" data-row-menu-cancel="" className={`${BUTTON} border border-border bg-card text-secondary`} disabled={busy && Boolean(doomed || !deleting)} onClick={() => { setDoomed(null); go("rest"); }}>{t("common.cancel")}</button>
          {deleting ? (
            <button type="button" data-row-menu-confirm="delete" className={`${BUTTON} bg-danger text-white`} disabled={busy || !doomed} onClick={() => void confirm()}>{busy && doomed ? t("trash.deleting") : t("trash.confirmYes")}</button>
          ) : (
            <button type="button" data-row-menu-confirm="archive" className={`${BUTTON} bg-brand text-on-brand`} disabled={busy} onClick={() => void confirm()}>{busy ? t("rail.row.saving") : t("rail.row.archiveYes")}</button>
          )}
        </div>
      </div>
    );
  }

  const rows: ReactNode[] = [];
  const tail: ReactNode[] = [];
  if (actions) {
    rows.push(
      <MobileSheetRow
        key="rename"
        icon={<PencilLine className="h-[18px] w-[18px]" aria-hidden />}
        label={<TwoLines title={t("rail.row.rename")} line={rights.rename ? t("rail.row.renameHint") : t("rail.row.ownerRenames")} off={!rights.rename} />}
        attrs={{ "data-row-menu-item": "rename", ...(rights.rename ? {} : CLOSED) }}
        onSelect={() => { if (rights.rename) go("rename"); }}
      />,
    );
    if (rights.rename && named.state === "answered" && named.name !== null) {
      const folder = target.root ? pathParts(target.root.replace(/\/+$/, "")).at(-1) ?? "" : "";
      rows.push(
        <MobileSheetRow
          key="reset"
          icon={<RotateCcw className="h-[18px] w-[18px]" aria-hidden />}
          label={<TwoLines title={t("rail.row.resetName")} line={folder ? t("rail.row.resetNameHint", { folder }) : t("rail.row.resetNameHintBare")} />}
          attrs={{ "data-row-menu-item": "reset" }}
          onSelect={() => {
            const project = target.project;
            void actions.rename(project, null).then((result) => { onDone(result.ok ? undefined : refusalText(t, result.code, "rail.row.ownerRenames")); });
          }}
        />,
      );
    }
  }
  if (rights.move !== null && onMove && view) {
    rows.push(
      <MobileSheetRow
        key="move"
        icon={<ArrowRightLeft className="h-[18px] w-[18px]" aria-hidden />}
        label={<TwoLines title={t("workspaces.moveTo")} line={rights.move ? t("rail.row.moveHint", { where: workspaceName(t, view.workspaces, rights.current) }) : t("rail.row.ownerMoves")} off={!rights.move} />}
        attrs={{ "data-row-menu-item": "move", ...(rights.move ? {} : CLOSED) }}
        trailing={rights.move ? <ChevronRight className="h-4 w-4" aria-hidden /> : null}
        onSelect={() => { if (rights.move) go("move"); }}
      />,
    );
  }
  if (onToggleCrown && !target.archived) {
    rows.push(
      <MobileSheetRow
        key="crown"
        icon={<Crown className={`h-[18px] w-[18px] ${target.crowned ? "fill-crown text-crown" : ""}`} aria-hidden />}
        label={<TwoLines title={target.crowned ? t("rail.uncrown") : t("rail.crown")} line={target.crowned ? t("rail.row.crownedHint") : t("rail.row.crownHint")} />}
        attrs={{ "data-row-menu-item": "crown" }}
        onSelect={() => { onToggleCrown(target.project, !target.crowned); onDone(); }}
      />,
    );
  }
  if (actions) {
    if (target.archived) {
      tail.push(
        <MobileSheetRow
          key="unarchive"
          icon={<ArchiveRestore className="h-[18px] w-[18px]" aria-hidden />}
          label={<TwoLines title={t("dash.unarchive")} line={rights.archive ? t("rail.row.unarchiveHint") : t("rail.row.ownerArchives")} off={!rights.archive} />}
          attrs={{ "data-row-menu-item": "unarchive", ...(rights.archive ? {} : CLOSED) }}
          onSelect={() => {
            if (!rights.archive) return;
            void actions.unarchive(target.project).then((result) => { onDone(result.ok ? undefined : refusalText(t, result.code, "rail.row.ownerArchives")); });
          }}
        />,
      );
    } else {
      const off = target.working || !rights.archive;
      tail.push(
        <MobileSheetRow
          key="archive"
          icon={<Archive className="h-[18px] w-[18px]" aria-hidden />}
          label={<TwoLines title={t("rail.row.archive")} line={target.working ? t("rail.row.working") : rights.archive ? t("rail.row.archiveHint") : t("rail.row.ownerArchives")} off={off} />}
          attrs={{ "data-row-menu-item": "archive", ...(off ? CLOSED : {}) }}
          onSelect={() => { if (!off) go("archive"); }}
        />,
      );
    }
  }
  if (loaded) {
    const off = target.working || !rights.delete;
    tail.push(
      <MobileSheetRow
        key="delete"
        icon={<Trash2 className={`h-[18px] w-[18px] ${off ? "" : "text-danger"}`} aria-hidden />}
        label={<TwoLines title={t("rail.row.delete")} line={target.working ? t("rail.row.working") : rights.delete ? t("rail.row.deleteHint") : t("rail.row.ownerDeletes")} off={off} danger />}
        attrs={{ "data-row-menu-item": "delete", ...(off ? CLOSED : {}) }}
        onSelect={() => {
          if (off) return;
          go("delete");
          setBusy(true);
          loadProjectConversations(target.project).then((complete) => {
            if (!complete.length) throw new Error("project catalog is empty");
            setDoomed(complete);
          }).catch(() => setError(t("trash.projectLoadFailed"))).finally(() => setBusy(false));
        }}
      />,
    );
  }
  return (
    <div data-row-menu={target.project} data-row-menu-view="rest">
      {rows}
      {rows.length && tail.length ? <MobileSheetDivider /> : null}
      {tail}
    </div>
  );
}
