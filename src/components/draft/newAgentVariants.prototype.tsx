"use client";

import { ArrowRightLeft } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { effortTierLabel, roleName } from "@/components/builderCopy";
import { ComposerBar } from "@/components/ComposerBar";
import { DirectoryPicker } from "@/components/DirectoryPicker";
import { RoleSection } from "@/components/DraftAgentPane";
import { ChevronDown, X } from "@/components/icons";
import { Z } from "@/components/layers";
import { ReasoningControls } from "@/components/ReasoningControls";
import { engineTintOf } from "@/components/utils";
import { useIsMobile } from "@/hooks/useIsMobile";
import { ENGINE_MODELS } from "@/lib/agent/models";
import { useLocale } from "@/lib/i18n";

import { AGENT_LAUNCH_ENGINES, EngineRadioGroup, LaunchAccountSelect, launchEngineLabel } from "./AgentLaunchControls";
import type { DraftLayout, DraftLayoutParts } from "./draftLayout";

/*
 * Design prototypes for creating a new agent (docs/design/new-agent-redesign.md).
 * Three arrangements of the SAME draft: the state, the launch and every control
 * are the product's own (`DraftAgentPane`, `ComposerBar`, `ReasoningControls`,
 * `EngineRadioGroup`, `LaunchAccountSelect`, `DirectoryPicker`, `RoleSection`).
 * Only the kanban fixture installs one, through `?newagent=<n>`; nothing here
 * is reachable from the product.
 */

export const NEW_AGENT_LOOKS = [0, 1, 2, 3] as const;
export type NewAgentLook = (typeof NEW_AGENT_LOOKS)[number];

const TITLES: Record<"en" | "uk", Record<NewAgentLook, string>> = {
  en: { 0: "Today", 1: "The composer is the card", 2: "One line, opened where asked", 3: "A sheet at the button" },
  uk: { 0: "Сьогодні", 1: "Композер і є карткою", 2: "Один рядок, що розкривається за запитом", 3: "Аркуш біля кнопки" },
};

/** What the fixture prepares before the page draws, for the states a press cannot reach in one step. */
export const NEW_AGENT_SEEDS = ["handoff", "signed-out", "capability"] as const;
export type NewAgentSeed = (typeof NEW_AGENT_SEEDS)[number];

export function parseNewAgent(search: string): { look: NewAgentLook; inner: boolean; seed: NewAgentSeed | null } | null {
  const params = new URLSearchParams(search);
  const raw = params.get("newagent");
  if (raw === null) return null;
  const look = Number(raw) as NewAgentLook;
  if (!NEW_AGENT_LOOKS.includes(look)) return null;
  const seed = params.get("naseed") as NewAgentSeed | null;
  return { look, inner: params.get("inner") === "1", seed: seed && NEW_AGENT_SEEDS.includes(seed) ? seed : null };
}

const STRIP = 40;

/** The page around the application: the look's number and name in a strip, and
    the application itself in a frame of the stated size below it. */
export function NewAgentHost({ look }: { look: NewAgentLook }) {
  const params = new URLSearchParams(location.search);
  const lang = localStorage.getItem("llv_lang") === "uk" ? "uk" : "en";
  const [width, height] = (params.get("frame") ?? "1440x900").split("x").map(Number) as [number, number];
  const inner = new URLSearchParams(params);
  inner.set("inner", "1");
  return (
    <div data-na-host="" style={{ display: "flex", flexDirection: "column", width, background: "var(--surface-board)" }}>
      <div
        data-na-strip=""
        style={{ height: STRIP, display: "flex", alignItems: "center", gap: 10, padding: "0 10px", background: "var(--color-brand)", color: "var(--color-on-brand)", font: "600 13px/1 var(--font-sans)", overflow: "hidden", whiteSpace: "nowrap" }}
      >
        <span data-na-number="" style={{ font: "800 26px/1 var(--font-sans)", minWidth: 20, textAlign: "center" }}>{look}</span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{TITLES[lang][look]}</span>
        <span style={{ marginLeft: "auto", opacity: 0.75, fontWeight: 500 }}>{width}×{height} · {lang}</span>
      </div>
      <iframe data-na-frame={look} title={TITLES[lang][look]} src={`${location.pathname}?${inner.toString()}${location.hash}`} style={{ width, height, border: 0, display: "block" }} />
    </div>
  );
}

export const NEW_AGENT_STRIP = STRIP;

/* What the board does around a draft, undone for the looks: the card that holds a draft gives it a fixed
   conversation height and a title of its own («Untitled task»), and look 3 seats no card at all. A shipped
   look would change the board's own rules; a prototype overrides them from here. The composer's parts are
   reordered the same way: what a look puts under the field (`[data-na-below]`) comes before the composer's
   thumbnails and messages, where a shipped look would hand it to the composer as a slot. */
const BOARD_CSS = `
.kb .agent-draft:has([data-na-draft]) { height: auto; max-width: none; }
.kb .card[data-id^="draft:"]:has([data-na-draft="1"], [data-na-draft="2"]) > :is(.head, .foot) { display: none; }
.kb .card[data-id^="draft:"]:has([data-na-seat="3"]) { display: none; }
.kb .agent-drafts:has([data-na-seat="3"]) { display: none; }
.kb .card:not([data-id^="draft:"]) [data-na-draft] { border-top: 1px solid var(--border-default); padding-top: 8px; }
[data-na-role] > div { border: 0; background: none; padding: 0; }
[data-na-role] label[for^="draft-role-"] { display: none; }
[data-na-form][data-na-reorder] > * { order: 3; }
[data-na-form][data-na-reorder] > [data-testid="composer-input-unit"] { order: 1; }
[data-na-draft="2"] [data-na-reorder] [data-testid="composer-options-row"] > div:first-child { display: contents; }
[data-na-sheet] textarea { max-height: 96px; }
[data-na-sheet][data-na-tight] textarea { max-height: 58px; }
[data-na-phone] [role="radio"] { position: relative; }
[data-na-phone] [role="radio"]::before { content: ""; position: absolute; inset: -9px 0; }
.kb [data-na-anchor-open], [data-na-anchor-open] { background: var(--surface-well) !important; color: var(--color-primary) !important; }
`;

/* The captions a shipped look would add to the catalog: the product names these fields only in the default
   option of each select («model: default») and in its accessibility labels, which are sentences. */
const CAPTIONS = {
  en: { model: "Model", effort: "Effort", speed: "Speed", account: "Account", task: "Task", more: "More fields below" },
  uk: { model: "Модель", effort: "Міркування", speed: "Швидкість", account: "Акаунт", task: "Задача", more: "Нижче є ще поля" },
} as const;

function useCaptions() {
  const { locale } = useLocale();
  return CAPTIONS[locale === "uk" ? "uk" : "en"];
}

const CAPTION = "min-w-0 truncate text-label font-semibold text-muted first-letter:uppercase";
const ICON_BUTTON = "inline-flex shrink-0 items-center justify-center rounded-control text-muted hover:bg-sunken hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

function Close({ parts, phone }: { parts: DraftLayoutParts; phone: boolean }) {
  const { t } = useLocale();
  return (
    <button type="button" data-na-close="" className={`${ICON_BUTTON} ${phone ? "h-11 w-11" : "h-7 w-7"}`} aria-label={t("draft.dismiss")} title={t("draft.dismiss")} onClick={parts.onClose}>
      <X className="h-4 w-4" aria-hidden />
    </button>
  );
}

/** The conversation a handoff draft continues, said in words wherever the look has no heading. */
function Source({ parts }: { parts: DraftLayoutParts }) {
  if (!parts.src) return null;
  return (
    <p data-na-source="" title={parts.src} className="flex min-w-0 items-center gap-1 text-caption font-semibold text-secondary">
      <ArrowRightLeft className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
      <span className="min-w-0 truncate first-letter:uppercase">{parts.heading}</span>
    </p>
  );
}

/** The launch in flight: the prompt as the operator's own bubble, and the product's status under it. */
function Launching({ parts }: { parts: DraftLayoutParts }) {
  const { t } = useLocale();
  if (!parts.attempt) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <span className="min-w-0 max-w-[85%] whitespace-pre-wrap rounded-[10px] rounded-br-[3px] bg-accent-soft px-2.5 py-1.5 text-ui text-secondary">
          {parts.attempt.prompt || t("draft.imagesOnly")}
        </span>
      </div>
      {parts.launchStatus}
    </div>
  );
}

/**
 * The product's composer, whole: prompt, voice, images, the launch and every error it reports. `below` is
 * what a look keeps directly under the field, ahead of the thumbnails and the messages the composer adds.
 */
function Prompt({ parts, leftSlot, below }: { parts: DraftLayoutParts; leftSlot: ReactNode; below?: ReactNode }) {
  const { t } = useLocale();
  return (
    <form
      data-na-form=""
      data-na-reorder={below === undefined ? undefined : ""}
      className="flex min-w-0 flex-col gap-1.5"
      aria-label={t("draft.promptAria")}
      onSubmit={(event) => {
        event.preventDefault();
        parts.submit();
      }}
    >
      {parts.capabilityAlert ? <div style={{ order: 0 }}>{parts.capabilityAlert}</div> : null}
      <ComposerBar {...parts.composerProps} leftSlot={leftSlot} />
      {below ? <div data-na-below="" style={{ order: 2 }} className="flex min-w-0 flex-col gap-1.5">{below}</div> : null}
    </form>
  );
}

function Engines({ parts }: { parts: DraftLayoutParts }) {
  return <EngineRadioGroup engine={parts.launch.engine} engines={AGENT_LAUNCH_ENGINES} roomy disabled={parts.fieldsDisabled} onChange={parts.launch.setEngine} />;
}

/** A cell that fits «Account B · active» and «GPT-6-Astra» without cutting either. */
const RUNTIME_CELL = 150;

/**
 * Model, effort, speed and account as one grid of captioned cells: one row when every cell fits, two columns
 * otherwise, and an odd last cell takes the whole row. The selects are the product's own, in the order
 * `ReasoningControls` and `LaunchAccountSelect` render them; the grid only seats each under its caption.
 */
function RuntimeGrid({ parts, roomy }: { parts: DraftLayoutParts; roomy?: boolean }) {
  const captions = useCaptions();
  const { launch } = parts;
  const id = useId();
  const grid = useRef<HTMLDivElement | null>(null);
  const cells = [captions.model, captions.effort, ...(launch.engine === "codex" ? [captions.speed] : []), ...(launch.accounts.length ? [captions.account] : [])];
  const count = cells.length;
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const element = grid.current;
    if (!element) return;
    const measure = () => setWide(element.clientWidth >= count * RUNTIME_CELL);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [count]);
  const columns = wide ? count : Math.min(2, count);
  const order = (index: number, select: boolean) => Math.floor(index / columns) * 2 * columns + (select ? columns : 0) + (index % columns);
  const whole = (index: number) => columns === 2 && count % 2 === 1 && index === count - 1;
  const scope = `[data-na-runtime="${id}"]`;
  return (
    <div ref={grid} data-na-runtime={id} data-na-columns={columns} className="grid min-w-0 gap-x-1.5 gap-y-0.5" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      <style>{`${scope} > select { width: 100%; min-width: 0; }${cells.map((_, index) => `${scope} > select:nth-of-type(${index + 1}) { order: ${order(index, true)};${whole(index) ? " grid-column: 1 / -1;" : ""} }`).join("")}`}</style>
      {cells.map((caption, index) => (
        <span key={caption} className={`${CAPTION} ${index >= columns ? "pt-1" : ""}`} style={{ order: order(index, false), gridColumn: whole(index) ? "1 / -1" : undefined }}>{caption}</span>
      ))}
      <ReasoningControls
        engine={launch.engine}
        model={launch.model}
        effort={launch.effort}
        speed={launch.speed}
        disabled={parts.fieldsDisabled}
        roomy={roomy}
        onModel={launch.setModel}
        onEffort={launch.setEffort}
        onSpeed={launch.setSpeed}
      />
      <LaunchAccountSelect draft={launch} disabled={parts.fieldsDisabled} roomy={roomy} />
    </div>
  );
}

function Field({ label, aside, children }: { label: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className={`flex-1 ${CAPTION}`}>{label}</span>
        {aside}
      </div>
      {children}
    </div>
  );
}

function FolderField({ parts, openSignal, bare }: { parts: DraftLayoutParts; openSignal?: number; bare?: boolean }) {
  const { t } = useLocale();
  const picker = <DirectoryPicker id={`na-dirs-${parts.draftId}`} value={parts.cwd} dirs={parts.dirs} disabled={parts.fieldsDisabled} ariaLabel={t("draft.dirAria")} openSignal={openSignal} onChange={parts.setCwd} />;
  return bare ? picker : <Field label={t("draft.directory")}>{picker}</Field>;
}

/** The product's role block (select, description, parameters, prompt preview), without its strip. */
function RoleField({ parts, bare }: { parts: DraftLayoutParts; bare?: boolean }) {
  const { t } = useLocale();
  const block = (
    <div data-na-role="" className="min-w-0 flex-1">
      <RoleSection idPrefix={parts.draftId} roles={parts.roles} roleId={parts.roleId} roleParams={parts.roleParams} disabled={parts.fieldsDisabled} onSelectRole={parts.selectRole} onSetParam={parts.setRoleParam}>
        {parts.roleExtras}
      </RoleSection>
    </div>
  );
  return bare ? block : <Field label={t("draft.role")}>{block}</Field>;
}

function Shell({ look, parts, phone, className, children }: { look: NewAgentLook; parts: DraftLayoutParts; phone: boolean; className: string; children: ReactNode }) {
  const { t } = useLocale();
  return (
    /* `reader-host` is the board's own opt-out from its button reset (kanbanBoard.css:68), the one a conversation uses. */
    <section data-pan-ignore data-na-draft={look} data-na-phone={phone ? "" : undefined} data-na-handoff={parts.src ? "" : undefined} aria-label={t("draft.paneAria")} className={`reader-host flex min-w-0 flex-col ${className}`}>
      <style>{BOARD_CSS}</style>
      {children}
    </section>
  );
}

/** The phone's pane: what scrolls sits above, gathered at the foot; the composer never leaves the bottom edge. */
function PhonePane({ look, parts, settings }: { look: NewAgentLook; parts: DraftLayoutParts; settings: ReactNode }) {
  return (
    <Shell look={look} parts={parts} phone className="h-full min-h-0 flex-1 gap-2 bg-card p-3">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mt-auto flex min-w-0 flex-col gap-2">
          <Source parts={parts} />
          <Launching parts={parts} />
          {settings}
        </div>
      </div>
      <Prompt parts={parts} leftSlot={null} />
    </Shell>
  );
}

/**
 * Look 1. The composer is the card: the box the orchestrator's conversation
 * already has, with the engine in the row under it where that conversation
 * keeps its runtime, the model beside the engine it depends on, and every
 * other setting a captioned field below.
 */
function ComposerCard(parts: DraftLayoutParts) {
  const phone = useIsMobile();
  if (phone) {
    /* The phone's own header already says «New agent · draft», so the pane adds no heading of its own. */
    return (
      <PhonePane look={1} parts={parts} settings={(
        <>
          <div className="flex min-h-11 min-w-0 items-center gap-1.5">
            <Engines parts={parts} />
            <span className="flex-1" />
            <Close parts={parts} phone />
          </div>
          <RuntimeGrid parts={parts} />
          <FolderField parts={parts} />
          <RoleField parts={parts} />
        </>
      )} />
    );
  }
  return (
    <Shell look={1} parts={parts} phone={false} className="gap-2">
      <header className="flex min-h-7 items-center gap-1.5">
        <h3 title={parts.src || undefined} className="min-w-0 flex-1 truncate text-body font-semibold text-primary first-letter:uppercase">{parts.heading}</h3>
        <Close parts={parts} phone={false} />
      </header>
      <Launching parts={parts} />
      <Prompt parts={parts} leftSlot={<Engines parts={parts} />} below={<RuntimeGrid parts={parts} />} />
      <FolderField parts={parts} />
      <RoleField parts={parts} />
    </Shell>
  );
}

type Group = "runtime" | "folder" | "role";

/**
 * Look 2. One line: the prompt, and under it what the agent will run on, said
 * in words on a single row. A word that is pressed opens its own controls
 * directly under that row and nothing else. The row starts with the close
 * button, a rule apart from the words, and ends with the image picker, which
 * keeps the far right as it does in the orchestrator's composer: closing
 * clears the draft, so it stands away from everything pressed while writing.
 */
function OneLine(parts: DraftLayoutParts) {
  const { t } = useLocale();
  const phone = useIsMobile();
  const [open, setOpen] = useState<Group | null>(null);
  const [folderSignal, setFolderSignal] = useState(0);
  const { launch } = parts;
  const tint = engineTintOf(launch.engine);
  const model = ENGINE_MODELS[launch.engine].find((entry) => entry.id === launch.model)?.label ?? (launch.model || t("draft.modelDefault"));
  const account = launch.accounts.find((entry) => entry.id === launch.launchAccountId)?.label ?? null;
  const role = parts.roles.find((entry) => entry.id === parts.roleId) ?? null;
  const toggle = (group: Group) => {
    setOpen((current) => (current === group ? null : group));
    if (group === "folder") setFolderSignal((signal) => signal + 1);
  };
  /* The runtime is the longest of the three and the one that gives way: it alone is cut with an ellipsis
     when the row runs out, and the folder and the role keep their words. */
  const word = (group: Group, label: ReactNode, name: string, give: string) => (
    <button
      type="button"
      data-na-open={group}
      aria-expanded={open === group}
      aria-label={name}
      title={name}
      onClick={() => toggle(group)}
      className={`inline-flex items-center gap-1 rounded-control px-1.5 text-caption font-semibold text-secondary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 aria-expanded:bg-sunken aria-expanded:text-primary ${give} ${phone ? "min-h-11" : "h-7"}`}
    >
      <span className="min-w-0 truncate">{label}</span>
      <ChevronDown className={`h-3 w-3 shrink-0 text-muted ${open === group ? "rotate-180" : ""}`} aria-hidden />
    </button>
  );
  const words = (
    <div data-na-words="" className="flex min-w-0 flex-1 flex-nowrap items-center gap-0.5 overflow-hidden">
      {word("runtime", (
        <>
          <span style={{ color: tint.color }}>{launchEngineLabel(launch.engine)}</span>
          {" · "}{model}
          {launch.effort ? <>{" · "}{effortTierLabel(t, launch.effort)}</> : null}
          {launch.engine === "codex" && launch.speed ? <>{" · "}{t(launch.speed === "fast" ? "draft.speedFast" : "draft.speedStandard")}</> : null}
          {account ? <>{" · "}{account}</> : null}
        </>
      ), t("launch.reasoning"), "min-w-16 shrink")}
      {word("folder", parts.cwd || t("draft.directory"), t("draft.dirAria"), "max-w-36 shrink-0")}
      {word("role", role ? roleName(t, role) : t("draft.noRole"), t("draft.roleAria"), "max-w-32 shrink-0")}
    </div>
  );
  const editor = open ? (
    <div data-na-editor={open} className="flex min-w-0 flex-col gap-1.5 rounded-control bg-sunken p-2">
      {open === "runtime" ? (
        <>
          <Engines parts={parts} />
          <RuntimeGrid parts={parts} />
        </>
      ) : open === "folder" ? <FolderField parts={parts} openSignal={folderSignal} bare /> : <RoleField parts={parts} bare />}
    </div>
  ) : null;
  const dismiss = (
    <>
      <Close parts={parts} phone={phone} />
      <span aria-hidden className="mx-2 h-4 w-px shrink-0 bg-border" />
    </>
  );
  if (phone) {
    return (
      <PhonePane look={2} parts={parts} settings={(
        <>
          <div className="flex min-w-0 items-center gap-1">
            {dismiss}
            {words}
          </div>
          {editor}
        </>
      )} />
    );
  }
  return (
    <Shell look={2} parts={parts} phone={false} className="gap-1.5">
      <Source parts={parts} />
      <Launching parts={parts} />
      {/* One row inside the composer's own frame: the close button, the words, and the image picker last. */}
      <Prompt parts={parts} leftSlot={<>{dismiss}{words}</>} below={editor} />
    </Shell>
  );
}

const SHEET_WIDTH = 440;
/** What the foot gives back to the fields when they do not fit: the prompt shows three lines in place of five. */
const TIGHT_GAIN = 38;

/** The control the operator pressed: the card's own «+ Agent», or the header's. */
function sheetAnchor(band: string, createLabel: string): HTMLElement | null {
  const visible = (element: HTMLElement | null) => (element && element.getClientRects().length ? element : null);
  return visible(band ? document.querySelector<HTMLElement>(`[data-add-agent="${CSS.escape(band)}"]`) : null)
    ?? visible(document.querySelector<HTMLElement>("[data-new-agent]"))
    ?? visible(document.querySelector<HTMLElement>(`[data-bar-control][aria-label="${CSS.escape(createLabel)}"]`));
}

interface SheetPlace {
  top: number;
  left: number;
  maxHeight: number;
  /** The board card whose «+ Agent» opened the sheet, by its title. */
  task: string;
}

/**
 * Look 3. A sheet at the button: no card joins a column until an agent exists.
 * The fields are a captioned column that scrolls on its own; the composer, its
 * thumbnails and its errors are the sheet's foot and never leave the window.
 * When the column holds more than the window shows, the foot shortens its
 * prompt and each cut edge says so: a fade, and below it a chevron that scrolls
 * to the next fields. The sheet starts under the board's bar and names the task
 * it was opened for.
 */
function AnchoredSheet(parts: DraftLayoutParts) {
  const { t } = useLocale();
  const captions = useCaptions();
  const phone = useIsMobile();
  const sheet = useRef<HTMLElement | null>(null);
  const fields = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<SheetPlace | null>(null);
  const [cut, setCut] = useState({ above: false, below: false, tight: false });
  const createLabel = t("dash.createMenu");
  useLayoutEffect(() => {
    if (phone) return;
    let frame = 0;
    let marked: HTMLElement | null = null;
    const mark = (element: HTMLElement | null) => {
      if (marked === element) return;
      marked?.removeAttribute("data-na-anchor-open");
      marked?.removeAttribute("aria-expanded");
      marked = element;
      marked?.setAttribute("data-na-anchor-open", "");
      marked?.setAttribute("aria-expanded", "true");
    };
    /* The button moves while the board settles around it (the card that held the draft closes its seat),
       so the sheet follows it frame by frame; a prototype can afford the reads. Under the button when the
       sheet fits there, beside it otherwise, never above the bottom edge of the board's bar. */
    const update = () => {
      frame = requestAnimationFrame(update);
      const element = sheetAnchor(parts.band, createLabel);
      mark(element);
      const anchor = element?.getBoundingClientRect();
      const floor = (document.querySelector("header.bar")?.getBoundingClientRect().bottom ?? 46) + 6;
      const ceiling = window.innerHeight - 12;
      const width = Math.min(SHEET_WIDTH, window.innerWidth - 24);
      /* What the sheet would take with nothing scrolled: its own height plus what the fields hide. */
      const natural = (sheet.current?.offsetHeight ?? 0) + (fields.current ? fields.current.scrollHeight - fields.current.clientHeight : 0);
      const height = Math.min(natural, ceiling - floor);
      const clampLeft = (left: number) => Math.max(12, Math.min(left, window.innerWidth - width - 12));
      const clampTop = (top: number) => Math.max(floor, Math.min(top, ceiling - height));
      let next = { left: clampLeft(window.innerWidth), top: floor };
      if (anchor) {
        const below = Math.max(floor, anchor.bottom + 6);
        if (below + height <= ceiling) next = { left: clampLeft(anchor.left), top: below };
        else if (anchor.right + 8 + width <= window.innerWidth - 12) next = { left: anchor.right + 8, top: clampTop(anchor.top) };
        else if (anchor.left - 8 - width >= 12) next = { left: anchor.left - 8 - width, top: clampTop(anchor.top) };
        else next = { left: clampLeft(anchor.left), top: clampTop(below) };
      }
      const task = (parts.band ? element?.closest(".card")?.querySelector("h3.title")?.textContent?.trim() : "") ?? "";
      const maxHeight = ceiling - next.top;
      const column = fields.current;
      if (column) {
        const hidden = column.scrollHeight - column.clientHeight;
        const above = column.scrollTop > 1;
        const below = hidden - column.scrollTop > 1;
        const spare = maxHeight - (sheet.current?.offsetHeight ?? 0);
        /* The shorter prompt stays until the sheet has room for the longer one again, so the two never alternate. */
        setCut((current) => {
          const tight = hidden > 1 || (current.tight && spare < TIGHT_GAIN);
          return current.above === above && current.below === below && current.tight === tight ? current : { above, below, tight };
        });
      }
      setPlace((current) => (current && current.left === next.left && current.top === next.top && current.maxHeight === maxHeight && current.task === task ? current : { ...next, maxHeight, task }));
    };
    update();
    return () => {
      cancelAnimationFrame(frame);
      mark(null);
    };
  }, [phone, parts.band, createLabel]);
  const column = (close: boolean) => (
    <>
      <Field label={t("draft.engineAria")} aside={close ? <Close parts={parts} phone /> : null}><Engines parts={parts} /></Field>
      <RuntimeGrid parts={parts} />
      <FolderField parts={parts} />
      <RoleField parts={parts} />
    </>
  );
  if (phone) return <PhonePane look={3} parts={parts} settings={column(true)} />;
  return (
    <>
      <span data-na-seat="3" hidden><style>{BOARD_CSS}</style></span>
      {createPortal(
        <section
          ref={sheet}
          data-na-draft={3}
          data-na-sheet=""
          data-na-tight={cut.tight ? "" : undefined}
          data-na-handoff={parts.src ? "" : undefined}
          role="dialog"
          aria-label={t("draft.paneAria")}
          style={{ top: place?.top ?? 0, left: place?.left ?? 0, maxHeight: place?.maxHeight, width: Math.min(SHEET_WIDTH, window.innerWidth - 24), visibility: place ? "visible" : "hidden" }}
          className={`fixed ${Z.popover} flex flex-col rounded-surface border border-border bg-raised shadow-2`}
        >
          <header className="flex shrink-0 items-center gap-1.5 px-3 pb-1 pt-2.5">
            <div className="flex min-w-0 flex-1 flex-col">
              <h3 title={parts.src || undefined} className="min-w-0 truncate text-body font-semibold text-primary first-letter:uppercase">{parts.heading}</h3>
              {place?.task ? (
                <p data-na-task="" className="min-w-0 truncate text-caption text-muted">
                  <span className="font-semibold">{captions.task}:</span> {place.task}
                </p>
              ) : null}
            </div>
            <Close parts={parts} phone={false} />
          </header>
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div ref={fields} data-na-fields="" className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 pb-3 pt-1.5">
              {column(false)}
            </div>
            {cut.above ? <span aria-hidden data-na-more="above" className="pointer-events-none absolute inset-x-0 top-0 h-5 border-t border-border" style={{ background: "linear-gradient(to bottom, var(--surface-raised), transparent)" }} /> : null}
            {cut.below ? (
              <div data-na-more="below" className="pointer-events-none absolute inset-x-0 bottom-0 flex h-14 items-end justify-center pb-1.5" style={{ background: "linear-gradient(to top, var(--surface-raised) 40%, transparent)" }}>
                <button
                  type="button"
                  aria-label={captions.more}
                  title={captions.more}
                  onClick={() => fields.current?.scrollBy({ top: fields.current.clientHeight - 56 })}
                  className="pointer-events-auto inline-flex h-6 items-center gap-1 rounded-full border border-border bg-raised pl-1.5 pr-2 text-caption font-semibold text-secondary shadow-1 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  {captions.more}
                </button>
              </div>
            ) : null}
          </div>
          <div data-na-foot="" className="flex shrink-0 flex-col gap-2 border-t border-border px-3 pb-3 pt-2.5">
            <Launching parts={parts} />
            <Prompt parts={parts} leftSlot={parts.composerProps.leftSlot} />
          </div>
        </section>,
        document.body,
      )}
    </>
  );
}

const LAYOUTS: Record<NewAgentLook, DraftLayout | null> = { 0: null, 1: ComposerCard, 2: OneLine, 3: AnchoredSheet };

export function newAgentLayout(look: NewAgentLook): DraftLayout | null {
  return LAYOUTS[look];
}
