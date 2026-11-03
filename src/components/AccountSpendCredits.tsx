"use client";

import { useEffect, useId, useRef } from "react";
import type { AccountOption, EngineAccountsState } from "@/hooks/useEngineAccounts";
import { useLocale, type Locale } from "@/lib/i18n";
import { SettingSwitch } from "./ProjectSettingRow";
import { formatCheckedClock } from "./rateLimit";

/** Paid spending is on and the account still holds a positive balance: past its plan limit it keeps working. */
export function paidSpendingActive(account: AccountOption): boolean {
  return account.spendCredits === true && Number(account.paidCredits?.balance) > 0;
}

/** The balance in the reader's number format, keeping the decimals the reading carries. */
export function formatPaidBalance(balance: string, locale: Locale): string {
  const value = Number(balance);
  if (!Number.isFinite(value)) return balance;
  const decimals = Math.min(6, balance.split(".")[1]?.length ?? 0);
  return new Intl.NumberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);
}

/**
 * The paid-spending switch on a Codex account's row. `phone` draws it on the
 * phone card, whose content edge is the card's own padding; the panel aligns
 * it with the row's limits block.
 */
export function AccountSpendCredits({ account, state, phone = false }: { account: AccountOption; state: EngineAccountsState; phone?: boolean }) {
  const { t, locale } = useLocale();
  const switchId = useId();
  const labelId = useId();
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
  // Turning the switch on adds the warning and the balance below it: keep both
  // whole in the scroller, since the warning is the line that says money is spent.
  useEffect(() => {
    if (enabled && !wasEnabled.current) detailRef.current?.scrollIntoView?.({ block: "nearest" });
    wasEnabled.current = enabled;
  }, [enabled]);
  if (state.engine !== "codex") return null;
  const paid = account.paidCredits;
  const readAt = paid?.checkedAt && !Number.isNaN(new Date(paid.checkedAt).getTime()) ? formatCheckedClock(paid.checkedAt) : null;
  const balance = paid?.balance
    ? readAt ? t("accounts.paidBalanceRead", { balance: formatPaidBalance(paid.balance, locale), at: readAt }) : t("accounts.paidBalance", { balance: formatPaidBalance(paid.balance, locale) })
    : t("accounts.paidNone");
  const text = phone ? "text-label" : "text-[10px] leading-snug";
  return <div className={`${phone ? "pb-1 pr-2" : "px-3.5 pb-1 pl-[30px]"} ${text}`} data-account-spend-credits={account.id}>
    <div className="flex min-h-[44px] items-center gap-2 sm:min-h-8">
      {/* Named by the switch through aria-labelledby, never a <label for>: the
          blank width of the row must not turn paid spending on. */}
      <span id={labelId} className="min-w-0 flex-1 text-[12px] font-semibold text-primary">{t("accounts.spendCredits")}</span>
      <SettingSwitch id={switchId} aria-labelledby={labelId} enabled={enabled} size="responsive"
        onClick={() => void state.setSpendCredits?.(account.id, !enabled)} />
    </div>
    <div ref={detailRef}>
      {enabled ? <p className="break-words text-secondary">{t("accounts.spendCreditsOn")}</p> : null}
      <p className="break-words text-muted">{balance}</p>
      {failed ? <p ref={alertRef} role="alert" className="mt-1 break-words text-danger">{t("accounts.spendCreditsFailed")}</p> : null}
    </div>
  </div>;
}
