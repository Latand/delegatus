"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "./icons";

import { useLocale } from "@/lib/i18n";
import type { AccountReportRow } from "@/lib/transfer/types";

/* The sign-in checklist of an install transfer (docs/design/install-memory-transfer.md
   §3.4, operator decision Q1): one row per account the import brought to this
   engine, in the source's order, with its state here. «Sign in» starts the
   product's own sign-in for that account, whose link and code appear on the
   account's card below; «Check» reads its limits live; a signed-in account
   settles its row by itself. Hidden once every row is usable or not needed. */

type Row = AccountReportRow;
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
type Engine = "claude" | "codex";

const STATE_TONE: Record<Row["state"], string> = {
  signed_out: "text-warning",
  usable: "text-success",
  different_account: "text-danger",
  read_failed: "text-danger",
  not_needed: "text-muted",
  not_created: "text-danger",
};

async function readRows(engine: Engine, fetcher: Fetcher): Promise<Row[]> {
  try {
    const response = await fetcher(`/api/transfer/accounts?engine=${engine}`, { cache: "no-store" });
    if (!response.ok) return [];
    const body = await response.json() as { ok?: boolean; result?: Row[] };
    return body.ok && Array.isArray(body.result) ? body.result : [];
  } catch { return []; }
}

async function post(fetcher: Fetcher, body: Record<string, unknown>): Promise<boolean> {
  try {
    const response = await fetcher("/api/transfer/accounts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return response.ok;
  } catch { return false; }
}

const globalFetch: Fetcher = (input, init) => globalThis.fetch(input, init);

/** The rows for one engine, re-read whenever the account list changes (a sign-in settles its row on the server). */
export function useImportedAccounts(engine: Engine, version: string | number, fetcher: Fetcher = globalFetch) {
  const [rows, setRows] = useState<Row[]>([]);
  const reload = useCallback(async () => { setRows(await readRows(engine, fetcher)); }, [engine, fetcher]);
  useEffect(() => {
    let live = true;
    void readRows(engine, fetcher).then(next => { if (live) setRows(next); });
    return () => { live = false; };
  }, [engine, fetcher, version]);
  return { rows, reload, post: (body: Record<string, unknown>) => post(fetcher, body) };
}

export function TransferAccountsChecklist({ engine, rows, onSignIn, onAction }: {
  engine: Engine;
  rows: readonly Row[];
  /** Starts the product's sign-in for the account here, by its id on this install. */
  onSignIn: (accountId: string) => Promise<unknown>;
  onAction: (body: { action: "verify" | "not_needed" | "confirm_identity"; engine: Engine; sourceId?: string }) => Promise<unknown>;
}) {
  const { t } = useLocale();
  const [busy, setBusy] = useState<string | null>(null);
  const open = rows.filter(row => row.state !== "usable" && row.state !== "not_needed");
  if (!rows.length || !open.length) return null;
  const run = async (key: string, work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key);
    try { await work(); } finally { setBusy(null); }
  };
  return (
    <section aria-label={t("transfer.accounts.title")} data-transfer-checklist className="border-b border-border bg-accent/5 px-3 py-2">
      <div className="flex items-center gap-2">
        <h3 className="text-[11.5px] font-bold">{t("transfer.accounts.title")}</h3>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void run("verify", () => onAction({ action: "verify", engine }))}
          className="ml-auto inline-flex min-h-[44px] items-center gap-1 rounded-[6px] px-1.5 text-[10.5px] font-semibold text-accent hover:bg-canvas disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-[24px]"
        >
          {busy === "verify" ? <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden /> : null}
          {t("transfer.accounts.check")}
        </button>
      </div>
      <p className="mt-0.5 text-[10.5px] leading-snug text-muted">{t("transfer.accounts.hint")}</p>
      <ul className="mt-1.5 space-y-1">
        {rows.map(row => (
          <li key={row.sourceId} data-transfer-account={row.sourceId} className="rounded-[8px] border border-border bg-card px-2 py-1.5">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 truncate text-[11.5px] font-semibold">{row.label}</span>
              <span className={`shrink-0 text-[10.5px] font-semibold ${STATE_TONE[row.state]}`}>{t(`transfer.accounts.state.${row.state}`)}</span>
            </div>
            <div className="text-[10px] text-muted">
              {[row.activeOnSource ? t("transfer.accounts.activeThere") : null, row.bindings.length ? t("transfer.accounts.bound", { count: row.bindings.length }) : null, row.detail ?? null]
                .filter(Boolean).join(" · ")}
            </div>
            {row.state !== "not_created" ? (
              <div className="mt-1 flex flex-wrap gap-1.5">
                {(row.state === "signed_out" || row.state === "different_account" || row.state === "read_failed") && row.targetId ? (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void run(`sign-in:${row.sourceId}`, () => onSignIn(row.targetId!))}
                    className="inline-flex min-h-[44px] items-center rounded-[7px] border border-border bg-canvas px-2 text-[11px] font-semibold hover:bg-sunken disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-[26px]"
                  >
                    {row.state === "signed_out" ? t("transfer.accounts.signIn") : t("transfer.accounts.signInAgain")}
                  </button>
                ) : null}
                {row.state === "different_account" ? (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void run(`confirm:${row.sourceId}`, () => onAction({ action: "confirm_identity", engine, sourceId: row.sourceId }))}
                    className="inline-flex min-h-[44px] items-center rounded-[7px] border border-border bg-canvas px-2 text-[11px] font-semibold hover:bg-sunken disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-[26px]"
                  >
                    {t("transfer.accounts.confirm")}
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void run(`skip:${row.sourceId}`, () => onAction({ action: "not_needed", engine, sourceId: row.sourceId }))}
                  className="inline-flex min-h-[44px] items-center px-1 text-[10.5px] font-semibold text-muted underline underline-offset-2 hover:text-primary disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-[26px]"
                >
                  {t("transfer.accounts.notNeeded")}
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
