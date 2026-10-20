"use client";

import { ArrowRightLeft, Check, ChevronDown, ChevronRight, Folders, Plus, SlidersHorizontal, Users } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { Z } from "@/components/layers";
import { MobileSheetRow } from "@/components/mobile/MobileSheet";
import { BAR_MENU_ROW } from "@/components/ProjectBar";
import { useLocale, type TFunction } from "@/lib/i18n";
import { MEMBER_COLOR_HEX, type MemberColor, type Workspace } from "@/lib/team/contract";

import { ALL_WORKSPACES, type CurrentWorkspace, type TeamWorkspaces } from "./workspaceFilter";
import type { WriteResult } from "./workspacesClient";

/*
 * The workspace switcher (docs/design/workspaces.md §13.5 D1, D2, D3, P2, P3):
 * the chip in the rail header and its menu, the phone's sheet rows, and the
 * one «Move to…» menu the rail, the Team page and the workspace page share.
 * Switching only filters; nothing here restricts what anyone sees.
 */

/** What the Viewer hands the rail, the phone's project sheet and the
    Overview once a team install has a workspace. */
export interface WorkspaceRailState {
  view: TeamWorkspaces;
  /** The choice as it applies: `"all"` or an existing workspace's id. */
  chosen: CurrentWorkspace;
  choose: (next: CurrentWorkspace) => void;
  place: (project: string, workspaceId: string | null) => Promise<WriteResult>;
  /** Leaves the board for a team page (the phone's navigation knows how). */
  leave: (path: string) => void;
}

export const WORKSPACE_PATHS = {
  manage: "/team?tab=workspaces",
  create: "/team?tab=workspaces&create=1",
  page: (id: string) => `/team/workspaces/${encodeURIComponent(id)}`,
};

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
/* The engine chip's trigger (`EngineAccountSwitch.tsx`), which fits the rail header's 40 px. */
const CHIP = `flex h-8 min-w-0 max-w-full items-center gap-1 rounded-[7px] border border-border bg-canvas px-2 text-[11px] font-semibold hover:bg-sunken ${FOCUS}`;
const MENU_LABEL = "px-2 pb-1 pt-1.5 text-[11px] font-bold text-muted";

export function WorkspaceDot({ color, size = 8 }: { color: MemberColor; size?: number }) {
  return <span aria-hidden data-workspace-dot={color} className="shrink-0 rounded-full" style={{ width: size, height: size, backgroundColor: MEMBER_COLOR_HEX[color] }} />;
}

export function currentWorkspace(state: Pick<WorkspaceRailState, "view" | "chosen">): Workspace | null {
  return state.chosen === ALL_WORKSPACES ? null : state.view.workspaces.find((workspace) => workspace.id === state.chosen) ?? null;
}

/** The words a refusal gets where the action was taken. */
export function workspaceErrorText(t: TFunction, code: string | null): string {
  switch (code) {
    case "name_required": return t("workspaces.error.nameRequired");
    case "name_too_long": return t("workspaces.error.nameTooLong");
    case "name_taken": return t("workspaces.error.nameTaken");
    case "workspace_gone": return t("workspaces.error.gone");
    case "workspace_not_empty": return t("workspaces.error.notEmpty");
    default: return t("workspaces.error.failed");
  }
}

/** Outside pointer and Escape close a popover; Escape gives focus back to its trigger. */
function useDismiss(open: boolean, refs: ReadonlyArray<RefObject<HTMLElement | null>>, trigger: RefObject<HTMLElement | null>, onClose: () => void): void {
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close.current();
      trigger.current?.focus();
    };
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (refs.some((ref) => ref.current?.contains(target))) return;
      close.current();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open, refs, trigger]);
}

/** The counts the menu shows: how many of the rail's projects each holds. */
export interface WorkspaceCounts {
  all: number;
  byWorkspace: ReadonlyMap<string, number>;
}

/**
 * D1 and D2: the chip that stands where the product name stood, naming the
 * current workspace, and its menu. Everyone can switch; only the owner gets
 * the settings and New workspace rows.
 */
export function WorkspaceChip({ state, counts }: { state: WorkspaceRailState; counts: WorkspaceCounts }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const refs = useMemo(() => [box] as const, []);
  useDismiss(open, refs, trigger, () => setOpen(false));
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>("[aria-checked='true']")?.focus();
  }, [open]);
  const current = currentWorkspace(state);
  const label = current ? current.name : t("workspaces.all");
  const owner = state.view.canManage;
  const choose = (next: CurrentWorkspace) => {
    setOpen(false);
    state.choose(next);
    trigger.current?.focus();
  };
  const row = (key: string, lead: ReactNode, name: string, count: number, checked: boolean, next: CurrentWorkspace) => (
    <button
      key={key}
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      data-workspace-option={next}
      className={BAR_MENU_ROW}
      onClick={() => choose(next)}
    >
      {lead}
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className="shrink-0 text-[11px] font-normal tabular-nums text-muted">{t("mobile2.projects.count", { count })}</span>
      <span className="flex w-3.5 shrink-0 justify-center">{checked ? <Check className="h-3.5 w-3.5 text-accent" aria-hidden /> : null}</span>
    </button>
  );
  const link = (key: string, icon: ReactNode, text: string, href: string) => (
    <a key={key} role="menuitem" href={href} data-workspace-link={key} className={BAR_MENU_ROW} onClick={() => setOpen(false)}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{text}</span>
    </a>
  );
  return (
    <div ref={box} className="relative flex min-w-0">
      <button
        ref={trigger}
        type="button"
        data-workspace-chip=""
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("workspaces.current", { name: label })}
        title={label}
        className={CHIP}
        onClick={() => setOpen((value) => !value)}
      >
        {current ? <WorkspaceDot color={current.color} /> : <Folders className="h-3 w-3 shrink-0 text-muted" aria-hidden />}
        <span data-workspace-chip-label="" className="min-w-0 truncate">{label}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-muted" aria-hidden />
      </button>
      {open ? (
        <div
          ref={menu}
          role="menu"
          aria-label={t("workspaces.heading")}
          data-workspace-menu=""
          className={`absolute left-0 top-9 ${Z.popover} w-[272px] max-w-[calc(100vw-16px)] rounded-[10px] border border-border bg-card p-1 shadow-2`}
        >
          <div className={MENU_LABEL}>{t("workspaces.heading")}</div>
          {row("all", <Folders className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />, t("workspaces.all"), counts.all, !current, ALL_WORKSPACES)}
          {state.view.workspaces.map((workspace) => row(
            workspace.id,
            <span className="flex w-3.5 shrink-0 justify-center"><WorkspaceDot color={workspace.color} /></span>,
            workspace.name,
            counts.byWorkspace.get(workspace.id) ?? 0,
            current?.id === workspace.id,
            workspace.id,
          ))}
          <div className="my-1 h-px bg-border" aria-hidden />
          {owner && current ? link("settings", <SlidersHorizontal className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />, t("workspaces.settings"), WORKSPACE_PATHS.page(current.id)) : null}
          {owner ? link("create", <Plus className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />, t("workspaces.new"), WORKSPACE_PATHS.create) : null}
          {link("manage", <Users className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />, t("workspaces.manage"), WORKSPACE_PATHS.manage)}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A menu hung beside the control that opened it and kept inside the window,
 * drawn in a portal so a scrolling list or the rail's edge never cuts it. The
 * outside pointer and Escape close it; Escape gives focus back to the control.
 */
export function WorkspacePopover({ anchor, label, onClose, testId, width = 236, children }: {
  anchor: RefObject<HTMLElement | null>;
  label: string;
  onClose: () => void;
  testId: string;
  width?: number;
  children: ReactNode;
}) {
  const menu = useRef<HTMLDivElement | null>(null);
  const refs = useMemo(() => [menu, anchor] as const, [anchor]);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  useDismiss(true, refs, anchor, onClose);
  useLayoutEffect(() => {
    const trigger = anchor.current;
    const panel = menu.current;
    if (!trigger || !panel) return;
    const rect = trigger.getBoundingClientRect();
    const margin = 8;
    /* Beside the control when the window has room; under it otherwise. */
    let left = rect.right + 4;
    let top = rect.top;
    if (left + panel.offsetWidth > window.innerWidth - margin) {
      left = Math.max(margin, Math.min(rect.right, window.innerWidth - margin) - panel.offsetWidth);
      top = rect.bottom + 4;
    }
    if (top + panel.offsetHeight > window.innerHeight - margin) top = Math.max(margin, rect.top - panel.offsetHeight - 4);
    setPlace({ left, top });
    panel.querySelector<HTMLElement>("button:not(:disabled), a[href]")?.focus();
  }, [anchor]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={menu}
      role="menu"
      aria-label={label}
      data-workspace-popover={testId}
      className={`fixed ${Z.popover} max-w-[calc(100vw-16px)] rounded-[10px] border border-border bg-card p-1 shadow-2`}
      style={{ width, ...(place ? { left: place.left, top: place.top } : { left: 0, top: 0, visibility: "hidden" }) }}
    >
      {children}
    </div>,
    document.body,
  );
}

/** The one «Move to…» menu (D3, D4): the workspaces a project can go to. */
export function MoveToMenu({ workspaces, exclude = null, anchor, onPick, onClose }: {
  workspaces: readonly Workspace[];
  exclude?: string | null;
  anchor: RefObject<HTMLElement | null>;
  onPick: (workspaceId: string) => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  return (
    <WorkspacePopover anchor={anchor} label={t("workspaces.moveTo")} onClose={onClose} testId="move">
      <div className={MENU_LABEL}>{t("workspaces.moveTo")}</div>
      {workspaces.filter((workspace) => workspace.id !== exclude).map((workspace) => (
        <button
          key={workspace.id}
          type="button"
          role="menuitem"
          data-workspace-move-to={workspace.id}
          className={BAR_MENU_ROW}
          onClick={() => onPick(workspace.id)}
        >
          <span className="flex w-3.5 shrink-0 justify-center"><WorkspaceDot color={workspace.color} /></span>
          <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
        </button>
      ))}
    </WorkspacePopover>
  );
}

export const WORKSPACE_MENU_LABEL = MENU_LABEL;

/** The icon and word of a Move control, so a placeholder can take its exact width. */
export function MoveLabel() {
  const { t } = useLocale();
  return (
    <>
      <ArrowRightLeft className="h-3 w-3 shrink-0" aria-hidden />
      <span>{t("workspaces.move")}</span>
    </>
  );
}

/**
 * P2: the first rows of the phone's project sheet. The current workspace, a
 * tap away from the list of the others; for the owner, the settings of the
 * one chosen and a new one.
 */
export function MobileWorkspaceSwitch({ state, counts, expanded, onToggle }: {
  state: WorkspaceRailState;
  counts: WorkspaceCounts;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useLocale();
  const current = currentWorkspace(state);
  const owner = state.view.canManage;
  const dot = (color: MemberColor) => <span className="flex h-[18px] w-[18px] items-center justify-center"><WorkspaceDot color={color} size={12} /></span>;
  const check = <Check className="h-[18px] w-[18px] text-accent" aria-hidden />;
  return (
    <>
      <MobileSheetRow
        icon={current ? dot(current.color) : <Folders className="h-[18px] w-[18px]" aria-hidden />}
        label={
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{current ? current.name : t("workspaces.all")}</span>
            <span className="text-label font-medium text-muted">{t("workspaces.label")}</span>
          </span>
        }
        attrs={{ "data-mobile2-workspace": expanded ? "open" : "closed" }}
        ariaLabel={t("workspaces.current", { name: current ? current.name : t("workspaces.all") })}
        trailing={expanded ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
        onSelect={onToggle}
      />
      {expanded ? (
        <div data-mobile2-workspace-list="" className="pl-6">
          <MobileSheetRow
            icon={<Folders className="h-[18px] w-[18px]" aria-hidden />}
            label={t("workspaces.all")}
            role="menuitemradio"
            checked={!current}
            attrs={{ "data-mobile2-workspace-option": ALL_WORKSPACES }}
            trailing={<><span>{t("mobile2.projects.count", { count: counts.all })}</span>{!current ? check : null}</>}
            onSelect={() => state.choose(ALL_WORKSPACES)}
          />
          {state.view.workspaces.map((workspace) => (
            <MobileSheetRow
              key={workspace.id}
              icon={dot(workspace.color)}
              label={workspace.name}
              role="menuitemradio"
              checked={current?.id === workspace.id}
              attrs={{ "data-mobile2-workspace-option": workspace.id }}
              trailing={<><span>{t("mobile2.projects.count", { count: counts.byWorkspace.get(workspace.id) ?? 0 })}</span>{current?.id === workspace.id ? check : null}</>}
              onSelect={() => state.choose(workspace.id)}
            />
          ))}
          {owner && current ? (
            <MobileSheetRow icon={<SlidersHorizontal className="h-[18px] w-[18px]" aria-hidden />} label={t("workspaces.settings")} attrs={{ "data-mobile2-workspace-link": "settings" }} onSelect={() => state.leave(WORKSPACE_PATHS.page(current.id))} />
          ) : null}
          {owner ? (
            <MobileSheetRow icon={<Plus className="h-[18px] w-[18px]" aria-hidden />} label={t("workspaces.new")} attrs={{ "data-mobile2-workspace-link": "create" }} onSelect={() => state.leave(WORKSPACE_PATHS.create)} />
          ) : null}
        </div>
      ) : null}
    </>
  );
}
