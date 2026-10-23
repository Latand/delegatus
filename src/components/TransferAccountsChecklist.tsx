"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "./icons";

import { useLocale } from "@/lib/i18n";
import type { AccountReportRow } from "@/lib/transfer/types";

/* The sign-in checklist of an install transfer (docs/design/install-memory-transfer.md
   §3.4, operator decision Q1): one row per account the import brought to this
   engine, in the source's order, with its state here. «Sign in» starts the
   product's own sign-in for that account, whose link and code appear on the
   account's card; «Check» reads its limits live; a signed-in account settles
   its row by itself. A row whose account could not be made offers «Try
   again» when its setup can be retried, and «Not needed here» always. Hidden
   once every row is usable or not needed. The accounts dialog, the phone's
   accounts screen and the Copilot list each mount it. */

type Row = AccountReportRow;
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
type Engine = "claude" | "codex" | "copilot";
export type TransferAccountAction = { action: "verify" | "retry" | "not_needed" | "confirm_identity"; engine: Engine; sourceId?: string };

const STATE_TONE: Record<Row["state"], string> = {
  signed_out: "text-warning",
  unchecked: "text-warning",
  usable: "text-success",
  different_account: "text-danger",
  read_failed: "text-danger",
  not_needed: "text-muted",
  not_created: "text-danger",
};

/** Causes the transfer names by code; anything else is the provider's own redacted detail. */
const DETAIL_CODES = ["provider-account", "identity-unreadable", "no-limit-windows", "account-missing", "create-failed"] as const;
type DetailCode = (typeof DETAIL_CODES)[number];
const isDetailCode = (detail: string): detail is DetailCode => (DETAIL_CODES as readonly string[]).includes(detail);

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

/** The rows for one engine, re-read whenever the account list changes (a sign-in
    settles its row on the server). `loaded` turns true once the first read
    answered, whatever it answered. */
export function useImportedAccounts(engine: Engine, version: string | number, fetcher: Fetcher = globalFetch) {
  const [state, setState] = useState<{ rows: Row[]; loaded: boolean }>({ rows: [], loaded: false });
  const reload = useCallback(async () => { const rows = await readRows(engine, fetcher); setState({ rows, loaded: true }); }, [engine, fetcher]);
  useEffect(() => {
    let live = true;
    void readRows(engine, fetcher).then(rows => { if (live) setState({ rows, loaded: true }); });
    return () => { live = false; };
  }, [engine, fetcher, version]);
  return { rows: state.rows, loaded: state.loaded, reload, post: (body: Record<string, unknown>) => post(fetcher, body) };
}

const DIALOG_BUTTON = "inline-flex min-h-[44px] items-center rounded-[7px] border border-border bg-canvas px-2 text-[11px] font-semibold hover:bg-sunken disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-[26px]";
const DIALOG_LINK = "inline-flex min-h-[44px] items-center px-1 text-[10.5px] font-semibold text-muted underline underline-offset-2 hover:text-primary disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-[26px]";
const PHONE_BUTTON = "inline-flex min-h-11 items-center rounded-[8px] border border-border bg-canvas px-2.5 text-ui font-semibold active:bg-sunken disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
const PHONE_LINK = "inline-flex min-h-11 items-center px-1 text-label font-semibold text-muted underline underline-offset-2 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

export function TransferAccountsChecklist({ engine, rows, onSignIn, onAction, variant = "dialog" }: {
  engine: Engine;
  rows: readonly Row[];
  /** Starts the product's sign-in for the account here, by its id on this install. */
  onSignIn: (accountId: string) => Promise<unknown>;
  onAction: (body: TransferAccountAction) => Promise<unknown>;
  /** `dialog`: the desktop accounts dialog; `inline`: a box inside the Copilot list; `phone`: the phone's accounts screen, with 44 px targets. */
  variant?: "dialog" | "inline" | "phone";
}) {
  const { t } = useLocale();
  const [busy, setBusy] = useState<string | null>(null);
  const open = rows.filter(row => row.state !== "usable" && row.state !== "not_needed");
  if (!rows.length || !open.length) return null;
  const phone = variant === "phone";
  const button = phone ? PHONE_BUTTON : DIALOG_BUTTON;
  const link = phone ? PHONE_LINK : DIALOG_LINK;
  const run = async (key: string, work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key);
    try { await work(); } finally { setBusy(null); }
  };
  const detailText = (detail: string | undefined) => detail ? (isDetailCode(detail) ? t(`transfer.accounts.detail.${detail}`) : detail) : null;
  return (
    <section aria-label={t("transfer.accounts.title")} data-transfer-checklist={engine} className={phone ? "mx-3 mb-2 rounded-[10px] border border-border bg-accent/5 px-3 py-2" : variant === "inline" ? "rounded-md border border-border bg-accent/5 px-2 py-1.5" : "border-b border-border bg-accent/5 px-3 py-2"}>
      <div className="flex items-center gap-2">
        <h3 className={phone ? "text-label font-bold" : "text-[11.5px] font-bold"}>{t("transfer.accounts.title")}</h3>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void run("verify", () => onAction({ action: "verify", engine }))}
          className={`ml-auto inline-flex items-center gap-1 rounded-[6px] px-1.5 font-semibold text-accent hover:bg-canvas disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${phone ? "min-h-11 text-ui" : "min-h-[44px] text-[10.5px] sm:min-h-[24px]"}`}
        >
          {busy === "verify" ? <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden /> : null}
          {t("transfer.accounts.check")}
        </button>
      </div>
      <p className={`mt-0.5 leading-snug text-muted ${phone ? "text-label" : "text-[10.5px]"}`}>
        {t(engine === "copilot" ? "transfer.accounts.hintCopilot" : "transfer.accounts.hint")}
      </p>
      <ul className="mt-1.5 space-y-1">
        {rows.map(row => {
          const signIn = (row.state === "signed_out" || row.state === "different_account" || row.state === "read_failed") && row.targetId;
          const confirm = row.state === "different_account" || (row.state === "read_failed" && row.detail === "identity-unreadable");
          const retry = row.state === "not_created" && row.retry;
          return (
            <li key={row.sourceId} data-transfer-account={row.sourceId} className="rounded-[8px] border border-border bg-card px-2 py-1.5">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className={`min-w-0 truncate font-semibold ${phone ? "text-ui" : "text-[11.5px]"}`}>{row.label}</span>
                <span className={`shrink-0 font-semibold ${phone ? "text-label" : "text-[10.5px]"} ${STATE_TONE[row.state]}`}>{t(`transfer.accounts.state.${row.state}`)}</span>
              </div>
              <div className={`text-muted ${phone ? "text-caption" : "text-[10px]"}`}>
                {/* No project list here: the dialog shows no «Bound to» (#1418); the bindings apply all the same. */}
                {[row.activeOnSource ? t("transfer.accounts.activeThere") : null, detailText(row.detail)].filter(Boolean).join(" · ")}
              </div>
              {row.state !== "usable" && row.state !== "not_needed" ? (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {signIn ? (
                    <button type="button" disabled={busy !== null} onClick={() => void run(`sign-in:${row.sourceId}`, () => onSignIn(row.targetId!))} className={button}>
                      {row.state === "signed_out" ? t("transfer.accounts.signIn") : t("transfer.accounts.signInAgain")}
                    </button>
                  ) : null}
                  {retry ? (
                    <button type="button" disabled={busy !== null} onClick={() => void run(`retry:${row.sourceId}`, () => onAction({ action: "retry", engine, sourceId: row.sourceId }))} className={button}>
                      {t("transfer.accounts.retry")}
                    </button>
                  ) : null}
                  {confirm ? (
                    <button type="button" disabled={busy !== null} onClick={() => void run(`confirm:${row.sourceId}`, () => onAction({ action: "confirm_identity", engine, sourceId: row.sourceId }))} className={button}>
                      {t("transfer.accounts.confirm")}
                    </button>
                  ) : null}
                  <button type="button" disabled={busy !== null} onClick={() => void run(`skip:${row.sourceId}`, () => onAction({ action: "not_needed", engine, sourceId: row.sourceId }))} className={link}>
                    {t("transfer.accounts.notNeeded")}
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
