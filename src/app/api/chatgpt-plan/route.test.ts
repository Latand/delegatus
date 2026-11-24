import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { NextRequest } from "next/server";
import { soloBrowserSession } from "@/lib/agent/operatorSession";
import { discovery, grant, jwks, label, modelsUrl, now, planFixture, synth, until } from "@/lib/chatgptPlan/plan.fixture";
import { PlanSession } from "@/lib/chatgptPlan/session";
import { claimInstall, createInvite, redeemJoin } from "@/lib/team/members";
import { MEMBER_COOKIE } from "@/lib/team/sessions";
import { resetTeamStoreForTests, teamStore } from "@/lib/team/store";
import { DELETE, GET, POST } from "./route";

const globals = globalThis as typeof globalThis & { __delegatusChatGPTPlan?: PlanSession };
const origin = "http://127.0.0.1:8898";
let f: ReturnType<typeof planFixture>;
const staging = process.env.LLV_STAGING;
const formerState = process.env.LLV_STATE_DIR;
let nonce: string | undefined;
const raw = (method: string, body?: unknown, headers: Record<string, string> = {}, cookie?: string) =>
  new NextRequest(`${origin}/api/chatgpt-plan`, { method, headers: { host: new URL(origin).host, origin,
    "content-type": "application/json", cookie: cookie ?? `llv_operator=${soloBrowserSession()}`, ...headers },
  body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  delete process.env.LLV_STAGING;
  f = planFixture(url => {
    if (url === discovery.jwks_uri) return jwks();
    if (url === discovery.token_endpoint) return Response.json(grant(nonce));
    if (url === modelsUrl) return Response.json({ models: [] });
    if (url === discovery.revocation_endpoint) return new Response(null, { status: 200 });
    throw new Error("Unexpected fixture route");
  });
  globals.__delegatusChatGPTPlan = new PlanSession(f.store, f.oidc, () => now);
  process.env.LLV_STATE_DIR = f.root;
  resetTeamStoreForTests();
});

afterEach(() => {
  globals.__delegatusChatGPTPlan?.oauth.cancel();
  delete globals.__delegatusChatGPTPlan;
  if (staging === undefined) delete process.env.LLV_STAGING; else process.env.LLV_STAGING = staging;
  if (formerState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = formerState;
  resetTeamStoreForTests();
  f.dispose();
});

test("the plan is off with no issued client ID and cannot be used on staging", async () => {
  const read = await GET(raw("GET"));
  expect(read.headers.get("cache-control")).toBe("no-store");
  expect(await read.json()).toMatchObject({ state: "not_connected" });
  process.env.LLV_STAGING = "1";
  expect(await (await GET(raw("GET"))).json()).toEqual({ state: "off_staging" });
  expect((await POST(raw("POST", { action: "sign-in" }))).status).toBe(409);
  expect((await DELETE(raw("DELETE"))).status).toBe(409);
  expect(f.requests).toHaveLength(0);
});

test("an allowed remote browser can read the reason and cannot open a loopback listener", async () => {
  const saved = process.env.LLV_TS_HOST;
  const host = "viewer.example";
  process.env.LLV_TS_HOST = host;
  try {
    const remote = { host, origin: `https://${host}` };
    expect(await (await GET(raw("GET", undefined, remote))).json()).toEqual({ state: "remote_browser" });
    expect((await POST(raw("POST", { action: "sign-in" }, remote))).status).toBe(409);
    expect((await POST(raw("POST", { action: "sign-in" }, { origin: "https://another.example" }))).status).toBe(403);
    expect(f.requests).toHaveLength(0);
  } finally {
    if (saved === undefined) delete process.env.LLV_TS_HOST; else process.env.LLV_TS_HOST = saved;
  }
});

test("agent and member controls are refused and a member sees only a state", async () => {
  f.seed();
  const agent = { "x-llv-spawn-capability": "a".repeat(43) };
  expect((await GET(raw("GET", undefined, agent))).status).toBe(403);
  expect((await POST(raw("POST", { action: "cancel" }, agent))).status).toBe(403);
  expect((await DELETE(raw("DELETE", undefined, agent))).status).toBe(403);
  const store = teamStore();
  const owner = claimInstall(store, "Owner fixture", { surface: "desktop", browser: "chrome" });
  const member = redeemJoin(store, createInvite(store, owner.member, null).code, "Member fixture", { surface: "phone", browser: "safari" });
  const cookie = `${MEMBER_COOKIE}=${member.cookie}`;
  expect(await (await GET(raw("GET", undefined, {}, cookie))).json()).toEqual({ state: "connected" });
  for (const action of ["sign-in", "enable-plan", "cancel", "acknowledge"]) {
    expect((await POST(raw("POST", { action }, {}, cookie))).status).toBe(403);
  }
  expect((await DELETE(raw("DELETE", undefined, {}, cookie))).status).toBe(403);
  expect(f.requests).toHaveLength(0);
});

test("authorized flow answers from an allowlist and keeps all credentials out of console output", async () => {
  const logs = spyOn(console, "info").mockImplementation(() => {});
  try {
    const results = [];
    const start = await POST(raw("POST", { action: "sign-in" }));
    expect(start.status).toBe(200);
    const signed = await start.text();
    results.push(signed);
    const authorize = new URL(JSON.parse(signed).authorizeUrl);
    nonce = authorize.searchParams.get("nonce")!;
    const target = new URL(authorize.searchParams.get("redirect_uri")!);
    target.search = new URLSearchParams({ state: authorize.searchParams.get("state")!, code: synth("code"), client_id: "issued-fixture" }).toString();
    let resumeRead!: () => void;
    let beganRead = false, captured = false;
    const held = new Promise<void>(resolve => { resumeRead = resolve; });
    const read = f.store.credentials.bind(f.store);
    const probe = spyOn(f.store, "credentials").mockImplementation(async () => {
      if (beganRead) return read();
      beganRead = true;
      const snapshot = await read();
      captured = true;
      await held;
      return snapshot;
    });
    const pending = GET(raw("GET"));
    try {
      await until(() => captured);
      results.push(await (await fetch(target)).text());
      await until(() => globals.__delegatusChatGPTPlan?.oauth.pending === false);
      resumeRead();
      expect(await (await pending).json()).toMatchObject({ state: "connecting" });
    } finally {
      resumeRead();
      probe.mockRestore();
    }
    const status = await (await GET(raw("GET"))).text();
    results.push(status);
    expect(JSON.parse(status)).toMatchObject({ state: "connected", account: { email: label }, planModels: { voiceBackend: false } });
    const form = f.requests.find(entry => entry.url === discovery.token_endpoint)?.init?.body as URLSearchParams;
    results.push(await (await DELETE(raw("DELETE"))).text());
    const joined = JSON.stringify([results, logs.mock.calls]);
    for (const sensitive of [synth("access"), synth("refresh"), synth("code"), grant(nonce).id_token, form.get("code_verifier")!]) {
      expect(joined).not.toContain(sensitive);
    }
  } finally { logs.mockRestore(); }
});
