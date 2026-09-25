"use client";

import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { replaceRoleCatalog, type RoleCatalogItem } from "@/components/DraftAgentPane";
import { EngineMark } from "@/components/EngineMark";
import type { AccountOption } from "@/hooks/useEngineAccounts";
import { clampEffortToScale, effortScale } from "@/lib/agent/efforts";
import { ENGINE_MODELS } from "@/lib/agent/models";
import { useLocale, type TFunction } from "@/lib/i18n";
import { costClass, effortRank, tightestHeadroom, type CostClass } from "@/lib/roles/costHints";
import { equivalentConfig } from "@/lib/roles/equivalents";
import type { BuilderVariantId, RoleConfig, RoleEngine, RoleId } from "@/lib/roles/types";

/**
 * The agent mapping (#1876, design §2.2 and §4): which engine, model and effort
 * each role starts on for this install, with a relative cost beside each row.
 * One component with one data source — the setup guide's step 2 and the
 * "Agent mapping" menu row both mount it. Every change saves at once through
 * `PUT /api/roles`, optimistically, and rolls back with the reason on failure.
 */

export type MappingCatalogItem = RoleCatalogItem & {
  shipped?: { config: RoleConfig; variants?: Record<BuilderVariantId, RoleConfig> };
};

export type EngineStatus = {
  connected: boolean;
  /** The engine's command does not resolve here, whatever its sign-in says. */
  missing?: boolean;
  /** The engine's active account, for the headroom line. */
  account: AccountOption | null;
};

type RowKey = { roleId: RoleId; variant?: BuilderVariantId };

const ENGINE_NAME: Record<RoleEngine, string> = { claude: "Claude", codex: "Codex" };

/* One track list for the head and every row. The model column stops at 220 px
   and the role column takes what is left, so the standalone surface (no step
   rail) widens the names instead of stretching one select. */
const TABLE_GRID = "grid-cols-[minmax(176px,1fr)_136px_minmax(0,220px)_104px_104px]";

function blockedText(t: TFunction, engine: RoleEngine, status: EngineStatus): string {
  return t(status.missing ? "onboarding.agents.blockedMissing" : "onboarding.agents.blocked", { engine: ENGINE_NAME[engine] });
}

const GROUPS: readonly { id: "build" | "review" | "design" | "coordinate" | "rare"; rows: readonly RowKey[] }[] = [
  { id: "build", rows: [{ roleId: "builder" }, { roleId: "builder", variant: "frontend" }, { roleId: "builder", variant: "apply-fixes" }] },
  { id: "review", rows: [{ roleId: "reviewer" }, { roleId: "verifier" }] },
  { id: "design", rows: [{ roleId: "architect" }] },
  { id: "coordinate", rows: [{ roleId: "orchestrator" }] },
  { id: "rare", rows: [{ roleId: "cleaner" }, { roleId: "prod-auditor" }, { roleId: "deployer" }] },
];

const ALL_ROWS = GROUPS.flatMap((group) => group.rows);

function rowId(row: RowKey): string {
  return row.variant ? `${row.roleId}:${row.variant}` : row.roleId;
}

function rowLabel(row: RowKey, t: TFunction): string {
  if (row.variant === "frontend") return t("onboarding.agents.role.builderFrontend");
  if (row.variant === "apply-fixes") return t("onboarding.agents.role.builderFixes");
  const keys: Record<RoleId, Parameters<TFunction>[0]> = {
    builder: "onboarding.agents.role.builder",
    reviewer: "onboarding.agents.role.reviewer",
    verifier: "onboarding.agents.role.verifier",
    architect: "onboarding.agents.role.architect",
    orchestrator: "onboarding.agents.role.orchestrator",
    cleaner: "onboarding.agents.role.cleaner",
    "prod-auditor": "onboarding.agents.role.prodAuditor",
    deployer: "onboarding.agents.role.deployer",
  };
  return t(keys[row.roleId]);
}

function configOf(roles: readonly MappingCatalogItem[], row: RowKey): RoleConfig | null {
  const role = roles.find((candidate) => candidate.id === row.roleId);
  if (!role) return null;
  return row.variant ? role.variants?.[row.variant] ?? null : role.config;
}

function shippedOf(roles: readonly MappingCatalogItem[], row: RowKey): RoleConfig | null {
  const role = roles.find((candidate) => candidate.id === row.roleId);
  if (!role?.shipped) return null;
  return row.variant ? role.shipped.variants?.[row.variant] ?? null : role.shipped.config;
}

function same(left: RoleConfig | null, right: RoleConfig | null): boolean {
  return !!left && !!right && left.engine === right.engine && left.model === right.model && left.effort === right.effort;
}

/** The request body for a set of row changes; `null` resets a row. */
function patchBody(changes: readonly { row: RowKey; config: RoleConfig | null }[]) {
  const overrides: Record<string, { config?: RoleConfig | null; variants?: Record<string, RoleConfig | null> }> = {};
  for (const { row, config } of changes) {
    const entry = overrides[row.roleId] ??= {};
    if (row.variant) (entry.variants ??= {})[row.variant] = config;
    else entry.config = config;
  }
  return { overrides };
}

/** The catalog as it will read after `changes`, for the optimistic render. */
function applyLocally(roles: readonly MappingCatalogItem[], changes: readonly { row: RowKey; config: RoleConfig | null }[]): MappingCatalogItem[] {
  return roles.map((role) => {
    let next = role;
    for (const { row, config } of changes) {
      if (row.roleId !== role.id) continue;
      const value = config ?? shippedOf(roles, row);
      if (!value) continue;
      next = row.variant
        ? { ...next, variants: { ...next.variants!, [row.variant]: value } }
        : { ...next, config: value };
    }
    return next;
  });
}

const COST_KEY: Record<CostClass, Parameters<TFunction>[0]> = {
  light: "onboarding.agents.cost.light",
  moderate: "onboarding.agents.cost.moderate",
  heavy: "onboarding.agents.cost.heavy",
  "very-heavy": "onboarding.agents.cost.veryHeavy",
};

const COST_CHIP: Record<CostClass, string> = {
  light: "bg-sunken text-secondary",
  moderate: "bg-sunken text-secondary",
  heavy: "bg-warning-soft text-warning",
  "very-heavy": "bg-danger-soft text-danger",
};

function CostChip({ config }: { config: RoleConfig }) {
  const { t } = useLocale();
  const cost = costClass(config);
  return (
    <span data-cost-class={cost} className={`inline-flex h-5 items-center whitespace-nowrap rounded-[6px] px-1.5 text-caption font-semibold ${COST_CHIP[cost]}`}>
      {t(COST_KEY[cost])}
    </span>
  );
}

function Headroom({ config, status, compact = false }: { config: RoleConfig; status: EngineStatus; compact?: boolean }) {
  const { t } = useLocale();
  if (!status.connected) {
    return (
      <span className="flex items-center gap-1 text-label font-semibold text-warning">
        <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
        {blockedText(t, config.engine, status)}
      </span>
    );
  }
  const headroom = tightestHeadroom(config.engine, config.model, status.account?.limits);
  if (!headroom) return null;
  const windowName = headroom.window === "session"
    ? t("onboarding.agents.window.session")
    : headroom.window === "weekly" ? t("onboarding.agents.window.weekly") : headroom.window;
  /* The accounts panel's own thresholds: warning under 30 %, danger under 10 %. */
  const tone = headroom.percentLeft < 10 ? "text-danger" : headroom.percentLeft < 30 ? "text-warning" : "text-muted";
  const full = t("onboarding.agents.headroom", { window: windowName, percent: headroom.percentLeft });
  /* In the table the line lives in the 104 px cost cell under the chip, so it
     keeps the percent on one line and names the window on hover. */
  return compact
    ? <span data-mapping-headroom="" title={full} aria-label={full} className={`block whitespace-nowrap text-label leading-4 ${tone}`}>{t("onboarding.agents.headroomShort", { percent: headroom.percentLeft })}</span>
    : <span data-mapping-headroom="" className={`text-label ${tone}`}>{full}</span>;
}

function EngineSegments({ value, label, statuses, onChange }: { value: RoleEngine; label: string; statuses: Record<RoleEngine, EngineStatus>; onChange: (engine: RoleEngine) => void }) {
  const { t } = useLocale();
  return (
    <div role="radiogroup" aria-label={t("onboarding.agents.engineAria", { role: label })} className="inline-flex h-8 shrink-0 rounded-[8px] border border-border bg-sunken p-0.5 max-sm:h-auto">
      {(["claude", "codex"] as const).map((engine) => {
        const checked = value === engine;
        return (
          <button
            key={engine}
            type="button"
            role="radio"
            aria-checked={checked}
            data-engine-segment={engine}
            /* A disconnected engine stays selectable: someone who connects Codex
               tomorrow may still point a role at it today. */
            title={statuses[engine].connected ? ENGINE_NAME[engine] : blockedText(t, engine, statuses[engine])}
            onClick={() => { if (!checked) onChange(engine); }}
            className={`inline-flex min-w-0 items-center gap-1 rounded-[6px] px-1.5 text-ui font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:min-h-11 max-sm:flex-1 max-sm:justify-center ${checked ? "bg-card text-primary shadow-1 ring-1 ring-inset ring-strong" : "text-muted hover:text-primary"}`}
          >
            <EngineMark engine={engine} size={12} />
            {ENGINE_NAME[engine]}
          </button>
        );
      })}
    </div>
  );
}

const SELECT = "h-8 w-full min-w-0 rounded-[8px] border border-border bg-canvas px-1.5 text-ui font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11";

function RowControls({ row, config, shipped, statuses, layout, onChange }: {
  row: RowKey;
  config: RoleConfig;
  shipped: RoleConfig | null;
  statuses: Record<RoleEngine, EngineStatus>;
  layout: "table" | "card";
  onChange: (config: RoleConfig | null) => void;
}) {
  const { t } = useLocale();
  const label = rowLabel(row, t);
  const changed = shipped !== null && !same(config, shipped);
  const status = statuses[config.engine];
  const scale = effortScale(config.engine, config.model) ?? [];
  const nudge = costClass(config) === "very-heavy" && effortRank(config.effort) > effortRank("high") && scale.includes("high");
  const models = ENGINE_MODELS[config.engine];
  const modelSelect = (
    <select
      aria-label={t("onboarding.agents.modelAria", { role: label })}
      value={config.model}
      onChange={(event) => {
        const model = event.target.value;
        onChange({ engine: config.engine, model, effort: clampEffortToScale(config.engine, model, config.effort) ?? config.effort });
      }}
      className={SELECT}
    >
      {models.some((option) => option.id === config.model) ? null : <option value={config.model}>{config.model}</option>}
      {models.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
    </select>
  );
  const effortSelect = (
    <select
      aria-label={t("onboarding.agents.effortAria", { role: label })}
      value={config.effort}
      onChange={(event) => onChange({ ...config, effort: event.target.value })}
      className={SELECT}
    >
      {scale.includes(config.effort) ? null : <option value={config.effort}>{config.effort}</option>}
      {scale.map((tier) => <option key={tier} value={tier}>{tier}</option>)}
    </select>
  );
  const engineControl = <EngineSegments value={config.engine} label={label} statuses={statuses} onChange={(engine) => onChange(equivalentConfig(config, engine, row))} />;
  /* The state sits on its own line under the name, so the longest Ukrainian
     names («Розробник, виправлення», «Аудитор продакшену») keep the whole
     column when a row is changed. */
  const roleCell = (
    <span className="flex min-w-0 flex-col">
      <span className="min-w-0 truncate text-body font-semibold text-primary" title={label}>{label}</span>
      {changed ? (
        <span className="flex items-center gap-1 text-label text-secondary">
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
          {t("onboarding.agents.stateChanged")} ·
          <button type="button" data-mapping-reset={rowId(row)} onClick={() => onChange(null)} className="shrink-0 rounded-[6px] px-0.5 font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:-my-3.5 max-sm:min-h-11">
            {t("onboarding.agents.reset")}
          </button>
        </span>
      ) : <span className="sr-only">{t("onboarding.agents.stateDefault")}</span>}
    </span>
  );
  const nudgeLine = nudge ? (
    <span data-mapping-nudge={rowId(row)} className="flex flex-wrap items-center gap-x-1.5 text-label text-danger">
      {t("onboarding.agents.heavyNudge")}
      <button type="button" onClick={() => onChange({ ...config, effort: "high" })} className="rounded-[6px] font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:-my-3.5 max-sm:min-h-11">
        {t("onboarding.agents.heavyNudgeAction")}
      </button>
    </span>
  ) : null;

  if (layout === "card") {
    return (
      <div data-mapping-row={rowId(row)} data-mapping-blocked={status.connected ? undefined : ""} className="flex flex-col gap-2 rounded-[12px] border border-border bg-card p-3">
        {/* The chip stays on the name's line when a changed row adds its own. */}
        <div className="flex min-w-0 items-start gap-2">
          <span className="min-w-0 flex-1">{roleCell}</span>
          <span className="flex h-6 shrink-0 items-center"><CostChip config={config} /></span>
        </div>
        <div className="flex [&>div]:flex-1">{engineControl}</div>
        {modelSelect}
        {effortSelect}
        <Headroom config={config} status={status} />
        {nudgeLine}
      </div>
    );
  }
  return (
    <div data-mapping-row={rowId(row)} data-mapping-blocked={status.connected ? undefined : ""} className="border-b border-border py-1.5 last:border-b-0">
      <div className={`grid min-h-8 ${TABLE_GRID} items-center`}>
        <span className="min-w-0 pr-2">{roleCell}</span>
        <span className="min-w-0 pr-2">{engineControl}</span>
        <span className="min-w-0 pr-2">{modelSelect}</span>
        <span className="min-w-0 pr-2">{effortSelect}</span>
        <span className="flex min-w-0 flex-col items-start">
          <CostChip config={config} />
          {status.connected ? <Headroom config={config} status={status} compact /> : null}
        </span>
      </div>
      {!status.connected || nudgeLine ? (
        <div className={`grid ${TABLE_GRID} items-start pt-1`}>
          <span />
          <span className="col-span-4 flex min-w-0 flex-col gap-0.5">{!status.connected ? <Headroom config={config} status={status} /> : null}{nudgeLine}</span>
        </div>
      ) : null}
    </div>
  );
}

export function AgentMappingTable({ statuses, layout, onConnect }: {
  statuses: Record<RoleEngine, EngineStatus>;
  layout: "table" | "card";
  /** Opens the Engines step (or the accounts surface) for the missing engine. */
  onConnect: (engine: RoleEngine) => void;
}) {
  const { t } = useLocale();
  const [roles, setRoles] = useState<MappingCatalogItem[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ count: number; engine: RoleEngine; undo: { row: RowKey; config: RoleConfig | null }[] } | null>(null);
  const [bannerLeft, setBannerLeft] = useState(false);
  const [rareOpen, setRareOpen] = useState(false);

  const load = useCallback(() => {
    setLoadFailed(false);
    void fetch("/api/roles")
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return (await response.json()) as { roles: MappingCatalogItem[] };
      })
      .then((body) => setRoles(body.roles))
      .catch(() => setLoadFailed(true));
  }, []);
  useEffect(load, [load]);

  const save = useCallback(async (changes: { row: RowKey; config: RoleConfig | null }[]): Promise<boolean> => {
    if (!roles) return false;
    const before = roles;
    setRoles(applyLocally(roles, changes));
    setSaveError(null);
    try {
      const response = await fetch("/api/roles", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patchBody(changes)),
      });
      const body = await response.json().catch(() => null) as { roles?: MappingCatalogItem[]; error?: string } | null;
      if (!response.ok || !body?.roles) throw new Error(body?.error || `HTTP ${response.status}`);
      setRoles(body.roles);
      replaceRoleCatalog(body.roles);
      return true;
    } catch (error) {
      setRoles(before);
      setSaveError(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, [roles]);

  if (loadFailed) {
    return (
      <div className="flex items-center gap-2 text-body text-secondary">
        <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-warning" />
        <span className="min-w-0 flex-1">{t("onboarding.offline")}</span>
        <button type="button" onClick={load} className="shrink-0 rounded-[8px] border border-border px-2.5 py-1 text-ui font-semibold hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:min-h-11">{t("onboarding.retry")}</button>
      </div>
    );
  }
  if (!roles) {
    return <div className="flex flex-col gap-2" aria-busy>{[0, 1, 2, 3].map((index) => <div key={index} className="h-11 animate-pulse rounded-[8px] bg-sunken motion-reduce:animate-none" />)}</div>;
  }

  const connectedEngines = (["claude", "codex"] as const).filter((engine) => statuses[engine].connected);
  const missing = connectedEngines.length === 1 ? (connectedEngines[0] === "claude" ? "codex" : "claude") : null;
  const connected = connectedEngines.length === 1 ? connectedEngines[0]! : null;
  const blockedRows = missing ? ALL_ROWS.filter((row) => configOf(roles, row)?.engine === missing) : [];

  const moveAll = () => {
    if (!missing || !connected) return;
    const moves = blockedRows.map((row) => ({ row, from: configOf(roles, row)!, shipped: shippedOf(roles, row) }));
    const changes = moves.map(({ row, from }) => ({ row, config: equivalentConfig(from, connected, row) }));
    /* The undo writes back what each row was: a row that was on its shipped
       value resets, a row the install had changed gets that change back. */
    const undo = moves.map(({ row, from, shipped }) => ({ row, config: same(from, shipped) ? null : from }));
    void save(changes).then((ok) => { if (ok) setReceipt({ count: changes.length, engine: connected, undo }); });
  };

  return (
    <div data-agent-mapping="" className="flex flex-col gap-3">
      {/* The legend comes before the first chip it explains. */}
      <p data-mapping-legend="" className="text-label text-muted">{t("onboarding.agents.legend")}</p>
      {connectedEngines.length === 0 ? (
        <p className="rounded-[8px] bg-warning-soft px-3 py-2 text-body text-warning">{t("onboarding.agents.neither")}</p>
      ) : null}
      {missing && connected && blockedRows.length > 0 && !bannerLeft ? (
        <div data-mapping-banner="" className="flex flex-col gap-2 rounded-[12px] bg-warning-soft p-3">
          <p className="flex items-start gap-1.5 text-body text-primary">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
            <span>{t("onboarding.agents.banner", { count: blockedRows.length, missing: ENGINE_NAME[missing] })}</span>
          </p>
          <div className="flex flex-wrap items-center gap-2 max-sm:flex-col max-sm:items-stretch">
            <button type="button" data-mapping-move="" onClick={moveAll} className="inline-flex h-8 items-center justify-center rounded-[8px] bg-brand px-3 text-ui font-semibold text-on-brand hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11">
              {t("onboarding.agents.move", { connected: ENGINE_NAME[connected] })}
            </button>
            <button type="button" onClick={() => onConnect(missing)} className="inline-flex h-8 items-center justify-center rounded-[8px] border border-border bg-card px-3 text-ui font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11">
              {t("onboarding.agents.connect", { missing: ENGINE_NAME[missing] })}
            </button>
            <button type="button" onClick={() => setBannerLeft(true)} className="inline-flex h-8 items-center justify-center rounded-[8px] px-2 text-ui font-semibold text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11">
              {t("onboarding.agents.leaveAsIs")}
            </button>
          </div>
        </div>
      ) : null}
      {receipt ? (
        <p role="status" data-mapping-receipt="" className="flex flex-wrap items-center gap-x-2 text-ui text-secondary">
          {t("onboarding.agents.moved", { count: receipt.count, connected: ENGINE_NAME[receipt.engine] })}
          <button type="button" onClick={() => { const undo = receipt.undo; setReceipt(null); void save(undo); }} className="rounded-[6px] font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:min-h-11">
            {t("onboarding.agents.undo")}
          </button>
        </p>
      ) : null}
      {saveError ? <p role="alert" className="text-ui text-danger">{t("onboarding.agents.saveFailed", { reason: saveError })}</p> : null}

      {layout === "table" ? (
        <div className={`grid ${TABLE_GRID} text-label font-semibold uppercase tracking-[0.02em] text-muted`}>
          <span>{t("onboarding.agents.col.role")}</span>
          <span>{t("onboarding.agents.col.engine")}</span>
          <span>{t("onboarding.agents.col.model")}</span>
          <span>{t("onboarding.agents.col.effort")}</span>
          <span>{t("onboarding.agents.col.cost")}</span>
        </div>
      ) : null}

      {GROUPS.map((group) => {
        const rare = group.id === "rare";
        const open = !rare || rareOpen;
        const heading = t(`onboarding.agents.group.${group.id}` as Parameters<TFunction>[0]);
        return (
          <section key={group.id} data-mapping-group={group.id} className="flex flex-col">
            {rare ? (
              <button type="button" aria-expanded={open} onClick={() => setRareOpen((value) => !value)} className="flex min-h-8 items-center gap-1 pt-2 text-left text-label font-semibold uppercase tracking-[0.02em] text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:min-h-11">
                {open ? <ChevronDown className="h-3 w-3" aria-hidden /> : <ChevronRight className="h-3 w-3" aria-hidden />}
                {heading}
              </button>
            ) : (
              <h3 className="pt-2 text-label font-semibold uppercase tracking-[0.02em] text-muted">{heading}</h3>
            )}
            {open ? (
              <div className={layout === "card" ? "flex flex-col gap-2 pt-1.5" : "flex flex-col"}>
                {group.rows.map((row) => {
                  const config = configOf(roles, row);
                  if (!config) return null;
                  return (
                    <RowControls
                      key={rowId(row)}
                      row={row}
                      config={config}
                      shipped={shippedOf(roles, row)}
                      statuses={statuses}
                      layout={layout}
                      onChange={(next) => { setReceipt(null); void save([{ row, config: next }]); }}
                    />
                  );
                })}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
