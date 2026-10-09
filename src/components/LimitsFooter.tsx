"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import { accountEntryPointVisible, type AccountOption, type Engine, useEngineAccounts } from "@/hooks/useEngineAccounts";
import { consumePendingAccountPanel, onAccountPanelRequest } from "@/lib/accounts/openPanel";
import { claudeTierDisplayName } from "@/lib/agent/models";
import { type Locale, type TFunction, translate, useLocale } from "@/lib/i18n";
import { effectiveQuota, LIMITS_FRESHNESS_S, quotaAsEngineLimits, quotaReadingFromAccountLimits, quotaReadingFromEngineLimits, reconcileQuotaReadings, type ReconciledQuota } from "@/lib/rateLimit";
import { LIMITS_RATE_LIMITED_REASON, LIMITS_REAUTH_REQUIRED_REASON, type EngineLimits, type LimitsPayload, type LimitsProvenance, type LimitWindow } from "@/lib/types";

import { AccountsPanel } from "./AccountsPanel";
import { CopilotFooterRow } from "./CopilotFooterRow";
import { BurndownPanel } from "./BurndownPanel";
import { TelegramFooterRow } from "./TelegramConnect";
import { Loader2 } from "./icons";
import { formatQuotaAsOf, localeBcp47 as bcp47, windowLabel } from "./rateLimit";
import { engineTintOf, fmtAge } from "./utils";
import { barColor, LimitWindowLine } from "./LimitRow";
import { EngineMark } from "./EngineMark";
import { LINE_EDGE, ReserveBar, type SidebarFooterDensity } from "./railFooterDensity";

const POLL_MS = 60_000;

/** Human "as of HH:MM" hint for a stale snapshot. The Codex block renders this
    text alongside the dimming, giving that state a readable reason. */
export function fmtStaleSince(staleSince: string | null | undefined, locale: Locale): string | null {
  return formatQuotaAsOf(staleSince, locale);
}

export function fmtQuotaStaleHint(stale: boolean, observedAt: number | null, locale: Locale): string | null {
  if (!stale) return null;
  return formatQuotaAsOf(observedAt, locale) ?? translate(locale, "accounts.limitsStale");
}

export function fmtLimitsFailureReason(meta: LimitsProvenance, locale: Locale): string | null {
  if (meta.source !== "unavailable" && meta.source !== "cache") return null;
  if (meta.reason === LIMITS_REAUTH_REQUIRED_REASON) return translate(locale, "limits.reauthRequired");
  if (meta.reason !== LIMITS_RATE_LIMITED_REASON || !meta.retryAt) return null;
  const retryAt = new Date(meta.retryAt);
  if (Number.isNaN(retryAt.getTime())) return translate(locale, "limits.rateLimited");
  return translate(locale, "limits.rateLimitedRetry", {
    time: retryAt.toLocaleTimeString(bcp47(locale), { hour: "2-digit", minute: "2-digit", hour12: false }),
  });
}

/** Bar keeps the engine identity color while there is headroom, then warns. */
/** True only when both payloads name a Codex account and the id changed. A
    freshly added account has no transcripts, so its payload arrives with
    `codex: null`; without this guard the sticky merge would carry the previous
    account's percentages forward under the new account's name. */
function accountChanged(previous: LimitsPayload | null, next: LimitsPayload, engine: "claude" | "codex" | "copilot"): boolean {
  if (!previous) return false;
  const prevId = engine === "claude" ? previous.claudeAccountId ?? null : engine === "codex" ? previous.codexAccountId ?? null : previous.copilotAccountId ?? null;
  const nextId = engine === "claude" ? next.claudeAccountId ?? null : engine === "codex" ? next.codexAccountId ?? null : next.copilotAccountId ?? null;
  if (prevId === null || nextId === null) return false;
  return prevId !== nextId;
}

export function stickyPayload(previous: LimitsPayload | null, next: LimitsPayload): LimitsPayload {
  const claudeChanged = accountChanged(previous, next, "claude");
  const codexChanged = accountChanged(previous, next, "codex");
  const copilotChanged = accountChanged(previous, next, "copilot");
  return {
    claude: claudeChanged ? next.claude : (next.claude ?? previous?.claude ?? null),
    // A switch clears the prior account's values. Same-account refreshes may
    // retain the last snapshot while provenance explains its freshness.
    codex: codexChanged ? next.codex : (next.codex ?? previous?.codex ?? null),
    copilot: copilotChanged ? next.copilot : (next.copilot ?? previous?.copilot ?? null),
    claudeAccountId: next.claudeAccountId ?? previous?.claudeAccountId ?? null,
    codexAccountId: next.codexAccountId ?? previous?.codexAccountId ?? null,
    copilotAccountId: next.copilotAccountId ?? previous?.copilotAccountId ?? null,
    provenance: next.provenance,
    staleSince: next.staleSince ?? null,
  };
}

/** The Codex limits block doubles as the account switcher: the whole block is a
    button that opens the unified {@link AccountsPanel}, and the header carries the
    active account chip so "which account am I on" reads without a click. It
    renders even with no Codex numbers (a freshly switched account) so the entry
    point never disappears. */
/** Masks Codex values until the payload explicitly names the active account.
    A stale request can still complete, while its quota values stay detached from
    the visible account until a payload with the same identity arrives. */
export function codexLimitsForActiveAccount(payload: Pick<LimitsPayload, "codex" | "codexAccountId"> | null, activeAccountId: string): EngineLimits | null {
  if (!payload?.codex || !activeAccountId || payload.codexAccountId !== activeAccountId) return null;
  return payload.codex;
}

/** Engine-symmetric masking gate: the same account-ownership stamp check for
    either engine, so a stale limits response never renders one account's
    percentages under another account's label (Fable/Sol invariant 19). */
export function limitsForActiveAccount(limits: EngineLimits | null, payloadAccountId: string | null, activeAccountId: string): EngineLimits | null {
  if (!limits || !activeAccountId || payloadAccountId !== activeAccountId) return null;
  return limits;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** A single latest-request-wins limits channel. Abort improves resource use;
    the generation check also protects callers whose fetch implementation still
    resolves an aborted response. */
export function createLatestLimitsLoader(fetcher: Fetcher, onPayload: (payload: LimitsPayload) => void) {
  let generation = 0;
  let controller: AbortController | null = null;
  return {
    async load(): Promise<boolean> {
      controller?.abort();
      const requestGeneration = ++generation;
      controller = new AbortController();
      try {
        const response = await fetcher("/api/limits", { signal: controller.signal });
        if (!response.ok) return false;
        const payload = await response.json() as LimitsPayload;
        if (requestGeneration !== generation) return false;
        controller = null;
        onPayload(payload);
        return true;
      } catch {
        return false;
      }
    },
    dispose() {
      generation += 1;
      controller?.abort();
      controller = null;
    },
  };
}

/** Every window of a reading as the line's tooltip names it: "5h left 60% · Week left 90%". */
function quotaWindowsSummary(t: TFunction, quota: ReconciledQuota, accountLimits: EngineLimits | null): string {
  if (!accountLimits) return "";
  return [
    accountLimits.session ? `${windowLabel(t, "session", accountLimits.session.windowMinutes)} ${t("limits.left")} ${Math.round(100 - accountLimits.session.usedPercent)}%` : null,
    accountLimits.weekly ? `${windowLabel(t, "weekly", accountLimits.weekly.windowMinutes)} ${t("limits.left")} ${Math.round(100 - accountLimits.weekly.usedPercent)}%` : null,
    ...quota.tiers.map((tier) => `${t("limits.tierWeek", { tier: claudeTierDisplayName(tier.value.tier, tier.value.label) })} ${t("limits.left")} ${Math.round(100 - tier.value.usedPercent)}%`),
  ].filter(Boolean).join(" · ");
}

/** The compact footer's line for an account that is not the active one: its name,
    what is left of its tightest window and the bar of that share, from the
    reading its own account row carries. It has no burndown chart (the history
    belongs to the active account), so the whole line opens the accounts panel
    focused on it. */
function InactiveAccountLine({ account, engine, label, now, onOpen }: {
  account: AccountOption;
  engine: Engine;
  label: string;
  now: number;
  onOpen: (accountId: string) => void;
}) {
  const { locale, t } = useLocale();
  const tint = engineTintOf(engine);
  const quota = reconcileQuotaReadings(null, quotaReadingFromAccountLimits(account.limits), now);
  const accountLimits = quotaAsEngineLimits(quota);
  const effective = effectiveQuota(quota);
  const windows = quotaWindowsSummary(t, quota, accountLimits);
  const stale = accountLimits?.capturedAt && now - accountLimits.capturedAt > LIMITS_FRESHNESS_S ? fmtAge(accountLimits.capturedAt) : null;
  const staleReason = [fmtQuotaStaleHint(Boolean(effective?.stale), effective?.observedAt ?? null, locale), stale ? t("limits.stale", { stale }) : null].filter(Boolean).join(" · ");
  const anyStale = Boolean(quota.session?.stale || quota.weekly?.stale || quota.tiers.some((tier) => tier.stale));
  const summary = [label, account.label, account.plan, windows || t("limits.noDataYet"), staleReason].filter(Boolean).join(" · ");
  const color = effective ? barColor(effective.percent, tint.color) : tint.color;
  return (
    <div data-meter-line="" data-footer-account={account.id} data-footer-account-active="false" className={`flex h-[26px] items-center pl-[13px] pr-1.5 ${anyStale ? "opacity-60" : ""}`} onClick={() => onOpen(account.id)}>
      <button type="button" aria-haspopup="dialog" aria-label={t("accounts.triggerAria", { engine: `${label} · ${account.label}` })} title={summary} className={`flex h-[22px] min-w-0 items-center gap-1.5 rounded-[7px] px-1.5 text-left hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${effective ? "flex-1" : "flex-initial"}`} onClick={(event) => { event.stopPropagation(); onOpen(account.id); }}>
        <span data-meter-name="" className="min-w-0 truncate text-[11.5px] font-medium text-secondary">{account.label}</span>
        <span className="relative flex shrink-0">
          <EngineMark engine={engine} size={12} label={label} />
          {staleReason ? <span data-limits-stale-dot="" title={staleReason} className="absolute -right-[3px] -top-[3px] h-1.5 w-1.5 rounded-full bg-warning ring-1 ring-card" /> : null}
        </span>
      </button>
      {effective ? (
        <span className="flex h-[22px] shrink-0 cursor-pointer items-center gap-1.5 px-1.5">
          <span data-meter-value="" className="text-[11px] tabular-nums text-muted">{t("limits.left")} <span className="font-bold" style={{ color: effective.percent <= 30 ? color : "var(--color-primary)" }}>{Math.round(effective.percent)}%</span></span>
          <ReserveBar percent={effective.percent} color={color} />
        </span>
      ) : (
        <span data-limits-reason="" title={staleReason || undefined} className="min-w-0 flex-1 cursor-pointer truncate px-1.5 text-right text-[10px] text-muted">{t("limits.noDataYet")}</span>
      )}
    </div>
  );
}

/** One engine's limits block, doubling as its account switcher: the whole block
    is a button opening the unified {@link AccountsPanel} for that engine, and
    the header carries the active-account chip from the reconciled windows so
    "which account am I on, and how much is left" reads without a click. Renders
    even with no numbers (a freshly switched account) so the entry point never
    disappears — symmetric for Claude and Codex (Fable P9). */
function EngineLimitsBlock({
  engine,
  label,
  limits,
  payloadAccountId,
  now,
  receivedAt,
  provenance,
  onSwitched,
  density,
}: {
  density: SidebarFooterDensity;
  engine: Engine;
  label: string;
  limits: EngineLimits | null;
  payloadAccountId: string | null;
  now: number;
  receivedAt: number;
  provenance: LimitsProvenance;
  onSwitched: () => void;
}) {
  const { locale, t } = useLocale();
  const accounts = useEngineAccounts(engine);
  const [open, setOpen] = useState(false);
  const [chartOpen, setChartOpen] = useState(false);
  const [focusAccountId, setFocusAccountId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const chartTriggerRef = useRef<HTMLButtonElement>(null);
  const identityVersion = useRef(accounts.identityVersion);

  const close = () => {
    setOpen(false);
    setFocusAccountId(null);
    triggerRef.current?.focus();
  };

  // A tapped account badge (issue #229) asks this engine's panel to open focused
  // on one account. Desktop: this block is always mounted, so the window event
  // lands directly. Mobile: it mounts with the project drawer, so a request
  // dispatched a moment earlier is claimed from the retained pending slot here.
  useEffect(() => {
    const openFocused = (accountId: string) => {
      setChartOpen(false);
      setFocusAccountId(accountId);
      setOpen(true);
    };
    const pending = consumePendingAccountPanel(engine);
    if (pending) openFocused(pending.accountId);
    return onAccountPanelRequest((request) => {
      if (request.engine === engine) openFocused(request.accountId);
    });
  }, [engine]);

  const openOn = (accountId: string) => {
    setChartOpen(false);
    setFocusAccountId(accountId);
    setOpen(true);
  };

  const closeChart = () => {
    setChartOpen(false);
    chartTriggerRef.current?.focus();
  };

  // Outside-pointer close only. Escape is owned by the panel's dialog subtree
  // (see AccountsPanel / handleOverlayEscape): routing it through a second
  // window listener here would race the project drawer's window Escape handler,
  // so one press would close both the sheet and the drawer beneath it.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  // Outside-pointer close only. Escape is owned by the chart's own dialog subtree
  // (BurndownPanel routes it through handleOverlayEscape), so it never races the
  // project drawer's window Escape handler — one press closes only the chart.
  // The panel renders inside containerRef, so clicks inside it are "contained"
  // and never self-close it.
  useEffect(() => {
    if (!chartOpen) return;
    const onDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setChartOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [chartOpen]);

  // Every mounted account surface of this engine shares one store. A version
  // bump arrives for both the compact Switchboard selector and the footer panel,
  // including the post-mutation confirmation that can follow an optimistic switch.
  useEffect(() => {
    if (identityVersion.current === accounts.identityVersion) return;
    identityVersion.current = accounts.identityVersion;
    onSwitched();
  }, [accounts.identityVersion, onSwitched]);

  // A per-card re-read or a redeemed reset credit (#1418, #1373) produced a
  // newer reading than this block's own payload; the route dropped the
  // server-side cache for that account, so one reload brings the footer level
  // with the card instead of waiting out the poll.
  const limitsVersion = useRef(accounts.limitsVersion);
  useEffect(() => {
    if (limitsVersion.current === accounts.limitsVersion) return;
    limitsVersion.current = accounts.limitsVersion;
    onSwitched();
  }, [accounts.limitsVersion, onSwitched]);

  if (!accountEntryPointVisible(Boolean(limits), accounts.status)) return null;

  const tint = engineTintOf(engine);
  const payloadLimits = limitsForActiveAccount(limits, payloadAccountId, accounts.active);
  const identityPending = Boolean(limits && payloadLimits === null);
  const activeAccount = accounts.accounts.find((account) => account.id === accounts.active);
  const quota = reconcileQuotaReadings(
    quotaReadingFromEngineLimits(payloadLimits, provenance, receivedAt),
    quotaReadingFromAccountLimits(activeAccount?.limits),
    now,
  );
  const accountLimits = quotaAsEngineLimits(quota);
  const hasWindows = Boolean(accountLimits && (accountLimits.session || accountLimits.weekly || accountLimits.tiers?.length));
  const stale = accountLimits?.capturedAt && now - accountLimits.capturedAt > LIMITS_FRESHNESS_S ? fmtAge(accountLimits.capturedAt) : null;
  const activeLabel = activeAccount?.label ?? t("accounts.trigger");
  const effective = effectiveQuota(quota);
  const effectiveStaleHint = fmtQuotaStaleHint(Boolean(effective?.stale), effective?.observedAt ?? null, locale);
  const anyStale = Boolean(quota.session?.stale || quota.weekly?.stale || quota.tiers.some((tier) => tier.stale));
  const draining = accounts.migration?.state === "draining";
  const failureReason = fmtLimitsFailureReason(provenance, locale);
  const visibleFailureReason = accounts.status === "loading" || identityPending ? null : failureReason;

  const windows = quotaWindowsSummary(t, quota, accountLimits);
  /* Why the line is dimmed or carries the amber dot: an old reading, or a read that failed. */
  const staleReason = [effectiveStaleHint, stale ? t("limits.stale", { stale }) : null, visibleFailureReason].filter(Boolean).join(" · ");
  const summary = [label, activeLabel, accountLimits?.plan, windows || (visibleFailureReason ? null : accounts.status === "loading" || identityPending ? t("limits.accountLoading") : t("limits.noDataYet")), staleReason].filter(Boolean).join(" · ");
  /* The line says what is left of the tightest window, and the bar draws that same share. */
  const left = effective ? effective.percent : null;
  const color = effective ? barColor(effective.percent, tint.color) : tint.color;
  /* The compact footer names every account of the engine, one line each, in the order the account list
     holds them; the active one stands in its place. "All windows" keeps the active account alone. */
  const otherAccounts = density === "line" ? accounts.accounts.filter((account) => account.id !== accounts.active) : [];
  const listsActive = accounts.accounts.some((account) => account.id === accounts.active);
  const several = otherAccounts.length > 0;
  const inactiveLine = (account: AccountOption) => <InactiveAccountLine key={account.id} account={account} engine={engine} label={label} now={now} onOpen={openOn} />;
  const activeLine = (
      <div data-meter-line="" data-footer-account={accounts.active} data-footer-account-active="true" className={`flex h-[26px] items-center pl-[13px] pr-1.5 ${anyStale ? "opacity-60" : ""}`}>
        <button ref={triggerRef} type="button" aria-expanded={open} aria-haspopup="dialog" aria-current={several ? "true" : undefined} aria-label={t("accounts.triggerAria", { engine: label })} title={summary} className={`flex h-[22px] min-w-0 items-center gap-1.5 rounded-[7px] px-1.5 text-left hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${hasWindows && effective ? "flex-1" : "flex-initial"}`} onClick={() => { setChartOpen(false); setFocusAccountId(null); setOpen((value) => !value); }}>
          {/* The account starts on the edge every name in the sidebar starts on, and the mark that names
              the engine follows it, as an icon follows its word in the list above. The amber dot
              stands on the mark's corner, where it takes no width from the name. */}
          <span data-meter-name="" className="min-w-0 truncate text-[11.5px] font-semibold text-primary">{activeLabel}</span>
          <span className="relative flex shrink-0">
            <EngineMark engine={engine} size={12} label={label} />
            {staleReason ? <span data-limits-stale-dot="" title={staleReason} className="absolute -right-[3px] -top-[3px] h-1.5 w-1.5 rounded-full bg-warning ring-1 ring-card" /> : null}
          </span>
          {draining ? <Loader2 className="h-3 w-3 shrink-0 animate-spin text-accent motion-reduce:animate-none" aria-hidden /> : null}
        </button>
        {hasWindows && effective ? (
          <button ref={chartTriggerRef} type="button" aria-expanded={chartOpen} aria-haspopup="dialog" aria-label={t("burndown.openAria", { engine: label })} title={windows} className="flex h-[22px] shrink-0 items-center gap-1.5 rounded-[7px] px-1.5 hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" onClick={() => { setOpen(false); setChartOpen((value) => !value); }}>
            <span data-meter-value="" className="text-[11px] tabular-nums text-muted">{t("limits.left")} <span className="font-bold" style={{ color: effective.percent <= 30 ? color : "var(--color-primary)" }}>{Math.round(effective.percent)}%</span></span>
            <ReserveBar percent={left} color={color} />
          </button>
        ) : (
          /* The reason takes what the account's name leaves: the name is never cut to make room for it. */
          <span data-limits-reason="" title={staleReason || undefined} className="min-w-0 flex-1 truncate px-1.5 text-right text-[10px] text-muted">{visibleFailureReason ?? (accounts.status === "loading" || identityPending ? "…" : t("limits.noDataYet"))}</span>
        )}
      </div>
  );
  return (
    <div ref={containerRef} className="relative" data-engine-limits={engine}>
      {several && listsActive
        ? accounts.accounts.map((account) => account.id === accounts.active ? <Fragment key={account.id}>{activeLine}</Fragment> : inactiveLine(account))
        : <>{activeLine}{otherAccounts.map(inactiveLine)}</>}
      {/* Behind "All windows" a failed read says why in full, under its account. */}
      {density === "detail" && visibleFailureReason ? (
        <div className={`${LINE_EDGE} -mt-0.5 pb-1 ${anyStale ? "opacity-60" : ""}`}>
          <span data-meter-note="" className="block break-words text-[10px] leading-[13px] text-muted">{visibleFailureReason}</span>
        </div>
      ) : null}
      {density === "detail" && hasWindows ? (
        /* Behind "All windows": the plan, then every window with its reset, on the edge the account starts on. */
        <div data-limits-windows="" className={`${LINE_EDGE} pb-1 ${anyStale ? "opacity-60" : ""}`}>
          {accountLimits?.plan ? <span data-meter-note="" className="-mt-0.5 block truncate pb-0.5 text-[10px] leading-[13px] text-muted">{label} · {accountLimits.plan}</span> : null}
          <LimitWindowLine label={windowLabel(t, "session", accountLimits!.session?.windowMinutes)} window={accountLimits!.session} engineColor={tint.color} now={now} staleHint={fmtQuotaStaleHint(Boolean(quota.session?.stale), quota.session?.observedAt ?? null, locale)} />
          <LimitWindowLine label={windowLabel(t, "weekly", accountLimits!.weekly?.windowMinutes)} window={accountLimits!.weekly} engineColor={tint.color} now={now} staleHint={fmtQuotaStaleHint(Boolean(quota.weekly?.stale), quota.weekly?.observedAt ?? null, locale)} />
          {quota.tiers.map((tier) => (
            <LimitWindowLine key={tier.value.tier} label={t("limits.tierWeek", { tier: claudeTierDisplayName(tier.value.tier, tier.value.label) })} window={tier.value} engineColor={tint.color} now={now} staleHint={fmtQuotaStaleHint(tier.stale, tier.observedAt, locale)} />
          ))}
        </div>
      ) : null}
      {open ? <AccountsPanel state={accounts} onClose={close} focusAccountId={focusAccountId} quotaOverride={{ accountId: accounts.active, quota, now }} /> : null}
      {chartOpen ? <BurndownPanel key={accounts.active} engine={engine} label={label} plan={accountLimits?.plan ?? null} activeAccountId={accounts.active} onClose={closeChart} /> : null}
    </div>
  );
}

/** Sidebar footer: Claude and Codex plan limits (5h session + weekly). Each
    block is also that engine's account switcher (see {@link EngineLimitsBlock}). */
export function LimitsFooter({ density }: { density: SidebarFooterDensity }) {
  const [snap, setSnap] = useState<{ data: LimitsPayload; at: number } | null>(null);
  const [now, setNow] = useState(() => Date.now() / 1000);
  /* A switch busts the account-keyed server cache and immediately schedules a
     fresh read through this ref. */
  const loadRef = useRef<() => Promise<void>>(async () => {});
  const invalidateLimits = useCallback(() => void loadRef.current(), []);

  useEffect(() => {
    let active = true;
    const loader = createLatestLimitsLoader(fetch, (json) => {
      setSnap((prev) => ({ data: stickyPayload(prev?.data ?? null, json), at: Date.now() / 1000 }));
    });
    const load = async () => {
      await loader.load();
      if (active) setNow(Date.now() / 1000);
    };
    loadRef.current = load;
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      active = false;
      clearInterval(t);
      loader.dispose();
      loadRef.current = async () => {};
    };
  }, []);

  // Each engine's account list governs its switcher visibility. Both remain
  // mounted through empty limits, initial loading, and account refresh failures.
  return (
    <div className="shrink-0 border-t border-border py-0.5 empty:hidden">
      <EngineLimitsBlock engine="claude" label="Claude" limits={snap?.data.claude ?? null} payloadAccountId={snap?.data.claudeAccountId ?? null} now={now} receivedAt={snap?.at ?? now} provenance={snap?.data.provenance.claude ?? { source: "unavailable", reason: null, staleSince: null }} onSwitched={invalidateLimits} density={density} />
      <EngineLimitsBlock engine="codex" label="Codex" limits={snap?.data.codex ?? null} payloadAccountId={snap?.data.codexAccountId ?? null} now={now} receivedAt={snap?.at ?? now} provenance={snap?.data.provenance.codex ?? { source: "unavailable", reason: null, staleSince: null }} onSwitched={invalidateLimits} density={density} />
      {/* GitHub Copilot accounts and their monthly transcript quota. */}
      <CopilotFooterRow
        limits={snap?.data.copilot ?? null}
        limitsAccountId={snap?.data.copilotAccountId ?? null}
        now={now}
        onChanged={invalidateLimits}
        density={density}
      />
      {/* The personal Telegram connector row (issue #1059) sits beside the
          account controls; the entry point never disappears. */}
      <TelegramFooterRow density={density} />
    </div>
  );
}
