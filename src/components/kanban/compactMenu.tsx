"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AlignLeft, ArrowDown, ArrowUp, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, EyeOff, Link2, ListPlus, Maximize2, Minus, Pencil, Workflow } from "lucide-react";

import { useSwapGuard } from "@/components/menuSwapGuard";
import { useLocale } from "@/lib/i18n";
import { TASK_COLORS } from "@/lib/tasks/types";

import { compactLayout, layoutStates, menuPlacement, sectionAt, type CompactLayout, type MenuAction, type MenuEntry, type MenuNode, type MenuSection, type MenuSide } from "./compactMenuModel";
import { CheckGlyph, KanbanMenu, useMenuDismiss, type KanbanMenuProps } from "./kanbanMenus";

/* The card's, a column's and a conversation's ⋯ (docs/design/compact-card-menu.md):
   the columns and the priorities as segmented rows, the frequent actions as
   icon cells, and named rows that open in place or as a page. The entries,
   their handlers and their labels are the ones the board builds; this decides
   where each one sits. No state of a menu is taller than 360 px. */

type Translate = ReturnType<typeof useLocale>["t"];

/* The caption under an icon cell: the short form of the entry's own label. */
const CELL_CAPTION = {
  rename: "kanban.menu.cell.rename", describe: "kanban.menu.cell.describe", links: "kanban.menu.cell.links", hide: "kanban.menu.cell.hide",
  full: "kanban.menu.cell.full", copyLink: "kanban.menu.cell.copyLink", link: "kanban.menu.cell.link",
} as const;
const CELL_ICON: Record<string, ReactNode> = {
  rename: <Pencil aria-hidden />, describe: <AlignLeft aria-hidden />, links: <Link2 aria-hidden />, hide: <EyeOff aria-hidden />,
  full: <Maximize2 aria-hidden />, copyLink: <Copy aria-hidden />, link: <ListPlus aria-hidden />,
};
const PRIORITY_ICON: Record<string, ReactNode> = {
  "priority:high": <ArrowUp aria-hidden />, "priority:normal": <Minus aria-hidden />, "priority:low": <ArrowDown aria-hidden />,
};
/* A key drawn in a cell's corner; Enter is its sign there. */
const keySign = (kbd: string) => (kbd === "Enter" ? "↵" : kbd);

function Row({ action, hint, onPick }: { action: MenuAction; hint: boolean; onPick: (action: MenuAction) => void }) {
  const lines = hint && (action.why || action.warn);
  return (
    <button
      type="button"
      className={lines ? "cm-tall" : undefined}
      role={action.type === "radio" ? "menuitemradio" : action.type === "check" ? "menuitemcheckbox" : "menuitem"}
      aria-checked={action.type === "radio" || action.type === "check" ? Boolean(action.checked) : undefined}
      aria-disabled={action.disabled ? true : undefined}
      title={hint ? undefined : action.why ?? undefined}
      data-cm-item={action.id ?? ""}
      onClick={() => onPick(action)}
    >
      {action.icon ?? null}
      {action.status ? <span className="st" data-status={action.status} /> : null}
      {action.type === "radio" || action.type === "check" ? <CheckGlyph /> : null}
      <span className="lbl">
        {action.label}
        {hint && action.why ? <span className="why">{action.why}</span> : null}
        {/* What a choice waits on is never folded into a tooltip. */}
        {action.warn ? <span className="why warn">{action.warn}</span> : null}
      </span>
      {action.kbd ? <span className="kbd">{action.kbd}</span> : null}
    </button>
  );
}

function Swatches({ entry, onClose }: { entry: Extract<MenuEntry, { type: "swatches" }>; onClose: (refocus: boolean) => void }) {
  return (
    <div className="swatches" role="group" aria-label={entry.label}>
      {[null, ...TASK_COLORS].map((color) => (
        <button
          key={color ?? "none"}
          type="button"
          className="swatch"
          role="menuitemradio"
          aria-checked={entry.value === color}
          aria-label={entry.names(color)}
          title={entry.names(color)}
          data-swatch={color ?? "none"}
          data-none={color ? undefined : "1"}
          data-cm-item={`colour:${color ?? "none"}`}
          style={color ? ({ "--c": entry.hex[color] } as React.CSSProperties) : undefined}
          onClick={() => { onClose(true); entry.onPick(color); }}
        />
      ))}
    </div>
  );
}

/** The row that opens a section. A pipeline's carries the pipeline mark, its whole title and its state. */
function SectionRow({ section, opens, expanded, value, onOpen }: { section: MenuSection; opens: "expand" | "drill"; expanded: boolean; value: ReactNode; onOpen: (event: React.MouseEvent) => void }) {
  const lane = section.lane && section.value;
  return (
    <button
      type="button"
      role="menuitem"
      className={lane ? "cm-tall" : undefined}
      aria-haspopup={opens === "drill" ? "menu" : undefined}
      aria-expanded={opens === "expand" ? expanded : undefined}
      data-cm-section={section.id}
      data-cm-opens={opens}
      onClick={onOpen}
    >
      {lane ? <Workflow className="cm-lane" aria-hidden /> : null}
      <span className="lbl">
        {section.title}
        {lane ? <span className="why">{section.value}</span> : null}
      </span>
      {lane ? null : value}
      {/* A page is the arrow to the right. A section that opens in place puts its rows under its own row: the arrow points down, and up only once they are there. */}
      {opens === "drill" ? <ChevronRight className="cm-chev" aria-hidden /> : expanded ? <ChevronUp className="cm-chev" aria-hidden /> : <ChevronDown className="cm-chev" aria-hidden />}
    </button>
  );
}

interface ViewProps {
  layout: CompactLayout; path: readonly string[]; t: Translate;
  onPick: (action: MenuAction) => void; onClose: (refocus: boolean) => void;
  /** `swap` carries the press that replaced the whole list. */
  onPath: (path: string[], swap?: React.MouseEvent) => void;
}

/** One state of a menu: the resting list with at most one section opened in place, or the page a path of sections leads to. */
function MenuView({ layout, path, t, onPick, onClose, onPath }: ViewProps) {
  const top = layout.nodes.find((node) => node.node === "section" && node.section.id === path[0]);
  const page = top?.node === "section" && top.open === "drill" ? sectionAt(layout, path) : null;
  const entries = (list: MenuEntry[], hints: boolean, at: readonly string[]) => list.map((entry, index) => {
    if (entry.type === "sep") return <div key={`sep-${index}`} className="sep" role="separator" />;
    if (entry.type === "swatches") return <Swatches key="swatches" entry={entry} onClose={onClose} />;
    if (entry.type === "section") return <SectionRow key={entry.section.id} section={entry.section} opens="drill" expanded={false} value={null} onOpen={(event) => onPath([...at, entry.section.id], event)} />;
    return <Row key={`${index}-${entry.label}`} action={entry} hint={hints} onPick={onPick} />;
  });
  if (page) {
    return (
      <div className="cm-page" role="group" aria-label={page.title} data-cm-page={page.id}>
        <button type="button" role="menuitem" className="cm-back" aria-label={`${t("kanban.menu.back")}: ${page.title}`} data-cm-back="" onClick={(event) => onPath(path.slice(0, -1), event)}>
          <ChevronLeft aria-hidden />
          <span className="cm-title">{page.title}</span>
        </button>
        {entries(page.entries, page.hints, path)}
      </div>
    );
  }
  const swatch = layout.nodes.flatMap((node) => (node.node === "section" ? node.section.entries : [])).find((entry) => entry.type === "swatches");
  const value = (section: MenuSection) => {
    if (section.id === "appearance" && swatch?.type === "swatches") {
      return <span className="cm-val cm-colour"><span className="cm-dot" data-set={swatch.value ? "1" : undefined} style={swatch.value ? ({ "--c": swatch.hex[swatch.value] } as React.CSSProperties) : undefined} />{section.value}</span>;
    }
    return section.value ? <span className="cm-val">{section.value}</span> : null;
  };
  const node = (entry: MenuNode, index: number) => {
    if (entry.node === "sep") return <div key={`sep-${index}`} className="sep" role="separator" />;
    if (entry.node === "row") return <Row key={`row-${index}`} action={entry.action} hint={entry.hint} onPick={onPick} />;
    if (entry.node === "segments") {
      const hinted = entry.options.filter((option) => option.why);
      return (
        <div key={entry.id} role="none">
          <div className={`cm-seg${entry.id === "priority" ? " cm-seg-row" : ""}`} role="group" aria-label={entry.label} data-cm-segments={entry.id}>
            {entry.options.map((option) => (
              <button key={option.id} type="button" role="menuitemradio" aria-checked={Boolean(option.checked)} title={option.why ?? option.label} data-cm-item={option.id ?? ""} onClick={() => onPick(option)}>
                {option.status ? <span className="st" data-status={option.status} /> : PRIORITY_ICON[option.id ?? ""] ?? null}
                <span className="cm-cap">{option.label}</span>
              </button>
            ))}
          </div>
          {/* What the ends of the row do, in words under them: a tooltip does not exist under a finger. */}
          {hinted.length ? (
            <p className="cm-ends" aria-hidden data-cm-ends={entry.id}>
              {hinted.map((option) => <span key={option.id} data-cm-end={option.id ?? ""}>{option.why}</span>)}
            </p>
          ) : null}
        </div>
      );
    }
    if (entry.node === "quick") {
      const caption = (action: MenuAction) => (action.id && action.id in CELL_CAPTION ? t(CELL_CAPTION[action.id as keyof typeof CELL_CAPTION]) : action.label);
      /* What a cell does beyond its name, and why it cannot be used, in words under the cells. */
      const noted = entry.actions.flatMap((action) => {
        const text = action.disabled ? action.why : action.note;
        return text ? [{ action, text }] : [];
      });
      return (
        <div key={`quick-${index}`} role="none">
          <div className="cm-quick" role="group" data-cm-quick="">
            {entry.actions.map((action) => (
              <button key={action.id} type="button" role="menuitem" aria-label={action.label} aria-keyshortcuts={action.kbd ?? undefined} aria-disabled={action.disabled ? true : undefined} title={[action.label, action.kbd ? `(${action.kbd})` : null, action.why ? `· ${action.why}` : null].filter(Boolean).join(" ")} data-cm-item={action.id ?? ""} onClick={() => onPick(action)}>
                {CELL_ICON[action.id ?? ""] ?? null}
                <span className="cm-cap">{caption(action)}</span>
                {action.kbd ? <span className="cm-key" aria-hidden>{keySign(action.kbd)}</span> : null}
              </button>
            ))}
          </div>
          {noted.map(({ action, text }) => (
            <p key={action.id} className="cm-note" data-cm-note={action.id ?? ""}>{caption(action)}: {text}</p>
          ))}
        </div>
      );
    }
    const section = entry.section;
    const expanded = entry.open === "expand" && path[0] === section.id;
    return (
      <div key={section.id} role="none">
        <SectionRow section={section} opens={entry.open} expanded={expanded} value={value(section)} onOpen={(event) => onPath(expanded ? [] : [section.id], entry.open === "drill" ? event : undefined)} />
        {expanded ? <div className="cm-body" role="group" aria-label={section.title} data-cm-body={section.id}>{entries(section.entries, section.hints, [section.id])}</div> : null}
      </div>
    );
  };
  return <>{layout.nodes.map(node)}</>;
}

function CompactMenu({ layout, anchor, label, onClose }: { layout: CompactLayout } & Pick<KanbanMenuProps, "anchor" | "label" | "onClose">) {
  const { t } = useLocale();
  const ref = useRef<HTMLDivElement>(null);
  /* The sections opened to reach what is shown; empty at rest. */
  const [path, setPath] = useState<string[]>([]);
  /* Placed once, for its tallest state, and hung from its top edge: opening a
     section never moves the menu, so the row that was pressed stays under the
     pointer, its rows appear under it and no state covers the button. Every
     state is laid out unseen on the first pass to learn that height. */
  const [placed, setPlaced] = useState<MenuSide | null>(null);
  const swapped = useSwapGuard();
  useMenuDismiss(ref, anchor, onClose);
  const states = layoutStates(layout);
  const noop = () => {};
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const view = menu.querySelector<HTMLElement>("[data-cm-shown]");
    const rest = menu.offsetHeight;
    const chrome = rest - (view?.offsetHeight ?? rest);
    const cap = parseFloat(getComputedStyle(menu).maxHeight) || window.innerHeight - 16;
    const probes = [...menu.querySelectorAll<HTMLElement>("[data-cm-probe]")].map((probe) => probe.offsetHeight + chrome);
    const tallest = Math.min(cap, Math.max(rest, ...probes));
    const spot = menuPlacement(anchor.getBoundingClientRect(), menu.offsetWidth, tallest, { width: window.innerWidth, height: window.innerHeight });
    menu.style.left = `${Math.round(spot.left)}px`;
    menu.style.top = `${Math.round(spot.top)}px`;
    /* The unseen states are dropped before the first paint. */
    setPlaced(spot.side);
  }, [anchor]);
  const go = (next: string[], swap?: React.MouseEvent) => {
    swapped(swap);
    setPath(next);
  };
  const from = useRef<string[]>([]);
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu || !placed) return;
    const row = (id: string | undefined) => (id ? menu.querySelector<HTMLElement>(`[data-cm-section="${CSS.escape(id)}"]`) : null);
    /* Into a page: its first entry. Back out: the row that led there. Opened in place: the row itself. */
    const left = from.current.length > path.length ? row(from.current[path.length]) : null;
    const first = menu.querySelector<HTMLElement>('.cm-page [role^="menuitem"]:not([aria-disabled="true"]):not(.cm-back)');
    (left ?? first ?? row(path[0]) ?? menu.querySelector<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])'))?.focus();
    from.current = path;
  }, [path, placed]);
  const pick = (action: MenuAction) => {
    if (action.disabled) return;
    onClose(!action.keepFocus);
    action.onSelect();
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    const list = [...(ref.current?.querySelectorAll<HTMLElement>('[data-cm-shown] [role^="menuitem"]') ?? [])].filter((item) => item.getAttribute("aria-disabled") !== "true");
    const index = list.indexOf(document.activeElement as HTMLElement);
    const active = document.activeElement as HTMLElement | null;
    const inRow = Boolean(active?.closest(".cm-seg, .cm-quick, .swatches"));
    const paged = Boolean(ref.current?.querySelector(".cm-page"));
    if (paged && (event.key === "Backspace" || (event.key === "ArrowLeft" && !inRow))) { event.preventDefault(); go(path.slice(0, -1)); return; }
    if (event.key === "ArrowRight" && active?.dataset.cmOpens === "drill") { event.preventDefault(); active.click(); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowRight") { event.preventDefault(); list[(index + 1) % list.length]?.focus(); }
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") { event.preventDefault(); list[(index - 1 + list.length) % list.length]?.focus(); }
    else if (event.key === "Home") { event.preventDefault(); list[0]?.focus(); }
    else if (event.key === "End") { event.preventDefault(); list[list.length - 1]?.focus(); }
    else if (event.key === "Tab") { event.preventDefault(); onClose(true); }
  };
  return (
    <div
      ref={ref}
      className="menu cm"
      role="menu"
      aria-label={label}
      data-cm-view={path.length ? path.join("/") : "rest"}
      data-cm-side={placed ?? undefined}
      style={{ "--cm-width": `${layout.width}px` } as React.CSSProperties}
      onKeyDown={onKeyDown}
    >
      <div data-cm-shown="" role="none"><MenuView layout={layout} path={path} t={t} onPick={pick} onClose={onClose} onPath={go} /></div>
      {placed ? null : (
        <div className="cm-probe" aria-hidden inert>
          {states.filter((state) => state.length).map((state) => (
            <div key={state.join("/")} data-cm-probe={state.join("/")}><MenuView layout={layout} path={state} t={t} onPick={noop} onClose={noop} onPath={noop} /></div>
          ))}
        </div>
      )}
    </div>
  );
}

/** One of the board's menus: the compact layout for a card, a column and a
    conversation, the plain list for every other kind. */
export function BoardMenu(props: KanbanMenuProps) {
  const { t } = useLocale();
  const layout = compactLayout(props.kind, props.items, {
    appearance: t("kanban.menu.appearance"), more: t("kanban.menu.more"), pipelines: t("kanban.menu.pipelines"), move: t("kanban.moveTo"), priority: t("kanban.priority"),
  });
  if (!layout) return <KanbanMenu {...props} />;
  return <CompactMenu layout={layout} anchor={props.anchor} label={props.label} onClose={props.onClose} />;
}
