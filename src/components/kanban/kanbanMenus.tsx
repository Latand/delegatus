"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { TASK_COLORS, type TaskColor, type TaskStatus } from "@/lib/tasks/types";

/* Menus and popovers of the kanban board, ported from the approved prototype
   (`prototypes/kanban-board/app.js` openMenu/openTray): fixed to the viewport
   beside their anchor, focus moves in on open and back to the anchor on close,
   arrows walk the items, Tab and Escape close. */

/* What an entry is and which group it belongs to, for a presenter that lays
   the same entries out another way (`menuPresenter`), and on a group's heading
   the state of what the group acts on; the menu itself reads none of them. */
interface KanbanMenuMark { id?: string; group?: string; note?: string }

export type KanbanMenuItem =
  | KanbanMenuMark & { type: "head"; label: string }
  | KanbanMenuMark & { type: "sep" }
  /* The colour labels as a row of swatches, each a radio item; `null` is none. */
  | KanbanMenuMark & { type: "swatches"; label: string; value: TaskColor | null; names: (color: TaskColor | null) => string; hex: Record<TaskColor, string>; onPick: (color: TaskColor | null) => void }
  | KanbanMenuMark & {
    /* `check` is a toggle (menuitemcheckbox), drawn with the radio's tick. */
    type: "item" | "radio" | "check";
    label: string;
    why?: string | null;
    /** A second hint, in warning ink: something the choice waits on. */
    warn?: string | null;
    kbd?: string;
    status?: TaskStatus;
    checked?: boolean;
    disabled?: boolean;
    /** The item moves focus itself (an editor opens, the card leaves): the
        menu closes without handing focus back to its anchor. */
    keepFocus?: boolean;
    /** A leading icon, the way the header's ⋯ rows carry one. */
    icon?: ReactNode;
    onSelect: () => void;
  };

/** A popover's left edge: right-aligned to its control unless that would hang
    past the left edge of the surface the control sits in, then starting under
    the control; always 8 px inside the viewport. */
export function popoverLeft(anchor: { left: number; right: number }, width: number, viewportWidth: number, withinLeft: number | null = null): number {
  let left = anchor.right - width;
  if (withinLeft !== null && left < withinLeft) left = anchor.left;
  return Math.max(8, Math.min(left, viewportWidth - width - 8));
}

export function placeMenu(element: HTMLElement, anchor: HTMLElement, within?: HTMLElement | null): void {
  const rect = anchor.getBoundingClientRect();
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  const left = popoverLeft(rect, width, window.innerWidth, within ? within.getBoundingClientRect().left : null);
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - 8) top = rect.top - height - 6;
  top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
  element.style.left = `${Math.round(left)}px`;
  element.style.top = `${Math.round(top)}px`;
}

export function useMenuDismiss(ref: React.RefObject<HTMLElement | null>, anchor: HTMLElement, onClose: (refocus: boolean) => void) {
  useEffect(() => {
    const down = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || anchor.contains(target)) return;
      onClose(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose(true);
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [ref, anchor, onClose]);
}

export const CheckGlyph = () => (
  <svg className="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 5 5L20 7" /></svg>
);

export interface KanbanMenuProps {
  anchor: HTMLElement;
  label: string;
  items: readonly KanbanMenuItem[];
  onClose: (refocus: boolean) => void;
  /** Which menu of the board this is (`card`, `column`, `reader`, …). */
  kind?: string;
}

/* A design prototype lays the board's menus out another way over the same
   entries (docs/design/compact-card-menu.md). Only the evidence fixture sets
   it; the product leaves it empty and draws the menu below. */
export const menuPresenter: { current: ((props: KanbanMenuProps) => ReactNode | undefined) | null } = { current: null };

export function KanbanMenu(props: KanbanMenuProps) {
  const presented = menuPresenter.current?.(props);
  return presented === undefined ? <KanbanMenuList {...props} /> : presented;
}

export function KanbanMenuList({ anchor, label, items, onClose }: KanbanMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  useMenuDismiss(ref, anchor, onClose);
  useLayoutEffect(() => {
    if (!ref.current) return;
    placeMenu(ref.current, anchor);
    ref.current.querySelector<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [anchor]);
  const focusables = () => [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]
    .filter((item) => item.getAttribute("aria-disabled") !== "true");
  const onKeyDown = (event: React.KeyboardEvent) => {
    const list = focusables();
    const index = list.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowRight") { event.preventDefault(); list[(index + 1) % list.length]?.focus(); }
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") { event.preventDefault(); list[(index - 1 + list.length) % list.length]?.focus(); }
    else if (event.key === "Home") { event.preventDefault(); list[0]?.focus(); }
    else if (event.key === "End") { event.preventDefault(); list[list.length - 1]?.focus(); }
    else if (event.key === "Tab") { event.preventDefault(); onClose(true); }
  };
  return (
    <div ref={ref} className="menu" role="menu" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((item, index) => {
        if (item.type === "sep") return <div key={`sep-${index}`} className="sep" role="separator" />;
        if (item.type === "head") return <div key={`head-${index}`} className="head">{item.label}</div>;
        if (item.type === "swatches") {
          return (
            <div key={`swatches-${index}`} className="swatches" role="group" aria-label={item.label}>
              {[null, ...TASK_COLORS].map((color) => (
                <button
                  key={color ?? "none"}
                  type="button"
                  className="swatch"
                  role="menuitemradio"
                  aria-checked={item.value === color}
                  aria-label={item.names(color)}
                  title={item.names(color)}
                  data-swatch={color ?? "none"}
                  data-none={color ? undefined : "1"}
                  style={color ? ({ "--c": item.hex[color] } as React.CSSProperties) : undefined}
                  onClick={() => {
                    onClose(true);
                    item.onPick(color);
                  }}
                />
              ))}
            </div>
          );
        }
        return (
          <button
            /* By place too: the card's ⋯ holds each lane's actions as a
               group, so a label can repeat in one menu (#2148). */
            key={`${index}-${item.type}-${item.label}`}
            type="button"
            role={item.type === "radio" ? "menuitemradio" : item.type === "check" ? "menuitemcheckbox" : "menuitem"}
            aria-checked={item.type === "radio" || item.type === "check" ? Boolean(item.checked) : undefined}
            aria-disabled={item.disabled ? true : undefined}
            onClick={() => {
              if (item.disabled) return;
              onClose(!item.keepFocus);
              item.onSelect();
            }}
          >
            {item.icon ?? null}
            {item.status ? <span className="st" data-status={item.status} /> : null}
            {item.type === "radio" || item.type === "check" ? <CheckGlyph /> : null}
            <span className="lbl">
              {item.label}
              {item.why ? <span className="why">{item.why}</span> : null}
              {item.warn ? <span className="why warn">{item.warn}</span> : null}
            </span>
            {item.kbd ? <span className="kbd">{item.kbd}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function KanbanPopover({ anchor, label, onClose, children, initialFocus = "button", className, within }: {
  anchor: HTMLElement;
  /** The surface the anchor sits in; the popover does not hang past its left edge. */
  within?: HTMLElement | null;
  label: string;
  onClose: (refocus: boolean) => void;
  children: ReactNode;
  /** Selector of what takes focus on open. */
  initialFocus?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useMenuDismiss(ref, anchor, onClose);
  useLayoutEffect(() => {
    if (!ref.current) return;
    placeMenu(ref.current, anchor, within);
    ref.current.querySelector<HTMLElement>(initialFocus)?.focus();
  }, [anchor, initialFocus, within]);
  return (
    <div ref={ref} className={`popover${className ? ` ${className}` : ""}`} role="dialog" aria-label={label}>
      {children}
    </div>
  );
}

/** One open menu or popover at a time, closed with focus back on its anchor. */
export function useOverlay<T>() {
  const [open, setOpen] = useState<{ anchor: HTMLElement; value: T } | null>(null);
  const close = useCallback((refocus: boolean) => {
    setOpen((current) => {
      if (current && refocus && current.anchor.isConnected) {
        const anchor = current.anchor;
        queueMicrotask(() => anchor.focus());
      }
      return null;
    });
  }, []);
  /* One object while nothing opens or closes, so handlers that list the overlay among their inputs keep their
     identity and memoized cards and readers do not re-render on every board render. */
  return useMemo(() => ({ open, setOpen, close }), [open, close]);
}
