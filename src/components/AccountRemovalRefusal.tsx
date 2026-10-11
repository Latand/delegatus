"use client";

import { TriangleAlert } from "lucide-react";
import { useEffect, useRef } from "react";

import type { AccountRefusalReason, AccountRemovalLiveWork, AccountRemovalRefusal as Refusal } from "@/hooks/useEngineAccounts";
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

/** The deep link that opens one conversation, where its own controls stop
    the agent or move it to another account; a launch with no conversation
    yet opens by its transcript path. */
export function liveWorkHref(work: AccountRemovalLiveWork): string | null {
  if (work.conversationId) return `#c=${encodeURIComponent(work.conversationId)}`;
  return work.path ? `#f=${encodeURIComponent(work.path)}` : null;
}

function liveWorkName(work: AccountRemovalLiveWork): string {
  if (work.title) return work.title;
  const file = work.path?.split("/").filter(Boolean).at(-1);
  return file ?? work.conversationId ?? "";
}

/** The live work behind a refusal, each item a link into its conversation. */
function LiveWorkList({ refusal, phone }: { refusal: Refusal; phone: boolean }) {
  const { t } = useLocale();
  const sessions = refusal.sessions ?? [];
  if (sessions.length === 0) return null;
  const more = (refusal.sessionCount ?? sessions.length) - sessions.length;
  return (
    <div data-account-refusal-sessions className="flex min-w-0 flex-col gap-0.5">
      <p>{t("accounts.refusal.sessionsLead")}</p>
      <ul className="flex min-w-0 flex-col">
        {sessions.map((work) => {
          const href = liveWorkHref(work);
          const name = liveWorkName(work);
          return (
            <li key={href ?? name} className="min-w-0">
              {href ? (
                <a
                  href={href}
                  data-account-refusal-session={work.conversationId ?? work.path ?? ""}
                  title={name}
                  className={`inline-flex max-w-full items-center rounded-[5px] font-semibold text-accent underline underline-offset-2 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${phone ? "min-h-[44px] min-w-[44px]" : "min-h-[44px] sm:min-h-[22px]"}`}
                >
                  <span className="break-words">{name}</span>
                </a>
              ) : <span className="break-words">{name}</span>}
            </li>
          );
        })}
      </ul>
      {more > 0 ? <p className="text-secondary">{t("accounts.refusal.sessionsMore", { count: more })}</p> : null}
    </div>
  );
}

/**
 * Why a removal did not happen (#1857 §5.2): one message per server answer,
 * inside the refused row, never clamped. Several blockers draw as several
 * lines in one block. Live work is named under them, each item a link into
 * the conversation that stops or moves it. A failed file step offers Try
 * again, a missing answer Refresh and an open sign-in Cancel sign-in; the ✕
 * closes it, as does the next attempt. A new
 * answer scrolls its whole block into view, so a refusal on a row near the
 * bottom of the scrolling list never lands below the fold.
 */
export function AccountRemovalRefusal({ refusal, phone = false, inset = true, disabled, onDismiss, onRetry, onRefresh, onCancelSignIn }: {
  refusal: Refusal;
  /** Full card width with a 44 px ✕ on the phone screen. */
  phone?: boolean;
  /** Indented under the row's label, as in the accounts panel. A narrow card
      (the Copilot list in the rail footer) draws it at its full width. */
  inset?: boolean;
  disabled: boolean;
  onDismiss: () => void;
  onRetry: () => void;
  onRefresh: () => void;
  /** Ends the open sign-in a `login_pending` refusal names. */
  onCancelSignIn?: () => void;
}) {
  const { t } = useLocale();
  const block = useRef<HTMLDivElement>(null);
  useEffect(() => {
    block.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [refusal]);
  const action = refusal.reasons.includes("removal_failed")
    ? { label: t("accounts.refusal.retry"), run: onRetry }
    : refusal.reasons.includes("no_answer")
      ? { label: t("accounts.refusal.refresh"), run: onRefresh }
      : refusal.reasons.includes("login_pending") && onCancelSignIn
        ? { label: t("accounts.refusal.cancelSignIn"), run: onCancelSignIn }
        : null;
  return (
    <div
      ref={block}
      role="alert"
      data-account-refusal={refusal.accountId}
      className={`flex items-start gap-2 rounded-[8px] bg-danger-soft py-2.5 pl-3 ${phone ? "mb-1.5 mr-2 pr-1" : inset ? "mb-2 ml-[30px] mr-3.5 pr-1.5" : "pr-1.5"}`}
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
        <LiveWorkList refusal={refusal} phone={phone} />
        {action ? (
          <div>
            <button
              type="button"
              disabled={disabled}
              onClick={action.run}
              className={phone
                ? "-my-3 inline-flex min-h-[44px] min-w-[44px] items-center rounded-[6px] text-[11px] font-semibold text-accent underline underline-offset-2 disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                : "inline-flex min-h-[44px] items-center rounded-[6px] border border-border bg-canvas px-2 text-[10.5px] font-semibold text-primary hover:bg-sunken disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-[24px]"}
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
