import fs from "node:fs";
import path from "node:path";

import { listCodexAccounts, UnknownAccountError, type CodexAccount } from "./codex";
import { accountProbeIdentity, AccountMutationBusyError, withAccountMutationLock, withAccountMutationLockAsync } from "./accountMutation";
import { statePath } from "../configDir";
import { CODEX_ACCOUNTS_SOURCE, CODEX_LOGIN_SOURCE, readAccountSource, writeAccountSource } from "./accountsStore";
import {
  CodexAppServerClient,
  type AppServerAccountRead,
  type AppServerRateLimits,
  type AppServerResetCreditOutcome,
  type AppServerResetCredits,
  type DeviceCodeChallenge,
} from "./codexAppServer";
import type { AppServerEnvelope } from "./codexAppServerProtocol";

/** Authentication is only asserted after `account/read`; attempt state is a
 * separate recoverable record for device-login supervision. */
export type ManagedLoginState = "pending" | "completed" | "failed" | "stale" | "cancelled" | "idle" | "authenticated";
export type PersistedAttemptState = Exclude<ManagedLoginState, "idle" | "authenticated">;

export interface ManagedLoginAttempt {
  accountId: string;
  loginId: string;
  verificationUrl: string;
  userCode: string;
  startedAt: number;
}

export interface ManagedLoginSnapshot {
  state: ManagedLoginState;
  attemptState: PersistedAttemptState | null;
  deviceAuth: { url: string; code: string } | null;
}

export interface ManagedCodexRuntimeOptions {
  startClient?: (home: string) => Promise<CodexAppServerClient>;
  now?: () => number;
  stateFile?: string;
}

export interface CodexQuotaProbe {
  account: AppServerAccountRead;
  rateLimits: AppServerRateLimits;
  /** Usage-limit reset credits reported beside the limits (issue #1373). */
  resetCredits: AppServerResetCredits | null;
  authenticated: boolean;
  envelope: AppServerEnvelope | null;
}

/** One redemption attempt (issue #1373): the reading taken just before, the
    backend's answer, and the reading taken right after so the new window is
    visible without a second round trip. `refusedLocally` marks the case where
    the pre-read showed no available credit and nothing was sent. */
export interface CodexResetCreditRedemption {
  outcome: AppServerResetCreditOutcome;
  refusedLocally: boolean;
  before: CodexQuotaProbe;
  after: CodexQuotaProbe;
}

type AttemptReason = "child-died" | "login-unsuccessful" | "cancelled" | "viewer-restarted" | "account-read-failed" | "start-failed";

interface PersistedAttempt {
  accountId: string;
  generation: number;
  state: PersistedAttemptState;
  startedAt: number;
  updatedAt: number;
  reason: AttemptReason | null;
}

interface StoredAttempts {
  version: 1;
  attempts: Record<string, PersistedAttempt>;
}

interface ActiveAttempt extends PersistedAttempt {
  home: string;
  client: CodexAppServerClient | null;
  loginId: string | null;
  verificationUrl: string | null;
  userCode: string | null;
  startPromise: Promise<ManagedLoginAttempt>;
}

function canonicalHome(home: string): string {
  const resolved = path.resolve(home);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

/** Whether this installation records a Codex registry at all. An installation
    that has never had one trusts the account it was handed; since #1870 that is
    a collection with no registry rows rather than a pathname with no file. */
function codexRegistryRecorded(): boolean {
  const read = readAccountSource(CODEX_ACCOUNTS_SOURCE);
  if (read.kind === "collection") return read.body !== undefined;
  if (read.kind === "gap") return true;
  try { fs.lstatSync(statePath("codex-accounts.json")); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function currentCodexAccount(account: CodexAccount): CodexAccount {
  if (!codexRegistryRecorded()) return account;
  const current = listCodexAccounts().find((candidate) => candidate.id === account.id);
  if (!current || current.kind !== account.kind || canonicalHome(current.home) !== canonicalHome(account.home)) {
    throw new UnknownAccountError(account.id);
  }
  return current;
}

function safeStoredAttempt(value: unknown): value is PersistedAttempt {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PersistedAttempt>;
  return typeof item.accountId === "string" && typeof item.generation === "number" &&
    typeof item.startedAt === "number" && typeof item.updatedAt === "number" &&
    (item.state === "pending" || item.state === "completed" || item.state === "failed" || item.state === "stale" || item.state === "cancelled") &&
    (item.reason === null || item.reason === "child-died" || item.reason === "login-unsuccessful" || item.reason === "cancelled" || item.reason === "viewer-restarted" || item.reason === "account-read-failed" || item.reason === "start-failed");
}

/* Device-login attempts are the `accounts` collection of state.sqlite (#1870,
   slice 7), one row per canonical CODEX_HOME. `file` names the store's
   directory; a store this process cannot read reports no attempt, the way an
   absent or damaged file always did. */
function readStoredAttempts(file: string): Map<string, PersistedAttempt> {
  try {
    const read = readAccountSource(CODEX_LOGIN_SOURCE, path.dirname(file));
    const parsed = (read.kind === "collection"
      ? read.body ?? {}
      : JSON.parse(fs.readFileSync(file, "utf8"))) as Partial<StoredAttempts>;
    if (parsed.version !== 1 || !parsed.attempts || typeof parsed.attempts !== "object") return new Map();
    return new Map(Object.entries(parsed.attempts).filter((entry): entry is [string, PersistedAttempt] => safeStoredAttempt(entry[1])));
  } catch {
    return new Map();
  }
}

/**
 * Supervises one device-login child per canonical CODEX_HOME. Persistent state
 * deliberately contains no challenge, login id, token, or auth-file contents.
 */
export class ManagedCodexRuntime {
  private readonly active = new Map<string, ActiveAttempt>();
  private records: Map<string, PersistedAttempt>;
  private readonly pendingRecords = new Map<string, PersistedAttempt>();
  private recordDrain: Promise<void> | null = null;
  private recordRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private recordRetryAttempt = 0;
  private readonly startClient: (home: string) => Promise<CodexAppServerClient>;
  private readonly now: () => number;
  private readonly stateFile: string;

  constructor(options: ManagedCodexRuntimeOptions = {}) {
    this.startClient = options.startClient ?? ((home) => CodexAppServerClient.start({ home }));
    this.now = options.now ?? (() => Date.now());
    this.stateFile = options.stateFile ?? statePath("codex-login-attempts.json");
    this.records = readStoredAttempts(this.stateFile);
  }

  async startLogin(account: CodexAccount): Promise<ManagedLoginAttempt> {
    return this.beginLogin(account, false);
  }

  /** Replaces a stranded attempt for an existing managed account. */
  async retryLogin(account: CodexAccount): Promise<ManagedLoginAttempt> {
    return this.beginLogin(account, true);
  }

  private beginLogin(account: CodexAccount, replace: boolean): Promise<ManagedLoginAttempt> {
    if (account.kind !== "managed") return Promise.reject(new Error("only managed Codex accounts can start an app-server login"));
    this.records = readStoredAttempts(this.stateFile);
    const home = canonicalHome(account.home);
    const existing = this.active.get(home);
    if (existing && !replace) return existing.startPromise;

    const previous = existing ?? null;
    const recorded = this.records.get(home);
    const now = this.now();
    const generation = Math.max(recorded?.generation ?? 0, previous?.generation ?? 0) + 1;
    // This reservation happens before the first await. Concurrent callers share
    // this promise and therefore own one child and one challenge deterministically.
    const attempt = {
      accountId: account.id,
      generation,
      state: "pending" as const,
      startedAt: now,
      updatedAt: now,
      reason: null,
      home,
      client: null,
      loginId: null,
      verificationUrl: null,
      userCode: null,
      startPromise: null as unknown as Promise<ManagedLoginAttempt>,
    } satisfies Omit<ActiveAttempt, "startPromise"> & { startPromise: Promise<ManagedLoginAttempt> };
    this.active.set(home, attempt);
    this.record(home, attempt);
    attempt.startPromise = this.launch(account, attempt, previous);
    return attempt.startPromise;
  }

  private async launch(account: CodexAccount, attempt: ActiveAttempt, previous: ActiveAttempt | null): Promise<ManagedLoginAttempt> {
    if (previous) await this.stopSuperseded(previous);
    try {
      const client = await this.startClient(account.home);
      if (!this.owns(attempt)) {
        client.close();
        throw new Error("a newer managed login owns this Codex home");
      }
      attempt.client = client;
      client.onLifecycle((event) => {
        if (event.type === "failed") this.settle(attempt, "failed", "child-died", false);
      });
      client.onNotification((notification) => {
        if (notification.method !== "account/login/completed" || !isCompletion(notification.params, attempt.loginId)) return;
        this.settle(attempt, notification.params.success ? "completed" : "failed", notification.params.success ? null : "login-unsuccessful", true);
      });
      const challenge = await client.startDeviceLogin();
      if (!this.owns(attempt)) {
        client.close();
        throw new Error("a newer managed login owns this Codex home");
      }
      attempt.loginId = challenge.loginId;
      attempt.verificationUrl = challenge.verificationUrl;
      attempt.userCode = challenge.userCode;
      return publicAttempt(attempt);
    } catch (error) {
      this.settle(attempt, "failed", "start-failed", true);
      throw error;
    }
  }

  async cancelLogin(accountId: string): Promise<boolean> {
    const active = [...this.active.values()].find((attempt) => attempt.accountId === accountId);
    if (active) {
      await this.cancelAttempt(active, "cancelled");
      return true;
    }
    this.records = readStoredAttempts(this.stateFile);
    const stored = [...this.records.entries()].find(([, attempt]) => attempt.accountId === accountId);
    if (!stored) return false;
    this.record(stored[0], { ...stored[1], state: "cancelled", updatedAt: this.now(), reason: "cancelled" });
    return true;
  }

  private async cancelAttempt(attempt: ActiveAttempt, reason: AttemptReason): Promise<void> {
    if (!this.owns(attempt)) return;
    const client = attempt.client;
    this.settle(attempt, "cancelled", reason, false);
    if (!client) {
      await attempt.startPromise.catch(() => undefined);
      return;
    }
    if (!attempt.loginId) {
      client.close();
      await attempt.startPromise.catch(() => undefined);
      return;
    }
    try { await client.cancelLogin(attempt.loginId); } catch { /* closing the child finalizes the cancellation */ }
    finally { client.close(); }
  }

  /** A replacement already owns the map slot, so the usual generation fence
   * must not prevent its predecessor from being reaped. Its persisted record
   * is intentionally left alone: the newer generation is authoritative. */
  private async stopSuperseded(attempt: ActiveAttempt): Promise<void> {
    const client = attempt.client;
    if (!client || !attempt.loginId) {
      client?.close();
      return;
    }
    try { await client.cancelLogin(attempt.loginId); } catch { /* close below completes supersession */ }
    finally { client.close(); }
  }

  async loginSnapshot(account: CodexAccount): Promise<ManagedLoginSnapshot> {
    const snapshot = await withAccountMutationLockAsync(() => {
      const current = currentCodexAccount(account);
      const home = canonicalHome(current.home);
      return { account: current, home, identity: accountProbeIdentity(current),
        active: this.active.get(home), stored: readStoredAttempts(this.stateFile).get(home) };
    }, { holder: "Codex login snapshot" });
    if (snapshot.account.kind !== "managed") return { state: snapshot.account.authPresent ? "authenticated" : "idle", attemptState: null, deviceAuth: null };
    const status = await this.readAccount(snapshot.active?.client ?? null, snapshot.account.home)
      .then((value) => ({ value, failed: false as const }), () => ({ value: null, failed: true as const }));
    return await withAccountMutationLockAsync(() => {
      const current = currentCodexAccount(snapshot.account);
      const active = this.active.get(snapshot.home);
      const stored = readStoredAttempts(this.stateFile).get(snapshot.home);
      if (accountProbeIdentity(current) !== snapshot.identity
        || active !== snapshot.active || JSON.stringify(stored) !== JSON.stringify(snapshot.stored)) return this.peekLogin(current);
      return this.commitLoginSnapshot(snapshot.home, active, stored, status);
    }, { holder: "Codex login commit" });
  }

  private commitLoginSnapshot(home: string, active: ActiveAttempt | undefined, stored: PersistedAttempt | undefined,
    read: { value: AppServerAccountRead | null; failed: boolean }): ManagedLoginSnapshot {
    try {
      if (read.failed || !read.value) throw new Error("account read failed");
      if (isSupportedChatGptAccount(read.value)) {
        if (active) this.settle(active, "completed", null, true);
        else if (stored) this.record(home, { ...stored, state: "completed", updatedAt: this.now(), reason: null });
        return { state: "authenticated", attemptState: "completed", deviceAuth: null };
      }
      if (active?.state === "pending" && active.verificationUrl && active.userCode) {
        return { state: "pending", attemptState: "pending", deviceAuth: { url: active.verificationUrl, code: active.userCode } };
      }
      if (stored?.state === "pending") {
        const stale = { ...stored, state: "stale" as const, updatedAt: this.now(), reason: "viewer-restarted" as const };
        this.record(home, stale);
        return { state: "stale", attemptState: "stale", deviceAuth: null };
      }
      return stored ? { state: stored.state, attemptState: stored.state, deviceAuth: null } : { state: "idle", attemptState: null, deviceAuth: null };
    } catch {
      const base = stored ?? active;
      if (base) {
        const stale = { ...base, state: "stale" as const, updatedAt: this.now(), reason: "account-read-failed" as const };
        this.settle(active ?? null, "stale", "account-read-failed", true);
        if (!active) this.record(home, stale);
        return { state: "stale", attemptState: "stale", deviceAuth: null };
      }
      return { state: "stale", attemptState: "stale", deviceAuth: null };
    }
  }

  /** Request-safe in-memory projection. Authentication probes and persisted
   * attempt transitions remain owned by the background controller. */
  peekLogin(account: CodexAccount): ManagedLoginSnapshot {
    return this.peekLoginFrom(account, readStoredAttempts(this.stateFile));
  }

  peekLogins(accounts: readonly CodexAccount[]): Map<string, ManagedLoginSnapshot> {
    const stored = readStoredAttempts(this.stateFile);
    return new Map(accounts.map((account) => [account.id, this.peekLoginFrom(account, stored)]));
  }

  private peekLoginFrom(account: CodexAccount, storedAttempts: Map<string, PersistedAttempt>): ManagedLoginSnapshot {
    if (account.kind !== "managed") return { state: account.authPresent ? "authenticated" : "idle", attemptState: null, deviceAuth: null };
    const home = canonicalHome(account.home);
    const active = this.active.get(home);
    const stored = storedAttempts.get(home);
    if (stored?.state === "pending" && active?.state === "pending" && active.verificationUrl && active.userCode) {
      return { state: "pending", attemptState: "pending", deviceAuth: { url: active.verificationUrl, code: active.userCode } };
    }
    return stored
      ? { state: stored.state, attemptState: stored.state, deviceAuth: null }
      : active?.state === "pending"
        ? { state: "pending", attemptState: "pending", deviceAuth: null }
      : { state: "idle", attemptState: null, deviceAuth: null };
  }

  /** Reads a structured rate snapshot through an active login child when one exists. */
  async readRateLimits(account: CodexAccount): Promise<AppServerRateLimits> {
    return (await this.probeQuota(account)).rateLimits;
  }

  async verifyAuthentication(account: CodexAccount): Promise<boolean> {
    return (await this.probeQuota(account)).authenticated;
  }

  /** Performs the two read-only account calls on one app-server client. */
  async probeQuota(account: CodexAccount): Promise<CodexQuotaProbe> {
    const snapshot = await withAccountMutationLockAsync(() => {
      const current = currentCodexAccount(account);
      return { account: current, identity: accountProbeIdentity(current) };
    }, { holder: "Codex quota snapshot" });
    const result = await this.probeQuotaUnlocked(snapshot.account);
    await withAccountMutationLockAsync(() => {
      if (accountProbeIdentity(currentCodexAccount(snapshot.account)) !== snapshot.identity) throw new Error("Codex account changed during quota probe");
    }, { holder: "Codex quota recheck" });
    return result;
  }

  private async probeQuotaUnlocked(account: CodexAccount): Promise<CodexQuotaProbe> {
    const active = this.active.get(canonicalHome(account.home));
    if (active?.client) return this.probeQuotaFrom(active.client);
    const client = await this.startClient(account.home);
    try { return await this.probeQuotaFrom(client); }
    finally { client.close(); }
  }

  private async readAccount(existing: CodexAppServerClient | null, home: string) {
    if (existing) return existing.readAccount();
    const client = await this.startClient(home);
    try { return await client.readAccount(); }
    finally { client.close(); }
  }

  private async probeQuotaFrom(client: CodexAppServerClient): Promise<CodexQuotaProbe> {
    const account = await client.readAccount();
    const { rateLimits, resetCredits } = await client.readRateLimits();
    return { account, rateLimits, resetCredits, authenticated: isSupportedChatGptAccount(account), envelope: client.inboundEnvelope() };
  }

  /** Redeems one usage-limit reset credit for `account` (issue #1373) on a
      single app-server client: read, consume, read again. A pre-read that
      shows zero available credits refuses locally and sends nothing — the
      backend is only asked to spend when the account is known to hold one. */
  async redeemResetCredit(account: CodexAccount, idempotencyKey: string): Promise<CodexResetCreditRedemption> {
    const snapshot = await withAccountMutationLockAsync(() => {
      const current = currentCodexAccount(account);
      return { account: current, identity: accountProbeIdentity(current) };
    }, { holder: "Codex credit admission" });
    const recheck = () => withAccountMutationLockAsync(() => {
      if (accountProbeIdentity(currentCodexAccount(snapshot.account)) !== snapshot.identity) throw new Error("Codex account changed during credit redemption");
    }, { holder: "Codex credit recheck" });
    const result = await this.redeemResetCreditUnlocked(snapshot.account, idempotencyKey, recheck);
    await recheck();
    return result;
  }

  private async redeemResetCreditUnlocked(account: CodexAccount, idempotencyKey: string, recheck: () => Promise<void>): Promise<CodexResetCreditRedemption> {
    const active = this.active.get(canonicalHome(account.home));
    if (active?.client) return this.redeemResetCreditFrom(active.client, idempotencyKey, recheck);
    const client = await this.startClient(account.home);
    try { return await this.redeemResetCreditFrom(client, idempotencyKey, recheck); }
    finally { client.close(); }
  }

  private async redeemResetCreditFrom(client: CodexAppServerClient, idempotencyKey: string, recheck: () => Promise<void>): Promise<CodexResetCreditRedemption> {
    const before = await this.probeQuotaFrom(client);
    if (before.resetCredits !== null && before.resetCredits.availableCount === 0) {
      return { outcome: "noCredit", refusedLocally: true, before, after: before };
    }
    await recheck();
    const outcome = await client.consumeRateLimitResetCredit({ idempotencyKey });
    const after = await this.probeQuotaFrom(client);
    return { outcome, refusedLocally: false, before, after };
  }

  private owns(attempt: ActiveAttempt): boolean {
    return this.active.get(attempt.home)?.generation === attempt.generation;
  }

  private settle(attempt: ActiveAttempt | null, state: PersistedAttemptState, reason: AttemptReason | null, close: boolean): void {
    if (!attempt || !this.owns(attempt)) return;
    this.active.delete(attempt.home);
    const completed = { ...attempt, state, updatedAt: this.now(), reason };
    try { this.record(attempt.home, completed); }
    catch { this.queueRecord(attempt.home, completed); }
    finally { if (close) attempt.client?.close(); }
  }

  private record(home: string, attempt: PersistedAttempt): void {
    try {
      withAccountMutationLock(() => this.writeRecords(new Map([[home, attempt]])));
    } catch (error) {
      if (!(error instanceof AccountMutationBusyError)) throw error;
      this.queueRecord(home, attempt);
    }
  }

  private writeRecords(updates: Map<string, PersistedAttempt>): void {
    this.records = readStoredAttempts(this.stateFile);
    let changed = false;
    for (const [home, attempt] of updates) {
      const previous = this.records.get(home);
      if (previous && previous.generation > attempt.generation) continue;
      this.records.set(home, {
        accountId: attempt.accountId,
        generation: attempt.generation,
        state: attempt.state,
        startedAt: attempt.startedAt,
        updatedAt: attempt.updatedAt,
        reason: attempt.reason,
      });
      changed = true;
    }
    if (!changed) return;
    const stored: StoredAttempts = { version: 1, attempts: Object.fromEntries(this.records) };
    writeAccountSource(CODEX_LOGIN_SOURCE, stored, path.dirname(this.stateFile));
  }

  private queueRecord(home: string, attempt: PersistedAttempt): void {
    const queued = this.pendingRecords.get(home);
    if (!queued || queued.generation <= attempt.generation) this.pendingRecords.set(home, attempt);
    this.startRecordDrain();
  }

  private startRecordDrain(): void {
    if (this.recordDrain || this.recordRetryTimer) return;
    const drain = async () => {
      while (this.pendingRecords.size > 0) {
        const batch = new Map(this.pendingRecords);
        await withAccountMutationLockAsync(async () => this.writeRecords(batch));
        for (const [queuedHome, queuedAttempt] of batch) {
          if (this.pendingRecords.get(queuedHome) === queuedAttempt) this.pendingRecords.delete(queuedHome);
        }
      }
    };
    const pending = drain();
    this.recordDrain = pending;
    void pending.then(
      () => {
        this.recordDrain = null;
        this.recordRetryAttempt = 0;
        if (this.pendingRecords.size > 0) this.startRecordDrain();
      },
      () => {
        this.recordDrain = null;
        this.recordRetryAttempt += 1;
        const retryMs = Math.min(100 * 2 ** Math.min(this.recordRetryAttempt - 1, 8), 30_000);
        if (this.recordRetryAttempt === 1 || (this.recordRetryAttempt & (this.recordRetryAttempt - 1)) === 0) {
          console.error(`[codex accounts] Codex login outcome persistence failed; retry ${this.recordRetryAttempt} in ${retryMs}ms`);
        }
        this.recordRetryTimer = setTimeout(() => {
          this.recordRetryTimer = null;
          this.startRecordDrain();
        }, retryMs);
        this.recordRetryTimer.unref?.();
      },
    );
  }
}

function isSupportedChatGptAccount(account: AppServerAccountRead): boolean {
  return account.account?.type === "chatgpt";
}

function publicAttempt(attempt: ActiveAttempt): ManagedLoginAttempt {
  if (!attempt.loginId || !attempt.verificationUrl || !attempt.userCode) throw new Error("managed login challenge is incomplete");
  return { accountId: attempt.accountId, loginId: attempt.loginId, verificationUrl: attempt.verificationUrl, userCode: attempt.userCode, startedAt: attempt.startedAt };
}

function isCompletion(value: unknown, loginId: string | null): value is { loginId?: unknown; success: boolean } {
  if (!value || typeof value !== "object" || !loginId) return false;
  const completion = value as { loginId?: unknown; success?: unknown };
  return completion.loginId === loginId && typeof completion.success === "boolean";
}

let defaultRuntime: ManagedCodexRuntime | null = null;

export function managedCodexRuntime(): ManagedCodexRuntime {
  defaultRuntime ??= new ManagedCodexRuntime();
  return defaultRuntime;
}

/** Test seam: routes keep their production surface while tests supply fake stdio children. */
export function setManagedCodexRuntimeForTests(runtime: ManagedCodexRuntime | null): void {
  defaultRuntime = runtime;
}

export function deviceChallengeFrom(response: DeviceCodeChallenge): { url: string; code: string } {
  return { url: response.verificationUrl, code: response.userCode };
}
