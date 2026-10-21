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
afterAll(async () => { setVoiceToolHubForTests(undefined); resetTeamStoreForTests(); await fs.rm(root, { recursive: true, force: true }); });
function request(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://127.0.0.1/api/voice-tools", { method, headers: { host: "127.0.0.1", "sec-fetch-site": "same-origin", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const proposal = { name: "music", title: "Music", capability: "Search music", transport: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: { secretRef: "music-token" } } } };

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
  const saved = await POST(request("POST", { action: "secrets", secrets: { "music-token": "synthetic-voice-credential" } }));
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

test("team mode admits only an active owner, and rechecks after the request body wait", async () => {
  resetTeamStoreForTests();
  const owner = claimInstall(teamStore(), "Owner", { surface: "desktop", browser: "chrome" });
  const invitation = createInvite(teamStore(), owner.member, "Member");
  const member = redeemJoin(teamStore(), invitation.code, "Member", { surface: "desktop", browser: "chrome" });
  const ownerHeaders = { cookie: `${MEMBER_COOKIE}=${owner.cookie}` };
  const memberHeaders = { cookie: `${MEMBER_COOKIE}=${member.cookie}` };
  expect((await GET(request("GET"))).status).toBe(401);
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
  const secondSession = mintSession(teamStore(), owner.member.id, "claim", { surface: "desktop", browser: "chrome" });
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
});
