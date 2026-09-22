"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useLocale } from "@/lib/i18n";

import { engineTintOf } from "./utils";

/**
 * GitHub Copilot accounts in the limits footer (docs/design/copilot-engine.md
 * 3.9, slice 1). One row, shown only once the Copilot CLI is installed or an
 * account exists; opening it lists the accounts, picks the one launches use,
 * adds a managed account and hands over the command that signs it in from a
 * terminal. Copilot reports no plan limits yet, so the row carries none.
 */

interface CopilotAccountRow {
  id: string;
  label: string;
  kind: "legacy" | "managed";
  active: boolean;
  loginCommand: string | null;
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

export function CopilotFooterRow() {
  const { t } = useLocale();
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
      if (isBody(next)) setBody(next);
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
      {open ? (
        <div role="dialog" aria-label={t("copilot.accounts.title")} className="flex flex-col gap-2 border-t border-border bg-sunken px-3.5 py-2.5 text-[11.5px]">
          {!body.cli.present && body.cli.reason ? <p className="text-muted">{body.cli.reason}</p> : null}
          <p className="text-muted">{t("copilot.accounts.hint")}</p>
          {body.accounts.map((account) => (
            <div key={account.id} className="flex flex-col gap-1 rounded-md border border-border bg-card px-2 py-1.5">
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-semibold text-primary">{account.label}</span>
                {account.active ? (
                  <span className="shrink-0 text-[10px] font-semibold text-muted">{t("copilot.accounts.active")}</span>
                ) : (
                  <button type="button" className="shrink-0 rounded px-1.5 text-[10.5px] font-semibold text-accent hover:bg-accent-soft" onClick={() => void post({ action: "select", id: account.id })}>
                    {t("copilot.accounts.use")}
                  </button>
                )}
              </div>
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
