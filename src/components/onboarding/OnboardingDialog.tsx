"use client";

import { AlertTriangle, Check, ChevronLeft, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { DelegatusMark } from "@/components/brand/BrandMark";
import { Z } from "@/components/layers";
import { requestOrchestratorDraft, type OrchestratorDraftLaunch } from "@/components/orchestrator/draftPrefill";
import type { CreateProjectOutcome, CreateProjectRequestOptions } from "@/hooks/useProjectCuration";
import { useEngineAccounts } from "@/hooks/useEngineAccounts";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { OnboardingMarker } from "@/lib/onboarding/marker";
import { ONBOARDING_GUIDE_STEP_IDS, ONBOARDING_LATER_STEP_IDS, ONBOARDING_STEP_IDS, type OnboardingGuideStepId, type OnboardingStepId, type OnboardingStepState } from "@/lib/onboarding/steps";
import type { RoleEngine } from "@/lib/roles/types";

import { AgentMappingTable, type EngineStatus } from "./AgentMappingTable";
import { CheckStep } from "./CheckStep";
import { engineAccount, engineReady, EnginesStep, type CliPresence } from "./EnginesStep";
import { OrchestratorStep } from "./OrchestratorStep";
import { PhoneStep, type PhoneStepOutcome } from "./PhoneStep";
import { ProjectStep, type GuideProject } from "./ProjectStep";
import { putOnboarding, useOnboarding, type OnboardingMode } from "./useOnboarding";
import { VoiceStep } from "./VoiceStep";

/**
 * The setup guide (#1876, design §2–§3; #2166 §2.1): three numbered steps,
 * Engines, Project and Orchestrator, that end on a running orchestrator.
 * Agents, Phone, Voice and Check stay in the same dialog under "Later, any
 * time": unnumbered, opened from the list, never part of Back or Continue.
 * Nothing is gated: every step closes by Escape, ✕ or "Close, finish later",
 * and nothing in the app waits on it. The "Agent mapping" and "Dictation"
 * menu rows open the Agents table or the Voice step alone in the same shell.
 */

const GUIDE: readonly OnboardingGuideStepId[] = ONBOARDING_GUIDE_STEP_IDS;
const LATER: readonly OnboardingStepId[] = ONBOARDING_LATER_STEP_IDS;

function isGuideStep(id: OnboardingStepId): id is OnboardingGuideStepId {
  return (GUIDE as readonly string[]).includes(id);
}

const STEP_KEY: Record<OnboardingStepId, Parameters<TFunction>[0]> = {
  engines: "onboarding.step.engines",
  project: "onboarding.step.project",
  orchestrator: "onboarding.step.orchestrator",
  agents: "onboarding.step.agents",
  phone: "onboarding.step.phone",
  voice: "onboarding.step.voice",
  check: "onboarding.step.check",
};

const HEADING_KEY: Record<OnboardingStepId, Parameters<TFunction>[0]> = {
  engines: "onboarding.engines.heading",
  project: "onboarding.project.heading",
  orchestrator: "onboarding.orchestrator.heading",
  agents: "onboarding.agents.heading",
  phone: "onboarding.phone.heading",
  voice: "onboarding.voice.heading",
  check: "onboarding.check.heading",
};

/* The Check step writes its own lead: it names the model the run will use.
   The orchestrator's lead is the one sentence its draft opens with. */
const LEAD_KEY: Record<OnboardingStepId, Parameters<TFunction>[0] | null> = {
  engines: "onboarding.engines.lead",
  project: "onboarding.project.lead",
  orchestrator: "orchPanel.intro",
  agents: "onboarding.agents.lead",
  phone: "onboarding.phone.lead",
  voice: "onboarding.voice.lead",
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

/** The first of the three guide steps that is not done. */
export function firstOpenStep(marker: Pick<OnboardingMarker, "steps"> | null): OnboardingGuideStepId {
  return GUIDE.find((step) => marker?.steps[step] !== "done") ?? GUIDE[0]!;
}

/** The project the Project step starts on: the one the guide opened over when
    it has a folder, else the most recent that has one. */
function preferredProject(projects: readonly GuideProject[], current: string | null): GuideProject | null {
  const onDisk = projects.filter((entry) => entry.cwd);
  return onDisk.find((entry) => entry.project === current) ?? onDisk[0] ?? null;
}

export function OnboardingDialog({ mode, initialStep, marker, onClose, projects = [], currentProject = null, checkMinutes = DEFAULT_CHECK_MINUTES, onCreateProject }: {
  mode: OnboardingMode;
  /** Open the guide on this step (the QR popover opens it on Phone). */
  initialStep?: OnboardingStepId | null;
  marker: OnboardingMarker | null;
  /** `steps` rides on the same write as the outcome. */
  onClose: (outcome: "dismissed" | "completed", steps?: Partial<Record<OnboardingStepId, OnboardingStepState>>) => void;
  /** The projects the rail lists, most recent first, with their folders. */
  projects?: readonly GuideProject[];
  currentProject?: string | null;
  checkMinutes?: number;
  /** The rail's own project creation, for "Open another folder". */
  onCreateProject?: (name: string, root: string, options?: CreateProjectRequestOptions) => Promise<CreateProjectOutcome>;
}) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const claude = useEngineAccounts("claude");
  const codex = useEngineAccounts("codex");
  const { cli, recheck } = useCliPresence();
  const now = useNow();
  const [view, setView] = useState<OnboardingMode>(mode);
  const [current, setCurrent] = useState<OnboardingStepId>(() => {
    const target = mode === "mapping" ? "agents" : mode === "voice" ? "voice" : initialStep ?? null;
    return target ?? firstOpenStep(marker);
  });
  /* The guide step a "Later" step returns to. */
  const [lastGuide, setLastGuide] = useState<OnboardingGuideStepId>(() => isGuideStep(current) ? current : firstOpenStep(marker));
  const [steps, setSteps] = useState<Record<OnboardingStepId, OnboardingStepState>>(() => ({ ...Object.fromEntries(ONBOARDING_STEP_IDS.map((id) => [id, null])), ...marker?.steps }) as Record<OnboardingStepId, OnboardingStepState>);
  /* The project step 3 works on; the catalog may arrive after the guide
     opens, so the preferred one is taken once it does, until the user picks. */
  const [chosen, setChosen] = useState<GuideProject | null>(() => preferredProject(projects, currentProject));
  const picked = useRef(false);
  useEffect(() => {
    if (picked.current || chosen) return;
    const preferred = preferredProject(projects, currentProject);
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- the catalog answered after the guide opened */
    if (preferred) setChosen(preferred);
  }, [projects, currentProject, chosen]);
  const choose = (project: GuideProject) => {
    picked.current = true;
    setChosen(project);
  };
  /* What the Phone step ended on: leaving it counts it done only once phone
     access is on, and skipped otherwise. */
  const phoneOutcome = useRef<PhoneStepOutcome | null>(null);
  /* The phone state on screen, for who holds the one filled button. */
  const [phoneState, setPhoneState] = useState<PhoneStepOutcome | null>(null);
  /* Every guide step the guide showed; finishing marks the ones never left by
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
        /* An open folder picker (the Project step's form) closes itself first. */
        if ((event.target as Partial<Element> | null)?.closest?.("[data-directory-picker=open]")) return;
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
  useEffect(() => { bodyRef.current?.scrollTo?.({ top: 0 }); }, [current, view]);

  const statuses: Record<RoleEngine, EngineStatus> = {
    claude: { connected: engineReady(claude, cli.claude), missing: cli.claude === "missing", account: engineAccount(claude) },
    codex: { connected: engineReady(codex, cli.codex), missing: cli.codex === "missing", account: engineAccount(codex) },
  };
  /* A visited Engines step earns its check only when an engine can run; with
     none it carries the warning its own screen shows. */
  const enginesSettled = claude.status !== "loading" && codex.status !== "loading";
  const noEngine = enginesSettled && !statuses.claude.connected && !statuses.codex.connected;
  const guideStep = isGuideStep(current);
  const guideIndex = GUIDE.indexOf(guideStep ? current : lastGuide);
  useEffect(() => {
    if (view === "guide") visited.current.add(current);
  }, [view, current]);

  const mark = (id: OnboardingStepId, state: "done" | "skipped") => {
    if (steps[id] === state) return;
    setSteps((value) => ({ ...value, [id]: state }));
    void putOnboarding({ steps: { [id]: state } });
  };
  const markDone = (id: OnboardingStepId) => mark(id, "done");
  const goTo = (id: OnboardingStepId) => {
    setStepListOpen(false);
    setCurrent(id);
    if (isGuideStep(id)) setLastGuide(id);
  };
  const backToGuide = () => goTo(lastGuide);
  /* Leaving a "Later" step records it the way Continue used to. */
  const leaveLater = () => {
    if (current === "phone" && phoneOutcome.current !== "serving") mark("phone", "skipped");
    else markDone(current);
    backToGuide();
  };
  const skipLater = (id: OnboardingStepId) => {
    mark(id, "skipped");
    backToGuide();
  };
  const next = () => {
    if (current === "project" && !chosen) {
      goTo("orchestrator");
      return;
    }
    markDone(current);
    goTo(GUIDE[Math.min(GUIDE.length - 1, guideIndex + 1)]!);
  };
  /* The guide's end: the steps it showed are done, the orchestrator step says
     how it ended, and both ride on the one write that closes the guide. */
  const finish = (outcome: "dismissed" | "completed", orchestrator: "done" | "skipped" | null) => {
    const written: Partial<Record<OnboardingStepId, OnboardingStepState>> = {};
    if (outcome === "completed") for (const id of visited.current) if (isGuideStep(id) && id !== "orchestrator" && !steps[id]) written[id] = "done";
    if (orchestrator) written.orchestrator = orchestrator;
    setSteps((value) => ({ ...value, ...written }));
    onClose(outcome, Object.keys(written).length ? written : undefined);
  };
  const create = (launch: OrchestratorDraftLaunch) => {
    if (!chosen) return;
    requestOrchestratorDraft({ project: chosen.project, launch, confirm: true });
    finish("completed", "done");
  };
  const readFirst = (launch: OrchestratorDraftLaunch) => {
    if (!chosen) return;
    requestOrchestratorDraft({ project: chosen.project, launch });
    finish("dismissed", null);
  };
  const openSeat = () => {
    if (!chosen) return;
    requestOrchestratorDraft({ project: chosen.project, launch: null });
    finish("dismissed", null);
  };
  const recheckAll = () => {
    recheck();
    void claude.refresh();
    void codex.refresh();
  };
  const onConnect = () => {
    setView("guide");
    goTo("engines");
  };
  const dismiss = () => onClose("dismissed");
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
    <CheckStep noEngine={noEngine} onGoEngines={() => goTo("engines")} onLeave={dismiss} onSkip={() => skipLater("check")} onOwnsPrimary={setCheckOwnsPrimary} />
  ) : current === "phone" ? (
    <PhoneStep onSkip={() => skipLater("phone")} onState={(state) => { phoneOutcome.current = state; setPhoneState(state); }} />
  ) : current === "voice" ? (
    <VoiceStep onSkip={() => skipLater("voice")} onGoEngines={() => goTo("engines")} />
  ) : current === "project" ? (
    <ProjectStep projects={projects} chosen={chosen} onChoose={choose} onCreate={onCreateProject} />
  ) : current === "orchestrator" ? (
    <OrchestratorStep
      project={chosen}
      connected={{ claude: statuses.claude.connected, codex: statuses.codex.connected }}
      enginesSettled={enginesSettled}
      checkMinutes={checkMinutes}
      onGoEngines={() => goTo("engines")}
      onGoProject={() => goTo("project")}
      onCreate={create}
      onReadFirst={readFirst}
      onOpenSeat={openSeat}
    />
  ) : (
    <EnginesStep claude={claude} codex={codex} cli={cli} now={now} onRecheck={recheckAll} />
  );

  const stepRow = (id: OnboardingStepId, index: number | null) => {
    const active = id === current;
    const state = steps[id];
    const warn = id === "engines" && state === "done" && noEngine;
    const later = index === null;
    return (
      <li key={id}>
        <button
          type="button"
          data-onboarding-step={id}
          aria-current={active ? "step" : undefined}
          onClick={() => goTo(id)}
          className={`relative flex w-full items-center gap-2 rounded-[8px] px-3 text-left text-ui focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11 ${later ? "h-8" : "h-9 font-semibold"} ${active ? "bg-accent-soft font-semibold text-primary" : !later && state === "done" ? "text-secondary hover:bg-card" : "text-muted hover:bg-card hover:text-primary"}`}
        >
          {active ? <span aria-hidden className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent" /> : null}
          <span data-step-mark={later ? "later" : warn && !active ? "warn" : state === "done" && !active ? "done" : "number"} className="w-4 shrink-0 text-center tabular-nums">
            {later
              ? <span aria-hidden>·</span>
              : warn && !active
                ? <AlertTriangle className="h-3.5 w-3.5 text-warning" aria-label={t("onboarding.stepNoEngine")} />
                : state === "done" && !active ? <Check className="h-3.5 w-3.5 text-success" aria-label={t("onboarding.stepDone")} /> : index! + 1}
          </span>
          <span className="min-w-0 flex-1 truncate">{t(STEP_KEY[id])}</span>
          {state === "skipped" && !later ? <span className="text-caption text-muted">{t("onboarding.stepSkipped")}</span> : null}
        </button>
      </li>
    );
  };
  const stepList = (
    <nav aria-label={t("onboarding.stepsAria")}>
      <ol className="flex flex-col gap-1">{GUIDE.map((id, index) => stepRow(id, index))}</ol>
      <div className="mt-5 px-3 pb-1 text-label font-semibold uppercase tracking-[0.06em] text-muted">{t("onboarding.later")}</div>
      <ol className="flex flex-col">{LATER.map((id) => stepRow(id, null))}</ol>
    </nav>
  );

  /* The Check step's rows open in place with a failure; the dialog takes the height it needs, up to the viewport. */
  const checkTall = view === "guide" && current === "check";
  /* One filled button at a time: while a step's own action is the next thing
     to press (Run the check, Turn on phone access, Create the orchestrator),
     the footer's button steps back to a border. */
  const stepOwnsPrimary = (current === "check" && checkOwnsPrimary)
    || (current === "phone" && (phoneState === "ready" || phoneState === "serving-other" || phoneState === "exposed"))
    || current === "orchestrator";
  const counter = guideStep ? t("onboarding.stepCounter", { n: guideIndex + 1, total: GUIDE.length }) : t("onboarding.later");
  const bordered = "border border-border bg-card text-primary hover:bg-sunken";
  const filled = "bg-brand text-on-brand hover:opacity-90";
  const footerButton = "inline-flex h-8 items-center justify-center rounded-[8px] px-4 text-ui font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11 max-sm:flex-[2]";
  const backButton = (onClick: () => void) => (
    <button type="button" data-onboarding-back="" onClick={onClick} className="inline-flex h-8 items-center justify-center rounded-[8px] border border-border bg-card px-3.5 text-ui font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11 max-sm:flex-1">
      {t("onboarding.back")}
    </button>
  );
  const footerButtons = view !== "guide" ? null : !guideStep ? (
    <button type="button" data-onboarding-primary="" onClick={leaveLater} className={`${footerButton} ${stepOwnsPrimary ? bordered : filled}`}>
      {t("onboarding.laterReturn")}
    </button>
  ) : (
    <>
      {guideIndex > 0 ? backButton(() => goTo(GUIDE[guideIndex - 1]!)) : null}
      {current === "orchestrator" ? (
        <button type="button" data-onboarding-primary="" data-onboarding-finish-without="" onClick={() => finish("completed", "skipped")} className={`${footerButton} ${bordered}`}>
          {t("onboarding.finishWithout")}
        </button>
      ) : (
        <button type="button" data-onboarding-primary="" onClick={next} className={`${footerButton} ${stepOwnsPrimary ? bordered : filled}`}>
          {t("onboarding.continue")}
        </button>
      )}
    </>
  );
  const headerBack = view !== "guide" ? null : !guideStep ? backToGuide : guideIndex > 0 ? () => goTo(GUIDE[guideIndex - 1]!) : null;

  if (isMobile) {
    return (
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-onboarding-dialog={view}
        data-onboarding-current={view === "guide" ? current : undefined}
        className={`fixed inset-0 ${Z.modal} flex flex-col bg-canvas outline-none`}
      >
        <header className="shrink-0 border-b border-border bg-raised pt-[env(safe-area-inset-top)]">
          <div className="flex h-[52px] items-center gap-1 px-1">
            {headerBack ? (
              <button type="button" aria-label={t("onboarding.back")} onClick={headerBack} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[8px] text-secondary active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
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
              <div className="h-full bg-accent" style={{ width: `${((guideIndex + 1) / GUIDE.length) * 100}%` }} />
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
        data-onboarding-current={view === "guide" ? current : undefined}
        className={`flex ${checkTall ? "h-[820px]" : "h-[640px]"} max-h-[calc(100vh-96px)] w-[920px] max-w-full flex-col overflow-hidden rounded-[12px] border border-border bg-card shadow-2 outline-none`}
      >
        <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-border bg-raised px-4">
          <DelegatusMark size={24} />
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
          {view === "guide" ? <div className="w-[200px] shrink-0 overflow-y-auto border-r border-border bg-sunken p-2">{stepList}</div> : null}
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
export function OnboardingHost({ projects, currentProject, onCreateProject }: {
  projects?: readonly GuideProject[];
  currentProject?: string | null;
  onCreateProject?: (name: string, root: string, options?: CreateProjectRequestOptions) => Promise<CreateProjectOutcome>;
}) {
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
      onCreateProject={onCreateProject}
    />
  );
}
