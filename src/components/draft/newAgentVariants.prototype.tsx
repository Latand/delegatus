"use client";

import { Folder } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
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

export function parseNewAgent(search: string): { look: NewAgentLook; inner: boolean } | null {
  const params = new URLSearchParams(search);
  const raw = params.get("newagent");
  if (raw === null) return null;
  const look = Number(raw) as NewAgentLook;
  if (!NEW_AGENT_LOOKS.includes(look)) return null;
  return { look, inner: params.get("inner") === "1" };
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
   look would change the board's own rules; a prototype overrides them from here. */
const BOARD_CSS = `
.kb .agent-draft:has([data-na-draft]) { height: auto; max-width: none; }
.kb .card[data-id^="draft:"]:has([data-na-draft="1"], [data-na-draft="2"]) > :is(.head, .foot) { display: none; }
.kb .card[data-id^="draft:"]:has([data-na-seat="3"]) { display: none; }
.kb .agent-drafts:has([data-na-seat="3"]) { display: none; }
.kb .card:not([data-id^="draft:"]) [data-na-draft] { border-top: 1px solid var(--border-default); padding-top: 8px; }
[data-na-role] > div { border: 0; background: none; padding: 0; }
[data-na-role][data-na-bare] label[for^="draft-role-"] { display: none; }
`;

const ICON_BUTTON = "inline-flex shrink-0 items-center justify-center rounded-control text-muted hover:bg-sunken hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

function Close({ parts, phone }: { parts: DraftLayoutParts; phone: boolean }) {
  const { t } = useLocale();
  return (
    <button type="button" className={`${ICON_BUTTON} ${phone ? "h-11 w-11" : "h-7 w-7"}`} aria-label={t("draft.dismiss")} title={t("draft.dismiss")} onClick={parts.onClose}>
      <X className="h-4 w-4" aria-hidden />
    </button>
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

/** The product's composer, whole: prompt, voice, images, the launch and every error it reports. */
function Prompt({ parts, leftSlot }: { parts: DraftLayoutParts; leftSlot: ReactNode }) {
  const { t } = useLocale();
  return (
    <form
      className="flex min-w-0 flex-col gap-1.5"
      aria-label={t("draft.promptAria")}
      onSubmit={(event) => {
        event.preventDefault();
        parts.submit();
      }}
    >
      {parts.capabilityAlert}
      <ComposerBar {...parts.composerProps} leftSlot={leftSlot} />
    </form>
  );
}

function Engines({ parts, roomy }: { parts: DraftLayoutParts; roomy?: boolean }) {
  return <EngineRadioGroup engine={parts.launch.engine} engines={AGENT_LAUNCH_ENGINES} roomy={roomy} disabled={parts.fieldsDisabled} onChange={parts.launch.setEngine} />;
}

function Reasoning({ parts, roomy }: { parts: DraftLayoutParts; roomy?: boolean }) {
  const { launch } = parts;
  return (
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
  );
}

function FolderPicker({ parts, openSignal }: { parts: DraftLayoutParts; openSignal?: number }) {
  const { t } = useLocale();
  return <DirectoryPicker id={`na-dirs-${parts.draftId}`} value={parts.cwd} dirs={parts.dirs} disabled={parts.fieldsDisabled} ariaLabel={t("draft.dirAria")} openSignal={openSignal} onChange={parts.setCwd} />;
}

/** The product's role block (select, description, parameters, prompt preview), without its strip. */
function Role({ parts, bare }: { parts: DraftLayoutParts; bare?: boolean }) {
  return (
    <div data-na-role="" data-na-bare={bare ? "" : undefined} className="min-w-0 flex-1">
      <RoleSection idPrefix={parts.draftId} roles={parts.roles} roleId={parts.roleId} roleParams={parts.roleParams} disabled={parts.fieldsDisabled} onSelectRole={parts.selectRole} onSetParam={parts.setRoleParam}>
        {parts.roleExtras}
      </RoleSection>
    </div>
  );
}

function Shell({ look, parts, className, children }: { look: NewAgentLook; parts: DraftLayoutParts; className: string; children: ReactNode }) {
  const { t } = useLocale();
  return (
    /* `reader-host` is the board's own opt-out from its button reset (kanbanBoard.css:68), the one a conversation uses. */
    <section data-pan-ignore data-na-draft={look} aria-label={t("draft.paneAria")} title={parts.headingTitle} className={`reader-host flex min-w-0 flex-col ${className}`}>
      <style>{BOARD_CSS}</style>
      {children}
    </section>
  );
}

/**
 * Look 1. The composer is the card: the box the orchestrator's conversation
 * already has, with the runtime in the row under it where that conversation
 * keeps its runtime, then the folder and the role, one quiet row each.
 */
function ComposerCard(parts: DraftLayoutParts) {
  const phone = useIsMobile();
  /* The engine and the account it runs on share the composer's own row; the three reasoning selects
     tile the row under it edge to edge, so nothing wraps to a ragged second line in a narrow column. */
  const runtime = (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <Engines parts={parts} />
      <LaunchAccountSelect draft={parts.launch} disabled={parts.fieldsDisabled} className="max-w-44" />
    </div>
  );
  const context = (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 [&>select]:min-w-24 [&>select]:flex-1"><Reasoning parts={parts} /></div>
      <div className="flex min-w-0 items-center gap-1.5">
        <Folder className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
        <FolderPicker parts={parts} />
      </div>
      <Role parts={parts} bare />
    </>
  );
  return (
    <Shell look={1} parts={parts} className={phone ? "h-full flex-1 gap-2 bg-card p-3" : "gap-2"}>
      <header className="flex min-h-7 items-center gap-1.5">
        <h3 className="min-w-0 flex-1 truncate text-body font-semibold text-primary first-letter:uppercase">{parts.heading}</h3>
        <Close parts={parts} phone={phone} />
      </header>
      {phone ? <div className="min-h-0 flex-1" /> : null}
      <Launching parts={parts} />
      {phone ? <div className="flex flex-col gap-2">{runtime}{context}</div> : null}
      <Prompt parts={parts} leftSlot={phone ? null : runtime} />
      {phone ? null : context}
    </Shell>
  );
}

/**
 * Look 2. One line: the prompt, and under it what the agent will run on, said
 * in words. A word that is pressed opens its own controls and nothing else.
 */
function OneLine(parts: DraftLayoutParts) {
  const { t } = useLocale();
  const phone = useIsMobile();
  const [open, setOpen] = useState<"runtime" | "folder" | "role" | null>(null);
  const [folderSignal, setFolderSignal] = useState(0);
  const { launch } = parts;
  const tint = engineTintOf(launch.engine);
  const model = ENGINE_MODELS[launch.engine].find((entry) => entry.id === launch.model)?.label ?? (launch.model || t("draft.modelDefault"));
  const account = launch.accounts.find((entry) => entry.id === launch.launchAccountId)?.label ?? null;
  const role = parts.roles.find((entry) => entry.id === parts.roleId) ?? null;
  const toggle = (group: "runtime" | "folder" | "role") => {
    setOpen((current) => (current === group ? null : group));
    if (group === "folder") setFolderSignal((signal) => signal + 1);
  };
  const word = (group: "runtime" | "folder" | "role", label: ReactNode, name: string) => (
    <button
      type="button"
      data-na-open={group}
      aria-expanded={open === group}
      aria-label={name}
      title={name}
      onClick={() => toggle(group)}
      className={`inline-flex min-w-0 items-center gap-1 rounded-control px-1.5 text-caption font-semibold text-secondary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 aria-expanded:bg-sunken aria-expanded:text-primary ${phone ? "min-h-11" : "h-7"}`}
    >
      <span className="min-w-0 truncate">{label}</span>
      <ChevronDown className={`h-3 w-3 shrink-0 text-muted ${open === group ? "rotate-180" : ""}`} aria-hidden />
    </button>
  );
  const words = (
    <div className="flex min-w-0 flex-wrap items-center gap-x-0.5 gap-y-0.5">
      {word("runtime", (
        <>
          <span style={{ color: tint.color }}>{launchEngineLabel(launch.engine)}</span>
          {" · "}{model}
          {launch.effort ? <>{" · "}{effortTierLabel(t, launch.effort)}</> : null}
          {launch.engine === "codex" && launch.speed ? <>{" · "}{t(launch.speed === "fast" ? "draft.speedFast" : "draft.speedStandard")}</> : null}
          {account ? <>{" · "}{account}</> : null}
        </>
      ), t("launch.reasoning"))}
      {word("folder", parts.cwd || t("draft.directory"), t("draft.dirAria"))}
      {word("role", role ? roleName(t, role) : t("draft.noRole"), t("draft.roleAria"))}
    </div>
  );
  const editor = open ? (
    <div data-na-editor={open} className="flex min-w-0 flex-wrap items-center gap-1.5 rounded-control bg-sunken p-2 [&>select]:min-w-24 [&>select]:flex-1">
      {open === "runtime" ? (
        <>
          <Engines parts={parts} />
          <Reasoning parts={parts} />
          <LaunchAccountSelect draft={launch} disabled={parts.fieldsDisabled} />
        </>
      ) : open === "folder" ? <FolderPicker parts={parts} openSignal={folderSignal} /> : <Role parts={parts} bare />}
    </div>
  ) : null;
  return (
    <Shell look={2} parts={parts} className={phone ? "h-full flex-1 gap-2 bg-card p-3" : "gap-1.5"}>
      {phone ? (
        <>
          <header className="flex items-center gap-1.5">
            <h3 className="min-w-0 flex-1 truncate text-body font-semibold text-primary first-letter:uppercase">{parts.heading}</h3>
            <Close parts={parts} phone />
          </header>
          <div className="min-h-0 flex-1" />
        </>
      ) : null}
      <Launching parts={parts} />
      {phone ? <>{editor}{words}</> : null}
      <div className="flex min-w-0 items-start gap-1">
        <div className="min-w-0 flex-1"><Prompt parts={parts} leftSlot={phone ? null : words} /></div>
        {phone ? null : <Close parts={parts} phone={false} />}
      </div>
      {/* The editor ends where the composer ends: the close button keeps its own gutter. */}
      {phone || !editor ? null : <div className="mr-8 flex min-w-0 flex-col">{editor}</div>}
    </Shell>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-label font-semibold text-muted first-letter:uppercase">{label}</span>
      {children}
    </div>
  );
}

const SHEET_WIDTH = 440;

/** The control the operator pressed: the card's own «+ Agent», or the header's. */
function sheetAnchor(band: string, createLabel: string): HTMLElement | null {
  const visible = (element: HTMLElement | null) => (element && element.getClientRects().length ? element : null);
  return visible(band ? document.querySelector<HTMLElement>(`[data-add-agent="${CSS.escape(band)}"]`) : null)
    ?? visible(document.querySelector<HTMLElement>("[data-new-agent]"))
    ?? visible(document.querySelector<HTMLElement>(`[data-bar-control][aria-label="${CSS.escape(createLabel)}"]`));
}

/**
 * Look 3. A sheet at the button: no card joins a column until an agent exists.
 * The fields are the labelled column the orchestrator's own create panel uses,
 * and the composer closes the sheet's foot.
 */
function AnchoredSheet(parts: DraftLayoutParts) {
  const { t } = useLocale();
  const phone = useIsMobile();
  const sheet = useRef<HTMLElement | null>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const createLabel = t("dash.createMenu");
  useLayoutEffect(() => {
    if (phone) return;
    let frame = 0;
    /* The button moves while the board settles around it (the card that held the draft closes its seat),
       so the sheet follows it frame by frame; a prototype can afford the reads. Under the button when the
       sheet fits there, beside it otherwise, so the button that opened it stays in view. */
    const update = () => {
      frame = requestAnimationFrame(update);
      const anchor = sheetAnchor(parts.band, createLabel)?.getBoundingClientRect();
      const width = Math.min(SHEET_WIDTH, window.innerWidth - 24);
      const height = sheet.current?.offsetHeight ?? 0;
      const clampLeft = (left: number) => Math.max(12, Math.min(left, window.innerWidth - width - 12));
      const clampTop = (top: number) => Math.max(12, Math.min(top, window.innerHeight - height - 12));
      let next = { left: clampLeft(window.innerWidth), top: 58 };
      if (anchor) {
        const below = anchor.bottom + 6;
        if (below + height <= window.innerHeight - 12) next = { left: clampLeft(anchor.left), top: below };
        else if (anchor.right + 8 + width <= window.innerWidth - 12) next = { left: anchor.right + 8, top: clampTop(anchor.top) };
        else if (anchor.left - 8 - width >= 12) next = { left: anchor.left - 8 - width, top: clampTop(anchor.top) };
        else next = { left: clampLeft(anchor.left), top: clampTop(below) };
      }
      setPlace((current) => (current && current.left === next.left && current.top === next.top ? current : next));
    };
    update();
    return () => cancelAnimationFrame(frame);
  }, [phone, parts.band, createLabel]);
  const { launch } = parts;
  const body = (
    <>
      <header className="flex items-center gap-1.5">
        <h3 className="min-w-0 flex-1 truncate text-body font-semibold text-primary first-letter:uppercase">{parts.heading}</h3>
        <Close parts={parts} phone={phone} />
      </header>
      <div className={`flex min-w-0 flex-col gap-2.5 ${phone ? "min-h-0 flex-1 overflow-y-auto" : ""}`}>
        <Field label={t("draft.engineAria")}><Engines parts={parts} roomy /></Field>
        {launch.accounts.length ? (
          <Field label={t("launch.account")}><LaunchAccountSelect draft={launch} disabled={parts.fieldsDisabled} roomy className="w-full" /></Field>
        ) : null}
        <Field label={t("launch.reasoning")}>
          <div className="flex flex-wrap items-center gap-2 [&>select]:min-w-28 [&>select]:flex-1"><Reasoning parts={parts} roomy /></div>
        </Field>
        <Field label={t("draft.directory")}><FolderPicker parts={parts} /></Field>
        <Field label={t("draft.role")}><Role parts={parts} bare /></Field>
      </div>
      <Launching parts={parts} />
      <div className="border-t border-border pt-2.5"><Prompt parts={parts} leftSlot={parts.composerProps.leftSlot} /></div>
    </>
  );
  if (phone) return <Shell look={3} parts={parts} className="h-full flex-1 gap-3 bg-card p-3">{body}</Shell>;
  return (
    <>
      <span data-na-seat="3" hidden><style>{BOARD_CSS}</style></span>
      {createPortal(
        <section
          ref={sheet}
          data-na-draft={3}
          data-na-sheet=""
          role="dialog"
          aria-label={t("draft.paneAria")}
          style={{ top: place?.top ?? 0, left: place?.left ?? 0, width: Math.min(SHEET_WIDTH, window.innerWidth - 24), visibility: place ? "visible" : "hidden" }}
          className={`fixed ${Z.popover} flex max-h-[calc(100dvh-24px)] flex-col gap-3 overflow-y-auto rounded-surface border border-border bg-raised p-3 shadow-2`}
        >
          {body}
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
