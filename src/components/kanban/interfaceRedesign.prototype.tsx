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
 * Every project, count and limit drawn by the prototype's own chrome is
 * invented.
 */

import { Archive, ChevronDown, ChevronLeft, ChevronRight, Crown, LayoutGrid, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings as Gear, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { LAYER } from "@/components/layers";
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
    switchProject: (name: string) => `Project ${name}: switch project or go to anything`, systemAria: (left: number) => `System: tightest limit ${left}% left`,
    ram: "RAM", swap: "Swap", free: "9.0 GiB free", used: "1.0 GiB used", sessions: "3 agent sessions", stopIdle: "Stop idle", accounts: "Accounts", telegram: "Telegram", notConnected: "Not connected",
    thisProject: "This project", delegatus: "Delegatus", hide: "Hide the sidebar (B)", expand: "Open the sidebar (B)", collapse: "Collapse the sidebar (B)",
    crown: (name: string) => `Pin ${name}`, agent: (n: number) => `Agent ${n}`, roles: ["builder", "reviewer", "critic", "researcher"], rename: "Rename", crownConv: "Crown",
    needs: (n: number) => `${n} need you`, working: (n: number) => `${n} working`, hint: "Ctrl K",
  },
  uk: {
    goTo: "Перейти до проєкту, агента чи налаштування", filter: "Фільтр проєктів", overview: "Огляд", archived: "Архів", newProject: "Новий проєкт",
    settings: "Налаштування", system: "Система", quiet: "усе спокійно", back: "Назад", close: "Закрити", projects: "Проєкти", left: (n: number) => `лишилось ${n}%`,
    switchProject: (name: string) => `Проєкт ${name}: перемкнути проєкт або перейти будь-куди`, systemAria: (left: number) => `Система: найтісніший ліміт, лишилось ${left}%`,
    ram: "RAM", swap: "Swap", free: "9.0 GiB вільно", used: "1.0 GiB зайнято", sessions: "3 сесії агентів", stopIdle: "Зупинити неактивні", accounts: "Акаунти", telegram: "Telegram", notConnected: "Не підключено",
    thisProject: "Цей проєкт", delegatus: "Delegatus", hide: "Сховати панель (B)", expand: "Відкрити панель (B)", collapse: "Згорнути панель (B)",
    crown: (name: string) => `Закріпити ${name}`, agent: (n: number) => `Агент ${n}`, roles: ["будівник", "рев’юер", "критик", "дослідник"], rename: "Перейменувати", crownConv: "Коронувати",
    needs: (n: number) => `${n} потребують вас`, working: (n: number) => `${n} працюють`, hint: "Ctrl K",
  },
};

const STRIP = 36;
export const REDESIGN_STRIP_HEIGHT = STRIP;

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

/** Answer an existing control's press with the prototype's own surface. */
function useIntercept(enabled: boolean, selector: string, handler: (trigger: HTMLElement) => void) {
  const latest = useRef(handler);
  useEffect(() => { latest.current = handler; });
  useEffect(() => {
    if (!enabled) return;
    const onClick = (event: MouseEvent) => {
      const trigger = (event.target as Element | null)?.closest<HTMLElement>(selector);
      if (!trigger) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      latest.current(trigger);
    };
    /* On the window, in capture: ahead of the root container React listens on. */
    window.addEventListener("click", onClick, true);
    return () => window.removeEventListener("click", onClick, true);
  }, [enabled, selector]);
}

/** A node kept inside a real element, for the two controls variant 1 puts in the board header. */
function useSlot(enabled: boolean, parentSelector: string, place: "first" | "after"): HTMLElement | null {
  const [slot] = useState<HTMLElement | null>(() => {
    if (!enabled) return null;
    const node = document.createElement("span");
    node.dataset.irSlot = place;
    node.style.display = "contents";
    return node;
  });
  useEffect(() => {
    if (!slot) return;
    const attach = () => {
      const parent = document.querySelector(parentSelector);
      if (!parent) return;
      if (place === "first" && parent.firstChild !== slot) parent.insertBefore(slot, parent.firstChild);
      if (place === "after" && parent.nextSibling !== slot) parent.parentNode?.insertBefore(slot, parent.nextSibling);
    };
    attach();
    const observer = new MutationObserver(attach);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { observer.disconnect(); slot.remove(); };
  }, [slot, parentSelector, place]);
  return slot;
}

/* ── Rows and menus ────────────────────────────────────────────────────── */

type Open =
  | { kind: "menu"; menu: string; anchor: DOMRect }
  | { kind: "palette" | "system" | "settings"; anchor: DOMRect | null; scope?: "project" | "delegatus" }
  | null;

function RowView({ entry, lang, name, onInto, promoted }: { entry: Row; lang: Lang; name: string; onInto: (entry: Row) => void; promoted?: boolean }) {
  const [on, setOn] = useState(entry.key === "sound" || entry.key === "reports" || entry.key === "push");
  const [picked, setPicked] = useState(entry.key === "status" ? 1 : entry.key.startsWith("priority") ? 1 : 0);
  const label = entry.label[lang];
  if (entry.kind === "segment" || entry.kind === "chips") {
    return (
      <div className={`ir-row ir-choice ${promoted ? "ir-choice-wide" : ""}`} data-ir-row={entry.key}>
        <span className="ir-row-label">{label}</span>
        <span className={entry.kind === "segment" ? "ir-segment" : "ir-chips"} role="group" aria-label={label}>
          {entry.choices!.map((choice, index) => (
            <button
              key={index} type="button" data-ir-control={`${name}:${entry.key}:${index}`}
              aria-pressed={entry.kind === "segment" ? picked === index : undefined}
              aria-label={entry.key === "colour" ? `${label} ${index + 1}` : undefined}
              className={entry.key === "colour" ? "ir-swatch" : undefined}
              style={entry.key === "colour" ? { "--ir-hue": `${index * 40}` } as CSSProperties : undefined}
              onClick={() => setPicked(index)}
            >
              {entry.key === "colour" ? null : choice[lang]}
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
  return (
    <button
      type="button" className={`ir-row ${promoted ? "ir-promoted" : ""} ${entry.kind === "danger" ? "ir-danger" : ""}`} data-ir-control={`${name}:${entry.key}`}
      onClick={() => { if (entry.into) onInto(entry); }}
    >
      <span className="ir-row-label">{label}</span>
      {entry.trail ? <span className="ir-trail">{entry.trail[lang]}</span> : null}
      {entry.into ? <ChevronRight className="ir-chev" aria-hidden /> : null}
    </button>
  );
}

function MenuView({ menu, name, lang, titleRow }: { menu: Menu; name: string; lang: Lang; titleRow?: ReactNode }) {
  const [into, setInto] = useState<Row | null>(null);
  const t = COPY[lang];
  if (into) {
    const agents = into.key === "agents";
    return (
      <div className="ir-menu-body" data-ir-menu-view={into.key}>
        <button type="button" className="ir-row ir-back" data-ir-control={`${name}:back`} onClick={() => setInto(null)}>
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
            : into.into!.map((entry) => <RowView key={entry.key} entry={entry} lang={lang} name={`${name}:${into.key}`} onInto={() => {}} />)}
        </div>
      </div>
    );
  }
  const wide = menu.promoted.filter((entry) => entry.kind === "segment");
  const buttons = menu.promoted.filter((entry) => entry.kind !== "segment");
  return (
    <div className="ir-menu-body" data-ir-menu-view="first">
      {titleRow}
      {wide.map((entry) => <RowView key={entry.key} entry={entry} lang={lang} name={name} onInto={setInto} promoted />)}
      {buttons.length ? (
        <div className="ir-promoted-row" style={{ gridTemplateColumns: `repeat(${buttons.length}, minmax(0, 1fr))` }}>
          {buttons.map((entry) => <RowView key={entry.key} entry={entry} lang={lang} name={name} onInto={setInto} promoted />)}
        </div>
      ) : null}
      {menu.promoted.length ? <div className="ir-rule" /> : null}
      {menu.rows.map((entry) => <RowView key={entry.key} entry={entry} lang={lang} name={name} onInto={setInto} />)}
    </div>
  );
}

/* ── Surfaces ──────────────────────────────────────────────────────────── */

function Surface({ open, phone, width, label, onClose, children, name, tall }: {
  open: Exclude<Open, null>; phone: boolean; width: number; label: string; onClose: () => void; children: ReactNode; name: string; tall?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const anchor = open.anchor;
  /* A menu opened low on the page moves up by what would hang below the window. */
  const [lift, setLift] = useState(0);
  const below = !phone && anchor !== null && open.kind !== "settings" && anchor.top <= innerHeight * 0.6;
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
  const centred = !phone && (!anchor || open.kind === "settings");
  const style: CSSProperties = phone
    ? { zIndex: LAYER.overlay }
    : centred
      ? { zIndex: LAYER.overlay, width, left: Math.max(8, (innerWidth - width) / 2), top: Math.max(8, Math.min(96, innerHeight * 0.1)), maxHeight: innerHeight - 2 * Math.max(8, Math.min(96, innerHeight * 0.1)) }
      : anchor!.top > innerHeight * 0.6
        /* A trigger at the foot of the rail opens its panel beside itself, growing upward. */
        ? { zIndex: LAYER.popover, width, left: Math.min(anchor!.right + 8, innerWidth - width - 8), bottom: Math.max(8, innerHeight - anchor!.bottom), maxHeight: innerHeight - 16 }
        : { zIndex: LAYER.popover, width, left: Math.max(8, Math.min(anchor!.left, innerWidth - width - 8)), top: anchor!.bottom + 6 - lift, maxHeight: innerHeight - (anchor!.bottom + 6 - lift) - 8 };
  return createPortal(
    <div data-ir-layer={name}>
      <div className={`ir-scrim ${phone || centred ? "ir-scrim-dim" : ""}`} style={{ zIndex: phone || centred ? LAYER.modal : LAYER.popover - 1 }} data-ir-scrim="" onClick={onClose} />
      <div ref={ref} role="dialog" aria-modal={phone || centred} aria-label={label} data-ir-surface={name} className={`ir-surface ${phone ? "ir-sheet" : "ir-pop"} ${tall ? "ir-tall" : ""}`} style={style}>
        {phone ? <div className="ir-grab" aria-hidden /> : null}
        {children}
      </div>
    </div>,
    document.body,
  );
}

function ProjectRows({ lang, name, query, compact, withCrown = true }: { lang: Lang; name: string; query: string; compact?: boolean; withCrown?: boolean }) {
  const t = COPY[lang];
  const [crowned, setCrowned] = useState(() => new Set(PROJECTS.filter((project) => project.crowned).map((project) => project.name)));
  const [archived, setArchived] = useState(false);
  const shown = PROJECTS.filter((project) => project.name.includes(query.trim().toLowerCase()));
  return (
    <>
      <button type="button" className="ir-row ir-project" data-ir-control={`${name}:overview`}>
        <LayoutGrid className="ir-ico" aria-hidden />
        <span className="ir-row-label">{t.overview}</span>
      </button>
      {shown.map((project) => (
        <div key={project.name} className="ir-project-line">
          <button type="button" className="ir-row ir-project" aria-current={project.name === "atlas" ? "page" : undefined} data-ir-control={`${name}:project:${project.name}`}>
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

function Field({ lang, name, value, onChange, placeholder, hint }: { lang: Lang; name: string; value: string; onChange: (value: string) => void; placeholder: string; hint?: boolean }) {
  return (
    <label className="ir-field">
      <Search className="ir-ico" aria-hidden />
      <input data-ir-control={`${name}:field`} value={value} placeholder={placeholder} aria-label={placeholder} onChange={(event) => onChange(event.target.value)} />
      {hint ? <kbd>{COPY[lang].hint}</kbd> : null}
    </label>
  );
}

/** Variant 1's one finder: projects first, then everything the rail's menu held. */
function Palette({ lang, phone, onSettings, onSystem, settingsRows }: { lang: Lang; phone: boolean; onSettings: () => void; onSystem: () => void; settingsRows: Row[] | null }) {
  const t = COPY[lang];
  const [query, setQuery] = useState("");
  const [settings, setSettings] = useState(false);
  if (settingsRows && settings) {
    return (
      <div className="ir-menu-body" data-ir-menu-view="palette-settings">
        <button type="button" className="ir-row ir-back" data-ir-control="palette:back" onClick={() => setSettings(false)}><ChevronLeft className="ir-chev" aria-hidden /><span className="ir-row-label">{t.settings}</span></button>
        {settingsRows.map((entry) => <RowView key={entry.key} entry={entry} lang={lang} name="palette:settings" onInto={() => {}} />)}
      </div>
    );
  }
  return (
    <div className="ir-menu-body" data-ir-menu-view="palette">
      <Field lang={lang} name="palette" value={query} onChange={setQuery} placeholder={phone ? t.filter : t.goTo} hint={!phone} />
      <div className="ir-head">{t.projects}</div>
      <ProjectRows lang={lang} name="palette" query={query} />
      <button type="button" className="ir-row" data-ir-control="palette:new-project"><Plus className="ir-ico" aria-hidden /><span className="ir-row-label">{t.newProject}</span></button>
      <div className="ir-rule" />
      {phone ? (
        <button type="button" className="ir-row" data-ir-control="palette:system" onClick={onSystem}>
          <Ring left={tightestLimit()} /><span className="ir-row-label">{t.system}</span><span className="ir-trail">{t.left(tightestLimit())}</span><ChevronRight className="ir-chev" aria-hidden />
        </button>
      ) : null}
      <button type="button" className="ir-row" data-ir-control="palette:settings" onClick={() => (settingsRows ? setSettings(true) : onSettings())}>
        <Gear className="ir-ico" aria-hidden /><span className="ir-row-label">{t.settings}</span><ChevronRight className="ir-chev" aria-hidden />
      </button>
    </div>
  );
}

function Ring({ left }: { left: number }) {
  return <i className="ir-ring" style={{ "--ir-left": `${left}%` } as CSSProperties} aria-hidden />;
}

function SystemPanel({ lang }: { lang: Lang }) {
  const t = COPY[lang];
  return (
    <div className="ir-menu-body" data-ir-menu-view="system">
      <div className="ir-head">{t.system}</div>
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
    </div>
  );
}

/** Direction B's one Settings place. */
function SettingsPlace({ lang, phone, scope, onClose }: { lang: Lang; phone: boolean; scope: "project" | "delegatus"; onClose: () => void }) {
  const t = COPY[lang];
  const first = SETTINGS.find((section) => section.scope === scope)!.key;
  const [key, setKey] = useState<string | null>(phone ? null : first);
  const section = SETTINGS.find((entry) => entry.key === key) ?? null;
  const list = (
    <nav className="ir-settings-nav" aria-label={t.settings}>
      {(["project", "delegatus"] as const).map((group) => (
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
      {phone ? (
        <button type="button" className="ir-row ir-back" data-ir-control="settings:back" onClick={() => setKey(null)}><ChevronLeft className="ir-chev" aria-hidden /><span className="ir-row-label">{section.title[lang]}</span></button>
      ) : <div className="ir-settings-title">{section.title[lang]}</div>}
      {section.rows.map((entry) => <RowView key={entry.key} entry={entry} lang={lang} name={`settings:${section.key}`} onInto={() => {}} />)}
    </div>
  ) : null;
  return (
    <div className={`ir-settings ${phone ? "ir-settings-phone" : ""}`} data-ir-menu-view="settings">
      <div className="ir-settings-bar">
        <span className="ir-settings-title">{t.settings}</span>
        <button type="button" className="ir-icon" aria-label={t.close} data-ir-control="settings:close" onClick={onClose}><X aria-hidden /></button>
      </div>
      {phone ? (section ? rows : list) : <div className="ir-settings-panes">{list}{rows}</div>}
    </div>
  );
}

/** Variants 2 and 3: the rail as a layout sibling of the Viewer. */
function Rail({ lang, collapsible, open, onToggle, onSystem, onSettings }: {
  lang: Lang; collapsible: boolean; open: boolean; onToggle: () => void; onSystem: (anchor: DOMRect) => void; onSettings: (anchor: DOMRect) => void;
}) {
  const t = COPY[lang];
  const [query, setQuery] = useState("");
  if (!open) {
    return (
      <nav className="ir-rail ir-rail-closed" data-ir-rail="closed" aria-label={t.projects}>
        <button type="button" className="ir-tile" aria-label={t.overview} title={t.overview} data-ir-control="rail:overview"><LayoutGrid aria-hidden /></button>
        <div className="ir-rail-rule" />
        {[...PROJECTS].sort((a, b) => Number(b.crowned) - Number(a.crowned)).map((project) => (
          <button key={project.name} type="button" className="ir-tile ir-monogram" aria-current={project.name === "atlas" ? "page" : undefined} aria-label={project.name} title={project.name} data-ir-control={`rail:project:${project.name}`}>
            {project.name.slice(0, 2)}
            {project.needs ? <i className="ir-badge" aria-hidden /> : project.live ? <i className="ir-badge ir-badge-live" aria-hidden /> : null}
          </button>
        ))}
        <button type="button" className="ir-tile" aria-label={t.newProject} title={t.newProject} data-ir-control="rail:new-project"><Plus aria-hidden /></button>
        <span className="ir-grow" />
        <button type="button" className="ir-tile" aria-label={t.systemAria(tightestLimit())} title={t.system} data-ir-control="rail:system" onClick={(event) => onSystem(event.currentTarget.getBoundingClientRect())}><Ring left={tightestLimit()} /></button>
        <button type="button" className="ir-tile" aria-label={t.settings} title={t.settings} data-ir-control="rail:settings" onClick={(event) => onSettings(event.currentTarget.getBoundingClientRect())}><Gear aria-hidden /></button>
        <button type="button" className="ir-tile" aria-label={t.expand} title={t.expand} data-ir-control="rail:toggle" onClick={onToggle}><PanelLeftOpen aria-hidden /></button>
      </nav>
    );
  }
  return (
    <nav className="ir-rail" data-ir-rail="open" aria-label={t.projects}>
      <div className="ir-rail-top">
        <Field lang={lang} name="rail" value={query} onChange={setQuery} placeholder={t.filter} />
        <button type="button" className="ir-icon" aria-label={t.newProject} title={t.newProject} data-ir-control="rail:new-project"><Plus aria-hidden /></button>
      </div>
      <div className="ir-rail-list"><ProjectRows lang={lang} name="rail" query={query} /></div>
      <button type="button" className="ir-row ir-status" aria-label={t.systemAria(tightestLimit())} data-ir-control="rail:system" onClick={(event) => onSystem(event.currentTarget.getBoundingClientRect())}>
        <Ring left={tightestLimit()} />
        <span className="ir-row-label">{t.system}<span className="ir-sub">{LIMITS.map((limit) => `${limit.engine} ${Math.min(...limit.windows.map((window) => window.left))}%`).join(" · ")}</span></span>
      </button>
      <div className="ir-rail-foot">
        <button type="button" className="ir-row" data-ir-control="rail:settings" onClick={(event) => onSettings(event.currentTarget.getBoundingClientRect())}><Gear className="ir-ico" aria-hidden /><span className="ir-row-label">{t.settings}</span></button>
        <button type="button" className="ir-icon" aria-label={collapsible ? t.collapse : t.hide} title={collapsible ? t.collapse : t.hide} data-ir-control="rail:toggle" onClick={onToggle}><PanelLeftClose aria-hidden /></button>
      </div>
    </nav>
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
  const close = useCallback(() => setOpen(null), []);

  useLayoutEffect(() => {
    /* Menus and sheets are portalled to the body, outside this wrapper. */
    if (glass) document.documentElement.dataset.irGlass = "";
  }, [glass]);

  /* The existing menu buttons answer with the regrouped menus. */
  const rect = (trigger: HTMLElement) => trigger.getBoundingClientRect();
  useIntercept(direction !== null && !phone, "[data-bar-more]", (trigger) => setOpen({ kind: "menu", menu: "board", anchor: rect(trigger) }));
  useIntercept(direction !== null && !phone, ".kb .card [data-menu]", (trigger) => setOpen({ kind: "menu", menu: "card", anchor: rect(trigger) }));
  useIntercept(direction === "A" && !phone, "[data-rail-menu]", (trigger) => setOpen({ kind: "menu", menu: "rail", anchor: rect(trigger) }));
  useIntercept(direction === "B" && !phone, "[data-rail-menu]", () => setOpen({ kind: "settings", anchor: null, scope: "delegatus" }));
  useIntercept(direction !== null && phone, '[data-mobile2-open="menu"]', (trigger) => {
    const screen = trigger.closest<HTMLElement>("[data-mobile2-screen]")?.dataset.mobile2Screen;
    setOpen({ kind: "menu", menu: screen === "board" ? "phoneBoard" : "phoneConversation", anchor: rect(trigger) });
  });
  /* The phone's title already opens the projects; the sidebar variants give that sheet the rail's missing functions. */
  useIntercept((noRail || ownRail) && phone, '[data-mobile2-title][data-mobile2-open="projects"]', () => setOpen({ kind: "palette", anchor: null }));

  /* Variant 1 on the desktop: the header's title is the switcher, and one chip is the system. */
  const lead = useSlot(noRail && !phone, '[data-bar="project"] [data-bar-group="where"]', "first");
  const status = useSlot(noRail && !phone, '[data-bar="project"] [data-bar-group="status"]', "after");
  useEffect(() => {
    if (phone || !(noRail || ownRail)) return;
    const onKey = (event: KeyboardEvent) => {
      const typing = (event.target as HTMLElement | null)?.closest("input, textarea, [contenteditable]");
      const palette = (event.key === "k" && (event.ctrlKey || event.metaKey)) || (event.key.toLowerCase() === "b" && !typing && !event.ctrlKey && !event.metaKey && !event.altKey);
      if (!palette) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (noRail) setOpen((was) => (was?.kind === "palette" ? null : { kind: "palette", anchor: document.querySelector('[data-ir-control="shell:project"]')?.getBoundingClientRect() ?? null }));
      else setRailOpen((was) => !was);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [phone, noRail, ownRail]);

  const settingsScope = (menu: string, key: string): "project" | "delegatus" | null =>
    direction !== "B" ? null : key === "settings-project" ? "project" : key === "settings" ? (menu === "phoneConversation" || menu === "phoneBoard" ? "project" : "delegatus") : null;
  /* A menu row named Settings opens the Settings place. */
  useIntercept(direction === "B", '[data-ir-control$=":settings"], [data-ir-control$=":settings-project"]', (trigger) => {
    const [menu, key] = trigger.dataset.irControl!.split(":") as [string, string];
    if (menu === "palette" || menu === "rail") return;
    const scope = settingsScope(menu, key);
    if (scope) setOpen({ kind: "settings", anchor: null, scope });
  });

  const openSystem = (anchor: DOMRect | null) => setOpen({ kind: "system", anchor });
  const openSettings = (anchor: DOMRect | null) => setOpen(direction === "B" ? { kind: "settings", anchor: null, scope: "delegatus" } : { kind: "menu", menu: "rail", anchor: anchor ?? new DOMRect(8, 8, 0, 0) });
  const railMenu = MENUS_A.rail!;
  const flatSettings = [...railMenu.promoted, ...railMenu.rows.flatMap((entry) => entry.into ?? [entry])];

  let surface: ReactNode = null;
  if (open?.kind === "menu") {
    const source = open.menu === "rail" ? MENUS_A : menus;
    const menu = source[open.menu]!;
    const titleRow = direction === "B" && open.menu === "phoneConversation" ? (
      <div className="ir-title-row" data-ir-title-refs={B_CONVERSATION_TITLE_REFS.join(",")}>
        <span className="ir-settings-title">{menu.title[lang]}</span>
        <button type="button" className="ir-quiet" data-ir-control="phoneConversation:rename">{t.rename}</button>
        <button type="button" className="ir-icon ir-crown" aria-pressed="false" aria-label={t.crownConv} data-ir-control="phoneConversation:crown"><Crown aria-hidden /></button>
      </div>
    ) : phone ? <div className="ir-title-row"><span className="ir-settings-title">{menu.title[lang]}</span></div> : null;
    surface = (
      <Surface open={open} phone={phone} width={open.menu === "card" ? 300 : 280} label={menu.title[lang]} onClose={close} name={`menu-${open.menu}`}>
        <MenuView menu={menu} name={open.menu} lang={lang} titleRow={titleRow} />
      </Surface>
    );
  } else if (open?.kind === "palette") {
    surface = (
      <Surface open={open} phone={phone} width={380} label={t.goTo} onClose={close} name="palette">
        <Palette lang={lang} phone={phone} onSystem={() => openSystem(null)} onSettings={() => openSettings(null)} settingsRows={direction === "B" ? null : flatSettings} />
      </Surface>
    );
  } else if (open?.kind === "system") {
    surface = <Surface open={open} phone={phone} width={320} label={t.system} onClose={close} name="system"><SystemPanel lang={lang} /></Surface>;
  } else if (open?.kind === "settings") {
    surface = <Surface open={open} phone={phone} width={Math.min(720, innerWidth - 32)} label={t.settings} onClose={close} name="settings" tall><SettingsPlace lang={lang} phone={phone} scope={open.scope ?? "delegatus"} onClose={close} /></Surface>;
  }

  const atlas = PROJECTS[0]!;
  const others = PROJECTS.slice(1).reduce((sum, project) => sum + project.needs, 0);
  return (
    <div data-ir-inner={variant} data-ir-shell={noRail ? "none" : ownRail ? "own" : "today"} className="ir-root">
      <style>{CSS}</style>
      {ownRail && !phone ? (
        <Rail
          lang={lang} collapsible={variant === 3} open={railOpen} onToggle={() => setRailOpen((was) => !was)}
          onSystem={openSystem} onSettings={openSettings}
        />
      ) : null}
      {ownRail && !phone && variant === 2 && !railOpen ? (
        <div className="ir-restore"><button type="button" className="ir-icon" aria-label={t.expand} title={t.expand} data-ir-control="rail:toggle" onClick={() => setRailOpen(true)}><PanelLeftOpen aria-hidden /></button></div>
      ) : null}
      <div data-ir-stage="" className="ir-stage">{children}</div>
      {lead ? createPortal(
        <button type="button" className="ir-switch-title" aria-haspopup="dialog" aria-expanded={open?.kind === "palette"} aria-label={t.switchProject(atlas.name)} data-ir-control="shell:project" onClick={(event) => setOpen({ kind: "palette", anchor: event.currentTarget.getBoundingClientRect() })}>
          <span>{atlas.name}</span>
          {others ? <i className="ir-badge-inline" title={t.needs(others)} aria-hidden /> : null}
          <ChevronDown aria-hidden />
        </button>,
        lead,
      ) : null}
      {status ? createPortal(
        <button type="button" className="ir-system-chip" aria-haspopup="dialog" aria-expanded={open?.kind === "system"} aria-label={t.systemAria(tightestLimit())} title={t.system} data-ir-control="shell:system" onClick={(event) => openSystem(event.currentTarget.getBoundingClientRect())}>
          <Ring left={tightestLimit()} /><span>{tightestLimit()}%</span>
        </button>,
        status,
      ) : null}
      {surface}
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
[data-ir-shell="none"] [data-bar="project"] [data-bar-group="where"] > h1 { display: none; }

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
.ir-ring { width: 16px; height: 16px; flex-shrink: 0; border-radius: 50%; background: conic-gradient(var(--color-accent) var(--ir-left), var(--border-strong) 0); -webkit-mask: radial-gradient(circle, transparent 4.5px, black 5px); mask: radial-gradient(circle, transparent 4.5px, black 5px); }
.ir-switch-title:focus-visible, .ir-system-chip:focus-visible, [data-ir-layer] button:focus-visible, .ir-rail button:focus-visible, .ir-field input:focus-visible { outline: 2px solid color-mix(in srgb, var(--color-accent) 55%, transparent); outline-offset: 1px; }

/* Surfaces */
.ir-scrim { position: fixed; inset: 0; }
.ir-scrim-dim { background: rgb(20 20 30 / 0.32); }
.ir-surface { position: fixed; display: flex; flex-direction: column; overflow: hidden; background: var(--surface-raised); border: 1px solid var(--border-default); box-shadow: var(--shadow-2); }
.ir-pop { border-radius: var(--radius-surface); animation: ir-in var(--motion-base) var(--ease-standard); }
.ir-sheet { left: 0; right: 0; bottom: 0; max-height: 88dvh; border-radius: 20px 20px 0 0; border-bottom: 0; padding-bottom: env(safe-area-inset-bottom); animation: ir-up var(--motion-slow) var(--ease-standard); }
.ir-sheet.ir-tall { height: 88dvh; }
.ir-grab { width: 36px; height: 4px; margin: 8px auto 2px; flex-shrink: 0; border-radius: 2px; background: var(--border-strong); }
@keyframes ir-in { from { opacity: 0; transform: translateY(-4px) scale(0.98); } }
@keyframes ir-up { from { transform: translateY(24px); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .ir-pop, .ir-sheet { animation: none; } }
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
.ir-segment button[aria-pressed="true"] { background: var(--surface-card); color: var(--color-primary); box-shadow: var(--shadow-1); }
.ir-chips { display: inline-flex; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.ir-chips button { min-height: calc(var(--ir-row) - 8px); padding: 0 10px; border-radius: 999px; border: 1px solid var(--border-default); font-size: var(--text-ui); font-weight: 600; color: var(--color-primary); }
.ir-chips button.ir-swatch { width: 24px; min-height: 24px; padding: 0; border: 0; background: oklch(0.68 0.13 calc(var(--ir-hue) * 1deg)); }
.ir-chips button.ir-swatch:first-child { background: none; border: 1px dashed var(--border-strong); }
@media (pointer: coarse) { .ir-chips button { min-height: 44px; min-width: 44px; } .ir-segment button { min-height: 44px; } }
.ir-switch { position: relative; width: 30px; height: 18px; flex-shrink: 0; border-radius: 999px; background: var(--border-strong); transition: background var(--motion-fast); }
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
.ir-title-row { display: flex; flex-shrink: 0; align-items: center; gap: 8px; min-height: var(--ir-row); padding: 2px var(--ir-pad) 6px; }
.ir-title-row .ir-settings-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Projects */
.ir-project-line { display: flex; flex-shrink: 0; align-items: center; gap: 2px; }
.ir-project-line > .ir-row { flex: 1 1 auto; min-width: 0; width: auto; }
.ir-project { min-height: calc(var(--ir-row) + 8px); font-weight: 600; }
.ir-archived { font-weight: 400; color: var(--color-secondary); }
.ir-dot { width: 8px; height: 8px; flex-shrink: 0; border-radius: 50%; background: var(--border-strong); }
.ir-dot-live { background: var(--color-success); }
.ir-needs { flex-shrink: 0; min-width: 18px; padding: 0 5px; border-radius: 999px; background: var(--color-warning-soft); color: var(--color-warning); font-size: var(--text-label); font-weight: 700; line-height: 18px; text-align: center; }
.ir-crown { color: var(--border-strong); }
.ir-crown[aria-pressed="true"] { color: var(--color-crown); }
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
.ir-settings-phone .ir-settings-bar { padding-left: 14px; }
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
html[data-ir-glass] :is(.ir-stage > div > aside, .ir-rail, .kb .bar, [data-mobile2-bar], [data-mobile2-dock]) { isolation: isolate; }
html[data-ir-glass] .ir-stage > div > aside :is(header, [data-rail-footer], [data-rail-footer] > *) { background: transparent; border-color: var(--glass-edge); }
/* Wells let the wash through without a blur of their own: they are large and they scroll. */
html[data-ir-glass] .kb .column { background-color: var(--glass-well); border-color: var(--glass-edge); }
html[data-ir-glass] :is(.kb .seat, .kb .card) { box-shadow: 0 6px 22px rgb(30 24 60 / 0.07), 0 1px 2px rgb(30 24 60 / 0.05); border-color: var(--glass-edge); }
/* Menus, popovers and sheets float over content: the strong fill keeps their text at AA. */
html[data-ir-glass] :is(.kb .menu, [data-bar-more-menu], [data-rail-menu-panel], .ir-surface, [data-mobile2-sheet]) {
  background: var(--glass-fill-strong); -webkit-backdrop-filter: blur(30px) saturate(1.8); backdrop-filter: blur(30px) saturate(1.8); border-color: var(--glass-edge); box-shadow: var(--glass-shadow), var(--glass-shine);
}
/* Secondary labels on glass are one step stronger than on paper, as the ground under them varies. */
html[data-ir-glass] :is(.ir-stage > div > aside, .ir-rail, .kb .bar, .kb .col-head, [data-mobile2-bar], [data-mobile2-dock], .kb .menu, [data-bar-more-menu], [data-rail-menu-panel], .ir-surface, [data-mobile2-sheet]) {
  --color-muted: var(--ir-muted-strong);
}
html[data-ir-glass] .ir-settings-panes .ir-settings-nav { background: color-mix(in srgb, var(--surface-sunken) 50%, transparent); }
html[data-ir-glass] :is(.ir-promoted, .ir-segment button[aria-pressed="true"]) { background: color-mix(in srgb, var(--surface-card) 82%, transparent); }
@media (prefers-reduced-transparency: reduce) {
  html[data-ir-glass] { --glass-fill: var(--surface-card); --glass-fill-strong: var(--surface-raised); --glass-well: var(--surface-well); --glass-blur: none; }
}
`;
