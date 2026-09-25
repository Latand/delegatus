"use client";

import { AlertTriangle, Bot } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AgentLaunchControls, launchEngineLabel, useAgentLaunchDraft, useLaunchReadiness } from "@/components/draft/AgentLaunchControls";
import { EngineMark } from "@/components/EngineMark";
import type { OrchestratorDraftLaunch } from "@/components/orchestrator/draftPrefill";
import { runsOnValue } from "@/components/orchestrator/RunsOnRow";
import { useOrchestratorSeat } from "@/components/orchestrator/useOrchestratorSeat";
import { defaultModelFor } from "@/lib/agent/models";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { RoleConfig } from "@/lib/roles/types";

import type { GuideProject } from "./ProjectStep";
import { SeatSchematic } from "./TourSchematics";

/**
 * Step 3, Orchestrator (#2166 §3.3): the step the guide ends on. It says in
 * one sentence and three lines what the orchestrator does, names the project
 * and the runtime it will start on, each with Change, and owns the one filled
 * button, "Create the orchestrator".
 *
 * Create spawns nothing here. It hands the project's own create draft a
 * request with `confirm`, and the draft presses its own Confirm once it is
 * ready (`usePendingSeatConfirm`), so the one designation path, with its
 * one-key idempotency, stays the draft's.
 */

type Engine = OrchestratorDraftLaunch["engine"];

/** The orchestrator role's runtime from the agent mapping, as `/api/roles` answers it. */
function useOrchestratorRole(): { config: RoleConfig | null; settled: boolean } {
  const [state, setState] = useState<{ config: RoleConfig | null; settled: boolean }>({ config: null, settled: false });
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/roles")
      .then(async (response) => response.ok ? (await response.json()) as { roles?: Array<{ id?: unknown; config?: RoleConfig }> } : null)
      .catch(() => null)
      .then((body) => {
        if (cancelled) return;
        const role = body?.roles?.find((entry) => entry.id === "orchestrator");
        setState({ config: role?.config ?? null, settled: true });
      });
    return () => { cancelled = true; };
  }, []);
  return state;
}

/**
 * What the orchestrator starts on (§3.3): the role's own configuration when
 * its engine is connected (Claude, Opus, high by default); otherwise the
 * connected engine with its default model at high.
 */
export function orchestratorRuntime(role: RoleConfig | null, connected: Record<Engine, boolean>): { engine: Engine; model: string; effort: string } {
  const roleEngine = role?.engine === "codex" ? "codex" : role?.engine === "claude" ? "claude" : null;
  if (role && roleEngine && connected[roleEngine]) return { engine: roleEngine, model: role.model, effort: role.effort || "high" };
  const engine: Engine = connected.claude || !connected.codex ? "claude" : "codex";
  if (role && roleEngine === engine) return { engine, model: role.model, effort: role.effort || "high" };
  return { engine, model: defaultModelFor(engine), effort: "high" };
}

function seatHeld(status: ReturnType<typeof useOrchestratorSeat>["status"]): boolean {
  return Boolean(status?.seat?.conversationId && status.exists);
}

const lines = (t: TFunction) => [t("onboarding.orchestrator.line1"), t("onboarding.orchestrator.line2"), t("onboarding.orchestrator.line3")];

export function OrchestratorStep(props: {
  project: GuideProject | null;
  connected: Record<Engine, boolean>;
  /** Engine sign-in states have loaded: until then no state is claimed. */
  enginesSettled: boolean;
  checkMinutes: number;
  onGoEngines: () => void;
  onGoProject: () => void;
  onCreate: (launch: OrchestratorDraftLaunch) => void;
  onReadFirst: (launch: OrchestratorDraftLaunch) => void;
  onOpenSeat: () => void;
}) {
  const role = useOrchestratorRole();
  const runtime = orchestratorRuntime(role.config, props.connected);
  /* The launch draft reads its defaults once, so it mounts on the runtime the
     role and the engines settle on, and again if that changes underneath. */
  if (!role.settled || !props.enginesSettled) return <StepBody {...props} launchKey={null} runtime={runtime} />;
  return <StepBody key={`${runtime.engine}:${runtime.model}:${runtime.effort}`} {...props} launchKey="ready" runtime={runtime} />;
}

function StepBody({ project, connected, checkMinutes, onGoEngines, onGoProject, onCreate, onReadFirst, onOpenSeat, launchKey, runtime }: Parameters<typeof OrchestratorStep>[0] & {
  launchKey: "ready" | null;
  runtime: { engine: Engine; model: string; effort: string };
}) {
  const { t } = useLocale();
  const launch = useAgentLaunchDraft({ initialEngine: runtime.engine, initialModel: runtime.model, initialEffort: runtime.effort });
  const readiness = useLaunchReadiness(launch);
  /* The account starts as the engine's active one; when that one is signed
     out and another of the same engine is signed in, the other is the one the
     orchestrator can start on. Once, when the accounts arrive. */
  const accountPicked = useRef(false);
  useEffect(() => {
    if (accountPicked.current || !launch.catalog) return;
    accountPicked.current = true;
    const section = launch.catalog[launch.engine];
    const current = section?.accounts.find((entry) => entry.id === launch.launchAccountId);
    const signedIn = current?.signedOut ? section?.accounts.find((entry) => !entry.signedOut) : null;
    if (signedIn) launch.setAccountId(signedIn.id);
  }, [launch]);
  const [changing, setChanging] = useState(false);
  const { status } = useOrchestratorSeat(project?.project ?? null, project?.cwd ?? undefined);
  const held = project ? seatHeld(status) : false;
  const noEngine = launchKey !== null && !connected.claude && !connected.codex;
  const engine: Engine = launch.engine === "codex" ? "codex" : "claude";
  const request = (): OrchestratorDraftLaunch => ({
    engine,
    model: launch.model,
    effort: launch.effort,
    ...(launch.launchAccountId ? { account: launch.launchAccountId } : {}),
  });
  const signedOut = readiness.kind === "signed-out" ? readiness : null;

  const fact = (label: string, value: React.ReactNode, onChange: () => void, testId: string, expanded?: boolean) => (
    <div className="flex min-w-0 items-baseline gap-3 py-2 max-sm:flex-wrap max-sm:gap-x-2 max-sm:gap-y-0.5">
      <span className="w-[92px] shrink-0 text-label font-semibold text-muted max-sm:w-auto max-sm:flex-1">{label}</span>
      <span className="min-w-0 flex-1 truncate text-ui text-primary max-sm:order-3 max-sm:basis-full max-sm:whitespace-normal">{value}</span>
      <button
        type="button"
        data-onboarding-orchestrator-change={testId}
        aria-expanded={expanded}
        onClick={onChange}
        className="shrink-0 rounded-[6px] text-ui font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"
      >
        {t(expanded ? "orchPanel.runsOnDone" : "orchPanel.runsOnChange")}
      </button>
    </div>
  );

  const primary = "inline-flex h-9 items-center justify-center gap-1.5 rounded-[8px] bg-brand px-4 text-ui font-semibold text-on-brand hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 max-sm:h-11";
  const secondary = "inline-flex h-9 items-center justify-center rounded-[8px] border border-border bg-card px-3.5 text-ui font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11";
  const warning = (text: string) => (
    <p data-onboarding-orchestrator-warning="" className="flex items-center gap-1.5 text-ui text-warning">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {text}
    </p>
  );

  let action: React.ReactNode;
  if (!project) {
    action = (
      <div className="flex flex-col items-start gap-2 max-sm:items-stretch">
        {warning(t("onboarding.orchestrator.noProject"))}
        <button type="button" data-onboarding-orchestrator-go="project" onClick={onGoProject} className={secondary}>{t("onboarding.orchestrator.goProject")}</button>
      </div>
    );
  } else if (noEngine) {
    action = (
      <div className="flex flex-col items-start gap-2 max-sm:items-stretch">
        {warning(t("onboarding.orchestrator.noEngine"))}
        <button type="button" data-onboarding-orchestrator-go="engines" onClick={onGoEngines} className={secondary}>{t("onboarding.orchestrator.goEngines")}</button>
      </div>
    );
  } else if (held) {
    action = (
      <div className="flex flex-col items-start gap-2 max-sm:items-stretch">
        <p className="text-ui text-secondary">{t("onboarding.orchestrator.alreadyHas", { project: project.name })}</p>
        <button type="button" data-onboarding-orchestrator-open="" onClick={onOpenSeat} className={secondary}>{t("onboarding.orchestrator.openIt")}</button>
      </div>
    );
  } else if (signedOut) {
    action = (
      <div className="flex flex-col items-start gap-2 max-sm:items-stretch">
        {warning(t("onboarding.orchestrator.signedOut", { engine: launchEngineLabel(signedOut.engine), label: signedOut.label }))}
        <button type="button" data-onboarding-orchestrator-signin="" onClick={onGoEngines} className={primary}>
          <EngineMark engine={signedOut.engine} size={14} tone="inherit" />
          {t("launch.signInFirst", { engine: launchEngineLabel(signedOut.engine) })}
        </button>
      </div>
    );
  } else {
    action = (
      <div className="flex items-center gap-4 max-sm:flex-col max-sm:items-stretch max-sm:gap-2">
        <button type="button" data-onboarding-orchestrator-create="" disabled={launchKey === null} onClick={() => onCreate(request())} className={primary}>
          <Bot className="h-4 w-4" aria-hidden />
          {t("orchPanel.confirm")}
        </button>
        <button
          type="button"
          data-onboarding-orchestrator-read=""
          disabled={launchKey === null}
          onClick={() => onReadFirst(request())}
          className="rounded-[6px] text-ui font-semibold text-secondary underline-offset-2 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:justify-center"
        >
          {t("onboarding.orchestrator.readFirst")} →
        </button>
      </div>
    );
  }

  return (
    <div data-onboarding-orchestrator="" className="flex flex-col gap-4">
      <div className="flex gap-4 rounded-[12px] border border-accent/35 bg-accent-soft/40 p-3 max-sm:flex-col">
        <div className="h-[100px] w-[160px] shrink-0 overflow-hidden rounded-[8px] bg-sunken max-sm:h-[112px] max-sm:w-full">
          <SeatSchematic />
        </div>
        <ul className="flex min-w-0 flex-1 flex-col gap-1.5 text-ui leading-[1.45] text-secondary">
          {lines(t).map((line) => (
            <li key={line} className="flex gap-2">
              <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-col divide-y divide-border rounded-[10px] border border-border px-3">
        {fact(
          t("onboarding.orchestrator.project"),
          project ? (
            <>
              {project.name}
              {project.cwd ? <span className="ml-1.5 font-mono text-[11px] text-muted">{project.cwd}</span> : null}
            </>
          ) : <span className="text-muted">—</span>,
          onGoProject,
          "project",
        )}
        <div>
          {fact(
            t("orchPanel.runsOn"),
            <span className="inline-flex min-w-0 items-center gap-1.5" data-onboarding-orchestrator-runs-on="">
              <EngineMark engine={launch.engine} size={12} />
              <span className="min-w-0 truncate">{runsOnValue(launch, t)}</span>
            </span>,
            () => setChanging((value) => !value),
            "runs-on",
            changing,
          )}
          {changing ? (
            <div className="border-t border-border py-2 max-sm:[&_button]:min-h-11 max-sm:[&_select]:min-h-11">
              <AgentLaunchControls draft={launch} stacked />
            </div>
          ) : null}
        </div>
      </div>
      <p className="text-caption leading-[1.5] text-muted">{t("onboarding.orchestrator.costNote", { engine: launchEngineLabel(launch.engine), check: checkMinutes })}</p>
      {action}
    </div>
  );
}
