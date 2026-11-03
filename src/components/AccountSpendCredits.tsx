"use client";

import { useEffect, useId, useRef } from "react";
import type { AccountOption, EngineAccountsState } from "@/hooks/useEngineAccounts";
import { useLocale } from "@/lib/i18n";
import { SettingSwitch } from "./ProjectSettingRow";
import { formatCheckedClock } from "./rateLimit";

/**
 * The paid-spending switch on a Codex account's row. `phone` draws it on the
 * phone card, whose content edge is the card's own padding; the panel aligns
 * it with the row's limits block.
 */
export function AccountSpendCredits({ account, state, phone = false }: { account: AccountOption; state: EngineAccountsState; phone?: boolean }) {
  const { t } = useLocale();
  const switchId = useId();
  const alertRef = useRef<HTMLParagraphElement>(null);
  const failed = account.spendCreditsError === true;
  // The error sits at the end of the row, which can be below the scroller's
  // fold: bring it fully into view when it appears.
  useEffect(() => {
    if (failed) alertRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [failed]);
  if (state.engine !== "codex") return null;
  const enabled = account.spendCredits === true;
  const paid = account.paidCredits;
  const readAt = paid?.checkedAt && !Number.isNaN(new Date(paid.checkedAt).getTime()) ? formatCheckedClock(paid.checkedAt) : null;
  const balance = paid?.balance
    ? readAt ? t("accounts.paidBalanceRead", { balance: paid.balance, at: readAt }) : t("accounts.paidBalance", { balance: paid.balance })
    : t("accounts.paidNone");
  const text = phone ? "text-label" : "text-[10px] leading-snug";
  return <div className={`${phone ? "pb-1 pr-2" : "px-3.5 pb-1 pl-[30px]"} ${text}`} data-account-spend-credits={account.id}>
    <div className="flex min-h-[44px] items-center gap-2 sm:min-h-8">
      <label htmlFor={switchId} className="min-w-0 flex-1 cursor-pointer text-[12px] font-semibold text-primary">{t("accounts.spendCredits")}</label>
      <SettingSwitch id={switchId} enabled={enabled} size="responsive"
        onClick={() => void state.setSpendCredits?.(account.id, !enabled)} />
    </div>
    {enabled ? <p className="break-words text-secondary">{t("accounts.spendCreditsOn")}</p> : null}
    <p className="break-words text-muted">{balance}</p>
    {failed ? <p ref={alertRef} role="alert" className="mt-1 break-words text-danger">{t("accounts.spendCreditsFailed")}</p> : null}
  </div>;
}
