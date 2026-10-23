"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { hiddenAccountsOf, removalRefusalOf, type AccountRemovalRefusal as Refusal, type HiddenAccount } from "@/hooks/useEngineAccounts";
import { consumePendingAccountPanel, onAccountPanelRequest } from "@/lib/accounts/openPanel";
import { useLocale } from "@/lib/i18n";
import type { EngineLimits } from "@/lib/types";

import { AccountRemovalRefusal } from "./AccountRemovalRefusal";
import { TransferAccountsChecklist, useImportedAccounts } from "./TransferAccountsChecklist";
import { HiddenAccountOffer } from "./AccountRemovalSummary";
import { engineTintOf } from "./utils";
import { barColor, LimitWindowLine, quotaAsOfHint } from "./LimitRow";
import { LINE_EDGE, ReserveBar, type SidebarFooterDensity } from "./railFooterDensity";
import { windowLabel } from "./rateLimit";

/** GitHub Copilot account switcher and monthly allowance in the footer. */

export interface CopilotAccountRow {
  id: string;
  label: string;
  kind: "legacy" | "managed";
  active: boolean;
  auth: "signed_in" | "signed_out" | "unknown";
  "user": string | null;
  loginCommand: string | null;
  login: { operationId: string; phase: string; loginUrl: string | null; userCode?: string | null; deadlineAt: string } | null;
}

export interface CopilotAccountsBody {
  cli: { present: boolean; reason: string | null };
  active: string;
  accounts: CopilotAccountRow[];
  /** The default home the operator removed, offered back in account setup. */
  hidden?: HiddenAccount[];
  error?: string;
}

/** What a press expects the list to become, computed over whatever list it lands on. */
type Prediction = (held: CopilotAccountsBody) => CopilotAccountsBody;

function isBody(value: unknown): value is CopilotAccountsBody {
  const body = value as Partial<CopilotAccountsBody> | null;
  return Boolean(body && typeof body === "object" && body.cli && Array.isArray(body.accounts));
}

const LIVE_LOGIN_PHASES = ["starting", "awaiting_browser", "awaiting_storage_choice", "verifying", "canceling"];

/** The Copilot account list and its actions, shared by the footer's switcher
    and the setup guide's Engines step (#2166): one sign-in implementation. */
export function useCopilotAccounts({ polling, onChanged }: { polling: boolean; onChanged?: () => void }) {
  const { t } = useLocale();
  /* The last list the server gave, and the predictions still on their way: the
     drawn list is the stored one with each prediction laid over it in press
     order, so a refusal drops only its own. */
  const [served, setBody] = useState<CopilotAccountsBody | null>(null);
  const [presses, setPresses] = useState<ReadonlyArray<{ id: number; predict: Prediction }>>([]);
  const pressCount = useRef(0);
  const body = useMemo(() => (served ? presses.reduce((held, press) => press.predict(held), served) : null), [served, presses]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/accounts/copilot");
      const next: unknown = await response.json();
      if (isBody(next)) setBody(next);
    } catch { /* the row stays as it was */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!polling || !body?.accounts.some((account) => account.login && LIVE_LOGIN_PHASES.includes(account.login.phase))) return;
    const timer = window.setInterval(() => void load(), 1000);
    return () => window.clearInterval(timer);
  }, [polling, body, load]);

  /* `predicted`, when given, is laid over the list before the request and taken
     off on a refusal (audit B33, B37); `settled` names a refusal status that means the
     change already holds, so the list is read again instead. */
  const post = async (payload: Record<string, unknown>, predicted?: Prediction, settled?: number): Promise<boolean> => {
    setError(null);
    const mine = ++pressCount.current;
    if (predicted) setPresses((held) => [...held, { id: mine, predict: predicted }]);
    try {
      const response = await fetch("/api/accounts/copilot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const next: unknown = await response.json().catch(() => null);
      if (!response.ok && response.status === settled) {
        void load();
        onChanged?.();
        return true;
      }
      if (!response.ok) {
        setError((next as { error?: string } | null)?.error ?? t("copilot.accounts.failed"));
        return false;
      }
      if (isBody(next)) {
        setBody(next);
        onChanged?.();
      }
      return true;
    } catch {
      setError(t("copilot.accounts.failed"));
      return false;
    } finally {
      if (predicted) setPresses((held) => held.filter((press) => press.id !== mine));
    }
  };

  /* The remove control every engine shares: a refusal names what to end first,
     a removal answers with the list as it now stands. */
  const remove = async (account: CopilotAccountRow) => {
    setError(null);
    setRefusal(null);
    let response: Response;
    try {
      response = await fetch("/api/accounts/copilot", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: account.id }),
      });
    } catch {
      setRefusal(removalRefusalOf(account.id, account.label, null, null));
      return;
    }
    const next: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      setRefusal(removalRefusalOf(account.id, account.label, response.status, next));
      void load();
      return;
    }
    if (isBody(next)) {
      setBody(next);
      onChanged?.();
    }
  };

  const copy = async (account: CopilotAccountRow) => {
    if (!account.loginCommand) return;
    try {
      await navigator.clipboard.writeText(account.loginCommand);
      setCopied(account.id);
    } catch {
      setError(t("copilot.accounts.copyFailed"));
    }
  };

  return { body, error, copied, refusal, load, post, copy, remove, dismissRefusal: () => setRefusal(null) };
}

export type CopilotAccounts = ReturnType<typeof useCopilotAccounts>;

/** Whether a Copilot account can run agents: its credential answered signed in. */
export function copilotSignedIn(body: CopilotAccountsBody | null): CopilotAccountRow | null {
  const signedIn = body?.accounts.filter((account) => account.auth === "signed_in") ?? [];
  return signedIn.find((account) => account.active) ?? signedIn[0] ?? null;
}

/** Every Copilot account with its sign-in, then the add row. */
export function CopilotAccountList({ accounts }: { accounts: CopilotAccounts }) {
  const { t } = useLocale();
  const { body, error, copied, refusal, load, post, copy, remove, dismissRefusal } = accounts;
  const [restoring, setRestoring] = useState(false);
  /* The "active" badge moves on the press; both rows' Use waits for the answer. */
  const [selecting, setSelecting] = useState(false);
  const select = (id: string) => {
    if (!body || selecting) return;
    setSelecting(true);
    void post({ action: "select", id }, (held) => ({ ...held, active: id, accounts: held.accounts.map((account) => ({ ...account, active: account.id === id })) }))
      .finally(() => setSelecting(false));
  };
  const [label, setLabel] = useState("");
  /* Removal arms on the first click and runs on the confirm, as in the
     Claude and Codex lists. */
  const [armed, setArmed] = useState<string | null>(null);
  /* Copilot accounts an install transfer brought (install-memory-transfer
     §3.4, §5.2): Copilot has no limit read, so a row is ready once its
     account shows as signed in; a completed sign-in settles it by itself. */
  const imported = useImportedAccounts("copilot", (body?.accounts ?? []).map((account) => `${account.id}:${account.auth}`).join(","));
  if (!body) return null;
  return (
    <>
      {!body.cli.present && body.cli.reason ? <p className="text-muted">{body.cli.reason}</p> : null}
      <TransferAccountsChecklist
        variant="inline"
        engine="copilot"
        rows={imported.rows}
        onSignIn={async (accountId) => { await post({ action: "login", id: accountId }); await imported.reload(); }}
        onAction={async (action) => { await imported.post(action); if (action.action !== "not_needed") await load(); await imported.reload(); }}
      />
      <p className="text-muted">{t("copilot.accounts.hint")}</p>
      {body.accounts.map((account) => (
        <div key={account.id} data-copilot-account={account.id} className="flex flex-col gap-1 rounded-md border border-border bg-card px-2 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            {/* The name keeps its width; a long sign-in line gives way and truncates (its full text in the title). */}
            <span className="min-w-0 max-w-[60%] shrink-0 truncate font-semibold text-primary" title={account.label}>{account.label}</span>
            {(() => {
              const status = account.auth === "signed_in" ? t("copilot.accounts.signedIn", { user: account.user ?? "" }) : account.auth === "signed_out" ? t("copilot.accounts.signedOut") : t("copilot.accounts.unknown");
              return <span data-copilot-account-status="" className="min-w-0 flex-1 truncate text-right text-[10px] text-muted" title={status}>{status}</span>;
            })()}
            {account.active ? (
              <span className="shrink-0 text-[10px] font-semibold text-muted">{t("copilot.accounts.active")}</span>
            ) : (
              <button type="button" disabled={selecting} className="shrink-0 rounded px-1.5 text-[10.5px] font-semibold text-accent hover:bg-accent-soft disabled:opacity-45" onClick={() => select(account.id)}>
                {t("copilot.accounts.use")}
              </button>
            )}
          </div>
          {account.kind === "managed" && account.auth !== "signed_in" && (!account.login || !LIVE_LOGIN_PHASES.includes(account.login.phase)) ? (
            <button type="button" data-copilot-signin={account.id} className="self-start rounded px-1.5 py-0.5 text-[10.5px] font-semibold text-accent hover:bg-accent-soft" onClick={() => void post({ action: "login", id: account.id })}>
              {t("copilot.accounts.signIn")}
            </button>
          ) : null}
          {account.login?.phase === "starting" || account.login?.phase === "verifying" || account.login?.phase === "canceling" ? (
            <div className="flex items-center gap-2 text-[10.5px] text-muted">
              <span>{account.login.phase === "starting" ? t("copilot.accounts.login.starting") : account.login.phase === "verifying" ? t("copilot.accounts.login.verifying") : t("copilot.accounts.login.canceling")}</span>
              {account.login.phase !== "canceling" ? <button type="button" className="rounded px-1.5 text-accent hover:bg-accent-soft" onClick={() => void post({ action: "cancel-login", operationId: account.login!.operationId })}>{t("copilot.accounts.cancel")}</button> : null}
            </div>
          ) : null}
          {account.login?.phase === "awaiting_browser" ? (
            <div className="flex flex-wrap items-center gap-2 text-[10.5px]">
              <a href={account.login.loginUrl ?? undefined} target="_blank" rel="noreferrer noopener" className="font-semibold text-accent underline">{t("copilot.accounts.openLogin")}</a>
              {account.login.userCode ? <><span className="text-muted">{t("copilot.accounts.codeLabel")}</span><code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-primary">{account.login.userCode}</code></> : null}
              <button type="button" className="rounded px-1.5 text-accent hover:bg-accent-soft" onClick={() => void post({ action: "cancel-login", operationId: account.login!.operationId })}>{t("copilot.accounts.cancel")}</button>
            </div>
          ) : null}
          {account.login?.phase === "awaiting_storage_choice" ? (
            <div className="flex flex-col gap-1.5 text-[10.5px]">
              <span className="text-muted">{t("copilot.accounts.login.plaintextWarning")}</span>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className="rounded px-1.5 text-accent hover:bg-accent-soft" onClick={() => void post({ action: "choose-plaintext-storage", operationId: account.login!.operationId, acceptPlaintext: true })}>{t("copilot.accounts.login.plaintextAccept")}</button>
                <button type="button" className="rounded px-1.5 text-muted hover:bg-accent-soft" onClick={() => void post({ action: "choose-plaintext-storage", operationId: account.login!.operationId, acceptPlaintext: false })}>{t("copilot.accounts.login.plaintextDecline")}</button>
              </div>
            </div>
          ) : null}
          {account.loginCommand ? (
            <div className="flex min-w-0 items-center gap-1.5">
              <code className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-secondary" title={account.loginCommand}>{account.loginCommand}</code>
              <button type="button" className="shrink-0 rounded px-1.5 text-[10.5px] font-semibold text-accent hover:bg-accent-soft" onClick={() => void copy(account)}>
                {copied === account.id ? t("copilot.accounts.copied") : t("copilot.accounts.copyLogin")}
              </button>
            </div>
          ) : null}
          {armed === account.id ? (
            /* The card is narrow in the rail footer: the confirm reads at its full width, its buttons under it. */
            <div data-account-remove-armed={account.id} className="flex flex-col gap-1">
              <span className="min-w-0 text-[10.5px] font-semibold leading-snug text-danger">
                {t(account.kind === "legacy" ? "accounts.removeConfirmLegacy" : "copilot.accounts.removeConfirm", { label: account.label })}
              </span>
              <span className="flex justify-end gap-1">
                <button type="button" data-account-remove-confirm={account.id} className="shrink-0 rounded bg-danger px-2 py-0.5 text-[10.5px] font-semibold text-white hover:opacity-90" onClick={() => { setArmed(null); void remove(account); }}>
                  {t("accounts.removeConfirmCta")}
                </button>
                <button type="button" className="shrink-0 rounded px-2 py-0.5 text-[10.5px] font-semibold text-secondary hover:bg-canvas" onClick={() => setArmed(null)}>
                  {t("accounts.removeConfirmCancel")}
                </button>
              </span>
            </div>
          ) : (
            <button type="button" data-account-remove={account.id} aria-label={t("accounts.removeAria", { label: account.label })} className="self-end rounded px-1.5 py-0.5 text-[10.5px] font-semibold text-muted hover:bg-danger-soft hover:text-danger" onClick={() => setArmed(account.id)}>
              {t("accounts.remove")}
            </button>
          )}
          {refusal?.accountId === account.id ? (
            <AccountRemovalRefusal refusal={refusal} inset={false} disabled={false} onDismiss={dismissRefusal} onRetry={() => void remove(account)} onRefresh={() => void load()} />
          ) : null}
        </div>
      ))}
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!label.trim()) return;
          void post({ label }).then(() => setLabel(""));
        }}
      >
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder={t("copilot.accounts.labelPlaceholder")}
          aria-label={t("copilot.accounts.labelPlaceholder")}
          className="min-w-0 flex-1 rounded-md border border-border bg-card px-2 py-1 text-[11.5px]"
        />
        <button type="submit" className="shrink-0 rounded-md border border-border bg-card px-2 py-1 text-[11px] font-semibold text-primary hover:bg-canvas">
          {t("copilot.accounts.add")}
        </button>
      </form>
      {hiddenAccountsOf(body.hidden).map((account) => (
        <HiddenAccountOffer
          key={account.id}
          account={account}
          busy={restoring}
          onRestore={() => {
            /* The row is back at once, its sign-in unchecked until the next
               read; a refusal takes it off and offers it again (audit B37). An
               "already listed" answer means it is back. */
            setRestoring(true);
            const row: CopilotAccountRow = { id: account.id, label: account.label, kind: "legacy", active: false, auth: "unknown", user: null, loginCommand: null, login: null };
            const predicted: Prediction = (held) => ({ ...held, accounts: held.accounts.some((listed) => listed.id === account.id) ? held.accounts : [row, ...held.accounts], hidden: (held.hidden ?? []).filter((hidden) => hidden.id !== account.id) });
            void post({ action: "restore", id: account.id }, predicted, 404).finally(() => setRestoring(false));
          }}
        />
      ))}
      {error ? <p role="alert" className="text-danger">{error}</p> : null}
    </>
  );
}

export function CopilotFooterRow({ limits, limitsAccountId, now, onChanged, density }: {
  density: SidebarFooterDensity;
  limits: EngineLimits | null;
  limitsAccountId: string | null;
  now: number;
  onChanged: () => void;
}) {
  const { t, locale } = useLocale();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const tint = engineTintOf("copilot");
  const accounts = useCopilotAccounts({ polling: open, onChanged });
  const { body, load } = accounts;

  /* A launch preflight on a signed-out Copilot account (#2170) opens this
     row's switcher, where the account's Sign in is. */
  useEffect(() => {
    if (consumePendingAccountPanel("copilot")) setOpen(true);
    return onAccountPanelRequest((request) => {
      if (request.engine !== "copilot") return;
      setOpen(true);
      void load();
    });
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  if (!body || (!body.cli.present && body.accounts.length === 0)) return null;
  const active = body.accounts.find((account) => account.active) ?? null;

  const weekly = active?.id === limitsAccountId ? limits?.weekly ?? null : null;
  const left = weekly ? Math.max(0, Math.min(100, 100 - weekly.usedPercent)) : null;
  const color = left === null ? tint.color : barColor(left, tint.color);
  const summary = ["Copilot", active ? active.label : t("copilot.accounts.none"), left === null ? null : `${windowLabel(t, "weekly", weekly?.windowMinutes)} ${t("limits.left")} ${Math.round(left)}%`].filter(Boolean).join(" · ");
  return (
    <div ref={containerRef} className="relative" data-engine-limits="copilot">
      <button type="button" data-meter-line="" aria-expanded={open} aria-label={t("copilot.accounts.rowAria")} title={summary} onClick={() => setOpen((value) => !value)} className={`flex h-[26px] w-full items-center gap-1.5 ${LINE_EDGE} text-left hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`}>
        {/* Built as the Claude and Codex lines are: the account in words, a mark in a 12 px box after it,
            what is left, its bar. Copilot has no mark of its own, so its tint dot stands in the box. */}
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span data-meter-name="" className="min-w-0 truncate text-[11.5px] font-semibold text-primary">{active ? active.label : "Copilot"}</span>
          <span role="img" aria-label="Copilot" title="Copilot" className="grid h-3 w-3 shrink-0 place-items-center"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: tint.color }} /></span>
        </span>
        {active ? null : <span className="shrink-0 text-[10px] text-muted">{t("copilot.accounts.none")}</span>}
        {left === null ? null : <span data-meter-value="" className="shrink-0 text-[11px] tabular-nums text-muted">{t("limits.left")} <span className="font-bold text-primary">{Math.round(left)}%</span></span>}
        {left === null ? null : <ReserveBar percent={left} color={color} />}
      </button>
      {density === "detail" && weekly ? (
        <div data-limits-windows="" className={`${LINE_EDGE} pb-1`}>
          <LimitWindowLine
            label={windowLabel(t, "weekly", weekly.windowMinutes)}
            window={weekly}
            engineColor={tint.color}
            now={now}
            staleHint={weekly.observedAt != null && now - weekly.observedAt > 300 ? quotaAsOfHint(weekly.observedAt, locale) : null}
          />
        </div>
      ) : null}
      {open ? (
        /* Bounded with a scroller of its own: it opens in the rail's footer,
           which sits at the window's lower edge, so an unbounded list (an
           import's checklist above the accounts) ran under the edge of a short
           window, where nothing scrolls. */
        <div role="dialog" aria-label={t("copilot.accounts.title")} data-copilot-panel="" className="flex max-h-[min(40vh,20rem)] flex-col gap-2 overflow-y-auto overscroll-contain border-t border-border bg-sunken px-3.5 py-2.5 text-[11.5px] [&>*]:shrink-0">
          <CopilotAccountList accounts={accounts} />
        </div>
      ) : null}
    </div>
  );
}
