import { createHash } from "node:crypto";
import { request } from "node:http";
import { afterEach, expect, test } from "bun:test";
import { CALLBACK, DYNAMIC_CLIENT, RESOURCE, SCOPES } from "./constants";
import { PlanOAuth } from "./oauth";
import { hostId } from "./hostId";
import { clientId, discovery, grant, jwks, jwt, model, modelsUrl, now, planFixture, synth, until } from "./plan.fixture";

const dispose: (() => void)[] = [];
const priorClient = process.env.LLV_CHATGPT_PLAN_CLIENT_ID;
afterEach(() => { for (const cleanup of dispose.splice(0).reverse()) cleanup(); if (priorClient === undefined) delete process.env.LLV_CHATGPT_PLAN_CLIENT_ID; else process.env.LLV_CHATGPT_PLAN_CLIENT_ID = priorClient; });

function create(answer?: Parameters<typeof planFixture>[0], timeout?: number) {
  process.env.LLV_CHATGPT_PLAN_CLIENT_ID = "dynamic_agent_client";
  const fixture = planFixture(answer);
  const oauth = new PlanOAuth(fixture.store, fixture.oidc, () => now, timeout);
  dispose.push(fixture.dispose, () => oauth.cancel());
  return { ...fixture, oauth };
}
const allowed = () => true;
const params = (url: string | undefined) => new URL(url!).searchParams;
const callback = (auth: URLSearchParams, overrides: Record<string, string | null> = {}) => {
  const target = new URL(auth.get("redirect_uri")!);
  target.search = new URLSearchParams({ state: auth.get("state")!, code: synth("code"), client_id: clientId }).toString();
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) target.searchParams.delete(key); else target.searchParams.set(key, value);
  }
  return target;
};
const http = (url: URL, host?: string) => new Promise<{ status: number; text: string }>((resolve, reject) => {
  const req = request(url, { agent: false, headers: host ? { host } : undefined }, response => {
    let text = "";
    response.setEncoding("utf8").on("data", chunk => { text += chunk; }).on("end", () => resolve({ status: response.statusCode!, text }));
  });
  req.on("error", reject).end();
});

test("loopback callback rejects bad Host, path and state and exchanges one PKCE code after saving the issued client", async () => {
  let nonce = "";
  const fixture = create(async (url, init) => {
    if (url === discovery.jwks_uri) return jwks();
    if (url === modelsUrl) return Response.json({ models: [{ visibility: "list", slug: model }, { visibility: "hidden", slug: "hidden" }] });
    expect(await fixture.store.credentials()).toMatchObject({ clientId, pendingRegistration: true });
    const exchange = init?.body as URLSearchParams;
    expect(exchange.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createHash("sha256").update(exchange.get("code_verifier")!).digest("base64url")).toBe(first.get("code_challenge")!);
    expect(exchange.get("redirect_uri")).toBe(first.get("redirect_uri")!);
    expect(exchange.get("client_id")).toBe(clientId);
    expect(exchange.get("resource")).toBe(RESOURCE);
    return Response.json(grant(nonce));
  });
  const first = params(await fixture.oauth.start(false, allowed));
  nonce = first.get("nonce")!;
  expect(Object.fromEntries(first)).toMatchObject({ client_id: DYNAMIC_CLIENT, agent_name_hint: "Delegatus", response_type: "code",
    scope: SCOPES, resource: RESOURCE, code_challenge_method: "S256" });
  expect(first.get("ext_agent_host_id")).toMatch(/^urn:uuid:/);
  expect(first.has("id_token_hint") || first.has("login_hint")).toBe(false);
  expect(first.get("redirect_uri")).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:[1-9]\\d*${CALLBACK}$`));
  const target = callback(first);
  expect((await http(target, "untrusted.example")).status).toBe(404);
  expect((await http(new URL("/different", target))).status).toBe(404);
  expect((await http(callback(first, { state: "wrong" }))).status).toBe(400);
  const repeated = callback(first);
  repeated.searchParams.append("state", first.get("state")!);
  expect((await http(repeated)).status).toBe(400);
  expect(fixture.oauth.pending).toBe(true);
  expect(fixture.requests).toHaveLength(1);
  expect((await http(target)).text).toBe("Return to Delegatus. You can close this tab.");
  await until(() => (fixture.oauth.pending) === false);
  expect(await fixture.store.credentials()).toMatchObject({ clientId, models: [model] });
  await expect(http(target)).rejects.toThrow();
  expect(fixture.requests.filter(row => row.url === discovery.token_endpoint)).toHaveLength(1);
});

test("invalid_grant opens one new listener with the saved client and fresh PKCE and nonce", async () => {
  const fixture = create(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
  const first = params(await fixture.oauth.start(false, allowed));
  await http(callback(first));
  await until(() => (!!fixture.oauth.retryUrl) === true);
  const second = params(fixture.oauth.retryUrl);
  expect(second.get("client_id")).toBe(clientId);
  expect(second.has("agent_name_hint") || second.has("prompt")).toBe(false);
  expect(second.get("ext_agent_host_id")).toBe(first.get("ext_agent_host_id"));
  for (const key of ["state", "nonce", "code_challenge"]) expect(second.get(key)).not.toBe(first.get(key));
  await http(callback(second, { client_id: null }));
  await until(() => (fixture.oauth.pending) === false);
  expect(fixture.requests.filter(row => row.url === discovery.token_endpoint)).toHaveLength(2);
  expect(await fixture.store.credentials()).toMatchObject({ clientId, pendingRegistration: true });
});

test.each([
  [{ error: "access_denied" }, "declined"],
  [{ client_id: null }, "registration_incomplete"],
  [{ client_id: DYNAMIC_CLIENT }, "registration_incomplete"],
] as const)("invalid first callback %j avoids exchange", async (override, reason) => {
  const fixture = create();
  const first = params(await fixture.oauth.start(false, allowed));
  await http(callback(first, override));
  await until(() => (fixture.oauth.pending) === false);
  expect(fixture.oauth.reason).toBe(reason);
  expect(fixture.requests).toHaveLength(1);
});

test("explicit consent uses the full grant and refuses a different callback client", async () => {
  const fixture = create();
  await hostId(fixture.store);
  fixture.seed();
  const first = params(await fixture.oauth.start(true, allowed));
  expect(first.get("prompt")).toBe("consent");
  expect(first.get("scope")).toBe(SCOPES);
  await http(callback(first, { client_id: "another-client" }));
  await until(() => (fixture.oauth.pending) === false);
  expect(fixture.oauth.reason).toBe("account_mismatch");
  expect(fixture.requests).toHaveLength(1);
});

test("declined plan permission keeps the verified account and another subject cannot replace it", async () => {
  let nonce = "";
  let different = false;
  const fixture = create(url => {
    if (url === discovery.jwks_uri) return jwks();
    const { refresh_token: _refresh, ...identityGrant } = grant(nonce);
    return Response.json({ ...identityGrant, scope: "openid email",
      ...(different ? { id_token: jwt(nonce, { sub: "another-subject" }) } : {}) });
  });
  const first = params(await fixture.oauth.start(false, allowed));
  nonce = first.get("nonce")!;
  await http(callback(first));
  await until(() => !fixture.oauth.pending);
  const saved = await fixture.store.credentials();
  expect(saved?.tokens?.scopes).toEqual(["openid", "email"]);
  expect(saved?.tokens?.refreshToken).toBeUndefined();
  expect(fixture.requests.some(request => request.url === modelsUrl)).toBe(false);

  different = true;
  const consent = params(await fixture.oauth.start(true, allowed));
  nonce = consent.get("nonce")!;
  await http(callback(consent, { client_id: null }));
  await until(() => !fixture.oauth.pending);
  expect(fixture.oauth.reason).toBe("account_mismatch");
  expect(await fixture.store.credentials()).toEqual(saved);
});

test("a plan grant without a refresh token cannot activate the registration", async () => {
  let nonce = "";
  const fixture = create(() => {
    const { refresh_token: _refresh, ...incomplete } = grant(nonce);
    return Response.json(incomplete);
  });
  const first = params(await fixture.oauth.start(false, allowed));
  nonce = first.get("nonce")!;
  await http(callback(first));
  await until(() => !fixture.oauth.pending);
  expect(fixture.oauth.reason).toBe("reconnect_required");
  const row = await fixture.store.credentials();
  expect(row).toMatchObject({ clientId, pendingRegistration: true });
  expect(row?.tokens).toBeUndefined();
  expect(fixture.requests).toHaveLength(2);
});

test("cancel and deadline close the real loopback listener", async () => {
  const fixture = create(undefined, 300);
  const first = params(await fixture.oauth.start(false, allowed));
  await expect(fixture.oauth.start(false, allowed)).rejects.toThrow("busy");
  fixture.oauth.cancel();
  await expect(http(callback(first))).rejects.toThrow();
  const second = params(await fixture.oauth.start(false, allowed));
  await until(() => (fixture.oauth.reason) === "expired");
  await expect(http(callback(second))).rejects.toThrow();
});

test("Windows disables sign-in before credential files, discovery, or a listener", async () => {
  const fixture = create();
  const windows = new PlanOAuth(fixture.store, fixture.oidc, () => now, undefined, "win32");
  await expect(windows.start(false, allowed)).rejects.toThrow("plan_disabled");
  expect(fixture.requests).toHaveLength(0);
  expect(await fixture.store.read("host")).toBeUndefined();
  windows.cancel();
});

test("cancel after the grant is issued revokes the uncommitted refresh token", async () => {
  let nonce = "";
  let releaseModels!: (response: Response) => void;
  let modelsWaiting!: () => void;
  const waiting = new Promise<void>(resolve => { modelsWaiting = resolve; });
  const models = new Promise<Response>(resolve => { releaseModels = resolve; });
  const fixture = create(async (url, init) => {
    if (url === discovery.jwks_uri) return jwks();
    if (url === modelsUrl) { modelsWaiting(); return models; }
    if (url === discovery.revocation_endpoint) {
      expect((init?.body as URLSearchParams).get("token")).toBe(synth("refresh"));
      return new Response(null, { status: 200 });
    }
    return Response.json(grant(nonce));
  });
  const authorize = params(await fixture.oauth.start(false, allowed));
  nonce = authorize.get("nonce")!;
  await http(callback(authorize));
  await waiting;
  expect(await fixture.store.credentials()).toMatchObject({ pendingRegistration: true, pendingGrantRefresh: synth("refresh") });
  fixture.oauth.cancel();
  releaseModels(Response.json({ models: [] }));
  const deadline = performance.now() + 1_500;
  while ((await fixture.store.credentials())?.revocationConfirmed !== true) {
    if (performance.now() > deadline) throw new Error("Uncommitted grant revocation did not settle");
    await Bun.sleep(5);
  }
  expect(await fixture.store.credentials()).toMatchObject({ pendingRegistration: true, revocationConfirmed: true });
  expect(fixture.requests.filter(row => row.url === discovery.revocation_endpoint)).toHaveLength(1);
});
