import { setTimeout as delay } from "node:timers/promises";
import { isStagingMode } from "@/lib/staging";
import { PLAN_SCOPE } from "./constants";
import { PlanError, unusableRefresh } from "./errors";
import { validateIdentity } from "./idToken";
import { PlanOAuth } from "./oauth";
import { PlanOidc, readTokenSet } from "./oidc";
import { PLAN_USAGE_URL, type PlanStatus } from "./public";
import { streamPlanResponse, validatePlanRequest } from "./responses";
import { PlanStore, type Credentials } from "./store";

const REFRESH_WINDOW = 60_000;
const REFRESH_LIFETIME = 30 * 86_400_000;

export class PlanSession {
  readonly oauth: PlanOAuth;
  private signingOut = false;

  constructor(readonly store = new PlanStore(), private readonly oidc = new PlanOidc(), private readonly now = Date.now) {
    this.oauth = new PlanOAuth(store, oidc, now);
  }

  private unavailable(row: Credentials | undefined, model?: string) {
    if (isStagingMode() || this.signingOut || !row || row.signedOut || row.pendingRegistration) return "not_connected";
    if (row.reconnect || (row.tokens && row.tokens.refreshedAt + REFRESH_LIFETIME <= this.now())) return "reconnect_required";
    if (!row.tokens) return "not_connected";
    if (!row.tokens.scopes.includes(PLAN_SCOPE) && !row.pendingRotation) return "plan_disabled";
    if (model && row.models && !row.models.includes(model)) return "plan_disabled";
    return undefined;
  }

  async status(model: string, owner: boolean, local: boolean): Promise<PlanStatus> {
    if (isStagingMode()) return { state: "off_staging" };
    if (owner && !local) return { state: "remote_browser" };
    try {
      const wasChanging = this.oauth.pending || this.signingOut;
      const row = await this.store.credentials();
      const unavailable = this.unavailable(row);
      const reason = owner ? this.oauth.reason ?? row?.reconnect : undefined;
      let state: PlanStatus["state"] = unavailable ?? (row?.pendingRotation ? "reconnect_required" : "connected");
      // A read already in flight when the callback settles can still hold the
      // pending registration. Keep polling once so the page sees the commit.
      if (wasChanging || this.oauth.pending || this.signingOut) state = "connecting";
      else if (reason === "client_rejected" || reason === "account_mismatch" || reason === "reconnect_required") state = "reconnect_required";
      if (!owner) return { state };
      return { state, reason, acknowledged: row?.acknowledged === true, usageUrl: PLAN_USAGE_URL,
        ...(row?.email && !row.signedOut ? { account: { email: row.email } } : {}),
        ...(row?.models && !row.signedOut ? { planModels: { voiceBackend: row.models.includes(model) } } : {}),
        revocationConfirmed: row?.revocationConfirmed,
        authorizeUrl: this.oauth.retryUrl };
    } catch (error) {
      return owner ? { state: "error", reason: error instanceof PlanError ? error.reason : "credential_file" } : { state: "error" };
    }
  }

  async eligible(model: string): Promise<boolean> {
    if (isStagingMode() || this.signingOut) return false;
    try {
      const row = await this.store.credentials();
      return !this.unavailable(row, model);
    } catch { return false; }
  }

  private requireConnection(row: Credentials | undefined, model: string): asserts row is Credentials & {
    tokens: NonNullable<Credentials["tokens"]> & { refreshToken: string };
  } {
    const reason = this.unavailable(row, model);
    if (reason) throw new PlanError(reason);
    if (!row?.tokens?.refreshToken) throw new PlanError("not_connected");
  }

  private reconnect(row: Credentials, reason: "reconnect_required" | "client_rejected"): never {
    this.store.write("credentials", { ...row, tokens: undefined, pendingRotation: undefined, reconnect: reason });
    throw new PlanError("reconnect_required");
  }

  private async access(model: string, signal: AbortSignal, owner: () => boolean): Promise<string> {
    if (isStagingMode() || this.signingOut) throw new PlanError("not_connected");
    const row = await this.store.credentials();
    this.requireConnection(row, model);
    signal.throwIfAborted();
    if (!row.pendingRotation && row.tokens.expiresAt > this.now() + REFRESH_WINDOW) return row.tokens.accessToken;
    // An admitted refresh must checkpoint a rotation even if the voice turn ends.
    // Before admission the caller can still cancel without consuming the token.
    try {
      return await this.store.transaction("credentials", async () => {
        let current = await this.store.credentials();
        this.requireConnection(current, model);
        if (!owner()) throw new PlanError("plan_disabled");
        signal.throwIfAborted();
        const now = this.now();
        if (!current.pendingRotation && current.tokens.expiresAt > now
          && (current.tokens.expiresAt > now + REFRESH_WINDOW || current.tokens.refreshToken !== row.tokens.refreshToken)) {
          return current.tokens.accessToken;
        }
        const deadline = AbortSignal.timeout(15_000);
        if (!current.pendingRotation) {
          const earliest = current.tokens.earliestRefreshAt ?? 0;
          if (earliest > now) {
            if (current.tokens.expiresAt > now) return current.tokens.accessToken;
            throw new PlanError("retry_later");
          }
          const result = await this.oidc.exchange({ grant_type: "refresh_token", client_id: current.clientId,
            refresh_token: current.tokens.refreshToken }, deadline);
          if (result.code === "invalid_client") return this.reconnect(current, "client_rejected");
          if (result.code && unusableRefresh.has(result.code)) return this.reconnect(current, "reconnect_required");
          if (result.status !== undefined) throw new PlanError("retry_later");
          let tokens;
          try { tokens = readTokenSet(result.body, this.now(), current.tokens); }
          catch { return this.reconnect(current, "reconnect_required"); }
          current = { ...current, tokens, pendingRotation: result.body?.id_token ? true : undefined, savedAt: this.now() };
          this.store.write("credentials", current);
        }
        if (current.pendingRotation) {
          try {
            const tokens = current.tokens!;
            const identity = await validateIdentity(this.oidc, tokens.idToken, current.clientId, tokens.refreshedAt, deadline);
            if (identity.subject !== current.subject) throw new PlanError("reconnect_required");
            current = { ...current, ...identity, pendingRotation: undefined };
            this.store.write("credentials", current);
          } catch (error) {
            if (error instanceof PlanError && error.reason === "reconnect_required") return this.reconnect(current, "reconnect_required");
            throw new PlanError("retry_later");
          }
        }
        this.requireConnection(current, model);
        if (current.tokens.expiresAt <= this.now()) throw new PlanError("retry_later");
        return current.tokens.accessToken;
      }, 15_000);
    } catch (error) {
      throw error instanceof PlanError ? error : new PlanError("retry_later");
    }
  }

  async respond(body: Record<string, unknown> & { model: string }, signal: AbortSignal, owner: () => boolean) {
    validatePlanRequest(body);
    if (!owner()) throw new PlanError("plan_disabled");
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    const accessToken = await this.access(body.model, deadline, owner);
    if (!owner()) throw new PlanError("plan_disabled");
    if (this.signingOut) throw new PlanError("not_connected");
    return streamPlanResponse(this.oidc.http, accessToken, body, deadline);
  }

  start(consent: boolean, guard: () => boolean): Promise<string> {
    if (this.signingOut) throw new PlanError("busy");
    return this.oauth.start(consent, guard);
  }

  async acknowledge(guard: () => boolean): Promise<void> {
    await this.store.transaction("credentials", async () => {
      const row = await this.store.credentials();
      if (!guard()) throw new PlanError("declined");
      if (row?.tokens && !this.unavailable(row)) this.store.write("credentials", { ...row, acknowledged: true });
    });
  }

  async signOut(guard: () => boolean): Promise<boolean> {
    if (this.signingOut) throw new PlanError("busy");
    if (!guard()) throw new PlanError("declined");
    this.signingOut = true;
    this.oauth.cancel();
    try {
      return await this.store.transaction("credentials", async () => {
        const row = await this.store.credentials();
        if (!guard()) throw new PlanError("declined");
        if (!row) return true;
        const refreshToken = row.tokens?.refreshToken;
        // The durable sign-out removes the tokens before network I/O. A
        // process stop here leaves only the remote-revocation uncertainty.
        const signedOut: Credentials = { ...row, signedOut: true, tokens: undefined, pendingRotation: undefined,
          pendingRegistration: undefined, reconnect: undefined, revocationConfirmed: refreshToken ? false : row.revocationConfirmed ?? true };
        this.store.write("credentials", signedOut);
        const confirmed = refreshToken ? await this.revoke(row.clientId, refreshToken) : signedOut.revocationConfirmed!;
        if (confirmed !== signedOut.revocationConfirmed) this.store.write("credentials", { ...signedOut, revocationConfirmed: confirmed });
        console.info(confirmed ? "[chatgpt-plan] signed-out" : "[chatgpt-plan] revocation-unconfirmed");
        return confirmed;
      });
    } finally {
      this.signingOut = false;
    }
  }

  private async revoke(clientId: string, token: string): Promise<boolean> {
    const deadline = AbortSignal.timeout(10_000);
    for (const wait of [0, 300, 1_000]) {
      try {
        if (wait) await delay(wait, undefined, { signal: deadline });
        const config = await this.oidc.configuration(deadline);
        const response = await this.oidc.http(config.revocation_endpoint, {
          method: "POST", redirect: "error", signal: AbortSignal.any([deadline, AbortSignal.timeout(2_500)]),
          body: new URLSearchParams({ token, token_type_hint: "refresh_token", client_id: clientId }),
        });
        void response.body?.cancel().catch(() => undefined);
        if (response.status === 200) return true;
        if (response.status < 500) return false;
      } catch {
        if (deadline.aborted) return false;
      }
    }
    return false;
  }
}

const globals = globalThis as typeof globalThis & { __delegatusChatGPTPlan?: PlanSession };
export function chatgptPlan(): PlanSession {
  return globals.__delegatusChatGPTPlan ??= new PlanSession();
}
