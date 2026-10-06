"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AlignLeft, ArrowDown, ArrowUp, ChevronDown, ChevronLeft, ChevronRight, Copy, EyeOff, Link2, ListPlus, Maximize2, Minus, Pencil, X } from "lucide-react";

import { useLocale } from "@/lib/i18n";
import { TASK_COLORS } from "@/lib/tasks/types";

import { compactLayout, type CompactLayout, type MenuAction, type MenuEntry, type MenuNode, type MenuSection, type MenuVariant, type MenuWords } from "./compactMenus.prototype.model";
import { CheckGlyph, KanbanMenuList as KanbanMenuToday, placeMenu, useMenuDismiss, type KanbanMenuProps } from "./kanbanMenus";

/* Design prototype, three numbered layouts of the board's menus
   (docs/design/compact-card-menu.md). The entries, their handlers and their
   labels are the ones the board builds today; only where each one sits
   changes. The evidence fixture installs this as `menuPresenter` under
   `?menus=1|2|3`; nothing in the product does. */

const WORDS: Record<"en" | "uk", Omit<MenuWords, "move" | "priority" | "none"> & { back: string; quick: Record<string, string> }> = {
  en: {
    appearance: "Appearance", more: "More", task: "Task link", closing: "Close or stop", back: "Back",
    quick: { rename: "Rename", describe: "Describe", links: "Attach", hide: "Hide", full: "Full pane", copyLink: "Copy link", link: "To task", closeOnBoard: "Close" },
  },
  uk: {
    appearance: "Вигляд", more: "Ще", task: "Зв’язок із задачею", closing: "Закрити або зупинити", back: "Назад",
    quick: { rename: "Назва", describe: "Опис", links: "PR, issue", hide: "Сховати", full: "На все вікно", copyLink: "Посилання", link: "До задачі", closeOnBoard: "Закрити" },
  },
};

const QUICK_ICON: Record<string, ReactNode> = {
  rename: <Pencil aria-hidden />, describe: <AlignLeft aria-hidden />, links: <Link2 aria-hidden />, hide: <EyeOff aria-hidden />,
  full: <Maximize2 aria-hidden />, copyLink: <Copy aria-hidden />, link: <ListPlus aria-hidden />, closeOnBoard: <X aria-hidden />,
};
const PRIORITY_ICON: Record<string, ReactNode> = {
  "priority:high": <ArrowUp aria-hidden />, "priority:normal": <Minus aria-hidden />, "priority:low": <ArrowDown aria-hidden />,
};

/* The board's own tokens and row grammar; what is new is the segmented row,
   the icon cells, the value on a closed row and the back row. */
export const COMPACT_MENU_CSS = `
.kb .menu.cm { width: var(--cm-width); min-width: 0; max-width: calc(100vw - 16px); }
.kb .menu.cm .lbl { min-width: 0; flex: 1 1 auto; overflow-wrap: anywhere; }
.kb .menu.cm [role^="menuitem"].cm-tall { align-items: flex-start; padding-top: 6px; padding-bottom: 6px; }
.kb .menu.cm .why { white-space: normal; }
.kb .menu.cm .cm-seg { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 2px; padding: 2px; margin: 2px 4px 4px; border-radius: var(--radius-control); background: var(--surface-well); }
.kb .menu.cm .cm-seg [role="menuitemradio"] { flex-direction: column; justify-content: center; gap: 3px; min-height: 40px; padding: 4px 2px; border-radius: calc(var(--radius-control) - 2px); font-size: var(--text-label); font-weight: 600; color: var(--color-secondary, var(--color-primary)); text-align: center; line-height: 1.15; }
.kb .menu.cm .cm-seg.cm-seg-row [role="menuitemradio"] { flex-direction: row; gap: 5px; min-height: 30px; }
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
.kb .menu.cm .cm-val { margin-left: auto; flex: 0 1 auto; min-width: 0; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-label); color: var(--color-muted); }
.kb .menu.cm .cm-val + .cm-chev { margin-left: 0; }
.kb .menu.cm .cm-chev { margin-left: auto; width: 14px; height: 14px; flex-shrink: 0; color: var(--color-muted); }
.kb .menu.cm .cm-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; background: var(--c, transparent); border: 1px solid var(--border-strong); }
.kb .menu.cm .cm-dot[data-set="1"] { border-color: transparent; }
.kb .menu.cm .cm-body { padding: 0 0 4px 10px; margin: 0 0 2px 10px; border-left: 1px solid var(--border-default); }
.kb .menu.cm .cm-body .swatches, .kb .menu.cm .cm-page .swatches { grid-template-columns: repeat(9, 22px); gap: 5px; padding: 6px 4px 8px; }
.kb .menu.cm .cm-body .swatch, .kb .menu.cm .cm-page .swatch { width: 22px; height: 22px; }
.kb .menu.cm .cm-back { font-weight: 600; }
.kb .menu.cm .cm-back svg { width: 14px; height: 14px; flex-shrink: 0; color: var(--color-muted); }
.kb .menu.cm .cm-back .cm-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb .menu.cm[data-cm-variant="2"] { max-height: min(360px, calc(100vh - 16px)); }
.kb .menu.cm[data-cm-variant="2"] .cm-page [role^="menuitem"].cm-tall { padding-top: 3px; padding-bottom: 3px; }
.kb .menu.cm[data-cm-variant="2"] .cm-page .sep { margin: 3px 4px; }
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

function Entries({ entries, hints, onPick, onClose }: { entries: MenuEntry[]; hints: boolean; onPick: (action: MenuAction) => void; onClose: (refocus: boolean) => void }) {
  return (
    <>
      {entries.map((entry, index) => {
        if (entry.type === "sep") return <div key={`sep-${index}`} className="sep" role="separator" />;
        if (entry.type === "swatches") {
          return (
            <div key="swatches" className="swatches" role="group" aria-label={entry.label}>
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
        return <Row key={`${index}-${entry.label}`} action={entry} hint={hints} onPick={onPick} />;
      })}
    </>
  );
}

function CompactMenu({ variant, layout, anchor, label, onClose }: { variant: MenuVariant; layout: CompactLayout } & Pick<KanbanMenuProps, "anchor" | "label" | "onClose">) {
  const { locale } = useLocale();
  const words = WORDS[locale === "uk" ? "uk" : "en"];
  const ref = useRef<HTMLDivElement>(null);
  /* The one section that is open: expanded in place, or drilled into. */
  const [open, setOpen] = useState<string | null>(null);
  useMenuDismiss(ref, anchor, onClose);
  const sections = layout.nodes.flatMap((node) => (node.node === "section" ? [node] : []));
  const drilled = sections.find((node) => node.open === "drill" && node.section.id === open) ?? null;
  const swatch = layout.nodes.flatMap((node) => (node.node === "section" ? node.section.entries : [])).find((entry) => entry.type === "swatches");
  const from = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!ref.current) return;
    placeMenu(ref.current, anchor);
    /* Into a page: its first entry. Back out: the row that led there. */
    const back = from.current && !drilled ? ref.current.querySelector<HTMLElement>(`[data-cm-section="${CSS.escape(from.current)}"]`) : null;
    const first = drilled ? ref.current.querySelector<HTMLElement>('.cm-page [role^="menuitem"]:not([aria-disabled="true"]):not(.cm-back)') : null;
    const opened = !drilled && open ? ref.current.querySelector<HTMLElement>(`[data-cm-section="${CSS.escape(open)}"]`) : null;
    (back ?? first ?? opened ?? ref.current.querySelector<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])'))?.focus();
    from.current = drilled ? drilled.section.id : null;
  }, [anchor, open, drilled]);
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
    if (drilled && (event.key === "Backspace" || (event.key === "ArrowLeft" && !inRow))) { event.preventDefault(); setOpen(null); return; }
    if (event.key === "ArrowRight" && active?.dataset.cmOpens === "drill") { event.preventDefault(); active.click(); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowRight") { event.preventDefault(); list[(index + 1) % list.length]?.focus(); }
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") { event.preventDefault(); list[(index - 1 + list.length) % list.length]?.focus(); }
    else if (event.key === "Home") { event.preventDefault(); list[0]?.focus(); }
    else if (event.key === "End") { event.preventDefault(); list[list.length - 1]?.focus(); }
    else if (event.key === "Tab") { event.preventDefault(); onClose(true); }
  };
  const value = (section: MenuSection) => {
    if (section.id === "appearance" && swatch?.type === "swatches") {
      return <span className="cm-val" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span className="cm-dot" data-set={swatch.value ? "1" : undefined} style={swatch.value ? ({ "--c": swatch.hex[swatch.value] } as React.CSSProperties) : undefined} />{section.value}</span>;
    }
    return section.value ? <span className="cm-val">{section.value}</span> : null;
  };
  const node = (entry: MenuNode, index: number) => {
    if (entry.node === "sep") return <div key={`sep-${index}`} className="sep" role="separator" />;
    if (entry.node === "row") return <Row key={`row-${index}`} action={entry.action} hint={entry.hint} onPick={pick} />;
    if (entry.node === "segments") {
      return (
        <div key={entry.id} className={`cm-seg${entry.id === "priority" ? " cm-seg-row" : ""}`} role="group" aria-label={entry.label} data-cm-segments={entry.id}>
          {entry.options.map((option) => (
            <button key={option.id} type="button" role="menuitemradio" aria-checked={Boolean(option.checked)} title={option.why ?? option.label} data-cm-item={option.id ?? ""} onClick={() => pick(option)}>
              {option.status ? <span className="st" data-status={option.status} /> : PRIORITY_ICON[option.id ?? ""] ?? null}
              <span className="cm-cap">{option.label}</span>
            </button>
          ))}
        </div>
      );
    }
    if (entry.node === "quick") {
      return (
        <div key={`quick-${index}`} className="cm-quick" role="group" data-cm-quick="">
          {entry.actions.map((action) => (
            <button key={action.id} type="button" role="menuitem" aria-label={action.label} aria-disabled={action.disabled ? true : undefined} title={action.why ? `${action.label}. ${action.why}` : action.label} data-cm-item={action.id ?? ""} onClick={() => pick(action)}>
              {QUICK_ICON[action.id ?? ""] ?? null}
              <span className="cm-cap">{words.quick[action.id ?? ""] ?? action.label}</span>
            </button>
          ))}
        </div>
      );
    }
    const section = entry.section;
    const expanded = entry.open === "expand" && open === section.id;
    return (
      <div key={section.id} role="none">
        <button
          type="button"
          role="menuitem"
          aria-haspopup={entry.open === "drill" ? "menu" : undefined}
          aria-expanded={entry.open === "expand" ? expanded : undefined}
          data-cm-section={section.id}
          data-cm-opens={entry.open}
          onClick={() => setOpen(expanded ? null : section.id)}
        >
          <span className="lbl">{section.title}</span>
          {value(section)}
          {entry.open === "drill" ? <ChevronRight className="cm-chev" aria-hidden /> : expanded ? <ChevronDown className="cm-chev" aria-hidden /> : <ChevronRight className="cm-chev" aria-hidden />}
        </button>
        {expanded ? <div className="cm-body" role="group" aria-label={section.title} data-cm-body={section.id}><Entries entries={section.entries} hints={section.hints} onPick={pick} onClose={onClose} /></div> : null}
      </div>
    );
  };
  return (
    <div
      ref={ref}
      className="menu cm"
      role="menu"
      aria-label={label}
      data-cm-variant={variant}
      data-cm-view={drilled ? drilled.section.id : open ?? "rest"}
      style={{ "--cm-width": `${layout.width}px` } as React.CSSProperties}
      onKeyDown={onKeyDown}
    >
      <style>{COMPACT_MENU_CSS}</style>
      {drilled ? (
        <div className="cm-page" role="group" aria-label={drilled.section.title} data-cm-page={drilled.section.id}>
          <button type="button" role="menuitem" className="cm-back" aria-label={`${words.back}: ${drilled.section.title}`} data-cm-back="" onClick={() => setOpen(null)}>
            <ChevronLeft aria-hidden />
            <span className="cm-title">{drilled.section.title}</span>
          </button>
          <div className="sep" role="separator" />
          <Entries entries={drilled.section.entries} hints={drilled.section.hints} onPick={pick} onClose={onClose} />
        </div>
      ) : layout.nodes.map(node)}
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
  const words: MenuWords = { appearance: local.appearance, more: local.more, task: local.task, closing: local.closing, move: t("kanban.moveTo"), priority: t("kanban.priority"), none: t("kanban.color.none") };
  const layout = compactLayout(props.kind, props.items, variant, words);
  if (!layout) return <KanbanMenuToday {...props} />;
  return <CompactMenu variant={variant} layout={layout} anchor={props.anchor} label={props.label} onClose={props.onClose} />;
}
