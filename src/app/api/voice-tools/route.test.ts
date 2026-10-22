import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-tools-routes-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
const { GET, POST } = await import("./route");
const { VoiceToolHub, setVoiceToolHubForTests } = await import("@/lib/voiceTools/hub");
const { VoiceToolsStore } = await import("@/lib/voiceTools/store");
setVoiceToolHubForTests(new VoiceToolHub(new VoiceToolsStore(path.join(root, "state"))));
const { POST: proposalPOST } = await import("./proposals/route");
const { internalServiceHeaders } = await import("@/lib/agent/callerClaims");
const { claimInstall, createInvite, redeemJoin } = await import("@/lib/team/members");
const { teamStore, resetTeamStoreForTests } = await import("@/lib/team/store");
const { MEMBER_COOKIE, mintSession } = await import("@/lib/team/sessions");
const { POST: claimPOST } = await import("@/app/api/team/claim/route");
afterAll(async () => { setVoiceToolHubForTests(undefined); resetTeamStoreForTests(); await fs.rm(root, { recursive: true, force: true }); });
function authenticatedOwner() {
  const claimed = claimInstall(teamStore(), "Owner", { surface: "desktop", browser: "chrome" });
  const session = mintSession(teamStore(), claimed.member.id, "passkey", { surface: "desktop", browser: "chrome" });
  return { ...claimed, cookie: session.value, session: session.session };
}
const browserOwner = authenticatedOwner();
function request(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://127.0.0.1/api/voice-tools", { method, headers: { host: "127.0.0.1", "sec-fetch-site": "same-origin", cookie: `${MEMBER_COOKIE}=${browserOwner.cookie}`, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const proposal = { name: "music", title: "Music", capability: "Search music", transport: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: { secretRef: "music-token" } } } };

test("both proposal routes return INVALID_PROPOSAL for non-registry package targets", async () => {
  const before = await (await GET(request("GET"))).json();
  const approvedService = internalServiceHeaders("mcp");
  for (const transport of [
    { type: "stdio", command: "bun", args: ["x", "sh", "-c", "exec bun /abs/server.mjs"] },
    { type: "stdio", command: "bun", args: ["x", "bun", "/abs/server.mjs"] },
    { type: "stdio", command: "bun", args: ["x", "python3", "/abs/server.py"] },
    { type: "stdio", command: "uv", args: ["tool", "run", "python", "/abs/server.py"] },
    { type: "stdio", command: "uv", args: ["tool", "run", "python==3.12"] },
    { type: "stdio", command: "bun", args: ["x", "name@file:/abs"] },
    { type: "stdio", command: "bun", args: ["x", "/abs"] },
    { type: "stdio", command: "uv", args: ["tool", "run", "/abs"] },
    { type: "stdio", command: "uv", args: ["tool", "run", "n @ file:///abs"] },
    { type: "stdio", command: "bun", args: ["x", "git+file:/abs"] },
    { type: "stdio", command: "uv", args: ["tool", "run", "git+file:/abs"] },
  ]) {
    const invalid = { ...proposal, name: "invalid", transport };
    const browser = await POST(request("POST", { action: "propose", proposal: invalid }));
    expect(browser.status).toBe(400);
    expect(await browser.json()).toEqual({ code: "INVALID_PROPOSAL" });
    const mcp = await proposalPOST(request("POST", { action: "propose", proposal: invalid, clientRequestId: "invalid-package", conversationId: "conversation_worker" }, approvedService));
    expect(mcp.status).toBe(400);
    expect(await mcp.json()).toEqual({ code: "INVALID_PROPOSAL" });
  }
  expect(await (await GET(request("GET"))).json()).toEqual(before);
  for (const command of ["bun", "uv"]) {
    const transport = { type: "stdio", command, args: command === "bun" ? ["x", "@tools/music@1.2.3"] : ["tool", "run", "music==1.2.3"] };
    const valid = { ...proposal, name: `registry_${command}`, transport };
    expect((await POST(request("POST", { action: "propose", proposal: valid }))).status).toBe(200);
    expect((await proposalPOST(request("POST", { action: "propose", proposal: valid, clientRequestId: `registry-${command}`, conversationId: "conversation_worker" }, approvedService))).status).toBe(200);
    const view = await (await GET(request("GET"))).json();
    expect((await POST(request("POST", { action: "remove", name: valid.name, digest: view.servers[valid.name].digest }))).status).toBe(200);
  }
});

test("browser API separates operator actions from MCP proposals and never echoes credentials", async () => {
  expect((await GET(request("GET"))).status).toBe(200);
  for (const headers of [{ "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "none" }, { "x-llv-spawn-capability": "invalid-agent-claim" }, internalServiceHeaders("mcp")]) {
    expect((await POST(request("POST", { action: "propose", proposal }, headers))).status).toBe(403);
    expect((await GET(request("GET", undefined, headers))).status).toBe(403);
  }
  expect((await proposalPOST(request("POST", { action: "propose", proposal, clientRequestId: "proposal-one", conversationId: "conversation_worker" }))).status).toBe(403);
  const approvedService = internalServiceHeaders("mcp");
  const result = await proposalPOST(request("POST", { action: "propose", proposal, clientRequestId: "proposal-one", conversationId: "conversation_worker" }, approvedService));
  expect(result.status).toBe(200);
  const view = await result.json();
  expect(view.servers.music.state).toBe("pending"); expect(view.servers.music.lastDryRun).toBeNull();
  for (const action of ["approve", "remove", "dry-run", "secrets", "reject"]) {
    expect((await proposalPOST(request("POST", { action, name: "music", digest: view.servers.music.digest, clientRequestId: `forbidden-${action}`, conversationId: "conversation_worker" }, approvedService))).status).toBe(400);
  }
  expect((await POST(request("POST", { action: "approve", name: "music", digest: view.servers.music.digest }))).status).toBe(409);
  const saved = await POST(request("POST", { action: "secrets", secrets: { "music-token": { value: "synthetic-voice-credential", destinations: ["https://example.invalid"] } } }));
  expect(saved.status).toBe(200); expect(await saved.text()).not.toContain("synthetic-voice-credential");
  const status = await (await GET(request("GET"))).json();
  expect(status.servers.music.missingSecrets).toEqual([]);
  expect(status.servers.music.transport).toEqual({ type: "http", url: "https://example.invalid/mcp", headerNames: ["Authorization"], headerValues: {} });
  expect(await fs.readFile(path.join(root, "state/voice-tools.json"), "utf8")).not.toContain("synthetic-voice-credential");
  expect((await POST(request("POST", { action: "configure", name: "music", digest: status.servers.music.digest, askBeforeActing: true }))).status).toBe(200);
  expect((await POST(request("POST", { action: "remove", name: "music", digest: status.servers.music.digest }))).status).toBe(409);
  const current = await (await GET(request("GET"))).json();
  const rejected = await (await POST(request("POST", { action: "reject", name: "music", digest: current.servers.music.digest }))).json();
  expect(rejected.servers.music.state).toBe("rejected");
  expect((await POST(request("POST", { action: "remove", name: "music", digest: rejected.servers.music.digest }))).status).toBe(200);
  expect((await (await GET(request("GET"))).json()).servers).toEqual({});
});

test("the operator dry-runs and approves a pinned catalog, configures acting confirmation, and rejects stale clicks", async () => {
  const peer = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const message = await req.json() as { id?: number; method: string };
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }
      : { tools: [{ name: "search", description: "Search", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] };
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  } });
  try {
    const local = { ...proposal, transport: { type: "http", url: `http://127.0.0.1:${peer.port}/mcp` } };
    const proposed = await (await POST(request("POST", { action: "propose", proposal: local }))).json();
    const probe = await POST(request("POST", { action: "dry-run", name: "music", digest: proposed.servers.music.digest }));
    expect(probe.status).toBe(200);
    const discovered = await probe.json(); expect(discovered.servers.music.lastDryRun.code).toBe("OK");
    const configured = await (await POST(request("POST", { action: "configure", name: "music", digest: discovered.servers.music.digest, tools: { search: { enabled: true, acts: false } } }))).json();
    expect((await POST(request("POST", { action: "approve", name: "music", digest: discovered.servers.music.digest }))).status).toBe(409);
    const approved = await (await POST(request("POST", { action: "approve", name: "music", digest: configured.servers.music.digest }))).json();
    expect(approved.servers.music.state).toBe("enabled"); expect(approved.servers.music.approval.digest).toBe(configured.servers.music.digest);
    const kept = await (await POST(request("POST", { action: "configure", name: "music", digest: approved.servers.music.digest, askBeforeActing: true, reapprove: true }))).json();
    expect([kept.servers.music.state, kept.servers.music.approval.digest]).toEqual(["enabled", kept.servers.music.digest]);
    expect((await POST(request("POST", { action: "configure", name: "music", digest: kept.servers.music.digest, reapprove: false }))).status).toBe(400);
    const changed = await (await POST(request("POST", { action: "configure", name: "music", digest: kept.servers.music.digest, askBeforeActing: false }))).json();
    expect(changed.servers.music.state).toBe("pending"); expect(changed.servers.music.approval).toBeNull();
    expect((await POST(request("POST", { action: "remove", name: "music", digest: changed.servers.music.digest }))).status).toBe(200);
  } finally { await peer.stop(true); }
});


test("both proposal routes and approval refuse a secret sent to another origin", async () => {
  const { approvalDigest } = await import("@/lib/voiceTools/contracts");
  const secret = { value: "synthetic-bound-credential", destinations: ["https://example.invalid"] };
  expect((await POST(request("POST", { action: "secrets", secrets: { "bound-token": secret } }))).status).toBe(200);
  const trusted = { ...proposal, name: "bound", transport: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: { secretRef: "bound-token" } } } };
  for (const header of ["Host", "host", "hOsT"]) {
    const authorityOverride = { ...trusted, name: `bound_${header.toLowerCase()}`, transport: { ...trusted.transport,
      headers: { ...trusted.transport.headers, [header]: { value: "unbound.example.test" } } } };
    const browser = await POST(request("POST", { action: "propose", proposal: authorityOverride }));
    expect(browser.status).toBe(400); expect(await browser.json()).toEqual({ code: "INVALID_PROPOSAL" });
    const mcp = await proposalPOST(request("POST", { action: "propose", proposal: authorityOverride,
      clientRequestId: `host-override-${header.toLowerCase()}`, conversationId: "conversation_worker" }, internalServiceHeaders("mcp")));
    expect(mcp.status).toBe(400); expect(await mcp.json()).toEqual({ code: "INVALID_PROPOSAL" });
  }
  const hostile = { ...trusted, transport: { ...trusted.transport, url: "https://other.example.test/mcp" } };
  const inputs = [
    POST(request("POST", { action: "propose", proposal: hostile })),
    proposalPOST(request("POST", { action: "propose", proposal: hostile, conversationId: "conversation_worker", clientRequestId: "wrong-destination" }, internalServiceHeaders("mcp"))),
  ];
  for (const response of await Promise.all(inputs)) {
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ code: "SECRET_DESTINATION" });
  }
  expect((await POST(request("POST", { action: "propose", proposal: trusted }))).status).toBe(200);
  const file = path.join(root, "state/voice-tools.json");
  const registry = JSON.parse(await fs.readFile(file, "utf8"));
  registry.servers.bound.transport.url = hostile.transport.url;
  await fs.writeFile(file, JSON.stringify(registry));
  for (const action of ["approve", "dry-run"]) {
    const response = await POST(request("POST", { action, name: "bound", digest: approvalDigest("bound", registry.servers.bound) }));
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ code: "SECRET_DESTINATION" });
  }
  const response = await POST(request("POST", { action: "remove", name: "bound", digest: approvalDigest("bound", registry.servers.bound) }));
  expect(response.status).toBe(200);
});

test("team mode admits only an active owner, and rechecks after the request body wait", async () => {
  resetTeamStoreForTests();
  process.env.LLV_STATE_DIR = path.join(root, "team-state");
  const owner = authenticatedOwner();
  const invitation = createInvite(teamStore(), owner.member, "Member");
  const member = redeemJoin(teamStore(), invitation.code, "Member", { surface: "desktop", browser: "chrome" });
  const ownerHeaders = { cookie: `${MEMBER_COOKIE}=${owner.cookie}` };
  const memberHeaders = { cookie: `${MEMBER_COOKIE}=${member.cookie}` };
  expect((await GET(request("GET", undefined, { cookie: "" }))).status).toBe(401);
  expect((await GET(request("GET", undefined, memberHeaders))).status).toBe(403);
  expect((await POST(request("POST", { action: "propose", proposal }, memberHeaders))).status).toBe(403);
  expect((await GET(request("GET", undefined, ownerHeaders))).status).toBe(200);
  const hub = new VoiceToolHub(new VoiceToolsStore(path.join(root, "state")));
  const view = hub.store.view.bind(hub.store);
  hub.store.view = async () => {
    const result = await view();
    teamStore().revokeSessionsOf(owner.member.id, new Date().toISOString());
    return result;
  };
  setVoiceToolHubForTests(hub);
  expect((await POST(request("POST", { action: "propose", proposal }, ownerHeaders))).status).toBe(401);
  setVoiceToolHubForTests(new VoiceToolHub(new VoiceToolsStore(path.join(root, "state"))));
  // Issue a fresh owner session for the independent body-read race.
  const secondSession = mintSession(teamStore(), owner.member.id, "passkey", { surface: "desktop", browser: "chrome" });
  const secondHeaders = { cookie: `${MEMBER_COOKIE}=${secondSession.value}` };
  // Revoke at the exact body await; authorization must be checked again before mutation.
  const req = request("POST", { action: "propose", proposal }, secondHeaders);
  const reader = req.body!.getReader.bind(req.body);
  Object.defineProperty(req.body, "getReader", { value: () => {
    teamStore().revokeSessionsOf(owner.member.id, new Date().toISOString());
    return reader();
  } });
  expect((await POST(req)).status).toBe(401);
  resetTeamStoreForTests();
  process.env.LLV_STATE_DIR = path.join(root, "state");
});

// Regression: browser-shaped headers are public input, never operator proof.
test("a header-less same-origin local client cannot approve or save secrets", async () => {
  for (const action of ["approve", "secrets", "dry-run", "configure"]) {
    const reply = await POST(request("POST", { action, name: "music", digest: `sha256:${"a".repeat(64)}` }, { cookie: "" }));
    expect(reply.status).toBe(401);
  }
});


test("a same-origin local client cannot approve a successfully probed server", async () => {
  // Reproduce the solo-mode hole; an existing owner would let the older team
  // gate reject this client before the voice-specific proof is checked.
  resetTeamStoreForTests();
  process.env.LLV_STATE_DIR = path.join(root, "solo-spoof-state");
  const store = new VoiceToolsStore(path.join(root, "spoof-state"));
  const hub = new VoiceToolHub(store);
  setVoiceToolHubForTests(hub);
  let contacts = 0;
  const peer = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    contacts++;
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const message = await req.json() as { id?: number; method: string };
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result = message.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }
      : { tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }] };
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  } });
  try {
    await store.propose({ ...proposal, transport: { type: "http", url: `http://127.0.0.1:${peer.port}/mcp` } }, { kind: "conversation", conversationId: "conversation_worker", at: "2026-01-01T00:00:00.000Z" });
    await hub.dryRun("music", (await store.view()).servers.music.digest);
    const ready = (await store.view()).servers.music;
    expect(ready.lastDryRun?.code).toBe("OK"); expect(contacts).toBeGreaterThan(0);
    const response = await POST(request("POST", { action: "approve", name: "music", digest: ready.digest }, { cookie: "" }));
    expect(response.status).toBe(401);
    expect((await new VoiceToolsStore(store.directory).view()).servers.music.state).toBe("pending");
  } finally {
    await peer.stop(true);
    resetTeamStoreForTests();
    process.env.LLV_STATE_DIR = path.join(root, "state");
    setVoiceToolHubForTests(new VoiceToolHub(new VoiceToolsStore(path.join(root, "state"))));
  }
});

test("claiming an unclaimed install does not authorize voice tool proposal, dry run or approval", async () => {
  resetTeamStoreForTests();
  process.env.LLV_STATE_DIR = path.join(root, "claim-attack-state");
  const store = new VoiceToolsStore(process.env.LLV_STATE_DIR);
  setVoiceToolHubForTests(new VoiceToolHub(store));
  let contacts = 0;
  const peer = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    contacts++;
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const message = await req.json() as { id?: number; method: string };
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result = message.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }
      : { tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }] };
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  } });
  try {
    const claim = await claimPOST(new NextRequest("http://127.0.0.1/api/team/claim", { method: "POST",
      headers: { host: "127.0.0.1", origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ name: "Attacker" }) }));
    expect(claim.status).toBe(200);
    const claimedCookie = claim.cookies.get(MEMBER_COOKIE)?.value;
    expect(claimedCookie).toBeTruthy();
    const attacker = { cookie: `${MEMBER_COOKIE}=${claimedCookie}` };
    const local = { ...proposal, transport: { type: "http", url: `http://127.0.0.1:${peer.port}/mcp` } };
    expect((await POST(request("POST", { action: "propose", proposal: local }, attacker))).status).toBe(401);
    expect((await GET(request("GET", undefined, attacker))).status).toBe(401);
    for (const action of ["dry-run", "approve", "configure", "secrets", "remove", "reject"]) {
      expect((await POST(request("POST", { action, name: "music", digest: `sha256:${"a".repeat(64)}` }, attacker))).status).toBe(401);
    }
    expect((await proposalPOST(request("POST", { action: "propose", proposal: local, clientRequestId: "claim-attempt", conversationId: "conversation_worker" }, attacker))).status).toBe(403);
    expect(contacts).toBe(0);
    const view = await store.view();
    expect(view.servers.music).toBeUndefined();

    resetTeamStoreForTests();
    process.env.LLV_STATE_DIR = path.join(root, "claim-owner-state");
    const owner = authenticatedOwner();
    const ownerStore = new VoiceToolsStore(process.env.LLV_STATE_DIR);
    setVoiceToolHubForTests(new VoiceToolHub(ownerStore));
    const ownerCookie = { cookie: `${MEMBER_COOKIE}=${owner.cookie}` };
    const authorized = await POST(request("POST", { action: "propose", proposal: local }, ownerCookie));
    expect(authorized.status).toBe(200);
    const proposed = await authorized.json();
    const dryRun = await POST(request("POST", { action: "dry-run", name: "music", digest: proposed.servers.music.digest }, ownerCookie));
    expect(dryRun.status).toBe(200);
    const discovered = await dryRun.json();
    const approved = await POST(request("POST", { action: "approve", name: "music", digest: discovered.servers.music.digest }, ownerCookie));
    expect(approved.status).toBe(200);
    expect((await approved.json()).servers.music.state).toBe("enabled");
    expect(contacts).toBeGreaterThan(0);
  } finally {
    await peer.stop(true);
    resetTeamStoreForTests();
    process.env.LLV_STATE_DIR = path.join(root, "state");
    setVoiceToolHubForTests(new VoiceToolHub(new VoiceToolsStore(path.join(root, "state"))));
  }
});

test("both proposal routes, approval and dry run refuse a secret bound to another origin", async () => {
  const store = new VoiceToolsStore(path.join(root, "destination-state"));
  setVoiceToolHubForTests(new VoiceToolHub(store));
  let contacts = 0;
  const peer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    contacts++;
    return new Response(null, { status: 500 });
  } });
  const local = { ...proposal, transport: { ...proposal.transport, url: `http://127.0.0.1:${peer.port}/mcp` } };
  try {
    // A missing reference can be proposed, but gains no destination authority.
    expect((await POST(request("POST", { action: "propose", proposal: local }))).status).toBe(200);
    expect((await POST(request("POST", { action: "secrets", secrets: {
      "music-token": { value: "synthetic-voice-credential", destinations: ["https://example.invalid"] },
    } }))).status).toBe(200);
    const mcp = internalServiceHeaders("mcp");
    const responses = [
      await POST(request("POST", { action: "propose", proposal: local })),
      await proposalPOST(request("POST", { action: "propose", proposal: local, clientRequestId: "wrong-destination", conversationId: "conversation_worker" }, mcp)),
    ];
    const digest = (await store.view()).servers.music.digest;
    for (const action of ["approve", "dry-run"]) responses.push(await POST(request("POST", { action, name: "music", digest })));
    for (const response of responses) {
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ code: "SECRET_DESTINATION" });
    }
    expect(contacts).toBe(0);
    expect((await store.view()).servers.music.approval).toBeNull();
  } finally {
    await peer.stop(true);
    setVoiceToolHubForTests(new VoiceToolHub(new VoiceToolsStore(path.join(root, "state"))));
  }
});
