import { afterEach, expect, spyOn, test } from "bun:test";
import { PLAN_SCOPE, RESOURCE } from "./constants";
import { unusableRefresh } from "./errors";
import { clientId, complete, discovery, grant, jwks, model, now, planFixture, stream, synth } from "./plan.fixture";
import { PlanSession } from "./session";
import { PlanStore } from "./store";

let fixture: ReturnType<typeof planFixture>;
afterEach(() => fixture.dispose());
const body = { model, input: [{ role: "user", content: "Read the board" }] };
const signal = () => AbortSignal.timeout(4_000);
const owner = () => true;
const responsesUrl = `${RESOURCE}/responses`;
function create(handle?: Parameters<typeof planFixture>[0]) {
  fixture = planFixture((url, init) => url === responsesUrl ? stream(complete({ output: [] })) : handle!(url, init));
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
