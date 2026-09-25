"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { consumePendingAccountPanel, onAccountPanelRequest } from "@/lib/accounts/openPanel";
import { useLocale } from "@/lib/i18n";
import type { EngineLimits, LimitsProvenance } from "@/lib/types";

import { engineTintOf } from "./utils";
import { LimitRow, quotaAsOfHint } from "./LimitRow";
import { windowLabel } from "./rateLimit";

/** GitHub Copilot account switcher and monthly allowance in the footer. */

interface CopilotAccountRow {
  id: string;
  label: string;
  kind: "legacy" | "managed";
  active: boolean;
  auth: "signed_in" | "signed_out" | "unknown";
  "user": string | null;
  loginCommand: string | null;
  login: { operationId: string; phase: string; loginUrl: string | null; userCode?: string | null; deadlineAt: string } | null;
}

interface CopilotAccountsBody {
  cli: { present: boolean; reason: string | null };
  active: string;
  accounts: CopilotAccountRow[];
  error?: string;
}

function isBody(value: unknown): value is CopilotAccountsBody {
  const body = value as Partial<CopilotAccountsBody> | null;
  return Boolean(body && typeof body === "object" && body.cli && Array.isArray(body.accounts));
}

export function CopilotFooterRow({ limits, limitsAccountId, now, provenance, onChanged }: {
  limits: EngineLimits | null;
  limitsAccountId: string | null;
  now: number;
  provenance: LimitsProvenance;
  onChanged: () => void;
}) {
  const { t, locale } = useLocale();
  const [body, setBody] = useState<CopilotAccountsBody | null>(null);
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tint = engineTintOf("copilot");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/accounts/copilot");
      const next: unknown = await response.json();
      if (isBody(next)) setBody(next);
    } catch { /* the row stays as it was */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

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
    if (!open || !body?.accounts.some((account) => account.login && ["starting", "awaiting_browser", "awaiting_storage_choice", "verifying", "canceling"].includes(account.login.phase))) return;
    const timer = window.setInterval(() => void load(), 1000);
    return () => window.clearInterval(timer);
  }, [open, body, load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  const post = async (payload: Record<string, unknown>) => {
    setError(null);
    try {
      const response = await fetch("/api/accounts/copilot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const next: unknown = await response.json();
      if (!response.ok) {
        setError((next as { error?: string } | null)?.error ?? t("copilot.accounts.failed"));
        return;
      }
      if (isBody(next)) {
        setBody(next);
        onChanged();
      }
    } catch {
      setError(t("copilot.accounts.failed"));
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

  if (!body || (!body.cli.present && body.accounts.length === 0)) return null;
  const active = body.accounts.find((account) => account.active) ?? null;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-label={t("copilot.accounts.rowAria")}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-[44px] w-full items-center gap-2 px-3.5 py-1.5 text-left hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-[36px]"
      >
        <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: tint.color }} />
        <span className="text-[11.5px] font-bold text-primary">Copilot</span>
        <span className="ml-auto truncate text-[10px] font-semibold text-muted">
          {active ? active.label : t("copilot.accounts.none")}
        </span>
      </button>
      {active?.id === limitsAccountId ? (
        <div className="px-3.5 pb-2">
          <LimitRow
            label={windowLabel(t, "weekly", limits?.weekly?.windowMinutes)}
            window={limits?.weekly ?? null}
            engineColor={tint.color}
            now={now}
            staleHint={limits?.weekly?.observedAt != null && now - limits.weekly.observedAt > 300
              ? quotaAsOfHint(limits.weekly.observedAt, locale)
              : provenance.source === "unavailable" ? t("limits.noDataYet") : null}
          />
        </div>
      ) : null}
      {open ? (
        <div role="dialog" aria-label={t("copilot.accounts.title")} className="flex flex-col gap-2 border-t border-border bg-sunken px-3.5 py-2.5 text-[11.5px]">
          {!body.cli.present && body.cli.reason ? <p className="text-muted">{body.cli.reason}</p> : null}
          <p className="text-muted">{t("copilot.accounts.hint")}</p>
          {body.accounts.map((account) => (
            <div key={account.id} className="flex flex-col gap-1 rounded-md border border-border bg-card px-2 py-1.5">
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-semibold text-primary">{account.label}</span>
                <span className="shrink-0 text-[10px] text-muted">
                  {account.auth === "signed_in" ? t("copilot.accounts.signedIn", { user: account.user ?? "" }) : account.auth === "signed_out" ? t("copilot.accounts.signedOut") : t("copilot.accounts.unknown")}
                </span>
                {account.active ? (
                  <span className="shrink-0 text-[10px] font-semibold text-muted">{t("copilot.accounts.active")}</span>
                ) : (
                  <button type="button" className="shrink-0 rounded px-1.5 text-[10.5px] font-semibold text-accent hover:bg-accent-soft" onClick={() => void post({ action: "select", id: account.id })}>
                    {t("copilot.accounts.use")}
                  </button>
                )}
              </div>
              {account.kind === "managed" && account.auth !== "signed_in" && (!account.login || !["starting", "awaiting_browser", "awaiting_storage_choice", "verifying", "canceling"].includes(account.login.phase)) ? (
                <button type="button" className="self-start rounded px-1.5 py-0.5 text-[10.5px] font-semibold text-accent hover:bg-accent-soft" onClick={() => void post({ action: "login", id: account.id })}>
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
          {error ? <p role="alert" className="text-danger">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
