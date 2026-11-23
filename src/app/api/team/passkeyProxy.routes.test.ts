import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { NextRequest } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { proxy } from "@/proxy";
import { claimInstall } from "@/lib/team/members";
import { MEMBER_COOKIE } from "@/lib/team/sessions";
import { SoftwareAuthenticator } from "@/lib/team/softwareAuthenticator.test-support";
import { resetTeamStoreForTests, teamStore } from "@/lib/team/store";
import { GET as publicInfo } from "./public/route";
import { GET as passkeys, POST as register } from "./passkeys/route";
import { POST as signIn } from "./session/passkey/route";
import { POST as approval } from "./session/approval/route";
import { POST as invite } from "./invites/route";

const PUBLIC_HOST = "viewer.example.net";
const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;
const LOCAL_HOST = "127.0.0.1:8898";
const LOCAL_ORIGIN = `http://${LOCAL_HOST}`;
const saved = { ...process.env };
let server: ReturnType<typeof Bun.serve>;
let cookie: string;
let memberId: string;
let stateDirectory: string;

beforeEach(() => {
  setSystemTime(new Date("2026-11-05T12:00:00Z"));
  process.env.LLV_TOKEN = "test-access-key";
  process.env.LLV_PUBLIC_ORIGIN = PUBLIC_ORIGIN;
  process.env.HOSTNAME = "127.0.0.1";
  delete process.env.LLV_PUBLIC_HOST;
  delete process.env.LLV_TS_HOST;
  delete process.env.LLV_TS_URL;
  resetTeamStoreForTests();
  stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-passkey-proxy-"));
  process.env.LLV_STATE_DIR = stateDirectory;
  const signed = claimInstall(teamStore(), "Owner", { surface: "desktop", browser: "chrome" });
  cookie = `${MEMBER_COOKIE}=${signed.cookie}`;
  memberId = signed.member.id;
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const req = new NextRequest(request);
    const gate = proxy(req);
    if (gate.headers.get("x-middleware-next") !== "1") return gate;
    switch (`${req.method} ${req.nextUrl.pathname}`) {
      case "GET /api/team/public": return publicInfo(req);
      case "GET /api/team/passkeys": return passkeys(req);
      case "POST /api/team/passkeys": return register(req);
      case "POST /api/team/session/passkey": return signIn(req);
      case "POST /api/team/session/approval": return approval(req);
      case "POST /api/team/invites": return invite(req);
      default: return new Response("unhandled", { status: 404 });
    }
  } });
});

afterEach(async () => {
  await server?.stop(true);
  resetTeamStoreForTests();
  fs.rmSync(stateDirectory, { recursive: true, force: true });
  for (const key of ["LLV_STATE_DIR", "LLV_TOKEN", "LLV_PUBLIC_ORIGIN", "LLV_PUBLIC_HOST", "LLV_TS_HOST", "LLV_TS_URL", "HOSTNAME"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  setSystemTime();
});

function call(path: string, body?: object, { legacy = false, signed = false, headers = {} }: {
  legacy?: boolean; signed?: boolean; headers?: Record<string, string>;
} = {}) {
  return fetch(new URL(path, server.url), { method: body ? "POST" : "GET", headers: {
    host: legacy ? LOCAL_HOST : PUBLIC_HOST,
    origin: legacy ? LOCAL_ORIGIN : PUBLIC_ORIGIN,
    "sec-fetch-site": "same-origin", "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.10",
    ...(signed ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers,
  }, body: body ? JSON.stringify(body) : undefined });
}

test("preserved public Host and Origin register and sign in through the real routes", async () => {
  // Carry the same member cookie across the proxy edit.
  const beforeProxyEdit = await call("/api/team/passkeys", undefined, { legacy: true, signed: true });
  expect(beforeProxyEdit.status).toBe(200);
  expect(await beforeProxyEdit.json()).toMatchObject({ available: false });
  const info = await call("/api/team/public");
  expect(info.status).toBe(200);
  expect(await info.json()).toMatchObject({ mode: "team", hostName: PUBLIC_HOST, methods: { passkey: { available: true, address: PUBLIC_ORIGIN }, telegram: { available: false } } });
  const authenticator = await new SoftwareAuthenticator().init();
  const optionsResponse = await call("/api/team/passkeys", { step: "options" }, { signed: true });
  expect(optionsResponse.status).toBe(200);
  const registration = await optionsResponse.json();
  expect(registration.options.rp.id).toBe(PUBLIC_HOST);
  const credential = await authenticator.register(registration.options, PUBLIC_ORIGIN);
  const registered = await call("/api/team/passkeys", { step: "verify", id: registration.id, response: credential }, { signed: true });
  expect(registered.status).toBe(200);
  expect(teamStore().passkeysFor(memberId)).toHaveLength(1);
  const listing = await call("/api/team/passkeys", undefined, { signed: true });
  expect(await listing.json()).toMatchObject({ available: true, passkeys: [{ rpId: PUBLIC_HOST, here: true }] });
  const invitation = await call("/api/team/invites", {}, { signed: true });
  expect(invitation.status).toBe(200);
  expect((await invitation.json()).url).toStartWith(`${PUBLIC_ORIGIN}/join/`);

  const signInOptions = await call("/api/team/session/passkey", { step: "options" });
  expect(signInOptions.status).toBe(200);
  const options = await signInOptions.json();
  expect(options.options.rpId).toBe(PUBLIC_HOST);
  const assertion = await authenticator.assert(options.options, PUBLIC_HOST, PUBLIC_ORIGIN, registration.options.user.id);
  const signedIn = await call("/api/team/session/passkey", { step: "verify", id: options.id, response: assertion });
  expect(signedIn.status).toBe(200);
  expect(await signedIn.json()).toMatchObject({ ok: true, me: { id: memberId } });
  expect(signedIn.headers.get("set-cookie")).toContain("Secure");
  expect(signedIn.headers.get("set-cookie")).toContain("HttpOnly");
  expect(signedIn.headers.get("set-cookie")).toContain("SameSite=lax");
});

test("today's rewrite keeps approval, sessions and links working before and after the server setting is added", async () => {
  for (const configured of [false, true]) {
    if (configured) process.env.LLV_PUBLIC_ORIGIN = PUBLIC_ORIGIN;
    else delete process.env.LLV_PUBLIC_ORIGIN;
    const options = { legacy: true };
    const info = await call("/api/team/public", undefined, options);
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ hostName: "127.0.0.1", methods: { passkey: { available: false }, telegram: { available: false } } });
    for (const [path, signed] of [["/api/team/session/passkey", false], ["/api/team/passkeys", true]] as const) {
      const unavailable = await call(path, { step: "options" }, { ...options, signed });
      expect(unavailable.status).toBe(409);
      expect(await unavailable.json()).toMatchObject({ code: "passkey_unavailable" });
    }
    expect((await call("/api/team/session/approval", {}, options)).status).toBe(200);
    const invitation = await call("/api/team/invites", {}, { ...options, signed: true });
    expect(invitation.status).toBe(200);
    expect((await invitation.json()).url).toStartWith(`https://${LOCAL_HOST}/join/`);
  }
});

test("both ceremonies reject cryptographically valid credentials for an attacker origin", async () => {
  const authenticator = await new SoftwareAuthenticator().init();
  const registrationOptions = await call("/api/team/passkeys", { step: "options" }, { signed: true });
  expect(registrationOptions.status).toBe(200);
  const registration = await registrationOptions.json();
  const wrongRegistration = await authenticator.register(registration.options, "https://evil.example.net");
  const refused = await call("/api/team/passkeys", { step: "verify", id: registration.id, response: wrongRegistration }, { signed: true });
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({ code: "passkey_rejected" });
  expect(teamStore().passkeysFor(memberId)).toHaveLength(0);
  const rightRegistration = await authenticator.register(registration.options, PUBLIC_ORIGIN);
  expect((await call("/api/team/passkeys", { step: "verify", id: registration.id, response: rightRegistration }, { signed: true })).status).toBe(200);
  const options = await (await call("/api/team/session/passkey", { step: "options" })).json();
  const wrongAssertion = await authenticator.assert(options.options, PUBLIC_HOST, "https://evil.example.net", registration.options.user.id);
  const wrongSignIn = await call("/api/team/session/passkey", { step: "verify", id: options.id, response: wrongAssertion });
  expect(wrongSignIn.status).toBe(401);
  expect(await wrongSignIn.json()).toMatchObject({ code: "passkey_rejected" });
  expect(wrongSignIn.headers.get("set-cookie")).toBeNull();
});

test("host and origin forgeries are refused before every public or authenticated team route", async () => {
  const forgeries: Record<string, string>[] = [
    { host: "evil.example.net", origin: "https://evil.example.net", "x-forwarded-host": PUBLIC_HOST },
    { host: "evil.example.net", origin: PUBLIC_ORIGIN, forwarded: `host=${PUBLIC_HOST};proto=https` },
    { origin: "https://evil.example.net" }, { origin: `http://${PUBLIC_HOST}` }, { origin: `${PUBLIC_ORIGIN}:8443` },
    { origin: "http://localhost" }, { "sec-fetch-site": "cross-site" },
  ];
  for (const headers of forgeries) {
    for (const path of ["/api/team/public", "/api/team/passkeys", "/api/team/session/passkey", "/api/team/session/approval", "/api/team/invites"]) {
      const response = await call(path, path.endsWith("public") ? undefined : {}, { signed: true, headers });
      expect(response.status, `${path}: ${JSON.stringify(headers)}`).toBe(403);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  }
  // Forwarded headers cannot replace today's rewritten loopback authority.
  const loopback = await call("/api/team/public", undefined, { legacy: true, headers: { "x-forwarded-host": "evil.example.net" } });
  expect(await loopback.json()).toMatchObject({ hostName: "127.0.0.1", methods: { passkey: { available: false } } });
});
