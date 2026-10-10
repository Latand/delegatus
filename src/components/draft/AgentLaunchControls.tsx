"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { accountWeeklyLeft, WeeklyMeter, weeklyLeftAria, weeklyLeftHint } from "@/components/accountWeekly";
import { ReasoningControls, type SpeedChoice } from "@/components/ReasoningControls";
import { engineTintOf } from "@/components/utils";
import { useEngineAccounts } from "@/hooks/useEngineAccounts";
import { useIsMobile } from "@/hooks/useIsMobile";
import { requestAccountPanel } from "@/lib/accounts/openPanel";
import { effortScale, registerCopilotEffortScales } from "@/lib/agent/efforts";
import { defaultModelFor } from "@/lib/agent/models";
import { useLocale } from "@/lib/i18n";
import type { CopilotModelEntry } from "@/lib/agent/copilotModels";

/**
 * THE shared «which agent am I launching» control set (PRD #976 slice A).
 *
 * Engine, model, reasoning effort, codex speed and stored account were the
 * board draft pane's private state; the orchestrator panel (#977), its rotate
 * flow (#978) and the mobile create sheet (#979) all offer the operator the
 * exact same choices, so the choices live here — once — and every surface
 * mounts this module instead of growing a lookalike.
 *
 * The API is deliberately split so a host can bring its own layout:
 *
 *  - {@link useAgentLaunchDraft} owns the STATE and the invariants that tie the
 *    fields together (switching engines re-defaults the model, drops an account
 *    id that belongs to the other engine's catalog, and drops a tier the new
 *    engine does not have). It renders nothing.
 *  - {@link AgentLaunchControls} is one LAYOUT of those fields; a host that
 *    wants a different arrangement composes {@link EngineRadioGroup},
 *    {@link LaunchAccountSelect} and `ReasoningControls` itself from the same
 *    draft object.
 *
 * Persistence is injected ({@link LaunchDraftStorage}), so the board draft keeps
 * its per-draft sessionStorage keys and a transient surface keeps nothing.
 */

export type LaunchEngine = "claude" | "codex" | "copilot";
export type { SpeedChoice };

/** Secret-free slice of one stored account that a launch selector needs. */
export interface LaunchAccountOption {
  id: string;
  label: string;
  authPresent: boolean;
  /** No credential, or one the provider refused: a launch on it cannot start
      until the account signs in again (#2170). */
  signedOut: boolean;
}

export type LaunchAccountCatalog = Record<LaunchEngine, { active: string; accounts: LaunchAccountOption[] }>;

const ENGINES: { key: LaunchEngine; label: string }[] = [
  { key: "claude", label: "Claude" },
  { key: "codex", label: "Codex" },
  { key: "copilot", label: "Copilot" },
];

/** The engines a surface offers when it names none: every surface launches
    Claude and Codex. Copilot is offered only where a surface opts in — the
    agent draft — because pipeline stages and orchestrator seats do not run it
    yet (docs/design/copilot-engine.md, slice 4). */
export const DEFAULT_LAUNCH_ENGINES: readonly LaunchEngine[] = ["claude", "codex"];
export const AGENT_LAUNCH_ENGINES: readonly LaunchEngine[] = ["claude", "codex", "copilot"];

export function launchEngineLabel(engine: LaunchEngine): string {
  return ENGINES.find((entry) => entry.key === engine)?.label ?? engine;
}

/** Crash-safe read of one engine section of `/api/accounts`: a malformed body
    yields an empty section, which simply hides that engine's selector. */
export function launchAccountSection(raw: unknown): LaunchAccountCatalog[LaunchEngine] {
  const section = raw as { active?: unknown; accounts?: unknown } | null;
  const accounts = Array.isArray(section?.accounts)
    ? section.accounts.flatMap((entry): LaunchAccountOption[] => {
        const account = entry as { id?: unknown; label?: unknown; authPresent?: unknown; auth?: { state?: unknown } | null };
        return typeof account.id === "string" && typeof account.label === "string"
          ? [{
              id: account.id,
              label: account.label,
              authPresent: account.authPresent !== false,
              /* The account's reconciled auth state decides when the body carries
                 one: a credential store that cannot be read reports no
                 credential present, and that is not a signed-out account. */
              signedOut: typeof account.auth?.state === "string" ? account.auth.state === "signed_out" : account.authPresent === false,
            }]
          : [];
      })
    : [];
  return { active: typeof section?.active === "string" ? section.active : "", accounts };
}

/** Both engine sections of one `/api/accounts` body. */
export function launchAccountCatalogOf(body: unknown): LaunchAccountCatalog {
  const raw = body as { claude?: unknown; codex?: unknown; copilot?: unknown } | null;
  return { claude: launchAccountSection(raw?.claude), codex: launchAccountSection(raw?.codex), copilot: launchAccountSection(raw?.copilot) };
}

/**
 * The account a launch will actually run on (issue #40): a stored id from the
 * other engine's catalog — or from an account that has been removed — falls back
 * to the engine's active account, so the value shown is always the value sent.
 */
export function resolveLaunchAccountId(
  catalog: LaunchAccountCatalog | null,
  engine: LaunchEngine,
  accountId: string,
): string {
  const section = catalog?.[engine] ?? null;
  if (!section) return "";
  return section.accounts.some((account) => account.id === accountId) ? accountId : section.active;
}

/** Asks every mounted catalog to read `/api/accounts` again. */
const CATALOG_REFRESH_EVENT = "llv:launch-accounts-refresh";

/** The stored-account catalog for both engines; null until `/api/accounts`
    answers, and null forever if it never does (the selector simply stays out
    of the way, exactly as the board draft has always behaved). */
export function useLaunchAccountCatalog(): LaunchAccountCatalog | null {
  const [catalog, setCatalog] = useState<LaunchAccountCatalog | null>(null);
  useEffect(() => {
    let cancelled = false;
    const read = () => {
      void fetch("/api/accounts")
        .then(async (res) => {
          if (!res.ok || cancelled) return;
          setCatalog(launchAccountCatalogOf(await res.json()));
        })
        .catch(() => {});
    };
    read();
    window.addEventListener(CATALOG_REFRESH_EVENT, read);
    return () => {
      cancelled = true;
      window.removeEventListener(CATALOG_REFRESH_EVENT, read);
    };
  }, []);
  return catalog;
}

/**
 * Whether a launch on the draft's account can start (#2170): the ONE engine
 * readiness preflight the agent launcher and the orchestrator draft share.
 * A signed-out account is the one answer that stops a launch here — anything
 * the catalog cannot see (no catalog yet, an account it does not list) is left
 * to the server, which refuses what really cannot run.
 */
export type LaunchReadiness =
  | { kind: "ready" }
  | { kind: "signed-out"; engine: LaunchEngine; accountId: string; label: string };

export function launchReadiness(draft: Pick<AgentLaunchDraft, "engine" | "catalog" | "launchAccountId">): LaunchReadiness {
  const account = draft.catalog?.[draft.engine]?.accounts.find((entry) => entry.id === draft.launchAccountId);
  if (!account?.signedOut) return { kind: "ready" };
  return { kind: "signed-out", engine: draft.engine, accountId: account.id, label: account.label };
}

/** The preflight's own action: that account's sign-in, in the Accounts panel. */
export function openLaunchSignIn(readiness: Extract<LaunchReadiness, { kind: "signed-out" }>): void {
  requestAccountPanel(readiness.engine, readiness.accountId);
}

/** How often a blocked draft re-reads the catalog, so a sign-in finished in
    the Accounts panel (or anywhere else) lifts the block without a reload. */
const SIGNED_OUT_RECHECK_MS = 4_000;

/**
 * {@link launchReadiness} for a mounted draft, kept current: while the chosen
 * account is signed out, the catalog is read again on focus and on a short
 * cadence, and only then — a draft on a ready account polls nothing.
 */
export function useLaunchReadiness(draft: AgentLaunchDraft): LaunchReadiness {
  const readiness = launchReadiness(draft);
  const blocked = readiness.kind === "signed-out";
  useEffect(() => {
    if (!blocked) return;
    const refresh = () => window.dispatchEvent(new Event(CATALOG_REFRESH_EVENT));
    const timer = window.setInterval(refresh, SIGNED_OUT_RECHECK_MS);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [blocked]);
  return readiness;
}

/** Where a host keeps the draft between mounts. Absent: memory only. */
export interface LaunchDraftStorage {
  read(name: string): string;
  write(name: string, value: string): void;
}

export interface AgentLaunchDraft {
  engine: LaunchEngine;
  model: string;
  effort: string;
  speed: SpeedChoice;
  /** The operator's explicit pick, "" while they have made none. */
  accountId: string;
  /** The id a launch would actually carry — see {@link resolveLaunchAccountId}. */
  launchAccountId: string;
  catalog: LaunchAccountCatalog | null;
  accounts: LaunchAccountOption[];
  activeAccountId: string;
  setEngine(engine: LaunchEngine): void;
  setModel(model: string): void;
  setEffort(effort: string): void;
  setSpeed(speed: SpeedChoice): void;
  setAccountId(accountId: string): void;
}

/**
 * The draft's launch parameters, with their invariants. Switching engines is
 * the one compound move: the account id belongs to ONE engine's catalog, the
 * model default differs, and the tier lists differ (claude has «max», codex
 * does not), so a carried-over invalid tier falls back to the CLI default.
 */
export function useAgentLaunchDraft(options: {
  storage?: LaunchDraftStorage;
  /** Engine to start on when storage holds none. */
  initialEngine?: LaunchEngine;
  /** Model/tier to start on when storage holds none — a surface with a canonical
      configuration (the orchestrator's own spawn config) opens on it instead of
      the engine's generic default. Switching engines re-defaults the model, as
      everywhere else: a model belongs to one engine. */
  initialModel?: string;
  initialEffort?: string;
  catalog?: LaunchAccountCatalog | null;
  /** Fires with the NEW engine before the state moves, for hosts that
      renegotiate engine-scoped capabilities (the board draft's image
      negotiation). */
  onEngineChange?: (engine: LaunchEngine) => void;
} = {}): AgentLaunchDraft {
  const { storage, onEngineChange } = options;
  const read = (name: string) => storage?.read(name) ?? "";
  const write = (name: string, value: string) => storage?.write(name, value);
  const fetched = useLaunchAccountCatalog();
  const catalog = options.catalog !== undefined ? options.catalog : fetched;

  const [engine, setEngineState] = useState<LaunchEngine>(() => {
    const stored = read("engine");
    if (stored === "codex" || stored === "claude" || stored === "copilot") return stored;
    return options.initialEngine ?? "claude";
  });
  const [model, setModelState] = useState(() => read("model") || options.initialModel || defaultModelFor(engine));
  const [effort, setEffortState] = useState(() => read("effort") || options.initialEffort || "");
  const [speed, setSpeedState] = useState<SpeedChoice>(() => {
    const stored = read("speed");
    return stored === "fast" || stored === "standard" ? stored : "";
  });
  const [accountId, setAccountIdState] = useState(() => read("accountId"));

  const setModel = (value: string) => {
    setModelState(value);
    write("model", value);
  };
  const setEffort = (value: string) => {
    setEffortState(value);
    write("effort", value);
  };
  const setSpeed = (value: SpeedChoice) => {
    setSpeedState(value);
    write("speed", value);
  };
  const setAccountId = (value: string) => {
    setAccountIdState(value);
    write("accountId", value);
  };
  const setEngine = (value: LaunchEngine) => {
    onEngineChange?.(value);
    setEngineState(value);
    write("engine", value);
    /* An account id belongs to one engine's catalog; flipping engines drops the
       explicit choice so the new engine launches on its own active account. */
    setAccountId("");
    setModel(defaultModelFor(value));
    if (effort && !effortScale(value, defaultModelFor(value))!.includes(effort)) setEffort("");
  };

  const section = catalog?.[engine] ?? null;
  return {
    engine,
    model,
    effort,
    speed,
    accountId,
    launchAccountId: resolveLaunchAccountId(catalog, engine, accountId),
    catalog,
    accounts: section?.accounts ?? [],
    activeAccountId: section?.active ?? "",
    setEngine,
    setModel,
    setEffort,
    setSpeed,
    setAccountId,
  };
}

/**
 * The engine picker chips every draft-style window shares — the agent draft
 * pane, the pipeline stage placeholders and the orchestrator panel render the
 * exact same control (issue #196: one window recipe, no lookalikes).
 */
export function EngineRadioGroup({
  engine,
  disabled,
  roomy,
  engines = DEFAULT_LAUNCH_ENGINES,
  onChange,
}: {
  engine: LaunchEngine;
  disabled?: boolean;
  /** The 32px control step for surfaces that give the draft its own column. */
  roomy?: boolean;
  /** The engines this surface can launch; Claude and Codex unless it opts in. */
  engines?: readonly LaunchEngine[];
  onChange: (engine: LaunchEngine) => void;
}) {
  const { t } = useLocale();
  return (
    <div className="flex shrink-0 items-center gap-1" role="radiogroup" aria-label={t("draft.engineAria")}>
      {ENGINES.filter(({ key }) => engines.includes(key)).map(({ key, label }) => {
        const active = engine === key;
        const chip = engineTintOf(key);
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(key)}
            style={active ? { backgroundColor: "var(--color-card)", color: chip.color, borderColor: chip.color } : undefined}
            className={`rounded-full border font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60 ${
              roomy ? "px-3 py-1 text-ui" : "px-2 py-0.5 text-[10.5px]"
            } ${active ? "" : "border-transparent bg-transparent text-muted hover:text-primary"}`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** How far a sideways chip row scrolls so one chip stands inside it with
    `pad` to spare on the side it came in from; the row's own offset when the
    chip is already in sight. Rectangles are viewport coordinates. */
export function revealScrollLeft(
  row: { left: number; width: number; scrollLeft: number },
  chip: { left: number; width: number },
  pad = 24,
): number {
  const start = chip.left - row.left;
  const end = start + chip.width;
  if (start < pad) return Math.max(0, row.scrollLeft + start - pad);
  if (end > row.width - pad) return row.scrollLeft + end - row.width + pad;
  return row.scrollLeft;
}

/** The mask that fades a sideways row out at an edge more chips are hidden behind. */
function edgeFade(start: boolean, end: boolean): React.CSSProperties | undefined {
  if (!start && !end) return undefined;
  const image = `linear-gradient(to right, ${start ? "transparent, #000 20px" : "#000"}, ${end ? "#000 calc(100% - 24px), transparent" : "#000"})`;
  return { maskImage: image, WebkitMaskImage: image };
}

/** How long a finger rests on a chip before its hint shows instead of a pick. */
const LONG_PRESS_MS = 500;

/**
 * The stored-account picker (issue #40), as the operator chose it on
 * 2026-10-10: every account of the engine is a chip in one row, a radio group,
 * and nothing opens. A chip names the account, what is left of its weekly
 * limit and that share as a bar, read from the same per-account readings the
 * sidebar footer draws ({@link accountWeeklyLeft}). The chosen chip carries the
 * accent border; the engine's active account carries the green dot. A
 * signed-out account stays in the row, dashed and marked, and cannot be picked
 * until it signs back in via Accounts. The phone scrolls the row sideways and
 * fades the edge more chips hide behind; the desktop wraps it.
 *
 * Renders nothing while the engine has no catalog: the launch then runs on
 * whatever the CLI's own active profile is, which is what every surface did
 * before accounts existed.
 */
export function LaunchAccountSelect({
  draft,
  disabled,
  roomy,
  className,
}: {
  draft: AgentLaunchDraft;
  disabled?: boolean;
  roomy?: boolean;
  className?: string;
}) {
  const { t } = useLocale();
  const phone = useIsMobile();
  /* The readings come from the one accounts store the footer reads; Copilot has none there, so no bar. */
  const readings = useEngineAccounts(draft.engine === "codex" ? "codex" : "claude").accounts;
  const [now] = useState(() => Date.now() / 1000);
  const rowRef = useRef<HTMLDivElement>(null);
  const chipRefs = useRef(new Map<string, HTMLButtonElement>());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  const press = useRef<{ id: string; timer: number; fired: boolean } | null>(null);
  const tint = engineTintOf(draft.engine).color;
  const selected = draft.launchAccountId;
  const count = draft.accounts.length;

  const measureEdges = useCallback(() => {
    const row = rowRef.current;
    if (!row || !phone) { setEdges((value) => (value.start || value.end ? { start: false, end: false } : value)); return; }
    const start = row.scrollLeft > 1;
    const end = row.scrollLeft + row.clientWidth < row.scrollWidth - 1;
    setEdges((value) => (value.start === start && value.end === end ? value : { start, end }));
  }, [phone]);

  /* The chosen chip is in sight when the row first shows and whenever the engine changes. */
  useLayoutEffect(() => {
    const row = rowRef.current;
    const chip = chipRefs.current.get(selected);
    if (phone && row && chip) {
      const box = row.getBoundingClientRect();
      const rect = chip.getBoundingClientRect();
      row.scrollLeft = revealScrollLeft({ left: box.left, width: box.width, scrollLeft: row.scrollLeft }, { left: rect.left, width: rect.width });
    }
    measureEdges();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- revealed on the engine and on the catalog's arrival, not on every pick
  }, [draft.engine, count, phone]);

  useEffect(() => {
    if (!phone) return;
    window.addEventListener("resize", measureEdges);
    return () => window.removeEventListener("resize", measureEdges);
  }, [phone, measureEdges]);

  useEffect(() => () => { if (press.current) window.clearTimeout(press.current.timer); }, []);

  if (!count) return null;

  const chips = draft.accounts.map((account) => {
    const weekly = draft.engine === "copilot" ? null : accountWeeklyLeft(readings.find((entry) => entry.id === account.id)?.limits, now, tint);
    const pickable = account.authPresent && !account.signedOut;
    const active = account.id === draft.activeAccountId;
    const name = [account.label, active ? t("accounts.active") : null, account.signedOut ? t("kanban.account.tagSignedOut") : null, weekly ? weeklyLeftAria(t, weekly) : null].filter(Boolean).join(" · ");
    const title = [account.label, active ? t("accounts.active") : null, account.signedOut ? t("kanban.account.tagSignedOut") : null, weekly ? weeklyLeftHint(t, weekly, now) : null].filter(Boolean).join(" · ");
    return { account, weekly, pickable, active, name, title };
  });
  const tabStop = chips.some((chip) => chip.account.id === focusId) ? focusId : chips.some((chip) => chip.account.id === selected) ? selected : chips[0]!.account.id;

  const pick = (id: string) => {
    const chip = chips.find((entry) => entry.account.id === id);
    if (!chip?.pickable || disabled) return;
    setHint(null);
    draft.setAccountId(id);
  };
  const moveFocus = (index: number) => {
    const chip = chips[(index + chips.length) % chips.length]!;
    setFocusId(chip.account.id);
    chipRefs.current.get(chip.account.id)?.focus();
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    const index = chips.findIndex((chip) => chip.account.id === tabStop);
    switch (event.key) {
      case "ArrowRight": case "ArrowDown": event.preventDefault(); moveFocus(index + 1); break;
      case "ArrowLeft": case "ArrowUp": event.preventDefault(); moveFocus(index - 1); break;
      case "Home": event.preventDefault(); moveFocus(0); break;
      case "End": event.preventDefault(); moveFocus(chips.length - 1); break;
      case "Enter": case " ": event.preventDefault(); pick(tabStop!); break;
      default: break;
    }
  };
  const size = phone ? "min-h-11 px-2.5 text-body" : roomy ? "h-8 px-2 text-ui" : "h-7 px-1.5 text-ui";

  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className ?? ""}`} data-launch-account-chips>
      <div
        ref={rowRef}
        role="radiogroup"
        aria-label={t("draft.accountAria", { engine: launchEngineLabel(draft.engine) })}
        aria-disabled={disabled || undefined}
        onKeyDown={onKeyDown}
        onScroll={phone ? measureEdges : undefined}
        onPointerDown={() => setHint(null)}
        data-launch-account-row={phone ? "scroll" : "wrap"}
        style={phone ? edgeFade(edges.start, edges.end) : undefined}
        className={`flex min-w-0 items-center gap-1 ${phone ? "overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" : "flex-wrap"}`}
      >
        {chips.map(({ account, weekly, pickable, active, name, title }) => {
          const chosen = account.id === selected;
          return (
            <button
              key={account.id}
              ref={(element) => { if (element) chipRefs.current.set(account.id, element); else chipRefs.current.delete(account.id); }}
              type="button"
              role="radio"
              aria-checked={chosen}
              aria-disabled={!pickable || undefined}
              aria-label={name}
              title={title}
              disabled={disabled}
              tabIndex={account.id === tabStop ? 0 : -1}
              data-launch-account={account.id}
              data-launch-account-pickable={pickable ? "true" : "false"}
              onFocus={() => setFocusId(account.id)}
              onClick={() => {
                if (press.current?.fired && press.current.id === account.id) { press.current = null; return; }
                pick(account.id);
              }}
              onPointerDown={(event) => {
                if (event.pointerType !== "touch") return;
                if (press.current) window.clearTimeout(press.current.timer);
                const entry = { id: account.id, fired: false, timer: 0 };
                entry.timer = window.setTimeout(() => { entry.fired = true; setHint(title); }, LONG_PRESS_MS);
                press.current = entry;
              }}
              onPointerUp={() => { if (press.current && !press.current.fired) window.clearTimeout(press.current.timer); }}
              onPointerCancel={() => { if (press.current) { window.clearTimeout(press.current.timer); press.current = null; } }}
              onContextMenu={(event) => { if (press.current?.id === account.id) event.preventDefault(); }}
              className={`${size} inline-flex max-w-full shrink-0 select-none items-center gap-1.5 whitespace-nowrap rounded-control border text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60 ${
                chosen ? "border-accent bg-accent-soft" : pickable ? "border-border bg-card hover:bg-sunken" : "cursor-not-allowed border-dashed border-border bg-transparent"
              }`}
            >
              {active ? <span aria-hidden data-launch-account-active className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" /> : null}
              {/* The whole name: a chip is only cut short when it would be wider than its row. */}
              <span className={`min-w-0 truncate ${chosen ? "font-semibold text-primary" : pickable ? "font-medium text-secondary" : "text-muted"}`}>{account.label}</span>
              {account.signedOut ? (
                <span className="shrink-0 text-caption font-semibold text-warning" data-launch-account-signed-out>{t("kanban.account.tagSignedOut")}</span>
              ) : null}
              {weekly && pickable ? <WeeklyMeter weekly={weekly} /> : null}
            </button>
          );
        })}
      </div>
      {/* A phone has no hover: a long press shows the hint a pointer reads, the reset included. */}
      {hint ? <p className="text-label leading-snug text-muted" role="status" data-launch-account-hint>{hint}</p> : null}
    </div>
  );
}

/**
 * One layout of the whole set: engine chips, account, model, effort, speed.
 * `stacked` gives each control a label above it — the shape a full-height dock
 * column wants; the default packs them into one wrapping strip, the shape a
 * dense board card wants.
 */
export function AgentLaunchControls({
  draft,
  disabled,
  stacked,
}: {
  draft: AgentLaunchDraft;
  disabled?: boolean;
  stacked?: boolean;
}) {
  const { t } = useLocale();
  const catalogAccountId = draft.launchAccountId || draft.activeAccountId;
  const [copilotModels, setCopilotModels] = useState<CopilotModelEntry[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (draft.engine !== "copilot" || !catalogAccountId) { setCopilotModels(null); return; }
    setCopilotModels(null);
    void fetch(`/api/accounts/copilot/models?account=${encodeURIComponent(catalogAccountId)}`)
      .then(async (response) => {
        if (!response.ok || cancelled) return;
        const body = await response.json() as { models?: unknown };
        if (Array.isArray(body.models)) {
          const models = body.models.filter((item): item is CopilotModelEntry => Boolean(item)
            && typeof item === "object" && typeof (item as CopilotModelEntry).id === "string"
            && typeof (item as CopilotModelEntry).name === "string");
          registerCopilotEffortScales(models);
          setCopilotModels(models);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [draft.engine, catalogAccountId]);
  useEffect(() => {
    if (draft.engine !== "copilot" || !copilotModels?.length) return;
    if (!copilotModels.some((model) => model.id === draft.model)) {
      draft.setModel("auto");
      if (draft.effort) draft.setEffort("");
      return;
    }
    const selected = copilotModels.find((model) => model.id === draft.model);
    if (draft.effort && selected?.efforts && !selected.efforts.includes(draft.effort)) draft.setEffort("");
  }, [draft.engine, draft.model, draft.effort, copilotModels, draft.setModel, draft.setEffort]);
  if (!stacked) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <EngineRadioGroup engine={draft.engine} disabled={disabled} onChange={draft.setEngine} />
        <LaunchAccountSelect draft={draft} disabled={disabled} />
        <ReasoningControls
          engine={draft.engine}
          model={draft.model}
          effort={draft.effort}
          speed={draft.speed}
          disabled={disabled}
          onModel={draft.setModel}
          onEffort={draft.setEffort}
          onSpeed={draft.setSpeed}
          copilotModels={draft.engine === "copilot" ? copilotModels : undefined}
        />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2.5">
      <Field label={t("draft.engineAria")}>
        <EngineRadioGroup engine={draft.engine} disabled={disabled} roomy onChange={draft.setEngine} />
      </Field>
      {draft.accounts.length ? (
        <Field label={t("launch.account")}>
          <LaunchAccountSelect draft={draft} disabled={disabled} roomy className="w-full" />
        </Field>
      ) : null}
      <Field label={t("launch.reasoning")}>
        <div className="flex flex-wrap items-center gap-2 [&>select]:min-w-28 [&>select]:flex-1">
          <ReasoningControls
            engine={draft.engine}
            model={draft.model}
            effort={draft.effort}
            speed={draft.speed}
            disabled={disabled}
            roomy
            onModel={draft.setModel}
            onEffort={draft.setEffort}
            onSpeed={draft.setSpeed}
            copilotModels={draft.engine === "copilot" ? copilotModels : undefined}
          />
        </div>
      </Field>
    </div>
  );
}

function Field({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className ?? ""}`}>
      <span className="text-label font-semibold text-muted">{label}</span>
      {children}
    </div>
  );
}
