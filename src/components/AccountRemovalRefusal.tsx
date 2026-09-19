"use client";

import { TriangleAlert } from "lucide-react";

import type { AccountRefusalReason, AccountRemovalRefusal as Refusal } from "@/hooks/useEngineAccounts";
import { type MessageKey, type TFunction, useLocale } from "@/lib/i18n";

import { ArchivePath } from "./AccountRemovalSummary";
import { X } from "./icons";

const REASON_KEY = {
  live_sessions: "accounts.refusal.live_sessions",
  login_pending: "accounts.refusal.login_pending",
  queued_pin: "accounts.refusal.queued_pin",
  current_conversations: "accounts.refusal.current_conversations",
  unsafe_home: "accounts.refusal.unsafe_home",
  archive_unavailable: "accounts.refusal.archive_unavailable",
  accounts_locked: "accounts.refusal.accounts_locked",
  unknown_account: "accounts.refusal.unknown_account",
  removal_failed: "accounts.refusal.removal_failed",
  no_answer: "accounts.refusal.no_answer",
} as const satisfies Record<AccountRefusalReason, MessageKey>;

/** The message key one refusal reason reads as; `removal_failed` names its
    errno when the server sent one. */
export function refusalMessageKey(reason: AccountRefusalReason, errno?: string): MessageKey {
  return reason === "removal_failed" && errno ? "accounts.refusal.removal_failedErrno" : REASON_KEY[reason];
}

export function refusalText(t: TFunction, refusal: Refusal, reason: AccountRefusalReason): string {
  return t(refusalMessageKey(reason, refusal.errno), { label: refusal.label, errno: refusal.errno ?? "" });
}

/**
 * Why a removal did not happen (#1857 §5.2): one message per server answer,
 * inside the refused row, never clamped. Several blockers draw as several
 * lines in one block. A failed file step offers Try again and a missing
 * answer offers Refresh; the ✕ closes it, as does the next attempt.
 */
export function AccountRemovalRefusal({ refusal, phone = false, disabled, onDismiss, onRetry, onRefresh }: {
  refusal: Refusal;
  /** Full card width with a 44 px ✕ on the phone screen. */
  phone?: boolean;
  disabled: boolean;
  onDismiss: () => void;
  onRetry: () => void;
  onRefresh: () => void;
}) {
  const { t } = useLocale();
  const action = refusal.reasons.includes("removal_failed")
    ? { label: t("accounts.refusal.retry"), run: onRetry }
    : refusal.reasons.includes("no_answer")
      ? { label: t("accounts.refusal.refresh"), run: onRefresh }
      : null;
  return (
    <div
      role="alert"
      data-account-refusal={refusal.accountId}
      className={`flex items-start gap-2 rounded-[8px] bg-danger-soft py-2.5 pl-3 ${phone ? "mb-1.5 mr-2 pr-1" : "mb-2 ml-[30px] mr-3.5 pr-1.5"}`}
    >
      <TriangleAlert className="mt-[2px] h-[13px] w-[13px] shrink-0 text-danger" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 text-[11px] leading-[1.45] text-primary">
        {refusal.reasons.map((reason) => (
          <div key={reason} data-account-refusal-reason={reason} className="flex min-w-0 flex-col gap-1">
            <p className="break-words">{refusalText(t, refusal, reason)}</p>
            {reason === "archive_unavailable" ? (
              <>
                {refusal.archive ? <ArchivePath path={refusal.archive} copyLabel={t("accounts.refusal.copyPath")} phone={phone} /> : null}
                <p>{t("accounts.refusal.archive_unavailableAfter")}</p>
              </>
            ) : null}
          </div>
        ))}
        {action ? (
          <div>
            <button
              type="button"
              disabled={disabled}
              onClick={action.run}
              className={`inline-flex items-center rounded-[6px] border border-border bg-canvas px-2 text-[10.5px] font-semibold text-primary hover:bg-sunken disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${phone ? "min-h-[44px]" : "min-h-[44px] sm:min-h-[24px]"}`}
            >
              {action.label}
            </button>
          </div>
        ) : null}
      </div>
      <button
        type="button"
        aria-label={t("accounts.refusal.dismiss")}
        onClick={onDismiss}
        className={`inline-flex shrink-0 items-center justify-center rounded-[6px] text-muted hover:bg-canvas/60 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${phone ? "-my-2 h-11 w-11" : "-mt-0.5 h-11 w-11 sm:h-5 sm:w-5"}`}
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
    </div>
  );
}
