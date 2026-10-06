"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import { RuntimePillFace, RuntimePopover, RuntimeSheet, tierWord, type AccountChoice, type RuntimePanel } from "@/components/RuntimePill";
import { useAccountName } from "@/hooks/useEngineAccounts";
import { useIsMobile } from "@/hooks/useIsMobile";
import { effortScale } from "@/lib/agent/efforts";
import { ENGINE_MODELS } from "@/lib/agent/models";
import { useLocale } from "@/lib/i18n";

import { AGENT_LAUNCH_ENGINES, launchEngineLabel, type AgentLaunchDraft, type LaunchEngine } from "./AgentLaunchControls";

/** A model of another engine as a row of the model list; the draft's own engine keeps its plain ids,
    which is how the pill's panels look a model's name up. */
const foreignModel = (engine: LaunchEngine, model: string) => `${engine}/${model}`;

/**
 * The runtime pill of a conversation's composer, over an agent that does not
 * exist yet. The face, the popover and the phone's sheet are the pill's own;
 * the draft answers them from its launch parameters and applies a choice to
 * itself, since there is no conversation to reconfigure. So what the face says
 * is what Send launches.
 *
 * The engine is chosen with the model: a conversation has one engine and its
 * pill never offers another, a draft has to pick it, so the model list names
 * every engine's models and a model of another engine moves the draft there.
 */
export function DraftRuntimePill({ launch, disabled = false }: { launch: AgentLaunchDraft; disabled?: boolean }) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const { engine } = launch;
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<RuntimePanel>("root");
  const [at, setAt] = useState<{ bottom: number; left: number } | null>(null);
  /* The document the pill stands in, which its panels portal into; read at the press that opens them. */
  const [owner, setOwner] = useState<Document | null>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const nameOf = useAccountName(engine === "codex" ? "codex" : "claude");

  const modelOptions = useMemo(() => AGENT_LAUNCH_ENGINES.flatMap((entry) => ENGINE_MODELS[entry].map((model) => ({
    ...model, id: entry === engine ? model.id : foreignModel(entry, model.id), label: `${launchEngineLabel(entry)} · ${model.label}`,
  }))), [engine]);
  const efforts = effortScale(engine, launch.model) ?? [];
  const fast = launch.speed === "fast";
  /* No tier chosen is the engine's own default, and the launch sends none: the face says so in a word
     instead of naming a tier the agent may not run at. */
  const tier = launch.effort ? tierWord(t, launch.effort, isMobile) : t("draft.tierDefault");
  const short = ENGINE_MODELS[engine].find((model) => model.id === launch.model)?.shortLabel ?? launch.model;
  const text = [launchEngineLabel(engine), short, tier, fast ? t("composer.speedFastTier") : ""].filter(Boolean).join(" · ");
  /* The account is named once the operator picked one; before that the engine's active account takes the
     launch, which the panels say in their own account line. The phone's chip names no account, as a
     conversation's does not: its sheet leads with the accounts and marks the one the launch goes to. */
  const picked = engine !== "copilot" && launch.accountId ? nameOf(launch.launchAccountId) : "";

  const close = useCallback(() => {
    setOpen(false);
    setPanel("root");
    pillRef.current?.focus();
  }, []);
  /* The popover opens upward, as a composer at the foot of a conversation needs. A draft's composer can
     stand near the top of a column, so a popover that would leave the window opens downward instead. */
  const place = useCallback(() => {
    const pill = pillRef.current;
    const view = pill?.ownerDocument.defaultView;
    if (!pill || !view) return;
    const rect = pill.getBoundingClientRect();
    const height = pill.ownerDocument.querySelector<HTMLElement>("[data-runtime-popover]")?.offsetHeight ?? 0;
    const fits = rect.top - 6 - height >= 8;
    setAt({
      bottom: Math.max(8, fits ? view.innerHeight - rect.top + 6 : view.innerHeight - rect.bottom - 6 - height),
      left: Math.max(8, Math.min(rect.left, view.innerWidth - 248)),
    });
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
  const panelProps = {
    t, engine, modelOptions, account: launch.launchAccountId, nameOf, accountChoice, efforts,
    accountStart: launch.launchAccountId ? t("draft.accountStartsOn", { account: nameOf(launch.launchAccountId) }) : "",
    face: { model: launch.model, effort: launch.effort, fast },
    speedShown: engine === "codex",
    speedDetail: fast ? t("composer.speedFastTier") : t("composer.speedStandard"),
    effortLocked: false, modelLocked: false, speedLocked: false, lockReason: "",
    onSelectEffort: (value: string) => {
      launch.setEffort(value);
      if (!isMobile) close();
    },
    onSelectModel: (key: string) => {
      const foreign = AGENT_LAUNCH_ENGINES.find((entry) => entry !== engine && key.startsWith(`${entry}/`));
      if (foreign) launch.setEngine(foreign);
      launch.setModel(foreign ? key.slice(foreign.length + 1) : key);
      if (!isMobile) close();
    },
    onSelectFast: (value: boolean) => {
      launch.setSpeed(value ? "fast" : "standard");
      if (!isMobile) close();
    },
    onClose: close,
  };
  const show = (document: Document) => {
    setOwner(document);
    setOpen(true);
  };

  return (
    <span className="relative inline-flex min-w-0" onPointerDown={(event) => event.stopPropagation()}>
      <RuntimePillFace
        pillRef={pillRef}
        phone={isMobile}
        open={open}
        disabled={disabled}
        label={`${t("composer.runtimePill")} — ${text}${picked ? ` → ${picked}` : ""}`}
        text={text}
        nextAccount={picked || null}
        onToggle={() => (open ? close() : pillRef.current ? show(pillRef.current.ownerDocument) : undefined)}
        onOpen={() => { if (pillRef.current) show(pillRef.current.ownerDocument); }}
      />
      {open && owner && !isMobile ? <RuntimePopover {...panelProps} panel={panel} setPanel={setPanel} at={at ?? { bottom: 8, left: 8 }} owner={owner} /> : null}
      {open && owner && isMobile ? (
        <RuntimeSheet {...panelProps} owner={owner} heading={{ title: t("draft.sheetTitle"), summary: t("draft.sheetSummary", { runtime: text }) }} />
      ) : null}
    </span>
  );
}
