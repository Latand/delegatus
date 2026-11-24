import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { CALLBACK, clientIdValid, configuredClientId, credentialStorageSupported, DYNAMIC_CLIENT, ISSUER, object, PLAN_SCOPE, RESOURCE, SCOPES } from "./constants";
import { PlanError } from "./errors";
import { hostId } from "./hostId";
import { validateIdentity } from "./idToken";
import { PlanOidc, readTokenSet } from "./oidc";
import type { PlanReason } from "./public";
import { listPlanModels } from "./responses";
import { PlanStore, type Credentials } from "./store";

type Attempt = {
  abort: AbortController;
  timer: ReturnType<typeof setTimeout>;
  server?: Server;
  retryUrl?: string;
  refreshToken?: string;
  grantClientId?: string;
  grantCheckpoint?: Promise<void>;
  revocation?: Promise<boolean>;
  guard: () => boolean;
};
const random = () => randomBytes(32).toString("base64url");
const same = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b)
  && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const one = (params: URLSearchParams, name: string) => {
  const values = params.getAll(name);
  return values.length === 1 ? values[0] : undefined;
};

export class PlanOAuth {
  private attempt?: Attempt;
  reason?: PlanReason;
  get pending() { return !!this.attempt; }
  get retryUrl() { return this.attempt?.retryUrl; }

  constructor(private readonly store: PlanStore, private readonly oidc: PlanOidc,
    private readonly now = Date.now, private readonly timeoutMs = 10 * 60_000, private readonly platform = process.platform) {}

  private closeListener(attempt: Attempt): void {
    const server = attempt.server;
    attempt.server = undefined;
    server?.close();
    server?.closeIdleConnections();
  }

  private settle(attempt: Attempt, reason?: PlanReason): void {
    if (this.attempt !== attempt) return;
    this.attempt = undefined;
    this.reason = reason;
    clearTimeout(attempt.timer);
    attempt.abort.abort();
    this.closeListener(attempt);
    if (attempt.refreshToken) void this.revokeGrant(attempt, attempt.refreshToken);
  }

  private revokeGrant(attempt: Attempt, token: string): Promise<boolean> {
    if (attempt.revocation) return attempt.revocation;
    attempt.revocation = this.performGrantRevocation(attempt, token);
    return attempt.revocation;
  }

  private async performGrantRevocation(attempt: Attempt, token: string): Promise<boolean> {
    await attempt.grantCheckpoint?.catch(() => undefined);
    let confirmed = false;
    try {
      const deadline = AbortSignal.timeout(10_000);
      const config = await this.oidc.configuration(deadline);
      const response = await this.oidc.http(config.revocation_endpoint, { method: "POST", redirect: "error", signal: deadline,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: attempt.grantClientId ?? configuredClientId() ?? "", token, token_type_hint: "refresh_token" }) });
      confirmed = response.ok;
    } catch { confirmed = false; }
    try {
      await this.store.transaction("credentials", async () => {
        const row = await this.store.credentials();
        if (row?.pendingGrantRefresh !== token) return;
        this.store.write("credentials", { ...row, pendingGrantRefresh: confirmed ? undefined : token, revocationConfirmed: confirmed });
      });
    } catch { confirmed = false; }
    if (!confirmed) console.info("[chatgpt-plan] revocation-unconfirmed");
    return confirmed;
  }

  cancel(): void {
    if (this.attempt) this.settle(this.attempt);
    this.reason = undefined;
  }

  private check(attempt: Attempt): void {
    if (attempt.abort.signal.aborted || !attempt.guard()) throw new PlanError("declined");
  }

  async start(consent: boolean, guard: () => boolean): Promise<string> {
    if (this.attempt) throw new PlanError("busy");
    if (!credentialStorageSupported(this.platform)) throw new PlanError("plan_disabled");
    const configured = configuredClientId();
    if (!configured || (configured !== DYNAMIC_CLIENT && !clientIdValid(configured))) throw new PlanError("plan_disabled");
    this.reason = undefined;
    const attempt: Attempt = {
      abort: new AbortController(), guard,
      timer: setTimeout(() => this.settle(attempt, "expired"), this.timeoutMs),
    };
    attempt.timer.unref();
    this.attempt = attempt;
    try {
      this.check(attempt);
      const saved = await this.store.credentials();
      if (consent && (!saved?.subject || saved.signedOut)) throw new PlanError("invalid_request");
      this.check(attempt);
      const host = await hostId(this.store);
      this.check(attempt);
      const url = await this.listen(attempt, saved, host, consent, true);
      console.info("[chatgpt-plan] sign-in-started");
      return url;
    } catch (error) {
      const failure = error instanceof PlanError ? error : new PlanError("retry_later");
      this.settle(attempt, failure.reason);
      throw failure;
    }
  }

  private async listen(attempt: Attempt, saved: Credentials | undefined, host: string, consent: boolean, mayRetry: boolean): Promise<string> {
    const config = await this.oidc.configuration(attempt.abort.signal);
    this.check(attempt);
    const state = random(), nonce = random(), verifier = random();
    let accepted = false;
    const server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000 }, (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Content-Security-Policy", "default-src 'none'");
      res.setHeader("Connection", "close");
      const reply = (status: number, message = "") => res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }).end(message);
      const target = req.url;
      if (req.method !== "GET" || req.headers.host !== address || !target || target.split("?")[0] !== CALLBACK) { reply(404); return; }
      const params = new URLSearchParams(target.slice(CALLBACK.length + 1));
      const received = one(params, "state");
      if (accepted || !received || !same(received, state)) { reply(400); return; }
      accepted = true;
      attempt.retryUrl = undefined;
      reply(200, "Return to Delegatus. You can close this tab.");
      this.closeListener(attempt);
      void this.complete(attempt, params, saved, host, consent, mayRetry, nonce, verifier, redirect);
    });
    let address = "", redirect = "";
    attempt.server = server;
    server.maxConnections = 16;
    server.setTimeout(5_000, socket => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0, signal: attempt.abort.signal }, () => {
        server.removeListener("error", reject);
        server.on("error", () => this.settle(attempt, "retry_later"));
        resolve();
      });
      // listen can close before its callback on cancellation.
      server.once("close", () => reject(new PlanError("declined")));
    });
    this.check(attempt);
    const bound = server.address();
    if (!bound || typeof bound === "string") throw new PlanError("retry_later");
    address = `127.0.0.1:${bound.port}`;
    redirect = `http://${address}${CALLBACK}`;
    const url = new URL(config.authorization_endpoint);
    url.search = new URLSearchParams({
      client_id: saved?.clientId ?? configuredClientId()!,
      ...(!saved ? { agent_name_hint: "Delegatus" } : {}),
      ext_agent_host_id: host, response_type: "code", redirect_uri: redirect, resource: RESOURCE,
      scope: SCOPES, state, nonce, code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      ...(consent ? { prompt: "consent" } : {}),
    }).toString();
    return url.href;
  }

  private async complete(attempt: Attempt, params: URLSearchParams, saved: Credentials | undefined, host: string,
    consent: boolean, mayRetry: boolean, nonce: string, verifier: string, redirect: string): Promise<void> {
    try {
      this.check(attempt);
      if (params.has("error")) throw new PlanError("declined");
      const code = one(params, "code");
      const issued = one(params, "client_id");
      if (!code) throw new PlanError("registration_incomplete");
      if (saved && params.has("client_id") && issued !== saved.clientId) throw new PlanError("account_mismatch");
      const clientId = saved?.clientId ?? issued;
      if (!clientIdValid(clientId)) throw new PlanError("registration_incomplete");
      if (!saved) {
        const registration: Credentials = { version: 1, issuer: ISSUER, clientId, savedAt: this.now(), pendingRegistration: true };
        await this.store.transaction("credentials", async () => {
          const current = await this.store.credentials();
          this.check(attempt);
          if (current) throw new PlanError("busy");
          this.store.write("credentials", registration);
        });
        saved = registration;
      }
      this.check(attempt);
      const deadline = AbortSignal.any([attempt.abort.signal, AbortSignal.timeout(15_000)]);
      const result = await this.oidc.exchange({ grant_type: "authorization_code", client_id: clientId,
        code, code_verifier: verifier, redirect_uri: redirect }, deadline);
      const refreshToken = object(result.body)?.refresh_token;
      if (typeof refreshToken === "string" && refreshToken.length > 0) {
        attempt.refreshToken = refreshToken;
        attempt.grantClientId = clientId;
        attempt.grantCheckpoint = this.store.transaction("credentials", async () => {
          const current = await this.store.credentials();
          if (current?.clientId === clientId) {
            saved = { ...current, pendingGrantRefresh: refreshToken, revocationConfirmed: false };
            this.store.write("credentials", saved);
          }
        });
        await attempt.grantCheckpoint;
        if (attempt.abort.signal.aborted) { await this.revokeGrant(attempt, refreshToken); return; }
      }
      this.check(attempt);
      if (result.code === "invalid_grant" && mayRetry) {
        const retryUrl = await this.listen(attempt, saved, host, consent, false);
        this.check(attempt);
        attempt.retryUrl = retryUrl;
        return;
      }
      if (result.code === "invalid_grant") throw new PlanError("reconnect_required");
      if (result.code === "invalid_client") throw new PlanError("client_rejected");
      if (result.status !== undefined) throw new PlanError(result.status >= 500 ? "retry_later" : "reconnect_required");
      const tokens = readTokenSet(result.body, this.now());
      const identity = await validateIdentity(this.oidc, tokens.idToken, clientId, this.now(), deadline, nonce);
      if (saved.subject && identity.subject !== saved.subject) throw new PlanError("account_mismatch");
      this.check(attempt);
      const models = tokens.scopes.includes(PLAN_SCOPE)
        ? await listPlanModels(this.oidc.http, tokens.accessToken, deadline).catch(() => undefined) : undefined;
      const acknowledged = saved.acknowledged;
      const previous = JSON.stringify(saved);
      await this.store.transaction("credentials", async () => {
        const current = await this.store.credentials();
        this.check(attempt);
        if (JSON.stringify(current) !== previous) throw new PlanError("busy");
        this.store.write("credentials", {
          version: 1, issuer: ISSUER, clientId, ...identity, tokens, models,
          savedAt: this.now(), acknowledged, pendingGrantRefresh: undefined, revocationConfirmed: undefined,
        } satisfies Credentials);
      });
      attempt.refreshToken = undefined;
      this.settle(attempt);
      console.info("[chatgpt-plan] connected");
    } catch (error) {
      if (this.attempt !== attempt) return;
      this.settle(attempt, error instanceof PlanError ? error.reason : "retry_later");
      console.info("[chatgpt-plan] declined");
    }
  }
}
