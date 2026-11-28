"use client";

import { Loader2, Plus, RefreshCw } from "lucide-react";
import { useState, type ReactNode } from "react";

import { accountSessionLeft, accountSignInAvailable, accountSignInPhase, AccountSignInBlock, AddAccountForm, useAccountSignIn } from "@/components/AccountsPanel";
import { copilotSignedIn, useCopilotAccounts, type CopilotAccounts } from "@/components/CopilotFooterRow";
import { antigravityCardState, AntigravitySignIn, type AntigravityAccount, type AntigravityCliPresence } from "@/components/onboarding/AntigravityAccount";
import { DotNotePlace, InstallCommand, ProgramHead, RowDot, TONE_INK, useNarrowRows, useOnHost, type ProgramId, type ProgramInstall, type ProgramInstalls, type ProgramStateWords } from "@/components/onboarding/ProgramRowParts";
import { formatResetClock } from "@/components/rateLimit";
import type { DotTone } from "@/components/settings/StatusDot";
import { NONTERMINAL_CLAUDE_LOGIN_PHASES, type AccountOption, type EngineAccountsState } from "@/hooks/useEngineAccounts";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale, type TFunction } from "@/lib/i18n";
import { agentInstallCommand, type HostPlatform } from "@/lib/onboarding/agentInstallCommands";

/**
 * The Accounts step (stored id `engines`; docs/design/onboarding-v2.md §3.2,
 * Accounts 1): one row per agent program, Claude Code, Codex, Antigravity and
 * Copilot. A row holds the mark, the name, one state line that its status dot
 * leads, and at most one action; what the state calls for stands under it.
 * Claude Code and Codex start their sign-in from the row, with the blocks the
 * accounts panel draws (`AccountSignInBlock`); several accounts of one program
 * unfold as a list under its row, with "Add an account" last. Antigravity
 * shows its terminal sign-in and "Check sign-in", Copilot one sentence. A
 * program that is not installed shows its command to copy. One "Check again"
 * stands beside the step's heading and looks for all four.
 */

export type CliPresence = "found" | "missing" | null;

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

/** Under this share of its session limit an account's dot turns amber and its row says why. */
const LOW_LIMIT = 30;

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
const BUTTON = `inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[8px] px-3.5 text-ui font-semibold disabled:cursor-not-allowed disabled:opacity-50 max-sm:h-11 ${FOCUS}`;
const FILLED = "bg-brand text-on-brand hover:opacity-90";
const BORDERED = "border border-border bg-card text-primary hover:bg-sunken";
const TEXT_ACTION = `inline-flex min-h-8 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-[6px] text-ui font-semibold text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:no-underline max-sm:min-h-11 max-sm:min-w-11 ${FOCUS}`;

const planName = (plan: string | null | undefined) => {
  const trimmed = plan?.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : null;
};

type SessionLimit = { left: number; resetsAt: number | null };

/** The hour a session limit starts over, once that is known and still ahead. */
function resetClock(limit: SessionLimit, now: number): string | null {
  return limit.resetsAt !== null && limit.resetsAt > now ? formatResetClock(limit.resetsAt, now) : null;
}

/** What the limit left reads as in a popover: the share, and when it starts over once that is known. */
function limitNote(limit: SessionLimit, now: number, t: TFunction): string {
  const time = resetClock(limit, now);
  return time !== null ? t("onboarding.engines.note.limitLeftResets", { left: limit.left, time }) : t("onboarding.engines.note.limitLeft", { left: limit.left });
}

/* What one line of a popover holds beside the word that leads the path. */
const PATH_ROOM = 26;

/** A path as a popover's line holds it: whole when it fits, otherwise its last folders and the file behind "…". */
export function shortPath(path: string, room = PATH_ROOM): string {
  if (path.length <= room) return path;
  const separator = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const parts = path.split(separator);
  let kept = parts.pop() ?? "";
  while (parts.length > 0 && `…${separator}${parts[parts.length - 1]}${separator}${kept}`.length <= room) kept = `${parts.pop()}${separator}${kept}`;
  return `…${separator}${kept}`;
}

/** What a popover says of an installed program (design §3.2): its version and where its command was found, as far as
    the last check learned them. Null when it learned neither, and the popover keeps its sentence. */
export function installNote(install: ProgramInstall | null | undefined, t: TFunction): string | null {
  const version = install?.version ?? null;
  const path = install?.path ? shortPath(install.path) : null;
  if (version && path) return t("onboarding.engines.note.versionAt", { version, path });
  if (version) return t("onboarding.engines.note.version", { version });
  return path ? t("onboarding.engines.note.foundAt", { path }) : null;
}

/** The state a Claude Code or Codex row is in (the table of design §3.2). */
export type AccountsRowKind = "loading" | "missing" | "unsupported" | "signed-out" | "signing-in" | "connected" | "several";

export function accountsRowKind(state: Pick<EngineAccountsState, "engine" | "accounts" | "status">, cli: CliPresence, platform: HostPlatform, signingIn: boolean): AccountsRowKind {
  if (cli === "missing") return state.engine === "codex" && platform === "win32" ? "unsupported" : "missing";
  if (state.status === "loading" && state.accounts.length === 0) return "loading";
  if (state.accounts.length > 1) return "several";
  if (engineConnected(state)) return "connected";
  return signingIn ? "signing-in" : "signed-out";
}

/** A note that only says its state line over again. A wide card's popover and a screen reader keep it; in a narrow
    card, where it would open right under that line, the dot opens nothing (design §12.3). */
const restated = (note: string): Pick<ProgramStateWords, "note" | "inline"> => ({ note, inline: null });

/** Where a missing program was looked for. On Windows the search also covers the folders under AppData\Local that
    the native installers write to (`windowsAgentBinaryCandidates`). */
const missingNote = (platform: HostPlatform, t: TFunction) => t(platform === "win32" ? "onboarding.engines.note.missingWindows" : "onboarding.engines.note.missing");

/** A Claude Code or Codex row's state line: its words, their tone and the dot's popover. Shared with the welcome. */
export function accountsRowWords(state: Pick<EngineAccountsState, "engine" | "accounts" | "active" | "status">, kind: AccountsRowKind, now: number, t: TFunction, install?: ProgramInstall | null, platform: HostPlatform = "linux"): ProgramStateWords | null {
  if (kind === "loading") return null;
  if (kind === "missing") return { words: t("onboarding.engines.missing"), tone: "off", note: missingNote(platform, t) };
  if (kind === "unsupported") return { words: t("onboarding.engines.needsWsl"), tone: "off", note: t("onboarding.engines.needsWslNote") };
  if (kind === "signing-in") return { words: t("onboarding.engines.signingIn"), tone: "warn", ...restated(t("onboarding.engines.note.accountSigningIn")) };
  if (kind === "signed-out") {
    if (state.status === "error") return { words: t("onboarding.engines.authUnknown"), tone: "warn", note: t("onboarding.engines.note.authUnknown") };
    const words = t("onboarding.engines.signedOut");
    const found = installNote(install, t);
    if (found !== null) return { words, tone: "warn", note: found };
    /* With no version or path known, Claude Code's sentence still adds to the line; Codex's says the line again. */
    return state.engine === "claude" ? { words, tone: "warn", note: t("onboarding.engines.isolatedSignin") } : { words, tone: "warn", ...restated(t("onboarding.engines.note.signedOut")) };
  }
  if (kind === "connected") {
    const account = engineAccount(state);
    const plan = planName(account?.plan);
    const limit = account ? accountSessionLeft(account, now) : null;
    /* The version and the limit left; without a limit read, the version and the place; without a version, the limit and its hour. */
    const known = limit && install?.version ? t("onboarding.engines.note.versionLimit", { version: install.version, left: limit.left })
      : limit ? limitNote(limit, now, t) : installNote(install, t);
    return {
      words: plan ? t("onboarding.engines.connected", { plan }) : t("onboarding.engines.connectedNoPlan"),
      tone: "ok",
      ...(known !== null ? { note: known } : restated(t("onboarding.engines.note.connected"))),
    };
  }
  /* Several accounts: the line counts them, and only the ones that wait for a sign-in. */
  const waiting = state.accounts.filter((account) => !accountConnected(account));
  const head = t("onboarding.engines.accountsHeader", { count: state.accounts.length });
  if (!waiting.length) return { words: head, tone: "ok", note: installNote(install, t) ?? t("onboarding.engines.note.connected") };
  return {
    words: `${head} · ${t("onboarding.engines.accountsNeedSignIn", { count: waiting.length })}`,
    tone: "warn",
    note: t("onboarding.engines.note.waiting", { labels: waiting.map((account) => account.label).join(", ") }),
  };
}

/** Antigravity's state line, from the facts every surface of it reads. */
export function antigravityRowWords(agy: Pick<AntigravityAccount, "cli" | "auth" | "loaded" | "plan">, cli: AntigravityCliPresence, t: TFunction, install?: ProgramInstall | null, platform: HostPlatform = "linux"): ProgramStateWords | null {
  const state = antigravityCardState(agy, cli);
  if (state === "loading") return null;
  if (state === "missing") return { words: t("onboarding.engines.missing"), tone: "off", note: missingNote(platform, t) };
  /* With no version or path known the sentence says the line again: the row's own sign-in block names Google. */
  const found = installNote(install, t);
  if (state === "connected") return { words: agy.plan ? t("onboarding.engines.connected", { plan: agy.plan }) : t("onboarding.engines.connectedNoPlan"), tone: "ok", ...(found !== null ? { note: found } : restated(t("onboarding.engines.note.connected"))) };
  if (state === "signed-out") return { words: t("onboarding.engines.signedOut"), tone: "warn", ...(found !== null ? { note: found } : restated(t("onboarding.engines.note.agySignedOut"))) };
  return { words: t("onboarding.engines.authUnknown"), tone: "warn", note: t("onboarding.engines.note.agyUnknown") };
}

/** A row of the list: its head on one line with the action beside it, and what its state calls for under it. */
function ProgramRow({ program, kind, words, action, children }: { program: ProgramId; kind: string; words: ProgramStateWords | null; action?: ReactNode; children?: ReactNode }) {
  return (
    <li data-onboarding-engine={program} data-engine-state={kind} className="flex min-w-0 flex-col gap-2 px-4 py-3">
      <div className="flex min-w-0 items-center gap-x-3">
        <ProgramHead program={program} state={words} />
        {action ? <span data-settings-row-value="" className="flex shrink-0 items-center">{action}</span> : null}
      </div>
      {children ? <div className="flex min-w-0 flex-col gap-2 pl-[30px] max-sm:pl-0">{children}</div> : null}
    </li>
  );
}

function AddAccountAction({ program, disabled, onClick }: { program: ProgramId; disabled: boolean; onClick: () => void }) {
  const { t } = useLocale();
  return (
    <button type="button" data-onboarding-add-account={program} data-onboarding-row-action="" disabled={disabled} onClick={onClick} className={TEXT_ACTION}>
      <Plus className="h-3.5 w-3.5" aria-hidden />
      {t("onboarding.engines.addAccount")}
    </button>
  );
}

/** One account among several: its dot leads its name and plan, and a dot that is not green has its reason in words on a line under the name. */
function AccountLine({ state, account, now, signIn, phone }: { state: EngineAccountsState; account: AccountOption; now: number; signIn: ReturnType<typeof useAccountSignIn>; phone: boolean }) {
  const { t } = useLocale();
  const engine = state.engine;
  const connected = accountConnected(account);
  const phase = accountSignInPhase(engine, account, signIn);
  const limit = connected ? accountSessionLeft(account, now) : null;
  const low = limit !== null && limit.left < LOW_LIMIT;
  const tone: DotTone = connected && !low ? "ok" : "warn";
  const words = !connected ? t(phase === "running" ? "onboarding.engines.accountSigningIn" : "onboarding.engines.accountNeedsSignIn") : low ? t("onboarding.engines.accountLimitLeft", { left: limit.left }) : null;
  const note = !connected ? t(phase === "running" ? "onboarding.engines.note.accountSigningIn" : "onboarding.engines.note.accountSignedOut") : limit ? limitNote(limit, now, t) : t("onboarding.engines.note.connected");
  /* In a narrow card the note opens right under the account's own words, so there it adds only what they leave out:
     under the share of the limit, the hour it starts over. Words that say all of it ("needs sign-in", "signing in", a
     share with no hour known) leave the dot nothing to open. An account with room left has no words, and its note is whole. */
  const time = low ? resetClock(limit, now) : null;
  const inline = !connected ? null : !low ? undefined : time !== null ? t("onboarding.engines.note.resets", { time }) : null;
  const plan = planName(account.plan);
  const loginBusy = engine === "claude" && state.accounts.some((candidate) => candidate.login != null && NONTERMINAL_CLAUDE_LOGIN_PHASES.has(candidate.login.phase));
  const canSignIn = !connected && phase === null && accountSignInAvailable(engine, account);
  return (
    <li data-onboarding-account={account.id} data-account-state={connected ? (low ? "low" : "ready") : phase === "running" ? "signing-in" : "needs-sign-in"} className="flex min-w-0 flex-col gap-1.5 py-1">
      <div data-program-dot-row="" className="flex min-h-8 min-w-0 items-center gap-3 max-sm:min-h-11">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center">
            <RowDot tone={tone} note={note} inline={inline} label={account.label} />
            <span data-settings-row-label="" className="min-w-0 text-ui text-primary">
              <span className="font-semibold">{account.label}</span>
              {plan ? <span className="text-secondary"> · {plan}</span> : null}
            </span>
          </span>
          {words ? <span data-onboarding-account-words="" className={`pl-[12.5px] text-ui max-sm:pl-[15.5px] ${TONE_INK[tone]}`}>{words}</span> : null}
          <DotNotePlace />
        </div>
        {canSignIn ? (
          <span data-settings-row-value="" className="flex shrink-0">
            <button type="button" data-onboarding-sign-in={account.id} aria-label={t("mobile2.accounts.signInAria", { label: account.label })} disabled={state.mutation !== null || loginBusy} onClick={() => signIn.start(account)} className={`${BUTTON} ${BORDERED}`}>
              {t("onboarding.engines.signIn")}
            </button>
          </span>
        ) : null}
      </div>
      {phase ? <div className="pl-[12.5px] max-sm:pl-0"><AccountSignInBlock state={state} account={account} signIn={signIn} phone={phone} /></div> : null}
    </li>
  );
}

/** A Claude Code or Codex row over the engine's account store. */
function AccountsRow({ state, cli, install, now, platform, primary, lead, phone, stacked }: {
  state: EngineAccountsState;
  cli: CliPresence;
  /** Where the program's command was found and its version, for the dot's popover. */
  install?: ProgramInstall;
  now: number;
  platform: HostPlatform;
  /** This row's action is the step's next thing to press. */
  primary: boolean;
  /** No agent is signed in yet, so a code awaited here holds the step's one filled button. */
  lead: boolean;
  phone: boolean;
  /** The card is narrow: the row's action stands under its head. */
  stacked: boolean;
}) {
  const { t } = useLocale();
  const engine = state.engine;
  const signIn = useAccountSignIn(state);
  const [adding, setAdding] = useState(false);
  const phases = state.accounts.map((account) => accountSignInPhase(engine, account, signIn));
  const running = phases.includes("running");
  const kind = accountsRowKind(state, cli, platform, running);
  const base = accountsRowWords(state, kind, now, t, install, platform);
  /* While a sign-in is pending "Add an account" is disabled, and the row's dot says why. */
  const words = base && running && kind === "several" ? { ...base, note: t("onboarding.engines.note.signingIn") } : base;
  const only = state.accounts[0] ?? null;
  const loginBusy = engine === "claude" && state.accounts.some((account) => account.login != null && NONTERMINAL_CLAUDE_LOGIN_PHASES.has(account.login.phase));
  const busy = state.mutation !== null || loginBusy;
  const face = primary ? FILLED : BORDERED;
  const add = <AddAccountAction program={engine} disabled={busy || running || adding} onClick={() => setAdding(true)} />;
  const form = adding ? <AddAccountForm state={state} disabled={running} onClose={() => setAdding(false)} /> : null;

  let action: ReactNode = null;
  let body: ReactNode = null;
  if (kind === "missing") {
    body = <InstallCommand engine={engine} install={agentInstallCommand(engine, platform)} sentence={t(platform === "win32" ? "onboarding.engines.pastePowerShell" : "onboarding.engines.pasteTerminal")} />;
  } else if (kind === "unsupported") {
    body = <p className="text-ui text-secondary">{t("onboarding.engines.needsWslHelp")}</p>;
  } else if (kind === "signed-out") {
    /* A Claude sign-in that failed says so under the row and offers its own Retry. */
    const failed = only !== null && phases[0] === "failed";
    if (only === null) {
      /* A program with no account at all: a new account needs its name before the sign-in can start. */
      action = adding ? null : <button type="button" data-onboarding-add-account={engine} data-onboarding-row-action="" disabled={busy} onClick={() => setAdding(true)} className={`${BUTTON} ${face}`}>{t("onboarding.engines.addAccount")}</button>;
    } else if (!failed && accountSignInAvailable(engine, only)) {
      action = <button type="button" data-onboarding-sign-in={only.id} data-onboarding-row-action="" aria-label={t("mobile2.accounts.signInAria", { label: only.label })} disabled={busy} onClick={() => signIn.start(only)} className={`${BUTTON} ${face}`}>{t("onboarding.engines.signIn")}</button>;
    }
    body = failed ? <AccountSignInBlock state={state} account={only} signIn={signIn} phone={phone} /> : form;
  } else if (kind === "signing-in" && only) {
    body = <AccountSignInBlock state={state} account={only} signIn={signIn} phone={phone} primary={lead} />;
  } else if (kind === "connected") {
    action = adding ? null : add;
    body = form;
  } else if (kind === "several") {
    body = (
      <>
        <ul data-onboarding-accounts={engine} className="flex flex-col">
          {state.accounts.map((account) => <AccountLine key={account.id} state={state} account={account} now={now} signIn={signIn} phone={phone} />)}
        </ul>
        {form ?? <div>{add}</div>}
      </>
    );
  }
  /* In a narrow card the action stands under the head, where a list of several accounts ends too: beside a long state
     it would not fit. */
  if (stacked && action) {
    body = <><div>{action}</div>{body}</>;
    action = null;
  }
  return <ProgramRow program={engine} kind={kind} words={words} action={action}>{body}</ProgramRow>;
}

function AntigravityRow({ agy, cli, install, platform, onHost }: { agy: AntigravityAccount; cli: AntigravityCliPresence; install?: ProgramInstall; platform: HostPlatform; onHost: boolean }) {
  const { t } = useLocale();
  const state = antigravityCardState(agy, cli);
  return (
    <ProgramRow program="antigravity" kind={state} words={antigravityRowWords(agy, cli, t, install, platform)}>
      {state === "missing" ? (
        <InstallCommand engine="antigravity" install={agentInstallCommand("antigravity", platform)} sentence={t(platform === "win32" ? "onboarding.engines.pastePowerShell" : "onboarding.engines.pasteTerminal")} />
      ) : state === "signed-out" || state === "unknown" ? <AntigravitySignIn agy={agy} onHost={onHost} /> : null}
    </ProgramRow>
  );
}

type CopilotKind = "loading" | "missing" | "connected" | "signed-out";

function copilotKind(accounts: CopilotAccounts): CopilotKind {
  const { body } = accounts;
  if (body === null) return "loading";
  if (!body.cli.present) return "missing";
  return copilotSignedIn(body) ? "connected" : "signed-out";
}

/** Copilot's row: the guide starts no install and no sign-in for it, so each state that waits holds one sentence and no button. */
function CopilotRow({ accounts, install, onHost }: { accounts: CopilotAccounts; install?: ProgramInstall; onHost: boolean }) {
  const { t } = useLocale();
  const kind = copilotKind(accounts);
  const signedIn = copilotSignedIn(accounts.body);
  const found = installNote(install, t);
  const words: ProgramStateWords | null = kind === "loading" ? null
    : kind === "missing" ? { words: t("onboarding.engines.missing"), tone: "off", note: t("onboarding.engines.note.missingCopilot") }
      : kind === "connected" ? { words: t("onboarding.engines.connectedCopilot", { label: signedIn?.label ?? "" }), tone: "ok", note: t("onboarding.engines.copilotNote") }
        : { words: t("onboarding.engines.signedOut"), tone: "warn", ...(found !== null ? { note: found } : restated(t("onboarding.engines.note.copilotSignedOut"))) };
  return (
    <ProgramRow program="copilot" kind={kind} words={words}>
      {kind === "missing" ? <p data-onboarding-copilot-manual="" className="text-ui text-secondary">{t("onboarding.engines.copilotInstall")}</p>
        : kind === "signed-out" ? <p data-onboarding-copilot-manual="" className="text-ui text-secondary">{t(onHost ? "onboarding.engines.copilotSignInHere" : "onboarding.engines.copilotSignInHost")}</p> : null}
    </ProgramRow>
  );
}

/** The step's one "Check again": it asks about all four programs, so it stands on the heading's line and in no program's row. */
function RecheckAll({ onClick }: { onClick: () => Promise<unknown> }) {
  const { t } = useLocale();
  const [checking, setChecking] = useState(false);
  const Icon = checking ? Loader2 : RefreshCw;
  return (
    <button type="button" data-onboarding-recheck="" disabled={checking} aria-busy={checking || undefined} onClick={() => { setChecking(true); void onClick().finally(() => setChecking(false)); }} className={`${TEXT_ACTION} disabled:opacity-100`}>
      <Icon className={`h-3.5 w-3.5 ${checking ? "animate-spin motion-reduce:animate-none" : ""}`} aria-hidden />
      {t("onboarding.engines.recheck")}
    </button>
  );
}

/** Whether an agent account is signed in: Claude Code, Codex or Antigravity. Copilot runs single agents and no role. */
export function anyAgentSignedIn(claude: Pick<EngineAccountsState, "accounts">, codex: Pick<EngineAccountsState, "accounts">, antigravity: Pick<AntigravityAccount, "cli" | "auth" | "loaded">, cli: { claude: CliPresence; codex: CliPresence; antigravity?: CliPresence }): boolean {
  return engineReady(claude, cli.claude) || engineReady(codex, cli.codex) || antigravityCardState(antigravity, cli.antigravity ?? antigravity.cli) === "connected";
}

export function EnginesStep({ claude, codex, antigravity, cli, installs = {}, now, platform = "linux", onRecheck }: {
  claude: EngineAccountsState;
  codex: EngineAccountsState;
  /** Antigravity's recorded sign-in and its check; the dialog owns it because the mapping rows read it too. */
  antigravity: AntigravityAccount;
  cli: { claude: CliPresence; codex: CliPresence; antigravity?: CliPresence };
  /** What the same check learned of each installed program: its path and version, which the status popovers name. */
  installs?: ProgramInstalls;
  now: number;
  /** The system Delegatus runs on: on Windows a row shows the PowerShell line, and Codex asks for WSL 2. */
  platform?: HostPlatform;
  onRecheck: () => unknown;
}) {
  const { t } = useLocale();
  const phone = useIsMobile();
  const stacked = useNarrowRows();
  const onHost = useOnHost();
  /* Read at the step's level: the one "Check again" looks for all four programs, Copilot among them. */
  const copilot = useCopilotAccounts({ polling: true });
  const agyCli: AntigravityCliPresence = cli.antigravity ?? antigravity.cli;
  const lead = !anyAgentSignedIn(claude, codex, antigravity, cli);
  const awaitingCode = claude.accounts.some((account) => account.login?.phase === "awaiting_code");
  /* The first program that needs an action holds the filled button: a sign-in the row itself can start. A code Claude
     awaits holds its own filled Submit, and once an agent is signed in the footer's Continue is the filled one. */
  const startsHere = (state: EngineAccountsState, presence: CliPresence) => {
    if (accountsRowKind(state, presence, platform, state.accounts.some((account) => account.loginPending || (account.login != null && NONTERMINAL_CLAUDE_LOGIN_PHASES.has(account.login.phase)))) !== "signed-out") return false;
    const only = state.accounts[0];
    return !only || (only.login?.result?.status !== "failure" && accountSignInAvailable(state.engine, only));
  };
  const next: "claude" | "codex" | null = !lead || awaitingCode ? null : startsHere(claude, cli.claude) ? "claude" : startsHere(codex, cli.codex) ? "codex" : null;
  const copilotState = copilotKind(copilot);
  /* The button stands there while a program can still be installed by hand, and while Copilot waits for a sign-in made in its own terminal. */
  const offersRecheck = cli.claude === "missing" || cli.codex === "missing" || agyCli === "missing" || copilotState === "missing" || copilotState === "signed-out";
  const recheckAll = () => Promise.all([onRecheck(), copilot.load(), antigravity.reload()]);
  return (
    <div data-onboarding-accounts-step="" className="flex flex-col gap-3">
      <div>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3">
          <h2 className="text-title font-bold text-primary">{t("onboarding.engines.heading")}</h2>
          {offersRecheck ? <RecheckAll onClick={recheckAll} /> : null}
        </div>
        <p data-onboarding-accounts-lead="" className="mt-2 text-body leading-[1.45] text-secondary">{t("onboarding.engines.lead")}</p>
      </div>
      <ul data-onboarding-programs="" className="flex flex-col divide-y divide-border rounded-[12px] border border-border bg-card">
        <AccountsRow state={claude} cli={cli.claude} install={installs.claude} now={now} platform={platform} primary={next === "claude"} lead={lead} phone={phone} stacked={stacked} />
        <AccountsRow state={codex} cli={cli.codex} install={installs.codex} now={now} platform={platform} primary={next === "codex"} lead={lead} phone={phone} stacked={stacked} />
        <AntigravityRow agy={antigravity} cli={agyCli} install={installs.antigravity} platform={platform} onHost={onHost} />
        <CopilotRow accounts={copilot} install={installs.copilot} onHost={onHost} />
      </ul>
    </div>
  );
}
