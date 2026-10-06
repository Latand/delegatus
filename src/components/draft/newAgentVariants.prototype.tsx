"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { ComposerBar } from "@/components/ComposerBar";
import { FeedMessageRow } from "@/components/conversation/OutboxBubbles";
import { ChevronDown, Zap } from "@/components/icons";
import { RuntimePopover, RuntimeSheet, tierWord, type AccountChoice, type RuntimePanel } from "@/components/RuntimePill";
import { FeedSkeleton } from "@/components/skeletons";
import { useAccountName } from "@/hooks/useEngineAccounts";
import { useIsMobile } from "@/hooks/useIsMobile";
import { effortScale } from "@/lib/agent/efforts";
import { ENGINE_MODELS } from "@/lib/agent/models";
import { useLocale } from "@/lib/i18n";

import { AGENT_LAUNCH_ENGINES, launchEngineLabel, type LaunchEngine } from "./AgentLaunchControls";
import type { DraftLayout, DraftLayoutParts } from "./draftLayout";

/*
 * Design prototypes for creating a new agent (docs/design/new-agent-redesign.md,
 * the operator's verdict of 2026-10-06). Creating an agent is the composer and
 * nothing else: the product's own `ComposerBar` with the runtime pill a
 * conversation's composer carries, and after Send the pane is the conversation.
 * The state, the launch and its recovery stay in `DraftAgentPane`. Only the
 * kanban fixture installs a look, through `?newagent=<n>`; nothing here is
 * reachable from the product.
 */

export const NEW_AGENT_LOOKS = [0, 1, 2] as const;
export type NewAgentLook = (typeof NEW_AGENT_LOOKS)[number];

const TITLES: Record<"en" | "uk", Record<NewAgentLook, string>> = {
  en: { 0: "Today", 1: "Only the composer, the conversation opens on Send", 2: "The conversation pane from the first frame" },
  uk: { 0: "Сьогодні", 1: "Лише композер, розмова відкривається після «Надіслати»", 2: "Панель розмови з першого кадру" },
};

/** What the fixture prepares before the page draws, for the states a press cannot reach in one step. */
export const NEW_AGENT_SEEDS = ["handoff", "signed-out", "refused"] as const;
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
      <iframe data-na-frame={look} title={TITLES[lang][look]} allow="microphone" src={`${location.pathname}?${inner.toString()}${location.hash}`} style={{ width, height, border: 0, display: "block" }} />
    </div>
  );
}

export const NEW_AGENT_STRIP = STRIP;

/* What the board does around a draft, undone for the looks: the card that holds a draft gives it a title of
   its own («Untitled task») and a foot, and a fixed conversation height. Look 1 is as tall as the composer
   until Send; look 2 keeps the conversation's height from the first frame. A shipped look would change the
   board's own rules; a prototype overrides them from here. */
const BOARD_CSS = `
.kb .card[data-id^="draft:"]:has([data-na-draft]) > :is(.head, .foot) { display: none; }
.kb .agent-draft:has([data-na-draft="1"]:not([data-na-sent])) { height: auto; }
.kb .card:not([data-id^="draft:"]) [data-na-draft] { border-top: 1px solid var(--border-default); padding-top: 8px; }
[data-na-opening] [data-skeleton="feed"] > :not(:last-child) { display: none; }
`;

/** A model of another engine as a row of the pill's model list; the draft's own engine keeps its plain ids,
    which is how the pill's panels look a model's name up. */
const foreignModel = (engine: LaunchEngine, model: string) => `${engine}/${model}`;

/**
 * The runtime pill of a conversation's composer, over a draft. The popover and
 * the phone's sheet are the pill's own; the draft answers them from its launch
 * parameters and applies a choice to itself, since no conversation exists yet
 * to reconfigure. The engine is chosen with the model: the list names every
 * engine's models, and a model of another engine moves the draft to it.
 */
function DraftRuntimePill({ parts }: { parts: DraftLayoutParts }) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const { launch } = parts;
  const { engine } = launch;
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<RuntimePanel>("root");
  const [at, setAt] = useState<{ bottom: number; left: number } | null>(null);
  /* The document the pill stands in, which its panels portal into; read at the press that opens them. */
  const [owner, setOwner] = useState<Document | null>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const nameOf = useAccountName(engine === "codex" ? "codex" : "claude");

  const modelOptions = useMemo(() => AGENT_LAUNCH_ENGINES.flatMap((owner) => ENGINE_MODELS[owner].map((model) => ({
    ...model, id: owner === engine ? model.id : foreignModel(owner, model.id), label: `${launchEngineLabel(owner)} · ${model.label}`,
  }))), [engine]);
  const efforts = effortScale(engine, launch.model) ?? [];
  /* No tier chosen is the engine's own default, which the phone's sheet says in the product's word for it. */
  const face = { model: launch.model, effort: launch.effort || t("draft.effortDefault"), fast: launch.speed === "fast" };
  const short = ENGINE_MODELS[engine].find((model) => model.id === launch.model)?.shortLabel ?? launch.model;
  const tier = launch.effort ? tierWord(t, launch.effort, isMobile) : "";
  const text = [launchEngineLabel(engine), short, tier, face.fast ? t("composer.speedFastTier") : ""].filter(Boolean).join(" · ");

  const close = useCallback(() => {
    setOpen(false);
    setPanel("root");
    pillRef.current?.focus();
  }, []);
  /* The popover opens upward, as a composer at the foot of a conversation needs. A draft's composer can
     stand near the top of a column, so a popover that would leave the window opens downward instead. */
  const place = useCallback(() => {
    const pill = pillRef.current?.getBoundingClientRect();
    const view = pillRef.current?.ownerDocument.defaultView;
    if (!pill || !view) return;
    const height = pillRef.current!.ownerDocument.querySelector<HTMLElement>("[data-runtime-popover]")?.offsetHeight ?? 0;
    const above = view.innerHeight - pill.top + 6;
    const fits = pill.top - 6 - height >= 8;
    setAt({ bottom: Math.max(8, fits ? above : view.innerHeight - pill.bottom - 6 - height), left: Math.max(8, Math.min(pill.left, view.innerWidth - 248)) });
  }, []);
  useLayoutEffect(() => {
    if (open && !isMobile) place();
  }, [open, panel, isMobile, place, efforts.length]);

  const accountChoice: AccountChoice | null = engine === "copilot" ? null : {
    runsOn: launch.launchAccountId,
    next: launch.launchAccountId,
    applying: false,
    pick: (accountId) => {
      launch.setAccountId(accountId);
      if (!isMobile) close();
    },
  };
  const selectModel = (key: string) => {
    const foreign = AGENT_LAUNCH_ENGINES.find((owner) => owner !== engine && key.startsWith(`${owner}/`));
    if (foreign) launch.setEngine(foreign);
    launch.setModel(foreign ? key.slice(foreign.length + 1) : key);
    if (!isMobile) close();
  };
  const panelProps = {
    t, engine, modelOptions, account: launch.launchAccountId, nameOf, accountChoice, face, efforts,
    speedShown: engine === "codex",
    speedDetail: face.fast ? t("composer.speedFastTier") : t("composer.speedStandard"),
    effortLocked: false, modelLocked: false, speedLocked: false, lockReason: "",
    onSelectEffort: (value: string) => {
      launch.setEffort(value);
      if (!isMobile) close();
    },
    onSelectModel: selectModel,
    onSelectFast: (fast: boolean) => {
      launch.setSpeed(fast ? "fast" : "standard");
      if (!isMobile) close();
    },
    onClose: close,
  };
  const picked = engine !== "copilot" && launch.accountId ? nameOf(launch.accountId) : "";

  return (
    <span className="relative inline-flex min-w-0" onPointerDown={(event) => event.stopPropagation()}>
      <button
        ref={pillRef}
        type="button"
        disabled={parts.fieldsDisabled}
        aria-haspopup={isMobile ? "dialog" : "menu"}
        aria-expanded={open}
        aria-label={`${t("composer.runtimePill")} — ${text}${picked ? ` → ${picked}` : ""}`}
        data-runtime-pill
        data-na-pill=""
        onClick={(event) => {
          if (open) return close();
          setOwner(event.currentTarget.ownerDocument);
          setOpen(true);
        }}
        /* The face is the conversation pill's own, class for class (`RuntimePill`). */
        className={isMobile
          ? "flex h-11 min-w-0 shrink items-center rounded-control px-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
          : `inline-flex h-7 min-w-0 shrink items-center gap-1 rounded-control px-1.5 text-label font-semibold text-secondary hover:bg-sunken hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 motion-reduce:transition-none disabled:opacity-60 ${open ? "bg-sunken text-primary" : ""}`}
      >
        {isMobile ? (
          <span className="inline-flex h-7 min-w-0 items-center gap-1 rounded-full bg-card px-2.5 text-label font-semibold text-secondary">
            <span className="min-w-0 truncate">{text}{picked ? ` → ${picked}` : ""}</span>
            <ChevronDown className="h-3 w-3 shrink-0" aria-hidden />
          </span>
        ) : (
          <>
            <Zap className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
            <span className="max-w-[52vw] truncate md:max-w-[16rem]">{text}</span>
            {picked ? <span className="max-w-[10rem] truncate text-accent" data-runtime-pill-next-account>→ {picked}</span> : null}
            <ChevronDown className="h-3 w-3 shrink-0" aria-hidden />
          </>
        )}
      </button>
      {open && owner && !isMobile ? <RuntimePopover {...panelProps} panel={panel} setPanel={setPanel} at={at ?? { bottom: 8, left: 8 }} owner={owner} /> : null}
      {open && owner && isMobile ? <RuntimeSheet {...panelProps} owner={owner} /> : null}
    </span>
  );
}

/**
 * The conversation as it opens: the operator's first message as the feed's own
 * row, and under it the feed's loading shape where the agent's first words will
 * be, both at the foot of the pane, above the composer, where a feed keeps its
 * latest rows. The launch says something in words only once it needs the operator.
 */
function Opening({ parts }: { parts: DraftLayoutParts }) {
  const { t } = useLocale();
  const attempt = parts.attempt!;
  return (
    <div data-na-opening="" className="flex min-h-0 flex-1 flex-col justify-end gap-3 overflow-hidden">
      <FeedMessageRow entry={null} canonical={{ text: attempt.prompt || t("draft.imagesOnly") }} />
      <FeedSkeleton className="!flex-none !px-0 !pb-1 !pt-0" />
      {attempt.phase === "attention" || attempt.error ? parts.launchStatus : null}
    </div>
  );
}

function Draft({ look, parts }: { look: 1 | 2; parts: DraftLayoutParts }) {
  const { t } = useLocale();
  const phone = useIsMobile();
  const sent = Boolean(parts.attempt);
  const tall = look === 2 || sent || phone;
  const { composer } = parts.composerProps;
  const input = composer.inputRef;
  const form = useRef<HTMLFormElement>(null);
  /* The cursor is in the field the moment the draft opens. */
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, [input]);
  /* The composer is in sight when the draft opens and when Send makes the pane a conversation, with the first
     message directly above it: the board reveals a card it opens the same way, and a shipped look would ask
     the board for it. */
  useEffect(() => {
    form.current?.scrollIntoView({ block: "nearest" });
  }, [sent]);
  return (
    /* `reader-host` is the board's own opt-out from its button reset (kanbanBoard.css:68), the one a conversation uses. */
    <section
      data-pan-ignore
      data-na-draft={look}
      data-na-sent={sent ? "" : undefined}
      aria-label={t("draft.paneAria")}
      className={`reader-host flex min-w-0 flex-col gap-2 ${tall ? "h-full min-h-0 flex-1" : ""} ${phone ? "bg-card p-3" : ""}`}
    >
      <style>{BOARD_CSS}</style>
      {tall ? (sent ? <Opening parts={parts} /> : <div data-na-room="" className="min-h-0 flex-1" />) : null}
      <form
        ref={form}
        data-na-form=""
        className="flex min-w-0 shrink-0 flex-col gap-1.5"
        aria-label={t("draft.promptAria")}
        onSubmit={(event) => {
          event.preventDefault();
          parts.submit();
        }}
        onKeyDown={(event) => {
          /* Escape on an empty field puts the draft away, as it does for a new task. */
          if (event.key !== "Escape" || event.defaultPrevented || sent || composer.text || composer.attachments.attachments.length) return;
          event.preventDefault();
          parts.onClose();
        }}
      >
        {parts.capabilityAlert}
        <ComposerBar
          {...parts.composerProps}
          sendIdleClassName="border-accent bg-accent hover:opacity-90"
          sendIdleStyle={undefined}
          leftSlot={<DraftRuntimePill parts={parts} />}
        />
      </form>
    </section>
  );
}

function ComposerOnly(parts: DraftLayoutParts) {
  return <Draft look={1} parts={parts} />;
}

function ConversationPane(parts: DraftLayoutParts) {
  return <Draft look={2} parts={parts} />;
}

const LAYOUTS: Record<NewAgentLook, DraftLayout | null> = { 0: null, 1: ComposerOnly, 2: ConversationPane };

export function newAgentLayout(look: NewAgentLook): DraftLayout | null {
  return LAYOUTS[look];
}
