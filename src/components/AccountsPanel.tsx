"use client";

import { Plus } from "lucide-react";
import { createContext, forwardRef, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  accountNoticeText,
  claudeLoginErrorText,
  NONTERMINAL_CLAUDE_LOGIN_PHASES,
  useEngineAccounts,
  type AccountOperation,
  type AccountAuthHealth,
  type AccountOption,
  type DeviceAuth,
  type EngineAccountsState,
} from "@/hooks/useEngineAccounts";
import { consumePendingAccountPanel, onAccountPanelRequest } from "@/lib/accounts/openPanel";
import { claudeTierDisplayName } from "@/lib/agent/models";
import { type TFunction, useLocale } from "@/lib/i18n";
import { handleOverlayEscape } from "@/lib/overlay";
import { quotaReadingFromAccountLimits, reconcileQuotaReadings, type ReconciledQuota, type ReconciledQuotaWindow } from "@/lib/rateLimit";
import { tierWindowKey, type TierWindowKey } from "@/lib/types";
import { useIsMobile } from "@/hooks/useIsMobile";

import { AccountRowOpening } from "./AccountRowOpening";
import { AccountSpendCredits, paidSpendingActive, showsCreditsBlock } from "./AccountSpendCredits";
import { AccountRemovalRefusal, liveWorkHref, refusalText } from "./AccountRemovalRefusal";
import { AccountCleanupFailed, AccountCleanupResult, AccountRemovalSummary, ArchivePath, HiddenAccountOffer } from "./AccountRemovalSummary";
import { AccountStatusDot, type AccountDotTone } from "./AccountStatusDot";
import { ChevronDown, ChevronRight, Loader2, PencilLine, RotateCw, SquareTerminal, Trash2, X, Zap } from "./icons";
import { AccountRowsSkeleton } from "./skeletons";
import { receipts as tabReceipts, type ReceiptStore } from "./mobile/MobileReceipt";
import { formatCheckedClock, formatQuotaAsOf, formatResetClock, windowLabel } from "./rateLimit";
import { engineTintOf } from "./utils";
import { Z } from "@/components/layers";
import { TransferAccountsChecklist, useImportedAccounts } from "./TransferAccountsChecklist";

const AUTH_HEALTH_KEY = {
  authenticated: "accounts.auth.authenticated",
  signed_out: "accounts.auth.signedOut",
  unknown: "accounts.auth.unknown",
  error: "accounts.auth.error",
} as const satisfies Record<AccountAuthHealth, Parameters<TFunction>[0]>;

function engineDisplay(engine: "claude" | "codex"): string {
  return engine === "claude" ? "Claude" : "Codex";
}

function accountQuota(account: AccountOption, now: number) {
  return reconcileQuotaReadings(null, quotaReadingFromAccountLimits(account.limits), now);
}

type LimitRowKey = "session" | "weekly" | TierWindowKey;

/** The windows an account reports, in the order every surface lists them:
    session, week, then one row per model tier the provider meters for this
    account (#1358, #1796) — Fable and Opus each answer for themselves. Each
    row carries the label its horizon earns. */
type LimitRow = { key: LimitRowKey; label: string; window: ReconciledQuotaWindow };

export function limitRows(quota: ReconciledQuota, t: TFunction): LimitRow[] {
  const candidates: { key: LimitRowKey; label: string; window: ReconciledQuotaWindow | null }[] = [
    { key: "session", label: windowLabel(t, "session", quota.session?.value.windowMinutes), window: quota.session },
    { key: "weekly", label: windowLabel(t, "weekly", quota.weekly?.value.windowMinutes), window: quota.weekly },
    ...quota.tiers.map((tier) => ({
      key: tierWindowKey(tier.value.tier),
      label: t("limits.tierWeek", { tier: claudeTierDisplayName(tier.value.tier, tier.value.label) }),
      window: tier as ReconciledQuotaWindow,
    })),
  ];
  return candidates.filter((row): row is LimitRow => row.window != null);
}

type RowState = "active" | "needsLogin" | "error" | "pending" | "idle";

function authHealth(account: AccountOption): AccountAuthHealth {
  if (account.provider && (!account.authPresent || account.authHealth === "signed_out")) return "error";
  return account.authHealth ?? (account.authPresent ? "unknown" : "signed_out");
}

function rowState(account: AccountOption, activeId: string): RowState {
  if (account.loginPending) return "pending";
  if (account.provider && authHealth(account) === "error") return "error";
  if (!account.authPresent || authHealth(account) === "signed_out") return "needsLogin";
  if (account.id === activeId) return "active";
  return "idle";
}

/* ────────────────────────────────────────────────────────────────────────── *
 * The account row — one component for the dialog and the phone's screen      *
 * ────────────────────────────────────────────────────────────────────────── */

/*
 * Every window an account reports stays on its row, one line each: label, bar,
 * whole percent, reset moment. The panel's caption names the columns, so no
 * line repeats a word. A press on the row opens it, in place, and changes
 * nothing else; making the account the default is its own control inside the
 * open row. The status is a dot with a short popover (AccountStatusDot).
 * One open row per panel; the state lives in the surface that lists the rows.
 */

const PhoneContext = createContext(false);

/** Sizes: the panel's on the desktop, 44 px targets and the phone's type on the phone screen. The name's line fills the head exactly, so a second line of a long name keeps the gap one line has. */
const DESK = {
  name: "text-[13px] leading-4",
  line: "text-[11px] leading-snug",
  /* The name's left edge: 4 px of the row, the 26 px dot and its 4 px gap. */
  indent: "pl-[34px] pr-3.5",
  action: "min-h-6 text-[11px]",
  endLine: "last:-mb-[5px]",
  icon: "h-6 w-6 mt-px",
  nudge: "mt-px",
  number: "w-[32px]",
  meter: "w-12",
  column: (wide: boolean) => (wide ? "w-[92px]" : "w-[52px]"),
  edge: "-mr-1.5",
  below: "pb-[5px]",
  head: "gap-1 pl-[4px] pr-2",
  toggle: "py-[5px]",
  credits: "last:-mb-[2px]",
  rowPad: "py-1",
  gap: "mt-2",
  tail: "-ml-1 -mr-1.5 w-6",
  chevron: "h-4 w-4",
};
const PHONE: typeof DESK = {
  name: "text-body leading-5",
  line: "text-[12px] leading-snug",
  indent: "pl-11 pr-3.5",
  action: "min-h-11 text-[12px]",
  endLine: "last:-mb-3",
  icon: "h-11 w-11",
  nudge: "",
  number: "w-[36px]",
  meter: "w-10",
  column: (wide: boolean) => (wide ? "w-[104px]" : "w-[58px]"),
  edge: "",
  below: "-mt-2 pb-3",
  head: "gap-0 pl-0 pr-0",
  toggle: "py-3",
  credits: "last:-mb-3",
  rowPad: "py-0.5",
  gap: "mt-1.5",
  tail: "-ml-2 -mr-3.5 w-11",
  chevron: "h-4 w-4 -translate-x-0.5",
};

function useSizes(): typeof DESK {
  return useContext(PhoneContext) ? PHONE : DESK;
}

const ACTION_BASE = "inline-flex shrink-0 items-center gap-1 rounded-[6px] px-1.5 font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40";
const quietAction = (s: typeof DESK) => `${ACTION_BASE} ${s.action} text-secondary hover:bg-canvas hover:text-primary`;
const accentAction = (s: typeof DESK) => `${ACTION_BASE} ${s.action} text-accent hover:bg-canvas`;

/** The track is the muted ink at low strength, so it stays visible on the row and on either active wash. */
const TRACK: React.CSSProperties = { backgroundColor: "color-mix(in srgb, var(--color-muted) 30%, transparent)" };

/** One colour rule, read from the number alone: the engine tint with headroom, amber at 30% or less, red at 10% or less. Whether credits carry the account is the credits line's to say. */
function limitInk(left: number, engine: "claude" | "codex"): string {
  if (left <= 10) return "var(--color-danger)";
  if (left <= 30) return "var(--color-warning)";
  return engineTintOf(engine).color;
}
const numberInk = (left: number) => (left > 30 ? "var(--color-primary)" : left <= 10 ? "var(--color-danger)" : "var(--color-warning)");

function Meter({ left, engine, className }: { left: number; engine: "claude" | "codex"; className: string }) {
  return (
    <span aria-hidden className={`block h-1.5 shrink-0 overflow-hidden rounded-full ${className}`} style={TRACK}>
      {/* Square at its end, clipped by the track: a small amount reads as a level in a bar. */}
      <span data-meter-fill={left} data-meter-tone={left <= 10 ? "danger" : left <= 30 ? "warning" : "engine"} className="block h-full" style={{ width: left > 0 ? `max(2px, ${left}%)` : 0, backgroundColor: limitInk(left, engine) }} />
    </span>
  );
}

/** What a row says about itself, read once: the window lines, the notes, the credits, the tools. */
type RowFacts = ReturnType<typeof factsOf>;

function factsOf(account: AccountOption, engine: "claude" | "codex", activeId: string, quota: ReconciledQuota, now: number, t: TFunction) {
  const windows = limitRows(quota, t);
  const exhausted = windows.filter((row) => row.window.value.usedPercent >= 100);
  const resets = exhausted.map((row) => row.window.value.resetsAt);
  const until = exhausted.length > 0 && resets.every((value): value is number => value !== null && value > now) ? Math.max(...resets) : null;
  const observed = windows.map((row) => row.window.observedAt).filter((value): value is number => value !== null);
  const status = mobileAccountState(account, activeId);
  const paid = paidSpendingActive(account);
  const checked = observed.length ? formatCheckedClock(new Date(Math.min(...observed) * 1000).toISOString()) : null;
  return {
    status, windows, exhausted, until, paid, checked,
    /* The moment a row note names: the window lines leave it out. */
    noteUntil: paid ? null : until,
    stale: windows.some((row) => row.window.stale),
    observedAt: observed.length ? Math.min(...observed) : null,
    health: authHealth(account),
    usable: account.authPresent && status !== "needsSignIn" && status !== "error" && status !== "pending",
    resets: engine === "codex" ? account.resetCredits ?? null : null,
    credits: engine === "codex" && showsCreditsBlock(account, quota),
  };
}

/** Every window of the row on one line. A moment an earlier line or the limit note already named is not said again. */
function WindowLines({ account, facts, now, engine, wide }: { account: AccountOption; facts: RowFacts; now: number; engine: "claude" | "codex"; wide: boolean }) {
  const { t } = useLocale();
  const s = useSizes();
  if (facts.windows.length === 0) return null;
  const named = new Set<number | null>([facts.noteUntil]);
  return (
    <dl data-account-limits={account.id} aria-label={t("accounts.limitsAria", { label: account.label })} className="flex flex-col gap-0.5">
      {facts.windows.map(({ key, label, window }) => {
        const resetsAt = window.value.resetsAt;
        const said = resetsAt !== null && !named.has(resetsAt);
        named.add(resetsAt);
        const left = Math.round(Math.max(0, Math.min(100, 100 - window.value.usedPercent)));
        return (
          <div key={key} data-limit-row={key} data-account-line className={`flex items-center gap-2 ${s.line} text-muted ${window.stale ? "opacity-70" : ""}`}>
            <dt className={`${s.column(wide)} shrink-0 font-semibold text-secondary`}>{label}</dt>
            <dd className="flex min-w-0 flex-1 items-center gap-2">
              <Meter left={left} engine={engine} className={s.meter} />
              <span data-limit-number className={`${s.number} shrink-0 text-right font-bold tabular-nums`} style={{ color: numberInk(left) }} aria-label={t("mobile2.accounts.cornerAria", { left, window: label })}>{left}%</span>
              {said ? <span data-limit-reset className="min-w-0 whitespace-nowrap">{formatResetClock(resetsAt, now)}</span> : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** What the row says at rest besides its name and numbers: one fact per line, and only when there is something to act on or to know. */
function RowNotes({ account, facts, now }: { account: AccountOption; facts: RowFacts; now: number }) {
  const { t } = useLocale();
  const s = useSizes();
  const lines: { key: string; ink: string; text: string }[] = [];
  if (facts.exhausted.length > 0) {
    lines.push(facts.paid
      ? { key: "past", ink: "font-semibold text-secondary", text: t("accounts.pastLimitOnPaid") }
      : { key: "limit", ink: "font-semibold text-danger", text: facts.until === null ? t("rateLimit.badge") : t("rateLimit.badgeUntil", { time: formatResetClock(facts.until, now) }) });
  }
  if (facts.stale) lines.push({ key: "stale", ink: "text-muted", text: formatQuotaAsOf(facts.observedAt) ?? t("accounts.limitsStale") });
  if (account.provider && facts.status !== "error") lines.push({ key: "provider", ink: "text-muted", text: t("accounts.provider.limitsUnknown") });
  return <>{lines.map((line) => <p key={line.key} data-account-note={line.key} data-account-line className={`break-words ${s.line} ${line.ink}`}>{line.text.charAt(0).toUpperCase() + line.text.slice(1)}</p>)}</>;
}

/** The reset a row can use, beside the limit it remedies. Named once, with its way out. */
function ResetLine({ account, state, facts, now, receipts }: { account: AccountOption; state: EngineAccountsState; facts: RowFacts; now: number; receipts?: ReceiptStore }) {
  const { t } = useLocale();
  const s = useSizes();
  const resets = facts.resets;
  if (!resets || resets.availableCount === 0) return null;
  const busy = state.limitsBusy?.accountId === account.id;
  const redeeming = busy && state.limitsBusy?.operation === "resetCredit";
  return (
    <div data-account-reset-credits={account.id} data-account-line className={`flex flex-wrap items-center gap-x-2 ${s.line} ${s.endLine}`}>
      <span className="flex min-w-0 flex-1 flex-wrap gap-x-1.5 font-semibold text-primary">
        {t("accounts.resetsAvailable", { count: resets.availableCount })}
        {resets.expiresAt !== null ? <span className="whitespace-nowrap font-normal text-muted">{t("accounts.resetsExpire", { at: formatResetClock(resets.expiresAt, now) })}</span> : null}
      </span>
      <button
        type="button"
        data-account-use-reset={account.id}
        aria-label={t("accounts.useResetAria", { label: account.label })}
        aria-busy={redeeming || undefined}
        disabled={state.mutation !== null || busy || !account.authPresent}
        onClick={() => void state.useResetCredit(account.id).then((ok) => { if (ok) receipts?.show(t("mobile2.accounts.resetUsed", { label: account.label })); })}
        className={`${accentAction(s)} ${s.edge}`}
      >
        {redeeming ? <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden /> : <Zap className="h-3 w-3" aria-hidden />}
        {t("accounts.useReset")}
      </button>
    </div>
  );
}

/** A reset count with nothing to do about it: a muted fact, in the open row. */
function NoResetsFact({ account, facts }: { account: AccountOption; facts: RowFacts }) {
  const { t } = useLocale();
  const s = useSizes();
  if (facts.resets && facts.resets.availableCount > 0) return null;
  return <p data-account-reset-credits={account.id} data-account-line className={`${s.line} text-muted`}>{t(facts.resets ? "accounts.resetsNone" : "accounts.resetsUnknown")}</p>;
}

/** When the numbers were read, and the way to read them again. */
function RefreshLine({ account, state, facts, receipts }: { account: AccountOption; state: EngineAccountsState; facts: RowFacts; receipts?: ReceiptStore }) {
  const { t } = useLocale();
  const s = useSizes();
  const busy = state.limitsBusy?.accountId === account.id;
  const refreshing = busy && state.limitsBusy?.operation === "refreshLimits";
  return (
    <div data-account-line className={`flex items-center gap-2 ${s.line} text-muted ${s.endLine}`}>
      <span className="min-w-0 flex-1 break-words">{facts.checked ? `${t("accounts.limitsChecked")} · ${facts.checked}` : t("limits.noDataYet")}</span>
      <button
        type="button"
        data-account-refresh-limits={account.id}
        aria-label={t("accounts.refreshLimitsAria", { label: account.label })}
        aria-busy={refreshing || undefined}
        disabled={state.mutation !== null || busy || !account.authPresent}
        onClick={() => void state.refreshLimits(account.id).then((ok) => { if (ok) receipts?.show(t("mobile2.accounts.refreshed", { label: account.label })); })}
        className={`${quietAction(s)} ${s.edge}`}
      >
        {refreshing ? <Loader2 className="h-3 w-3 animate-spin text-accent motion-reduce:animate-none" aria-hidden /> : <RotateCw className="h-3 w-3 text-muted" aria-hidden />}
        {t("accounts.refreshLimits")}
      </button>
    </div>
  );
}

/** The device sign-in a Codex row in flight shows: the verification link, its code and Cancel. Claude's login row carries its own. */
function DeviceSignInLine({ account, deviceAuth, onCancel }: { account: AccountOption; deviceAuth: DeviceAuth; onCancel: () => void }) {
  const { t } = useLocale();
  const s = useSizes();
  return (
    <div data-account-signin={account.id} data-account-line className={`flex items-center gap-x-2 ${s.line} text-muted ${s.endLine}`}>
      <a href={deviceAuth.url} target="_blank" rel="noreferrer noopener" className={`inline-flex items-center whitespace-nowrap font-semibold text-accent underline ${s.action}`}>{t("accounts.openLogin")}</a>
      <code className="select-all whitespace-nowrap font-mono font-semibold text-primary">{deviceAuth.code}</code>
      <button type="button" data-account-signin-cancel={account.id} onClick={onCancel} className={`${quietAction(s)} ml-auto ${s.edge}`}>{t("mobile2.accounts.cancelSignIn")}</button>
    </div>
  );
}

/** The sign-in a row can start: Claude restarts its login in place for any
    account, and Codex runs its device login for any account, Main included
    (#2166): signing in the account you have never asks for a second one. */
function SignInButton({ account, onStart, disabled }: { account: AccountOption; onStart: () => void; disabled: boolean }) {
  const { t } = useLocale();
  const s = useSizes();
  return (
    <button
      type="button"
      data-account-signin-start={account.id}
      aria-label={t("mobile2.accounts.signInAria", { label: account.label })}
      disabled={disabled}
      onClick={onStart}
      className={`${accentAction(s)} ${s.nudge}`}
    >
      {t("accounts.claudeLogin.signIn")}
    </button>
  );
}

/** How long an armed removal waits for its confirm before it disarms. */
const REMOVE_ARM_MS = 10_000;

/** Removal moves the home into the shared archive (Main is only hidden, its
    folder untouched), so the first press arms it and only a second, explicit
    confirm runs it. Escape or ten quiet seconds disarm it. */
function useRemoval(onRemove: () => void) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return undefined;
    const timer = setTimeout(() => setArmed(false), REMOVE_ARM_MS);
    return () => clearTimeout(timer);
  }, [armed]);
  return { armed, arm: () => setArmed(true), disarm: () => setArmed(false), run: () => { setArmed(false); onRemove(); } };
}

function RemoveConfirm({ account, removal, disabled }: { account: AccountOption; removal: ReturnType<typeof useRemoval>; disabled: boolean }) {
  const { t } = useLocale();
  const s = useSizes();
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => { confirm.current?.focus(); }, []);
  const text = t(account.kind === "legacy" ? "accounts.removeConfirmLegacy" : "accounts.removeConfirm", { label: account.label });
  // Only the question is strong; what follows it is plain text.
  const end = text.indexOf("? ");
  return (
    <div
      data-account-remove-armed={account.id}
      data-account-line
      className={`flex flex-col ${s.gap}`}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        event.preventDefault();
        removal.disarm();
      }}
    >
      <p className={`break-words ${s.line} text-muted`}>
        <span className="font-semibold text-primary">{end < 0 ? text : text.slice(0, end + 1)}</span>
        {end < 0 ? null : ` ${text.slice(end + 2)}`}
      </p>
      <div className={`flex justify-end gap-x-1 ${s.endLine}`}>
        <button type="button" disabled={disabled} onClick={removal.disarm} className={quietAction(s)}>{t("accounts.removeConfirmCancel")}</button>
        <button ref={confirm} type="button" data-account-remove-confirm={account.id} disabled={disabled} onClick={removal.run} className={`${ACTION_BASE} ${s.action} ${s.edge} text-danger hover:bg-danger-soft`}>{t("accounts.removeConfirmCta")}</button>
      </div>
    </div>
  );
}

/** Why a removal did not happen, as the row's own lines: the product's words and links, without a block around them. */
function RowRefusal({ account, state, engine, phone }: { account: AccountOption; state: EngineAccountsState; engine: "claude" | "codex"; phone: boolean }) {
  const { t } = useLocale();
  const s = useSizes();
  const line = useRef<HTMLDivElement>(null);
  const removal = state.removal;
  const refusal = removal?.kind === "refused" && removal.refusal.accountId === account.id ? removal.refusal : null;
  useEffect(() => { line.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" }); }, [refusal]);
  if (!refusal) return null;
  const sessions = refusal.sessions ?? [];
  const more = (refusal.sessionCount ?? sessions.length) - sessions.length;
  /* An open sign-in is ended from the refusal itself: Claude cancels its
     operation, Codex its device login. */
  const operationId = account.login?.operationId ?? null;
  const action = refusal.reasons.includes("removal_failed")
    ? { label: t("accounts.refusal.retry"), run: () => void state.remove(account.id) }
    : refusal.reasons.includes("no_answer")
      ? { label: t("accounts.refusal.refresh"), run: () => void state.refresh() }
      : refusal.reasons.includes("login_pending")
        ? engine === "codex"
          ? { label: t("accounts.refusal.cancelSignIn"), run: () => void cancelCodexDeviceSignIn(state, account.id) }
          : operationId ? { label: t("accounts.refusal.cancelSignIn"), run: () => void state.cancelLogin(operationId) } : null
        : null;
  return (
    <div ref={line} role="alert" data-account-refusal={refusal.accountId} data-account-line className={`flex flex-col gap-0.5 ${s.line} ${s.gap}`}>
      {refusal.reasons.map((reason) => (
        <div key={reason} data-account-refusal-reason={reason} className="flex min-w-0 flex-col gap-0.5">
          <p className="break-words text-danger">{refusalText(t, refusal, reason)}</p>
          {reason === "archive_unavailable" ? (
            <>
              {refusal.archive ? <ArchivePath path={refusal.archive} copyLabel={t("accounts.refusal.copyPath")} phone={phone} /> : null}
              <p className="text-muted">{t("accounts.refusal.archive_unavailableAfter")}</p>
            </>
          ) : null}
        </div>
      ))}
      {sessions.length ? <p data-account-refusal-sessions className="text-muted">{t("accounts.refusal.sessionsLead")}</p> : null}
      <div className={`flex flex-wrap items-center gap-x-3 ${s.endLine}`}>
        {sessions.map((work) => {
          const href = liveWorkHref(work);
          const name = work.title ?? work.path?.split("/").filter(Boolean).at(-1) ?? work.conversationId ?? "";
          return href
            ? <a key={href} href={href} data-account-refusal-session={work.conversationId ?? work.path ?? ""} title={name} className={`inline-flex min-w-0 items-center font-semibold text-accent underline underline-offset-2 ${s.action}`}><span className="break-words">{name}</span></a>
            : <span key={name} className="break-words text-muted">{name}</span>;
        })}
        {action ? <button type="button" disabled={state.mutation !== null} onClick={action.run} className={`${accentAction(s)} -ml-1.5`}>{action.label}</button> : null}
        <button type="button" data-account-refusal-close aria-label={t("accounts.refusal.dismiss")} onClick={state.dismissRemoval} className={`${quietAction(s)} ml-auto ${s.edge}`}>{t("common.close")}</button>
      </div>
      {more > 0 ? <p className="text-muted">{t("accounts.refusal.sessionsMore", { count: more })}</p> : null}
    </div>
  );
}

/** The row's own actions as one quiet line, each an icon and its word. The provider's editor keeps Remove's line. */
function ToolActions({ account, state, facts, removal, onProvider }: { account: AccountOption; state: EngineAccountsState; facts: RowFacts; removal: ReturnType<typeof useRemoval>; onProvider: () => void }) {
  const { t } = useLocale();
  const s = useSizes();
  return (
    <div data-account-line className={`-ml-1.5 flex flex-wrap items-center gap-x-1 ${s.endLine}`}>
      {/* Copies the account-bound CLI command — tmux/terminals live on the
          operator's machine, so the panel hands over the command, always. */}
      {facts.usable ? (
        <button
          type="button"
          data-account-copy-cli={account.id}
          aria-label={t("accounts.copyCliAria", { label: account.label })}
          disabled={state.mutation !== null}
          onClick={() => void state.copyTerminalCommand(account.id)}
          className={quietAction(s)}
        >
          <SquareTerminal className="h-3.5 w-3.5 text-muted" aria-hidden />
          {t("accounts.copyCli")}
        </button>
      ) : null}
      <span className="flex flex-1 items-center gap-1 whitespace-nowrap">
        {account.provider ? (
          <button type="button" data-account-provider-edit={account.id} onClick={onProvider} className={quietAction(s)}>
            <PencilLine className="h-3.5 w-3.5 text-muted" aria-hidden />
            {t("accounts.provider.edit")}
          </button>
        ) : null}
        {state.removing === account.id ? (
          <span role="status" className={`${quietAction(s)} ml-auto ${s.edge}`}><Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden />{t("accounts.removing")}</span>
        ) : (
          <button
            type="button"
            data-account-remove={account.id}
            aria-label={t("accounts.removeAria", { label: account.label })}
            disabled={state.mutation !== null}
            onClick={removal.arm}
            className={`${ACTION_BASE} ${s.action} ml-auto ${s.edge} text-muted hover:bg-danger-soft hover:text-danger`}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            {t("accounts.remove")}
          </button>
        )}
      </span>
    </div>
  );
}

/** A name that wraps is as wide as its longest line, and the word beside it follows the end of the first line, the gap one line has. */
function useHuggedName(label: string, active: boolean) {
  const name = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = name.current;
    if (!element || typeof document.createRange !== "function") return undefined;
    const word = element.nextElementSibling as HTMLElement | null;
    const hug = () => {
      element.style.maxWidth = "";
      if (word) word.style.transform = "";
      const range = document.createRange();
      range.selectNodeContents(element);
      if (typeof range.getClientRects !== "function") return;
      const lines = [...range.getClientRects()];
      if (lines.length < 2) return;
      element.style.maxWidth = `${Math.ceil(Math.max(...lines.map((line) => line.width)))}px`;
      const first = [...range.getClientRects()].filter((line, _, all) => line.top === all[0]!.top);
      if (word) word.style.transform = `translateX(${Math.max(...first.map((line) => line.right)) - element.getBoundingClientRect().right}px)`;
    };
    hug();
    void document.fonts?.ready.then(hug);
    window.addEventListener("resize", hug);
    return () => window.removeEventListener("resize", hug);
  }, [label, active]);
  return name;
}

/** The head's press opens or closes the row and changes nothing else. The default account carries a quiet word beside its name. */
const RowToggle = forwardRef<HTMLButtonElement, { account: AccountOption; active: boolean; open: boolean; onToggle: () => void }>(function RowToggle({ account, active, open, onToggle }, ref) {
  const { t } = useLocale();
  const s = useSizes();
  const name = useHuggedName(account.label, active);
  return (
    <button
      ref={ref}
      type="button"
      data-account-toggle={account.id}
      aria-expanded={open}
      aria-current={active ? "true" : undefined}
      onClick={onToggle}
      className={`flex min-w-0 flex-1 items-start gap-2 rounded-[6px] text-left hover:bg-canvas/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${s.toggle}`}
    >
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span ref={name} data-account-name className={`min-w-0 break-words ${s.name} ${active ? "font-bold" : "font-semibold"} text-primary`}>{account.label}</span>
        {active ? <span data-account-default-mark className={`shrink-0 font-normal text-muted ${s.line}`}>{t("accounts.defaultMark")}</span> : null}
      </span>
    </button>
  );
});

/** The surface the rows are listed on: the dialog or the phone's screen. */
type RowSurface = {
  state: EngineAccountsState;
  now: number;
  wide: boolean;
  phone: boolean;
  openId: string | null;
  setOpenId: (id: string | null) => void;
  focusId: string | null;
  loginBusy: boolean;
  signIn: AccountSignIn;
  /** Makes the account the default; true when it did. */
  makeDefault: (account: AccountOption) => Promise<boolean>;
  receipts?: ReceiptStore;
};

type AccountSignIn = {
  challenge: { accountId: string; deviceAuth: DeviceAuth } | null;
  start: (account: AccountOption) => void;
  cancel: (account: AccountOption) => void;
};

/** The sign-in a row can start. A Codex device sign-in hands its link and code back in the answer to the tap only, so the surface keeps them for the row. */
function useAccountSignIn(state: EngineAccountsState, receipts?: ReceiptStore): AccountSignIn {
  const { t } = useLocale();
  const [challenge, setChallenge] = useState<AccountSignIn["challenge"]>(null);
  const engine = state.engine;
  return {
    challenge,
    start: (account) => {
      const started = engine === "claude"
        ? state.retryLogin(account.id).then((ok) => ({ ok, deviceAuth: null as DeviceAuth | null }))
        : startCodexDeviceSignIn(state, account.id);
      void started.then(({ ok, deviceAuth }) => {
        setChallenge(ok && deviceAuth ? { accountId: account.id, deviceAuth } : null);
        receipts?.show(t(ok ? "mobile2.accounts.signInStarted" : "mobile2.accounts.signInFailed", { label: account.label }));
      });
    },
    cancel: (account) => {
      setChallenge((current) => (current?.accountId === account.id ? null : current));
      void cancelCodexDeviceSignIn(state, account.id);
    },
  };
}

function AccountRow({ account, engine, quota, surface }: {
  account: AccountOption;
  engine: "claude" | "codex";
  quota: ReconciledQuota;
  surface: RowSurface;
}) {
  const { t } = useLocale();
  const { state, now, wide, phone, openId, setOpenId, loginBusy, signIn, receipts } = surface;
  const s = phone ? PHONE : DESK;
  const facts = factsOf(account, engine, state.active, quota, now, t);
  const isActive = facts.status === "active";
  const nextChosen = account.nextChosen === true;
  const tint = engineTintOf(engine).color;
  const open = openId === account.id;
  const toggle = () => setOpenId(open ? null : account.id);
  const removal = useRemoval(() => void state.remove(account.id));
  const [providerOpen, setProviderOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  // A badge-driven open (issue #229) focuses one account: scroll it into view
  // and ring it so the panel lands on the conversation's account, not the top.
  const focused = surface.focusId === account.id;
  useEffect(() => {
    if (focused) rowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [focused]);
  // Making the account the default unmounts the control that was pressed and
  // moves the row to the top: focus goes to the row's own toggle.
  const wantFocus = useRef(false);
  useEffect(() => {
    if (isActive && wantFocus.current) {
      wantFocus.current = false;
      toggleRef.current?.focus();
    }
  }, [isActive]);
  // The form shows only while its row is open; what was typed stays in the editor.
  const providerFormOpen = providerOpen && open;
  const word = facts.status === "pending" ? t("accounts.pendingLogin") : t(account.provider && facts.health === "error" ? "accounts.provider.credentialError" : AUTH_HEALTH_KEY[facts.health]);
  const tone: AccountDotTone = facts.status === "pending" ? "pending" : facts.health === "authenticated" ? "success" : facts.health === "unknown" ? "muted" : facts.health === "signed_out" ? "warning" : "danger";
  const claudeLoginShown = engine === "claude" && !account.provider && account.login != null
    && (NONTERMINAL_CLAUDE_LOGIN_PHASES.has(account.login.phase) || account.login.result?.status === "failure");
  const canSignIn = facts.status === "needsSignIn" && mobileSignInAvailable(engine, account) && !claudeLoginShown;
  const challenge = engine === "codex" ? account.deviceAuth ?? (signIn.challenge?.accountId === account.id ? signIn.challenge.deviceAuth : null) : null;
  const creditsOn = facts.credits && account.spendCredits === true;
  return (
    <PhoneContext.Provider value={phone}>
      <div
        ref={rowRef}
        data-account-row={account.id}
        data-account-next-chosen={nextChosen ? "true" : undefined}
        {...(phone ? { "data-mobile2-account": account.id, "data-mobile2-account-state": facts.status } : {})}
        aria-busy={state.removing === account.id || undefined}
        className={`relative ${s.rowPad} ${focused ? "ring-2 ring-inset ring-accent/50" : ""} ${state.removing === account.id ? "opacity-60" : ""}`}
        // The default account reads as a tinted wash + hairline identity bar —
        // no boxed borders, so the list stays one quiet column.
        style={isActive ? { background: `color-mix(in srgb, ${tint} 7%, transparent)`, boxShadow: `inset 2px 0 0 ${tint}` } : undefined}
        // A press anywhere on a closed row opens it; its controls keep their
        // own presses. The toggle is the keyboard's way in.
        onClick={(event) => {
          if (!open && event.currentTarget.contains(event.target as Node) && !(event.target as Element).closest("button, a, input, code")) toggle();
        }}
      >
        <div data-account-head className={`flex items-start ${s.head}`}>
          <AccountStatusDot
            accountId={account.id}
            label={account.label}
            word={word}
            tone={tone}
            plan={planLabel(account.plan ?? quota.plan, t)}
            note={nextChosen ? t("accounts.nextForUnpinned") : null}
            phone={phone}
          />
          <RowToggle ref={toggleRef} account={account} active={isActive} open={open} onToggle={toggle} />
          {canSignIn ? <SignInButton account={account} disabled={state.mutation !== null || loginBusy} onStart={() => signIn.start(account)} /> : null}
          {/* The chevron is a pointer target only: the toggle beside it is the one keyboard stop. */}
          <button type="button" tabIndex={-1} aria-hidden data-account-chevron={account.id} onClick={toggle} className={`inline-flex shrink-0 items-center justify-center rounded-[6px] text-muted hover:bg-canvas hover:text-primary ${s.icon}`}>
            {open ? <ChevronDown className={s.chevron} aria-hidden /> : <ChevronRight className={s.chevron} aria-hidden />}
          </button>
        </div>
        <div data-account-below className={`flex flex-col gap-0.5 ${s.indent} ${s.below} empty:hidden`}>
          <WindowLines account={account} facts={facts} now={now} engine={engine} wide={wide} />
          <RowNotes account={account} facts={facts} now={now} />
          {engine === "codex" ? <AccountSpendCredits account={account} state={state} quota={quota} phone={phone} column={s.column(wide)} className={`${s.line} ${s.credits}`} /> : null}
          <ResetLine account={account} state={state} facts={facts} now={now} receipts={receipts} />
          {challenge ? (
            <DeviceSignInLine account={account} deviceAuth={challenge} onCancel={() => signIn.cancel(account)} />
          ) : null}
          {engine === "claude" && !account.provider
            ? <ClaudeLoginRow key={account.login?.operationId ?? account.id} account={account} state={state} loginBusy={loginBusy} headSignIn={canSignIn} inRow />
            : null}
          <AccountRowOpening open={open} phone={phone}>
            {/* The separate way to make an account the default, only where it can become one. */}
            {!isActive && facts.usable ? (
              <button
                type="button"
                data-account-make-default={account.id}
                aria-label={t("accounts.makeDefaultAria", { label: account.label })}
                disabled={state.mutation !== null}
                onClick={() => {
                  wantFocus.current = true;
                  void surface.makeDefault(account).then((ok) => { if (!ok) wantFocus.current = false; });
                }}
                className={`${accentAction(s)} -ml-1.5`}
              >
                {t("accounts.makeDefault")}
              </button>
            ) : null}
            {creditsOn ? <p data-account-line className={`break-words ${s.line} text-muted`}>{t("accounts.spendCreditsOnShort")}</p> : null}
            {engine === "codex" ? <NoResetsFact account={account} facts={facts} /> : null}
            {!account.provider && account.authPresent ? <RefreshLine account={account} state={state} facts={facts} receipts={receipts} /> : null}
            {removal.armed ? null : <ToolActions account={account} state={state} facts={facts} removal={removal} onProvider={() => setProviderOpen(true)} />}
          </AccountRowOpening>
          {engine === "claude" && account.provider ? <ClaudeProviderEditor state={state} account={account} phone={phone} inRow open={providerFormOpen} onOpenChange={setProviderOpen} /> : null}
          {removal.armed ? <RemoveConfirm account={account} removal={removal} disabled={state.mutation !== null} /> : null}
          <RowRefusal account={account} state={state} engine={engine} phone={phone} />
        </div>
      </div>
    </PhoneContext.Provider>
  );
}

/** The columns the percentages and dates stand in, named once for every row under it. */
function LimitsCaption({ className }: { className: string }) {
  const { t } = useLocale();
  return <span data-accounts-caption className={`whitespace-nowrap text-muted ${className}`}>{t("accounts.limitsCaption")}</span>;
}

export type ProjectAccountContext = {
  project: string;
  nextChosenAccountId?: string | null;
  restricted: boolean;
  allowed: { accountId: string; label: string }[];
  carrying: { accountId: string; label: string }[];
  outsidePool: { accountId: string; label: string; at: string; actor: "operator" | "agent" }[];
};

/** Project pool detail formerly painted as one chip per account in the primary
    toolbar. It now lives inside the engine panel, where full labels and the
    reason each account is present remain available without consuming the row. */
function ProjectAccountDetail({ context }: { context: ProjectAccountContext }) {
  const { t } = useLocale();
  const carrying = new Set(context.carrying.map((account) => account.accountId));
  const chosen = new Map(context.outsidePool.map((account) => [account.accountId, account] as const));
  const extra = [...context.carrying, ...context.outsidePool]
    .filter((account, index, list) => list.findIndex((item) => item.accountId === account.accountId) === index);
  const rows = context.restricted
    ? [...context.allowed, ...extra.filter((account) => !context.allowed.some((item) => item.accountId === account.accountId))]
    : extra;

  return (
    <section data-project-account-detail={context.project} className="border-b border-border bg-canvas/55 px-3.5 py-2.5">
      <div className="mb-1.5 flex items-center gap-2 text-[10px] font-semibold text-muted">
        <span>{t("projectAccounts.label")}</span>
        {!context.restricted ? (
          <span className="rounded-full border border-border bg-card px-1.5 py-0.5 text-secondary">
            {t("projectAccounts.any")}
          </span>
        ) : null}
      </div>
      {rows.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {rows.map((account) => {
            const choice = chosen.get(account.accountId);
            return (
              <span
                key={account.accountId}
                title={choice
                  ? t(choice.actor === "agent" ? "projectAccounts.chosenByAgent" : "projectAccounts.chosenByOperator", {
                      label: account.label,
                      at: choice.at,
                    })
                  : carrying.has(account.accountId)
                    ? t("projectAccounts.carryingAria", { label: account.label })
                    : account.accountId}
                {...(carrying.has(account.accountId) ? { "data-project-account-carrying": account.accountId } : {})}
                {...(choice ? { "data-project-account-outside-pool": account.accountId } : {})}
                className={`max-w-full break-words rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                  choice
                    ? "border-warning/45 bg-warning-soft text-warning"
                    : carrying.has(account.accountId)
                      ? "border-accent/45 bg-accent/10 text-primary"
                      : "border-border bg-card text-secondary"
                }`}
              >
                {account.label}
                {carrying.has(account.accountId) ? ` · ${t("projectAccounts.carrying")}` : ""}
                {choice ? ` · ${t("projectAccounts.outsidePool")}` : ""}
              </span>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

/** The Claude sign-in slice for one account row (issue #61). Renders the live
    login phase (browser link + bounded code entry, Cancel), a sanitized failure
    with Retry, or a Sign in / Retry affordance for any account stranded in
    signed_out or error — legacy Main included (issue #470) — and never removes
    the account. Codex rows never mount this (device login owns its own inline
    affordance in AccountRow). */
function ClaudeLoginRow({ account, state, loginBusy, headSignIn = false, inRow = false }: {
  account: AccountOption;
  state: EngineAccountsState;
  loginBusy: boolean;
  /** The row's head already carries the Sign in for a signed-out account: this row then adds nothing for it. */
  headSignIn?: boolean;
  /** Drawn inside an account row, on the row's own left edge. */
  inRow?: boolean;
}) {
  const { t } = useLocale();
  const pad = inRow ? "" : "px-3 pb-2 pl-[26px]";
  const login = account.login ?? null;
  const phase = login?.phase;
  const nonterminal = login != null && NONTERMINAL_CLAUDE_LOGIN_PHASES.has(login.phase);
  // The op's own Cancel/Submit gate on the shared mutation lock; the Sign in and
  // Retry affordances also stand down while any Claude login is nonterminal (C10).
  const busy = state.mutation !== null;
  const rowRef = useRef<HTMLDivElement>(null);
  const wantFocus = useRef(false);
  const [code, setCode] = useState("");
  const [submitted, setSubmitted] = useState(false);

  // Drop the pasted code the moment we leave code entry so it never lingers or
  // re-submits after a phase change (C6). Adjusting state during render (the
  // React-endorsed "reset on prop change" pattern) keeps it off an effect; the
  // row is also keyed by operationId so a fresh op after a retry starts clean.
  const [seenPhase, setSeenPhase] = useState(phase);
  if (phase !== seenPhase) {
    setSeenPhase(phase);
    if (phase !== "awaiting_code") {
      setCode("");
      setSubmitted(false);
    }
  }

  // Keep focus inside the sub-row when a control the operator just pressed
  // unmounts across a phase change (C9). Other transitions preserve their focus.
  useEffect(() => {
    if (wantFocus.current) {
      wantFocus.current = false;
      rowRef.current?.focus();
    }
  });
  const activate = (run: () => void) => {
    wantFocus.current = true;
    run();
  };

  if (nonterminal && login) {
    const cancelable = phase !== "canceling";
    const cancelButton = (
      <button
        type="button"
        onClick={() => activate(() => void state.cancelLogin(login.operationId))}
        disabled={busy || !cancelable}
        className="inline-flex min-h-[44px] shrink-0 items-center rounded-[7px] border border-border bg-canvas px-2 py-0.5 text-[11px] font-semibold hover:bg-sunken disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0"
      >
        {t("accounts.claudeLogin.cancel")}
      </button>
    );
    const spinnerLine = (key: "accounts.claudeLogin.starting" | "accounts.claudeLogin.awaitingBrowser" | "accounts.claudeLogin.verifying" | "accounts.claudeLogin.canceling") => (
      <div className="flex items-center gap-2">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none text-muted" aria-hidden />
        <span className="min-w-0 flex-1 text-[11px] text-muted">{t(key)}</span>
        {cancelable ? cancelButton : null}
      </div>
    );
    const hintId = `${login.operationId}-hint`;
    return (
      <div
        ref={rowRef}
        tabIndex={-1}
        role="group"
        aria-label={t("accounts.claudeLogin.groupAria", { label: account.label })}
        className={`flex flex-col gap-1.5 ${pad} focus-visible:outline-none`}
      >
        {phase === "starting" ? spinnerLine("accounts.claudeLogin.starting") : null}
        {phase === "awaiting_browser" ? spinnerLine("accounts.claudeLogin.awaitingBrowser") : null}
        {phase === "verifying" ? spinnerLine("accounts.claudeLogin.verifying") : null}
        {phase === "canceling" ? spinnerLine("accounts.claudeLogin.canceling") : null}
        {phase === "awaiting_code" ? (
          <>
            {/* The link renders only in awaiting_code — it is stale once the code
                is submitted. The URL is server-vetted; render it verbatim. */}
            {login.loginUrl ? (
              <a href={login.loginUrl} target="_blank" rel="noreferrer noopener" className="inline-flex min-h-[44px] items-center self-start text-[11px] font-semibold text-accent underline sm:min-h-0">
                {t("accounts.claudeLogin.openLink")}
              </a>
            ) : null}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (submitted || busy || code.trim() === "") return;
                activate(() => {
                  setSubmitted(true);
                  void state.submitLoginCode(login.operationId, code);
                });
              }}
              className="flex items-center gap-2"
            >
              <input
                type="text"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                onFocus={(event) => event.currentTarget.scrollIntoView({ block: "nearest" })}
                maxLength={8192}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-label={t("accounts.claudeLogin.codeLabel")}
                aria-describedby={hintId}
                placeholder={t("accounts.claudeLogin.codePlaceholder")}
                className="h-11 min-w-0 flex-1 rounded-[8px] border border-border bg-canvas px-2 font-mono text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-8"
              />
              <button
                type="submit"
                disabled={busy || submitted || code.trim() === ""}
                className="h-11 shrink-0 rounded-[8px] border border-border bg-canvas px-2.5 text-[11px] font-semibold hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-8"
              >
                {t("accounts.claudeLogin.submit")}
              </button>
            </form>
            <p id={hintId} className="text-[10px] leading-snug text-muted">{t("accounts.claudeLogin.codeHint")}</p>
            <div className="flex justify-end">{cancelButton}</div>
          </>
        ) : null}
      </div>
    );
  }

  // Terminal failure (failed / timed_out / interrupted): sanitized copy + Retry.
  if (login && login.result?.status === "failure") {
    return (
      <div ref={rowRef} tabIndex={-1} role="alert" className={`flex items-center gap-2 ${pad} focus-visible:outline-none`}>
        <span className="min-w-0 flex-1 text-[10.5px] font-semibold text-danger">{claudeLoginErrorText(t, login.result.code)}</span>
        <button
          type="button"
          onClick={() => activate(() => void state.retryLogin(account.id))}
          disabled={busy || loginBusy}
          className="inline-flex min-h-[44px] shrink-0 items-center rounded-[7px] border border-border bg-canvas px-2 py-0.5 text-[11px] font-semibold hover:bg-sunken disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0"
        >
          {t("accounts.retry")}
        </button>
      </div>
    );
  }

  // Any Claude account stranded in signed_out or error with no live op — legacy
  // Main included (issue #470) — gets an in-place recovery affordance that never
  // removes the account: Sign in when signed out, Retry when a credentialed
  // account is erroring. This also covers a canceled managed sign-in.
  const health = authHealth(account);
  if (headSignIn) return null;
  if (health === "signed_out" || health === "error" || !account.authPresent) {
    const label = health === "error" ? t("accounts.retry") : t("accounts.claudeLogin.signIn");
    return (
      <div ref={rowRef} tabIndex={-1} className={`flex items-center gap-2 ${pad} focus-visible:outline-none`}>
        <button
          type="button"
          onClick={() => activate(() => void state.retryLogin(account.id))}
          disabled={busy || loginBusy}
          className="inline-flex min-h-[44px] shrink-0 items-center rounded-[7px] border border-border bg-canvas px-2.5 py-0.5 text-[11px] font-semibold hover:bg-sunken disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0"
        >
          {label}
        </button>
      </div>
    );
  }

  return null;
}

/** Derived polite announcement for the sign-in live region (C9): the code-ready
    prompt while any account awaits its code, then the signed-in confirmation.
    Deriving from current state means the aria-live text changes exactly on the
    transition, with no effect and no mount-time announcement. */
function claudeAnnouncement(engine: "claude" | "codex", accounts: AccountOption[], t: TFunction): string {
  if (engine !== "claude") return "";
  const awaitingCode = accounts.find((account) => account.login?.phase === "awaiting_code");
  if (awaitingCode) return t("accounts.claudeLogin.announceCodeReady", { label: awaitingCode.label });
  const signedIn = accounts.find((account) => account.login?.phase === "authenticated");
  if (signedIn) return t("accounts.claudeLogin.announceDone", { label: signedIn.label });
  return "";
}

function operationText(operation: AccountOperation, t: TFunction): string {
  switch (operation) {
    case "refresh": return t("accounts.operation.refresh");
    case "add": return t("accounts.operation.add");
    case "switch": return t("accounts.operation.switch");
    case "login": return t("accounts.operation.login");
    case "remove": return t("accounts.operation.remove");
    case "restore": return t("accounts.operation.restore");
    case "cleanup": return t("accounts.operation.cleanup");
    case "terminal": return t("accounts.operation.terminal");
    case "refreshLimits": return t("accounts.operation.refreshLimits");
    case "resetCredit": return t("accounts.operation.resetCredit");
  }
}

/** The refusal block for one account's row, when the last removal answer
    refused that account (#1857 §5.2). */
function rowRefusal(state: EngineAccountsState, accountId: string, phone = false): React.ReactNode {
  const removal = state.removal;
  if (removal?.kind !== "refused" || removal.refusal.accountId !== accountId) return null;
  /* An open sign-in is ended from the refusal itself: Claude cancels its
     operation, Codex its device login (which the desktop row has no control for). */
  const operationId = state.accounts.find((account) => account.id === accountId)?.login?.operationId ?? null;
  const cancelSignIn = state.engine === "codex"
    ? () => void cancelCodexDeviceSignIn(state, accountId)
    : operationId ? () => void state.cancelLogin(operationId) : undefined;
  return (
    <AccountRemovalRefusal
      refusal={removal.refusal}
      phone={phone}
      disabled={state.mutation !== null}
      onDismiss={state.dismissRemoval}
      onRetry={() => void state.remove(accountId)}
      onRefresh={() => void state.refresh()}
      onCancelSignIn={cancelSignIn}
    />
  );
}

/** The removed default homes account setup offers back. One whose removal
    summary is still open is offered there instead, never twice. */
function HiddenAccountOffers({ state, phone = false, className }: { state: EngineAccountsState; phone?: boolean; className: string }) {
  const summary = state.removal?.kind === "removed" ? state.removal.summary : null;
  const offered = (state.hidden ?? []).filter((account) => !(summary?.hiddenHome && summary.accountId === account.id));
  return offered.map((account) => (
    <HiddenAccountOffer
      key={account.id}
      account={account}
      phone={phone}
      busy={state.mutation === "restore"}
      className={className}
      onRestore={() => void state.restore(account.id)}
    />
  ));
}

/** The footer slot's removal answer (#1857 §5.3, §5.4): the summary of what a
    removal moved, the clean-up result, or a refusal whose row has left the
    list. The phone draws it at the top of the engine section. */
function RemovalOutcome({ state, phone = false }: { state: EngineAccountsState; phone?: boolean }) {
  const removal = state.removal;
  const busy = state.mutation !== null;
  if (!removal) return null;
  switch (removal.kind) {
    case "removed":
      return <AccountRemovalSummary summary={removal.summary} phone={phone} busy={busy} onDismiss={state.dismissRemoval} onFinishCleanup={() => void state.cleanupOrphans()} onRestore={() => void state.restore(removal.summary.accountId)} />;
    case "cleanup":
      return <AccountCleanupResult report={removal.report} phone={phone} onDismiss={state.dismissRemoval} />;
    case "cleanupFailed":
      return <AccountCleanupFailed phone={phone} busy={busy} onDismiss={state.dismissRemoval} onRetry={() => void state.cleanupOrphans()} />;
    case "refused":
      if (state.accounts.some((account) => account.id === removal.refusal.accountId)) return null;
      return <div className={phone ? "mx-3" : "border-t border-border pt-2"}>{rowRefusal(state, removal.refusal.accountId, phone)}</div>;
  }
}

/** The token stays in this form until submission and is never put in a row or URL. */
function ClaudeProviderEditor({ state, account, phone = false, inRow = false, open: controlledOpen, onOpenChange }: {
  state: EngineAccountsState;
  account?: AccountOption;
  phone?: boolean;
  /** Drawn inside an account row: the row's "Edit provider" opens the form, so the editor adds no toggle of its own. */
  inRow?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useLocale();
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const setOpen = onOpenChange ?? setOwnOpen;
  const [label, setLabel] = useState(account?.label ?? "");
  const [baseUrl, setBaseUrl] = useState(account?.provider?.baseUrl ?? "https://opencode.ai/zen/go");
  const [token, setToken] = useState("");
  const [model, setModel] = useState(account?.provider?.model ?? "qwen3.8-max");
  const [smallFastModel, setSmallFastModel] = useState(account ? account.provider?.smallFastModel ?? "" : "qwen3.8-flash");
  const [headerLines, setHeaderLines] = useState("");
  const [clearHeaders, setClearHeaders] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const headers = Object.fromEntries(headerLines.split("\n").filter((line) => line.trim()).map((line) => {
    const colon = line.indexOf(":");
    if (colon < 1) return ["", ""];
    return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
  }));
  const provider = { baseUrl, model: model || "model-for-list", smallFastModel, ...(token ? { token } : {}),
    ...(!account || headerLines.trim() || clearHeaders ? { headers } : {}) };
  /* An existing account's save closes the editor and draws the new label,
     URL and model on its row at once, the token field emptied; a refusal
     takes the row back and reopens the editor with what was typed, token
     included (audit B32). A new account and the model list still wait. */
  const saveExisting = async (existing: AccountOption) => {
    if (busy) return;
    const typed = { token, headerLines, clearHeaders };
    const undo = state.drawAccount?.(existing.id, { label: label.trim(), provider: { ...existing.provider, baseUrl, model, smallFastModel: smallFastModel || null } }) ?? (() => {});
    setBusy(true); setError(""); setToken(""); setOpen(false);
    const refused = (message: string) => {
      undo();
      setToken(typed.token); setHeaderLines(typed.headerLines); setClearHeaders(typed.clearHeaders);
      setError(message); setOpen(true);
    };
    try {
      const response = await fetch("/api/accounts/claude", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: existing.id, label, provider: { ...provider, model } }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) { refused(body.error ?? t("accounts.provider.error")); return; }
      setHeaderLines(""); setClearHeaders(false);
      await state.refresh();
    } catch { refused(t("accounts.provider.error")); }
    finally { setBusy(false); }
  };
  const request = async (action: "provider-models" | "save") => {
    if (action === "save" && account) return saveExisting(account);
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/accounts/claude", {
        method: action === "save" && account ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action === "provider-models"
          ? { action, id: account?.id, provider }
          : { id: account?.id, label, provider: { ...provider, model } }),
      });
      const body = await response.json() as { error?: string; models?: string[] | null; account?: { id?: string } };
      if (!response.ok) { setError(body.error ?? t("accounts.provider.error")); return; }
      if (action === "provider-models") { setModels(body.models ?? []); return; }
      const selectNew = !account && !state.accounts.some((candidate) => candidate.id === state.active && candidate.authPresent);
      setToken(""); setHeaderLines(""); setClearHeaders(false); setOpen(false); await state.refresh();
      if (selectNew && body.account?.id) await state.select(body.account.id);
    } catch { setError(t("accounts.provider.error")); }
    finally { setBusy(false); }
  };
  // The editor stays mounted while closed: a refused save reopens it with what was typed.
  if (inRow && !open) return null;
  return (
    <div className={inRow ? "" : phone ? "px-3 pb-2" : "border-t border-border px-3 py-2"} data-claude-provider-editor={account?.id ?? "new"}>
      {inRow ? null : <button type="button" className="min-h-11 text-[11px] font-semibold text-accent underline underline-offset-2 sm:min-h-6" onClick={() => setOpen(!open)}>
        {account ? t("accounts.provider.edit") : t("accounts.provider.add")}
      </button>}
      {open ? <div className="mt-2 grid gap-2">
        <input aria-label={t("accounts.provider.name")} placeholder={t("accounts.provider.name")} value={label} onChange={(event) => setLabel(event.target.value)} className="min-h-11 w-full rounded border border-border bg-canvas px-2 py-1 text-xs sm:min-h-8" />
        <input aria-label={t("accounts.provider.url")} placeholder="https://opencode.ai/zen/go" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} className="min-h-11 w-full rounded border border-border bg-canvas px-2 py-1 text-xs sm:min-h-8" />
        <input aria-label={t("accounts.provider.token")} type={"password"} autoComplete="off" placeholder={account ? t("accounts.provider.keepToken") : t("accounts.provider.token")} value={token} onChange={(event) => setToken(event.target.value)} className="min-h-11 w-full rounded border border-border bg-canvas px-2 py-1 text-xs sm:min-h-8" />
        <input aria-label={t("accounts.provider.model")} list={`claude-provider-models-${account?.id ?? "new"}`} placeholder={t("accounts.provider.model")} value={model} onChange={(event) => setModel(event.target.value)} className="min-h-11 w-full rounded border border-border bg-canvas px-2 py-1 text-xs sm:min-h-8" />
        <input aria-label={t("accounts.provider.smallModel")} list={`claude-provider-models-${account?.id ?? "new"}`} placeholder={t("accounts.provider.smallModel")} value={smallFastModel} onChange={(event) => setSmallFastModel(event.target.value)} className="min-h-11 w-full rounded border border-border bg-canvas px-2 py-1 text-xs sm:min-h-8" />
        <textarea aria-label={t("accounts.provider.headers")} placeholder={t("accounts.provider.headersHint")} value={headerLines} onChange={(event) => setHeaderLines(event.target.value)} className="min-h-16 w-full rounded border border-border bg-canvas px-2 py-1 text-xs" />
        {account?.provider?.customHeaderNames?.length ? <div className="text-[11px] text-muted">{t("accounts.provider.savedHeaders")}: {account.provider.customHeaderNames.join(", ")}</div> : null}
        {account?.provider?.customHeaderNames?.length ? <label className="flex items-center gap-2 text-[11px] text-muted"><input type="checkbox" checked={clearHeaders} onChange={(event) => setClearHeaders(event.target.checked)} />{t("accounts.provider.clearHeaders")}</label> : null}
        {baseUrl.replace(/\/$/, "") === "https://opencode.ai/zen/go" ? <div className="text-[11px] text-muted">{t("accounts.provider.goModels")}</div> : null}
        <datalist id={`claude-provider-models-${account?.id ?? "new"}`}>{models.map((id) => <option key={id} value={id} />)}</datalist>
        <div className="flex gap-2">
          <button type="button" disabled={busy || !baseUrl || (!account && !token)} onClick={() => void request("provider-models")} className="min-h-11 rounded border border-border px-2 py-1 text-xs disabled:opacity-50 sm:min-h-8">{t("accounts.provider.loadModels")}</button>
          <button type="button" disabled={busy || !label.trim() || !baseUrl || !model || (!account && !token)} onClick={() => void request("save")} className="min-h-11 rounded border border-border px-2 py-1 text-xs font-semibold disabled:opacity-50 sm:min-h-8">{t("accounts.provider.save")}</button>
        </div>
        {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
      </div> : null}
    </div>
  );
}

/**
 * Unified, engine-parameterized Accounts panel. Symmetric for Claude and Codex:
 * account list with capacity chips, direct active-account selection, clear
 * operation state, and the add-account form.
 *
 * `placement` picks the desktop anchor for the caller's surface (mobile always
 * uses the bottom sheet):
 * - `"footer"` (the limits footer): a flyout beside the rail (`sm:left-full`),
 *   bottom-aligned, mirroring the resources CleanupPanel.
 * - `"header"` (the Switchboard header): a dropdown below the trigger
 *   (`sm:top-full`). The header sits at the top of an overflow-hidden modal, so
 *   a bottom-anchored flyout would grow upward out of that shell and clip; the
 *   header placement anchors downward and stays inside the box.
 */
export function AccountsPanel({
  state,
  onClose,
  placement = "footer",
  focusAccountId = null,
  quotaOverride,
  projectContext,
}: {
  state: EngineAccountsState;
  onClose: () => void;
  placement?: "footer" | "header";
  /** When set, the panel opens scrolled to and highlighting this account
      (issue #229 — a header account badge steers here). */
  focusAccountId?: string | null;
  quotaOverride?: { accountId: string; quota: ReconciledQuota; now: number };
  projectContext?: ProjectAccountContext;
}) {
  const { t } = useLocale();
  const { accounts, active, status, notice, mutation, engine } = state;
  const [label, setLabel] = useState("");
  const [presentationNow, setPresentationNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (quotaOverride) return;
    const id = setInterval(() => setPresentationNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, [quotaOverride]);
  const quotaNow = quotaOverride?.now ?? presentationNow;
  // While any Claude account has a live login op, the add/sign-in/retry starters
  // stand down so a second login can't race the supervisor (C10).
  const loginBusy = engine === "claude" && accounts.some((account) => account.login != null && NONTERMINAL_CLAUDE_LOGIN_PHASES.has(account.login.phase));
  // One polite live region per panel (C9). Derived from current state, so the
  // aria-live text changes exactly on the code-ready and signed-in transitions —
  // no effect/setState needed, and mount content is never announced.
  const announcement = claudeAnnouncement(engine, accounts, t);
  /* Accounts an install transfer brought: re-read whenever an account's
     sign-in state here changes, since a sign-in settles its row. */
  const imported = useImportedAccounts(engine, accounts.map((account) => `${account.id}:${account.authPresent ? 1 : 0}`).join(","));
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  /* The whole dialog stays inside the viewport: it is anchored by one edge
     (its bottom for the footer flyout and the phone sheet, its top under the
     header), so its height is bounded by the room on that side, and anything
     past it scrolls inside the dialog under its own header. */
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const fit = () => {
      const node = dialogRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const growsDown = placement === "header" && window.matchMedia("(min-width: 640px)").matches;
      setMaxHeight(Math.max(160, Math.floor(growsDown ? window.innerHeight - rect.top - 8 : rect.bottom - 8)));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [placement]);
  const engineName = engineDisplay(engine);
  // Desktop anchor per caller; both share the mobile bottom sheet. The header
  // placement drops downward (`sm:top-full`) so an overflow-hidden ancestor
  // can't clip the panel; the footer keeps the bottom-aligned right-side flyout.
  const placementClass =
    placement === "header"
      ? "sm:absolute sm:top-full sm:left-0 sm:mt-2 sm:bottom-auto sm:translate-x-0"
      : "sm:absolute sm:bottom-1 sm:left-full sm:ml-2 sm:translate-x-0";

  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  // A removal answer lasts until it is closed or the panel is.
  const dismissRemoval = state.dismissRemoval;
  useEffect(() => dismissRemoval, [dismissRemoval]);

  // One row is open at a time; a press on a row opens it and selects nothing.
  const [openId, setOpenId] = useState<string | null>(null);
  const phone = useIsMobile();
  const signIn = useAccountSignIn(state);
  const makeDefault = async (account: AccountOption) => {
    if (mutation) return false;
    return state.select(account.id);
  };

  const onAdd = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = label.trim();
    if (!trimmed || mutation) return;
    const created = await state.add(trimmed);
    if (created) setLabel("");
  };

  const rows = accounts.map((account) => ({
    account: projectContext
      ? { ...account, nextChosen: projectContext.nextChosenAccountId != null && account.id === projectContext.nextChosenAccountId }
      : account,
    quota: quotaOverride?.accountId === active && account.id === active ? quotaOverride.quota : accountQuota(account, quotaNow),
  })).sort((a, b) => Number(b.account.nextChosen === true) - Number(a.account.nextChosen === true)
    || Number(b.account.id === active) - Number(a.account.id === active));
  // One label column for the whole list (#1358): a tier row's longer label
  // widens every card's column, so the meters stay aligned from card to card.
  const wideLabels = rows.some(({ quota }) => quota.tiers.length > 0);
  const surface: RowSurface = {
    state, now: quotaNow, wide: wideLabels, phone, openId, setOpenId, loginBusy, signIn, makeDefault,
    focusId: focusAccountId,
  };

  return (
    <>
      {/* Mobile-only backdrop that absorbs the outside tap so it closes only the
          sheet, never the project drawer beneath it (desktop is a flyout). */}
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        aria-label={t("accounts.close")}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className={`fixed inset-0 ${Z.modal} cursor-default sm:hidden`}
      />
      <div
        role="dialog"
        aria-label={t("accounts.titleFor", { engine: engineName })}
        aria-busy={mutation !== null}
        onKeyDown={(event) => handleOverlayEscape(event, onClose)}
        ref={dialogRef}
        style={maxHeight === null ? undefined : { maxHeight }}
        className={`fixed bottom-3 left-1/2 ${Z.modal} flex w-[min(400px,calc(100vw-16px))] -translate-x-1/2 flex-col overflow-y-auto rounded-[14px] border border-border bg-card shadow-2 ${placementClass}`}
      >
        <header className="sticky top-0 z-[1] flex shrink-0 items-center gap-2 rounded-t-[14px] border-b border-border bg-card px-3 py-2">
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: engineTintOf(engine).color }} />
          <span className="text-[12.5px] font-bold">{t("accounts.titleFor", { engine: engineName })}</span>
          <LimitsCaption className={`ml-auto ${phone ? "text-[12px]" : "text-[11px]"}`} />
          <button
            ref={closeRef}
            type="button"
            aria-label={t("accounts.close")}
            onClick={onClose}
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[6px] p-1 text-muted hover:bg-canvas hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0 sm:min-w-0"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </header>

        <p className="sr-only" role="status" aria-live="polite">{announcement}</p>

        {projectContext ? <ProjectAccountDetail context={projectContext} /> : null}

        {mutation ? (
          <div role="status" aria-live="polite" className="flex items-center gap-2 border-b border-border bg-accent/5 px-3 py-2 text-[11px] font-semibold text-primary">
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none text-accent" aria-hidden />
            {operationText(mutation, t)}
          </div>
        ) : null}
          <>
            <div data-accounts-scroller className="max-h-[min(560px,70vh)] min-h-0 shrink divide-y divide-border/40 overflow-y-auto">
              {/* Inside the bounded list, so a long import scrolls with the
                  accounts it brought instead of pushing the dialog off screen. */}
              <TransferAccountsChecklist
                engine={engine}
                rows={imported.rows}
                onSignIn={async (accountId) => {
                  if (engine === "claude") await state.retryLogin(accountId);
                  else await startCodexDeviceSignIn(state, accountId);
                  await imported.reload();
                }}
                onAction={async (body) => {
                  await imported.post(body);
                  if (body.action === "verify" || body.action === "retry") await state.refresh();
                  await imported.reload();
                }}
              />
              {status === "loading" ? <AccountRowsSkeleton className="px-1.5 py-1" /> : null}
              {status === "error" && accounts.length === 0 ? <div className="px-3.5 py-2 text-[11px] text-muted">{t("accounts.noAccounts")}</div> : null}
              {rows.map(({ account, quota }) => (
                <AccountRow key={account.id} account={account} engine={engine} quota={quota} surface={surface} />
              ))}
            </div>
            <form onSubmit={onAdd} className="flex items-center gap-2 border-t border-border px-3 py-2">
              <input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={t("accounts.labelPlaceholder")}
                className="h-11 min-w-0 flex-1 rounded-[8px] border border-border bg-canvas px-2 text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-8"
              />
              <button
                type="submit"
                disabled={mutation !== null || label.trim() === "" || loginBusy}
                className="inline-flex h-11 min-w-[44px] shrink-0 items-center justify-center rounded-[8px] border border-border bg-canvas px-2.5 text-[11px] font-semibold hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-8 sm:min-w-0"
              >
                {t("accounts.confirmAdd")}
              </button>
            </form>
            <HiddenAccountOffers state={state} className="border-t border-border px-3 py-1.5" />
            {engine === "claude" ? <ClaudeProviderEditor state={state} /> : null}
            <div className="flex justify-end border-t border-border px-3 py-1.5">
              <button
                type="button"
                data-account-cleanup
                disabled={mutation !== null}
                onClick={() => void state.cleanupOrphans()}
                className="inline-flex min-h-[44px] items-center gap-1.5 text-[10.5px] font-semibold text-muted underline underline-offset-2 hover:text-primary disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0"
              >
                {mutation === "cleanup" ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden />
                    {t("accounts.cleanup.running")}
                  </>
                ) : t("accounts.cleanupOrphans")}
              </button>
            </div>
            <RemovalOutcome state={state} />
            {notice ? (
              <div className="flex items-center gap-2 border-t border-border px-3 py-1.5">
                {/* Failure text may carry the server's real error (`detail`), so it
                    wraps to two lines instead of truncating away the cause. */}
                <span className={`min-w-0 flex-1 text-[11px] leading-snug [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden ${notice.kind === "error" ? "text-danger" : "text-muted"}`} title={accountNoticeText(t, notice)}>{accountNoticeText(t, notice)}</span>
                {notice.action ? (
                  <button
                    type="button"
                    disabled={mutation !== null}
                    onClick={() => void state.retryNotice().then((recovered) => {
                      if (recovered && notice.operation === "add") setLabel("");
                    })}
                    className="inline-flex min-h-[44px] shrink-0 items-center rounded-[7px] border border-border bg-canvas px-2 py-0.5 text-[11px] font-semibold hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0"
                  >
                    {t("accounts.retry")}
                  </button>
                ) : null}
              </div>
            ) : null}
          </>
      </div>
    </>
  );
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Mobile v2 — the Accounts & limits screen (#1439, lane 9)                    *
 * ────────────────────────────────────────────────────────────────────────── */

/*
 * docs/design/mobile-v2/README.md §4.8: a screen from `⋯`, per engine. The
 * active account is a card — filled engine mark, label, `active`, plan,
 * "checked 14:32", the lowest window in the corner as `38% left / Week`,
 * coloured by what remains — with its windows as `label · meter · % left` and
 * the reset line under each, the resets line, and Refresh / Use one reset as
 * 44 px text buttons. Other authenticated accounts are quiet rows (`ready`)
 * that switch future launches on the tap, with Switch back in the receipt.
 * Accounts that are not signed in are quiet rows with a trailing `sign in →`
 * that opens the device sign-in; they become active only after it returns.
 * "Add a … account" is last.
 *
 * Every meter fills with what REMAINS (§5); the corner names its window; no
 * action asks for confirmation (§2 rule 9). The desktop dialog above is
 * untouched: this is the phone's layout over the same account store.
 */

export type MobileAccountState = "active" | "ready" | "needsSignIn" | "error" | "pending";

const MOBILE_STATE_OF: Record<RowState, MobileAccountState> = {
  pending: "pending",
  needsLogin: "needsSignIn",
  error: "error",
  active: "active",
  idle: "ready",
};

/** One state per row, in the phone's words. The precedence is the dialog's own
    `rowState` — a live sign-in outranks everything, then a missing or
    signed-out credential (the row stays inactive even when the registry still
    names it active), then active — so the two surfaces cannot drift apart. */
export function mobileAccountState(account: AccountOption, activeId: string): MobileAccountState {
  return MOBILE_STATE_OF[rowState(account, activeId)];
}

/** The sign-in a row can start: Claude restarts its login in place for any
    account, and Codex runs its device login for any account, Main included
    (#2166): signing in the account you have never asks for a second one. */
function mobileSignInAvailable(engine: "claude" | "codex", account: AccountOption): boolean {
  return !account.provider && (engine === "claude" || account.kind === "managed" || account.kind === "legacy");
}

/** Codex keeps its device-login contract on the accounts route (`action:
    "retry"`); the store has no verb for it, so the screen asks the route and
    re-reads the list, which then carries the pending login. The verification
    link and its code come back in THAT answer and nowhere else, so the caller
    keeps what it was handed and the row shows it. */
async function startCodexDeviceSignIn(state: EngineAccountsState, accountId: string): Promise<{ ok: boolean; deviceAuth: DeviceAuth | null }> {
  let deviceAuth: DeviceAuth | null = null;
  try {
    const response = await fetch("/api/accounts/codex", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "retry", id: accountId }),
    });
    if (!response.ok) return { ok: false, deviceAuth: null };
    const body = await response.json().catch(() => null) as { deviceAuth?: { url?: unknown; code?: unknown } } | null;
    const url = body?.deviceAuth?.url;
    const code = body?.deviceAuth?.code;
    if (typeof url === "string" && typeof code === "string") deviceAuth = { url, code };
  } catch {
    return { ok: false, deviceAuth: null };
  }
  await state.refresh();
  return { ok: true, deviceAuth };
}

/** Stops a Codex device sign-in that is waiting for its code (#2166, newcomer
    audit F20): Claude and Copilot always had a Cancel. */
async function cancelCodexDeviceSignIn(state: EngineAccountsState, accountId: string): Promise<boolean> {
  try {
    const response = await fetch("/api/accounts/codex", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "cancel", id: accountId }),
    });
    if (!response.ok) return false;
  } catch {
    return false;
  }
  await state.refresh();
  return true;
}

function planLabel(plan: string | null | undefined, t: TFunction): string | null {
  const trimmed = plan?.trim();
  if (!trimmed) return null;
  return t("mobile2.accounts.plan", { plan: trimmed.charAt(0).toUpperCase() + trimmed.slice(1) });
}

const MOBILE_ACTION = "inline-flex min-h-11 min-w-11 items-center gap-1.5 rounded-[8px] px-2 text-ui font-semibold text-accent active:bg-sunken disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

/** "Add a … account", last in the section: a quiet row that turns into the
    label field and its Add on the tap (an account needs a name before the
    device sign-in can start). The field is 16 px so iOS never zooms. */
function MobileAddAccountRow({ state, engineName, loginBusy }: { state: EngineAccountsState; engineName: string; loginBusy: boolean }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const busy = state.mutation !== null;
  if (!open) {
    return (
      <div className="mx-3 mb-1.5 rounded-[12px] bg-quiet pl-3 pr-1 ring-1 ring-inset ring-border">
        <button type="button" data-mobile2-account-add={state.engine} disabled={busy || loginBusy} className="flex min-h-14 w-full items-center gap-2.5 text-left active:bg-sunken disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40" onClick={() => setOpen(true)}>
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-strong" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-body font-semibold leading-[1.25] text-secondary">{t("mobile2.accounts.add", { engine: engineName })}</span>
            <span className="truncate text-label text-muted">{t("mobile2.accounts.addHint")}</span>
          </span>
          <Plus className="h-[18px] w-[18px] shrink-0 text-muted" aria-hidden />
        </button>
      </div>
    );
  }
  return (
    <form
      data-mobile2-account-add-form={state.engine}
      className="mx-3 mb-1.5 flex items-center gap-2 rounded-[12px] bg-quiet p-2 ring-1 ring-inset ring-border"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = label.trim();
        if (!trimmed || busy) return;
        void state.add(trimmed).then((created) => {
          if (created) {
            setLabel("");
            setOpen(false);
          }
        });
      }}
    >
      <input
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        aria-label={t("mobile2.accounts.addLabel")}
        placeholder={t("accounts.labelPlaceholder")}
        autoComplete="off"
        autoCapitalize="words"
        // eslint-disable-next-line jsx-a11y/no-autofocus -- the row the operator just tapped became this field
        autoFocus
        className="h-11 min-w-0 flex-1 rounded-[8px] border border-border bg-canvas px-2.5 text-[16px] outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      />
      <button type="button" className="inline-flex h-11 min-w-11 items-center justify-center rounded-[8px] px-2 text-ui font-semibold text-secondary active:bg-sunken" onClick={() => { setOpen(false); setLabel(""); }}>
        {t("mobile2.accounts.addCancel")}
      </button>
      <button type="submit" disabled={busy || loginBusy || label.trim() === ""} className="inline-flex h-11 min-w-11 items-center justify-center rounded-[8px] px-3 text-ui font-bold text-accent active:bg-sunken disabled:opacity-40">
        {t("accounts.confirmAdd")}
      </button>
    </form>
  );
}

function MobileEngineSection({ state, now, focusAccountId, receipts }: { state: EngineAccountsState; now: number; focusAccountId: string | null; receipts: ReceiptStore }) {
  const { t } = useLocale();
  const { engine, accounts, active, notice, status } = state;
  const engineName = engineDisplay(engine);
  const loginBusy = engine === "claude" && accounts.some((account) => account.login != null && NONTERMINAL_CLAUDE_LOGIN_PHASES.has(account.login.phase));
  // One row is open at a time; a press on a row opens it and selects nothing.
  const [openId, setOpenId] = useState<string | null>(null);
  // A removal answer lasts until it is closed or the screen is.
  const dismissRemoval = state.dismissRemoval;
  useEffect(() => dismissRemoval, [dismissRemoval]);
  /* The default account leads; the rest keep the registry's order. */
  const ordered = [...accounts].sort((a, b) => Number(b.nextChosen === true) - Number(a.nextChosen === true)
    || Number(mobileAccountState(b, active) === "active") - Number(mobileAccountState(a, active) === "active"));

  /* Making an account the default switches future launches and leaves a
     receipt that switches back. */
  const makeDefault = async (account: AccountOption) => {
    const before = active;
    const ok = await state.select(account.id);
    if (ok) receipts.show(t("mobile2.accounts.switched", { label: account.label }), { kind: "switchBack", run: () => void state.select(before) });
    return ok;
  };
  /* A sign-in tap opens the device sign-in and nothing else: the account it
     names never becomes the default here (P2-8, README §4.8). It returns
     that way — by signing in — and the next list read is what says so. */
  const signIn = useAccountSignIn(state, receipts);
  const surface: RowSurface = {
    state, now, wide: accounts.some((account) => accountQuota(account, now).tiers.length > 0), phone: true,
    openId, setOpenId, loginBusy, signIn, makeDefault, receipts, focusId: focusAccountId,
  };
  /* Accounts an install transfer brought, as on the desktop dialog: re-read
     whenever a sign-in here changes, since a sign-in settles its row. */
  const imported = useImportedAccounts(engine, accounts.map((account) => `${account.id}:${account.authPresent ? 1 : 0}`).join(","));

  return (
    <section data-mobile2-accounts-engine={engine} aria-label={t("accounts.titleFor", { engine: engineName })}>
      <div className="flex min-h-[34px] items-center gap-1.5 px-3 pt-1.5 text-label font-semibold text-secondary">
        {engineName}
        <span className="text-caption font-semibold tabular-nums text-muted">{accounts.length}</span>
        <LimitsCaption className="ml-auto text-[12px] font-normal" />
      </div>
      {/* The phone has no footer slot: the removal answer leads the section. */}
      <RemovalOutcome state={state} phone />
      <TransferAccountsChecklist
        variant="phone"
        engine={engine}
        rows={imported.rows}
        onSignIn={async (accountId) => {
          const account = accounts.find((candidate) => candidate.id === accountId);
          if (account) signIn.start(account);
          await imported.reload();
        }}
        onAction={async (body) => {
          await imported.post(body);
          if (body.action === "verify" || body.action === "retry") await state.refresh();
          await imported.reload();
        }}
      />
      {status === "loading" && accounts.length === 0 ? <AccountRowsSkeleton className="px-1 pb-2" /> : null}
      {status !== "loading" && accounts.length === 0 ? <div className="px-3 pb-2 text-label text-muted">{t("mobile2.accounts.noAccounts", { engine: engineName })}</div> : null}
      {ordered.length > 0 ? (
        <div data-mobile2-accounts-list className="mx-3 mb-1.5 divide-y divide-border/40 overflow-hidden rounded-[12px] bg-card ring-1 ring-inset ring-border">
          {ordered.map((account) => <AccountRow key={account.id} account={account} engine={engine} quota={accountQuota(account, now)} surface={surface} />)}
        </div>
      ) : null}
      {notice?.kind === "error" ? (
        <div role="alert" data-mobile2-accounts-notice className="mx-3 mb-1.5 flex items-center gap-2 pl-3 text-label text-danger">
          <span className="min-w-0 flex-1 leading-snug">{accountNoticeText(t, notice)}</span>
          {notice.action ? (
            <button type="button" disabled={state.mutation !== null} className={`${MOBILE_ACTION} shrink-0`} onClick={() => void state.retryNotice()}>
              {t("accounts.retry")}
            </button>
          ) : null}
        </div>
      ) : null}
      <MobileAddAccountRow state={state} engineName={engineName} loginBusy={loginBusy} />
      <HiddenAccountOffers state={state} phone className="mx-3 mb-1.5 pl-3" />
      {engine === "claude" ? <ClaudeProviderEditor state={state} phone /> : null}
    </section>
  );
}

/** The screen's body over given engine states — the shape the tests drive. */
export function MobileAccountsBody({ engines, now, focusAccountId = null, receipts = tabReceipts, nextChosenAccountIds }: {
  engines: EngineAccountsState[];
  /** Unix seconds the reset ETAs and staleness are read against. */
  now: number;
  /** The account a badge tap steered here (issue #229): scrolled to and ringed. */
  focusAccountId?: string | null;
  receipts?: ReceiptStore;
  /** The project route's shared selector result, keyed by engine. */
  nextChosenAccountIds?: Partial<Record<"claude" | "codex", string | null>>;
}) {
  const projected = nextChosenAccountIds
    ? engines.map((state) => ({
        ...state,
        accounts: state.accounts.map((account) => ({
          ...account,
          nextChosen: nextChosenAccountIds[state.engine] === account.id,
        })),
      }))
    : engines;
  return (
    <div data-mobile2-accounts-body className="flex flex-col pb-5 pt-1">
      {projected.map((state) => <MobileEngineSection key={state.engine} state={state} now={now} focusAccountId={focusAccountId} receipts={receipts} />)}
    </div>
  );
}

/** Keeps the project's read-only router choice aligned with the account rows
    shown on the phone. A new reading, account set, or presentation minute
    invalidates the prior response while the route is re-read. */
export function ProjectAwareMobileAccountsBody({ engines, now, project, focusAccountId = null, receipts = tabReceipts }: {
  engines: EngineAccountsState[];
  now: number;
  project?: string | null;
  focusAccountId?: string | null;
  receipts?: ReceiptStore;
}) {
  const [nextChoice, setNextChoice] = useState<{ key: string; ids: Partial<Record<"claude" | "codex", string | null>> } | null>(null);
  const key = project ? JSON.stringify([project, now, ...engines.map((state) => [state.engine, state.identityVersion, state.limitsVersion,
    state.accounts.map((account) => [account.id, account.authPresent, account.authHealth, account.loginState])])]) : "";
  useEffect(() => {
    if (!project) return;
    let live = true;
    void (async () => {
      try {
        const response = await fetch(`/api/account-project-bindings?project=${encodeURIComponent(project)}`, { cache: "no-store" });
        if (!response.ok) return;
        const payload: unknown = await response.json();
        if (!payload || typeof payload !== "object") return;
        const blocks = (payload as { engines?: unknown }).engines;
        if (!blocks || typeof blocks !== "object") return;
        const ids: Partial<Record<"claude" | "codex", string | null>> = {};
        for (const engine of ["claude", "codex"] as const) {
          const block = (blocks as Record<string, unknown>)[engine];
          if (block && typeof block === "object") {
            const id = (block as { nextChosenAccountId?: unknown }).nextChosenAccountId;
            if (typeof id === "string" || id === null) ids[engine] = id;
          }
        }
        if (live) setNextChoice({ key, ids });
      } catch {
        // Keep account rows usable when the project view is unavailable.
      }
    })();
    return () => { live = false; };
  }, [key, project]);
  const ids = nextChoice?.key === key && project ? nextChoice.ids : undefined;
  return <MobileAccountsBody engines={engines} now={now} focusAccountId={focusAccountId} receipts={receipts} nextChosenAccountIds={ids} />;
}

/** The screen the shell mounts under its bar: both engines' stores, the
    presentation clock, and the focus a badge asked for. */
export function MobileAccountsPanel({ receipts, project }: { receipts?: ReceiptStore; project?: string | null }) {
  const claude = useEngineAccounts("claude");
  const codex = useEngineAccounts("codex");
  const [focus, setFocus] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const pending = consumePendingAccountPanel("claude") ?? consumePendingAccountPanel("codex");
    // This mount-only value comes from the external account-navigation queue.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- restore focus from the surface that opened this screen.
    if (pending) setFocus(pending.accountId);
    return onAccountPanelRequest((request) => setFocus(request.accountId));
  }, []);
  return <ProjectAwareMobileAccountsBody engines={[claude, codex]} now={now} project={project} focusAccountId={focus} receipts={receipts} />;
}
