"use client";

/*
 * Design prototype (docs/design/interface-redesign.md): numbered directions for
 * the sidebar, the overflow menus and a glass visual language. Only the kanban
 * evidence fixture mounts this (`?redesign=<n>`); no product file imports it.
 *
 * The page the driver opens is a HOST: a strip that prints the variant number
 * and, under it, one frame per look at the exact size being judged. Each frame
 * loads the same fixture with `&inner=1`, where the real Viewer renders inside
 * `InterfaceRedesignInner`. The number therefore lies outside the application
 * and covers nothing in it, and viewport units, fixed surfaces and the phone
 * breakpoint behave as they do in a window of that size.
 *
 * A variant changes the shell in three ways, all of them reversible by leaving
 * the query off: it puts the real rail away with one style rule and draws its
 * own navigation as a layout sibling of the Viewer; it answers the EXISTING
 * menu buttons (the rail's, the board's, a card's, the phone's) with its own
 * regrouped menu; and it restyles the real surfaces through one stylesheet.
 * Variants whose header is shorter than today's also give the Viewer's
 * attention notice a row of its own under the header (`useNoticeBand`), so the
 * notice lies over nothing whatever the header's height. Every project, count
 * and limit drawn by the prototype's own chrome is invented.
 *
 * The prototype's surfaces use the product's own contracts, so a build inherits
 * them: a desktop menu or dialog is a `useModalLayer` layer (Tab stays inside,
 * Escape closes, focus goes in on open and back to the control that opened
 * it); a phone surface is the product's `MobileSheet`, opened and closed
 * through `mobileNav`, so Back closes it first, its handle drags it shut and
 * its × and scrim close it. Product actions behind the rows stay inert.
 */

import { Archive, ChevronDown, ChevronLeft, ChevronRight, Crown, LayoutGrid, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings as Gear, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { LAYER } from "@/components/layers";
import { MobileSheet } from "@/components/mobile/MobileSheet";
import { useMobileNav, useMobileNavStore } from "@/components/mobile/mobileNav";
import { useModalLayer } from "@/components/modalLayer";
import { useIsMobile } from "@/hooks/useIsMobile";

import {
  ARCHIVED, B_CONVERSATION_TITLE_REFS, LIMITS, MENUS_A, MENUS_B, PROJECTS, SETTINGS, SUBAGENTS, tightestLimit,
  type Lang, type Menu, type Row,
} from "./interfaceRedesign.prototype.model";

export const REDESIGN_VARIANTS = [0, 1, 2, 3, 4, 5, 6, 7] as const;
export type RedesignVariant = (typeof REDESIGN_VARIANTS)[number];

const TITLES: Record<Lang, Record<RedesignVariant, string>> = {
  en: {
    0: "Today",
    1: "No sidebar: the project title switches, one palette finds the rest",
    2: "Recombined sidebar: projects only, the system in one row",
    3: "Collapsible rail: 52 px at rest, opens beside the board",
    4: "Menus A: frequent actions promoted, the rest in named groups",
    5: "Menus B: object actions only, every setting in one Settings place",
    6: "Glass: translucent shell over today's structure",
    7: "Combined proposal: 1 + 5 + 6",
  },
  uk: {
    0: "Сьогодні",
    1: "Без бічної панелі: назва проєкту перемикає, одна палітра знаходить решту",
    2: "Перезібрана панель: лише проєкти, система в одному рядку",
    3: "Згортна рейка: 52 px у спокої, відкривається поруч із дошкою",
    4: "Меню A: часті дії нагорі, решта в названих групах",
    5: "Меню B: лише дії об’єкта, усі налаштування в одному місці",
    6: "Скло: напівпрозора оболонка поверх сьогоднішньої структури",
    7: "Зведена пропозиція: 1 + 5 + 6",
  },
};

const COPY = {
  en: {
    goTo: "Go to a project, an agent or a setting", filter: "Filter projects", overview: "Overview", archived: "Archived", newProject: "New project",
    settings: "Settings", system: "System", quiet: "all quiet", back: "Back", close: "Close", projects: "Projects", left: (n: number) => `${n}% left`,
    switchProject: (name: string) => `${name}: switch project or go to anything`, systemAria: (left: number) => `System: tightest limit ${left}% left`,
    ram: "RAM", swap: "Swap", free: "9.0 GiB free", used: "1.0 GiB used", sessions: "3 agent sessions", stopIdle: "Stop idle", accounts: "Accounts", telegram: "Telegram", notConnected: "Not connected",
    thisProject: "This project", delegatus: "Delegatus", hide: "Hide the sidebar (B)", expand: "Open the sidebar (B)", collapse: "Collapse the sidebar (B)",
    crown: (name: string) => `Pin ${name}`, agent: (n: number) => `Agent ${n}`, roles: ["builder", "reviewer", "critic", "researcher"], rename: "Rename", crownConv: "Crown",
    needs: (n: number) => `${n} need you`, working: (n: number) => `${n} working`, hint: "Ctrl K",
  },
  uk: {
    goTo: "Перейти до проєкту, агента чи налаштування", filter: "Фільтр проєктів", overview: "Огляд", archived: "Архів", newProject: "Новий проєкт",
    settings: "Налаштування", system: "Система", quiet: "усе спокійно", back: "Назад", close: "Закрити", projects: "Проєкти", left: (n: number) => `лишилось ${n}%`,
    switchProject: (name: string) => `${name}: перемкнути проєкт або перейти будь-куди`, systemAria: (left: number) => `Система: найтісніший ліміт, лишилось ${left}%`,
    ram: "RAM", swap: "Swap", free: "9.0 GiB вільно", used: "1.0 GiB зайнято", sessions: "3 сесії агентів", stopIdle: "Зупинити неактивні", accounts: "Акаунти", telegram: "Telegram", notConnected: "Не підключено",
    thisProject: "Цей проєкт", delegatus: "Delegatus", hide: "Сховати панель (B)", expand: "Відкрити панель (B)", collapse: "Згорнути панель (B)",
    crown: (name: string) => `Закріпити ${name}`, agent: (n: number) => `Агент ${n}`, roles: ["будівник", "рев’юер", "критик", "дослідник"], rename: "Перейменувати", crownConv: "Коронувати",
    needs: (n: number) => `${n} потребують вас`, working: (n: number) => `${n} працюють`, hint: "Ctrl K",
  },
};

const STRIP = 36;
export const REDESIGN_STRIP_HEIGHT = STRIP;
/** The Viewer draws the board header's island (attention badge and notice) on layer 50 (`Viewer.tsx`). */
const BAR_ISLAND_LAYER = 50;

export function parseRedesign(search: string): { variant: RedesignVariant; inner: boolean } | null {
  const params = new URLSearchParams(search);
  const raw = params.get("redesign");
  if (raw === null) return null;
  const variant = Number(raw) as RedesignVariant;
  if (!REDESIGN_VARIANTS.includes(variant)) return null;
  return { variant, inner: params.get("inner") === "1" };
}

const currentLang = (): Lang => (localStorage.getItem("llv_lang") === "uk" ? "uk" : "en");

/** The host page: the printed number and one frame per look. */
export function InterfaceRedesignHost({ variant }: { variant: RedesignVariant }) {
  const params = new URLSearchParams(location.search);
  const lang = currentLang();
  const [width, height] = (params.get("frame") ?? "1440x900").split("x").map(Number) as [number, number];
  /* `beside=0` puts today's look in a first frame, left of the variant. */
  const beside = params.get("beside");
  const looks = beside === null ? [variant] : [Number(beside) as RedesignVariant, variant];
  const src = (look: RedesignVariant) => {
    const inner = new URLSearchParams(params);
    inner.set("redesign", String(look));
    inner.set("inner", "1");
    inner.delete("beside");
    return `${location.pathname}?${inner.toString()}${location.hash}`;
  };
  return (
    <div data-ir-host="" style={{ display: "flex", gap: 12, background: "var(--surface-board)", height: "100%" }}>
      {looks.map((look) => (
        <div key={look} style={{ display: "flex", flexDirection: "column", width }}>
          <div
            data-ir-strip=""
            style={{ height: STRIP, display: "flex", alignItems: "center", gap: 10, padding: "0 10px", background: "var(--color-brand)", color: "var(--color-on-brand)", font: "600 13px/1 var(--font-sans)", overflow: "hidden", whiteSpace: "nowrap" }}
          >
            <span data-ir-variant-number="" style={{ font: "800 26px/1 var(--font-sans)", minWidth: 20, textAlign: "center" }}>{look}</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{TITLES[lang][look]}</span>
            <span style={{ marginLeft: "auto", opacity: 0.75, fontWeight: 500 }}>{width}×{height} · {lang}</span>
          </div>
          <iframe data-ir-frame={look} title={TITLES[lang][look]} src={src(look)} style={{ width, height, border: 0, display: "block" }} />
        </div>
      ))}
    </div>
  );
}

/* ── Hooks into the real shell ─────────────────────────────────────────── */

/**
 * Answer an existing control's press with the prototype's own surface. The
 * handler returns false to let the press through to the product.
 */
function useIntercept(enabled: boolean, selector: string, handler: (trigger: HTMLElement) => boolean | void) {
  const latest = useRef(handler);
  useEffect(() => { latest.current = handler; });
  useEffect(() => {
    if (!enabled) return;
    const onClick = (event: MouseEvent) => {
      const trigger = (event.target as Element | null)?.closest<HTMLElement>(selector);
      if (!trigger) return;
      if (latest.current(trigger) === false) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    /* On the window, in capture: ahead of the root container React listens on. */
    window.addEventListener("click", onClick, true);
    return () => window.removeEventListener("click", onClick, true);
  }, [enabled, selector]);
}

/**
 * A node kept inside a real element, for the two controls variants 1 and 7 put
 * in a header. The first candidate present wins; `host` names where it landed.
 */
function useSlot(enabled: boolean, candidates: readonly (readonly [selector: string, place: "first" | "after", host: string])[]): [HTMLElement | null, string | null] {
  const [slot] = useState<HTMLElement | null>(() => {
    if (!enabled) return null;
    const node = document.createElement("span");
    node.dataset.irSlot = "";
    node.style.display = "contents";
    return node;
  });
  const [host, setHost] = useState<string | null>(null);
  useEffect(() => {
    if (!slot) return;
    const attach = () => {
      for (const [selector, place, where] of candidates) {
        const parent = document.querySelector(selector);
        if (!parent) continue;
        if (place === "first" && parent.firstChild !== slot) parent.insertBefore(slot, parent.firstChild);
        if (place === "after" && parent.nextSibling !== slot) parent.parentNode?.insertBefore(slot, parent.nextSibling);
        setHost(where);
        return;
      }
      setHost(null);
    };
    attach();
    const observer = new MutationObserver(attach);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { observer.disconnect(); slot.remove(); };
    // The candidates are constants of the caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot]);
  return [slot, host];
}

/** The overview's title row: its heading followed by its status line. */
const OVERVIEW_TITLE_ROW = "div:has(> h1 + span[data-reach])";

/**
 * An intercepted product trigger opens a dialog here, so it says so. The
 * product declares `aria-haspopup="menu"` on the rail's, the board's and a
 * card's "⋯", for the menus the prototype answers in their place; a screen
 * reader would announce a menu and meet a dialog. What each trigger declared
 * comes back when the prototype goes.
 */
export function useDialogTriggers(enabled: boolean, selector: string) {
  useEffect(() => {
    if (!enabled) return;
    const declared = new Map<HTMLElement, string | null>();
    const mark = () => {
      for (const trigger of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
        if (!declared.has(trigger)) declared.set(trigger, trigger.getAttribute("aria-haspopup"));
        if (trigger.getAttribute("aria-haspopup") !== "dialog") trigger.setAttribute("aria-haspopup", "dialog");
      }
    };
    mark();
    const observer = new MutationObserver(mark);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-haspopup"] });
    return () => {
      observer.disconnect();
      for (const [trigger, value] of declared) {
        if (value === null) trigger.removeAttribute("aria-haspopup");
        else trigger.setAttribute("aria-haspopup", value);
      }
    };
  }, [enabled, selector]);
}

/** The space above and below the notice in its band. */
const NOTICE_GAP = 6;
/** Where the notice's band goes: above the board's body, or under a header that has no board. */
const NOTICE_HOSTS = [[".kb .kb-body", "before"], ["[data-project-bar]", "after"], [OVERVIEW_TITLE_ROW, "after"]] as const;

/**
 * The attention notice's own place. The Viewer hangs the notice from its
 * badge, fixed to the window, and counts on the header under it being tall
 * enough: where a variant's header is one row and today's wraps into two, the
 * notice ended over the orchestrator pane's controls. Here the notice gets a
 * row of the layout: a band under the header, as tall as the notice
 * and present only while one is shown, to which the notice is pinned. The band
 * is measured, so the header may be any height, and nothing is under the
 * notice but the band. (A build renders the notice in that row; the prototype
 * may not move a node React owns, so it pins the notice to the row's box.)
 */
function useNoticeBand(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const root = document.documentElement;
    const band = document.createElement("div");
    band.dataset.irNoticeBand = "";
    let toast: HTMLElement | null = null;
    let watched: Element[] = [];
    const place = () => {
      if (!toast?.isConnected || !band.isConnected) return;
      band.style.height = `${toast.offsetHeight + 2 * NOTICE_GAP}px`;
      const rect = band.getBoundingClientRect();
      root.style.setProperty("--ir-notice-top", `${rect.top + NOTICE_GAP}px`);
      root.style.setProperty("--ir-notice-right", `${innerWidth - rect.right + 16}px`);
      root.style.setProperty("--ir-notice-max", `${Math.max(160, rect.width - 32)}px`);
    };
    const sizes = new ResizeObserver(place);
    const clear = () => {
      band.remove();
      delete root.dataset.irNoticeBand;
      for (const name of ["--ir-notice-top", "--ir-notice-right", "--ir-notice-max"]) root.style.removeProperty(name);
      sizes.disconnect();
      toast = null;
      watched = [];
    };
    const attach = () => {
      const next = document.querySelector<HTMLElement>("[data-attention-toast]");
      const found = next ? NOTICE_HOSTS.map(([selector, where]) => [document.querySelector(selector), where] as const).find(([host]) => host) : undefined;
      if (!next || !found) { if (toast) clear(); return; }
      const [host, where] = found;
      if (where === "before" && host!.previousSibling !== band) host!.parentNode?.insertBefore(band, host);
      if (where === "after" && host!.nextSibling !== band) host!.parentNode?.insertBefore(band, host!.nextSibling);
      root.dataset.irNoticeBand = "";
      /* The band moves when anything above it changes height: the header wrapping, a filter row arriving. */
      const above: Element[] = [next];
      for (let node = band.previousElementSibling; node; node = node.previousElementSibling) above.push(node);
      if (band.parentElement) above.push(band.parentElement);
      if (above.length !== watched.length || above.some((node, index) => node !== watched[index])) {
        sizes.disconnect();
        for (const node of above) sizes.observe(node);
        watched = above;
      }
      toast = next;
      place();
    };
    attach();
    const observer = new MutationObserver(attach);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", place);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); clear(); };
  }, [enabled]);
}

/** True while the desktop shows the Overview: no project is chosen there. */
function useOverviewHere(enabled: boolean) {
  const [here, setHere] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const read = () => setHere(Boolean(document.querySelector(`.kb .bar[data-bar="overview"], ${OVERVIEW_TITLE_ROW}`)));
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [enabled]);
  return here;
}

const LEADS = [
  ['[data-bar="project"] [data-bar-group="where"]', "first", "project"],
  ['[data-project-bar] [data-bar-group="where"]', "first", "project"],
  [OVERVIEW_TITLE_ROW, "first", "overview"],
] as const;
const STATUS_SLOTS = [
  ['[data-bar="project"] [data-bar-group="status"]', "after", "project"],
  ['[data-project-bar] [data-bar-group="status"]', "after", "project"],
  [`${OVERVIEW_TITLE_ROW} > span[data-reach]`, "after", "overview"],
] as const;

const TABBABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';
const firstTabbable = (root: ParentNode | null) => root?.querySelector<HTMLElement>(TABBABLE) ?? null;

/* ── Rows and menus ────────────────────────────────────────────────────── */

type Open =
  | { kind: "menu"; menu: string; anchor: DOMRect; returnTo: HTMLElement | null }
  | { kind: "palette" | "system" | "settings"; anchor: DOMRect | null; scope?: "project" | "delegatus"; /** False where no project is chosen (the Overview). */ project?: boolean; returnTo: HTMLElement | null }
  | null;

/** What a row does beyond its own state: a drill-in, another sheet face, the Settings place. False when it does nothing (an inert product action). */
type RowAction = (entry: Row) => boolean;

function RowView({ entry, lang, name, onRow, promoted }: { entry: Row; lang: Lang; name: string; onRow: RowAction; promoted?: boolean }) {
  const [on, setOn] = useState(entry.key === "sound" || entry.key === "reports" || entry.key === "push");
  const [picked, setPicked] = useState(entry.key === "status" ? 1 : entry.key.startsWith("priority") ? 1 : entry.key.startsWith("colour") ? 3 : 0);
  const label = entry.label[lang];
  if (entry.kind === "segment" || entry.kind === "chips") {
    return (
      <div className={`ir-row ir-choice ${promoted ? "ir-choice-wide" : ""}`} data-ir-row={entry.key}>
        <span className="ir-row-label">{label}</span>
        <span className={entry.kind === "segment" ? "ir-segment" : "ir-chips"} role="group" aria-label={label}>
          {entry.choices!.map((choice, index) => (
            <button
              key={index} type="button" data-ir-control={`${name}:${entry.key}:${index}`}
              aria-pressed={picked === index}
              aria-label={entry.key.startsWith("colour") ? (index === 0 ? `${label}: ${lang === "uk" ? "без кольору" : "none"}` : `${label} ${index}`) : undefined}
              className={entry.key.startsWith("colour") ? "ir-swatch" : undefined}
              style={entry.key.startsWith("colour") ? { "--ir-hue": `${index * 40}` } as CSSProperties : undefined}
              onClick={() => setPicked(index)}
            >
              {entry.key.startsWith("colour") ? null : choice[lang]}
            </button>
          ))}
        </span>
      </div>
    );
  }
  if (entry.kind === "toggle") {
    return (
      <button type="button" role="switch" aria-checked={on} className={`ir-row ${promoted ? "ir-promoted ir-promoted-toggle" : ""}`} data-ir-control={`${name}:${entry.key}`} onClick={() => setOn((was) => !was)}>
        <span className="ir-row-label">{label}</span>
        <span className="ir-switch" aria-hidden />
      </button>
    );
  }
  const leads = Boolean(entry.into || entry.face);
  return (
    <button
      type="button" className={`ir-row ${promoted ? "ir-promoted" : ""} ${entry.kind === "danger" ? "ir-danger" : ""}`} data-ir-control={`${name}:${entry.key}`}
      onClick={() => onRow(entry)}
    >
      <span className="ir-row-label">{label}</span>
      {entry.trail ? <span className="ir-trail">{entry.trail[lang]}</span> : null}
      {leads ? <ChevronRight className="ir-chev" aria-hidden /> : null}
    </button>
  );
}

/** Focus follows a drill-in: in, onto the Back row; out, onto the row it came from. */
function useDrillFocus(body: RefObject<HTMLElement | null>, inside: string | null, name: string) {
  const from = useRef<string | null>(null);
  useEffect(() => {
    const root = body.current;
    if (!root) return;
    if (inside) {
      from.current = inside;
      root.querySelector<HTMLElement>(".ir-back")?.focus();
    } else if (from.current) {
      root.querySelector<HTMLElement>(`[data-ir-control="${name}:${from.current}"]`)?.focus();
      from.current = null;
    }
  }, [body, inside, name]);
}

function MenuView({ menu, name, lang, onRow }: { menu: Menu; name: string; lang: Lang; onRow: RowAction }) {
  const [into, setInto] = useState<Row | null>(null);
  const body = useRef<HTMLDivElement>(null);
  useDrillFocus(body, into?.key ?? null, name);
  const t = COPY[lang];
  const act: RowAction = (entry) => {
    if (entry.into) { setInto(entry); return true; }
    return onRow(entry);
  };
  if (into) {
    const agents = into.key === "agents";
    return (
      <div ref={body} className="ir-menu-body" data-ir-menu={name} data-ir-menu-view={into.key}>
        <button type="button" className="ir-row ir-back" data-ir-control={`${name}:back`} aria-label={`${t.back}: ${into.label[lang]}`} onClick={() => setInto(null)}>
          <ChevronLeft className="ir-chev" aria-hidden />
          <span className="ir-row-label">{into.label[lang]}</span>
        </button>
        <div className={agents ? "ir-scroll" : undefined} data-ir-agents={agents ? SUBAGENTS : undefined}>
          {agents
            ? Array.from({ length: SUBAGENTS }, (_, index) => (
              <button key={index} type="button" className="ir-row" data-ir-agent={index}>
                <span className="ir-row-label">{t.agent(index + 1)}</span>
                <span className="ir-trail">{t.roles[index % t.roles.length]}</span>
              </button>
            ))
            : into.into!.map((entry) => <RowView key={entry.key} entry={entry} lang={lang} name={`${name}:${into.key}`} onRow={act} />)}
        </div>
      </div>
    );
  }
  const wide = menu.promoted.filter((entry) => entry.kind === "segment");
  const buttons = menu.promoted.filter((entry) => entry.kind !== "segment");
  return (
    <div ref={body} className="ir-menu-body" data-ir-menu={name} data-ir-menu-view="first">
      {wide.map((entry) => <RowView key={entry.key} entry={entry} lang={lang} name={name} onRow={act} promoted />)}
      {buttons.length ? (
        <div className="ir-promoted-row" style={{ gridTemplateColumns: `repeat(${buttons.length}, minmax(0, 1fr))` }}>
          {buttons.map((entry) => <RowView key={entry.key} entry={entry} lang={lang} name={name} onRow={act} promoted />)}
        </div>
      ) : null}
      {menu.promoted.length ? <div className="ir-rule" /> : null}
      {menu.rows.map((entry) => <RowView key={entry.key} entry={entry} lang={lang} name={name} onRow={act} />)}
    </div>
  );
}

/* ── Surfaces ──────────────────────────────────────────────────────────── */

/**
 * A desktop menu or dialog. It is a modal layer: a scrim takes every press
 * outside it, Tab stays inside it, Escape closes it, focus starts on its field
 * or its first control and goes back to the control that opened it.
 */
function Surface({ open, width, label, onClose, children, name }: {
  open: Exclude<Open, null>; width: number; label: string; onClose: () => void; children: ReactNode; name: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const anchor = open.anchor;
  const centred = !anchor || open.kind === "settings";
  useModalLayer({ containerRef: ref, onClose, lockScroll: centred, manageFocus: false });
  /* The product listens for Escape too (a reader, a selection); the open layer answers it alone. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const returnTo = open.returnTo;
  useEffect(() => {
    const node = ref.current;
    (node?.querySelector<HTMLElement>("[data-ir-autofocus]") ?? firstTabbable(node) ?? node)?.focus();
    return () => { if (returnTo?.isConnected) returnTo.focus(); };
  }, [returnTo]);
  /* A menu opened low on the page moves up by what would hang below the window. */
  const [lift, setLift] = useState(0);
  const below = anchor !== null && !centred && anchor.top <= innerHeight * 0.6;
  const base = anchor ? anchor.bottom + 6 : 0;
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !below) return;
    const place = () => {
      const content = Array.from(node.children).reduce((height, child) => height + child.scrollHeight, 2);
      const next = Math.max(0, Math.min(base + content + 8 - innerHeight, base - 8));
      setLift((was) => (Math.abs(was - next) < 1 ? was : next));
    };
    place();
    /* A drill-in changes the menu's height without re-rendering this surface. */
    const observer = new MutationObserver(place);
    observer.observe(node, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [below, base]);
  const style: CSSProperties = centred
    ? { zIndex: LAYER.overlay, width, left: Math.max(8, (innerWidth - width) / 2), top: Math.max(8, Math.min(96, innerHeight * 0.1)), maxHeight: innerHeight - 2 * Math.max(8, Math.min(96, innerHeight * 0.1)) }
    : anchor!.top > innerHeight * 0.6
      /* A trigger at the foot of the rail opens its panel beside itself, growing upward. */
      ? { zIndex: LAYER.popover, width, left: Math.min(anchor!.right + 8, innerWidth - width - 8), bottom: Math.max(8, innerHeight - anchor!.bottom), maxHeight: innerHeight - 16 }
      : { zIndex: LAYER.popover, width, left: Math.max(8, Math.min(anchor!.left, innerWidth - width - 8)), top: anchor!.bottom + 6 - lift, maxHeight: innerHeight - (anchor!.bottom + 6 - lift) - 8 };
  return createPortal(
    <div data-ir-layer={name}>
      <div className={`ir-scrim ${centred ? "ir-scrim-dim" : ""}`} style={{ zIndex: centred ? LAYER.modal : LAYER.popover - 1 }} data-ir-scrim="" onClick={onClose} />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} data-ir-surface={name} className="ir-surface ir-pop" style={style}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function ProjectRows({ lang, name, query, compact, withCrown = true, overview = false }: { lang: Lang; name: string; query: string; compact?: boolean; withCrown?: boolean; /** The Overview is the place on screen: no project is the current one. */ overview?: boolean }) {
  const t = COPY[lang];
  const [crowned, setCrowned] = useState(() => new Set(PROJECTS.filter((project) => project.crowned).map((project) => project.name)));
  const [archived, setArchived] = useState(false);
  const shown = PROJECTS.filter((project) => project.name.includes(query.trim().toLowerCase()));
  return (
    <>
      <button type="button" className="ir-row ir-project" aria-current={overview ? "page" : undefined} data-ir-control={`${name}:overview`}>
        <LayoutGrid className="ir-ico" aria-hidden />
        <span className="ir-row-label">{t.overview}</span>
      </button>
      {shown.map((project) => (
        <div key={project.name} className="ir-project-line">
          <button type="button" className="ir-row ir-project" aria-current={!overview && project.name === "atlas" ? "page" : undefined} data-ir-control={`${name}:project:${project.name}`}>
            <i className={`ir-dot ${project.live ? "ir-dot-live" : ""}`} aria-hidden />
            <span className="ir-row-label">
              {project.name}
              {compact ? null : <span className="ir-sub">{project.age[lang]}</span>}
            </span>
            {project.needs ? <span className="ir-needs" title={t.needs(project.needs)}>{project.needs}</span> : null}
            <span className="ir-count">{project.total}</span>
          </button>
          {withCrown ? (
            <button
              type="button" className="ir-icon ir-crown" aria-pressed={crowned.has(project.name)} aria-label={t.crown(project.name)} data-ir-control={`${name}:crown:${project.name}`}
              onClick={() => setCrowned((was) => { const next = new Set(was); if (next.has(project.name)) next.delete(project.name); else next.add(project.name); return next; })}
            >
              <Crown aria-hidden />
            </button>
          ) : null}
        </div>
      ))}
      <button type="button" className="ir-row ir-fold" aria-expanded={archived} data-ir-control={`${name}:archived`} onClick={() => setArchived((was) => !was)}>
        <Archive className="ir-ico" aria-hidden />
        <span className="ir-row-label">{t.archived}</span>
        <span className="ir-count">{ARCHIVED.length}</span>
        <ChevronDown className="ir-chev" aria-hidden />
      </button>
      {archived ? ARCHIVED.map((project) => (
        <button key={project} type="button" className="ir-row ir-project ir-archived" data-ir-control={`${name}:archived:${project}`}>
          <i className="ir-dot" aria-hidden /><span className="ir-row-label">{project}</span>
        </button>
      )) : null}
    </>
  );
}

function Field({ lang, name, value, onChange, placeholder, hint, autoFocus }: { lang: Lang; name: string; value: string; onChange: (value: string) => void; placeholder: string; hint?: boolean; autoFocus?: boolean }) {
  return (
    <label className="ir-field">
      <Search className="ir-ico" aria-hidden />
      <input data-ir-control={`${name}:field`} data-ir-autofocus={autoFocus ? "" : undefined} value={value} placeholder={placeholder} aria-label={placeholder} onChange={(event) => onChange(event.target.value)} />
      {hint ? <kbd>{COPY[lang].hint}</kbd> : null}
    </label>
  );
}

/** A drill-in's first row: back to the list it came from. */
function BackRow({ name, label, lang, onBack }: { name: string; label: string; lang: Lang; onBack: () => void }) {
  return (
    <button type="button" className="ir-row ir-back" data-ir-control={`${name}:back`} aria-label={`${COPY[lang].back}: ${label}`} onClick={onBack}>
      <ChevronLeft className="ir-chev" aria-hidden /><span className="ir-row-label">{label}</span>
    </button>
  );
}

/** Variant 1's one finder: projects first, then the system and everything the rail's menu held. */
function Palette({ lang, phone, onSettings, settingsRows, overview }: { lang: Lang; phone: boolean; onSettings: () => void; settingsRows: Row[] | null; overview: boolean }) {
  const t = COPY[lang];
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"list" | "settings" | "system">("list");
  const body = useRef<HTMLDivElement>(null);
  useDrillFocus(body, view === "list" ? null : view, "palette");
  if (view === "settings" && settingsRows) {
    return (
      <div ref={body} className="ir-menu-body" data-ir-menu="palette" data-ir-menu-view="palette-settings">
        <BackRow name="palette" label={t.settings} lang={lang} onBack={() => setView("list")} />
        {settingsRows.map((entry) => <RowView key={entry.key} entry={entry} lang={lang} name="palette:settings" onRow={() => false} />)}
      </div>
    );
  }
  if (view === "system") {
    return (
      <div ref={body} className="ir-menu-body" data-ir-menu="palette" data-ir-menu-view="palette-system">
        <BackRow name="palette" label={t.system} lang={lang} onBack={() => setView("list")} />
        <SystemRows lang={lang} />
      </div>
    );
  }
  return (
    <div ref={body} className="ir-menu-body" data-ir-menu="palette" data-ir-menu-view="palette">
      <Field lang={lang} name="palette" value={query} onChange={setQuery} placeholder={phone ? t.filter : t.goTo} hint={!phone} autoFocus />
      <div className="ir-head">{t.projects}</div>
      <ProjectRows lang={lang} name="palette" query={query} overview={overview} />
      <button type="button" className="ir-row" data-ir-control="palette:new-project"><Plus className="ir-ico" aria-hidden /><span className="ir-row-label">{t.newProject}</span></button>
      <div className="ir-rule" />
      <button type="button" className="ir-row" data-ir-control="palette:system" onClick={() => setView("system")}>
        <Ring left={tightestLimit()} /><span className="ir-row-label">{t.system}</span><span className="ir-trail">{t.left(tightestLimit())}</span><ChevronRight className="ir-chev" aria-hidden />
      </button>
      <button type="button" className="ir-row" data-ir-control="palette:settings" onClick={() => (settingsRows ? setView("settings") : onSettings())}>
        <Gear className="ir-ico" aria-hidden /><span className="ir-row-label">{t.settings}</span><ChevronRight className="ir-chev" aria-hidden />
      </button>
    </div>
  );
}

function Ring({ left }: { left: number }) {
  return <i className="ir-ring" style={{ "--ir-left": `${left}%` } as CSSProperties} aria-hidden />;
}

function SystemRows({ lang }: { lang: Lang }) {
  const t = COPY[lang];
  return (
    <>
      <button type="button" className="ir-row ir-meter-row" data-ir-control="system:resources">
        <span className="ir-meter"><b>{t.ram}</b><span>{t.free}</span><i style={{ "--ir-fill": "72%" } as CSSProperties} /></span>
        <span className="ir-meter"><b>{t.swap}</b><span>{t.used}</span><i style={{ "--ir-fill": "12%" } as CSSProperties} /></span>
      </button>
      <div className="ir-line">
        <span className="ir-row-label">{t.sessions}</span>
        <button type="button" className="ir-quiet" data-ir-control="system:stop-idle">{t.stopIdle}</button>
      </div>
      <div className="ir-rule" />
      {LIMITS.map((limit) => (
        <div key={limit.engine} className="ir-engine">
          <div className="ir-line">
            <span className="ir-row-label"><b>{limit.engine}</b> <span className="ir-sub-inline">{limit.plan}</span></span>
            <button type="button" className="ir-quiet" data-ir-control={`system:accounts:${limit.engine}`}>{t.accounts}</button>
          </div>
          <button type="button" className="ir-row ir-meter-row" data-ir-control={`system:usage:${limit.engine}`}>
            {limit.windows.map((window) => (
              <span key={window.label.en} className="ir-meter"><b>{window.label[lang]}</b><span>{t.left(window.left)}</span><i style={{ "--ir-fill": `${100 - window.left}%` } as CSSProperties} /></span>
            ))}
          </button>
        </div>
      ))}
      <div className="ir-rule" />
      <button type="button" className="ir-row" data-ir-control="system:telegram"><span className="ir-row-label">{t.telegram}</span><span className="ir-trail">{t.notConnected}</span><ChevronRight className="ir-chev" aria-hidden /></button>
    </>
  );
}

function SystemPanel({ lang }: { lang: Lang }) {
  return (
    <div className="ir-menu-body" data-ir-menu-view="system">
      <div className="ir-head">{COPY[lang].system}</div>
      <SystemRows lang={lang} />
    </div>
  );
}

/** Direction B's one Settings place. On the phone it is the content of a sheet, whose header carries the title and the ×. */
function SettingsPlace({ lang, phone, scope, withProject, onClose, onBack, backLabel }: {
  lang: Lang; phone: boolean; scope: "project" | "delegatus"; /** False where no project is chosen: the project's sections are not offered. */ withProject: boolean; onClose: () => void; onBack?: () => void; backLabel?: string;
}) {
  const t = COPY[lang];
  const scopes = withProject ? ["project", "delegatus"] as const : ["delegatus"] as const;
  const first = SETTINGS.find((section) => section.scope === (withProject ? scope : "delegatus"))!.key;
  const [key, setKey] = useState<string | null>(phone ? null : first);
  const section = SETTINGS.find((entry) => entry.key === key) ?? null;
  const body = useRef<HTMLDivElement>(null);
  const from = useRef<string | null>(null);
  useEffect(() => {
    if (!phone || !body.current) return;
    if (key) { from.current = key; body.current.querySelector<HTMLElement>(".ir-back")?.focus(); }
    else if (from.current) { body.current.querySelector<HTMLElement>(`[data-ir-control="settings:section:${from.current}"]`)?.focus(); from.current = null; }
  }, [key, phone]);
  const list = (
    <nav className="ir-settings-nav" aria-label={t.settings}>
      {phone && onBack ? <BackRow name="settings:menu" label={backLabel ?? t.back} lang={lang} onBack={onBack} /> : null}
      {scopes.map((group) => (
        <div key={group}>
          <div className="ir-head">{group === "project" ? `${t.thisProject}: atlas` : t.delegatus}</div>
          {SETTINGS.filter((entry) => entry.scope === group).map((entry) => (
            <button key={entry.key} type="button" className="ir-row" aria-current={!phone && entry.key === key ? "page" : undefined} data-ir-control={`settings:section:${entry.key}`} onClick={() => setKey(entry.key)}>
              <span className="ir-row-label">{entry.title[lang]}</span>
              {phone ? <ChevronRight className="ir-chev" aria-hidden /> : null}
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
  const rows = section ? (
    <div className="ir-settings-rows" data-ir-settings-section={section.key}>
      {phone ? <BackRow name="settings" label={section.title[lang]} lang={lang} onBack={() => setKey(null)} /> : <div className="ir-settings-title">{section.title[lang]}</div>}
      {section.rows.map((entry) => <RowView key={entry.key} entry={entry} lang={lang} name={`settings:${section.key}`} onRow={() => false} />)}
    </div>
  ) : null;
  if (phone) return <div ref={body} className="ir-settings ir-settings-phone" data-ir-menu-view="settings">{section ? rows : list}</div>;
  return (
    <div className="ir-settings" data-ir-menu-view="settings">
      <div className="ir-settings-bar">
        <span className="ir-settings-title">{t.settings}</span>
        <button type="button" className="ir-icon" aria-label={t.close} data-ir-control="settings:close" onClick={onClose}><X aria-hidden /></button>
      </div>
      <div className="ir-settings-panes">{list}{rows}</div>
    </div>
  );
}

/** Variants 2 and 3: the rail as a layout sibling of the Viewer. */
function Rail({ lang, collapsible, open, onToggle, onSystem, onSettings, focusField, overview, showing }: {
  lang: Lang; collapsible: boolean; open: boolean; onToggle: () => void; onSystem: (trigger: HTMLElement) => void; onSettings: (trigger: HTMLElement) => void; focusField: number;
  overview: boolean; /** The dialog one of the rail's two entries has open. */ showing: "system" | "settings" | null;
}) {
  const t = COPY[lang];
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focusField && open) ref.current?.querySelector<HTMLElement>('[data-ir-control="rail:field"]')?.focus();
  }, [focusField, open]);
  /* Only variant 3 has a closed rail. Variant 2 hides its rail whole (S1), as today's does, and one control brings it back. */
  if (!open && !collapsible) return null;
  if (!open) {
    return (
      <nav ref={ref} className="ir-rail ir-rail-closed" data-ir-rail="closed" aria-label={t.projects}>
        <button type="button" className="ir-tile" aria-current={overview ? "page" : undefined} aria-label={t.overview} title={t.overview} data-ir-control="rail:overview"><LayoutGrid aria-hidden /></button>
        <div className="ir-rail-rule" />
        {[...PROJECTS].sort((a, b) => Number(b.crowned) - Number(a.crowned)).map((project) => (
          <button key={project.name} type="button" className="ir-tile ir-monogram" aria-current={!overview && project.name === "atlas" ? "page" : undefined} aria-label={project.name} title={project.name} data-ir-control={`rail:project:${project.name}`}>
            {project.name.slice(0, 2)}
            {project.needs ? <i className="ir-badge" aria-hidden /> : project.live ? <i className="ir-badge ir-badge-live" aria-hidden /> : null}
          </button>
        ))}
        <button type="button" className="ir-tile" aria-label={t.newProject} title={t.newProject} data-ir-control="rail:new-project"><Plus aria-hidden /></button>
        <span className="ir-grow" />
        <button type="button" className="ir-tile" aria-haspopup="dialog" aria-expanded={showing === "system"} aria-label={t.systemAria(tightestLimit())} title={t.system} data-ir-control="rail:system" onClick={(event) => onSystem(event.currentTarget)}><Ring left={tightestLimit()} /></button>
        <button type="button" className="ir-tile" aria-haspopup="dialog" aria-expanded={showing === "settings"} aria-label={t.settings} title={t.settings} data-ir-control="rail:settings" onClick={(event) => onSettings(event.currentTarget)}><Gear aria-hidden /></button>
        <button type="button" className="ir-tile" aria-label={t.expand} title={t.expand} data-ir-control="rail:toggle" onClick={onToggle}><PanelLeftOpen aria-hidden /></button>
      </nav>
    );
  }
  return (
    <nav ref={ref} className="ir-rail" data-ir-rail="open" aria-label={t.projects}>
      <div className="ir-rail-top">
        <Field lang={lang} name="rail" value={query} onChange={setQuery} placeholder={t.filter} />
        <button type="button" className="ir-icon" aria-label={t.newProject} title={t.newProject} data-ir-control="rail:new-project"><Plus aria-hidden /></button>
      </div>
      <div className="ir-rail-list"><ProjectRows lang={lang} name="rail" query={query} overview={overview} /></div>
      <button type="button" className="ir-row ir-status" aria-haspopup="dialog" aria-expanded={showing === "system"} aria-label={t.systemAria(tightestLimit())} data-ir-control="rail:system" onClick={(event) => onSystem(event.currentTarget)}>
        <Ring left={tightestLimit()} />
        <span className="ir-row-label">{t.system}<span className="ir-sub">{LIMITS.map((limit) => `${limit.engine} ${Math.min(...limit.windows.map((window) => window.left))}%`).join(" · ")}</span></span>
      </button>
      <div className="ir-rail-foot">
        <button type="button" className="ir-row" aria-haspopup="dialog" aria-expanded={showing === "settings"} data-ir-control="rail:settings" onClick={(event) => onSettings(event.currentTarget)}><Gear className="ir-ico" aria-hidden /><span className="ir-row-label">{t.settings}</span></button>
        <button type="button" className="ir-icon" aria-label={collapsible ? t.collapse : t.hide} title={collapsible ? t.collapse : t.hide} data-ir-control="rail:toggle" onClick={onToggle}><PanelLeftClose aria-hidden /></button>
      </div>
    </nav>
  );
}

/* ── The phone's sheets ────────────────────────────────────────────────── */

/** What the prototype draws in a phone sheet: a regrouped menu, the project palette, or Settings opened from either. */
type PhoneSheetState = {
  sheet: "menu" | "projects"; menu: string | null; view: "settings" | null; scope: "project" | "delegatus";
  /** The screen the sheet was opened on. On the Overview no project is chosen, so nothing in the sheet may act on one. */
  place: "project" | "overview";
  /** The Overview draws its board (and so has hidden work to show) only when something is on it. */
  board: boolean;
};
/** The phone's Overview and a project's board are both the "board" screen; only the Overview carries its own search control. */
const isOverviewScreen = (screen: Element | null) => Boolean(screen?.querySelector('[data-testid="overview-search"]'));
const phonePlace = (trigger: HTMLElement): Pick<PhoneSheetState, "place" | "board"> => {
  const screen = trigger.closest("[data-mobile2-screen]");
  return { place: isOverviewScreen(screen) ? "overview" : "project", board: Boolean(screen?.querySelector("[data-phone-kanban]")) };
};

/**
 * The product's `MobileSheet`, opened through `mobileNav` under the name the
 * product itself uses ("menu", "projects"). The product renders its own sheet
 * for that name too; the prototype's stylesheet hides it while this one is up.
 * This one mounts a commit later, so it is the top modal layer and owns Tab and
 * Escape.
 */
function PhoneSheet({ state, title, extra, onClose, children }: { state: PhoneSheetState; title: string; extra?: ReactNode; onClose: () => void; children: ReactNode }) {
  useLayoutEffect(() => {
    document.documentElement.dataset.irPhoneSheet = state.sheet;
    return () => { delete document.documentElement.dataset.irPhoneSheet; };
  }, [state.sheet]);
  return createPortal(
    <div data-ir-own="" data-ir-layer={`sheet-${state.menu ?? state.sheet}`}>
      <MobileSheet name={state.sheet} title={title} extra={extra} onClose={onClose}>
        <div data-ir-sheet-name={state.view === "settings" ? "settings" : state.menu ? `menu-${state.menu}` : "palette"}>{children}</div>
      </MobileSheet>
    </div>,
    document.body,
  );
}

/* ── The variant around the real Viewer ────────────────────────────────── */

/** Inside a frame: the real Viewer, with the variant's chrome around it. */
export function InterfaceRedesignInner({ variant, children }: { variant: RedesignVariant; children: ReactNode }) {
  const lang = currentLang();
  const t = COPY[lang];
  const phone = useIsMobile();
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const noRail = variant === 1 || variant === 7;
  const ownRail = variant === 2 || variant === 3;
  const direction: "A" | "B" | null = variant === 4 ? "A" : variant === 5 || variant === 7 ? "B" : null;
  const menus = direction === "A" ? MENUS_A : MENUS_B;
  const glass = variant === 6 || variant === 7;
  const [open, setOpen] = useState<Open>(null);
  const [railOpen, setRailOpen] = useState(variant === 2 || params.get("rail") === "open");
  const [railField, setRailField] = useState(0);
  const close = useCallback(() => setOpen(null), []);
  const nav = useMobileNavStore();
  const navState = useMobileNav();
  const [phoneSheet, setPhoneSheet] = useState<PhoneSheetState | null>(null);

  useLayoutEffect(() => {
    /* Menus and sheets are portalled to the body, outside this wrapper. */
    if (glass) document.documentElement.dataset.irGlass = "";
  }, [glass]);

  /* An intercepted product trigger says it is expanded while its surface is open, and collapsed once it has closed.
     What it said before the prototype touched it comes back when the prototype goes. */
  const expandedWas = useRef(new Map<HTMLElement, string | null>());
  useEffect(() => {
    const trigger = open?.returnTo;
    if (!trigger || trigger.dataset.irControl) return;
    if (!expandedWas.current.has(trigger)) expandedWas.current.set(trigger, trigger.getAttribute("aria-expanded"));
    trigger.setAttribute("aria-expanded", "true");
    return () => trigger.setAttribute("aria-expanded", "false");
  }, [open]);
  useEffect(() => {
    const touched = expandedWas.current;
    return () => {
      for (const [trigger, value] of touched) {
        if (value === null) trigger.removeAttribute("aria-expanded");
        else trigger.setAttribute("aria-expanded", value);
      }
    };
  }, []);
  /* Each of them opens a dialog here (a menu, Settings), where the product declares a menu. */
  useDialogTriggers(direction !== null && !phone, "[data-bar-more], .kb .card [data-menu], [data-rail-menu]");
  useNoticeBand((noRail || ownRail) && !phone);
  const overviewHere = useOverviewHere(!phone);

  /* The phone: the sheet is the product's, so leaving it by Back, the handle, the scrim or × ends it here too. */
  const lastNavSheet = useRef(navState.sheet);
  useEffect(() => {
    if (phoneSheet && lastNavSheet.current === phoneSheet.sheet && navState.sheet !== phoneSheet.sheet) setPhoneSheet(null);
    lastNavSheet.current = navState.sheet;
  }, [navState.sheet, phoneSheet]);
  const [sheetReady, setSheetReady] = useState(false);
  /* A commit after the product's own sheet mounted, so this one is pushed above it on the modal-layer stack. */
  useEffect(() => {
    const ready = Boolean(phoneSheet) && navState.sheet === phoneSheet?.sheet;
    const timer = window.setTimeout(() => setSheetReady(ready), 0);
    return () => window.clearTimeout(timer);
  }, [phoneSheet, navState.sheet]);
  /* A row that changes the sheet's face or opens Settings in it moves focus to the new content's first control. */
  const face = phoneSheet && sheetReady ? `${phoneSheet.menu}:${phoneSheet.view}` : null;
  const lastFace = useRef<string | null>(null);
  useEffect(() => {
    if (face && lastFace.current && lastFace.current !== face) firstTabbable(document.querySelector("[data-ir-own] [data-mobile2-sheet-body]"))?.focus();
    lastFace.current = face;
  }, [face]);
  const openPhone = (next: PhoneSheetState) => {
    setPhoneSheet(next);
    if (navState.sheet !== next.sheet) nav.openSheet(next.sheet);
  };

  /* The existing menu buttons answer with the regrouped menus. */
  const anchorOf = (trigger: HTMLElement) => trigger.getBoundingClientRect();
  useIntercept(direction !== null && !phone, "[data-bar-more]", (trigger) => setOpen({ kind: "menu", menu: "board", anchor: anchorOf(trigger), returnTo: trigger }));
  useIntercept(direction !== null && !phone, ".kb .card [data-menu]", (trigger) => setOpen({ kind: "menu", menu: "card", anchor: anchorOf(trigger), returnTo: trigger }));
  useIntercept(direction === "A" && !phone, "[data-rail-menu]", (trigger) => setOpen({ kind: "menu", menu: "rail", anchor: anchorOf(trigger), returnTo: trigger }));
  useIntercept(direction === "B" && !phone, "[data-rail-menu]", (trigger) => setOpen({ kind: "settings", anchor: null, scope: "delegatus", project: !overviewHere, returnTo: trigger }));
  /* The phone's "⋯" belongs to the screen it is on. The Overview is a "board" screen with no project chosen:
     it has its own menu, as today's does. A pipeline's menu (W10) is left as it is. */
  const PHONE_MENUS: Record<string, string> = { board: "phoneBoard", chat: "phoneConversation", task: "phoneTask" };
  useIntercept(direction !== null && phone, '[data-mobile2-open="menu"]', (trigger) => {
    const screen = trigger.closest<HTMLElement>("[data-mobile2-screen]")?.dataset.mobile2Screen ?? "";
    const where = phonePlace(trigger);
    const menu = screen === "board" && where.place === "overview" ? "phoneOverview" : PHONE_MENUS[screen];
    if (!menu) return false;
    openPhone({ sheet: "menu", menu, view: null, scope: where.place === "overview" ? "delegatus" : "project", ...where });
  });
  /* A pipeline's menu keeps its own face; its "Board menu" row leads to the regrouped board menu. */
  useIntercept(direction !== null && phone, '[data-mobile2-pipeline-menu] [data-mobile2-menu-row="board"]', () => openPhone({ sheet: "menu", menu: "phoneBoard", view: null, scope: "project", place: "project", board: true }));
  /* The phone's title already opens the projects; the sidebar variants give that sheet the rail's missing functions. */
  useIntercept((noRail || ownRail) && phone, '[data-mobile2-title][data-mobile2-open="projects"]', (trigger) => openPhone({ sheet: "projects", menu: null, view: null, scope: "delegatus", ...phonePlace(trigger) }));

  /* Variants 1 and 7 on the desktop: the header's title is the switcher, and one
     chip is the system. Every header that names where the operator is carries
     them: the project board's, the bar of a loading or empty project, and the
     Overview's title row (with or without a board under it). */
  /* The rail's toggle is a different button open and closed (in variant 2, hidden: the one restore control); focus moves to the new one. */
  const toggled = useRef(false);
  const [lead, leadHost] = useSlot(noRail && !phone, LEADS);
  const [status] = useSlot(noRail && !phone, STATUS_SLOTS);
  useEffect(() => {
    if (phone || !(noRail || ownRail)) return;
    const onKey = (event: KeyboardEvent) => {
      const typing = (event.target as HTMLElement | null)?.closest("input, textarea, [contenteditable]");
      const bare = !typing && !event.ctrlKey && !event.metaKey && !event.altKey;
      const find = event.key.toLowerCase() === "k" && (event.ctrlKey || event.metaKey);
      const toggle = event.key.toLowerCase() === "b" && bare;
      const slash = event.key === "/" && bare && variant === 3;
      if (!find && !toggle && !slash) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (noRail) {
        const active = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
        const entry = document.querySelector<HTMLElement>('[data-ir-control="shell:project"]');
        setOpen((was) => (was?.kind === "palette" ? null : { kind: "palette", anchor: entry?.getBoundingClientRect() ?? null, returnTo: active ?? entry }));
      } else if (toggle) {
        /* B is the toggle's key: focus follows it to the control that undoes it, as a press of the control does. */
        toggled.current = true;
        setRailOpen(!railOpen);
      } else {
        setRailOpen(true);
        setRailField((count) => count + 1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [phone, noRail, ownRail, variant, railOpen]);
  useEffect(() => {
    if (!toggled.current) return;
    toggled.current = false;
    document.querySelector<HTMLElement>('[data-ir-control="rail:toggle"]')?.focus();
  }, [railOpen]);

  /** A row that leads somewhere: Settings in direction B, the board menu from a task or a conversation. */
  const rowAction = (surface: "desktop" | "phone", menu: string): RowAction => (entry) => {
    if (direction === "B" && (entry.key === "settings-project" || entry.key === "settings")) {
      const scope = entry.key === "settings-project" || (menu.startsWith("phone") && menu !== "phoneOverview") ? "project" : "delegatus";
      if (surface === "phone") setPhoneSheet((was) => (was ? { ...was, view: "settings", scope } : was));
      else setOpen((was) => ({ kind: "settings", anchor: null, scope, project: !overviewHere, returnTo: was?.returnTo ?? null }));
      return true;
    }
    if (entry.face && surface === "phone") { setPhoneSheet((was) => (was ? { ...was, menu: entry.face!, view: null } : was)); return true; }
    return false;
  };

  const openSystem = (trigger: HTMLElement) => setOpen({ kind: "system", anchor: trigger.getBoundingClientRect(), returnTo: trigger });
  const openSettings = (trigger: HTMLElement | null) => setOpen((was) => direction === "B"
    ? { kind: "settings", anchor: null, scope: "delegatus", project: !overviewHere, returnTo: trigger ?? was?.returnTo ?? null }
    : { kind: "menu", menu: "rail", anchor: trigger?.getBoundingClientRect() ?? new DOMRect(8, 8, 0, 0), returnTo: trigger ?? was?.returnTo ?? null });
  const railMenu = MENUS_A.rail!;
  const flatSettings = [...railMenu.promoted, ...railMenu.rows.flatMap((entry) => entry.into ?? [entry])];

  /* Direction B puts rename and crown in the conversation sheet's header, beside its title. */
  const titleControls = (
    <span className="ir-title-row" data-ir-title-refs={B_CONVERSATION_TITLE_REFS.join(",")}>
      <button type="button" className="ir-quiet" data-ir-control="phoneConversation:rename">{t.rename}</button>
      <button type="button" className="ir-icon ir-crown" aria-pressed="false" aria-label={t.crownConv} data-ir-control="phoneConversation:crown"><Crown aria-hidden /></button>
    </span>
  );

  let surface: ReactNode = null;
  if (!phone && open?.kind === "menu") {
    const source = open.menu === "rail" ? MENUS_A : menus;
    const menu = source[open.menu]!;
    surface = (
      <Surface key={`menu-${open.menu}`} open={open} width={open.menu === "card" ? 300 : 280} label={menu.title[lang]} onClose={close} name={`menu-${open.menu}`}>
        <MenuView menu={menu} name={open.menu} lang={lang} onRow={rowAction("desktop", open.menu)} />
      </Surface>
    );
  } else if (!phone && open?.kind === "palette") {
    surface = (
      <Surface key="palette" open={open} width={380} label={t.goTo} onClose={close} name="palette">
        <Palette lang={lang} phone={false} onSettings={() => openSettings(null)} settingsRows={direction === "B" ? null : flatSettings} overview={overviewHere} />
      </Surface>
    );
  } else if (!phone && open?.kind === "system") {
    surface = <Surface key="system" open={open} width={320} label={t.system} onClose={close} name="system"><SystemPanel lang={lang} /></Surface>;
  } else if (!phone && open?.kind === "settings") {
    surface = <Surface key="settings" open={open} width={Math.min(720, innerWidth - 32)} label={t.settings} onClose={close} name="settings"><SettingsPlace lang={lang} phone={false} scope={open.scope ?? "delegatus"} withProject={open.project !== false} onClose={close} /></Surface>;
  }

  let sheet: ReactNode = null;
  if (phone && phoneSheet && sheetReady && navState.sheet === phoneSheet.sheet) {
    const closeSheet = () => nav.closeSheet();
    /* The product's own sheet title (the task's or the conversation's title, the project) heads the regrouped menu. */
    const productTitle = document.querySelector(`[data-mobile2-sheet="${phoneSheet.sheet}"] [data-mobile2-sheet-header] h2`)?.textContent ?? null;
    const whole = phoneSheet.menu ? menus[phoneSheet.menu] ?? null : null;
    /* An Overview with nothing on it draws no board, and so has no hidden work to open. */
    const drawn = (rows: Row[]) => (phoneSheet.board ? rows : rows.filter((entry) => entry.key !== "hidden"));
    const menu = whole && phoneSheet.menu === "phoneOverview" ? { ...whole, promoted: drawn(whole.promoted), rows: drawn(whole.rows) } : whole;
    if (phoneSheet.view === "settings") {
      sheet = (
        <PhoneSheet state={phoneSheet} title={t.settings} onClose={closeSheet}>
          <SettingsPlace lang={lang} phone scope={phoneSheet.scope} withProject={phoneSheet.place === "project"} onClose={closeSheet} backLabel={menu?.title[lang] ?? t.projects} onBack={() => setPhoneSheet((was) => (was ? { ...was, view: null } : was))} />
        </PhoneSheet>
      );
    } else if (menu && phoneSheet.menu) {
      const title = phoneSheet.menu === "phoneBoard" || phoneSheet.menu === "phoneOverview" ? menu.title[lang] : productTitle ?? menu.title[lang];
      sheet = (
        <PhoneSheet state={phoneSheet} title={title} onClose={closeSheet} extra={direction === "B" && phoneSheet.menu === "phoneConversation" ? titleControls : undefined}>
          <MenuView key={phoneSheet.menu} menu={menu} name={phoneSheet.menu} lang={lang} onRow={rowAction("phone", phoneSheet.menu)} />
        </PhoneSheet>
      );
    } else if (phoneSheet.sheet === "projects") {
      sheet = (
        <PhoneSheet state={phoneSheet} title={productTitle ?? t.projects} onClose={closeSheet}>
          <Palette lang={lang} phone onSettings={() => setPhoneSheet((was) => (was ? { ...was, view: "settings", scope: "delegatus" } : was))} settingsRows={direction === "B" ? null : flatSettings} overview={phoneSheet.place === "overview"} />
        </PhoneSheet>
      );
    }
  }

  const atlas = PROJECTS[0]!;
  const others = PROJECTS.slice(1).reduce((sum, project) => sum + project.needs, 0);
  const where = leadHost === "overview" ? t.overview : atlas.name;
  return (
    <div data-ir-inner={variant} data-ir-shell={noRail ? "none" : ownRail ? "own" : "today"} className="ir-root">
      <style>{CSS}</style>
      {ownRail && !phone ? (
        <Rail
          lang={lang} collapsible={variant === 3} open={railOpen} focusField={railField} overview={overviewHere}
          showing={open?.kind === "system" ? "system" : open?.kind === "settings" || (open?.kind === "menu" && open.menu === "rail") ? "settings" : null}
          onToggle={() => { toggled.current = true; setRailOpen((was) => !was); }}
          onSystem={openSystem} onSettings={openSettings}
        />
      ) : null}
      {ownRail && !phone && variant === 2 && !railOpen ? (
        <div className="ir-restore" data-ir-rail="hidden"><button type="button" className="ir-icon" aria-label={t.expand} title={t.expand} data-ir-control="rail:toggle" onClick={() => { toggled.current = true; setRailOpen(true); }}><PanelLeftOpen aria-hidden /></button></div>
      ) : null}
      <div data-ir-stage="" className="ir-stage">{children}</div>
      {lead ? createPortal(
        <button type="button" className="ir-switch-title" aria-haspopup="dialog" aria-expanded={open?.kind === "palette"} aria-label={t.switchProject(where)} data-ir-control="shell:project" data-ir-where={leadHost ?? ""} onClick={(event) => setOpen({ kind: "palette", anchor: event.currentTarget.getBoundingClientRect(), returnTo: event.currentTarget })}>
          <span>{where}</span>
          {others && leadHost !== "overview" ? <i className="ir-badge-inline" title={t.needs(others)} aria-hidden /> : null}
          <ChevronDown aria-hidden />
        </button>,
        lead,
      ) : null}
      {status ? createPortal(
        <button type="button" className="ir-system-chip" aria-haspopup="dialog" aria-expanded={open?.kind === "system"} aria-label={t.systemAria(tightestLimit())} title={t.system} data-ir-control="shell:system" onClick={(event) => openSystem(event.currentTarget)}>
          <Ring left={tightestLimit()} /><span>{tightestLimit()}%</span>
        </button>,
        status,
      ) : null}
      {surface}
      {sheet}
    </div>
  );
}

/* ── Styles ────────────────────────────────────────────────────────────── */

const CSS = `
.ir-root { display: flex; height: 100%; min-height: 0; min-width: 0; }
.ir-stage { flex: 1 1 0; min-width: 0; min-height: 0; }
/* A variant with its own navigation puts the real rail and its restore control away. */
[data-ir-shell="none"] .ir-stage > div > aside, [data-ir-shell="own"] .ir-stage > div > aside,
[data-ir-shell="none"] [data-rail-restore], [data-ir-shell="own"] [data-rail-restore] { display: none; }
[data-ir-shell="none"] .ir-stage > div > div:has(> [data-rail-restore]), [data-ir-shell="own"] .ir-stage > div > div:has(> [data-rail-restore]) { display: none; }
[data-ir-shell="none"] :is([data-bar="project"], [data-project-bar]) [data-bar-group="where"] > h1, [data-ir-shell="none"] ${OVERVIEW_TITLE_ROW} > h1 { display: none; }
/* The attention notice's band (useNoticeBand): a row of the layout under the
   header, present while a notice is shown. The notice is pinned to it and
   drawn as one line (its question, then the conversation's title), so the row
   is 44 px. Nothing else is in the row, whatever the header's height. */
[data-ir-notice-band] { flex-shrink: 0; box-sizing: border-box; border-bottom: 1px solid var(--border-default); background: var(--surface-card); }
html[data-ir-notice-band] [data-attention-toast] { position: fixed; top: var(--ir-notice-top); right: var(--ir-notice-right); max-width: min(560px, var(--ir-notice-max)); align-items: center; padding: 3px 6px 3px 12px; box-shadow: none; }
html[data-ir-notice-band] [data-attention-toast-open] { display: flex; align-items: baseline; gap: 8px; white-space: nowrap; }
html[data-ir-notice-band] [data-attention-toast-open] > span { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
html[data-ir-notice-band] [data-attention-toast-title] { flex-shrink: 0; }
html[data-ir-notice-band] [data-attention-toast-dismiss] { margin-top: 0; }
/* A phone sheet the prototype draws is the product's MobileSheet under the product's own name; the product's copy of that sheet waits hidden under it. */
html[data-ir-phone-sheet] [data-mobile2-scrim]:not([data-ir-own] > [data-mobile2-scrim]) { display: none; }

.ir-root, [data-ir-layer] { --ir-row: 32px; --ir-pad: 10px; --ir-font: var(--text-ui); --ir-radius: var(--radius-control); }
@media (pointer: coarse) { .ir-root, [data-ir-layer] { --ir-row: 48px; --ir-pad: 14px; --ir-font: 15px; --ir-radius: 12px; } }
[data-ir-layer] { font-family: var(--font-sans); color: var(--color-primary); }

/* Header controls of variant 1 */
.ir-switch-title { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 8px; margin-left: -8px; border-radius: var(--radius-control); font-size: 13.5px; font-weight: 700; color: var(--color-primary); white-space: nowrap; }
.ir-switch-title:hover, .ir-switch-title[aria-expanded="true"] { background: var(--surface-well); }
.ir-switch-title svg { width: 14px; height: 14px; color: var(--color-muted); }
.ir-badge-inline { width: 7px; height: 7px; border-radius: 50%; background: var(--color-warning); }
.ir-system-chip { display: inline-flex; flex-shrink: 0; align-items: center; gap: 6px; height: 32px; padding: 0 9px; border-radius: 999px; border: 1px solid var(--border-default); font-size: var(--text-ui); font-weight: 600; color: var(--color-secondary); font-variant-numeric: tabular-nums; }
.ir-system-chip:hover, .ir-system-chip[aria-expanded="true"] { background: var(--surface-well); color: var(--color-primary); }
.ir-ring { width: 16px; height: 16px; flex-shrink: 0; border-radius: 50%; background: conic-gradient(var(--color-accent) var(--ir-left), var(--color-muted) 0); -webkit-mask: radial-gradient(circle, transparent 4.5px, black 5px); mask: radial-gradient(circle, transparent 4.5px, black 5px); }
.ir-switch-title:focus-visible, .ir-system-chip:focus-visible, [data-ir-layer] button:focus-visible, .ir-rail button:focus-visible, .ir-field input:focus-visible { outline: 2px solid color-mix(in srgb, var(--color-accent) 55%, transparent); outline-offset: 1px; }

/* Surfaces */
.ir-scrim { position: fixed; inset: 0; }
.ir-scrim-dim { background: rgb(20 20 30 / 0.32); }
.ir-surface { position: fixed; display: flex; flex-direction: column; overflow: hidden; background: var(--surface-raised); border: 1px solid var(--border-default); box-shadow: var(--shadow-2); }
.ir-pop { border-radius: var(--radius-surface); animation: ir-in var(--motion-base) var(--ease-standard); }
.ir-surface:focus { outline: none; }
@keyframes ir-in { from { opacity: 0; transform: translateY(-4px) scale(0.98); } }
@media (prefers-reduced-motion: reduce) { .ir-pop { animation: none; } }
.ir-menu-body { display: flex; flex-direction: column; min-height: 0; overflow-y: auto; padding: 6px; }
.ir-scroll { min-height: 0; overflow-y: auto; }
.ir-menu-body:has(> .ir-scroll) { overflow: hidden; }
.ir-row { display: flex; flex-shrink: 0; align-items: center; gap: 8px; width: 100%; min-height: var(--ir-row); padding: 0 var(--ir-pad); border-radius: var(--ir-radius); font-size: var(--ir-font); text-align: left; color: var(--color-primary); }
button.ir-row:hover, button.ir-row[aria-current="page"] { background: var(--surface-well); }
.ir-row-label { min-width: 0; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ir-trail, .ir-count { flex-shrink: 0; font-size: var(--text-label); color: var(--color-muted); font-variant-numeric: tabular-nums; }
@media (pointer: coarse) { .ir-trail, .ir-count { font-size: 13px; } }
.ir-chev { width: 14px; height: 14px; flex-shrink: 0; color: var(--color-muted); }
.ir-ico { width: 15px; height: 15px; flex-shrink: 0; color: var(--color-muted); }
.ir-danger { color: var(--color-danger); }
.ir-back { font-weight: 700; }
.ir-rule { height: 1px; flex-shrink: 0; margin: 6px 4px; background: var(--border-default); }
.ir-head { padding: 8px var(--ir-pad) 4px; font-size: var(--text-label); font-weight: 600; color: var(--color-muted); }
.ir-inset { padding-left: 14px; }
.ir-promoted-row { display: grid; gap: 6px; padding: 2px; }
.ir-promoted { justify-content: center; min-height: calc(var(--ir-row) + 12px); border: 1px solid var(--border-default); background: var(--surface-card); font-weight: 600; text-align: center; }
.ir-promoted .ir-row-label { flex: 0 1 auto; white-space: normal; line-height: 1.2; }
.ir-promoted-toggle { justify-content: space-between; text-align: left; }
.ir-choice { justify-content: space-between; }
.ir-choice .ir-row-label { flex: 0 1 auto; }
.ir-choice-wide { flex-direction: column; align-items: stretch; gap: 4px; padding-top: 4px; padding-bottom: 6px; }
.ir-choice-wide .ir-row-label { font-size: var(--text-label); font-weight: 600; color: var(--color-muted); }
.ir-segment { display: inline-flex; flex-shrink: 0; padding: 2px; border-radius: var(--ir-radius); background: var(--surface-well); }
.ir-choice-wide .ir-segment { display: flex; }
.ir-segment button { flex: 1 1 0; min-height: calc(var(--ir-row) - 6px); padding: 0 9px; border-radius: calc(var(--ir-radius) - 2px); font-size: var(--text-ui); font-weight: 600; color: var(--color-secondary); white-space: nowrap; }
/* The chosen segment is told by an accent edge as well as by its fill, so the state reads at 3:1. */
.ir-segment button[aria-pressed="true"] { background: var(--surface-card); color: var(--color-primary); box-shadow: inset 0 0 0 1.5px var(--color-accent), var(--shadow-1); }
.ir-chips { display: inline-flex; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.ir-chips button { min-height: calc(var(--ir-row) - 8px); padding: 0 10px; border-radius: 999px; border: 1px solid var(--border-default); font-size: var(--text-ui); font-weight: 600; color: var(--color-primary); }
.ir-chips button.ir-swatch { width: 24px; min-height: 24px; padding: 0; border: 0; background: oklch(0.68 0.13 calc(var(--ir-hue) * 1deg)); }
.ir-chips button.ir-swatch:first-child { background: none; border: 1.5px dashed var(--color-muted); }
.ir-chips button[aria-pressed="true"] { border-color: var(--color-accent); box-shadow: inset 0 0 0 1px var(--color-accent); }
.ir-chips button.ir-swatch[aria-pressed="true"] { box-shadow: 0 0 0 2px var(--surface-raised), 0 0 0 3.5px var(--color-accent); }
@media (pointer: coarse) {
  .ir-chips button { min-height: 44px; min-width: 44px; }
  .ir-segment button { min-height: 44px; min-width: 44px; }
  /* Nine 44 px swatches do not fit beside a label on a phone: they wrap under it. */
  .ir-choice:has(> .ir-chips) { flex-wrap: wrap; padding-top: 6px; padding-bottom: 6px; }
  .ir-choice > .ir-chips { flex: 1 1 100%; justify-content: flex-start; }
  .ir-chips button.ir-swatch { width: 44px; min-height: 44px; }
}
/* The track is the control's edge: muted ink off, accent on, both at 3:1 or more on the menu. */
.ir-switch { position: relative; width: 30px; height: 18px; flex-shrink: 0; border-radius: 999px; background: var(--color-muted); transition: background var(--motion-fast); }
.ir-switch::after { content: ""; position: absolute; left: 2px; top: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--surface-card); transition: transform var(--motion-fast) var(--ease-standard); }
[aria-checked="true"] > .ir-switch { background: var(--color-accent); }
[aria-checked="true"] > .ir-switch::after { transform: translateX(12px); }
@media (prefers-reduced-motion: reduce) { .ir-switch, .ir-switch::after { transition: none; } }
.ir-icon { display: inline-flex; flex-shrink: 0; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: var(--radius-control); color: var(--color-muted); }
.ir-icon:hover { background: var(--surface-well); color: var(--color-primary); }
.ir-icon svg { width: 15px; height: 15px; }
@media (pointer: coarse) { .ir-icon { width: 44px; height: 44px; } .ir-icon svg { width: 20px; height: 20px; } }
.ir-quiet { flex-shrink: 0; min-height: 24px; padding: 0 9px; border-radius: 999px; border: 1px solid var(--border-default); font-size: var(--text-label); font-weight: 600; color: var(--color-primary); }
@media (pointer: coarse) { .ir-quiet { min-height: 44px; padding: 0 14px; font-size: 13px; } }
.ir-line { display: flex; flex-shrink: 0; align-items: center; gap: 8px; min-height: var(--ir-row); padding: 0 var(--ir-pad); font-size: var(--ir-font); }
.ir-sub { display: block; font-size: var(--text-label); font-weight: 400; color: var(--color-muted); overflow: hidden; text-overflow: ellipsis; }
.ir-sub-inline { font-size: var(--text-label); font-weight: 400; color: var(--color-muted); }
.ir-title-row { display: inline-flex; flex-shrink: 0; align-items: center; gap: 4px; }

/* Projects */
.ir-project-line { display: flex; flex-shrink: 0; align-items: center; gap: 2px; }
.ir-project-line > .ir-row { flex: 1 1 auto; min-width: 0; width: auto; }
.ir-project { min-height: calc(var(--ir-row) + 8px); font-weight: 600; }
.ir-archived { font-weight: 400; color: var(--color-secondary); }
.ir-dot { width: 8px; height: 8px; flex-shrink: 0; border-radius: 50%; background: var(--border-strong); }
.ir-dot-live { background: var(--color-success); }
.ir-needs { flex-shrink: 0; min-width: 18px; padding: 0 5px; border-radius: 999px; background: var(--color-warning-soft); color: var(--color-warning); font-size: var(--text-label); font-weight: 700; line-height: 18px; text-align: center; }
/* The crown is a control drawn as an icon: its outline is muted ink at rest; pinned, a gold fill inside a warning-ink outline, so both states read at 3:1. */
.ir-crown { color: var(--color-muted); }
.ir-crown[aria-pressed="true"] { color: var(--color-warning); }
.ir-crown[aria-pressed="true"] svg { fill: var(--color-crown); }
.ir-field { position: relative; display: flex; flex: 0 0 auto; align-items: center; min-width: 0; margin: 2px 2px 4px; }
.ir-rail-top > .ir-field { flex: 1 1 0; }
.ir-field .ir-ico { position: absolute; left: 10px; pointer-events: none; }
.ir-field input { width: 100%; min-width: 0; height: calc(var(--ir-row) + 2px); padding: 0 10px 0 32px; border: 1px solid var(--border-default); border-radius: var(--ir-radius); background: var(--surface-sunken); font-size: var(--ir-font); color: var(--color-primary); }
.ir-field input::placeholder { color: var(--color-muted); }
.ir-field kbd { position: absolute; right: 8px; padding: 0 5px; border: 1px solid var(--border-default); border-radius: 4px; font: 600 10px/16px var(--font-sans); color: var(--color-muted); pointer-events: none; }
.ir-field:has(kbd) input { padding-right: 56px; }

/* System panel */
.ir-meter-row { align-items: stretch; flex-direction: column; gap: 8px; padding-top: 8px; padding-bottom: 8px; }
.ir-meter { display: grid; grid-template-columns: 1fr auto; gap: 4px 8px; font-size: var(--text-label); }
.ir-meter b { font-weight: 600; }
.ir-meter span { color: var(--color-muted); font-variant-numeric: tabular-nums; }
.ir-meter i { grid-column: 1 / -1; height: 3px; border-radius: 2px; background: linear-gradient(to right, var(--color-accent) var(--ir-fill), var(--border-default) 0); }

/* The Settings place */
.ir-settings { display: flex; flex-direction: column; min-height: 0; flex: 1 1 auto; }
.ir-settings-bar { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; padding: 8px 8px 8px 16px; border-bottom: 1px solid var(--border-default); }
.ir-settings-title { font-size: var(--text-title); font-weight: 700; }
.ir-settings-panes { display: grid; grid-template-columns: 220px minmax(0, 1fr); min-height: 380px; }
.ir-settings-nav { padding: 6px; overflow-y: auto; }
.ir-settings-panes .ir-settings-nav { border-right: 1px solid var(--border-default); background: var(--surface-sunken); }
.ir-settings-rows { padding: 6px 10px 12px; overflow-y: auto; }
.ir-settings-rows > .ir-settings-title { display: block; padding: 8px var(--ir-pad) 6px; }
.ir-settings-phone .ir-settings-nav, .ir-settings-phone .ir-settings-rows { flex: 1 1 auto; min-height: 0; }

/* The prototype's rail */
.ir-rail { display: flex; flex-direction: column; flex-shrink: 0; width: 208px; min-height: 0; border-right: 1px solid var(--border-default); background: var(--surface-card); font-family: var(--font-sans); }
.ir-rail-top { display: flex; flex-shrink: 0; align-items: center; gap: 4px; padding: 6px 6px 2px; }
.ir-rail-list { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; overflow-y: auto; padding: 2px 6px; }
.ir-status { flex-shrink: 0; width: auto; min-height: 44px; margin: 0 6px; border-top: 1px solid var(--border-default); border-radius: 0; padding: 4px var(--ir-pad); }
.ir-status:hover { border-radius: var(--ir-radius); }
.ir-rail-foot { display: flex; flex-shrink: 0; align-items: center; gap: 4px; padding: 2px 6px 6px; }
.ir-rail-foot > .ir-row { flex: 1 1 0; width: auto; min-width: 0; }
.ir-rail-closed { width: 52px; align-items: center; gap: 4px; padding: 8px 0; }
.ir-tile { position: relative; display: inline-flex; flex-shrink: 0; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 10px; color: var(--color-secondary); font-size: var(--text-ui); font-weight: 700; text-transform: lowercase; }
.ir-tile:hover { background: var(--surface-well); color: var(--color-primary); }
.ir-tile svg { width: 17px; height: 17px; }
.ir-monogram { background: var(--surface-well); }
.ir-monogram[aria-current="page"] { background: var(--color-accent-soft); color: var(--color-accent); box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--color-accent) 55%, transparent); }
.ir-badge { position: absolute; right: -2px; top: -2px; width: 9px; height: 9px; border-radius: 50%; background: var(--color-warning); box-shadow: 0 0 0 2px var(--surface-card); }
.ir-badge-live { background: var(--color-success); }
.ir-rail-rule { width: 24px; height: 1px; margin: 2px 0; background: var(--border-default); }
.ir-grow { flex: 1 1 auto; }
.ir-restore { display: flex; flex-shrink: 0; padding: 6px 4px; }

/* ── Glass (variants 6 and 7) ──────────────────────────────────────────── */
/* Navigation and menus are the glass layer; what is read (cards, the feed, the
   message field) stays opaque. No rule here changes a box: only fills, edges,
   radii and shadows, so the glass frame has today's geometry exactly. */
html[data-ir-glass] {
  --glass-fill: color-mix(in srgb, var(--surface-card) 70%, transparent);
  --glass-fill-strong: color-mix(in srgb, var(--surface-raised) 86%, transparent);
  --glass-well: color-mix(in srgb, var(--surface-card) 46%, transparent);
  --glass-edge: color-mix(in srgb, var(--color-primary) 10%, transparent);
  --glass-shine: inset 0 1px 0 rgb(255 255 255 / 0.6), inset 0 0 0 1px rgb(255 255 255 / 0.2);
  --glass-blur: blur(22px) saturate(1.7);
  --glass-blur-strong: blur(30px) saturate(1.8);
  --glass-shadow: 0 10px 34px rgb(30 24 60 / 0.13), 0 1px 2px rgb(30 24 60 / 0.06);
  --radius-control: 10px; --radius-surface: 16px;
  --ir-wash:
    radial-gradient(52% 44% at 6% -6%, oklch(0.9 0.07 55 / 0.9), transparent 70%),
    radial-gradient(46% 40% at 98% 2%, oklch(0.9 0.06 285 / 0.75), transparent 72%),
    radial-gradient(60% 50% at 60% 108%, oklch(0.92 0.05 165 / 0.6), transparent 70%),
    var(--surface-canvas);
}
@media (prefers-color-scheme: dark) {
  html[data-ir-glass]:not([data-theme="light"]) {
    --glass-fill: color-mix(in srgb, var(--surface-card) 64%, transparent);
    --glass-fill-strong: color-mix(in srgb, var(--surface-raised) 78%, transparent);
    --glass-well: color-mix(in srgb, var(--surface-card) 40%, transparent);
    --glass-edge: rgb(255 255 255 / 0.1);
    --glass-shine: inset 0 1px 0 rgb(255 255 255 / 0.1), inset 0 0 0 1px rgb(255 255 255 / 0.04);
    --glass-shadow: 0 12px 40px rgb(0 0 0 / 0.5), 0 1px 2px rgb(0 0 0 / 0.4);
    --ir-wash:
      radial-gradient(52% 44% at 6% -6%, oklch(0.42 0.09 50 / 0.6), transparent 70%),
      radial-gradient(46% 40% at 98% 2%, oklch(0.4 0.11 285 / 0.6), transparent 72%),
      radial-gradient(60% 50% at 60% 108%, oklch(0.38 0.07 175 / 0.45), transparent 70%),
      var(--surface-canvas);
  }
}
html[data-ir-glass] { --ir-muted-strong: color-mix(in srgb, var(--color-primary) 30%, var(--color-muted)); }
html[data-ir-glass] body { background: var(--ir-wash) fixed; }
html[data-ir-glass] :is(.kb, .kb .kb-page, .kb .board-frame, .kb .board, main, [data-mobile2-screen], [data-mobile2-body], [data-phone-kanban]) { background-color: transparent; }
/* The glass layer: rail, bars, the phone's dock. The blur is drawn by a layer
   under the bar's content: a backdrop filter on the bar itself would make it
   the containing block of the fixed notice it hosts and move that notice. */
html[data-ir-glass] :is(.ir-stage > div > aside, .ir-rail, .kb .bar, [data-mobile2-bar], [data-mobile2-dock]) {
  position: relative; background: transparent; border-color: var(--glass-edge);
}
html[data-ir-glass] :is(.ir-stage > div > aside, .ir-rail, .kb .bar, [data-mobile2-bar], [data-mobile2-dock])::before {
  content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none;
  background: var(--glass-fill); -webkit-backdrop-filter: var(--glass-blur); backdrop-filter: var(--glass-blur); box-shadow: var(--glass-shine);
}
html[data-ir-glass] :is(.ir-stage > div > aside, .ir-rail, .kb .bar[data-bar="overview"], [data-mobile2-bar], [data-mobile2-dock]) { isolation: isolate; }
/* A project's board header hosts the Viewer's island: the attention badge and
   the notice, fixed on layer 50. Isolating that header would trap the notice
   at the header's own level, under the orchestrator pane beside it. Its
   stacking context sits at the island's layer instead, so the notice stays
   above what it overlapped before. The Overview's island is outside its bar,
   so that bar is only isolated: on layer 50 it would cover the notice. */
html[data-ir-glass] .kb .bar[data-bar="project"] { z-index: ${BAR_ISLAND_LAYER}; }
html[data-ir-glass] .ir-stage > div > aside :is(header, [data-rail-footer], [data-rail-footer] > *) { background: transparent; border-color: var(--glass-edge); }
/* Wells let the wash through without a blur of their own: they are large and they scroll. */
html[data-ir-glass] .kb .column { background-color: var(--glass-well); border-color: var(--glass-edge); }
html[data-ir-glass] :is(.kb .seat, .kb .card) { box-shadow: 0 6px 22px rgb(30 24 60 / 0.07), 0 1px 2px rgb(30 24 60 / 0.05); border-color: var(--glass-edge); }
/* Menus, popovers and sheets float over content: the strong fill keeps their text at AA. */
html[data-ir-glass] :is(.kb .menu, [data-bar-more-menu], [data-rail-menu-panel], .ir-surface, [data-mobile2-sheet]) {
  background: var(--glass-fill-strong); -webkit-backdrop-filter: var(--glass-blur-strong); backdrop-filter: var(--glass-blur-strong); border-color: var(--glass-edge); box-shadow: var(--glass-shadow), var(--glass-shine);
}
/* Secondary labels on glass are one step stronger than on paper, as the ground under them varies. */
html[data-ir-glass] :is(.ir-stage > div > aside, .ir-rail, .kb .bar, .kb .col-head, [data-mobile2-bar], [data-mobile2-dock], .kb .menu, [data-bar-more-menu], [data-rail-menu-panel], .ir-surface, [data-mobile2-sheet]) {
  --color-muted: var(--ir-muted-strong);
}
/* The engine's name in the rail's limits footer is drawn in the engine's tint, 3.03:1 on today's card: on glass it takes the text ink. */
html[data-ir-glass] .ir-stage > div > aside button[aria-haspopup="dialog"] > div > span:first-child { color: var(--color-primary) !important; }
html[data-ir-glass] [data-ir-notice-band] { background: var(--glass-fill); border-color: var(--glass-edge); }
html[data-ir-glass] .ir-settings-panes .ir-settings-nav { background: color-mix(in srgb, var(--surface-sunken) 50%, transparent); }
html[data-ir-glass] :is(.ir-promoted, .ir-segment button[aria-pressed="true"]) { background: color-mix(in srgb, var(--surface-card) 82%, transparent); }
@media (prefers-reduced-transparency: reduce) {
  html[data-ir-glass] { --glass-fill: var(--surface-card); --glass-fill-strong: var(--surface-raised); --glass-well: var(--surface-well); --glass-blur: none; --glass-blur-strong: none; }
}
`;
