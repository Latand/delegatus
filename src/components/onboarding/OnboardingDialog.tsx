"use client";

import { AlertTriangle, Check, ChevronLeft, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Z } from "@/components/layers";
import { useEngineAccounts } from "@/hooks/useEngineAccounts";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { OnboardingMarker } from "@/lib/onboarding/marker";
import { ONBOARDING_STEP_IDS, type OnboardingStepId, type OnboardingStepState } from "@/lib/onboarding/steps";
import type { RoleEngine } from "@/lib/roles/types";

import { AgentMappingTable, type EngineStatus } from "./AgentMappingTable";
import { CheckStep } from "./CheckStep";
import { engineAccount, engineReady, EnginesStep, type CliPresence } from "./EnginesStep";
import { PhoneStep, type PhoneStepOutcome } from "./PhoneStep";
import { TourStep, type TourHandle, type TourProject } from "./TourStep";
import { putOnboarding, useOnboarding, type OnboardingMode } from "./useOnboarding";
import { VoiceStep } from "./VoiceStep";

/**
 * The setup guide (#1876, design §2–§3): Engines, Agents, Phone, Voice, Tour
 * and Check. One dialog, one job per step, no welcome or finish screen.
 * Nothing is gated: steps are freely navigable, every step closes by Escape,
 * ✕ or "Close, finish later", and nothing in the app waits on it — the launch
 * refusal works the same with or without it. The "Agent mapping" and
 * "Dictation" menu rows open step 2's table or step 4 alone in the same shell.
 */

const STEPS: readonly OnboardingStepId[] = ONBOARDING_STEP_IDS;

const STEP_KEY: Record<OnboardingStepId, Parameters<TFunction>[0]> = {
  engines: "onboarding.step.engines",
  agents: "onboarding.step.agents",
  phone: "onboarding.step.phone",
  voice: "onboarding.step.voice",
  tour: "onboarding.step.tour",
  check: "onboarding.step.check",
};

const HEADING_KEY: Record<OnboardingStepId, Parameters<TFunction>[0]> = {
  engines: "onboarding.engines.heading",
  agents: "onboarding.agents.heading",
  phone: "onboarding.phone.heading",
  voice: "onboarding.voice.heading",
  tour: "onboarding.tour.heading",
  check: "onboarding.check.heading",
};

/* The Check step writes its own lead: it names the model the run will use.
   The tour's cards are its lead. */
const LEAD_KEY: Record<OnboardingStepId, Parameters<TFunction>[0] | null> = {
  engines: "onboarding.engines.lead",
  agents: "onboarding.agents.lead",
  phone: "onboarding.phone.lead",
  voice: "onboarding.voice.lead",
  tour: null,
  check: null,
};

/* The seat tick's shipped check interval, until the server says otherwise. */
const DEFAULT_CHECK_MINUTES = 5;

/** `/api/accounts` also says whether each engine's command resolves; the
    engine stores parse the accounts, so the step reads that one fact itself. */
function useCliPresence(): { cli: Record<RoleEngine, CliPresence>; recheck: () => void } {
  const [cli, setCli] = useState<Record<RoleEngine, CliPresence>>({ claude: null, codex: null });
  const read = useCallback((fresh: boolean) => {
    const presence = (value: unknown): CliPresence => value === "found" || value === "missing" ? value : null;
    void fetch(fresh ? "/api/accounts/cli" : "/api/accounts")
      .then(async (response) => response.ok ? (await response.json()) as Record<RoleEngine, unknown> : null)
      .catch(() => null)
      .then((body) => {
        if (!body) return;
        /* The accounts read nests the fact per engine; the re-probe answers it flat. */
        const read = (engine: RoleEngine) => {
          const value = body[engine];
          return presence(value && typeof value === "object" ? (value as { cli?: unknown }).cli : value);
        };
        setCli({ claude: read("claude"), codex: read("codex") });
      });
  }, []);
  useEffect(() => read(false), [read]);
  return { cli, recheck: () => read(true) };
}

function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function firstOpenStep(marker: OnboardingMarker | null): number {
  const index = STEPS.findIndex((step) => !marker?.steps[step]);
  return index < 0 ? 0 : index;
}

export function OnboardingDialog({ mode, initialStep, marker, onClose, projects = [], currentProject = null, checkMinutes = DEFAULT_CHECK_MINUTES }: {
  mode: OnboardingMode;
  /** Open the guide on this step (the QR popover opens it on Phone). */
  initialStep?: OnboardingStepId | null;
  marker: OnboardingMarker | null;
  onClose: (outcome: "dismissed" | "completed") => void;
  /** The projects the rail lists, for the tour's first action. */
  projects?: readonly TourProject[];
  currentProject?: string | null;
  checkMinutes?: number;
}) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const claude = useEngineAccounts("claude");
  const codex = useEngineAccounts("codex");
  const { cli, recheck } = useCliPresence();
  const now = useNow();
  const [view, setView] = useState<OnboardingMode>(mode);
  const [step, setStep] = useState(() => {
    const target = mode === "mapping" ? "agents" : mode === "voice" ? "voice" : initialStep ?? null;
    return target ? STEPS.indexOf(target) : firstOpenStep(marker);
  });
  const [steps, setSteps] = useState<Record<OnboardingStepId, OnboardingStepState>>(() => ({ ...Object.fromEntries(STEPS.map((id) => [id, null])), ...marker?.steps }) as Record<OnboardingStepId, OnboardingStepState>);
  /* What the Phone step ended on: Continue counts it done only once phone
     access is on, and skipped otherwise. */
  const phoneOutcome = useRef<PhoneStepOutcome | null>(null);
  /* The phone state on screen, for who holds the one filled button. */
  const [phoneState, setPhoneState] = useState<PhoneStepOutcome | null>(null);
  const tourRef = useRef<TourHandle>(null);
  /* Every step the guide showed; finishing marks the ones never left by
     Continue as done, since the user has seen them. */
  const visited = useRef(new Set<OnboardingStepId>());
  const [stepListOpen, setStepListOpen] = useState(false);
  const [checkOwnsPrimary, setCheckOwnsPrimary] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const dismissRef = useRef<() => void>(() => {});
  /* Keyboard for the whole time the dialog is open, listened on the window so
     it holds wherever focus is: Escape closes the guide, and Tab cycles inside
     the panel. Focus goes to the panel on open and back to whatever held it
     before on close. */
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismissRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>("button:not([disabled]), select:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])"))
        .filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      const active = document.activeElement;
      const inside = active instanceof Node && panel.contains(active);
      if (!inside || active === panel) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  useEffect(() => { bodyRef.current?.scrollTo?.({ top: 0 }); }, [step, view]);

  const statuses: Record<RoleEngine, EngineStatus> = {
    claude: { connected: engineReady(claude, cli.claude), missing: cli.claude === "missing", account: engineAccount(claude) },
    codex: { connected: engineReady(codex, cli.codex), missing: cli.codex === "missing", account: engineAccount(codex) },
  };
  /* A visited Engines step earns its check only when an engine can run; with
     none it carries the warning its own screen shows. */
  const enginesSettled = claude.status !== "loading" && codex.status !== "loading";
  const noEngine = enginesSettled && !statuses.claude.connected && !statuses.codex.connected;
  const current = STEPS[step]!;
  useEffect(() => {
    if (view === "guide") visited.current.add(current);
  }, [view, current]);
  const last = step === STEPS.length - 1;

  const mark = (id: OnboardingStepId, state: "done" | "skipped") => {
    if (steps[id] === state) return;
    setSteps((value) => ({ ...value, [id]: state }));
    void putOnboarding({ steps: { [id]: state } });
  };
  const markDone = (id: OnboardingStepId) => mark(id, "done");
  const goTo = (index: number) => {
    setStepListOpen(false);
    setStep(Math.max(0, Math.min(STEPS.length - 1, index)));
  };
  const skipAndContinue = (id: OnboardingStepId) => {
    mark(id, "skipped");
    goTo(STEPS.indexOf(id) + 1);
  };
  const next = () => {
    /* On the phone the tour is a pager: Continue turns its pages first. */
    if (current === "tour" && tourRef.current?.advance()) return;
    if (current === "phone" && phoneOutcome.current !== "serving") mark("phone", "skipped");
    else markDone(current);
    if (last) {
      for (const id of visited.current) if (id !== current && !steps[id]) markDone(id);
      onClose("completed");
    }
    else goTo(step + 1);
  };
  const tourCreated = () => {
    markDone("tour");
    onClose("dismissed");
  };
  const recheckAll = () => {
    recheck();
    void claude.refresh();
    void codex.refresh();
  };
  const onConnect = () => {
    setView("guide");
    goTo(0);
  };
  const dismiss = () => onClose("dismissed");
  const skipCheck = () => {
    setSteps((value) => ({ ...value, check: "skipped" }));
    void putOnboarding({ steps: { check: "skipped" } }).then(() => onClose("completed"));
  };
  useEffect(() => { dismissRef.current = dismiss; });

  const title = view === "mapping" ? t("onboarding.mappingTitle") : view === "voice" ? t("onboarding.voiceTitle") : t("onboarding.title");
  const heading = view === "mapping" ? null : (
    <>
      <h2 className="text-title font-bold text-primary">{t(HEADING_KEY[current])}</h2>
      {LEAD_KEY[current] ? <p className="mt-2 text-body leading-[1.45] text-secondary">{t(LEAD_KEY[current]!)}</p> : null}
    </>
  );
  const content = view === "mapping" || current === "agents" ? (
    <>
      {view === "mapping" ? <p className="mb-4 text-body leading-[1.45] text-secondary">{t("onboarding.agents.leadStandalone")}</p> : null}
      <AgentMappingTable statuses={statuses} layout={isMobile ? "card" : "table"} onConnect={onConnect} />
    </>
  ) : view === "voice" ? (
    <VoiceStep />
  ) : current === "check" ? (
    <CheckStep noEngine={noEngine} onGoEngines={() => goTo(0)} onLeave={dismiss} onSkip={skipCheck} onOwnsPrimary={setCheckOwnsPrimary} />
  ) : current === "phone" ? (
    <PhoneStep onSkip={() => skipAndContinue("phone")} onState={(state) => { phoneOutcome.current = state; setPhoneState(state); }} />
  ) : current === "voice" ? (
    <VoiceStep onSkip={() => skipAndContinue("voice")} onGoEngines={() => goTo(0)} />
  ) : current === "tour" ? (
    <TourStep
      handle={tourRef}
      projects={projects}
      initialProject={currentProject}
      claudeConnected={statuses.claude.connected}
      checkMinutes={checkMinutes}
      onCreated={tourCreated}
    />
  ) : (
    <EnginesStep claude={claude} codex={codex} cli={cli} now={now} onRecheck={recheckAll} />
  );

  const stepList = (
    <ol aria-label={t("onboarding.stepsAria")} className="flex flex-col gap-1">
      {STEPS.map((id, index) => {
        const active = index === step;
        const state = steps[id];
        const warn = id === "engines" && state === "done" && noEngine;
        return (
          <li key={id}>
            <button
              type="button"
              data-onboarding-step={id}
              aria-current={active ? "step" : undefined}
              onClick={() => goTo(index)}
              className={`relative flex h-9 w-full items-center gap-2 rounded-[8px] px-3 text-left text-ui font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11 ${active ? "bg-accent-soft text-primary" : state === "done" ? "text-secondary hover:bg-card" : "text-muted hover:bg-card hover:text-primary"}`}
            >
              {active ? <span aria-hidden className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent" /> : null}
              <span data-step-mark={warn && !active ? "warn" : state === "done" && !active ? "done" : "number"} className="w-4 shrink-0 text-center tabular-nums">
                {warn && !active
                  ? <AlertTriangle className="h-3.5 w-3.5 text-warning" aria-label={t("onboarding.stepNoEngine")} />
                  : state === "done" && !active ? <Check className="h-3.5 w-3.5 text-success" aria-label={t("onboarding.stepDone")} /> : index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate">{t(STEP_KEY[id])}</span>
              {state === "skipped" ? <span className="text-caption text-muted">{t("onboarding.stepSkipped")}</span> : null}
            </button>
          </li>
        );
      })}
    </ol>
  );

  /* The Check step's rows open in place with a failure; the dialog takes the height it needs, up to the viewport. */
  const checkTall = view === "guide" && (current === "check" || current === "tour");
  /* One filled button at a time: while a step's own action is the next thing
     to press (Run the check, Turn on phone access, Create the orchestrator),
     Continue steps back to a border. On the phone Continue turns the tour's
     pages, so it keeps its fill there. */
  const stepOwnsPrimary = (current === "check" && checkOwnsPrimary)
    || (current === "phone" && (phoneState === "ready" || phoneState === "serving-other"))
    || (current === "tour" && !isMobile);
  const counter = t("onboarding.stepCounter", { n: step + 1, total: STEPS.length });
  const footerButtons = view !== "guide" ? null : (
    <>
      {step > 0 ? (
        <button type="button" onClick={() => goTo(step - 1)} className="inline-flex h-8 items-center justify-center rounded-[8px] border border-border bg-card px-3.5 text-ui font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11 max-sm:flex-1">
          {t("onboarding.back")}
        </button>
      ) : null}
      <button type="button" data-onboarding-primary="" onClick={next} className={`inline-flex h-8 items-center justify-center rounded-[8px] px-4 text-ui font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11 max-sm:flex-[2] ${stepOwnsPrimary ? "border border-border bg-card text-primary hover:bg-sunken" : "bg-accent text-white hover:opacity-90"}`}>
        {last ? t("onboarding.finish") : t("onboarding.continue")}
      </button>
    </>
  );

  if (isMobile) {
    return (
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-onboarding-dialog={view}
        className={`fixed inset-0 ${Z.modal} flex flex-col bg-canvas outline-none`}
      >
        <header className="shrink-0 border-b border-border bg-raised pt-[env(safe-area-inset-top)]">
          <div className="flex h-[52px] items-center gap-1 px-1">
            {view === "guide" && step > 0 ? (
              <button type="button" aria-label={t("onboarding.back")} onClick={() => goTo(step - 1)} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[8px] text-secondary active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                <ChevronLeft className="h-5 w-5" aria-hidden />
              </button>
            ) : <span className="w-3 shrink-0" />}
            {view === "guide" ? (
              <button type="button" data-onboarding-step-list-toggle="" aria-expanded={stepListOpen} onClick={() => setStepListOpen((value) => !value)} className="flex min-h-11 min-w-0 flex-1 items-center truncate text-left text-body font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                <span className="truncate">{counter} · {t(STEP_KEY[current])}</span>
              </button>
            ) : (
              <span className="min-w-0 flex-1 truncate text-body font-semibold text-primary">{title}</span>
            )}
            <button type="button" aria-label={t("onboarding.close")} title={t("onboarding.leaveHint")} onClick={dismiss} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[8px] text-muted active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
              <X className="h-5 w-5" aria-hidden />
            </button>
          </div>
          {view === "guide" ? (
            <div className="h-0.5 bg-sunken" aria-hidden>
              <div className="h-full bg-accent" style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} />
            </div>
          ) : null}
        </header>
        {stepListOpen ? <div className="shrink-0 border-b border-border bg-sunken p-2">{stepList}</div> : null}
        <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto scroll-pb-6 px-4 pb-6 pt-4">
          {heading}
          <div className={heading ? "mt-4" : ""}>{content}</div>
        </div>
        {footerButtons ? (
          <footer className="flex shrink-0 gap-2 border-t border-border bg-raised px-4 pb-[calc(10px+env(safe-area-inset-bottom))] pt-2.5">
            {footerButtons}
          </footer>
        ) : null}
      </div>
    );
  }

  return (
    <div className={`fixed inset-0 ${Z.modal} flex items-center justify-center bg-black/40 p-12`} onMouseDown={(event) => { if (event.target === event.currentTarget) dismiss(); }}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-onboarding-dialog={view}
        className={`flex ${checkTall ? "h-[820px]" : "h-[640px]"} max-h-[calc(100vh-96px)] w-[920px] max-w-full flex-col overflow-hidden rounded-[12px] border border-border bg-card shadow-2 outline-none`}
      >
        <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-border bg-raised px-4">
          <span className="min-w-0 flex-1 truncate text-title font-bold text-primary">{title}</span>
          {view === "guide" ? (
            <button type="button" title={t("onboarding.leaveHint")} onClick={dismiss} className="inline-flex h-8 shrink-0 items-center rounded-[8px] px-2.5 text-ui font-semibold text-secondary hover:bg-sunken hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
              {t("onboarding.leave")}
            </button>
          ) : null}
          <button type="button" aria-label={t("onboarding.close")} onClick={dismiss} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] text-muted hover:bg-sunken hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>
        <div className="flex min-h-0 flex-1">
          {view === "guide" ? <nav className="w-[200px] shrink-0 border-r border-border bg-sunken p-2">{stepList}</nav> : null}
          {/* scroll-pb-6: what a step scrolls into view keeps the body's own
            breathing room above the fixed footer, rather than ending flush. */}
          <div ref={bodyRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto scroll-pb-6 bg-card p-6">
            {heading}
            <div className={heading ? "mt-4" : ""}>{content}</div>
          </div>
        </div>
        {footerButtons ? (
          <footer className="flex h-[60px] shrink-0 items-center gap-2 border-t border-border bg-raised px-4">
            <span className="min-w-0 flex-1 text-label font-semibold text-muted tabular-nums">{counter}</span>
            {footerButtons}
          </footer>
        ) : null}
      </div>
    </div>
  );
}

/** Mounted once in the Viewer: opens by itself on a first run and from the menus. */
export function OnboardingHost({ projects, currentProject }: { projects?: readonly TourProject[]; currentProject?: string | null }) {
  const { mode, step, opening, marker, checkMinutes, close } = useOnboarding();
  if (!mode) return null;
  return (
    <OnboardingDialog
      key={`${mode}:${opening}`}
      mode={mode}
      initialStep={step}
      marker={marker}
      onClose={close}
      projects={projects}
      currentProject={currentProject}
      checkMinutes={checkMinutes ?? DEFAULT_CHECK_MINUTES}
    />
  );
}
