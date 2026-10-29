"use client";

import { ArrowRightLeft, Check, RotateCcw } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Archive, ArchiveRestore, ChevronLeft, ChevronRight, Crown, PencilLine, Trash2 } from "@/components/icons";
import { Z } from "@/components/layers";
import { useModalLayer } from "@/components/modalLayer";
import { BAR_MENU_ROW } from "@/components/ProjectBar";
import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { deleteProjectFiles, loadProjectConversations } from "../ProjectTrash";
import { WORKSPACE_MENU_LABEL, WorkspaceDot } from "../team/WorkspaceSwitch";
import type { TeamWorkspaces } from "../team/workspaceFilter";
import { readProjectName } from "./presentationClient";
import { pathParts, refusalText, workspaceName, type ProjectRights, type ProjectRowActions } from "./rights";

/*
 * A project row's menu in the desktop rail, variant 2 «A menu that explains»
 * (docs/design/project-rail-context-menu/README.md). Every row has a second
 * line saying what it changes, where things stand, or why it is closed. Move
 * to… is a page of the menu with a Back row; Archive and Delete stand at the
 * bottom and each asks on a page of its own; Rename is a small dialog.
 */

export interface ProjectMenuTarget {
  project: string;
  name: string;
  /** The folder the name came from, when the catalog knows it. */
  root: string | null;
  crowned: boolean;
  archived: boolean;
  /** An agent is working in it, or a process still runs: archive and delete wait. */
  working: boolean;
}

/** Where a menu opens: beside its row (the ⋯, the keyboard) or at the pointer, under the row (right-click). */
export type ProjectMenuAt = { from: "trigger" | "keyboard" | "pointer"; x?: number };

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
/* The header menu's page row (src/components/headerMenu/HeaderMenu.tsx). */
const BACK_ROW = `mb-1 flex w-full min-h-[30px] items-center gap-1.5 rounded-t-[8px] border-b border-border px-2 py-1.5 text-left text-[12px] hover:bg-sunken ${FOCUS}`;
/* The create form's controls (ProjectRail.tsx CreateProjectForm). */
const INPUT = `w-full rounded-[9px] border border-border bg-canvas px-2.5 py-1.5 text-[13px] font-bold outline-none ${FOCUS}`;
const CANCEL = `rounded-[9px] px-2.5 py-1.5 text-[12px] font-semibold text-muted hover:bg-canvas disabled:opacity-60 ${FOCUS}`;
const CONFIRM = `rounded-[9px] px-3 py-1.5 text-[12px] font-semibold disabled:opacity-60 ${FOCUS}`;
/* A row the person may not use: still focusable and announced, with its reason under it. */
const ROW_OFF = "cursor-default hover:bg-transparent";
const ICON = "h-3.5 w-3.5 shrink-0";
const PANEL = `fixed ${Z.popover} w-[256px] max-w-[calc(100vw-16px)] rounded-[10px] border border-border bg-card p-1 shadow-2`;

/** A path drawn whole: it wraps only after a slash. */
export function PathText({ path }: { path: string }) {
  return <>{pathParts(path).map((part, index) => <span key={index}>{part}<wbr /></span>)}</>;
}

/** The arrows walk the stops of one panel; Home and End jump to its ends. */
function walk(event: ReactKeyboardEvent, panel: HTMLElement | null): void {
  const items = [...(panel?.querySelectorAll<HTMLElement>("[data-row-menu-stop]:not(:disabled)") ?? [])];
  if (!items.length) return;
  const index = items.indexOf(document.activeElement as HTMLElement);
  const go = (next: number) => { event.preventDefault(); items[(next + items.length) % items.length]?.focus(); };
  if (event.key === "ArrowDown") go(index + 1);
  else if (event.key === "ArrowUp") go(index < 0 ? items.length - 1 : index - 1);
  else if (event.key === "Home") go(0);
  else if (event.key === "End") go(items.length - 1);
}

type Page = "rest" | "move" | "archive" | "delete";
type NameRead = { state: "reading" } | { state: "failed" } | { state: "answered"; name: string | null };

interface Item {
  id: string;
  icon: ReactNode;
  label: string;
  line: string;
  off: boolean;
  danger?: boolean;
  opens?: boolean;
  act: () => void;
}

export function ProjectRowMenu({ target, at, row, view, rights, actions, loaded, onToggleCrown, onMove, onRename, onDeleted, onError, onClose }: {
  target: ProjectMenuTarget;
  at: ProjectMenuAt;
  /** The row the menu acts on: it stands beside it, or under it at the pointer. */
  row: () => HTMLElement | null;
  view: TeamWorkspaces | null;
  rights: ProjectRights;
  actions?: ProjectRowActions;
  /** The catalog answered, so the project's conversations can be listed for Delete. */
  loaded: boolean;
  onToggleCrown?: (project: string, crowned: boolean) => void;
  onMove?: (project: string, workspaceId: string | null) => void;
  onRename: () => void;
  onDeleted: (project: string) => void;
  /** A refusal that arrives after the menu closed is shown on the row. */
  onError: (project: string, text: string) => void;
  onClose: (refocus: boolean) => void;
}) {
  const { t } = useLocale();
  const panel = useRef<HTMLDivElement>(null);
  const [spot, setSpot] = useState<{ left: number; top: number } | null>(null);
  const [page, setPage] = useState<Page>("rest");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doomed, setDoomed] = useState<FileEntry[] | null>(null);
  const [named, setNamed] = useState<NameRead>({ state: "reading" });
  const close = useRef(onClose);
  const rowOf = useRef(row);
  /* The row of the main page that opened a page, to take the focus back to once that page closes. */
  const returnTo = useRef<Page | null>(null);
  /* Escape with the focus outside the menu (a page that unmounted under it) still closes it. */
  const escape = useRef<() => void>(() => {});
  useEffect(() => { close.current = onClose; rowOf.current = row; });

  /* Whether a name was chosen decides the reset row: it appears only once the read says so. */
  useEffect(() => {
    if (!actions) return;
    const abort = new AbortController();
    readProjectName(target.project, abort.signal).then(
      (name) => setNamed({ state: "answered", name }),
      () => { if (!abort.signal.aborted) setNamed({ state: "failed" }); },
    );
    return () => abort.abort();
  }, [actions, target.project]);

  useLayoutEffect(() => {
    const menu = panel.current;
    const element = rowOf.current();
    if (!menu || !element) return;
    const margin = 8;
    const box = element.getBoundingClientRect();
    const rail = element.closest("[data-project-rail]")?.getBoundingClientRect();
    /* Beside the rail, level with the row: it covers no row. At the pointer: under the row, so the name it acts on stays in view. */
    let left = at.from === "pointer" ? at.x ?? box.left : (rail?.right ?? box.right) + 4;
    let top = at.from === "pointer" ? box.bottom + 2 : box.top;
    left = Math.max(margin, Math.min(left, window.innerWidth - margin - menu.offsetWidth));
    if (top + menu.offsetHeight > window.innerHeight - margin) {
      top = at.from === "pointer" ? box.top - menu.offsetHeight - 2 : window.innerHeight - margin - menu.offsetHeight;
    }
    const next = { left, top: Math.max(margin, top) };
    setSpot((previous) => (previous && previous.left === next.left && previous.top === next.top ? previous : next));
  }, [at, page, named, error, doomed, busy]);

  const opened = spot !== null;
  useEffect(() => {
    if (!opened) return;
    const stops = panel.current?.querySelectorAll<HTMLElement>("[data-row-menu-stop]");
    const first = [...(stops ?? [])].find((stop) => stop.getAttribute("aria-disabled") !== "true") ?? stops?.[0];
    first?.focus();
  }, [opened]);
  useEffect(() => {
    if (page === "move") (panel.current?.querySelector<HTMLElement>("[data-row-menu-space][aria-checked='true']")
      ?? panel.current?.querySelector<HTMLElement>("[data-row-menu-space]"))?.focus();
    else if (page !== "rest") panel.current?.querySelector<HTMLElement>("[data-row-menu-cancel]")?.focus();
    else if (returnTo.current) {
      panel.current?.querySelector<HTMLElement>(`[data-row-menu-item='${returnTo.current}']`)?.focus();
      returnTo.current = null;
    }
  }, [page, doomed]);
  useEffect(() => {
    const down = (event: PointerEvent) => {
      const node = event.target as Node;
      if (panel.current?.contains(node)) return;
      /* The row's own ⋯ toggles the menu itself. */
      if ((node as Element).closest?.(`[data-rail-row-menu]`)) return;
      close.current(false);
    };
    /* A scroll that moves the row leaves the menu beside nothing; a pane scrolling elsewhere does not. */
    const scrolled = (event: Event) => {
      const target = event.target;
      const element = rowOf.current();
      if (target === document || target === window || (target instanceof Node && element && target.contains(element))) close.current(false);
    };
    const resized = () => close.current(false);
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || panel.current?.contains(event.target as Node)) return;
      event.preventDefault();
      escape.current();
    };
    window.addEventListener("pointerdown", down);
    window.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", resized);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", resized);
      window.removeEventListener("keydown", key);
    };
  }, []);

  const back = () => {
    if (busy) return;
    returnTo.current = page;
    setPage("rest");
    setError(null);
    setDoomed(null);
  };
  useEffect(() => {
    escape.current = () => { if (page !== "rest") back(); else close.current(true); };
  });
  const onKey = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (page !== "rest") back(); else onClose(true);
      return;
    }
    if (event.key === "Tab") { event.preventDefault(); onClose(true); return; }
    const active = document.activeElement as HTMLElement | null;
    if (event.key === "ArrowRight" && page === "rest" && active?.dataset.rowMenuItem === "move" && active.getAttribute("aria-disabled") !== "true") { event.preventDefault(); setPage("move"); return; }
    if (event.key === "ArrowLeft" && page !== "rest") { event.preventDefault(); back(); return; }
    walk(event, panel.current);
  };

  const items: Item[] = [];
  if (actions) {
    items.push({ id: "rename", icon: <PencilLine className={`${ICON} text-muted`} aria-hidden />, label: t("rail.row.rename"), line: rights.rename ? t("rail.row.renameHint") : t("rail.row.ownerRenames"), off: !rights.rename, act: onRename });
    if (rights.rename && named.state === "answered" && named.name !== null) {
      const folder = target.root ? pathParts(target.root.replace(/\/+$/, "")).at(-1) ?? "" : "";
      items.push({
        id: "reset",
        icon: <RotateCcw className={`${ICON} text-muted`} aria-hidden />,
        label: t("rail.row.resetName"),
        line: folder ? t("rail.row.resetNameHint", { folder }) : t("rail.row.resetNameHintBare"),
        off: false,
        act: () => {
          const project = target.project;
          onClose(true);
          void actions.rename(project, null).then((result) => { if (!result.ok) onError(project, refusalText(t, result.code, "rail.row.ownerRenames")); });
        },
      });
    }
  }
  if (rights.move !== null && onMove && view) {
    items.push({ id: "move", icon: <ArrowRightLeft className={`${ICON} text-muted`} aria-hidden />, label: t("workspaces.moveTo"), line: rights.move ? t("rail.row.moveHint", { where: workspaceName(t, view.workspaces, rights.current) }) : t("rail.row.ownerMoves"), off: !rights.move, opens: true, act: () => setPage("move") });
  }
  if (onToggleCrown && !target.archived) {
    items.push({
      id: "crown",
      icon: <Crown className={`${ICON} ${target.crowned ? "fill-crown text-crown" : "text-muted"}`} aria-hidden />,
      label: target.crowned ? t("rail.uncrown") : t("rail.crown"),
      line: target.crowned ? t("rail.row.crownedHint") : t("rail.row.crownHint"),
      off: false,
      act: () => { onToggleCrown(target.project, !target.crowned); onClose(true); },
    });
  }
  const tail: Item[] = [];
  if (actions) {
    if (target.archived) {
      tail.push({
        id: "unarchive", icon: <ArchiveRestore className={`${ICON} text-muted`} aria-hidden />, label: t("dash.unarchive"),
        line: rights.archive ? t("rail.row.unarchiveHint") : t("rail.row.ownerArchives"), off: !rights.archive,
        act: () => {
          const project = target.project;
          onClose(true);
          void actions.unarchive(project).then((result) => { if (!result.ok) onError(project, refusalText(t, result.code, "rail.row.ownerArchives")); });
        },
      });
    } else {
      tail.push({
        id: "archive", icon: <Archive className={`${ICON} text-muted`} aria-hidden />, label: t("rail.row.archive"),
        line: target.working ? t("rail.row.working") : rights.archive ? t("rail.row.archiveHint") : t("rail.row.ownerArchives"),
        off: target.working || !rights.archive, opens: true, act: () => setPage("archive"),
      });
    }
  }
  if (loaded) {
    tail.push({
      id: "delete", icon: <Trash2 className={`${ICON} text-danger`} aria-hidden />, label: t("rail.row.delete"),
      line: target.working ? t("rail.row.working") : rights.delete ? t("rail.row.deleteHint") : t("rail.row.ownerDeletes"),
      off: target.working || !rights.delete, danger: true, opens: true,
      act: () => {
        setPage("delete");
        setBusy(true);
        setError(null);
        loadProjectConversations(target.project).then((complete) => {
          if (!complete.length) throw new Error("project catalog is empty");
          setDoomed(complete);
        }).catch(() => setError(t("trash.projectLoadFailed"))).finally(() => setBusy(false));
      },
    });
  }

  const archive = async () => {
    if (!actions || busy) return;
    setBusy(true);
    setError(null);
    const result = await actions.archive(target.project);
    setBusy(false);
    if (result.ok) onClose(true);
    else setError(refusalText(t, result.code, "rail.row.ownerArchives"));
  };
  const remove = async () => {
    if (!doomed || busy) return;
    setBusy(true);
    setError(null);
    const failed = await deleteProjectFiles(target.project, doomed);
    setBusy(false);
    if (failed) { setError(t("trash.notDeleted", { failed, total: doomed.length })); return; }
    onClose(false);
    onDeleted(target.project);
  };

  const row_ = (item: Item) => (
    <button
      key={item.id}
      type="button"
      role="menuitem"
      data-row-menu-stop=""
      data-row-menu-item={item.id}
      aria-disabled={item.off ? true : undefined}
      aria-haspopup={item.opens && !item.off ? "menu" : undefined}
      className={`${BAR_MENU_ROW} py-1 ${item.off ? ROW_OFF : ""}`}
      onClick={() => { if (!item.off) item.act(); }}
    >
      {item.icon}
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className={`leading-4 ${item.off ? "text-muted" : item.danger ? "text-danger" : ""}`}>{item.label}</span>
        {item.line ? <span data-row-menu-why={item.off ? "off" : "hint"} className={`text-[11px] font-normal leading-[14px] ${item.off ? "text-secondary" : "text-muted"}`}>{item.line}</span> : null}
      </span>
      {item.opens && !item.off && item.id === "move" ? <ChevronRight className={`${ICON} text-muted`} aria-hidden /> : null}
    </button>
  );
  const backRow = (
    <button type="button" data-row-menu-back="" data-row-menu-stop="" className={BACK_ROW} onClick={back} disabled={busy}>
      <ChevronLeft className="h-4 w-4 shrink-0 text-secondary" aria-hidden />
      <span className="shrink-0 font-semibold text-secondary">{t("headerMenu.back")}</span>
      <span aria-hidden className="shrink-0 text-muted">·</span>
      <span className="min-w-0 flex-1 break-words font-bold text-primary">{target.name}</span>
    </button>
  );
  const errorLine = error ? <p role="alert" data-row-menu-error="" className="px-2 pb-1 text-[11px] font-semibold leading-[14px] text-danger">{error}</p> : null;

  let body: ReactNode;
  if (page === "move" && view) {
    const options = rights.targets.map((id) => ({ id, workspace: id ? view.workspaces.find((workspace) => workspace.id === id) ?? null : null }));
    body = (
      <div data-row-menu-page="move">
        {backRow}
        <div className={WORKSPACE_MENU_LABEL}>{t("workspaces.moveTo")}</div>
        {options.map(({ id, workspace }) => (
          <button
            key={id ?? "unassigned"}
            type="button"
            role="menuitemradio"
            aria-checked={rights.current === id}
            data-row-menu-stop=""
            data-row-menu-space={id ?? "unassigned"}
            className={BAR_MENU_ROW}
            onClick={() => {
              onClose(true);
              if (rights.current !== id) onMove?.(target.project, id);
            }}
          >
            <span className="flex w-3.5 shrink-0 justify-center">{workspace ? <WorkspaceDot color={workspace.color} /> : null}</span>
            <span className="min-w-0 flex-1 break-words">{workspace ? workspace.name : t("workspaces.unassigned")}</span>
            <span className="flex w-3.5 shrink-0 justify-center">{rights.current === id ? <Check className="h-3.5 w-3.5 text-accent" aria-hidden /> : null}</span>
          </button>
        ))}
      </div>
    );
  } else if (page === "archive" || page === "delete") {
    const deleting = page === "delete";
    body = (
      <div data-row-menu-page={page}>
        {backRow}
        <div className="flex flex-col gap-1.5 px-2 pb-1.5 pt-0.5">
          <p data-row-menu-question="" className="text-[12px] font-bold leading-4 text-primary">
            {t(deleting ? "rail.row.deleteTitle" : "rail.row.archiveTitle", { name: target.name })}
          </p>
          {deleting && !doomed ? (
            busy ? <p className="text-[11px] leading-[14px] text-muted">{t("rail.row.counting")}</p> : null
          ) : (
            <p className="text-[11px] leading-[15px] text-secondary">
              {deleting ? t("rail.row.deleteBody", { count: doomed?.length ?? 0 }) : t("rail.row.archiveBody")}
            </p>
          )}
        </div>
        {errorLine}
        <div className="flex justify-end gap-1.5 px-1 pb-1">
          <button type="button" data-row-menu-stop="" data-row-menu-cancel="" className={CANCEL} disabled={busy && Boolean(doomed || !deleting)} onClick={back}>{t("common.cancel")}</button>
          {deleting ? (
            <button type="button" data-row-menu-stop="" data-row-menu-confirm="delete" className={`${CONFIRM} bg-danger text-white`} disabled={busy || !doomed} onClick={() => void remove()}>
              {busy && doomed ? t("trash.deleting") : t("trash.confirmYes")}
            </button>
          ) : (
            <button type="button" data-row-menu-stop="" data-row-menu-confirm="archive" className={`${CONFIRM} bg-brand text-on-brand`} disabled={busy} onClick={() => void archive()}>
              {busy ? t("rail.row.saving") : t("rail.row.archiveYes")}
            </button>
          )}
        </div>
      </div>
    );
  } else {
    body = (
      <>
        {items.map(row_)}
        {items.length && tail.length ? <div className="mx-1 my-1 h-px bg-border" aria-hidden /> : null}
        {tail.map(row_)}
      </>
    );
  }

  const style: CSSProperties = spot ? { left: spot.left, top: spot.top } : { left: 0, top: 0, visibility: "hidden" };
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={panel}
      role="menu"
      aria-label={t("rail.row.actions", { name: target.name })}
      data-row-menu={target.project}
      data-row-menu-view={page}
      className={PANEL}
      style={style}
      onKeyDown={onKey}
    >
      {body}
    </div>,
    document.body,
  );
}

/** Rename as a small dialog over an inert page, naming the folder the name leaves alone. */
export function ProjectRenameDialog({ target, rename, onDone }: {
  target: ProjectMenuTarget;
  rename: ProjectRowActions["rename"];
  onDone: () => void;
}) {
  const { t } = useLocale();
  const [value, setValue] = useState(target.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const outer = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(onDone);
  useEffect(() => { done.current = onDone; });
  useModalLayer({ containerRef: dialog, onClose: () => { if (!busy) onDone(); }, manageFocus: false });
  useEffect(() => {
    /* Everything behind the dialog is out of reach: no Tab, no tap, no reader. */
    const held = [...document.body.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child !== outer.current && !child.hasAttribute("inert"));
    for (const child of held) child.setAttribute("inert", "");
    input.current?.focus();
    input.current?.select();
    return () => { for (const child of held) child.removeAttribute("inert"); };
  }, []);
  const save = async () => {
    if (busy) return;
    const next = value.trim();
    if (!next) { setError(t("rail.row.emptyName")); return; }
    if (next === target.name) { onDone(); return; }
    setBusy(true);
    setError(null);
    const result = await rename(target.project, next);
    setBusy(false);
    if (result.ok) done.current();
    else setError(refusalText(t, result.code, "rail.row.ownerRenames"));
  };
  if (typeof document === "undefined") return null;
  return createPortal(
    <div ref={outer} className={`fixed inset-0 ${Z.modal} flex items-start justify-center bg-black/40 px-4 pt-[18vh]`} role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) onDone(); }}>
      <form
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-rename-title"
        tabIndex={-1}
        data-project-rename=""
        className="flex w-[360px] max-w-full flex-col gap-2.5 rounded-[12px] border border-border bg-card p-4 shadow-2 outline-none"
        onSubmit={(event) => { event.preventDefault(); void save(); }}
      >
        <h2 id="project-rename-title" className="text-[14px] font-bold text-primary">{t("rail.row.renameTitle")}</h2>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-bold text-muted">{t("rail.row.name")}</span>
          <input
            ref={input}
            data-project-rename-input=""
            maxLength={80}
            aria-invalid={error ? true : undefined}
            disabled={busy}
            value={value}
            onChange={(event) => { setValue(event.target.value); setError(null); }}
            className={INPUT}
          />
        </label>
        {error ? <p role="alert" data-project-rename-error="" className="text-[11px] font-semibold text-danger">{error}</p> : null}
        <p data-project-rename-folder="" className="text-[11px] leading-[15px] text-muted">
          {target.root ? <>{t("rail.row.folderLead")} <PathText path={target.root} /></> : t("rail.row.renameHint")}
        </p>
        <div className="flex justify-end gap-1.5 pt-1">
          <button type="button" data-project-rename-cancel="" className={CANCEL} disabled={busy} onClick={onDone}>{t("common.cancel")}</button>
          <button type="submit" data-project-rename-save="" className={`${CONFIRM} bg-brand text-on-brand`} disabled={busy}>{busy ? t("rail.row.saving") : t("rail.row.save")}</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
