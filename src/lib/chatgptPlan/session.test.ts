import { afterEach, expect, spyOn, test } from "bun:test";
import { PLAN_SCOPE, RESOURCE } from "./constants";
import { unusableRefresh } from "./errors";
import { clientId, complete, discovery, grant, jwks, model, now, planFixture, stream, synth } from "./plan.fixture";
import { PlanSession } from "./session";
import { PlanStore } from "./store";
import { credentialStorageSupported } from "./constants";

let fixture: ReturnType<typeof planFixture>;
const priorClient = process.env.LLV_CHATGPT_PLAN_CLIENT_ID;
afterEach(() => { fixture.dispose(); if (priorClient === undefined) delete process.env.LLV_CHATGPT_PLAN_CLIENT_ID; else process.env.LLV_CHATGPT_PLAN_CLIENT_ID = priorClient; });
const body = { model, input: [{ role: "user", content: "Read the board" }] };
const signal = () => AbortSignal.timeout(4_000);
const owner = () => true;
const responsesUrl = `${RESOURCE}/responses`;
function create(handle?: Parameters<typeof planFixture>[0], response?: () => Response | Promise<Response>) {
  process.env.LLV_CHATGPT_PLAN_CLIENT_ID = "dynamic_agent_client";
  fixture = planFixture((url, init) => url === responsesUrl ? response?.() ?? stream(complete({ output: [] })) : handle!(url, init));
  return new PlanSession(fixture.store, fixture.oidc, () => now);
}
function expiring(expiresAt = now + 60_000) {
  const row = fixture.seed();
  return fixture.seed({ tokens: { ...row.tokens!, expiresAt } });
}
const refreshes = () => fixture.requests.filter(row => row.url === discovery.token_endpoint);
const inferences = () => fixture.requests.filter(row => row.url === responsesUrl);

test("no client ID means no plan inference or refresh", async () => {
  const session = create();
  expect(await session.status(model, true, true)).toMatchObject({ state: "not_connected" });
  expect(await session.eligible(model)).toBe(false);
  await expect(session.respond(body, signal(), owner)).rejects.toThrow("not_connected");
  expect(fixture.requests).toHaveLength(0);
});

test("model catalog and granted scopes gate inference", async () => {
  const session = create();
  const row = fixture.seed({ models: ["other"] });
  expect((await session.status(model, true, true)).planModels).toEqual({ voiceBackend: false });
  await expect(session.respond(body, signal(), owner)).rejects.toThrow("plan_disabled");
  fixture.seed({ tokens: { ...row.tokens!, scopes: [] } });
  expect((await session.status(model, true, true)).state).toBe("plan_disabled");
  await expect(session.respond(body, signal(), owner)).rejects.toThrow("plan_disabled");
  expect(fixture.requests).toHaveLength(0);
});

test("rejected client registration can be replaced by the owner while retaining the host identity", async () => {
  const session = create();
  const host = await (await import("./hostId")).hostId(fixture.store);
  const row = fixture.seed({ reconnect: "client_rejected", tokens: undefined });
  process.env.LLV_CHATGPT_PLAN_CLIENT_ID = "replacement-client";
  await session.replaceRejectedRegistration("replacement-client", owner);
  expect(await fixture.store.credentials()).toMatchObject({ clientId: "replacement-client", pendingRegistration: true });
  expect(await (await import("./hostId")).hostId(fixture.store)).toBe(host);
  expect(row.clientId).toBe(clientId);
  expect(credentialStorageSupported("win32")).toBe(false);
});

test("registration replacement requires the configured client ID", async () => {
  const session = create();
  fixture.seed({ reconnect: "client_rejected", tokens: undefined });
  delete process.env.LLV_CHATGPT_PLAN_CLIENT_ID;
  await expect(session.replaceRejectedRegistration("attacker-client", owner)).rejects.toThrow("plan_disabled");
  expect(await fixture.store.credentials()).toMatchObject({ reconnect: "client_rejected", clientId });
});

test("plan limit persists a bounded pause across calls", async () => {
  const session = create(undefined, () => Response.json({ error: { code: "subscription_sharing_usage_limit_exceeded" } }, { status: 429 }));
  fixture.seed();
  await expect(session.respond(body, signal(), owner)).rejects.toThrow("plan_limit");
  expect(await session.eligible(model)).toBe(false);
  const restarted = new PlanSession(new PlanStore(() => fixture.directory), fixture.oidc, () => now);
  expect(await restarted.eligible(model)).toBe(false);
  await expect(restarted.respond(body, signal(), owner)).rejects.toThrow("plan_limit");
  expect(inferences()).toHaveLength(1);
  await expect(session.respond(body, signal(), owner)).rejects.toThrow("plan_limit");
  expect(inferences()).toHaveLength(1);
  expect((await session.status(model, true, true))).toMatchObject({ state: "plan_limit", usageUrl: "https://chatgpt.com/settings/usage" });
});

test("temporary provider failure persists its shorter retry pause across sessions", async () => {
  const session = create(undefined, () => Response.json({ error: { code: "temporary_unavailable" } }, { status: 503 }));
  fixture.seed();
  await expect(session.respond(body, signal(), owner)).rejects.toThrow("retry_later");
  const restarted = new PlanSession(new PlanStore(() => fixture.directory), fixture.oidc, () => now);
  expect(await restarted.eligible(model)).toBe(false);
  await expect(restarted.respond(body, signal(), owner)).rejects.toThrow("retry_later");
  expect(inferences()).toHaveLength(1);
  expect(await restarted.status(model, true, true)).toMatchObject({ state: "retry_later", usageUrl: "https://chatgpt.com/settings/usage" });
  const row = await fixture.store.credentials();
  expect(row?.planPauseUntil).toBe(now + 30_000);
  expect(row?.planPauseReason).toBe("retry_later");
});

test.each([[429, 503], [503, 429]] as const)("overlapping %i and %i responses preserve the longer same-grant pause", async (firstStatus, secondStatus) => {
  let releaseFirst!: (response: Response) => void;
  let firstStarted!: () => void;
  let secondStarted!: () => void;
  const firstResponse = new Promise<Response>(resolve => { releaseFirst = resolve; });
  const started = new Promise<void>(resolve => { firstStarted = resolve; });
  const secondStartedPromise = new Promise<void>(resolve => { secondStarted = resolve; });
  let calls = 0;
  const failure = (status: number) => Response.json({ error: { code: status === 429
    ? "subscription_sharing_usage_limit_exceeded" : "temporary_unavailable" } }, { status });
  const session = create(undefined, async () => ++calls === 1 ? (firstStarted(), firstResponse) : (secondStarted(), failure(secondStatus)));
  fixture.seed();
  const first = session.respond(body, signal(), owner).catch(error => error);
  await started;
  const second = session.respond(body, signal(), owner).catch(error => error);
  await secondStartedPromise;
  await second;
  releaseFirst(failure(firstStatus));
  await first;
  const restarted = new PlanSession(new PlanStore(() => fixture.directory), fixture.oidc, () => now);
  expect(await fixture.store.credentials()).toMatchObject({ planPauseUntil: now + 60 * 60_000, planPauseReason: "plan_limit" });
  await expect(restarted.respond(body, signal(), owner)).rejects.toThrow("plan_limit");
  expect(inferences()).toHaveLength(2);
});

test("a late failure from an old account cannot pause its replacement registration", async () => {
  let release!: (response: Response) => void;
  let requestStarted!: () => void;
  const held = new Promise<Response>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { requestStarted = resolve; });
  const session = create(undefined, () => { requestStarted(); return held; });
  const old = fixture.seed();
  const pending = session.respond(body, signal(), owner).catch(error => error);
  await started;
  fixture.store.write("credentials", { ...old, clientId: "replacement-client", subject: "replacement-subject" });
  release(Response.json({ error: { code: "subscription_sharing_usage_limit_exceeded" } }, { status: 429 }));
  await pending;
  expect(await fixture.store.credentials()).toMatchObject({ clientId: "replacement-client", subject: "replacement-subject" });
  expect(await fixture.store.credentials()).not.toHaveProperty("planPauseUntil");
});

test.each([
  ["subscription_sharing_user_not_eligible", "not_eligible"],
  ["subscription_sharing_unsupported_capability", "request_invalid"],
] as const)("%s persists a restriction and never resubmits the plan request", async (code, restriction) => {
  const session = create(undefined, () => Response.json({ error: { code } }, { status: code.endsWith("unsupported_capability") ? 400 : 403 }));
  fixture.seed();
  await expect(session.respond(body, signal(), owner)).rejects.toThrow(restriction);
  expect(await fixture.store.credentials()).toMatchObject({ planRestriction: restriction });
  const restarted = new PlanSession(new PlanStore(() => fixture.directory), fixture.oidc, () => now);
  expect(await restarted.eligible(model)).toBe(false);
  await expect(restarted.respond(body, signal(), owner)).rejects.toThrow("plan_disabled");
  expect(inferences()).toHaveLength(1);
  expect((await restarted.status(model, true, true))).toMatchObject({ state: "plan_disabled", reason: restriction });
});

test("above the refresh window reuses the token and below it serializes independent sessions", async () => {
  const session = create((url, init) => {
    if (url === discovery.jwks_uri) return jwks();
    expect(url).toBe(discovery.token_endpoint);
    const form = init?.body as URLSearchParams;
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("client_id")).toBe(clientId);
    expect(form.get("resource")).toBe(RESOURCE);
    expect(form.has("scope")).toBe(false);
    const { scope: _scope, ...reply } = grant();
    return Response.json(reply);
  });
  fixture.seed();
  await session.respond(body, signal(), owner);
  expect(refreshes()).toHaveLength(0);
  expiring();
  const secondStore = new PlanStore(() => fixture.directory);
  const peer = new PlanSession(secondStore, fixture.oidc, () => now);
  await Promise.all([session.respond(body, signal(), owner), peer.respond(body, signal(), owner)]);
  expect(refreshes()).toHaveLength(1);
  expect(await secondStore.credentials()).toMatchObject({ tokens: { refreshToken: synth("refresh"), scopes: [PLAN_SCOPE] } });
  expect(inferences().slice(1).map(row => new Headers(row.init?.headers).get("authorization"))).toEqual(Array(2).fill(`Bearer ${synth("access")}`));
});

test("a peer's short-lived rotation serves requests already waiting for the previous token", async () => {
  let firstRead!: () => void, peerRead!: () => void;
  const oldRead = Promise.all([
    new Promise<void>(resolve => { firstRead = resolve; }),
    new Promise<void>(resolve => { peerRead = resolve; }),
  ]);
  const session = create(async () => {
    await oldRead;
    const { id_token: _identity, ...reply } = grant();
    return Response.json({ ...reply, expires_in: 30 });
  });
  expiring(now + 5_000);
  const credentials = fixture.store.credentials.bind(fixture.store);
  const observed = spyOn(fixture.store, "credentials").mockImplementation(async () => {
    const row = await credentials();
    firstRead();
    return row;
  });
  class PeerStore extends PlanStore {
    override async credentials() {
      const row = await super.credentials();
      peerRead();
      return row;
    }
  }
  const peer = new PlanSession(new PeerStore(() => fixture.directory), fixture.oidc, () => now);
  try {
    await Promise.all([session.respond(body, signal(), owner), peer.respond(body, signal(), owner)]);
    expect(refreshes()).toHaveLength(1);
    expect(inferences()).toHaveLength(2);
  } finally { observed.mockRestore(); }
});

test("refresh eligibility time uses a still-valid access token, and refuses an expired one", async () => {
  const session = create();
  const row = expiring();
  fixture.seed({ tokens: { ...row.tokens!, earliestRefreshAt: now + 61_000 } });
  await session.respond(body, signal(), owner);
  fixture.seed({ tokens: { ...row.tokens!, expiresAt: now - 1, earliestRefreshAt: now + 61_000 } });
  await expect(session.respond(body, signal(), owner)).rejects.toThrow("retry_later");
  expect(refreshes()).toHaveLength(0);
  expect(inferences()).toHaveLength(1);
});

test("checkpoints rotation before JWKS and resumes verification after reopening the session", async () => {
  let jwksCalls = 0;
  const session = create(async url => {
    if (url === discovery.token_endpoint) return Response.json(grant());
    expect(await fixture.store.credentials()).toMatchObject({ pendingRotation: true, tokens: { refreshToken: synth("refresh") } });
    if (++jwksCalls === 1) return new Response(null, { status: 503 });
    return jwks();
  });
  expiring();
  await expect(session.respond(body, signal(), owner)).rejects.toThrow("retry_later");
  expect(inferences()).toHaveLength(0);
  const restarted = new PlanSession(new PlanStore(() => fixture.directory), fixture.oidc, () => now);
  await restarted.respond(body, signal(), owner);
  expect(refreshes()).toHaveLength(1);
  expect(inferences()).toHaveLength(1);
  expect((await fixture.store.credentials())?.pendingRotation).toBeUndefined();
});

test.each([...unusableRefresh, "invalid_client"])("terminal %s clears tokens and keeps registration", async code => {
  const session = create(() => Response.json({ error: { code } }, { status: 400 }));
  expiring();
  await expect(session.respond(body, signal(), owner)).rejects.toThrow("reconnect_required");
  const row = await fixture.store.credentials();
  expect(row?.clientId).toBe(clientId);
  expect(row?.tokens).toBeUndefined();
  expect(row?.reconnect).toBe(code === "invalid_client" ? "client_rejected" : "reconnect_required");
  expect(inferences()).toHaveLength(0);
});

test.each(["network", "server", "body"])("temporary %s refresh failure keeps the credential", async mode => {
  const session = create(() => {
    if (mode === "network") throw new Error("private upstream message");
    if (mode === "body") return new Response(new ReadableStream({ start(controller) { controller.error(new Error("response disconnected")); } }));
    return Response.json({ detail: "private upstream message" }, { status: 503 });
  });
  const row = expiring();
  await expect(session.respond(body, signal(), owner)).rejects.toThrow("retry_later");
  expect(await fixture.store.credentials()).toEqual(row);
});

test("owner role lost during refresh blocks the paid dispatch after persisting rotation", async () => {
  let allowed = true;
  const session = create(url => {
    if (url === discovery.jwks_uri) { allowed = false; return jwks(); }
    return Response.json(grant());
  });
  expiring();
  await expect(session.respond(body, signal(), () => allowed)).rejects.toThrow("plan_disabled");
  expect(inferences()).toHaveLength(0);
  expect((await fixture.store.credentials())?.tokens?.refreshToken).toBe(synth("refresh"));
});

test.each([200, 503])("revocation status %i stops plan use and retains the registration", async status => {
  const session = create(async (url, init) => {
    expect(url).toBe(discovery.revocation_endpoint);
    const during = await fixture.store.credentials();
    expect(during).toMatchObject({ signedOut: true, revocationConfirmed: false });
    expect(during?.tokens).toBeUndefined();
    expect((init?.body as URLSearchParams).get("token_type_hint")).toBe("refresh_token");
    expect((init?.body as URLSearchParams).get("token")).toBe(synth("prior-refresh"));
    await expect(session.respond(body, signal(), owner)).rejects.toThrow("not_connected");
    return new Response(null, { status });
  });
  fixture.seed();
  expect(await session.signOut(owner)).toBe(status === 200);
  expect(fixture.requests.filter(row => row.url === discovery.revocation_endpoint)).toHaveLength(status === 200 ? 1 : 3);
  const row = await fixture.store.credentials();
  expect(row).toMatchObject({ signedOut: true, clientId, revocationConfirmed: status === 200 });
  expect(row?.tokens).toBeUndefined();
});

test("sign-out attempts both active and checkpointed grants and clears both locally", async () => {
  const attempted: string[] = [];
  const session = create(async (url, init) => {
    expect(url).toBe(discovery.revocation_endpoint);
    const token = (init?.body as URLSearchParams).get("token")!;
    attempted.push(token);
    return new Response(null, { status: token === synth("prior-refresh") ? 200 : 503 });
  });
  fixture.seed({ pendingGrantRefresh: synth("pending-refresh") });
  expect(await session.signOut(owner)).toBe(false);
  expect(attempted).toContain(synth("pending-refresh"));
  expect(attempted).toContain(synth("prior-refresh"));
  expect(await fixture.store.credentials()).toMatchObject({ signedOut: true, revocationConfirmed: false });
  expect(await fixture.store.credentials()).not.toHaveProperty("pendingGrantRefresh");
  expect(await fixture.store.credentials()).not.toHaveProperty("tokens");
});
