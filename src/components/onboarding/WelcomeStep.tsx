"use client";

import { DelegatusMark } from "@/components/brand/BrandMark";
import type { EngineAccountsState } from "@/hooks/useEngineAccounts";
import { useLocale } from "@/lib/i18n";
import type { HostPlatform } from "@/lib/onboarding/agentInstallCommands";

import type { AntigravityAccount } from "./AntigravityAccount";
import { accountsRowKind, accountsRowWords, antigravityRowWords, anyAgentSignedIn, type CliPresence } from "./EnginesStep";
import { ProgramHead, useOnHost, type ProgramStateWords } from "./ProgramRowParts";

/**
 * The guide's cover (docs/design/onboarding-v2.md §3.1, Welcome 2), shown
 * when the guide opens by itself with no step settled. It names the product
 * in one sentence and already says what the computer has: each agent program
 * as the Accounts step heads its row, the name and under it the status dot
 * leading the state line. With an agent account found it asks about one more
 * and "Continue with these" passes the Accounts step; with none it leads into
 * that step, saying whether a sign-in or an install waits there. Until the
 * install job exists (§12.4) the words promise the command, never an install.
 * It is no step: nothing here is stored.
 */

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
const BUTTON = `inline-flex h-8 shrink-0 items-center justify-center whitespace-nowrap rounded-[8px] px-3.5 text-ui font-semibold max-sm:h-11 ${FOCUS}`;

const AGENT_PROGRAMS = ["claude", "codex", "antigravity"] as const;

export function WelcomeStep({ claude, codex, antigravity, cli, cliAnswered = true, now, platform = "linux", onContinue, onAccounts }: {
  claude: EngineAccountsState;
  codex: EngineAccountsState;
  antigravity: AntigravityAccount;
  cli: { claude: CliPresence; codex: CliPresence; antigravity?: CliPresence };
  /** The read that says which programs are installed has ended; until then no row claims a state. */
  cliAnswered?: boolean;
  now: number;
  platform?: HostPlatform;
  /** "Continue with these": the accounts found are carried on as they are. */
  onContinue: () => void;
  /** "Add an account" and "Choose what to install": the Accounts step. */
  onAccounts: () => void;
}) {
  const { t } = useLocale();
  const onHost = useOnHost();
  const signingIn = (state: EngineAccountsState) => state.accounts.some((account) => account.loginPending);
  const words: Record<typeof AGENT_PROGRAMS[number], ProgramStateWords | null> = cliAnswered ? {
    claude: accountsRowWords(claude, accountsRowKind(claude, cli.claude, platform, signingIn(claude)), now, t),
    codex: accountsRowWords(codex, accountsRowKind(codex, cli.codex, platform, signingIn(codex)), now, t),
    antigravity: antigravityRowWords(antigravity, cli.antigravity ?? antigravity.cli, t),
  } : { claude: null, codex: null, antigravity: null };
  /* The question waits for every program's answer, so the buttons never change under a pointer. */
  const settled = AGENT_PROGRAMS.every((program) => words[program] !== null);
  const found = settled && anyAgentSignedIn(claude, codex, antigravity, cli);
  /* Nothing installed and installed-but-signed-out lead to the same step by different words: what the next step holds differs. */
  const installed = cli.claude !== "missing" || cli.codex !== "missing" || (cli.antigravity ?? antigravity.cli) !== "missing";
  const state = !settled ? "loading" : found ? "found" : installed ? "signed-out" : "nothing";
  return (
    <div data-onboarding-welcome={state} className="mx-auto flex w-full max-w-[520px] flex-col gap-5">
      <div className="flex flex-col gap-3">
        <DelegatusMark size={40} />
        <h2 className="text-[22px] font-bold leading-tight text-primary">{t("onboarding.welcome.heading")}</h2>
        <p className="max-w-[52ch] text-body leading-[1.5] text-secondary">{t("onboarding.welcome.lead")}</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <h3 data-onboarding-welcome-programs="" className="text-label font-semibold uppercase tracking-[0.02em] text-secondary">{t(onHost ? "onboarding.welcome.programsHere" : "onboarding.welcome.programsHost")}</h3>
        <ul data-onboarding-programs="" className="flex flex-col divide-y divide-border rounded-[12px] border border-border bg-card">
          {AGENT_PROGRAMS.map((program) => (
            <li key={program} data-onboarding-engine={program} className="flex min-w-0 items-center gap-3 px-4 py-2">
              <ProgramHead program={program} state={words[program]} grow="flex-1" />
            </li>
          ))}
        </ul>
      </div>
      {settled ? (
        <div className="flex flex-col gap-2">
          <p data-onboarding-welcome-question="" className="text-body text-primary">{t(found ? "onboarding.welcome.addQuestion" : installed ? "onboarding.welcome.signedOut" : "onboarding.welcome.nothing")}</p>
          <div className="flex flex-wrap gap-2 max-sm:flex-col">
            {found ? (
              <>
                <button type="button" data-onboarding-welcome-continue="" onClick={onContinue} className={`${BUTTON} bg-brand text-on-brand hover:opacity-90`}>{t("onboarding.welcome.continueWith")}</button>
                <button type="button" data-onboarding-welcome-accounts="" onClick={onAccounts} className={`${BUTTON} border border-border bg-card text-primary hover:bg-sunken`}>{t("onboarding.welcome.addAccount")}</button>
              </>
            ) : (
              <button type="button" data-onboarding-welcome-accounts="" onClick={onAccounts} className={`${BUTTON} bg-brand text-on-brand hover:opacity-90`}>{t(installed ? "onboarding.welcome.signIn" : "onboarding.welcome.chooseInstall")}</button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
