import { createHash } from "node:crypto";
import { request } from "node:http";
import { afterEach, expect, test } from "bun:test";
import { CALLBACK, DYNAMIC_CLIENT, RESOURCE, SCOPES } from "./constants";
import { PlanOAuth } from "./oauth";
import { PlanSession } from "./session";
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
  await fixture.oauth.cancel();
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

test.each(["omitted", "matching", "different"] as const)("empty state with an issued client handles a %s callback client_id", async shape => {
  let nonce = "";
  process.env.LLV_CHATGPT_PLAN_CLIENT_ID = clientId;
  const fixture = planFixture(async url => {
    if (url === discovery.jwks_uri) return jwks();
    if (url === modelsUrl) return Response.json({ models: [] });
    return Response.json(grant(nonce));
  });
  const oauth = new PlanOAuth(fixture.store, fixture.oidc, () => now);
  dispose.push(fixture.dispose, () => oauth.cancel());
  const authorize = params(await oauth.start(false, allowed));
  nonce = authorize.get("nonce")!;
  const target = callback(authorize, shape === "omitted" ? { client_id: null }
    : shape === "different" ? { client_id: "other-client" } : { client_id: clientId });
  await http(target);
  await until(() => !oauth.pending);
  if (shape === "different") {
    expect(await fixture.store.credentials()).toBeUndefined();
    expect(fixture.requests.some(row => row.url === discovery.token_endpoint)).toBe(false);
  } else expect(await fixture.store.credentials()).toMatchObject({ clientId, tokens: expect.any(Object) });
});

test("exchange invalid_client recovery restarts OSS registration and retains the installation host ID", async () => {
  process.env.LLV_CHATGPT_PLAN_CLIENT_ID = DYNAMIC_CLIENT;
  let nonce = "";
  let rejectFirst = true;
  const fixture = planFixture(async (url, init) => {
    if (url === discovery.jwks_uri) return jwks();
    if (url === modelsUrl) return Response.json({ models: [] });
    if (url === discovery.token_endpoint && (init?.body as URLSearchParams).get("grant_type") === "authorization_code" && rejectFirst) {
      rejectFirst = false;
      return Response.json({ error: "invalid_client" }, { status: 400 });
    }
    return Response.json(grant(nonce));
  });
  dispose.push(fixture.dispose);
  const session = new PlanSession(fixture.store, fixture.oidc, () => now);
  const host = await hostId(fixture.store);
  const first = params(await session.start(false, allowed));
  nonce = first.get("nonce")!;
  await http(callback(first));
  await until(() => !session.oauth.pending);
  expect(session.oauth.reason).toBe("client_rejected");
  expect(await fixture.store.credentials()).toMatchObject({ reconnect: "client_rejected", clientId });
  expect(await fixture.store.credentials()).not.toHaveProperty("pendingRegistration");

  await session.replaceRejectedRegistration(DYNAMIC_CLIENT, allowed);
  expect(await fixture.store.credentials()).toMatchObject({ registrationMode: "dynamic", pendingRegistration: true });
  const retry = params(await session.start(false, allowed));
  expect(retry.get("client_id")).toBe(DYNAMIC_CLIENT);
  expect(retry.get("agent_name_hint")).toBe("Delegatus");
  nonce = retry.get("nonce")!;
  await http(callback(retry));
  await until(() => !session.oauth.pending);
  expect(await fixture.store.credentials()).toMatchObject({ clientId, tokens: expect.any(Object) });
  expect(await hostId(fixture.store)).toBe(host);
});

test.each(["invalid_grant", "invalid_client"] as const)("replacement dynamic registration keeps its issued client ID readable after %s", async code => {
  process.env.LLV_CHATGPT_PLAN_CLIENT_ID = DYNAMIC_CLIENT;
  const fixture = create(async (url, init) => {
    if (url === discovery.token_endpoint && (init?.body as URLSearchParams).get("grant_type") === "authorization_code")
      return Response.json({ error: code }, { status: 400 });
    return Response.json({ error: "unexpected" }, { status: 500 });
  });
  const host = await hostId(fixture.store);
  fixture.seed({ tokens: undefined, reconnect: "client_rejected", pendingRegistration: true,
    registrationMode: "dynamic" });
  const session = new PlanSession(fixture.store, fixture.oidc, () => now);
  await session.replaceRejectedRegistration(DYNAMIC_CLIENT, allowed);
  const first = params(await session.start(false, allowed));
  expect(first.get("client_id")).toBe(DYNAMIC_CLIENT);
  await http(callback(first));
  if (code === "invalid_grant") {
    await until(() => !!session.oauth.retryUrl);
    expect(params(session.oauth.retryUrl).get("client_id")).toBe(clientId);
    expect(await fixture.store.credentials()).toMatchObject({ pendingClientId: clientId, clientId,
      pendingRegistration: true, registrationMode: "dynamic" });
    await session.oauth.cancel();
  } else {
    await until(() => !session.oauth.pending);
    expect(await fixture.store.credentials()).toMatchObject({ clientId, reconnect: "client_rejected" });
    expect(await fixture.store.credentials()).not.toHaveProperty("pendingRegistration");
    expect(await fixture.store.credentials()).not.toHaveProperty("registrationMode");
  }
  expect(await hostId(fixture.store)).toBe(host);
  expect(await fixture.store.credentials()).toBeDefined();
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

test("cancel during an admitted token exchange lets it checkpoint and revokes its returned grant", async () => {
  let nonce = "";
  let releaseExchange!: (response: Response) => void;
  let exchangeStarted!: () => void;
  const held = new Promise<Response>(resolve => { releaseExchange = resolve; });
  const started = new Promise<void>(resolve => { exchangeStarted = resolve; });
  const fixture = create(async (url, init) => {
    if (url === discovery.jwks_uri) return jwks();
    if (url === modelsUrl) return Response.json({ models: [] });
    if (url === discovery.token_endpoint && (init?.body as URLSearchParams).get("grant_type") === "authorization_code") {
      exchangeStarted();
      return held;
    }
    if (url === discovery.revocation_endpoint) {
      expect((init?.body as URLSearchParams).get("token")).toBe(synth("refresh"));
      return new Response(null, { status: 200 });
    }
    return Response.json(grant(nonce));
  });
  const authorize = params(await fixture.oauth.start(false, allowed));
  nonce = authorize.get("nonce")!;
  await http(callback(authorize));
  await started;
  const cancellation = fixture.oauth.cancel();
  releaseExchange(Response.json(grant(nonce)));
  expect(await cancellation).toBe(true);
  expect(await fixture.store.credentials()).toMatchObject({ pendingRegistration: true, revocationConfirmed: true });
  expect(fixture.requests.filter(row => row.url === discovery.revocation_endpoint)).toHaveLength(1);
});

test("sign-out waits for an admitted OAuth exchange and clears its late grant", async () => {
  let nonce = "";
  let releaseExchange!: (response: Response) => void;
  let exchangeStarted!: () => void;
  const held = new Promise<Response>(resolve => { releaseExchange = resolve; });
  const started = new Promise<void>(resolve => { exchangeStarted = resolve; });
  const fixture = create(async (url, init) => {
    if (url === discovery.token_endpoint && (init?.body as URLSearchParams).get("grant_type") === "authorization_code") {
      exchangeStarted();
      return held;
    }
    if (url === discovery.jwks_uri) return jwks();
    if (url === modelsUrl) return Response.json({ models: [] });
    if (url === discovery.revocation_endpoint) return new Response(null, { status: 200 });
    return Response.json(grant(nonce));
  });
  const session = new PlanSession(fixture.store, fixture.oidc, () => now);
  const authorize = params(await session.start(false, allowed));
  nonce = authorize.get("nonce")!;
  await http(callback(authorize));
  await started;
  let settled = false;
  const signOut = session.signOut(allowed).then(confirmed => { settled = true; return confirmed; });
  await Bun.sleep(20);
  expect(settled).toBe(false);
  releaseExchange(Response.json(grant(nonce)));
  expect(await signOut).toBe(true);
  expect(await fixture.store.credentials()).toMatchObject({ signedOut: true, revocationConfirmed: true });
  expect(await fixture.store.credentials()).not.toHaveProperty("tokens");
  expect(await fixture.store.credentials()).not.toHaveProperty("pendingGrantRefresh");
  expect(fixture.requests.filter(row => row.url === discovery.revocation_endpoint)).toHaveLength(1);
});

test("cancel reports uncertain revocation when an admitted exchange outcome is unknown", async () => {
  let nonce = "";
  let rejectExchange!: (error: Error) => void;
  let exchangeStarted!: () => void;
  const held = new Promise<Response>((_resolve, reject) => { rejectExchange = reject; });
  const started = new Promise<void>(resolve => { exchangeStarted = resolve; });
  const fixture = create(async (url, init) => {
    if (url === discovery.jwks_uri) return jwks();
    if (url === discovery.token_endpoint && (init?.body as URLSearchParams).get("grant_type") === "authorization_code") {
      exchangeStarted();
      return held;
    }
    if (url === discovery.revocation_endpoint) return new Response(null, { status: 200 });
    return Response.json(grant(nonce));
  });
  const authorize = params(await fixture.oauth.start(false, allowed));
  nonce = authorize.get("nonce")!;
  await http(callback(authorize));
  await started;
  const cancelled = fixture.oauth.cancel();
  rejectExchange(new Error("unknown exchange outcome"));
  expect(await cancelled).toBe(false);
  expect(await fixture.store.credentials()).toMatchObject({ pendingRegistration: true, revocationConfirmed: false });
});

test("reauthorization subject mismatch revokes only the candidate and preserves the connected grant", async () => {
  let nonce = "";
  const fixture = create(async (url, init) => {
    if (url === discovery.jwks_uri) return jwks();
    if (url === modelsUrl) return Response.json({ models: [] });
    if (url === discovery.revocation_endpoint) return new Response(null, { status: 200 });
    return Response.json({ ...grant(nonce), id_token: jwt(nonce, { sub: "different-subject" }) });
  });
  await hostId(fixture.store);
  const original = fixture.seed();
  const session = new PlanSession(fixture.store, fixture.oidc, () => now);
  const authorize = params(await session.start(false, allowed));
  nonce = authorize.get("nonce")!;
  await http(callback(authorize));
  await until(() => fixture.oauth.pending === false && fixture.requests.some(row => row.url === discovery.revocation_endpoint));
  const revokeDeadline = performance.now() + 1_500;
  while ((await fixture.store.credentials())?.revocationConfirmed !== true) {
    if (performance.now() > revokeDeadline) throw new Error("Candidate revocation did not settle");
    await Bun.sleep(5);
  }
  expect(await fixture.store.credentials()).toMatchObject({ clientId, subject: original.subject, tokens: original.tokens });
  expect(await session.eligible(model)).toBe(true);
  expect(fixture.requests.filter(row => row.url === discovery.revocation_endpoint)).toHaveLength(1);
});

test("a candidate grant is not committed when cancellation races verification", async () => {
  let nonce = "";
  let releaseModels!: (response: Response) => void;
  let modelsStarted!: () => void;
  const pendingModels = new Promise<Response>(resolve => { releaseModels = resolve; });
  const started = new Promise<void>(resolve => { modelsStarted = resolve; });
  const fixture = create(async (url) => {
    if (url === discovery.jwks_uri) return jwks();
    if (url === modelsUrl) { modelsStarted(); return pendingModels; }
    if (url === discovery.revocation_endpoint) return new Response(null, { status: 200 });
    return Response.json(grant(nonce));
  });
  await hostId(fixture.store);
  const original = fixture.seed();
  const session = new PlanSession(fixture.store, fixture.oidc, () => now);
  const authorize = params(await session.start(false, allowed));
  nonce = authorize.get("nonce")!;
  await http(callback(authorize));
  await started;
  const cancellation = session.oauth.cancel();
  releaseModels(Response.json({ models: [] }));
  expect(await cancellation).toBe(true);
  expect(await fixture.store.credentials()).toMatchObject({ clientId, subject: original.subject, tokens: original.tokens });
  expect(await session.eligible(model)).toBe(true);
});

test("candidate revocation requires HTTP 200 and preserves the active grant and warning", async () => {
  let nonce = "";
  const fixture = create(async url => {
    if (url === discovery.jwks_uri) return jwks();
    if (url === modelsUrl) return Response.json({ models: [] });
    if (url === discovery.revocation_endpoint) return new Response(null, { status: 202 });
    return Response.json({ ...grant(nonce), id_token: jwt(nonce, { sub: "different-subject" }) });
  });
  await hostId(fixture.store);
  const original = fixture.seed();
  const session = new PlanSession(fixture.store, fixture.oidc, () => now);
  const authorize = params(await session.start(false, allowed));
  nonce = authorize.get("nonce")!;
  await http(callback(authorize));
  await until(() => fixture.requests.some(row => row.url === discovery.revocation_endpoint));
  expect(await fixture.store.credentials()).toMatchObject({ clientId, subject: original.subject, tokens: original.tokens,
    pendingGrantRefresh: synth("refresh"), revocationConfirmed: false });
  expect(await session.eligible(model)).toBe(true);
  expect(fixture.requests.filter(row => row.url === discovery.revocation_endpoint)).toHaveLength(1);
});
