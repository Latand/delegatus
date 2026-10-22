import { afterEach, beforeEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { closeAgentRegistryForTests } from "./registry";
import { ensureOperatorSpawnCapability } from "./operatorCapability";
import {
  directOperatorActivityAuthority,
  internalServiceHeaders,
  requireOperatorAuthority,
  operatorBrowserRequest,
  rotationActor,
  setCallerConversationResolverForTests,
  voiceTransportOperator,
} from "./operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "./spawnPolicy";

const sandboxes: string[] = [];
const originalToken = process.env.LLV_TOKEN;
const originalScript = process.env.LLV_OPERATOR_TOKEN;
const configuredScriptKey = crypto.createHash("sha256").update("operator script fixture").digest("base64url");
const configuredKey = crypto.createHash("sha256").update("operator authority fixture").digest("base64url");
const originalStateDir = process.env.LLV_STATE_DIR;

beforeEach(() => {
  process.env.LLV_TOKEN = configuredKey;
  process.env.LLV_OPERATOR_TOKEN = configuredScriptKey;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-operator-authority-"));
  sandboxes.push(dir);
  process.env.LLV_STATE_DIR = path.join(dir, "state");
});

afterEach(() => {
  if (originalScript === undefined) delete process.env.LLV_OPERATOR_TOKEN; else process.env.LLV_OPERATOR_TOKEN = originalScript;
  if (originalToken === undefined) delete process.env.LLV_TOKEN; else process.env.LLV_TOKEN = originalToken;
  closeAgentRegistryForTests();
  setCallerConversationResolverForTests(null);
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function request(headers: Record<string, string>): NextRequest {
  return new NextRequest("http://127.0.0.1/api/orchestrator/seat", { method: "POST", headers });
}

/** What an ordinary tab's fetch actually looks like on the wire. */
const BROWSER = {
  host: "127.0.0.1",
  origin: "http://127.0.0.1",
  "sec-fetch-site": "same-origin",
  cookie: `llv_auth=${configuredKey}`,
  "content-type": "application/json",
};

test("an authenticated browser may perform operator actions, while bare requests are refused", () => {
  expect(requireOperatorAuthority(request(BROWSER)).ok).toBe(true);
  expect(requireOperatorAuthority(request({ host: "127.0.0.1" })).ok).toBe(false);
});

test("an agent naming itself with its capability is refused, whatever else it sends", () => {
  const workerCapability = crypto.randomBytes(32).toString("base64url");
  setCallerConversationResolverForTests(() => "conversation_worker");

  for (const headers of [
    { [VIEWER_SPAWN_CAPABILITY_HEADER]: workerCapability },
    { ...BROWSER, [VIEWER_SPAWN_CAPABILITY_HEADER]: workerCapability },
  ]) {
    const verdict = requireOperatorAuthority(request(headers));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.status).toBe(403);
      expect(verdict.error).toContain("agent");
    }
  }
});

test("an unknown conversation capability supplies no operator credential", () => {
  for (const candidate of ["", "  ", "short", "x".repeat(200), crypto.randomBytes(32).toString("base64url")]) {
    expect(requireOperatorAuthority(request({ [VIEWER_SPAWN_CAPABILITY_HEADER]: candidate })).ok).toBe(false);
  }
});

test("the on-disk service capability supplies no operator credential", () => {
  const onDisk = ensureOperatorSpawnCapability();
  expect(onDisk).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(requireOperatorAuthority(request({ [VIEWER_SPAWN_CAPABILITY_HEADER]: onDisk })).ok).toBe(false);
});

/* --------------------------------------------------------------------------- *
 * Voice transport asks the identical question — the two are one rule now.
 * --------------------------------------------------------------------------- */

test("a card voice click needs the browser session", () => {
  expect(voiceTransportOperator(request({ host: "127.0.0.1" }))).toBe(false);
  expect(voiceTransportOperator(request(BROWSER))).toBe(true);
});

test("voice transport: an agent naming itself with its capability is refused", () => {
  const workerCapability = crypto.randomBytes(32).toString("base64url");
  setCallerConversationResolverForTests(() => "conversation_worker");
  expect(voiceTransportOperator(request({ [VIEWER_SPAWN_CAPABILITY_HEADER]: workerCapability }))).toBe(false);
});

test("transport and operator-only actions agree: one rule, asked twice", () => {
  const workerCapability = crypto.randomBytes(32).toString("base64url");
  setCallerConversationResolverForTests(() => "conversation_worker");
  const agent = request({ [VIEWER_SPAWN_CAPABILITY_HEADER]: workerCapability });
  expect(voiceTransportOperator(agent)).toBe(false);
  expect(requireOperatorAuthority(agent).ok).toBe(false);

  setCallerConversationResolverForTests(() => null);
  const browser = request(BROWSER);
  expect(voiceTransportOperator(browser)).toBe(true);
  expect(requireOperatorAuthority(browser).ok).toBe(true);
});

test("direct activity accepts a browser and rejects server-authenticated background producers", () => {
  expect(directOperatorActivityAuthority(request(BROWSER)).ok).toBe(true);

  for (const service of ["monitor", "mcp", "orchestrator"] as const) {
    const serviceRequest = request({ ...BROWSER, ...internalServiceHeaders(service) });
    expect(directOperatorActivityAuthority(serviceRequest).ok).toBe(false);
    /* Service provenance does not alter
       the product's existing operator-authority contract. */
    expect(requireOperatorAuthority(serviceRequest).ok).toBe(true);
  }
});

/* --------------------------------------------------------------------------- *
 * Rotation asks the same question and answers it with a NAME (#1402).
 * --------------------------------------------------------------------------- */

test("REGRESSION (#1402): rotation NAMES every caller and refuses none — the agent it used to reject included", () => {
  const workerCapability = crypto.randomBytes(32).toString("base64url");
  setCallerConversationResolverForTests(() => "conversation_worker");

  /* The self-named agent: refused for every operator-only action, and named
     for rotation. There is no other answer this function can give. */
  const agent = request({ ...BROWSER, [VIEWER_SPAWN_CAPABILITY_HEADER]: workerCapability });
  expect(requireOperatorAuthority(agent).ok).toBe(false);
  expect(rotationActor(agent)).toEqual({ kind: "agent", conversationId: "conversation_worker" });

  /* The operator's own tab names no conversation, and carries the `operator`
     label to say so. */
  setCallerConversationResolverForTests(() => null);
  expect(rotationActor(request(BROWSER))).toEqual({ kind: "operator", conversationId: null });
  /* A background lane's marker classifies activity and has never been an actor
     rule; rotation reads the same thing here as it does without it. */
  expect(rotationActor(request({ ...BROWSER, ...internalServiceHeaders("mcp") })))
    .toEqual({ kind: "operator", conversationId: null });
});

test("an invalid internal-service claim cannot impersonate authenticated background provenance", () => {
  expect(directOperatorActivityAuthority(request({
    ...BROWSER,
    "x-llv-internal-service": "mcp.invalid",
  })).ok).toBe(true);
});

test("spoofed Fetch Metadata supplies no operator authority without a session or token", () => {
  for (const headers of [{}, { ...BROWSER, cookie: "" }, { ...BROWSER, cookie: "llv_member=invalid" }]) {
    const req = request(headers);
    expect(requireOperatorAuthority(req)).toMatchObject({ ok: false, status: 403 });
    expect(voiceTransportOperator(req)).toBe(false);
  }
});

test("a separate operator token permits scripts while only a verified cookie supplies browser attribution", () => {
  const script = request({ authorization: `Bearer ${configuredKey}`, "x-llv-operator-token": configuredScriptKey, "sec-fetch-site": "same-origin" });
  expect(requireOperatorAuthority(script).ok).toBe(true);
  expect(operatorBrowserRequest(script)).toBe(false);
  expect(operatorBrowserRequest(request(BROWSER))).toBe(true);
  for (const host of ["localhost", "127.0.0.1", "viewer.example.invalid"]) {
    expect(requireOperatorAuthority(request({ ...BROWSER, host })).ok).toBe(true);
  }
  process.env.LLV_TOKEN = crypto.createHash("sha256").update("rotated fixture").digest("base64url");
  process.env.LLV_OPERATOR_TOKEN = crypto.createHash("sha256").update("rotated script fixture").digest("base64url");
  expect(requireOperatorAuthority(script).ok).toBe(false);
  expect(requireOperatorAuthority(request(BROWSER)).ok).toBe(false);
});

test("a keyless solo navigation bootstraps a cookie, and APIs cannot bootstrap authority", async () => {
  const { teamGate } = await import("@/lib/team/gate");
  delete process.env.LLV_TOKEN;
  for (const host of ["127.0.0.1", "localhost", "viewer.example.invalid"]) {
    const previousHost = process.env.LLV_TS_HOST;
    process.env.LLV_TS_HOST = host;
    try {
      const navigation = new NextRequest(`http://${host}/`, { headers: { host, accept: "text/html" } });
      const response = teamGate(navigation, { bearerAuthenticated: false });
      const cookie = response!.cookies.get("llv_operator")!.value;
      expect(response!.headers.get("set-cookie")).toContain("HttpOnly");
      expect(requireOperatorAuthority(request({ host, cookie: `llv_operator=${cookie}` })).ok).toBe(true);
      expect(operatorBrowserRequest(request({ host, cookie: `llv_operator=${cookie}` }))).toBe(true);
      expect(teamGate(request({ host, "sec-fetch-site": "same-origin" }), { bearerAuthenticated: false })).toBeNull();
      const forgedNavigation = new NextRequest(`http://${host}/api/operator/worker-limit`, { headers: { host, "sec-fetch-mode": "navigate", accept: "text/html" } });
      expect(teamGate(forgedNavigation, { bearerAuthenticated: false })).toBeNull();
      expect(requireOperatorAuthority(request({ host, "sec-fetch-site": "same-origin" })).ok).toBe(false);
    } finally {
      if (previousHost === undefined) delete process.env.LLV_TS_HOST; else process.env.LLV_TS_HOST = previousHost;
    }
  }
});

test("a solo session minted in one process authorizes browser actions in another", async () => {
  const run = (source: string, env: NodeJS.ProcessEnv = process.env) => promisify(execFile)(process.execPath, ["-e", source], { env, timeout: 10_000 });
  const minted = await run(`import { soloBrowserSession } from './src/lib/agent/operatorSession'; console.log(soloBrowserSession(0))`);
  const cookie = minted.stdout.trim();
  const verified = await run(`
    import { verifySoloBrowserSession } from './src/lib/agent/operatorSession';
    import { requireOperatorAuthority, operatorBrowserRequest } from './src/lib/agent/operatorAuthority';
    Date.now = () => 1;
    const request = { headers: new Headers({ cookie: 'llv_operator=' + process.env.TEST_COOKIE }) };
    console.log(JSON.stringify({ verified: verifySoloBrowserSession(process.env.TEST_COOKIE, 1),
      expired: verifySoloBrowserSession(process.env.TEST_COOKIE, 31 * 24 * 60 * 60 * 1000),
      authority: requireOperatorAuthority(request).ok, browser: operatorBrowserRequest(request) }));
  `, { ...process.env, TEST_COOKIE: cookie });
  expect(JSON.parse(verified.stdout)).toEqual({ verified: true, expired: false, authority: true, browser: true });
});

test("solo session signatures bind expiry, state directory and access-key generation", async () => {
  const { soloBrowserSession, verifySoloBrowserSession } = await import("./operatorSession");
  const value = soloBrowserSession(0);
  expect(verifySoloBrowserSession(value, 1)).toBe(true);
  expect(verifySoloBrowserSession(value, 30 * 24 * 60 * 60 * 1000)).toBe(false);
  expect(verifySoloBrowserSession(value, -1)).toBe(false);
  expect(verifySoloBrowserSession(value.replace(/v1\.\d+/, "v1.2592000001"), 1)).toBe(false);
  expect(verifySoloBrowserSession(value.slice(0, -1) + (value.endsWith("a") ? "b" : "a"), 1)).toBe(false);
  const state = process.env.LLV_STATE_DIR!;
  const key = path.join(state, "operator-session-key");
  if (process.platform !== "win32") expect(fs.statSync(key).mode & 0o777).toBe(0o600);
  const oldKey = process.env.LLV_TOKEN;
  process.env.LLV_TOKEN = "changed-access-generation";
  expect(verifySoloBrowserSession(value, 1)).toBe(false);
  process.env.LLV_TOKEN = oldKey;
  process.env.LLV_STATE_DIR = path.join(state, "other");
  expect(verifySoloBrowserSession(value, 1)).toBe(false);
  expect(fs.existsSync(path.join(process.env.LLV_STATE_DIR, "operator-session-key"))).toBe(false);
  process.env.LLV_STATE_DIR = state;
  fs.writeFileSync(key, "damaged");
  expect(verifySoloBrowserSession(value, 1)).toBe(false);
  expect(() => soloBrowserSession(0)).toThrow("signing key");
});

test("live member sessions permit browser actions and revocation takes effect immediately", async () => {
  const { claimInstall } = await import("@/lib/team/members");
  const { teamStore, resetTeamStoreForTests } = await import("@/lib/team/store");
  const { teamActor } = await import("@/lib/team/actor");
  const { MEMBER_COOKIE, sha256Hex } = await import("@/lib/team/sessions");
  try {
    const store = teamStore();
    const claimed = claimInstall(store, "Owner", { surface: "desktop", browser: "chrome" });
    const req = request({ cookie: `${MEMBER_COOKIE}=${claimed.cookie}` });
    expect(requireOperatorAuthority(req).ok).toBe(true);
    expect(operatorBrowserRequest(req)).toBe(true);
    expect(teamActor(req)).toMatchObject({ kind: "member" });
    expect(teamActor(request({}))).toEqual({ kind: "anonymous" });
    store.revokeSession(sha256Hex(claimed.cookie), new Date().toISOString());
    expect(requireOperatorAuthority(req).ok).toBe(false);
    expect(operatorBrowserRequest(req)).toBe(false);
    expect(teamActor(req)).toEqual({ kind: "anonymous" });
  } finally { resetTeamStoreForTests(); }
});

test("the trusted local browser entry gets a cookie even when the gateway injects the access token", async () => {
  expect(requireOperatorAuthority(request({ authorization: `Bearer ${configuredKey}`, "sec-fetch-site": "same-origin" })).ok).toBe(false);
  const { proxy } = await import("../../proxy");
  const navigation = new NextRequest("http://127.0.0.1/", { headers: { host: "127.0.0.1", accept: "text/html", authorization: `Bearer ${configuredKey}` } });
  const response = proxy(navigation);
  const value = response.cookies.get("llv_operator")?.value;
  expect(typeof value).toBe("string");
  const req = request({ cookie: `llv_operator=${value}`, authorization: `Bearer ${configuredKey}` });
  expect(operatorBrowserRequest(req)).toBe(true);
  process.env.LLV_TOKEN = crypto.createHash("sha256").update("gateway rotation").digest("base64url");
  expect(requireOperatorAuthority(req).ok).toBe(false);
});

test("verified MCP dispatch retains its separate token authority and other service tags do not", () => {
  const mcp = internalServiceHeaders("mcp");
  expect(requireOperatorAuthority(request(mcp)).ok).toBe(true);
  setCallerConversationResolverForTests(() => "conversation_worker");
  expect(requireOperatorAuthority(request({ ...mcp, [VIEWER_SPAWN_CAPABILITY_HEADER]: "a".repeat(43) })).ok).toBe(false);
  setCallerConversationResolverForTests(() => null);
  for (const service of ["monitor", "orchestrator", "controller", "probe"] as const) {
    expect(requireOperatorAuthority(request(internalServiceHeaders(service))).ok).toBe(false);
  }
  expect(requireOperatorAuthority(request({ "x-llv-internal-service": "mcp.invalid" })).ok).toBe(false);
});


test("headless agent environments exclude every operator credential alias", async () => {
  const { reviewerEnvironment } = await import("./headless");
  const source: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, LLV_TOKEN: "fixture", DELEGATUS_TOKEN: "fixture", LLV_OPERATOR_TOKEN: "fixture", DELEGATUS_OPERATOR_TOKEN: "fixture" };
  const child = reviewerEnvironment(source, "a".repeat(43));
  for (const name of ["LLV_TOKEN", "DELEGATUS_TOKEN", "LLV_OPERATOR_TOKEN", "DELEGATUS_OPERATOR_TOKEN"]) expect(child[name]).toBeUndefined();
  expect(child.LLV_SPAWN_CAPABILITY).toBe("a".repeat(43));
  expect(child.PATH).toBe(source.PATH);
  expect(source.LLV_OPERATOR_TOKEN).toBe("fixture");
});


test("access cookies use the proxy's cookie encoding and malformed values are refused", async () => {
  const { proxy } = await import("../../proxy");
  process.env.LLV_TOKEN = `${configuredKey}+/=%`;
  const url = new URL("http://127.0.0.1/"); url.searchParams.set("k", process.env.LLV_TOKEN);
  const response = proxy(new NextRequest(url, { headers: { host: "127.0.0.1", accept: "text/html" } }));
  const wire = response.headers.get("set-cookie")!.split(";")[0]!;
  expect(requireOperatorAuthority(request({ cookie: wire })).ok).toBe(true);
  for (const value of ["%", "%GG", "%E0%A4%A"]) expect(requireOperatorAuthority(request({ cookie: `llv_auth=${value}` }))).toMatchObject({ ok: false, status: 403 });
});


test("cross-site page entry mints a usable same-origin solo session after Host admission", async () => {
  delete process.env.LLV_TOKEN;
  const { proxy } = await import("../../proxy");
  for (const host of ["localhost", "127.0.0.1", "viewer.example.invalid"]) {
    const previous = process.env.LLV_TS_HOST;
    process.env.LLV_TS_HOST = host;
    try {
      const response = proxy(new NextRequest(`http://${host}/`, { headers: {
        host, accept: "text/html", "sec-fetch-mode": "navigate", "sec-fetch-site": "cross-site",
      } }));
      expect(response.headers.get("x-middleware-next")).toBe("1");
      expect(response.headers.get("set-cookie")).toContain("SameSite=strict");
      const value = response.cookies.get("llv_operator")?.value;
      expect(typeof value).toBe("string");
      expect(requireOperatorAuthority(request({ host, cookie: `llv_operator=${value}` })).ok).toBe(true);
      expect(operatorBrowserRequest(request({ host, cookie: `llv_operator=${value}` }))).toBe(true);
      const foreign = proxy(new NextRequest("http://foreign.example.invalid/", { headers: {
        host: "foreign.example.invalid", accept: "text/html", "sec-fetch-mode": "navigate",
      } }));
      expect(foreign.status).toBe(403);
      expect(foreign.headers.get("set-cookie")).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.LLV_TS_HOST; else process.env.LLV_TS_HOST = previous;
    }
  }
});


test("concurrent session issuers share a complete private signing key", async () => {
  const run = () => promisify(execFile)(process.execPath, ["-e", `
    import { soloBrowserSession } from './src/lib/agent/operatorSession';
    console.log(soloBrowserSession(0));
  `], { env: process.env, timeout: 10_000 });
  const [first, second] = await Promise.all([run(), run()]);
  const { verifySoloBrowserSession } = await import("./operatorSession");
  for (const result of [first, second]) expect(verifySoloBrowserSession(result.stdout.trim(), 1)).toBe(true);
  expect(first.stdout).toBe(second.stdout);
  expect(fs.readdirSync(process.env.LLV_STATE_DIR!)).toEqual(["operator-session-key"]);
});

test("missing, linked and non-private session keys fail closed without replacement", async () => {
  const { soloBrowserSession, verifySoloBrowserSession } = await import("./operatorSession");
  const key = path.join(process.env.LLV_STATE_DIR!, "operator-session-key");
  const shape = `v1.2592000000.${"a".repeat(43)}`;
  expect(verifySoloBrowserSession(shape, 1)).toBe(false);
  expect(fs.existsSync(key)).toBe(false);
  const cookie = soloBrowserSession(0);
  const saved = fs.readFileSync(key);
  if (process.platform !== "win32") {
    fs.chmodSync(key, 0o644);
    expect(verifySoloBrowserSession(cookie, 1)).toBe(false);
    expect(() => soloBrowserSession(0)).toThrow("private");
    fs.chmodSync(key, 0o600);
    const target = path.join(process.env.LLV_STATE_DIR!, "saved-key");
    fs.renameSync(key, target);
    fs.symlinkSync(target, key);
    expect(verifySoloBrowserSession(cookie, 1)).toBe(false);
    expect(() => soloBrowserSession(0)).toThrow();
    expect(fs.readFileSync(target)).toEqual(saved);
  }
});
