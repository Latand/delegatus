import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { stateDir, statePath } from "@/lib/configDir";
import { withoutUnsupportedApiCredentials } from "@/lib/environmentIsolation";

import type { AccountContext } from "./contracts";

/**
 * Antigravity CLI (`agy`) account boundary (docs/design/antigravity-engine.md §3.6).
 *
 * `agy 1.5.13` resolves Google OAuth credentials from the host machine's
 * signed-in account even when `HOME` is redirected, so v1 models a single host
 * account (`"default"`). Delegatus owns the NDJSON transcripts under
 * `<config>/agent-log-viewer/accounts/antigravity/default/sessions/<id>/events.jsonl`,
 * which isolates test and scratch-instance state cleanly under `LLV_STATE_DIR`
 * without touching the operator's `~/.gemini/antigravity-cli/`.
 */

export const ANTIGRAVITY_DEFAULT_ACCOUNT_ID = "default";

export interface AntigravityAuthRecord {
  authenticated: boolean;
  tierName: string | null;
  tierId: string | null;
  checkedAt: string;
}

export interface AntigravityAccount {
  id: string;
  label: string;
  kind: "legacy";
  home: string;
  /** `<home>/sessions`, where AntigravityAcpHost writes per-session `events.jsonl`. */
  sessionsDir: string;
  createdAt: number;
  auth: "signed_in" | "signed_out" | "unknown";
  tierName: string | null;
}

export class UnknownAntigravityAccountError extends Error {
  constructor(id: string) {
    super(`unknown Antigravity account: ${id}`);
    this.name = "UnknownAntigravityAccountError";
  }
}

export class NoAntigravityAccountError extends Error {
  constructor() {
    super("no Antigravity CLI account is available; install `agy` and sign in with Google");
    this.name = "NoAntigravityAccountError";
  }
}

export function antigravityAccountsRoot(): string {
  return path.join(path.dirname(stateDir()), "accounts", "antigravity");
}

export function antigravityDefaultHome(): string {
  return path.join(antigravityAccountsRoot(), ANTIGRAVITY_DEFAULT_ACCOUNT_ID);
}

export function antigravityDefaultSessionsDir(): string {
  return path.join(antigravityDefaultHome(), "sessions");
}

function authStatePath(): string {
  return statePath("antigravity-auth-state.json");
}

/** Reads the last observed ACP auth/tier state, returning a fresh caller-owned copy. */
export function readAntigravityAuthState(): AntigravityAuthRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(authStatePath(), "utf8")) as Partial<AntigravityAuthRecord>;
    if (typeof raw.authenticated !== "boolean" || typeof raw.checkedAt !== "string") return null;
    return {
      authenticated: raw.authenticated,
      tierName: typeof raw.tierName === "string" && raw.tierName.trim() ? raw.tierName.trim() : null,
      tierId: typeof raw.tierId === "string" && raw.tierId.trim() ? raw.tierId.trim() : null,
      checkedAt: raw.checkedAt,
    };
  } catch {
    return null;
  }
}

/** Atomically records non-sensitive ACP auth/tier metadata (never tokens or emails). */
export function recordAntigravityAuthState(record: AntigravityAuthRecord): void {
  const file = authStatePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const payload: AntigravityAuthRecord = {
    authenticated: Boolean(record.authenticated),
    tierName: record.tierName?.trim() || null,
    tierId: record.tierId?.trim() || null,
    checkedAt: record.checkedAt,
  };
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function antigravityAuthCheckedAt(): string | null {
  return readAntigravityAuthState()?.checkedAt ?? null;
}

export function listAntigravityAccounts(): AntigravityAccount[] {
  const home = antigravityDefaultHome();
  const observed = readAntigravityAuthState();
  const auth: AntigravityAccount["auth"] = observed === null
    ? "unknown"
    : observed.authenticated ? "signed_in" : "signed_out";
  return [{
    id: ANTIGRAVITY_DEFAULT_ACCOUNT_ID,
    label: "Default",
    kind: "legacy",
    home,
    sessionsDir: path.join(home, "sessions"),
    createdAt: 0,
    auth,
    tierName: observed?.tierName ?? null,
  }];
}

export function activeAntigravityAccountId(): string {
  return ANTIGRAVITY_DEFAULT_ACCOUNT_ID;
}

export function antigravitySessionRoots(): string[] {
  return listAntigravityAccounts().map((account) => account.sessionsDir);
}

export function antigravityHomeOwningSessionPath(pathname: string): string | null {
  let target: string;
  try { target = fs.realpathSync(pathname); }
  catch { target = path.resolve(pathname); }
  for (const account of listAntigravityAccounts()) {
    let root: string;
    try { root = fs.realpathSync(account.sessionsDir); }
    catch { root = path.resolve(account.sessionsDir); }
    if (target.startsWith(root + path.sep)) return account.home;
  }
  return null;
}

/** ACP's "authentication required" code, and the words an agy build uses when it refuses a session for lack of a Google sign-in. One rule for the launch path and the probe. */
export const ACP_AUTH_REQUIRED_CODE = -32000;

/* agy answers a spent quota with the same -32000 as a missing sign-in; the account is still signed in then. */
const QUOTA_REFUSAL = /quota|exhaust|rate.?limit|too many requests/i;

export function isAntigravityAuthFailure(failure: { code?: unknown; message?: unknown }): boolean {
  const message = typeof failure.message === "string" ? failure.message : "";
  if (QUOTA_REFUSAL.test(message)) return false;
  if (failure.code === ACP_AUTH_REQUIRED_CODE) return true;
  return /auth|sign.?in|log.?in|credential|oauth/i.test(message);
}

export function antigravityAccountContext(account: AntigravityAccount): AccountContext {
  return {
    engine: "antigravity",
    accountId: account.id,
    kind: account.kind,
    home: account.home,
    transcriptRoot: account.sessionsDir,
    env: withoutUnsupportedApiCredentials(process.env),
  };
}

export function antigravityAccountForSpawn(requested?: string | null): AccountContext {
  const id = requested?.trim() || activeAntigravityAccountId();
  const account = listAntigravityAccounts().find((candidate) => candidate.id === id);
  if (!account) throw new UnknownAntigravityAccountError(id);
  return antigravityAccountContext(account);
}
