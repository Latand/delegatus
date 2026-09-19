"use client";

import { RefreshCw } from "lucide-react";
import { useState } from "react";

import { MobileAccountsBody } from "@/components/AccountsPanel";
import { EngineMark } from "@/components/EngineMark";
import type { AccountOption, EngineAccountsState } from "@/hooks/useEngineAccounts";
import { useLocale } from "@/lib/i18n";
import type { RoleEngine } from "@/lib/roles/types";

/**
 * Step 1 (#1876, design §2.1): which engines this machine can run right now.
 * Sign-in reuses the accounts screen's own rows — the Claude browser-and-code
 * flow and the Codex device code — embedded under the engine's card, so there
 * is one sign-in implementation and this step only decides when to show it.
 */

export type CliPresence = "found" | "missing" | null;

const ENGINE_NAME: Record<RoleEngine, string> = { claude: "Claude", codex: "Codex" };

/** Signed in, as the launch refusal counts it: a credential is present. */
export function accountConnected(account: AccountOption): boolean {
  return account.authPresent || account.authHealth === "authenticated";
}

export function engineConnected(state: Pick<EngineAccountsState, "accounts">): boolean {
  return state.accounts.some(accountConnected);
}

/** Connected as a launch counts it: a missing command outranks a present
    credential, since the engine cannot start either way. */
export function engineReady(state: Pick<EngineAccountsState, "accounts">, cli: CliPresence): boolean {
  return cli !== "missing" && engineConnected(state);
}

/** The account whose windows the cost hints read: the active one when it is
    signed in, otherwise the first that is. */
export function engineAccount(state: Pick<EngineAccountsState, "accounts" | "active">): AccountOption | null {
  const connected = state.accounts.filter(accountConnected);
  return connected.find((account) => account.id === state.active) ?? connected[0] ?? null;
}

function EngineCard({ state, cli, now, onRecheck }: { state: EngineAccountsState; cli: CliPresence; now: number; onRecheck: () => void }) {
  const { t } = useLocale();
  const [signingIn, setSigningIn] = useState(false);
  const engine = state.engine;
  const missing = cli === "missing";
  const connected = engineReady(state, cli);
  const account = engineAccount(state);
  const loading = state.status === "loading" && state.accounts.length === 0;
  /* The embedded rows either carry their own "sign in" or, for an account
     only a terminal can sign in, leave "add an account" as the way in. */
  const signable = state.accounts.some((candidate) => !accountConnected(candidate) && (engine === "claude" || candidate.kind === "managed"));
  const stateLine = loading
    ? null
    : connected
      ? account?.plan ? t("onboarding.engines.connected", { plan: account.plan }) : t("onboarding.engines.connectedNoPlan")
      : missing
        ? t("onboarding.engines.missing")
        : state.status === "error"
          ? t("onboarding.engines.authUnknown")
          : t("onboarding.engines.signedOut");
  const tone = connected ? "text-success" : missing ? "text-danger" : "text-warning";
  return (
    <div
      data-onboarding-engine={engine}
      data-engine-state={loading ? "loading" : connected ? "connected" : missing ? "missing" : "signed-out"}
      className="flex min-w-0 flex-col gap-2 rounded-[12px] border border-border bg-card p-3"
      style={{ borderLeft: `3px solid var(--color-${engine})` }}
    >
      {loading ? (
        <div className="h-14 animate-pulse rounded-[8px] bg-sunken motion-reduce:animate-none" aria-busy />
      ) : (
        <div className="flex min-w-0 items-center gap-2.5">
          <EngineMark engine={engine} size={18} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-body font-semibold text-primary">{ENGINE_NAME[engine]}</span>
            <span className={`text-ui ${tone}`}>{stateLine}</span>
          </span>
          {missing ? (
            <button type="button" onClick={onRecheck} className="inline-flex h-8 shrink-0 items-center gap-1 rounded-[8px] border border-border bg-canvas px-2.5 text-ui font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11">
              <RefreshCw className="h-3 w-3" aria-hidden />
              {t("onboarding.engines.recheck")}
            </button>
          ) : !connected ? (
            <button
              type="button"
              data-onboarding-sign-in={engine}
              aria-expanded={signingIn}
              onClick={() => setSigningIn((value) => !value)}
              className={`inline-flex h-8 shrink-0 items-center rounded-[8px] px-3 text-ui font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11 ${signingIn ? "border border-border bg-canvas text-primary hover:bg-sunken" : "bg-accent text-white hover:opacity-90"}`}
            >
              {signingIn ? t("onboarding.engines.hideSignIn") : t("onboarding.engines.signIn")}
            </button>
          ) : null}
        </div>
      )}
      {missing ? (
        <p className="text-ui text-secondary">{t(engine === "claude" ? "onboarding.engines.missingClaude" : "onboarding.engines.missingCodex")}</p>
      ) : null}
      {signingIn && !connected ? (
        <div data-onboarding-sign-in-body={engine} className="-mx-3 -mb-3 border-t border-border">
          <p data-onboarding-sign-in-hint={engine} className="px-3 pt-2.5 text-ui text-secondary">
            {signable ? t("onboarding.engines.signInPick") : t("onboarding.engines.signInAdd", { engine: ENGINE_NAME[engine] })}
          </p>
          <MobileAccountsBody engines={[state]} now={now} />
        </div>
      ) : null}
    </div>
  );
}

export function EnginesStep({ claude, codex, cli, now, onRecheck }: {
  claude: EngineAccountsState;
  codex: EngineAccountsState;
  cli: Record<RoleEngine, CliPresence>;
  now: number;
  onRecheck: () => void;
}) {
  const { t } = useLocale();
  const claudeOn = engineReady(claude, cli.claude);
  const codexOn = engineReady(codex, cli.codex);
  const settled = claude.status !== "loading" && codex.status !== "loading";
  const note = !settled
    ? null
    : claudeOn && codexOn
      ? null
      : claudeOn || codexOn
        ? t("onboarding.engines.oneOnly", { engine: claudeOn ? "Claude" : "Codex", other: claudeOn ? "Codex" : "Claude" })
        : t("onboarding.engines.neither");
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 items-start gap-4 max-sm:grid-cols-1 max-sm:gap-3">
        <EngineCard state={claude} cli={cli.claude} now={now} onRecheck={onRecheck} />
        <EngineCard state={codex} cli={cli.codex} now={now} onRecheck={onRecheck} />
      </div>
      {note ? (
        <p data-onboarding-engines-note="" className={`rounded-[8px] px-3 py-2 text-body ${claudeOn || codexOn ? "bg-sunken text-secondary" : "bg-warning-soft text-warning"}`}>{note}</p>
      ) : null}
    </div>
  );
}
