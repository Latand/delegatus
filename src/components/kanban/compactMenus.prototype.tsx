"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AlignLeft, ArrowDown, ArrowUp, ChevronDown, ChevronLeft, ChevronRight, Copy, EyeOff, Link2, ListPlus, Maximize2, Minus, Pencil, Smile, Workflow } from "lucide-react";

import { useLocale } from "@/lib/i18n";
import { TASK_COLORS } from "@/lib/tasks/types";

import { compactLayout, layoutStates, sectionAt, type CompactLayout, type MenuAction, type MenuEntry, type MenuNode, type MenuSection, type MenuVariant, type MenuWords } from "./compactMenus.prototype.model";
import { CheckGlyph, KanbanMenuList as KanbanMenuToday, popoverLeft, useMenuDismiss, type KanbanMenuProps } from "./kanbanMenus";

/* Design prototype, three numbered layouts of the board's menus
   (docs/design/compact-card-menu.md). The entries, their handlers and their
   labels are the ones the board builds today; only where each one sits
   changes. The evidence fixture installs this as `menuPresenter` under
   `?menus=1|2|3`; nothing in the product does. */

const WORDS: Record<"en" | "uk", Omit<MenuWords, "move" | "priority" | "none"> & { back: string; quick: Record<string, string> }> = {
  en: {
    appearance: "Appearance", more: "More", task: "Task link", closing: "Close or stop", pipelines: "Pipelines", back: "Back",
    quick: { rename: "Rename", describe: "Describe", links: "Attach", hide: "Hide", full: "Full pane", copyLink: "Copy link", link: "To task" },
  },
  uk: {
    appearance: "Вигляд", more: "Ще", task: "Зв’язок із задачею", closing: "Закрити або зупинити", pipelines: "Конвеєри", back: "Назад",
    quick: { rename: "Назва", describe: "Опис", links: "PR, issue", hide: "Сховати", full: "На все вікно", copyLink: "Посилання", link: "До задачі" },
  },
};

const QUICK_ICON: Record<string, ReactNode> = {
  rename: <Pencil aria-hidden />, describe: <AlignLeft aria-hidden />, links: <Link2 aria-hidden />, hide: <EyeOff aria-hidden />,
  full: <Maximize2 aria-hidden />, copyLink: <Copy aria-hidden />, link: <ListPlus aria-hidden />,
};
const PRIORITY_ICON: Record<string, ReactNode> = {
  "priority:high": <ArrowUp aria-hidden />, "priority:normal": <Minus aria-hidden />, "priority:low": <ArrowDown aria-hidden />,
};

/* The board's own tokens and row grammar; what is new is the segmented row,
   the icon cells, the value on a closed row, the back row and the one-row
   picker. No state of a menu is taller than 360 px. */
export const COMPACT_MENU_CSS = `
.kb .menu.cm { width: var(--cm-width); min-width: 0; max-width: calc(100vw - 16px); max-height: min(360px, calc(100vh - 16px)); animation: none; }
.kb .menu.cm .cm-probe { position: absolute; left: 0; right: 0; top: 0; height: 0; overflow: hidden; visibility: hidden; pointer-events: none; padding: 0 6px; }
.kb .menu.cm .lbl { min-width: 0; flex: 1 1 auto; overflow-wrap: anywhere; }
.kb .menu.cm [role^="menuitem"].cm-tall { align-items: flex-start; padding-top: 6px; padding-bottom: 6px; }
.kb .menu.cm .why { white-space: normal; }
.kb .menu.cm .cm-seg { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 2px; padding: 2px; margin: 2px 4px 4px; border-radius: var(--radius-control); background: var(--surface-well); }
.kb .menu.cm .cm-seg [role="menuitemradio"] { flex-direction: column; justify-content: center; gap: 3px; min-height: 40px; padding: 4px 2px; border-radius: calc(var(--radius-control) - 2px); font-size: var(--text-label); font-weight: 600; color: var(--color-secondary, var(--color-primary)); text-align: center; line-height: 1.15; }
.kb .menu.cm .cm-seg.cm-seg-row [role="menuitemradio"] { flex-direction: row; gap: 5px; min-height: 28px; }
.kb .menu.cm .cm-seg [role="menuitemradio"] svg { width: 13px; height: 13px; flex-shrink: 0; }
.kb .menu.cm .cm-seg [role="menuitemradio"][aria-checked="true"] { background: var(--surface-raised); color: var(--color-primary); box-shadow: var(--shadow-1); }
.kb .menu.cm .cm-seg [role="menuitemradio"]:hover, .kb .menu.cm .cm-seg [role="menuitemradio"]:focus-visible { background: var(--surface-raised); }
.kb .menu.cm .cm-seg [role="menuitemradio"]:focus-visible { box-shadow: 0 0 0 2px var(--color-accent); }
.kb .menu.cm .cm-seg .cm-cap { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb .menu.cm .cm-quick { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 2px; margin: 0 4px; }
.kb .menu.cm .cm-quick [role="menuitem"] { flex-direction: column; justify-content: center; gap: 4px; min-height: 48px; padding: 6px 2px 5px; font-size: var(--text-caption); font-weight: 600; color: var(--color-secondary, var(--color-primary)); text-align: center; line-height: 1.15; }
.kb .menu.cm .cm-quick [role="menuitem"] svg { width: 16px; height: 16px; flex-shrink: 0; color: var(--color-primary); }
.kb .menu.cm .cm-quick [role="menuitem"][aria-disabled="true"] svg { color: var(--color-muted); }
.kb .menu.cm .cm-quick .cm-cap { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb .menu.cm .cm-note { margin: 2px 10px 0; font-size: var(--text-caption); line-height: 1.3; color: var(--color-muted); }
.kb .menu.cm .cm-val { margin-left: auto; flex: 0 1 auto; min-width: 0; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-label); color: var(--color-muted); }
.kb .menu.cm .cm-val + .cm-chev { margin-left: 0; }
.kb .menu.cm .cm-chev { margin-left: auto; width: 14px; height: 14px; flex-shrink: 0; color: var(--color-muted); }
.kb .menu.cm .cm-lane { width: 15px; height: 15px; flex-shrink: 0; color: var(--color-muted); }
.kb .menu.cm .cm-tall .cm-lane, .kb .menu.cm .cm-tall .cm-chev { margin-top: 2px; }
.kb .menu.cm .cm-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; background: var(--c, transparent); border: 1px solid var(--border-strong); }
.kb .menu.cm .cm-dot[data-set="1"] { border-color: transparent; }
.kb .menu.cm .cm-body { padding: 0 0 4px 10px; margin: 0 0 2px 10px; border-left: 1px solid var(--border-default); }
.kb .menu.cm .cm-body .swatches, .kb .menu.cm .cm-page .swatches { grid-template-columns: repeat(9, 22px); gap: 5px; padding: 6px 4px 8px; }
.kb .menu.cm .cm-body .swatch, .kb .menu.cm .cm-page .swatch { width: 22px; height: 22px; }
.kb .menu.cm .cm-inline { display: flex; align-items: center; gap: 6px; min-height: 32px; padding: 0 6px 0 10px; }
.kb .menu.cm .cm-inline .swatches { display: grid; grid-template-columns: repeat(9, 20px); gap: 5px; padding: 0; flex: 1 1 auto; }
.kb .menu.cm .cm-inline .swatch { width: 20px; height: 20px; min-height: 0; }
.kb .menu.cm .cm-inline .cm-icon { width: 28px; min-height: 28px; padding: 0; justify-content: center; flex: 0 0 auto; }
.kb .menu.cm .cm-inline .cm-icon svg { width: 16px; height: 16px; }
.kb .menu.cm .cm-back { font-weight: 600; align-items: flex-start; min-height: 30px; padding-top: 6px; padding-bottom: 6px; border-bottom: 1px solid var(--border-default); border-radius: var(--radius-control) var(--radius-control) 0 0; margin-bottom: 3px; }
.kb .menu.cm .cm-back svg { width: 14px; height: 14px; flex-shrink: 0; margin-top: 2px; color: var(--color-muted); }
.kb .menu.cm .cm-back .cm-title { min-width: 0; overflow-wrap: anywhere; line-height: 1.3; }
/* A page is the densest state: its rows sit closer so a pipeline's seven actions keep their second lines inside 360 px. */
.kb .menu.cm .cm-page [role^="menuitem"]:not(.cm-back) { min-height: 28px; }
.kb .menu.cm .cm-page [role^="menuitem"].cm-tall { padding-top: 2px; padding-bottom: 2px; }
.kb .menu.cm .cm-page .sep { margin: 2px 4px; }
.kb .menu.cm .cm-page .why { line-height: 1.25; }
`;

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
function SectionRow({ section, opens, expanded, value, onOpen }: { section: MenuSection; opens: "expand" | "drill"; expanded: boolean; value: ReactNode; onOpen: () => void }) {
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
      {opens === "expand" && expanded ? <ChevronDown className="cm-chev" aria-hidden /> : <ChevronRight className="cm-chev" aria-hidden />}
    </button>
  );
}

interface ViewProps { layout: CompactLayout; path: readonly string[]; words: (typeof WORDS)["en"]; onPick: (action: MenuAction) => void; onClose: (refocus: boolean) => void; onPath: (path: string[]) => void }

/** One state of a menu: the resting list with at most one section opened in place, or the page a path of sections leads to. */
function MenuView({ layout, path, words, onPick, onClose, onPath }: ViewProps) {
  const top = layout.nodes.find((node) => node.node === "section" && node.section.id === path[0]);
  const page = top?.node === "section" && top.open === "drill" ? sectionAt(layout, path) : null;
  const entries = (list: MenuEntry[], hints: boolean, at: readonly string[]) => list.map((entry, index) => {
    if (entry.type === "sep") return <div key={`sep-${index}`} className="sep" role="separator" />;
    if (entry.type === "swatches") return <Swatches key="swatches" entry={entry} onClose={onClose} />;
    if (entry.type === "section") return <SectionRow key={entry.section.id} section={entry.section} opens="drill" expanded={false} value={null} onOpen={() => onPath([...at, entry.section.id])} />;
    return <Row key={`${index}-${entry.label}`} action={entry} hint={hints} onPick={onPick} />;
  });
  if (page) {
    return (
      <div className="cm-page" role="group" aria-label={page.title} data-cm-page={page.id}>
        <button type="button" role="menuitem" className="cm-back" aria-label={`${words.back}: ${page.title}`} data-cm-back="" onClick={() => onPath(path.slice(0, -1))}>
          <ChevronLeft aria-hidden />
          <span className="cm-title">{page.title}</span>
        </button>
        {entries(page.entries, page.hints, path)}
      </div>
    );
  }
  const swatch = layout.nodes.flatMap((node) => (node.node === "section" || node.node === "inline" ? node.section.entries : [])).find((entry) => entry.type === "swatches");
  const value = (section: MenuSection) => {
    if (section.id === "appearance" && swatch?.type === "swatches") {
      return <span className="cm-val" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span className="cm-dot" data-set={swatch.value ? "1" : undefined} style={swatch.value ? ({ "--c": swatch.hex[swatch.value] } as React.CSSProperties) : undefined} />{section.value}</span>;
    }
    return section.value ? <span className="cm-val">{section.value}</span> : null;
  };
  const node = (entry: MenuNode, index: number) => {
    if (entry.node === "sep") return <div key={`sep-${index}`} className="sep" role="separator" />;
    if (entry.node === "row") return <Row key={`row-${index}`} action={entry.action} hint={entry.hint} onPick={onPick} />;
    if (entry.node === "segments") {
      return (
        <div key={entry.id} className={`cm-seg${entry.id === "priority" ? " cm-seg-row" : ""}`} role="group" aria-label={entry.label} data-cm-segments={entry.id}>
          {entry.options.map((option) => (
            <button key={option.id} type="button" role="menuitemradio" aria-checked={Boolean(option.checked)} title={option.why ?? option.label} data-cm-item={option.id ?? ""} onClick={() => onPick(option)}>
              {option.status ? <span className="st" data-status={option.status} /> : PRIORITY_ICON[option.id ?? ""] ?? null}
              <span className="cm-cap">{option.label}</span>
            </button>
          ))}
        </div>
      );
    }
    if (entry.node === "quick") {
      const caption = (action: MenuAction) => words.quick[action.id ?? ""] ?? action.label;
      return (
        <div key={`quick-${index}`} role="none">
          <div className="cm-quick" role="group" data-cm-quick="">
            {entry.actions.map((action) => (
              <button key={action.id} type="button" role="menuitem" aria-label={action.label} aria-disabled={action.disabled ? true : undefined} title={[action.label, action.kbd ? `(${action.kbd})` : null, action.why ? `· ${action.why}` : null].filter(Boolean).join(" ")} data-cm-item={action.id ?? ""} onClick={() => onPick(action)}>
                {QUICK_ICON[action.id ?? ""] ?? null}
                <span className="cm-cap">{caption(action)}</span>
              </button>
            ))}
          </div>
          {/* A cell that cannot be used says why in words: a tooltip does not exist under a finger. */}
          {entry.actions.filter((action) => action.disabled && action.why).map((action) => (
            <p key={action.id} className="cm-note" data-cm-note={action.id ?? ""}>{caption(action)}: {action.why}</p>
          ))}
        </div>
      );
    }
    if (entry.node === "inline") {
      return (
        <div key={entry.section.id} className="cm-inline" role="group" aria-label={entry.section.title} data-cm-inline={entry.section.id}>
          {entry.section.entries.map((item) => {
            if (item.type === "swatches") return <Swatches key="swatches" entry={item} onClose={onClose} />;
            if (item.type === "sep" || item.type === "section") return null;
            return (
              <button key={item.id} type="button" role="menuitem" className="cm-icon" aria-label={item.label} title={item.label} aria-disabled={item.disabled ? true : undefined} data-cm-item={item.id ?? ""} onClick={() => onPick(item)}>
                <Smile aria-hidden />
              </button>
            );
          })}
        </div>
      );
    }
    const section = entry.section;
    const expanded = entry.open === "expand" && path[0] === section.id;
    return (
      <div key={section.id} role="none">
        <SectionRow section={section} opens={entry.open} expanded={expanded} value={value(section)} onOpen={() => onPath(expanded ? [] : [section.id])} />
        {expanded ? <div className="cm-body" role="group" aria-label={section.title} data-cm-body={section.id}>{entries(section.entries, section.hints, [section.id])}</div> : null}
      </div>
    );
  };
  return <>{layout.nodes.map(node)}</>;
}

function CompactMenu({ variant, layout, anchor, label, onClose }: { variant: MenuVariant; layout: CompactLayout } & Pick<KanbanMenuProps, "anchor" | "label" | "onClose">) {
  const { locale } = useLocale();
  const words = WORDS[locale === "uk" ? "uk" : "en"];
  const ref = useRef<HTMLDivElement>(null);
  /* The sections opened to reach what is shown; empty at rest. */
  const [path, setPath] = useState<string[]>([]);
  /* Placed once, for its tallest state: opening a section never moves the
     menu's top edge or its side, so the row under the pointer stays there.
     Every state is laid out unseen on the first pass to learn that height. */
  const [placed, setPlaced] = useState(false);
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
    const rect = anchor.getBoundingClientRect();
    const room = window.innerHeight - 8;
    let top = rect.bottom + 6;
    /* No room below for the tallest state: above the anchor, and low enough to grow down into. */
    if (top + tallest > room) top = Math.min(rect.top - rest - 6, room - tallest);
    menu.style.left = `${Math.round(popoverLeft(rect, menu.offsetWidth, window.innerWidth))}px`;
    menu.style.top = `${Math.round(Math.max(8, top))}px`;
    menu.dataset.cmTallest = String(Math.round(tallest));
    /* The unseen states are dropped before the first paint. */
    setPlaced(true);
  }, [anchor]);
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
    const list = [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])].filter((item) => item.getAttribute("aria-disabled") !== "true");
    const index = list.indexOf(document.activeElement as HTMLElement);
    const active = document.activeElement as HTMLElement | null;
    const inRow = Boolean(active?.closest(".cm-seg, .cm-quick, .swatches"));
    const paged = Boolean(ref.current?.querySelector(".cm-page"));
    if (paged && (event.key === "Backspace" || (event.key === "ArrowLeft" && !inRow))) { event.preventDefault(); setPath(path.slice(0, -1)); return; }
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
      data-cm-variant={variant}
      data-cm-view={path.length ? path.join("/") : "rest"}
      style={{ "--cm-width": `${layout.width}px` } as React.CSSProperties}
      onKeyDown={onKeyDown}
    >
      <style>{COMPACT_MENU_CSS}</style>
      <div data-cm-shown="" role="none"><MenuView layout={layout} path={path} words={words} onPick={pick} onClose={onClose} onPath={setPath} /></div>
      {placed ? null : (
        <div className="cm-probe" aria-hidden inert>
          {states.filter((state) => state.length).map((state) => (
            <div key={state.join("/")} data-cm-probe={state.join("/")}><MenuView layout={layout} path={state} words={words} onPick={noop} onClose={noop} onPath={noop} /></div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The presenter for one numbered layout; `undefined` leaves a menu as it is. */
export function compactMenuPresenter(variant: MenuVariant) {
  return function CompactMenuPresenter(props: KanbanMenuProps): ReactNode | undefined {
    return <CompactMenuGate variant={variant} {...props} />;
  };
}

function CompactMenuGate({ variant, ...props }: KanbanMenuProps & { variant: MenuVariant }) {
  const { t, locale } = useLocale();
  const local = WORDS[locale === "uk" ? "uk" : "en"];
  const words: MenuWords = { appearance: local.appearance, more: local.more, task: local.task, closing: local.closing, pipelines: local.pipelines, move: t("kanban.moveTo"), priority: t("kanban.priority"), none: t("kanban.color.none") };
  const layout = compactLayout(props.kind, props.items, variant, words);
  if (!layout) return <KanbanMenuToday {...props} />;
  return <CompactMenu variant={variant} layout={layout} anchor={props.anchor} label={props.label} onClose={props.onClose} />;
}
