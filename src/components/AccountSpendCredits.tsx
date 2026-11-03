"use client";

import type { AccountOption, EngineAccountsState } from "@/hooks/useEngineAccounts";
import { useLocale } from "@/lib/i18n";

export function AccountSpendCredits({ account, state }: { account: AccountOption; state: EngineAccountsState }) {
  const { t } = useLocale();
  if (state.engine !== "codex") return null;
  const paid = account.paidCredits;
  return <div className="px-3 pb-2 text-[11px]" data-account-spend-credits={account.id}>
    <label className="flex min-h-[44px] cursor-pointer items-center gap-2">
      <input type="checkbox" role="switch" checked={account.spendCredits === true}
        onChange={event => void state.setSpendCredits?.(account.id, event.target.checked)} />
      <span>{t("accounts.spendCredits")}</span>
    </label>
    <p className="break-words text-muted">{t("accounts.paidBalance", { balance: paid?.balance ?? t("accounts.balanceUnknown") })}</p>
    <p className="break-words text-muted">{paid?.checkedAt ? t("accounts.paidChecked", { at: paid.checkedAt }) : t("accounts.paidNeverRead")}</p>
    {account.spendCreditsError ? <p role="alert" className="mt-1 text-danger">{t("accounts.spendCreditsFailed")}</p> : null}
  </div>;
}
