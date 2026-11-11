"use client";

import { AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { AgentLaunchControls, launchEngineLabel, useAgentLaunchDraft, useLaunchReadiness } from "@/components/draft/AgentLaunchControls";
import { EngineMark } from "@/components/EngineMark";
import type { OrchestratorDraftLaunch } from "@/components/orchestrator/draftPrefill";
import { replaceRoleCatalog } from "@/components/DraftAgentPane";
import { runsOnValue } from "@/components/orchestrator/RunsOnRow";
import { useOrchestratorSeat } from "@/components/orchestrator/useOrchestratorSeat";
import { tokenRate } from "@/lib/activity/tokenPrices";
import { CLAUDE_ALIAS_RELEASES, CODEX_GPT61_SOL_MODEL, defaultModelFor, ENGINE_MODELS, modelDisplayName } from "@/lib/agent/models";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { RoleConfig } from "@/lib/roles/types";

import { handOffMoveReceipt, oneEngineMove, patchBody, type MappingCatalogItem } from "./AgentMappingTable";
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

type RoleCatalog = { roles: MappingCatalogItem[]; revision: string | null };

/** The agent mapping as `/api/roles` answers it: the orchestrator role's runtime, and the whole catalog with its revision for the move at creation. */
function useRoleCatalog(): { config: RoleConfig | null; settled: boolean; catalog: RoleCatalog | null; keep: (next: RoleCatalog) => void } {
  const [state, setState] = useState<{ config: RoleConfig | null; settled: boolean; catalog: RoleCatalog | null }>({ config: null, settled: false, catalog: null });
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/roles")
      .then(async (response) => response.ok ? (await response.json()) as { roles?: MappingCatalogItem[]; revision?: unknown } : null)
      .catch(() => null)
      .then((body) => {
        if (cancelled) return;
        const role = body?.roles?.find((entry) => entry.id === "orchestrator");
        const catalog = body?.roles ? { roles: body.roles, revision: typeof body.revision === "string" ? body.revision : null } : null;
        setState({ config: role?.config ?? null, settled: true, catalog });
      });
    return () => { cancelled = true; };
  }, []);
  const keep = useCallback((catalog: RoleCatalog) => setState((held) => ({ ...held, catalog })), []);
  return { ...state, keep };
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
  /** The step's create action for the dialog's footer, where "Create the orchestrator" stands: null in every state that has its own action in the body. */
  onCreateAction?: (action: { disabled: boolean; run: () => void } | null) => void;
  /** Where "Roles" says Change: the table under Later. */
  onGoAgents?: () => void;
  /** A first run: the cost estimate and the cheaper choice are offered only
      here, so an existing installation's guide reads as before. */
  newcomer?: boolean;
}) {
  const role = useRoleCatalog();
  const runtime = orchestratorRuntime(role.config, props.connected);
  /* The launch draft reads its defaults once, so it mounts on the runtime the
     role and the engines settle on, and again if that changes underneath. */
  if (!role.settled || !props.enginesSettled) return <StepBody {...props} launchKey={null} runtime={runtime} roles={role.catalog} keepRoles={role.keep} />;
  return <StepBody key={`${runtime.engine}:${runtime.model}:${runtime.effort}`} {...props} launchKey="ready" runtime={runtime} roles={role.catalog} keepRoles={role.keep} />;
}

function StepBody({ project, connected, checkMinutes, onGoEngines, onGoProject, onCreate, onReadFirst, onOpenSeat, onCreateAction, onGoAgents, newcomer = false, launchKey, runtime, roles, keepRoles }: Parameters<typeof OrchestratorStep>[0] & {
  launchKey: "ready" | null;
  runtime: { engine: Engine; model: string; effort: string };
  roles: RoleCatalog | null;
  keepRoles: (next: RoleCatalog) => void;
}) {
  const { t, locale } = useLocale();
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
  /* With one engine connected, the roles that default to the other move to it,
     once, when the orchestrator is created. Opening the step and the table
     behind "Change" write nothing. */
  const move = roles ? oneEngineMove(roles.roles, { claude: { connected: connected.claude }, codex: { connected: connected.codex } }) : null;
  const roleMove = move && move.count > 0 ? move : null;
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const create = async () => {
    if (moving) return;
    if (!roleMove) { onCreate(request()); return; }
    setMoving(true);
    setMoveError(null);
    try {
      const response = await fetch("/api/roles", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...(roles?.revision ? { expectedRevision: roles.revision } : {}), overrides: patchBody(roleMove.changes).overrides }),
      });
      const body = await response.json().catch(() => null) as { roles?: MappingCatalogItem[]; revision?: unknown; error?: string } | null;
      /* The server's own catalog answers a changed revision too: read it, so the count is the one the next press moves. */
      if (body?.roles && (response.status === 409 || response.ok)) keepRoles({ roles: body.roles, revision: typeof body.revision === "string" ? body.revision : null });
      if (!response.ok || !body?.roles) throw new Error(body?.error || `HTTP ${response.status}`);
      replaceRoleCatalog(body.roles);
      handOffMoveReceipt({ count: roleMove.count, engine: roleMove.to, undo: roleMove.undo });
      onCreate(request());
    } catch (error) {
      setMoveError(error instanceof Error ? error.message : String(error));
    } finally {
      setMoving(false);
    }
  };
  /* The dialog's footer holds the create button; it calls the latest closure. */
  const createRef = useRef(create);
  useLayoutEffect(() => { createRef.current = create; });
  const createVisible = Boolean(project) && !noEngine && !held && !signedOut;
  const createDisabled = launchKey === null || moving;
  useEffect(() => {
    onCreateAction?.(createVisible ? { disabled: createDisabled, run: () => void createRef.current() } : null);
    return () => onCreateAction?.(null);
  }, [onCreateAction, createVisible, createDisabled]);
  // Compare a stated workload at the existing standard API rates, not a
  // subscription bill.
  const aliases: Record<string, string> = CLAUDE_ALIAS_RELEASES;
  const estimate = (model: string, priceEngine = engine) => {
    const rate = tokenRate(priceEngine === "claude" ? aliases[model] ?? model : model, "standard");
    return rate ? rate.input * 0.1 + rate.output * 0.01 : null;
  };
  const cost = estimate(launch.model);
  const costFormat = new Intl.NumberFormat(locale === "uk" ? "uk-UA" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  /* One cheaper step from the Claude default; once on Codex nothing further is offered. */
  const cheaperModel = CODEX_GPT61_SOL_MODEL;
  const cheaperCost = engine === "claude" ? estimate(cheaperModel, "codex") : null;

  const fact = (label: string, value: React.ReactNode, onChange: () => void, testId: string, expanded?: boolean) => (
    <div className="flex min-w-0 items-baseline gap-3 py-2 max-[859px]:flex-wrap max-[859px]:gap-x-2 max-[859px]:gap-y-0.5">
      <span className="w-[92px] shrink-0 text-label font-semibold text-muted max-[859px]:w-auto max-[859px]:flex-1">{label}</span>
      <span className="min-w-0 flex-1 text-ui text-primary max-[859px]:order-3 max-[859px]:basis-full">{value}</span>
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
    /* "Create the orchestrator" is the dialog's footer button; the body keeps the way to read its instructions first. */
    action = (
      <button
        type="button"
        data-onboarding-orchestrator-read=""
        disabled={launchKey === null}
        onClick={() => onReadFirst(request())}
        className="self-start rounded-[6px] text-ui font-semibold text-secondary underline-offset-2 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:justify-center max-sm:self-stretch"
      >
        {t("onboarding.orchestrator.readFirst")} →
      </button>
    );
  }

  const rolesOnCodexOnly = !connected.claude && connected.codex;
  return (
    <div data-onboarding-orchestrator="" className="flex flex-col gap-4">
      <div className="flex gap-4 rounded-[12px] border border-accent/35 bg-accent-soft/40 p-3 max-[859px]:order-3 max-[859px]:flex-col">
        <div className="h-[100px] w-[160px] shrink-0 overflow-hidden rounded-[8px] bg-sunken max-[859px]:h-[112px] max-[859px]:w-full">
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
      {/* Below 860 px the facts come first: what it will run on is the question, the picture is not. */}
      <div className="flex flex-col gap-2 max-[859px]:order-1">
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
                <span className="min-w-0">{runsOnValue(launch, t)}</span>
              </span>,
              () => setChanging((value) => !value),
              "runs-on",
              changing,
            )}
            {rolesOnCodexOnly ? (
              <div data-onboarding-orchestrator-advice="" className="-mt-1 flex flex-wrap items-baseline gap-x-2 pb-2 text-ui text-secondary max-sm:flex-col max-sm:items-stretch">
                <span>{t("onboarding.orchestrator.adviceClaude")}</span>
                <button type="button" data-onboarding-orchestrator-connect="claude" onClick={onGoEngines} className="self-start rounded-[6px] font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center">
                  {t("onboarding.agents.connect", { missing: "Claude" })}
                </button>
              </div>
            ) : null}
            {changing ? (
              <div className="border-t border-border py-2 max-sm:[&_button]:min-h-11 max-sm:[&_select]:min-h-11">
                <AgentLaunchControls draft={launch} stacked />
              </div>
            ) : null}
          </div>
          {roleMove ? fact(
            t("onboarding.orchestrator.roles"),
            <span data-onboarding-orchestrator-roles="">{t("onboarding.orchestrator.rolesMove", { count: roleMove.count, from: launchEngineLabel(roleMove.from), to: launchEngineLabel(roleMove.to) })}</span>,
            () => onGoAgents?.(),
            "roles",
          ) : null}
        </div>
        {moveError ? <p role="alert" data-onboarding-orchestrator-move-error="" className="text-ui text-danger">{t("onboarding.agents.saveFailed", { reason: moveError })}</p> : null}
      </div>
      <div className="flex flex-col gap-1.5 text-caption leading-[1.5] text-secondary max-[859px]:order-2">
        <p>{t("onboarding.orchestrator.costNote", { engine: launchEngineLabel(launch.engine), check: checkMinutes })}</p>
        <p data-onboarding-permissions="">{t("onboarding.orchestrator.permissions")}</p>
        {newcomer ? <p data-onboarding-cost="">{cost === null ? t("onboarding.orchestrator.unpriced") : t("onboarding.orchestrator.estimate", { cost: costFormat.format(cost) })}</p> : null}
        {newcomer && !held && launchKey !== null && connected.codex && cost !== null && cheaperCost !== null && cheaperCost < cost ? (
          <button type="button" data-onboarding-cheaper="" className="self-start rounded-[6px] text-left text-ui font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:min-h-11" onClick={() => { launch.setEngine("codex"); launch.setModel(cheaperModel); }}>
            {t("onboarding.orchestrator.cheaper", { model: `${launchEngineLabel("codex")} · ${ENGINE_MODELS.codex.find((option) => option.id === cheaperModel)?.label ?? modelDisplayName("codex", cheaperModel)}` })}
          </button>
        ) : null}
      </div>
      <div className="flex flex-col max-[859px]:order-4">{action}</div>
    </div>
  );
}
