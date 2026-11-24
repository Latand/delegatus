import { boundedJson, ISSUER, object, RESOURCE } from "./constants";
import { PlanError } from "./errors";
import { epoch, textField, type TokenSet } from "./store";

type Discovery = { authorization_endpoint: string; token_endpoint: string; revocation_endpoint: string; jwks_uri: string };
const endpoints = ["authorization_endpoint", "token_endpoint", "revocation_endpoint", "jwks_uri"] as const;

export class PlanOidc {
  private discovery?: Promise<Discovery>;
  constructor(readonly http: typeof fetch = (...args) => fetch(...args)) {}

  configuration(signal: AbortSignal): Promise<Discovery> {
    signal.throwIfAborted();
    return this.discovery ??= this.load().catch(() => {
      this.discovery = undefined;
      throw new PlanError("retry_later");
    });
  }

  private async load(): Promise<Discovery> {
    const response = await this.http(`${ISSUER}/.well-known/openid-configuration`, {
      redirect: "error", signal: AbortSignal.timeout(5_000),
    });
    const data = object(response.ok ? await boundedJson(response) : undefined);
    if (data?.issuer !== ISSUER) throw new PlanError("retry_later");
    const result = {} as Discovery;
    for (const key of endpoints) {
      if (typeof data[key] !== "string") throw new PlanError("retry_later");
      const url = new URL(data[key]);
      if (url.origin !== ISSUER || url.username || url.password || url.search || url.hash) throw new PlanError("retry_later");
      result[key] = url.href;
    }
    return result;
  }

  async exchange(fields: Record<string, string>, signal: AbortSignal) {
    const config = await this.configuration(signal);
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await this.http(config.token_endpoint, {
        method: "POST", redirect: "error", signal,
        body: new URLSearchParams({ ...fields, resource: RESOURCE }),
      });
    } catch { throw new PlanError("retry_later"); }
    let body;
    try { body = object(await boundedJson(response, undefined, true)); }
    catch { throw new PlanError("retry_later"); }
    if (response.status === 200) return { body } as const;
    const code = object(body?.error)?.code ?? body?.error;
    return { code: typeof code === "string" ? code : undefined, status: response.status } as const;
  }
}

export function readTokenSet(body: Record<string, unknown> | undefined, now: number, previous?: TokenSet): TokenSet {
  if (!body || typeof body.token_type !== "string" || body.token_type.toLowerCase() !== "bearer"
    || !textField(body.access_token) || !textField(body.refresh_token)
    || (body.id_token !== undefined && !textField(body.id_token))
    || (body.scope !== undefined && typeof body.scope !== "string")
    || typeof body.expires_in !== "number" || body.expires_in <= 0 || !epoch(now + body.expires_in * 1_000)) {
    throw new PlanError("reconnect_required");
  }
  const idToken = body.id_token ?? previous?.idToken;
  const scopes = typeof body.scope === "string" ? body.scope.split(/\s+/).filter(Boolean) : previous?.scopes;
  if (!idToken || !scopes) throw new PlanError("reconnect_required");
  const earliest = body.earliest_refresh_at;
  const earliestMs = typeof earliest === "number" ? earliest * 1_000 : typeof earliest === "string" ? Date.parse(earliest) : null;
  const access = body.access_token;
  const refresh = body.refresh_token;
  return { accessToken: access, refreshToken: refresh, idToken, scopes,
    expiresAt: now + body.expires_in * 1_000, refreshedAt: now,
    ...(epoch(earliestMs) ? { earliestRefreshAt: earliestMs } : {}) };
}
