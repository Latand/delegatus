"use client";

import { useEffect, useId, useRef } from "react";
import type { AccountOption, EngineAccountsState } from "@/hooks/useEngineAccounts";
import { useLocale, type Locale } from "@/lib/i18n";
import type { ReconciledQuota } from "@/lib/rateLimit";
import { SettingSwitch } from "./ProjectSettingRow";
import { formatCheckedClock, formatReadClock } from "./rateLimit";

/** Paid spending is on and the account still holds a positive balance: past its plan limit it keeps working. */
export function paidSpendingActive(account: AccountOption): boolean {
  return account.spendCredits === true && Number(account.paidCredits?.balance) > 0;
}

/** Whole percent left of the row's tightest governing window (session or weekly), as the row's limit lines read it. Null without a reading. */
export function limitLeftPercent(quota: ReconciledQuota | null | undefined): number | null {
  if (!quota) return null;
  const left = [quota.session, quota.weekly].flatMap(window => window ? [Math.round(Math.max(0, Math.min(100, 100 - window.value.usedPercent)))] : []);
  return left.length ? Math.min(...left) : null;
}

/** Paid credits are only worth a row of their own near the end of the limit, or while spending is on and needs its off switch. */
export const CREDITS_BLOCK_LIMIT_LEFT_PERCENT = 5;

export function showsCreditsBlock(account: AccountOption, quota: ReconciledQuota | null | undefined): boolean {
  if (account.spendCredits === true) return true;
  const left = limitLeftPercent(quota);
  return Number(account.paidCredits?.balance) > 0 && left !== null && left <= CREDITS_BLOCK_LIMIT_LEFT_PERCENT;
}

/** The balance as whole credits in the reader's digit grouping: a balance under one credit reads "<1", zero reads 0. Display only. */
export function formatPaidBalance(balance: string, locale: Locale): string {
  const value = Number(balance);
  if (!Number.isFinite(value)) return balance;
  if (value > 0 && value < 1) return "<1";
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.round(value) + 0);
}

/**
 * The paid-spending line on a Codex account's row: "Credits", the balance in
 * whole credits and the switch, with the save failure under it. It draws only
 * while the account holds paid credits and its tightest window has 5% or less
 * left, or while the switch is on. What spending does while on is the open
 * row's line (`spendCreditsOnShort`). `phone` takes the sheet's 44 px switch;
 * `column` is the width of the row's label column, so "Credits" stands in the
 * column the window labels use.
 */
export function AccountSpendCredits({ account, state, quota, phone = false, column = "", className = "" }: {
  account: AccountOption;
  state: EngineAccountsState;
  quota: ReconciledQuota | null;
  phone?: boolean;
  column?: string;
  /** The row's type and its last-line slack. */
  className?: string;
}) {
  const { t, locale } = useLocale();
  const switchId = useId();
  const alertRef = useRef<HTMLParagraphElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const failed = account.spendCreditsError === true;
  const enabled = account.spendCredits === true;
  const wasEnabled = useRef(enabled);
  // The error sits at the end of the row, which can be below the scroller's
  // fold: bring it fully into view when it appears.
  useEffect(() => {
    if (failed) alertRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [failed]);
  // Turning the switch on adds a line to the open row: keep the row whole in
  // the scroller.
  useEffect(() => {
    if (enabled && !wasEnabled.current) detailRef.current?.scrollIntoView?.({ block: "nearest" });
    wasEnabled.current = enabled;
  }, [enabled]);
  if (state.engine !== "codex" || !showsCreditsBlock(account, quota)) return null;
  const paid = account.paidCredits;
  const checked = quota ? limitsCheckedClock(quota) : null;
  const readAt = paid?.checkedAt && !Number.isNaN(new Date(paid.checkedAt).getTime()) ? formatReadClock(paid.checkedAt) : null;
  // A read time earns its words only when it differs from the limits' check time.
  const shownRead = readAt && readAt !== checked ? readAt : null;
  return (
    <div ref={detailRef} data-account-spend-credits={account.id} className={className}>
      <div data-account-line className={`flex items-center gap-2 ${phone ? "min-h-11" : "min-h-6"}`}>
        {/* The switch carries its own name; the word beside it is no <label for>, so the blank width of the row cannot turn paid spending on. */}
        <span className={`${column} shrink-0 font-semibold text-secondary`}>{t("accounts.credits")}</span>
        <span className="min-w-0 flex-1 break-words text-muted">
          <span data-account-balance className="font-bold tabular-nums text-primary">{paid?.balance ? formatPaidBalance(paid.balance, locale) : t("accounts.paidNone")}</span>
          {shownRead ? ` · ${t("accounts.paidRead", { at: shownRead })}` : ""}
        </span>
        <SettingSwitch id={switchId} aria-label={t("accounts.spendCredits")} enabled={enabled} size={phone ? "sheet" : "row"}
          onClick={() => void state.setSpendCredits?.(account.id, !enabled)} />
      </div>
      {failed ? <p ref={alertRef} role="alert" className="break-words text-danger">{t("accounts.spendCreditsFailed")}</p> : null}
    </div>
  );
}

/** The clock time the row's limits were read, in the form the "Checked" line shows it. */
function limitsCheckedClock(quota: ReconciledQuota): string | null {
  const observed = [quota.session, quota.weekly, ...quota.tiers].flatMap((window) => window?.observedAt != null ? [window.observedAt] : []);
  return observed.length ? formatCheckedClock(new Date(Math.min(...observed) * 1000).toISOString()) : null;
}
